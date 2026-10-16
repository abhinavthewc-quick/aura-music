/**
 * Peak Rooms — Durable Object.
 *
 * Cloudflare does not allow a Durable Object to live inside a Pages project, so
 * this ships as its own small Worker. The Pages site binds to it by
 * `script_name` and reaches it over `/api/rooms`, which simply forwards the
 * WebSocket upgrade.
 *
 * All room logic lives in `RoomReferee`, which is shared verbatim with the
 * browser-side local referee used during development. This class is only
 * responsible for plumbing: sockets, persistence and alarms.
 */

import {
  RoomReferee,
  GRACE_MS,
  type RefereeState,
} from '../../src/rooms/referee';
import type {
  ClientMessage,
  ServerMessage,
} from '../../src/rooms/protocol';

export interface Env {
  /** Bumped when the storage shape changes so old rooms are discarded. */
  ROOM_SCHEMA?: string;
}

const SCHEMA = 'v1';
/** How often an idle room re-checks that it is still supposed to exist. */
const ALARM_MS = 30_000;

interface StoredRoom {
  schema: string;
  state: RefereeState;
  /** When the room last had anybody in it. */
  idleSince: number;
}

/**
 * The room endpoints are intentionally reachable from any origin: rooms are
 * created by friends and family from the live site, and the WebSocket upgrade
 * is not subject to CORS in the same way. Nothing here is secret — the admin
 * key is only ever given to the creator that asked for the room.
 */
function corsJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

/**
 * The WebSocket URL clients should connect to, derived from the address this
 * request arrived on. Works unchanged in local development and in production,
 * which keeps the create path identical in both.
 */
function wsBaseOf(url: URL): string {
  return url.protocol === 'https:' ? `wss://${url.host}` : `ws://${url.host}`;
}

export class RoomDO {
  private ctx: DurableObjectState;
  private env: Env;

  /** clientId -> live socket */
  private sockets = new Map<string, WebSocket>();
  private clientIds = new WeakMap<WebSocket, string>();
  private referee: RoomReferee | null = null;
  private hydrated = false;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  /* ---------------- HTTP / WebSocket entry ---------------- */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomId = url.searchParams.get('room') || '';
    if (!/^[a-z0-9]{4,24}$/i.test(roomId)) {
      return new Response('bad room id', { status: 400 });
    }

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleSocket(request, roomId);
    }
    return this.handleHttp(url, roomId);
  }

  private async handleHttp(url: URL, roomId: string): Promise<Response> {
    const action = url.searchParams.get('action');

    if (action === 'create') {
      const ownerKey = url.searchParams.get('k') || '';
      const ownerId = 'creator';
      if (roomId && ownerKey) {
        // Recording the creator keeps the room alive even before anyone
        // connects, and makes the owner key valid from the first moment.
        const referee = await this.ensureReferee(roomId, ownerKey, ownerId);
        // Wait for the write rather than relying on waitUntil: the caller may
        // immediately open a socket, and the object could be evicted first.
        await this.persist(referee);
        return corsJson({ ok: true, roomId, wsBase: wsBaseOf(url) });
      }
    }

    if (action === 'exists') {
      const stored = await this.ctx.storage.get<StoredRoom>('room');
      if (!stored || stored.schema !== SCHEMA) return corsJson({ exists: false, wsBase: wsBaseOf(url) });
      return corsJson({
        exists: true,
        people: stored.state.participants.length,
        emptySince: stored.idleSince || null,
        wsBase: wsBaseOf(url),
      });
    }

    return new Response('unknown action', { status: 400 });
  }

  private async handleSocket(request: Request, roomId: string): Promise<Response> {
    const url = new URL(request.url);
    const clientId = url.searchParams.get('client') || crypto.randomUUID();
    const adminKey = url.searchParams.get('k') || undefined;
    const name = url.searchParams.get('name') || 'listener';

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // workerd requires the server side to be accepted before anything can be
    // written to it, even when the Response below hands it straight back.
    server.accept();

    this.sockets.set(clientId, server);
    this.clientIds.set(server, clientId);

    // Message handling is wired directly rather than via the hibernation API,
    // so this keeps the object awake while a listener is connected. That is
    // the right trade for a room of a handful of friends; the alarm below is
    // what protects the idle grace period.
    server.addEventListener('message', (ev) => {
      this.ctx.waitUntil(this.onMessage(clientId, ev.data));
    });

    const drop = () => {
      this.sockets.delete(clientId);
      this.referee?.disconnect(clientId);
    };
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);

    // Do the join work inline, before returning the 101. Doing it after the
    // response has been sent loses the race: the socket is handed back to the
    // runtime before we ever get to write the welcome.
    const referee = await this.ensureReferee(roomId, undefined, undefined);
    referee.handle(clientId, { t: 'hello', clientId, name, ...(adminKey ? { adminKey } : {}) });
    await this.persist(referee);

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------------- messages ---------------- */

  private async onMessage(clientId: string, raw: string | ArrayBuffer): Promise<void> {
    let message: ClientMessage;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }

    const referee = await this.getReferee();
    referee.handle(clientId, message);

    // A control change must be durable before we answer, so a drop cannot roll
    // the room back to a stale position.
    await this.persist(referee);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const clientId = this.clientIds.get(ws);
    if (clientId) await this.onMessage(clientId, raw);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const clientId = this.clientIds.get(ws);
    if (!clientId) return;
    this.sockets.delete(clientId);
    this.referee?.disconnect(clientId);
  }

  /* ---------------- persistence + lifecycle ---------------- */

  private async getReferee(): Promise<RoomReferee> {
    if (this.referee) return this.referee;

    const stored = await this.ctx.storage.get<StoredRoom>('room');
    const referee = new RoomReferee('room', '', 'creator', {
      deliver: (clientId, message) => this.send(clientId, message),
      finished: () => {
        // No ctx.delete() in the runtime API: clearing storage is what lets
        // the platform reclaim the object.
        void this.ctx.storage.deleteAll();
      },
    }, {
      // Durable Objects have no `window`; the referee's grace/rescue timers
      // are driven by the alarm below instead of setTimeout.
      timers: {
        // Durable Objects have no `window`, but globalThis.setTimeout works and
        // keeps the in-memory grace/rescue logic identical to the browser.
        // The alarm below is the backstop for when the object is evicted.
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
      },
      onChange: (state) => {
        this.ctx.waitUntil(this.ctx.storage.put('room', {
          schema: SCHEMA,
          state,
          idleSince: state.participants.length ? 0 : Date.now(),
        } satisfies StoredRoom));
      },
    });

    if (stored && stored.schema === SCHEMA) referee.importState(stored.state);
    this.referee = referee;
    this.hydrated = true;
    return referee;
  }

  private async ensureReferee(roomId: string, ownerKey?: string, ownerId?: string): Promise<RoomReferee> {
    const referee = await this.getReferee();
    if (ownerKey) {
      // The key becomes valid immediately; whoever presents it on connect is
      // the admin. Idempotent, so a replayed create cannot reset a live room.
      referee.registerAdminKey(ownerKey);
    }
    await this.scheduleAlarm();
    return referee;
  }

  private async persist(referee: RoomReferee): Promise<void> {
    const state = referee.exportState();
    await this.ctx.storage.put('room', {
      schema: SCHEMA,
      state,
      idleSince: state.participants.length ? 0 : Date.now(),
    } satisfies StoredRoom);
  }

  private send(clientId: string, message: ServerMessage): void {
    const ws = this.sockets.get(clientId);
    if (!ws) return;
    try {
      ws.send(JSON.stringify(message));
    } catch (err) {
      this.sockets.delete(clientId);
    }
  }

  private async scheduleAlarm(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
  }

  /**
   * Idle rooms are evicted from memory by the platform, so the referee's own
   * setTimeout would never fire. The alarm is what actually enforces the grace
   * period: on wake we re-check whether anybody has come back.
   */
  async alarm(): Promise<void> {
    const referee = await this.getReferee();
    const state = referee.exportState();

    if (state.participants.length === 0) {
      const idleSince = state.expiresAt ? state.expiresAt - GRACE_MS : Date.now();
      if (Date.now() - idleSince >= GRACE_MS) {
        await this.ctx.storage.deleteAll();
        return;
      }
    } else {
      const admins = state.participants.filter((p) => p.role === 'admin');
      if (admins.length === 0) {
        // The rescue window has already elapsed via the in-memory timer, or the
        // object was evicted during it. Give it one more beat to be reclaimed.
        await this.ctx.storage.setAlarm(Date.now() + GRACE_MS);
        return;
      }
    }

    await this.scheduleAlarm();
  }
}