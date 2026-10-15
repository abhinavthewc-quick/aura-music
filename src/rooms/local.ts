/* BroadcastChannel transport — the local stand-in for a Durable Object.
 *
 * One tab hosts the referee; every tab on this machine talks to it over a
 * shared BroadcastChannel. This exists so the sync protocol can be exercised
 * honestly — two real browsers, real drift, real buffering — before any server
 * infrastructure is involved.
 *
 * The room creator's own tab hosts the referee too, so the rule is simply:
 * "the tab that creates the room is the referee". A second tab that opens the
 * same room finds the existing referee and connects to it.
 */

import { RoomReferee } from './referee';
import type { ClientMessage, ServerMessage } from './protocol';
import type { RoomTransport } from './transport';

type WireKind =
  | 'toReferee'   // client -> referee
  | 'fromReferee' // referee -> client (or a host heartbeat)
  | 'lookup'      // "is anyone already hosting this room?"

interface WireMessage {
  kind: WireKind;
  roomId: string;
  clientId?: string;
  payload?: ClientMessage | ServerMessage;
}

const LOOKUP_TIMEOUT_MS = 400;
const BEAT_INTERVAL_MS = 2000;
/** A client that has not heard a heartbeat for this long declares the room dead. */
const BEAT_TIMEOUT_MS = 8000;

function channelName(roomId: string): string {
  return `aura-room-${roomId}`;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Short, human-typeable room code. Ambiguous characters left out. */
export function newRoomId(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

/* ------------------------------------------------------------------ */
/* Client-side transport                                               */
/* ------------------------------------------------------------------ */

export class LocalTransport implements RoomTransport {
  readonly clientId: string;
  private channel: BroadcastChannel;
  private messageHandler: ((m: ServerMessage) => void) | null = null;
  private closeHandler: ((reason: string) => void) | null = null;
  private beatTimer: number | null = null;
  private lastBeat = Date.now();
  private closed = false;

  constructor(private roomId: string, clientId: string) {
    this.clientId = clientId;
    this.channel = new BroadcastChannel(channelName(roomId));
    this.channel.onmessage = (ev: MessageEvent<WireMessage>) => {
      const msg = ev.data;
      if (!msg || msg.roomId !== roomId) return;

      if (msg.kind === 'fromReferee') {
        this.lastBeat = Date.now();
        if (msg.payload && (!msg.clientId || msg.clientId === this.clientId)) {
          this.messageHandler?.(msg.payload as ServerMessage);
        }
        return;
      }
      if (msg.kind === 'lookup') {
        // We are not the host; do not answer lookups on its behalf.
      }
    };

    this.beatTimer = window.setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastBeat > BEAT_TIMEOUT_MS) {
        this.notifyClosed('the room server went away');
      }
    }, 1500);
  }

  send(message: ClientMessage): void {
    if (this.closed) return;
    this.channel.postMessage({
      kind: 'toReferee', roomId: this.roomId, clientId: this.clientId, payload: message,
    } satisfies WireMessage);
  }

  onMessage(handler: (m: ServerMessage) => void): void { this.messageHandler = handler; }
  onClose(handler: (reason: string) => void): void { this.closeHandler = handler; }

  notifyClosed(reason: string): void {
    if (this.closed) return;
    this.close();
    this.closeHandler?.(reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.beatTimer !== null) window.clearInterval(this.beatTimer);
    try {
      this.channel.postMessage({
        kind: 'toReferee', roomId: this.roomId, clientId: this.clientId, payload: { t: 'bye' },
      } satisfies WireMessage);
    } catch { /* channel already gone */ }
    this.channel.close();
  }
}

/** Transport used by the tab that hosts the referee — delivered in-process. */
export class HostedTransport implements RoomTransport {
  readonly clientId: string;
  private messageHandler: ((m: ServerMessage) => void) | null = null;
  private closeHandler: ((reason: string) => void) | null = null;

  constructor(private referee: RoomReferee, clientId: string) {
    this.clientId = clientId;
  }

  send(message: ClientMessage): void { this.referee.handle(this.clientId, message); }
  onMessage(handler: (m: ServerMessage) => void): void { this.messageHandler = handler; }
  onClose(handler: (reason: string) => void): void { this.closeHandler = handler; }

  /** Called by the referee when this tab's own client is the recipient. */
  deliver(message: ServerMessage): void { this.messageHandler?.(message); }

  notifyClosed(reason: string): void { this.closeHandler?.(reason); }
  close(): void { this.referee.handle(this.clientId, { t: 'bye' }); }
}

/* ------------------------------------------------------------------ */
/* Connecting                                                          */
/* ------------------------------------------------------------------ */

export interface LocalRoomConnection {
  transport: RoomTransport;
  /** True when this tab is the referee. */
  isHost: boolean;
  /** Only set when this tab just created the room. */
  ownerKey?: string;
  /** Stop hosting (closes the room for everyone in this tab). */
  stopHosting?: () => void;
}

/** Is a referee already running in some other tab for this room? */
export async function isRoomHosted(roomId: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const probe = new BroadcastChannel(channelName(roomId));
    const finish = (result: boolean) => {
      if (answered) return;
      answered = true;
      window.clearTimeout(timer);
      try { probe.close(); } catch { /* ignore */ }
      resolve(result);
    };
    const timer = window.setTimeout(() => finish(false), LOOKUP_TIMEOUT_MS);
    probe.onmessage = (ev: MessageEvent<WireMessage>) => {
      if (ev.data?.kind === 'fromReferee') finish(true);
    };
    probe.postMessage({ kind: 'lookup', roomId } satisfies WireMessage);
  });
}

/**
 * Host the room in this tab. The returned handle must be kept alive for the
 * lifetime of the room; losing it ends the room for everyone.
 */
export function hostRoom(
  roomId: string,
  ownerKey: string,
  ownerId: string,
  onStop: (reason: string) => void,
): { transport: HostedTransport; stop: (reason?: string) => void } {
  const channel = new BroadcastChannel(channelName(roomId));
  let stopped = false;

  const post = (msg: WireMessage) => {
    try { channel.postMessage(msg); } catch { /* channel closed */ }
  };

  const referee = new RoomReferee(roomId, ownerKey, ownerId, {
    deliver: (clientId, message) => {
      if (clientId === ownerId) hostedTransport.deliver(message);
      else post({ kind: 'fromReferee', roomId, clientId, payload: message });
    },
    finished: (reason) => stop(reason),
  });

  const hostedTransport = new HostedTransport(referee, ownerId);

  function stop(reason = "host stopped") {
    if (stopped) return;
    stopped = true;
    window.clearInterval(beat);
    referee.dispose();
    post({ kind: 'fromReferee', roomId, clientId: undefined, payload: undefined });
    hostedTransport.notifyClosed(reason);
    window.setTimeout(() => { try { channel.close(); } catch { /* ignore */ } }, 200);
  }

  // Tell late joiners we are alive.
  const beat = window.setInterval(() => post({ kind: 'fromReferee', roomId }), BEAT_INTERVAL_MS);

  channel.onmessage = (ev: MessageEvent<WireMessage>) => {
    const msg = ev.data;
    if (!msg || msg.roomId !== roomId) return;
    if (msg.kind === 'toReferee' && msg.clientId) {
      referee.handle(msg.clientId, msg.payload as ClientMessage);
    }
  };

  return { transport: hostedTransport, stop };
}