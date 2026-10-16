/**
 * Entry point for the Peak Rooms worker.
 *
 * Every request is routed to the Durable Object for the room named in the URL,
 * so each room gets its own isolated memory and clock. The worker itself is
 * stateless — all room state lives in the object.
 */

import { RoomDO } from './room';

export { RoomDO };

export interface Env {
  ROOM_SCHEMA?: string;
  /** Bound in wrangler.toml — one RoomDO instance per room name. */
  ROOM_OBJECT: DurableObjectNamespace;
}

/** Short, unambiguous room code people can read aloud. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function newRoomId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

function newAdminKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

/** The WebSocket URL clients should dial, derived from the address we were reached on. */
function wsBaseOf(url: URL): string {
  return url.protocol === 'https:' ? `wss://${url.host}` : `ws://${url.host}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Accept the action either as a query parameter or in a JSON body, so the
    // endpoint behaves identically whether it is called through the Pages
    // function, straight from the browser, or through the dev proxy.
    let posted: { action?: string; roomId?: string } = {};
    if (request.method === 'POST') {
      const clone = request.clone();
      posted = (await clone.json().catch(() => ({}))) as typeof posted;
    }

    const action = url.searchParams.get('action') || posted.action || '';
    const roomParam = url.searchParams.get('room') || posted.roomId || '';

    // Creating a room mints its id and owner key here rather than in the Pages
    // endpoint, so there is exactly one place that decides how these are
    // generated and the Pages function can stay a thin pass-through.
    if (action === 'create' && !roomParam) {
      const roomId = newRoomId();
      const adminKey = newAdminKey();
      const created = await routeToRoom(env, new Request(
        `https://room/?room=${roomId}&action=create&k=${adminKey}`,
      ));
      const body = (await created.json().catch(() => null)) as Record<string, unknown> | null;
      return corsJson({ ...(body || {}), roomId, adminKey, wsBase: wsBaseOf(url) });
    }

    if (!roomParam) {
      return corsJson({ error: 'missing room' }, 400);
    }

    // The room may have arrived in the body rather than the query, so rebuild
    // the request with it in the URL the Durable Object expects.
    if (!url.searchParams.get('room')) {
      const forwarded = new URL(request.url);
      forwarded.searchParams.set('room', roomParam);
      if (posted.action) forwarded.searchParams.set('action', posted.action);
      return routeToRoom(env, new Request(forwarded, request));
    }

    return routeToRoom(env, request);
  },
} satisfies ExportedHandler<Env>;

async function routeToRoom(env: Env, request: Request): Promise<Response> {
  const roomId = new URL(request.url).searchParams.get('room') || '';
  const id = env.ROOM_OBJECT.idFromName(roomId);
  const stub = env.ROOM_OBJECT.get(id);
  try {
    return await stub.fetch(request);
  } catch (err) {
    return corsJson({ error: 'room server error', detail: (err as Error).message }, 500);
  }
}