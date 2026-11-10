/* Load Google's UI only after someone chooses Google sign-in. Failed loads
   remain retryable; token verification still happens in google-auth.ts. */
let loading: Promise<void> | undefined;

export function loadGoogleIdentity(): Promise<void> {
  if ((window as any).google?.accounts?.id) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.id = 'auraGsiScript';
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    const timeout = window.setTimeout(() => fail(), 15000);
    const fail = () => {
      clearTimeout(timeout);
      script.remove();
      reject(new Error('Could not load Google sign-in. Try again or use email and password.'));
    };
    script.onload = () => {
      clearTimeout(timeout);
      if ((window as any).google?.accounts?.id) resolve();
      else fail();
    };
    script.onerror = fail;
    document.head.appendChild(script);
  }).catch(error => { loading = undefined; throw error; });
  return loading;
}
