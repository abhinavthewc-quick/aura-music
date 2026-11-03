/* Cloudflare Pages Function — /api/bot
   Authenticated proxy between the admin panel and the Aura Farmer Worker.
   The Worker's admin token never reaches the browser. Every request is first
   verified by /api/admin's existing Google/session auth, then forwarded. */

import { onRequestPost as adminPost } from './admin';

interface Env {
  BOT_WORKER_URL?: string;
  BOT_ADMIN_TOKEN?: string;
  GH_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  ADMIN_PASSWORD?: string;
  HF_TOKEN?: string;
  HF_BUCKET_ID?: string;
  BOT_SERVICE_TOKEN?: string;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });

export const onRequestPost = async ({ request, env, ctx }: {
  request: Request;
  env: Env;
  ctx?: { waitUntil: (promise: Promise<unknown>) => void };
}): Promise<Response> => {
  if (!env.BOT_WORKER_URL || !env.BOT_ADMIN_TOKEN) {
    return json(
      {
        error:
          'Discord bot backend is not configured — set BOT_WORKER_URL and BOT_ADMIN_TOKEN in the Pages environment.',
      },
      500,
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  /* Reuse the admin function's credential checks. No bot call can bypass the
     allow-list, and the Worker token stays server-side. */
  let verified: any = null;
  let verifyRes: Response;
  try {
    verifyRes = await adminPost({
      request: new Request(new URL('/api/admin', request.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'verify', credential: body?.credential }),
      }),
      env,
      ctx,
    });
    verified = await verifyRes.json().catch(() => null);
  } catch (e) {
    return json({ error: 'sign-in check failed — ' + ((e as Error).message || 'unknown error') }, 500);
  }
  if (!verifyRes.ok || !verified?.email) {
    return json({ error: verified?.error || 'Sign-in required.' }, verifyRes.status || 401);
  }

  const payload = { ...body };
  delete payload.credential;

  let upstream: Response;
  try {
    upstream = await fetch(env.BOT_WORKER_URL.replace(/\/+$/, '') + '/v1/admin', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.BOT_ADMIN_TOKEN}`,
        'x-admin-email': String(verified.email).slice(0, 200),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(40_000),
    });
  } catch (e) {
    return json(
      {
        error:
          'Aura Farmer Worker is unreachable — ' +
          ((e as Error).message || 'network error') +
          '. Check BOT_WORKER_URL.',
      },
      502,
    );
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
};
