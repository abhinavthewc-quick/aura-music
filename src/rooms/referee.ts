/* The room referee, for local development.
 *
 * In production this logic is the Durable Object. It is kept deliberately free
 * of any transport detail beyond a `deliver` callback, so that porting it means
 * replacing how messages arrive and leave — not rewriting the rules.
 *
 * It owns everything that matters:
 *   - the single authoritative playback state and its timestamp
 *   - who is in the room and what they may do
 *   - the shared queue
 *   - chat, with a history cap and a rate limit
 *   - the grace period and the admin-rescue window
 */

import {
  CHAT_HISTORY,
  CHAT_MAX_LEN,
  CHAT_RATE_COUNT,
  CHAT_RATE_WINDOW_MS,
  EMPTY_PLAYBACK,
  START_LEAD_MS,
  type ChatMessage,
  type ClientMessage,
  type Participant,
  type PlaybackState,
  type RoomSnapshot,
  type ServerMessage,
} from './protocol';

/** How long a room survives after everyone leaves. */
export const GRACE_MS = 3 * 60 * 1000;
/** How long listeners can claim control after the last admin leaves. */
export const ADMIN_RESCUE_MS = 30 * 1000;

export interface RefereeEvents {
  deliver(clientId: string, message: ServerMessage): void;
  /** The room has ended and the referee should stop. */
  finished(reason: string): void;
}

/**
 * Timer injection. The referee runs unchanged in a browser tab (local
 * development) and inside a Durable Object, which has no `window`.
 */
export interface RefereeTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const windowTimers: RefereeTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** Everything the referee holds, in a shape that survives serialisation. */
export interface RefereeState {
  playback: PlaybackState;
  queue: string[];
  participants: Participant[];
  adminKeys: [string, string][];
  chat: ChatMessage[];
  expiresAt: number | null;
}

export interface RefereeOptions {
  timers?: RefereeTimers;
  /** Called whenever authoritative state changes, so it can be persisted. */
  onChange?: (state: RefereeState) => void;
}

interface ChatRateEntry { at: number[] }

export class RoomReferee {
  readonly roomId: string;
  private playback: PlaybackState = { ...EMPTY_PLAYBACK };
  private queue: string[] = [];
  private participants = new Map<string, Participant>();
  /** Maps adminKey -> participantId. Possession of a key *is* the authority. */
  private adminKeys = new Map<string, string>();
  private chat: ChatMessage[] = [];
  private chatRate = new Map<string, ChatRateEntry>();
  private expiresAt: number | null = null;
  private rescueTimer: unknown = null;
  private expiryTimer: unknown = null;
  private events: RefereeEvents;
  private timers: RefereeTimers;
  private onChange?: (state: RefereeState) => void;
  private startedAt = Date.now();

  constructor(
    roomId: string,
    ownerKey: string,
    ownerId: string,
    events: RefereeEvents,
    options: RefereeOptions = {},
  ) {
    this.roomId = roomId;
    this.events = events;
    this.timers = options.timers ?? windowTimers;
    this.onChange = options.onChange;

    // An empty key means "no owner yet" — the Durable Object creates the room
    // lazily and seeds the owner separately.
    if (ownerKey) {
      this.adminKeys.set(ownerKey, ownerId);
      this.participants.set(ownerId, {
        id: ownerId, name: 'host', role: 'admin', joinedAt: this.startedAt,
      });
    }
  }

  /**
   * Make a key valid without creating a participant for it. Used when a room is
   * created: the key is real before anybody connects, and whoever presents it
   * first becomes the admin.
   */
  registerAdminKey(ownerKey: string): void {
    if (!ownerKey || this.adminKeys.has(ownerKey)) return;
    this.adminKeys.set(ownerKey, 'pending');
    this.changed();
  }

  /**
   * Register the room creator as the first admin. Ignored once the room has
   * anybody in it, so a replayed create request cannot reset a live room.
   */
  seedOwner(ownerId: string, ownerKey: string, name = 'host'): void {
    if (this.participants.size > 0) return;
    this.participants.set(ownerId, { id: ownerId, name, role: 'admin', joinedAt: this.now() });
    this.adminKeys.set(ownerKey, ownerId);
    this.broadcastParticipants();
  }

  /* ---- persistence (used by the Durable Object) ---- */

  exportState(): RefereeState {
    return {
      playback: this.playback,
      queue: this.queue,
      participants: [...this.participants.values()],
      adminKeys: [...this.adminKeys.entries()],
      chat: this.chat,
      expiresAt: this.expiresAt,
    };
  }

  importState(state: RefereeState): void {
    this.playback = state.playback ?? { ...EMPTY_PLAYBACK };
    this.queue = state.queue ?? [];
    this.participants = new Map((state.participants ?? []).map((p) => [p.id, p]));
    this.adminKeys = new Map(state.adminKeys ?? []);
    this.chat = state.chat ?? [];
    this.expiresAt = state.expiresAt ?? null;
  }

  private changed(): void {
    this.onChange?.(this.exportState());
  }

  now(): number {
    return Date.now();
  }

  private snapshot(): RoomSnapshot {
    return {
      roomId: this.roomId,
      playback: this.playback,
      queue: this.queue,
      participants: [...this.participants.values()],
      expiresAt: this.expiresAt,
    };
  }

  /**
   * Authority is possession of a key. The key is bound to whichever client
   * last presented it, so an admin who reconnects from a new tab (and therefore
   * a new clientId) keeps control instead of silently dropping to listener.
   */
  private isAdmin(clientId: string, key?: string): boolean {
    // The key is checked FIRST. On a fresh join the participant does not exist
    // yet, so looking them up before validating the key would reject the very
    // person presenting it.
    if (key) {
      for (const [k] of this.adminKeys) {
        if (k === key) {
          this.adminKeys.set(k, clientId);
          return true;
        }
      }
    }
    const p = this.participants.get(clientId);
    return p?.role === 'admin';
  }

  handle(clientId: string, message: ClientMessage): void {
    switch (message.t) {
      case 'hello': {
        const known = this.participants.get(clientId);
        const role: Participant['role'] = this.isAdmin(clientId, message.adminKey) ? 'admin' : 'listener';
        this.participants.set(clientId, {
          id: clientId,
          name: message.name || 'listener',
          role,
          joinedAt: known?.joinedAt ?? this.now(),
        });
        if (message.adminKey && this.adminKeys.get(message.adminKey) === clientId) {
          this.participants.get(clientId)!.role = 'admin';
        }
        this.cancelExpiry();
        this.broadcastParticipants();
        this.events.deliver(clientId, {
          t: 'welcome',
          you: this.participants.get(clientId)!,
          snapshot: this.snapshot(),
          serverTime: this.now(),
        });
        return;
      }

      case 'ping':
        this.events.deliver(clientId, { t: 'pong', sentAt: message.sentAt, serverTime: this.now() });
        return;

      case 'control': {
        // Silently ignored rather than reported: telling someone the room
        // closed because they pressed play would be alarming and wrong.
        if (!this.isAdmin(clientId) && !this.claimableBy(clientId)) return;
        this.applyControl(clientId, message);
        return;
      }

      case 'queue': {
        if (!this.isAdmin(clientId)) return;
        this.applyQueue(clientId, message);
        return;
      }

      case 'role': {
        if (!this.isAdmin(clientId)) return;
        const target = this.participants.get(message.participantId);
        if (!target) return;
        // Nobody may demote the last admin — that would orphan the room.
        if (message.action === 'demote') {
          const admins = [...this.participants.values()].filter((p) => p.role === 'admin');
          if (admins.length <= 1 && target.role === 'admin') return;
          target.role = 'listener';
          const key = this.keyFor(target.id);
          if (key) this.adminKeys.delete(key);
        } else {
          target.role = 'admin';
        }
        this.broadcastParticipants();
        return;
      }

      case 'chat': {
        this.pushChat(clientId, message.text);
        return;
      }

      case 'buffering':
        // Advisory only — v1 shows buffering state but never pauses the room.
        return;

      case 'bye': {
        this.participants.delete(clientId);
        this.chatRate.delete(clientId);
        this.broadcastParticipants();
        this.evaluateLifetime();
        return;
      }
    }
  }

  private keyFor(clientId: string): string | undefined {
    for (const [key, id] of this.adminKeys) if (id === clientId) return key;
    return undefined;
  }

  /** During the rescue window a listener may take control of an orphaned room. */
  private claimableBy(clientId: string): boolean {
    if (!this.rescueTimer) return false;
    return this.participants.has(clientId);
  }

  private applyControl(clientId: string, message: Extract<ClientMessage, { t: 'control' }>): void {
    const now = this.now();

    // Someone claiming control during the rescue window gets promoted.
    if (this.rescueTimer) {
      const p = this.participants.get(clientId);
      if (p) p.role = 'admin';
      this.endRescue();
      this.broadcastParticipants();
    }

    switch (message.action) {
      case 'play':
        if (!this.playback.trackKey) return;
        // Resume and first-play both schedule a start a few seconds out rather
        // than beginning immediately, so every device begins on the same
        // instant instead of whenever its own download and decode finish.
        this.scheduleStart(this.playback.positionMs);
        break;
      case 'pause':
        // Trust the position the pausing client reported: it is the only party
        // that knows where the audio actually is. Using our own stored value
        // would snap everyone back to the last seek instead.
        this.playback = {
          ...this.playback,
          playing: false,
          startAt: null,
          positionMs: typeof message.positionMs === 'number' && message.positionMs >= 0
            ? message.positionMs
            : this.playback.positionMs,
          updatedAt: now,
        };
        break;
      case 'seek':
        this.playback = {
          ...this.playback,
          positionMs: Math.max(0, message.positionMs ?? 0),
          updatedAt: now,
          // A seek during a pending start keeps the agreed start moment; one
          // during live playback drops it, since there is nothing to wait for.
          startAt: this.playback.startAt != null && this.playback.startAt > now
            ? this.playback.startAt
            : null,
        };
        break;
      case 'track': {
        if (!message.trackKey) return;
        const sameTrack = this.playback.trackKey === message.trackKey;
        const positionMs = sameTrack ? this.playback.positionMs : 0;
        this.playback = {
          trackKey: message.trackKey,
          videoId: message.videoId ?? null,
          positionMs,
          playing: this.playback.playing,
          updatedAt: now,
          startAt: null,
        };
        // Switching tracks mid-playback is the worst case for sync: everyone
        // has to download a different file first. Schedule a fresh start so
        // the room re-converges at a single agreed moment.
        if (this.playback.playing) this.scheduleStart(positionMs);
        break;
      }
    }
    this.broadcastPlayback();
  }

  /**
   * Begin playback at one agreed future instant.
   *
   * `updatedAt` is pushed into the future alongside `startAt`, which makes the
   * client's "expected position" formula correct for free: before the start it
   * clamps at `positionMs`, and after it advances from that same instant.
   */
  private scheduleStart(positionMs: number): void {
    const startAt = this.now() + START_LEAD_MS;
    this.playback = {
      ...this.playback,
      playing: true,
      positionMs,
      startAt,
      updatedAt: startAt,
    };
  }

  private applyQueue(clientId: string, message: Extract<ClientMessage, { t: 'queue' }>): void {
    const now = this.now();
    switch (message.action) {
      case 'add':
        if (message.trackKey && !this.queue.includes(message.trackKey)) this.queue.push(message.trackKey);
        break;
      case 'remove':
        this.queue = this.queue.filter((k) => k !== message.trackKey);
        break;
      case 'clear':
        this.queue = [];
        break;
      case 'next': {
        const nextKey = this.queue.shift();
        if (nextKey) {
          this.playback = {
            ...this.playback, trackKey: nextKey, positionMs: 0, updatedAt: now, startAt: null,
          };
          // Same reasoning as a track change: a fresh download is due, so give
          // the room an agreed moment to begin rather than racing it.
          if (this.playback.playing) this.scheduleStart(0);
        } else {
          this.playback = {
            ...this.playback, playing: false, positionMs: 0, updatedAt: now, startAt: null,
          };
        }
        break;
      }
    }
    this.events.deliver(clientId, { t: 'pong', sentAt: now, serverTime: now }); // keep client clock fresh
    this.broadcastQueue();
    this.broadcastPlayback();
  }

  private pushChat(clientId: string, text: string): void {
    const p = this.participants.get(clientId);
    if (!p) return;

    // Rate limit per participant, not per connection, so reconnects do not
    // hand someone a fresh allowance.
    const entry = this.chatRate.get(clientId) ?? { at: [] };
    const now = this.now();
    entry.at = entry.at.filter((t) => now - t < CHAT_RATE_WINDOW_MS);
    if (entry.at.length >= CHAT_RATE_COUNT) return;
    entry.at.push(now);
    this.chatRate.set(clientId, entry);

    const clean = String(text || '').slice(0, CHAT_MAX_LEN).trim();
    if (!clean) return;

    const message: ChatMessage = {
      id: `${now}-${clientId}-${this.chat.length}`,
      name: p.name,
      text: clean,
      at: now,
    };
    this.chat.push(message);
    if (this.chat.length > CHAT_HISTORY) this.chat.shift();
    this.changed();
    for (const id of this.participants.keys()) {
      this.events.deliver(id, { t: 'chat', message });
    }
  }

  /**
   * A participant's connection went away without a clean goodbye — the tab was
   * closed, the network dropped, the socket died. Same effect as `bye`.
   */
  disconnect(clientId: string): void {
    if (!this.participants.has(clientId)) return;
    this.participants.delete(clientId);
    this.chatRate.delete(clientId);
    this.broadcastParticipants();
    this.evaluateLifetime();
  }

  private broadcastPlayback(): void {
    this.changed();
    const payload: ServerMessage = { t: 'playback', playback: this.playback, serverTime: this.now() };
    for (const id of this.participants.keys()) this.events.deliver(id, payload);
  }

  private broadcastQueue(): void {
    this.changed();
    const payload: ServerMessage = { t: 'queue', queue: this.queue, serverTime: this.now() };
    for (const id of this.participants.keys()) this.events.deliver(id, payload);
  }

  private broadcastParticipants(): void {
    this.changed();
    const payload: ServerMessage = {
      t: 'participants',
      participants: [...this.participants.values()],
      serverTime: this.now(),
    };
    for (const id of this.participants.keys()) this.events.deliver(id, payload);
  }

  /* ---- room lifetime ---- */

  private cancelExpiry(): void {
    if (this.expiryTimer !== null) { this.timers.clearTimeout(this.expiryTimer); this.expiryTimer = null; }
    this.expiresAt = null;
  }

  private evaluateLifetime(): void {
    if (this.participants.size > 0) {
      this.cancelExpiry();
      if (!this.rescueTimer) this.startRescueIfOrphaned();
      return;
    }

    // Nobody left. Start the grace countdown.
    if (this.expiryTimer !== null) return;
    this.expiresAt = this.now() + GRACE_MS;
    this.changed();
    this.expiryTimer = this.timers.setTimeout(() => {
      this.events.finished('room closed — nobody came back');
    }, GRACE_MS);
  }

  private startRescueIfOrphaned(): void {
    const admins = [...this.participants.values()].filter((p) => p.role === 'admin');
    if (admins.length > 0) return;

    // An admin left but listeners remain — give them a moment to take over
    // rather than pulling the music out from under everyone.
    this.rescueTimer = this.timers.setTimeout(() => {
      this.rescueTimer = null;
      this.events.finished('room closed — no admin left');
    }, ADMIN_RESCUE_MS);
  }

  private endRescue(): void {
    if (this.rescueTimer !== null) { this.timers.clearTimeout(this.rescueTimer); this.rescueTimer = null; }
  }

  dispose(): void {
    this.cancelExpiry();
    this.endRescue();
  }
}