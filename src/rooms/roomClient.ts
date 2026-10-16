/* The high-level room client: one object the UI talks to.
 *
 * Owns the transport and the sync engine, keeps a local copy of the room
 * snapshot, and exposes only the verbs a person can actually use. Admin-only
 * verbs are refused here for a responsive UI — but the server re-checks every
 * one of them, because a client is never trusted to police itself.
 */

import { SyncEngine, type SyncTarget } from './syncEngine';
import type {
  ChatMessage,
  Participant,
  PlaybackState,
  RoomSnapshot,
  Role,
} from './protocol';
import type { RoomTransport } from './transport';

export interface RoomConnectionInfo {
  roomId: string;
  /** Present only for the creator. Treat as a password. */
  ownerKey?: string;
  /** True when this tab runs the referee (local development only). */
  isHost?: boolean;
}

export interface RoomView {
  roomId: string;
  you: Participant | null;
  role: Role;
  participants: Participant[];
  playback: PlaybackState;
  queue: string[];
  expiresAt: number | null;
  /** Live sync diagnostics, shown small in the corner. */
  driftMs: number;
  clockOffsetMs: number;
  inSync: boolean;
  buffering: boolean;
  closed: string | null;
}

type Listener = (view: RoomView) => void;

export class RoomClient {
  readonly roomId: string;
  private transport: RoomTransport;
  private engine: SyncEngine;
  private listeners = new Set<Listener>();

  private participants: Participant[] = [];
  private playback: PlaybackState = { trackKey: null, videoId: null, positionMs: 0, playing: false, updatedAt: 0 };
  private queue: string[] = [];
  private expiresAt: number | null = null;
  private you: Participant | null = null;
  private ownerKey?: string;
  private buffering = false;
  private closedReason: string | null = null;

  private clientId: string;
  private clockPingTimer: number | null = null;

  constructor(info: RoomConnectionInfo, transport: RoomTransport, clientId: string, target: SyncTarget) {
    this.roomId = info.roomId;
    this.ownerKey = info.ownerKey;
    this.clientId = clientId;

    this.engine = new SyncEngine({
      onError: () => { /* surfaced via view; the room keeps running */ },
    });
    this.engine.attach(target);

    this.transport = transport;
    transport.onMessage((m) => this.handle(m));
    transport.onClose((reason) => {
      this.closedReason = reason;
      this.stopPings();
      this.emit();
    });
  }

  /* ---------------- joining ---------------- */

  join(name: string): void {
    this.transport.send({
      t: 'hello',
      clientId: this.clientId,
      name,
      ...(this.ownerKey ? { adminKey: this.ownerKey } : {}),
    });
    this.startPings();
  }

  leave(): void {
    this.stopPings();
    this.engine.stop();
    this.transport.close();
  }

  get link(): string {
    const base = `${location.origin}${location.pathname}#/room/${this.roomId}`;
    return this.ownerKey ? `${base}?k=${this.ownerKey}` : base;
  }

  get shareLink(): string {
    return `${location.origin}${location.pathname}#/room/${this.roomId}`;
  }

  get isAdmin(): boolean {
    return this.you?.role === 'admin';
  }

  /* ---------------- inbound ---------------- */

  private handle(m: import('./protocol').ServerMessage): void {
    switch (m.t) {
      case 'welcome':
        this.you = m.you;
        this.participants = m.snapshot.participants;
        this.playback = m.snapshot.playback;
        this.queue = m.snapshot.queue;
        this.expiresAt = m.snapshot.expiresAt;
        this.engine.onPlayback(this.playback);
        this.engine.start(() => this.ping());
        this.emit();
        return;

      case 'playback':
        this.playback = m.playback;
        void this.engine.onPlayback(m.playback);
        this.emit();
        return;

      case 'queue':
        this.queue = m.queue;
        this.emit();
        return;

      case 'participants':
        this.participants = m.participants;
        if (this.you) {
          const refreshed = m.participants.find((p) => p.id === this.you!.id);
          if (refreshed) this.you = refreshed;
        }
        this.emit();
        return;

      case 'chat':
        this.onChat?.(m.message);
        return;

      case 'closing':
        this.closedReason = m.reason;
        this.stopPings();
        this.emit();
        return;

      case 'pong':
        this.engine.onPong(m.sentAt, m.serverTime);
        this.emit();
        return;
    }
  }

  /** Set by the UI so incoming chat can be rendered. */
  onChat: ((message: ChatMessage) => void) | null = null;

  /* ---------------- commands ---------------- */

  play(): void { this.control('play'); }
  pause(): void { this.control('pause'); }
  seek(ms: number): void { this.control('seek', { positionMs: Math.max(0, Math.round(ms)) }); }

  playTrack(trackKey: string, videoId?: string | null): void {
    this.control('track', { trackKey, videoId: videoId ?? null });
  }

  toggle(): void {
    // Nothing loaded yet: start the queue rather than doing nothing, which is
    // what made the room feel dead after queueing a first track.
    if (!this.playback.trackKey) {
      if (this.queue.length) {
        this.queueNext();
        // queueNext only changes the track; follow it with play so one press
        // actually starts the music.
        this.send({ t: 'control', action: 'play' });
        return;
      }
      return;
    }
    if (this.playback.playing) this.pause(); else this.play();
  }

  queueAdd(trackKey: string): void {
    // An idle room should start the first track rather than parking it in a
    // queue nobody will ever drain: the referee ignores `play` until a track
    // is loaded, so queueing alone produced a room that looked alive but was
    // silent.
    if (!this.playback.trackKey) {
      this.send({ t: 'control', action: 'track', trackKey });
      this.send({ t: 'control', action: 'play' });
      return;
    }
    this.send({ t: 'queue', action: 'add', trackKey });
  }
  queueRemove(trackKey: string): void { this.send({ t: 'queue', action: 'remove', trackKey }); }
  queueClear(): void { this.send({ t: 'queue', action: 'clear' }); }
  queueNext(): void { this.send({ t: 'queue', action: 'next' }); }

  promote(participantId: string): void { this.send({ t: 'role', action: 'promote', participantId }); }
  demote(participantId: string): void { this.send({ t: 'role', action: 'demote', participantId }); }

  say(text: string): void { this.send({ t: 'chat', text }); }

  setBuffering(value: boolean): void {
    if (this.buffering === value) return;
    this.buffering = value;
    this.send({ t: 'buffering', buffering: value });
    this.emit();
  }

  private control(action: 'play' | 'pause' | 'seek' | 'track', extra: Record<string, unknown> = {}): void {
    if (!this.isAdmin) return; // server enforces regardless
    this.send({ t: 'control', action, ...extra } as never);
  }

  private send(m: import('./protocol').ClientMessage): void {
    this.transport.send(m);
  }

  /* ---------------- clock ---------------- */

  private ping(): void {
    this.send({ t: 'ping', sentAt: Date.now() });
  }

  private startPings(): void {
    this.stopPings();
    this.ping();
    this.clockPingTimer = window.setInterval(() => this.ping(), 10000);
  }

  private stopPings(): void {
    if (this.clockPingTimer !== null) {
      window.clearInterval(this.clockPingTimer);
      this.clockPingTimer = null;
    }
  }

  /* ---------------- view ---------------- */

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.view());
    return () => this.listeners.delete(listener);
  }

  view(): RoomView {
    return {
      roomId: this.roomId,
      you: this.you,
      role: this.you?.role ?? 'listener',
      participants: this.participants,
      playback: this.playback,
      queue: this.queue,
      expiresAt: this.expiresAt,
      driftMs: Math.round(this.engine.lastDriftMs),
      clockOffsetMs: Math.round(this.engine.clockOffsetMs),
      inSync: this.engine.inSync,
      buffering: this.buffering,
      closed: this.closedReason,
    };
  }

  private emit(): void {
    const v = this.view();
    for (const l of this.listeners) l(v);
  }

  /** Diagnostics for the debug panel. */
  diagnostics() {
    return {
      driftMs: Math.round(this.engine.lastDriftMs),
      corrections: this.engine.corrections,
      clockReady: this.engine.clockReady,
      serverNow: Math.round(this.engine.serverNow),
      clientNow: Date.now(),
    };
  }
}

export type { RoomSnapshot };