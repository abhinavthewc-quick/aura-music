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
  private rescueTimer: number | null = null;
  private expiryTimer: number | null = null;
  private events: RefereeEvents;
  private startedAt = Date.now();

  constructor(roomId: string, ownerKey: string, ownerId: string, events: RefereeEvents) {
    this.roomId = roomId;
    this.events = events;

    this.adminKeys.set(ownerKey, ownerId);
    this.participants.set(ownerId, {
      id: ownerId, name: 'host', role: 'admin', joinedAt: this.startedAt,
    });
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

  private isAdmin(clientId: string, key?: string): boolean {
    const p = this.participants.get(clientId);
    if (!p) return false;
    if (p.role === 'admin') return true;
    if (key && this.adminKeys.get(key) === clientId) return true;
    return false;
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
        if (!this.isAdmin(clientId, undefined) && !this.claimableBy(clientId)) {
          this.events.deliver(clientId, { t: 'closing', reason: 'only admins control playback' });
          return;
        }
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
          this.adminKeys.delete(this.keyFor(target.id));
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
        this.playback = { ...this.playback, playing: true, positionMs: this.playback.positionMs, updatedAt: now };
        break;
      case 'pause':
        // Freeze the position at the moment of the pause, not the last seek.
        this.playback = { ...this.playback, playing: false, positionMs: this.playback.positionMs, updatedAt: now };
        break;
      case 'seek':
        this.playback = { ...this.playback, positionMs: Math.max(0, message.positionMs ?? 0), updatedAt: now };
        break;
      case 'track': {
        if (!message.trackKey) return;
        const sameTrack = this.playback.trackKey === message.trackKey;
        this.playback = {
          trackKey: message.trackKey,
          videoId: message.videoId ?? null,
          positionMs: sameTrack ? this.playback.positionMs : 0,
          playing: this.playback.playing,
          updatedAt: now,
        };
        break;
      }
    }
    this.broadcastPlayback();
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
          this.playback = { ...this.playback, trackKey: nextKey, positionMs: 0, updatedAt: now };
        } else {
          this.playback = { ...this.playback, playing: false, positionMs: 0, updatedAt: now };
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
    for (const id of this.participants.keys()) {
      this.events.deliver(id, { t: 'chat', message });
    }
  }

  private broadcastPlayback(): void {
    const payload: ServerMessage = { t: 'playback', playback: this.playback, serverTime: this.now() };
    for (const id of this.participants.keys()) this.events.deliver(id, payload);
  }

  private broadcastQueue(): void {
    const payload: ServerMessage = { t: 'queue', queue: this.queue, serverTime: this.now() };
    for (const id of this.participants.keys()) this.events.deliver(id, payload);
  }

  private broadcastParticipants(): void {
    const payload: ServerMessage = {
      t: 'participants',
      participants: [...this.participants.values()],
      serverTime: this.now(),
    };
    for (const id of this.participants.keys()) this.events.deliver(id, payload);
  }

  /* ---- room lifetime ---- */

  private cancelExpiry(): void {
    if (this.expiryTimer !== null) { window.clearTimeout(this.expiryTimer); this.expiryTimer = null; }
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
    this.expiryTimer = window.setTimeout(() => {
      this.events.finished('room closed — nobody came back');
    }, GRACE_MS);
  }

  private startRescueIfOrphaned(): void {
    const admins = [...this.participants.values()].filter((p) => p.role === 'admin');
    if (admins.length > 0) return;

    // An admin left but listeners remain — give them a moment to take over
    // rather than pulling the music out from under everyone.
    this.rescueTimer = window.setTimeout(() => {
      this.rescueTimer = null;
      this.events.finished('room closed — no admin left');
    }, ADMIN_RESCUE_MS);
  }

  private endRescue(): void {
    if (this.rescueTimer !== null) { window.clearTimeout(this.rescueTimer); this.rescueTimer = null; }
  }

  dispose(): void {
    this.cancelExpiry();
    this.endRescue();
  }
}