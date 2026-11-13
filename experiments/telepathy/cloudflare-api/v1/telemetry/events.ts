/* Cloudflare Pages Function: POST /api/v1/telemetry/events
 *
 * Micro-telemetry collector running at the Cloudflare Edge.
 */

interface KVNamespaceLike {
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface Env {
  TELEMETRY_KV?: KVNamespaceLike;
}

interface TelemetryEventPayload {
  userId: string;
  trackId: string;
  eventType: string;
  completionRatio?: number;
  timeBlock: string;
  dayType: string;
  audioRoute: string;
  weather?: string;
  createdAt?: string;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

export const onRequestOptions = async (): Promise<Response> => {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
};

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  let body: TelemetryEventPayload;

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'invalid JSON' }, 400);
  }

  const { userId, trackId, eventType } = body;
  if (!userId || !trackId || !eventType) {
    return jsonResponse({ error: 'userId, trackId, and eventType are required' }, 400);
  }

  // If KV is bound to the Pages environment, store event key
  if (env.TELEMETRY_KV) {
    try {
      const key = `telem:${userId}:${Date.now()}:${trackId}`;
      await env.TELEMETRY_KV.put(key, JSON.stringify(body), {
        expirationTtl: 30 * 24 * 3600, // 30 days retention
      });
    } catch {
      // ignore KV transient errors
    }
  }

  return jsonResponse(
    {
      status: 'logged',
      eventType,
      trackId,
      timestamp: body.createdAt || new Date().toISOString(),
    },
    201
  );
};
