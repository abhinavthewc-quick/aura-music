/* Room endpoint for the Pages site.
 *
 * Cloudflare does not allow a Durable Object inside a Pages project, so the
 * referee lives in a separate worker (rooms-worker/). Room ids, owner keys and
 * WebSocket URLs are all minted there; this file only forwards the request and
 * adds the human-facing share links, which need to know the site's origin.
 *
 * It deliberately does NOT require the admin Google session: friends and
 * family create rooms, not site administrators.
 */

interface Env {
  /** Public URL of the aura-rooms worker, e.g. https://aura-rooms.<sub>.workers.dev */
  ROOMS_WORKER_URL?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function urlOrigin(request: Request): string {
  try {
    return new URL(request.url).origin;
  } catch {
    return '';
  }
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
    const res = await fetch(`${workerUrl}/?action=create`).catch(() => null);
    if (!res) return json({ error: 'the room server is unreachable — try again' }, 502);
    if (!res.ok) return json({ error: 'could not create a room — try again' }, 502);

    const created = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (!created.roomId) return json({ error: 'the room server sent an unexpected reply' }, 502);

    const origin = urlOrigin(request);
    return json({
      ...created,
      shareUrl: `${origin}/rooms?r=${created.roomId}`,
      adminUrl: `${origin}/rooms?r=${created.roomId}&k=${created.adminKey}`,
    });
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