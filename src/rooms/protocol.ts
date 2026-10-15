/* Shared vocabulary for listening rooms.
 *
 * This module is intentionally free of DOM, audio and network concerns so the
 * exact same types describe messages between a browser client and whichever
 * component is acting as the room referee — a Durable Object in production, or
 * the BroadcastChannel server in local development.
 *
 * Design rule that keeps this simple: ONLY admins may change playback. There is
 * therefore at most one controller and no conflict resolution is needed when
 * two people press play at the same moment.
 */

export type Role = 'admin' | 'listener';

export interface Participant {
  id: string;
  name: string;
  role: Role;
  joinedAt: number;
}

/** What the room is doing right now. `updatedAt` is the server's clock. */
export interface PlaybackState {
  trackKey: string | null;
  videoId: string | null;
  positionMs: number;
  playing: boolean;
  updatedAt: number;
}

export interface ChatMessage {
  id: string;
  name: string;
  text: string;
  at: number;
}

/** Everything a client needs to render the room. */
export interface RoomSnapshot {
  roomId: string;
  playback: PlaybackState;
  queue: string[];
  participants: Participant[];
  expiresAt: number | null;
}

export type ControlAction = 'play' | 'pause' | 'seek' | 'track';

export type ClientMessage =
  /** Open a connection. `adminKey` is what proves you may control playback. */
  | { t: 'hello'; clientId: string; name: string; adminKey?: string }
  /** Clock sync. Server answers with `pong` carrying the same `sentAt`. */
  | { t: 'ping'; sentAt: number }
  /** Admin only. Seek carries `positionMs`; track carries `trackKey`/`videoId`. */
  | { t: 'control'; action: ControlAction; positionMs?: number; trackKey?: string; videoId?: string }
  /** Admin only. */
  | { t: 'queue'; action: 'add' | 'remove' | 'clear' | 'next'; trackKey?: string }
  /** Admin only. */
  | { t: 'role'; action: 'promote' | 'demote'; participantId: string }
  | { t: 'chat'; text: string }
  | { t: 'buffering'; buffering: boolean }
  | { t: 'bye' };

export type ServerMessage =
  | { t: 'welcome'; you: Participant; snapshot: RoomSnapshot; serverTime: number }
  /** Authoritative playback state. Clients converge on this. */
  | { t: 'playback'; playback: PlaybackState; serverTime: number }
  | { t: 'queue'; queue: string[]; serverTime: number }
  | { t: 'participants'; participants: Participant[]; serverTime: number }
  | { t: 'chat'; message: ChatMessage }
  /** Room is ending; `reason` is safe to show to the user. */
  | { t: 'closing'; reason: string }
  | { t: 'pong'; sentAt: number; serverTime: number };

export const EMPTY_PLAYBACK: PlaybackState = {
  trackKey: null,
  videoId: null,
  positionMs: 0,
  playing: false,
  updatedAt: 0,
};

/* Limits. Chat is capped so one enthusiastic person cannot flood the room. */
export const CHAT_MAX_LEN = 500;
export const CHAT_HISTORY = 200;
/** Messages allowed inside this window before a sender is ignored. */
export const CHAT_RATE_COUNT = 5;
export const CHAT_RATE_WINDOW_MS = 5000;
/** Clients correct themselves only when they are this far out. */
export const DRIFT_HARD_MS = 300;
/** Below this we leave the local element alone — correcting is audible. */
export const DRIFT_SOFT_MS = 120;