/* Shared Google session for the site and the admin panel. The session is
   created only after the ID token has been verified locally; the admin
   panel also re-sends the raw token to /api/admin, where the server
   verifies it again (signature + email) before doing anything. */

export const SESSION_KEY = 'auraSession_v2';

export interface AuraSession {
  email: string;
  name: string;
  picture: string;
  exp: number; // unix seconds — same as the ID token exp
  token: string; // raw Google ID token (valid ~1h)
}

export function getSession(): AuraSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.email || !s.token || typeof s.exp !== 'number' || s.exp * 1000 <= Date.now()) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return s as AuraSession;
  } catch {
    return null;
  }
}

export function setSession(s: AuraSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export function getIdToken(): string {
  return getSession()?.token || '';
}

/* ---------- per-email username profiles (main site) ----------
   The username chosen at first sign-in is tied to the Google address and
   stored locally as {"email": "username"}. Changing it in Settings updates
   the same map, so the name follows the account on this device. */

const PROFILES_KEY = 'auraProfiles_v1';

export function getProfileUsername(email: string): string {
  try {
    const map = JSON.parse(localStorage.getItem(PROFILES_KEY) || '{}');
    return String(map[email] || '').trim();
  } catch {
    return '';
  }
}

export function setProfileUsername(email: string, username: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(PROFILES_KEY) || '{}');
    map[email] = username;
    localStorage.setItem(PROFILES_KEY, JSON.stringify(map));
  } catch { /* storage unavailable */ }
}

export function normalizeUsername(raw: string): string {
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

export function isValidUsername(name: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N} _-]{1,19}$/u.test(name);
}
