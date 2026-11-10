/* Run only on a freshly loaded ?page=rooms local fixture. All room messages
   stay in the fake socket; no real room or music submission is created. */
const flush = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(predicate, label) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(requestAnimationFrame);
  }
  throw new Error('Timed out: ' + label);
}

export async function runRoomRegressions() {
  const fixture = window.__auraFixture;
  if (location.hostname !== '127.0.0.1' || fixture?.page !== 'rooms') throw new Error('Use the dedicated local rooms fixture.');
  const checks = [];
  const check = (value, label) => {
    if (!value) throw new Error(label);
    checks.push(label);
  };
  const $ = (id) => document.getElementById(id);
  const mutations = () => fixture.room.sent.filter((message) => ['control', 'queue', 'role'].includes(message.t));
  await until(() => $('createBtn')?.onclick, 'room controller');
  check(!$('joinView').hidden && $('roomView').hidden, 'room fixture starts on the join view');
  $('nameInput').value = 'Record listener';
  $('createBtn').click();
  await until(() => !$('roomView').hidden && fixture.room.you, 'local room welcome');
  const room = fixture.room;
  await flush();
  check($('rolePill').textContent === 'admin' && $('nowTitle').textContent === 'Nothing playing', 'new admin room shows its empty state');
  check($('queueList').textContent.includes('Nothing queued'), 'empty queue gives the admin a starting point');

  room.setPlayback({ trackKey: 'vid:abcdefghijk', videoId: 'abcdefghijk', positionMs: 20000, playing: false, startAt: null, updatedAt: Date.now() });
  room.setQueue(['lk:hand upload|old artist', 'vid:bcdefghijkl']);
  $('libSearch').value = 'rain';
  $('libSearch').dispatchEvent(new Event('input'));
  await until(() => document.querySelector('#libResults .add-btn'), 'local library results');
  await flush();
  check($('nowTitle').textContent === 'After the rain' && $('queueList').textContent.includes('Hand upload'), 'room resolves shared tracks and the stable no-ID queue key');
  const staleAdd = document.querySelector('#libResults .add-btn');
  const staleRemove = document.querySelector('#queueList button');
  check(!staleAdd.disabled && document.querySelectorAll('#queueList button').length === 2, 'admins can add and remove queued library tracks');
  staleRemove.click();
  check(mutations().at(-1)?.action === 'remove', 'admin queue action uses the local socket');

  room.setRole('listener');
  await flush();
  check(['playBtn', 'prevBtn', 'nextBtn'].every((id) => $(id).disabled), 'demotion disables playback controls');
  check(document.querySelectorAll('#queueList button').length === 0, 'demotion removes queue actions even when the queue is unchanged');
  const listenerAdd = document.querySelector('#libResults .add-btn');
  check(listenerAdd.disabled && getComputedStyle(listenerAdd).backgroundColor === 'rgb(26, 26, 26)', 'listener library action stays disabled and neutral');
  const before = mutations().length;
  $('playBtn').click();
  listenerAdd.click();
  staleAdd.click();
  staleRemove.click();
  check(mutations().length === before, 'listener and stale admin controls cannot send queue or playback changes');

  room.setRole('admin');
  await flush();
  check(!document.querySelector('#libResults .add-btn').disabled && document.querySelectorAll('#queueList button').length === 2, 'promotion restores queue actions without changing the queue');
  const cooldownAdd = document.querySelector('#libResults .add-btn');
  cooldownAdd.click();
  room.setRole('listener');
  await until(() => cooldownAdd.textContent === 'Add', 'add-button cooldown');
  check(cooldownAdd.disabled, 'add-button cooldown cannot restore permissions after demotion');

  $('chatInput').value = 'One more record';
  $('chatForm').requestSubmit();
  await flush();
  check($('chatLog').textContent.includes('One more record'), 'listeners can chat through the local socket');
  room.setPlayback({ playing: true, startAt: Date.now() + 30000, positionMs: 0, updatedAt: Date.now() });
  await flush();
  check(!$('countdown').hidden && Number($('countdownNum').textContent) > 0, 'agreed playback start shows a countdown');
  room.receive({ t: 'closing', reason: 'fixture complete' });
  await flush();
  check(!$('banner').hidden && $('banner').textContent.includes('fixture complete') && !$('liveDot').classList.contains('pulse'), 'closed room explains its state and stops the live pulse');
  $('leaveBtn').click();
  check(!$('joinView').hidden && $('roomView').hidden, 'leaving returns to the join view');
  check(localStorage.getItem('auraPlaylists') === fixture.playlist, 'room checks leave playlist storage unchanged');
  check(getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)', 'rooms ignore old light-theme preferences');
  check(document.documentElement.scrollWidth <= document.documentElement.clientWidth, 'room has no horizontal overflow');
  check(fixture.errors.length === 0 && !fixture.requests.some((request) => ['dispatch', 'bucketUpload', 'setSecret', 'search'].includes(request.action)), 'room checks have no uncaught errors or external submissions');
  fixture.roomTestResults = checks;
  return { page: fixture.page, passed: checks.length, checks };
}
