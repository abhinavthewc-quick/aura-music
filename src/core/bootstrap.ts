import { getSession } from './session';

/* A sign-in visit should not fetch a catalogue, decode artwork or initialize
   audio. Returning listeners and successful sign-ins load the same runtime. */
let application: Promise<void> | undefined;

export function loadApplication(): Promise<void> {
  if (!getSession()) return Promise.reject(new Error('Session ended'));
  if (!application) {
    application = import('../runtime').then(async ({ ready }) => {
      await ready;
      // Storage can change or the session can expire while chunks are loading.
      if (!getSession()) throw new Error('Session ended');
      const app = document.getElementById('musicApp');
      if (app) { app.hidden = false; app.inert = false; }
      const welcome = document.getElementById('welcomeScreen');
      if (welcome) {
        welcome.hidden = true;
        welcome.classList.add('hidden');
        welcome.inert = true;
        welcome.setAttribute('aria-hidden', 'true');
      }
      document.documentElement.removeAttribute('data-aura-entry');
    }).catch(error => {
      application = undefined;
      throw error;
    });
  }
  return application;
}
