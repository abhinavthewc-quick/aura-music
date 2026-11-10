import assert from 'node:assert/strict';
import test from 'node:test';
import { canManageRoom, formatTime, listenerInvite, listeningStatus, parseRoomInvite } from '../../src/rooms/presentation';
import { SessionAudioTarget } from '../../src/rooms/sessionAudio';
import type { RoomView } from '../../src/rooms/roomClient';

function view(overrides: Partial<RoomView> = {}): RoomView {
  return {
    roomId: 'record', you: { id: 'you', name: 'Listener', role: 'admin', joinedAt: 0 }, role: 'admin', participants: [],
    playback: { trackKey: 'vid:record', videoId: null, positionMs: 0, playing: true, updatedAt: 0, startAt: null, rev: 1 },
    queue: [], expiresAt: null, driftMs: 0, clockOffsetMs: 0, inSync: true, nudging: false,
    positionMs: 0, durationMs: 120000, startInMs: null, loading: false, blocked: false,
    outputLatencyMs: null, serverNow: 1000, clockReady: true, buffering: false, closed: null, ...overrides,
  };
}

test('room invites accept shipped formats without treating arbitrary text as a code', () => {
  assert.deepEqual(parseRoomInvite(' K7M2PQ '), { roomId: 'k7m2pq', adminKey: null });
  assert.deepEqual(parseRoomInvite('https://aura.example/rooms?r=K7M2PQ&k=owner%3Akey'), { roomId: 'k7m2pq', adminKey: 'owner:key' });
  assert.deepEqual(parseRoomInvite('/rooms.html#/room/K7M2PQ?k=owner%3Akey'), { roomId: 'k7m2pq', adminKey: 'owner:key' });
  assert.deepEqual(parseRoomInvite('#/room/K7M2PQ'), { roomId: 'k7m2pq', adminKey: null });
  for (const bad of ['', 'room code here', 'javascript:alert(1)', 'https://aura.example/other?r=abc', 'x'.repeat(13), '/rooms?r=abc/def']) {
    assert.equal(parseRoomInvite(bad), null, bad);
  }
});

test('a listener invite never includes the owner credential from an incoming invite', () => {
  const invite = parseRoomInvite('https://aura.example/rooms?r=record&k=private-owner-key');
  const shared = listenerInvite('https://aura.example', invite.roomId);
  assert.equal(shared, 'https://aura.example/rooms?r=record');
  assert.equal(new URL(shared).searchParams.has('k'), false);
});

test('unwelcomed, demoted, inconsistent, and disconnected views cannot manage a room', () => {
  assert.equal(canManageRoom(view()), true);
  assert.equal(canManageRoom(null), false);
  assert.equal(canManageRoom(view({ you: null })), false);
  assert.equal(canManageRoom(view({ role: 'listener' })), false);
  assert.equal(canManageRoom(view({ you: { ...view().you, role: 'listener' } })), false);
  assert.equal(canManageRoom(view({ closed: 'disconnected' })), false);
});

test('sync status never claims an idle, blocked, loading, paused, or correcting device is in sync', () => {
  assert.equal(listeningStatus(view()).state, 'live');
  assert.equal(listeningStatus(view({ you: null })).state, 'connecting');
  assert.equal(listeningStatus(view({ playback: { ...view().playback, trackKey: null } })).state, 'idle');
  assert.equal(listeningStatus(view({ blocked: true, loading: true, startInMs: 3000 })).state, 'blocked');
  assert.equal(listeningStatus(view({ loading: true, startInMs: 3000 })).state, 'loading');
  assert.equal(listeningStatus(view({ startInMs: 3000 })).state, 'starting');
  assert.equal(listeningStatus(view({ clockReady: false })).state, 'syncing');
  assert.equal(listeningStatus(view({ playback: { ...view().playback, playing: false } })).state, 'paused');
  assert.equal(listeningStatus(view({ inSync: false, nudging: false })).state, 'correcting');
  assert.equal(listeningStatus(view({ nudging: true })).state, 'correcting');
  assert.equal(listeningStatus(view(), 'decode failed').state, 'error');
  assert.equal(listeningStatus(view({ closed: 'gone', blocked: true, startInMs: 3000 }), 'decode failed').state, 'closed');
});

test('elapsed track times do not jump ahead or display invalid numbers', () => {
  assert.equal(formatTime(59999), '0:59');
  assert.equal(formatTime(120000), '2:00');
  for (const value of [-1000, Infinity, NaN]) assert.equal(formatTime(value), '0:00');
});

function deferred<T>() {
  let resolve: (value: T) => void;
  let reject: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve: (value: T) => resolve(value), reject: (reason: unknown) => reject(reason) };
}

async function microtasks(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

async function fakeAudio(run: (environment: any) => Promise<void>): Promise<void> {
  const oldWindow = (globalThis as any).window;
  const oldFetch = globalThis.fetch;
  const environment = { contexts: [], decodes: [], resumes: [], sources: [], holdResume: false };
  class Context {
    state = 'suspended';
    currentTime = 0;
    baseLatency = 0;
    destination = {};
    constructor() { environment.contexts.push(this); }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    resume() {
      if (!environment.holdResume) { this.state = 'running'; return Promise.resolve(); }
      const gate = deferred<void>();
      environment.resumes.push(gate);
      return gate.promise.then(() => { if (this.state !== 'closed') this.state = 'running'; });
    }
    close() { this.state = 'closed'; return Promise.resolve(); }
    decodeAudioData() {
      const gate = deferred<{ duration: number }>();
      environment.decodes.push(gate);
      return gate.promise;
    }
    createBufferSource() {
      const source = {
        buffer: null, playbackRate: { value: 1 }, onended: null, started: false, stopped: false,
        connect() {}, disconnect() {},
        start: () => { assert.notEqual(this.state, 'closed', 'retired contexts must never start a source'); source.started = true; },
        stop() { source.stopped = true; },
      };
      environment.sources.push(source);
      return source;
    }
  }
  (globalThis as any).window = { AudioContext: Context };
  globalThis.fetch = (async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })) as any;
  try { await run(environment); }
  finally {
    if (oldWindow === undefined) delete (globalThis as any).window; else (globalThis as any).window = oldWindow;
    globalThis.fetch = oldFetch;
  }
}

const track = (key: string) => ({ key, title: key, artist: 'Room artist', url: '/fixture.wav', durationMs: 120000 });

test('a late decode cannot revive a room that was left or fire its track callback', async () => {
  await fakeAudio(async (environment) => {
    const changed: string[] = [];
    const audio = new SessionAudioTarget({ resolve: track, onTrackChanged: (value) => changed.push(value.key) });
    const loading = audio.load('first');
    await microtasks();
    assert.equal(environment.decodes.length, 1);
    audio.dispose();
    environment.decodes[0].resolve({ duration: 120 });
    await loading;
    assert.equal(environment.contexts[0].state, 'closed');
    assert.equal(await audio.unlock(), false);
    assert.equal(audio.schedulePlay(2000, 0, 1000), false);
    assert.equal(environment.sources.length, 0);
    assert.deepEqual(changed, []);
  });
});

test('a pending audio permission request is visible and cannot resume after retirement', async () => {
  await fakeAudio(async (environment) => {
    environment.holdResume = true;
    const audio = new SessionAudioTarget({ resolve: track });
    const unlocking = audio.unlock();
    assert.equal(audio.isBlocked(), true);
    audio.dispose();
    environment.resumes[0].resolve();
    assert.equal(await unlocking, false);
    assert.equal(audio.isBlocked(), false);
    assert.equal(environment.contexts[0].state, 'closed');
  });
});

test('a superseded decode stops its old sync continuation and only announces the new record', async () => {
  await fakeAudio(async (environment) => {
    const changed: string[] = [];
    const errors: string[] = [];
    const audio = new SessionAudioTarget({ resolve: track, onTrackChanged: (value) => changed.push(value.key), onError: (error) => errors.push(error) });
    const first = audio.load('first').catch((error) => error);
    await microtasks();
    const second = audio.load('second');
    await microtasks();
    environment.decodes[1].resolve({ duration: 120 });
    await second;
    environment.decodes[0].resolve({ duration: 120 });
    assert.equal((await first).name, 'AbortError');
    assert.deepEqual(changed, ['second']);
    assert.deepEqual(errors, []);
    assert.equal(audio.getTrackKey(), 'second');
    audio.dispose();
  });
});

test('an unavailable next record silences the old record and reports a recoverable load error', async () => {
  await fakeAudio(async (environment) => {
    const errors: string[] = [];
    const audio = new SessionAudioTarget({ resolve: (key) => key === 'missing' ? null : track(key), onError: (error) => errors.push(error) });
    const loading = audio.load('first');
    await microtasks();
    environment.decodes[0].resolve({ duration: 120 });
    await loading;
    await audio.play();
    assert.equal(environment.sources[0].started, true);
    await assert.rejects(audio.load('missing'), /shared library/);
    assert.equal(environment.sources[0].stopped, true);
    assert.equal(audio.isPlaying(), false);
    assert.equal(errors.length, 1);
    audio.dispose();
  });
});
