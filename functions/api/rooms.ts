/* Room creation endpoint for the Pages site.
 *
 * Cloudflare does not allow a Durable Object to live inside a Pages project, so
 * the referee itself lives in a separate worker (rooms-worker/). This endpoint
 * mints the room id and owner key, asks that worker to register the room, and
 * hands the browser back the URL it should open its WebSocket against.
 *
 * It deliberately does NOT require the admin Google session: friends and
 * family create rooms, not site administrators.
 */

interface Env {
  /** Public URL of the aura-rooms worker, e.g. https://aura-rooms.<sub>.workers.dev */
  ROOMS_WORKER_URL?: string;
}

/** Short, unambiguous room code people can read aloud. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

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

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  const workerUrl = (env.ROOMS_WORKER_URL || '').replace(/\/$/, '');
  if (!workerUrl) {
    return json({ error: 'rooms are not configured — set ROOMS_WORKER_URL in the Pages environment' }, 503);
  }

  let body: { action?: string; roomId?: string } = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  if (body.action === 'create') {
    // Retry on the vanishingly unlikely chance of a code collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const roomId = newRoomId();
      const adminKey = newAdminKey();

      const res = await fetch(`${workerUrl}/?room=${roomId}&action=create&k=${adminKey}`).catch(() => null);

      if (!res) return json({ error: 'the room server is unreachable — try again' }, 502);
      if (res.status === 429) return json({ error: 'too many rooms created — try again later' }, 429);
      if (!res.ok) continue;

      const origin = urlOrigin(request);
      return json({
        roomId,
        adminKey,
        wsBase: workerUrl.replace(/^http/, 'ws'),
        shareUrl: `${origin}/#/room/${roomId}`,
        adminUrl: `${origin}/#/room/${roomId}?k=${adminKey}`,
      });
    }
    return json({ error: 'could not allocate a room — try again' }, 500);
  }

  if (body.action === 'exists') {
    const roomId = String(body.roomId || '').replace(/[^a-z0-9]/gi, '');
    if (!roomId) return json({ error: 'roomId required' }, 400);
    const res = await fetch(`${workerUrl}/?room=${roomId}&action=exists`).catch(() => null);
    if (!res) return json({ error: 'the room server is unreachable' }, 502);
    return json(await res.json());
  }

  return json({ error: 'unknown action' }, 400);
};

function urlOrigin(request: Request): string {
  try {
    return new URL(request.url).origin;
  } catch {
    return '';
  }
}