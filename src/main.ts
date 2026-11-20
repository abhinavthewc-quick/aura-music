import './ui/loader';
import './ui/a11y';
import './ui/login';
import { installCoverFallback } from './core/dom';
import { markAppReady } from './core/boot';
import { getSession } from './core/session';

installCoverFallback();

/* The sign-in screen needs the loader, the login form and nothing else. The
   app interior — player, library, lyrics, playlists, rooms, expose — is a
   separate chunk so a visitor who is only looking at the sign-in screen never
   downloads or evaluates it, and a signed-in visitor starts it immediately
   alongside the catalogue prefetch that is already in flight. */
const startApp = () => import('./app').then((m) => m.initApp());

if (getSession()) {
  void startApp();
} else {
  /* The inline head script hides the overlay for signed-in visitors before
     first paint; if the session expired between that check and here, give the
     sign-in screen back. */
  document.documentElement.removeAttribute('data-aura-authed');
  markAppReady('welcome');
  document.addEventListener('aura:signed-in', () => { void startApp(); }, { once: true });
}
