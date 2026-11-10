/* Room UI decisions that must stay truthful even between server messages. */
import type { RoomView } from './roomClient';

export interface RoomInvite { roomId: string; adminKey: string | null }

/** Accept a code and both shipped invite formats; never navigate to pasted URLs. */
export function parseRoomInvite(value: string): RoomInvite | null {
  const raw = value.trim();
  if (/^[a-z0-9]{1,12}$/i.test(raw)) return { roomId: raw.toLowerCase(), adminKey: null };
  try {
    const url = new URL(raw, 'https://aura.invalid/rooms');
    if (!/^https?:$/.test(url.protocol)) return null;
    if (!/^\/(?:rooms(?:\.html)?)?\/?$/.test(url.pathname)) return null;
    const legacy = /^#\/room\/([a-z0-9]{1,12})(?:\?([^#]*))?$/i.exec(url.hash);
    const roomId = (url.searchParams.get('r') || legacy?.[1] || '').toLowerCase();
    if (!/^[a-z0-9]{1,12}$/.test(roomId)) return null;
    const adminKey = url.searchParams.get('k') || new URLSearchParams(legacy?.[2]).get('k') || null;
    return { roomId, adminKey };
  } catch { return null; }
}

/** Sharing is always listener-only, including the manual clipboard fallback. */
export function listenerInvite(origin: string, roomId: string): string {
  return `${origin}/rooms?r=${encodeURIComponent(roomId)}`;
}

export function canManageRoom(view: Pick<RoomView, 'you' | 'role' | 'closed'> | null): boolean {
  return Boolean(view?.you?.role === 'admin' && view.role === 'admin' && !view.closed);
}

export function formatTime(ms: number): string {
  const seconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export interface ListeningStatus {
  state: 'closed' | 'connecting' | 'idle' | 'error' | 'blocked' | 'loading' | 'starting' | 'syncing' | 'paused' | 'correcting' | 'live';
  label: string;
  detail: string;
}

export function listeningStatus(view: RoomView, audioError = ''): ListeningStatus {
  if (view.closed) return { state: 'closed', label: 'Disconnected from the room', detail: 'Reconnect to listen together again.' };
  if (!view.you) return { state: 'connecting', label: 'Connecting to the room', detail: 'Getting everyone on the same page.' };
  if (!view.playback.trackKey) return {
    state: 'idle', label: view.role === 'admin' ? 'Ready when you are' : 'Waiting for a record',
    detail: view.role === 'admin' ? 'Your first pick starts for everyone.' : 'An admin will choose what plays next.',
  };
  if (audioError) return { state: 'error', label: 'This track couldn’t play', detail: 'Reconnect to try loading it again.' };
  if (view.blocked && view.playback.playing) return { state: 'blocked', label: 'Sound is off on this device', detail: 'Turn on sound to join the room.' };
  if (view.loading || view.buffering) return { state: 'loading', label: 'Getting the track ready', detail: 'Loading the same record on your device.' };
  if (view.startInMs !== null) return { state: 'starting', label: 'Starting together', detail: 'Everyone starts at the same moment.' };
  if (!view.clockReady) return { state: 'syncing', label: 'Finding the room’s timing', detail: 'Your device is matching the room’s clock.' };
  if (!view.playback.playing) return { state: 'paused', label: 'Paused for everyone', detail: 'The room will pick up from the same place.' };
  if (!view.inSync || view.nudging) return { state: 'correcting', label: 'Catching the room’s beat', detail: 'Your playback is adjusting automatically.' };
  return { state: 'live', label: 'You’re in sync', detail: 'Your timing matches the room’s shared clock.' };
}
