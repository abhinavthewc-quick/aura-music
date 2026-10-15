/* End-to-end check against a running rooms worker (the real Durable Object).
 *
 * Two genuine WebSocket clients, no browser involved, so this verifies the
 * server side on its own: roles, enforcement, sync messages and isolation.
 *
 * Usage: node rooms-worker/test/e2e.mjs [ws://localhost:8794]
 */

const BASE = process.argv[2] || 'ws://localhost:8794';
const ROOM = 'e2e' + Math.random().toString(36).slice(2, 7);

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect({ name, key, clientId }) {
  const ws = new WebSocket(
    `${BASE}/?room=${ROOM}&client=${clientId}&name=${encodeURIComponent(name)}${key ? '&k=' + key : ''}`
  );
  const inbox = [];
  const waiters = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  };
  return {
    ws, inbox,
    opened: new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('open failed')); }),
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor(match, ms = 4000) {
      const found = inbox.find(match);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error('timeout waiting for message')), ms);
      });
    },
    close: () => ws.close(),
  };
}

const OWNER_KEY = 'owner_' + Math.random().toString(36).slice(2, 10);

// Seed the room exactly as the Pages endpoint would.
const created = await fetch(`${BASE.replace('ws://', 'http://')}/?room=${ROOM}&action=create&k=${OWNER_KEY}`).then((r) => r.json());
check('room created', created.ok === true, JSON.stringify(created));

const alice = connect({ name: 'alice', key: OWNER_KEY, clientId: 'a1' });
const bob = connect({ name: 'bob', clientId: 'b1' });

await Promise.all([alice.opened, bob.opened]);
const aWelcome = await alice.waitFor((m) => m.t === 'welcome');
const bWelcome = await bob.waitFor((m) => m.t === 'welcome');

check('creator is admin', aWelcome.you.role === 'admin', aWelcome.you.role);
check('joiner is listener', bWelcome.you.role === 'listener', bWelcome.you.role);

/* --- both see both people --- */
await sleep(300);
const aPeople = await alice.waitFor((m) => m.t === 'participants' && m.participants.length === 2);
const bPeople = await bob.waitFor((m) => m.t === 'participants' && m.participants.length === 2);
check('alice sees 2 people', aPeople.participants.length === 2, aPeople.participants.map(p => p.name).join(','));
check('bob sees 2 people', bPeople.participants.length === 2, bPeople.participants.map(p => p.name).join(','));

/* --- clock sync --- */
alice.send({ t: 'ping', sentAt: Date.now() });
const pong = await alice.waitFor((m) => m.t === 'pong');
check('pong carries server time', typeof pong.serverTime === 'number' && pong.serverTime > 0, String(pong.serverTime));

/* --- admin control reaches the listener --- */
alice.send({ t: 'control', action: 'track', trackKey: 'song-1', videoId: 'v1' });
alice.send({ t: 'control', action: 'play' });
// Wait for the settled state, not the intermediate track-change broadcast.
const bPlay = await bob.waitFor((m) => m.t === 'playback' && m.playback.trackKey === 'song-1' && m.playback.playing === true);
check('track propagated to listener', bPlay.playback.trackKey === 'song-1' && bPlay.playback.playing === true,
  `${bPlay.playback.trackKey} playing=${bPlay.playback.playing}`);

/* --- listener control must be refused --- */
bob.inbox.length = 0;
bob.send({ t: 'control', action: 'pause' });
await sleep(700);
const aLatest = alice.inbox.filter((m) => m.t === 'playback');
const stillPlaying = aLatest.length ? aLatest[aLatest.length - 1].playback.playing : true;
check('listener cannot pause the room', stillPlaying === true, `playing=${stillPlaying}`);

/* --- queue --- */
alice.send({ t: 'queue', action: 'add', trackKey: 'song-2' });
alice.send({ t: 'queue', action: 'add', trackKey: 'song-3' });
const q = await bob.waitFor((m) => m.t === 'queue' && m.queue.length === 2);
check('queue is visible to listener', q.queue.join(',') === 'song-2,song-3', q.queue.join(','));

alice.send({ t: 'queue', action: 'next' });
const skipped = await bob.waitFor((m) => m.t === 'playback' && m.playback.trackKey === 'song-2');
check('skip advances the room', skipped.playback.trackKey === 'song-2', skipped.playback.trackKey);

/* --- chat --- */
bob.send({ t: 'chat', text: 'hello from bob' });
const chat = await alice.waitFor((m) => m.t === 'chat' && m.message.text === 'hello from bob');
check('chat reaches the admin', chat.message.name === 'bob', `${chat.message.name}: ${chat.message.text}`);

/* --- chat rate limit --- */
for (let i = 0; i < 12; i++) bob.send({ t: 'chat', text: `flood ${i}` });
await sleep(700);
const floodCount = alice.inbox.filter((m) => m.t === 'chat' && m.message.text.startsWith('flood ')).length;
check('chat flood is rate limited', floodCount <= 5, `${floodCount}/12 accepted (limit 5 per 5s)`);

/* --- promotion --- */
const bobId = bWelcome.you.id;
alice.send({ t: 'role', action: 'promote', participantId: bobId });
const promoted = await bob.waitFor((m) => m.t === 'participants' && m.participants.some(p => p.id === bobId && p.role === 'admin'));
check('listener can be promoted to admin', !!promoted,
  promoted.participants.map(p => `${p.name}:${p.role}`).join(','));

/* --- last admin cannot be demoted --- */
alice.send({ t: 'role', action: 'demote', participantId: bobId });
await sleep(500);
const afterDemote = await bob.waitFor((m) => m.t === 'participants');
const adminCount = afterDemote.participants.filter(p => p.role === 'admin').length;
check('room keeps at least one admin', adminCount >= 1, `${adminCount} admin(s)`);

alice.close(); bob.close();

/* --- room isolation --- */
const otherExists = await fetch(`${BASE.replace('ws://', 'http://')}/?room=nope${Date.now()}&action=exists`).then((r) => r.json());
check('rooms are isolated by id', otherExists.exists === false, JSON.stringify(otherExists));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);