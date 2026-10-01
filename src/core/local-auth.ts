/* Local email+password fallback accounts for the main site.
   Used when Google Sign-In is unavailable. Google never shares the user's
   Google password with any site — this is a separate, device-local password.
   Only a salted PBKDF2-SHA256 hash is stored (localStorage); the password
   itself never leaves the device. */

const ACCOUNTS_KEY = 'auraLocalAccounts_v1';
const ITERATIONS = 150000;

interface LocalAccount {
  salt: string;   // base64
  hash: string;   // base64 PBKDF2-SHA256
  createdAt: number;
}

const enc = new TextEncoder();

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password: string, saltB64: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unb64(saltB64), iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return b64(bits);
}

function readAll(): Record<string, LocalAccount> {
  try {
    return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, LocalAccount>): void {
  localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(map));
}

export function normEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

export function hasLocalAccount(email: string): boolean {
  return !!readAll()[normEmail(email)];
}

export async function registerLocalAccount(email: string, password: string): Promise<void> {
  const e = normEmail(email);
  const all = readAll();
  if (all[e]) throw new Error('An account for this email already exists on this device — sign in instead.');
  const saltB64 = b64(crypto.getRandomValues(new Uint8Array(16)));
  all[e] = { salt: saltB64, hash: await derive(password, saltB64), createdAt: Date.now() };
  writeAll(all);
}

export async function loginLocalAccount(email: string, password: string): Promise<boolean> {
  const all = readAll();
  const acc = all[normEmail(email)];
  if (!acc) throw new Error('No account with this email on this device — create one first.');
  const hash = await derive(password, acc.salt);
  return hash === acc.hash;
}
