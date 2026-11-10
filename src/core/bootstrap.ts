/* A sign-in visit should not fetch a catalogue, decode artwork or initialize
   audio. Returning listeners and successful sign-ins load the same runtime. */
let application: Promise<void> | undefined;

export function loadApplication(): Promise<void> {
  if (!application) {
    application = import('../runtime').then(async ({ ready }) => {
      await ready;
      const app = document.getElementById('musicApp');
      if (app) { app.hidden = false; app.inert = false; }
      const welcome = document.getElementById('welcomeScreen');
      if (welcome) {
        welcome.classList.add('hidden');
        welcome.inert = true;
        welcome.setAttribute('aria-hidden', 'true');
      }
    }).catch(error => {
      application = undefined;
      throw error;
    });
  }
  return application;
}
