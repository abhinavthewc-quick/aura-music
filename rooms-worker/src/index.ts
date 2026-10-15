/**
 * Entry point for the Aura Rooms worker.
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const roomId = url.searchParams.get('room') || '';

    if (!roomId) {
      return Response.json({ error: 'missing room' }, { status: 400 });
    }

    const id = env.ROOM_OBJECT.idFromName(roomId);
    const stub = env.ROOM_OBJECT.get(id);

    try {
      return await stub.fetch(request);
    } catch (err) {
      return Response.json(
        { error: 'room server error', detail: (err as Error).message },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Env>;