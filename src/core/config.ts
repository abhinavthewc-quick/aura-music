import { state } from './state';
/* ===== 2867-2919 ===== */
    /* ============================================================
       SITE-WIDE CONFIG — set this ONCE, and every visitor gets
       working YouTube Music search with zero setup on their end.

       1. Go to https://console.cloud.google.com/apis/library/youtube.googleapis.com
       2. Enable "YouTube Data API v3", then create an API key
          (Credentials → Create Credentials → API key).
       3. Restrict the key to "YouTube Data API v3" + your site's
          domain (HTTP referrers) so it can't be used elsewhere.
       4. Paste it below between the quotes.

       Notes for you (not shown to visitors):
       - The free tier is 10,000 units/day; a search costs ~100
         units, so this is shared across ALL visitors (~100
         searches/day total, not per-person). If the site gets
         busy, YouTube results may stop refreshing until the
         quota resets — Audius/iTunes/Deezer keep working either
         way since they don't use this key.
       - Because this is a static page, the key is technically
         visible in the page source to anyone who looks — that's
         normal for a public client-side key and is why step 3
         (domain-restricting it) matters.
       ============================================================ */
    export const AURA_YOUTUBE_API_KEY = '';
    // Jamendo — free, Creative Commons–licensed catalog of full tracks (not
    // previews). Get a free client_id in ~1 minute at
    // https://devportal.jamendo.com and paste it in Settings, or hardcode a
    // site-wide default here. Left blank, this source just stays quiet,
    // same as YouTube above without a key.
    export const AURA_JAMENDO_CLIENT_ID = '';

    /* Google Sign-In (Sign in with Google) — used by the welcome screen and
       the admin panel. Create one at https://console.cloud.google.com/
       APIs & Services → Credentials → Create Credentials → OAuth client ID
       (type: Web application) and add your origins:
         - https://aura-music-01g.pages.dev
         - http://localhost:5173
       Then paste the Client ID below. */
    export const GOOGLE_CLIENT_ID = '563051437889-5qcvn8a4e64i5fh49got6g70iundv0m9.apps.googleusercontent.com';

    /* The only Google account allowed to use the site and the admin panel. */
    export const ALLOWED_EMAIL = 'vivekpereiraalbert@gmail.com';
