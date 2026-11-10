/* Real RoomDO + referee, with only the platform storage/socket primitives
 * replaced. Run from the repository root:
 * node --import tsx --test rooms-worker/test/lifecycle.test.ts
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { RoomDO } from '../src/room';
import { GRACE_MS, type RefereeState } from '../../src/rooms/referee';
import type { ServerMessage } from '../../src/rooms/protocol';

const START = 1_800_000_000_000;
const OWNER_KEY = 'local-test-owner';

interface StoredRoom { schema: string; state: RefereeState; idleSince: number }

class Storage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  scheduled: number[] = [];

  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); }
  async deleteAll(): Promise<void> { this.values.clear(); }
  // Like Durable Object storage, deleteAll does not delete the alarm.
  async deleteAlarm(): Promise<void> { this.alarm = null; }
  async getAlarm(): Promise<number | null> { return this.alarm; }
  async setAlarm(at: number): Promise<void> { this.alarm = at; this.scheduled.push(at); }
}

class Socket extends EventTarget {
  peer!: Socket;
  inbox: ServerMessage[] = [];
  accept(): void {}
  send(raw: string): void { this.peer.inbox.push(JSON.parse(raw)); }
}

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: START });
  class Pair {
    0 = new Socket();
    1 = new Socket();
    constructor() { this[0].peer = this[1]; this[1].peer = this[0]; }
  }
  const pairDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocketPair');
  Object.defineProperty(globalThis, 'WebSocketPair', { configurable: true, value: Pair });
  t.after(() => {
    if (pairDescriptor) Object.defineProperty(globalThis, 'WebSocketPair', pairDescriptor);
    else Reflect.deleteProperty(globalThis, 'WebSocketPair');
  });

  // Node's Response rejects 101; workerd returns the client socket on it.
  const NativeResponse = globalThis.Response;
  t.mock.method(globalThis, 'Response', function (body: BodyInit | null, init?: ResponseInit & { webSocket?: Socket }) {
    return init?.status === 101 ? { status: 101, webSocket: init.webSocket } : new NativeResponse(body, init);
  } as unknown as typeof Response);

  const storage = new Storage();
  const pending: Promise<unknown>[] = [];
  const ctx = { storage, waitUntil(promise: Promise<unknown>) { pending.push(promise); } } as unknown as ConstructorParameters<typeof RoomDO>[0];
  let room = new RoomDO(ctx, {});
  async function flush(): Promise<void> {
    while (pending.length) await Promise.all(pending.splice(0));
  }
  async function request(query: string): Promise<any> {
    const response = await room.fetch(new Request(`https://rooms.invalid/?room=fixture&${query}`));
    await flush();
    assert.equal(response.status, 200);
    return response.json();
  }

  return {
    storage,
    stored: () => storage.get<StoredRoom>('room'),
    create: (key = OWNER_KEY) => request(`action=create&k=${encodeURIComponent(key)}`),
    exists: () => request('action=exists'),
    at(now: number) { t.mock.timers.setTime(now); },
    async tick(ms: number) { t.mock.timers.tick(ms); await flush(); },
    evict() {
      // Eviction loses all in-memory timers and sockets, but retains storage.
      const now = Date.now();
      t.mock.timers.reset();
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
      room = new RoomDO(ctx, {});
    },
    async alarm() {
      // A delivered alarm is consumed; getAlarm is null inside its handler.
      storage.alarm = null;
      await room.alarm();
      await flush();
    },
    async join(clientId: string, key: string | null = OWNER_KEY) {
      const response = await room.fetch(new Request(
        `https://rooms.invalid/?room=fixture&client=${clientId}&name=${clientId}${key ? `&k=${key}` : ''}`,
        { headers: { Upgrade: 'websocket' } },
      ));
      await flush();
      assert.equal(response.status, 101);
      const socket = (response as unknown as { webSocket: Socket }).webSocket;
      return {
        inbox: socket.inbox,
        async close() { socket.peer.dispatchEvent(new Event('close')); await flush(); },
      };
    },
  };
}

test('never-joined rooms expire from creation despite repeated writes, alarm wakes and eviction', async (t) => {
  const f = fixture(t);
  assert.equal((await f.create()).ok, true);
  assert.equal((await f.exists()).emptySince, START);

  for (const offset of [30_000, 60_000, 90_000, 120_000, 150_000, GRACE_MS - 1]) {
    f.at(START + offset);
    if (offset === 60_000) await f.create();
    // Exercise the onChange write as well as the explicit create persistence.
    if (offset === 90_000) await f.create('another-local-test-key');
    f.evict();
    await f.alarm();
    const existence = await f.exists();
    assert.equal(existence.exists, true, `alive before grace at +${offset}`);
    assert.equal(existence.people, 0);
    assert.equal(existence.emptySince, START, 'writes and wake-ups cannot renew the idle period');
  }

  f.at(START + GRACE_MS);
  f.evict();
  await f.alarm();
  assert.equal((await f.exists()).exists, false);
  assert.equal(f.storage.values.size, 0);
  assert.equal(f.storage.alarm, null);
});

test('joining cancels creation expiry and only the final departure starts a new grace period', async (t) => {
  const f = fixture(t);
  await f.create();
  f.at(START + GRACE_MS - 1);
  const owner = await f.join('owner');
  const guest = await f.join('guest', null);
  assert.equal(owner.inbox.find((message) => message.t === 'welcome')?.you.role, 'admin');
  assert.equal(guest.inbox.find((message) => message.t === 'welcome')?.you.role, 'listener');

  f.at(START + 2 * GRACE_MS);
  await f.alarm();
  assert.equal((await f.exists()).people, 2, 'occupied rooms survive the original creation deadline');
  await guest.close();
  assert.equal((await f.stored())?.state.expiresAt, null);
  assert.equal((await f.exists()).emptySince, null);

  const leftAt = Date.now() + 5000;
  f.at(leftAt);
  await owner.close();
  assert.equal((await f.stored())?.state.expiresAt, leftAt + GRACE_MS);
  assert.equal((await f.exists()).emptySince, leftAt);

  f.evict();
  f.at(leftAt + GRACE_MS - 1);
  await f.alarm();
  assert.equal((await f.exists()).exists, true);
  f.at(leftAt + GRACE_MS);
  await f.alarm();
  assert.equal((await f.exists()).exists, false);
  assert.equal(f.storage.alarm, null);
});

test('rejoining cancels the old timer and a later departure gets a full grace period', async (t) => {
  const f = fixture(t);
  await f.create();
  const first = await f.join('first');
  await f.tick(1000);
  await first.close();
  const oldDeadline = (await f.stored())!.state.expiresAt!;
  await f.tick(GRACE_MS - 1);
  const returning = await f.join('returning');
  assert.equal((await f.stored())?.state.expiresAt, null);
  await f.tick(2);
  assert.equal(Date.now(), oldDeadline + 1);
  await f.alarm();
  assert.equal((await f.exists()).people, 1, 'the cancelled timer and alarm cannot close the rejoined room');

  await returning.close();
  assert.equal((await f.stored())?.state.expiresAt, Date.now() + GRACE_MS);
  await f.tick(GRACE_MS - 1);
  assert.equal((await f.exists()).exists, true);
  await f.tick(1);
  assert.equal((await f.exists()).exists, false, 'the live referee timer still enforces the new deadline');
  assert.equal(f.storage.alarm, null, 'timer-driven cleanup also removes the backstop alarm');

  await f.create('new-local-owner');
  const recreated = (await f.stored())!;
  assert.equal(recreated.idleSince, Date.now());
  assert.deepEqual(recreated.state.adminKeys, [['new-local-owner', 'pending']], 'expired in-memory authority is discarded with storage');
});

test('a hydrated departure deadline takes precedence over a legacy rewritten idle timestamp', async (t) => {
  const f = fixture(t);
  await f.create();
  const owner = await f.join('owner');
  await owner.close();
  const stored = (await f.stored())!;
  const deadline = stored.state.expiresAt!;
  await f.storage.put('room', { ...stored, idleSince: START + GRACE_MS / 2 });
  f.evict();
  f.at(deadline);
  await f.alarm();
  assert.equal((await f.exists()).exists, false);
  assert.equal(f.storage.alarm, null);
});

test('a leftover alarm with no stored room cannot restart an idle lifetime', async (t) => {
  const f = fixture(t);
  await f.alarm();
  assert.equal((await f.exists()).exists, false);
  assert.equal(f.storage.values.size, 0);
  assert.equal(f.storage.alarm, null);
  assert.deepEqual(f.storage.scheduled, []);
});
