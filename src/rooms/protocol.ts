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
  /**
   * The server time at which the audio reaches `positionMs`. This may be in the
   * *future*: when it is, the room has agreed to begin at that instant and
   * every client is counting down to the same moment rather than starting
   * whenever its own message happened to arrive.
   */
  updatedAt: number;
  /** Non-null while a start is pending; the server time audio begins. */
  startAt: number | null;
  /** Increments on every authoritative playback change; clients ignore replays
    * of a state they have already converged on. */
  rev: number;
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
  /** Admin only. Seek carries `positionMs`; track carries `trackKey`/`videoId`.
   * `start` asks the referee to schedule a start — used when queueing the first
   * track of an idle room, so one message both changes track and begins. */
  | { t: 'control'; action: ControlAction; start?: boolean; positionMs?: number; trackKey?: string; videoId?: string }
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
  startAt: null,
  rev: 0,
};

/* Limits. Chat is capped so one enthusiastic person cannot flood the room. */
export const CHAT_MAX_LEN = 500;
export const CHAT_HISTORY = 200;
/** Messages allowed inside this window before a sender is ignored. */
export const CHAT_RATE_COUNT = 5;
export const CHAT_RATE_WINDOW_MS = 5000;

/**
 * How far ahead of "now" a start is scheduled.
 *
 * This exists because starting immediately is the single worst thing a sync
 * system can do: the track has to be downloaded and decoded first, and on a
 * phone that can take seconds. Whoever's network is fastest starts first and
 * everyone else is seconds behind before a single sample has been played.
 * Agreeing on one future moment removes that race entirely — a late device
 * simply joins mid-track and the convergence loop walks it back in.
 */
export const START_LEAD_MS = 4000;

/** Convergence band.
 *
 * These used to be 300/120, which meant two devices could sit at opposite
 * ends of the band — up to 240ms apart — and both be considered "in sync",
 * because each was only ever compared against the server, never against each
 * other. Correction is a ~1-2% rate nudge, which is inaudible, so the band can
 * be tight and the nudge does the rest. */
export const DRIFT_HARD_MS = 150;
/** Below this we leave the local element alone — correcting is audible. */
export const DRIFT_SOFT_MS = 20;