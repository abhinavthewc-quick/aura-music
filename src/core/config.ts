/* ===== 2867-2919 ===== */

    /* Google Sign-In (Sign in with Google) — used by the welcome screen and
       the admin panel. Create one at https://console.cloud.google.com/
       APIs & Services → Credentials → Create Credentials → OAuth client ID
       (type: Web application) and add your origins:
         - https://aura-music-01g.pages.dev
         - http://localhost:5173
       Then paste the Client ID below. */
    export const GOOGLE_CLIENT_ID = '563051437889-5qcvn8a4e64i5fh49got6g70iundv0m9.apps.googleusercontent.com';

    /* Google accounts allowed into the admin panel (the site itself is open). */
    export const ADMIN_EMAILS = [
      'vivekpereiraalbert@gmail.com',
      'abhinavthewc@gmail.com',
    ];
