/* Run on a freshly loaded /tests/artists/browser.html?page=rooms fixture.
   Every request and socket stays local. The parent coordinates this browser
   pass with the other page regressions and responsive screenshots. */
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
  const check = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
  const $ = (id) => document.getElementById(id);
  const mutations = () => fixture.room.sent.filter((message) => ['control', 'queue', 'role'].includes(message.t));
  const room = fixture.room;
  const savedFetch = window.fetch;
  const savedAudio = window.AudioContext;
  const savedWebkitAudio = window.webkitAudioContext;
  const contexts = [];
  const NativeAudio = savedWebkitAudio || savedAudio;
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  class TrackedAudio extends NativeAudio {
    constructor(options) { super(options); contexts.push(this); }
  }
  const isRoomRequest = (value) => new URL(typeof value === 'string' ? value : value.url, location.href).pathname === '/api/rooms';

  await until(() => $('createBtn')?.onclick, 'room controller');
  window.AudioContext = TrackedAudio;
  if (savedWebkitAudio) window.webkitAudioContext = TrackedAudio;
  try {
    check(!$('joinView').hidden && $('roomView').hidden, 'rooms start on the join view');
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    check(fixture.requests.length === 0 && contexts.length === 0, 'idle join and focus changes start no catalogue, room request, or audio context');
    check(document.getAnimations().filter((animation) => animation.playState === 'running').length === 0, 'idle gate has no startup or looping animation');
    check(getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)', 'rooms retain a true-black canvas');

    $('joinForm').requestSubmit();
    check(!$('joinError').hidden && $('codeInput').getAttribute('aria-invalid') === 'true' && document.activeElement === $('codeInput'), 'missing room code has an inline, focused error');
    $('codeInput').value = 'fixture';
    $('nameInput').value = '';
    $('joinForm').requestSubmit();
    check($('nameInput').getAttribute('aria-invalid') === 'true' && document.activeElement === $('nameInput'), 'name validation works from native form submission');
    check(fixture.requests.length === 0, 'invalid forms do not request a room or catalogue');
    $('nameInput').value = 'Record listener';

    window.fetch = (value, init) => isRoomRequest(value)
      ? Promise.resolve(Response.json({ error: 'fixture unavailable' }, { status: 503 }))
      : savedFetch(value, init);
    $('createBtn').click();
    await until(() => !$('createBtn').disabled && !$('joinError').hidden, 'visible create failure');
    check(!$('joinView').hidden && $('joinError').textContent.includes('unavailable'), 'create failures are visible on the join form instead of the hidden room');
    await until(() => contexts.every((context) => context.state === 'closed'), 'failed-entry audio disposal');
    check(contexts.every((context) => context.state === 'closed'), 'a failed entry closes its audio context');

    window.fetch = (value, init) => isRoomRequest(value)
      ? Promise.resolve(Response.json({ exists: false, wsBase: 'wss://fixture.invalid' }))
      : savedFetch(value, init);
    $('joinBtn').click();
    await until(() => !$('joinBtn').disabled && $('joinError').textContent.includes('doesn’t exist'), 'missing room response');
    check(fixture.requests.length === 0 && room.sent.length === 0, 'a missing room never downloads the library or opens a socket');

    let releaseLookup;
    let lookupCalls = 0;
    window.fetch = (value, init) => {
      if (!isRoomRequest(value)) return savedFetch(value, init);
      lookupCalls++;
      return new Promise((resolve) => { releaseLookup = () => resolve(Response.json({ exists: true, wsBase: 'wss://fixture.invalid' })); });
    };
    $('joinBtn').click();
    $('createBtn').click();
    $('joinForm').requestSubmit();
    await until(() => releaseLookup, 'delayed room lookup');
    check(lookupCalls === 1 && $('joinBtn').disabled && $('createBtn').disabled && !$('joinProgress').hidden, 'joining is single-flight with a clear pending state');
    $('cancelJoinBtn').click();
    releaseLookup();
    await flush();
    check(!$('joinView').hidden && $('roomView').hidden && !$('joinBtn').disabled && room.sent.length === 0, 'cancelled lookups cannot enter a room when their response arrives late');
    window.fetch = savedFetch;

    const { state, rebuildSongs } = await import('/src/core/state.ts');
    state.hfSongs = [];
    state.addedSongs = [];
    rebuildSongs();
    const createsBefore = fixture.requests.filter((request) => request.action === 'create').length;
    $('createBtn').click();
    $('createBtn').click();
    $('joinForm').requestSubmit();
    await until(() => !$('roomView').hidden && room.you, 'local room welcome');
    await flush();
    check(fixture.requests.filter((request) => request.action === 'create').length === createsBefore + 1 && room.sent.filter((message) => message.t === 'hello').length === 1, 'rapid create and join attempts create only one room membership');
    check(state.songs.length === fixture.tracks.length && fixture.requests.some((request) => request.path.includes('/api/buckets/')), 'cold entry loads the catalogue before resolving room tracks');
    check($('rolePill').textContent === 'Admin' && $('nowTitle').textContent.includes('first record'), 'new admin room explains who chooses the first record');
    check(document.querySelector('#queueList button') && document.querySelector('#libResults .add-btn')?.textContent === 'Play first', 'empty room offers a working queue action and browsable first-track choices');
    check($('syncbar').dataset.state === 'idle' && !$('syncLabel').textContent.includes('in sync'), 'an empty room does not claim audio is in sync');
    check(document.documentElement.scrollWidth <= document.documentElement.clientWidth, 'listening workspace fits the current viewport');

    $('inviteBtn').click();
    check(!$('invitePanel').hidden && $('inviteLink').value === `${location.origin}/rooms?r=fixture` && !location.search.includes('k='), 'invite disclosure exposes only a listener link and keeps owner keys out of the address bar');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('fixture clipboard denied'); } } });
    $('copyBtn').click();
    await until(() => $('inviteStatus').textContent.includes('selected link'), 'clipboard fallback');
    check(document.activeElement === $('inviteLink') && $('inviteLink').selectionEnd === $('inviteLink').value.length && !$('inviteLink').value.includes('k='), 'clipboard failure selects a safe link without pointing to an owner URL');
    $('inviteLink').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check($('invitePanel').hidden && document.activeElement === $('inviteBtn'), 'invite disclosure closes with Escape and restores keyboard focus');

    const firstChoice = document.querySelector('#libResults .add-btn');
    room.setQueue([firstChoice.dataset.trackKey]);
    await flush();
    check(!firstChoice.disabled && firstChoice.textContent === 'Play first', 'an idle room can still start its first record when that track is already queued');
    firstChoice.click();
    const firstMessage = mutations().at(-1);
    check(firstMessage?.t === 'control' && firstMessage.action === 'track' && firstMessage.start === true, 'first-track choice preserves the single scheduled-start protocol command');
    check([...document.querySelectorAll('#libResults .add-btn')].every((node) => node.disabled), 'a pending first pick prevents competing first-track requests');
    room.setQueue([firstChoice.dataset.trackKey]);
    await flush();
    check(firstChoice.textContent === 'Starting…' && $('trackFeedback').textContent.includes('Starting'), 'queue membership alone cannot acknowledge a first-track playback request');
    room.setQueue([]);
    room.setPlayback({ trackKey: firstChoice.dataset.trackKey, positionMs: 0, playing: false, startAt: null, updatedAt: Date.now() });
    await flush();
    check($('trackFeedback').textContent.includes('next record') && document.querySelector('#libResults .add-btn').textContent === 'Add', 'track feedback changes only after the authoritative playback update');

    const queueChoice = document.querySelector('#libResults .add-btn');
    const queueKey = queueChoice.dataset.trackKey;
    queueChoice.click();
    check(mutations().at(-1)?.t === 'queue' && mutations().at(-1).action === 'add' && mutations().at(-1).trackKey === queueKey, 'subsequent picks send a queue add rather than restarting shared playback');
    room.setQueue([]);
    await flush();
    check(queueChoice.disabled && queueChoice.textContent === 'Adding…', 'an unrelated queue update leaves an unconfirmed add pending');
    room.setQueue([queueKey]);
    await flush();
    check(queueChoice.disabled && queueChoice.textContent === 'Queued' && queueChoice.getAttribute('aria-label').includes('already in the queue') && $('trackFeedback').textContent.includes('added to the queue'), 'authoritative queue membership confirms an add and exposes an accessible queued state');
    const beforeDuplicate = mutations().length;
    queueChoice.click();
    // A retained handler must also re-check membership, independently of the
    // browser suppressing clicks on the now-disabled button.
    queueChoice.onclick(new MouseEvent('click'));
    room.setQueue([queueKey]);
    await flush();
    check(mutations().length === beforeDuplicate && queueChoice.textContent === 'Queued' && $('trackFeedback').textContent.includes('already in the queue'), 'duplicate and stale add actions do not send a command or start a false confirmation wait');
    $('queueList').focus({ preventScroll: true });
    room.setQueue([]);
    await flush();
    check(!queueChoice.disabled && queueChoice.textContent === 'Add' && document.activeElement === $('queueList'), 'removing a queued track restores its library action without moving focus off the scrollable queue');
    queueChoice.click();
    room.setQueue([queueKey]);
    await flush();
    check(mutations().length === beforeDuplicate + 1 && queueChoice.textContent === 'Queued' && $('trackFeedback').textContent.includes('added to the queue'), 'a removed track can be added again and acknowledged normally');

    room.setPlayback({ trackKey: 'vid:abcdefghijk', videoId: 'abcdefghijk', positionMs: 20000, playing: false, startAt: null, updatedAt: Date.now() });
    room.setQueue(['lk:hand upload|old artist', 'vid:bcdefghijkl']);
    $('libSearch').value = 'rain';
    $('libSearch').dispatchEvent(new Event('input'));
    await until(() => document.querySelector('#libResults .add-btn')?.dataset.trackKey === 'vid:abcdefghijk', 'local library search');
    await until(() => $('seekBar').getAttribute('aria-disabled') === 'false', 'track decode');
    check($('nowTitle').textContent === 'After the rain' && $('queueList').textContent.includes('Hand upload'), 'shared track metadata and the stable no-ID queue key resolve');
    check($('syncbar').dataset.state === 'paused', 'a paused room is identified as paused rather than live audio');
    const staleAdd = document.querySelector('#libResults .add-btn');
    const staleRemove = document.querySelector('#queueList button');
    const stalePromote = document.querySelector('#peopleList .promo');
    check(!staleAdd.disabled && document.querySelectorAll('#queueList button').length === 2 && stalePromote, 'admins can queue tracks and share the controls');
    const beforeStrayPointer = mutations().length;
    $('seekBar').dispatchEvent(new PointerEvent('pointerup', { pointerId: 11, bubbles: true }));
    check(mutations().length === beforeStrayPointer, 'a pointerup without a scrub never seeks to a stale position');
    $('seekBar').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    check(mutations().at(-1)?.action === 'seek' && mutations().at(-1).positionMs === 120000, 'keyboard End seeks to the track boundary');
    staleRemove.click();
    check(mutations().at(-1)?.action === 'remove', 'admin queue removal uses the local room protocol');

    room.setRole('listener');
    await flush();
    check(['playBtn', 'prevBtn', 'nextBtn'].every((id) => $(id).disabled) && $('seekBar').getAttribute('aria-disabled') === 'true' && $('seekBar').tabIndex === -1, 'demotion disables playback and removes the seek control from keyboard navigation');
    check(document.querySelectorAll('#queueList button').length === 0 && document.querySelectorAll('#peopleList .promo').length === 0, 'demotion removes queue and role actions without requiring content changes');
    const listenerAdd = document.querySelector('#libResults .add-btn');
    check(listenerAdd.disabled && getComputedStyle(listenerAdd).backgroundColor === 'rgb(26, 26, 26)', 'listener track actions remain disabled and neutral');
    check(['libResults', 'queueList', 'peopleList'].every((id) => {
      const list = $(id);
      list.focus({ preventScroll: true });
      return list.tabIndex === 0 && document.activeElement === list && $(list.getAttribute('aria-labelledby'))?.textContent.trim();
    }), 'listener lists retain named keyboard scroll targets when their actions are disabled or absent');
    const beforeDemotedActions = mutations().length;
    $('playBtn').click(); listenerAdd.click(); staleAdd.click(); staleRemove.click(); stalePromote.click();
    $('seekBar').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    $('volumeInput').value = '35';
    $('volumeInput').dispatchEvent(new Event('input'));
    check(mutations().length === beforeDemotedActions, 'listeners, stale admin handlers, and local volume cannot send shared music or role changes');

    room.setRole('admin');
    await flush();
    check(!document.querySelector('#libResults .add-btn').disabled && document.querySelectorAll('#queueList button').length === 2, 'promotion restores actions even when the queue is unchanged');
    document.querySelector('#libResults .add-btn').click();
    room.setRole('listener');
    room.setQueue([...room.queue, 'vid:abcdefghijk']);
    await flush();
    check(document.querySelector('#libResults .add-btn').disabled, 'a late queue acknowledgement cannot restore permissions after demotion');
    room.participants[1] = { ...room.participants[1], name: 'A different listener' };
    $('peopleList').focus({ preventScroll: true });
    room.receive({ t: 'participants', participants: room.participants, serverTime: Date.now() });
    check($('peopleList').textContent.includes('A different listener') && document.activeElement === $('peopleList'), 'roster name changes repaint without moving focus off the scrollable people list');

    $('libSearch').value = 'unfindable-fixture-record';
    $('libSearch').dispatchEvent(new Event('input'));
    await until(() => $('libResults').textContent.includes('No songs match'), 'search empty state');
    check(!$('clearSearchBtn').hidden && $('libResults').textContent.includes('different artist'), 'empty search offers a clear recovery path');
    $('clearSearchBtn').click();
    check(document.querySelectorAll('#libResults .add-btn').length > 0 && document.activeElement === $('libSearch'), 'clearing search restores browsing and retains keyboard focus');

    $('chatInput').value = 'One more record';
    $('chatForm').requestSubmit();
    await flush();
    check($('chatLog').textContent.includes('One more record'), 'listeners can send room chat');
    room.receive({ t: 'chat', message: { id: 'literal', name: '<listener>', text: '<img src=x onerror=alert(1)>', at: Date.now() } });
    check($('chatLog').textContent.includes('<img src=x onerror=alert(1)>') && !$('chatLog').querySelector('img'), 'chat treats participant content as text');
    for (let index = 0; index < 18; index++) room.receive({ t: 'chat', message: { id: `history-${index}`, name: 'Evening listener', text: 'A record worth staying up for. What should we play after this one?', at: Date.now() } });
    await flush();
    $('chatLog').scrollTop = 0;
    room.receive({ t: 'chat', message: { id: 'unread', name: 'Evening listener', text: 'This one has a beautiful opening.', at: Date.now() } });
    await flush();
    check($('chatLog').scrollTop < 45 && !$('newMessagesBtn').hidden, 'incoming chat respects someone reading earlier messages');
    $('newMessagesBtn').click();
    check($('newMessagesBtn').hidden && document.activeElement === $('chatLog'), 'new-message action returns to the latest chat with usable focus');
    room.setPlayback({ playing: true, startAt: Date.now() + 30000, positionMs: 0, updatedAt: Date.now() });
    await until(() => !$('countdown').hidden || !$('listenHint').hidden, 'scheduled start or sound permission state');
    check(!$('countdown').hidden || !$('listenHint').hidden, 'a scheduled start shows its countdown or an explicit local sound action');

    room.setRole('admin');
    const oldSocket = room.socket;
    const closedAdd = document.querySelector('#libResults .add-btn');
    const closedRole = document.querySelector('#peopleList .promo');
    room.receive({ t: 'closing', reason: 'fixture complete' });
    await flush();
    check(!$('banner').hidden && $('banner').textContent.includes('fixture complete') && !$('liveDot').classList.contains('connected') && $('syncbar').dataset.state === 'closed', 'disconnect explains the state and stops the shared-clock indicator');
    check(['playBtn', 'prevBtn', 'nextBtn', 'sendBtn', 'inviteBtn'].every((id) => $(id).disabled) && !$('reconnectBtn').hidden, 'closed rooms disable unavailable actions and offer reconnect');
    const beforeClosedActions = mutations().length;
    closedAdd.click(); closedRole.click();
    $('chatInput').value = 'Not sent after closing';
    const beforeClosedChat = room.sent.filter((message) => message.t === 'chat').length;
    $('chatForm').requestSubmit();
    check(mutations().length === beforeClosedActions && room.sent.filter((message) => message.t === 'chat').length === beforeClosedChat, 'closed-room and stale controls never queue commands onto a dead socket');
    await until(() => contexts.every((context) => context.state === 'closed'), 'closed-room audio cleanup');

    $('leaveBtn').click();
    check(!$('joinView').hidden && $('roomView').hidden && !$('chatLog').textContent.includes('One more record'), 'leaving clears room-specific chat and returns to the join form');
    const afterLeave = fixture.requests.length;
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    check(fixture.requests.length === afterLeave, 'leaving removes catalogue focus and visibility subscriptions');
    const helloCount = room.sent.filter((message) => message.t === 'hello').length;
    room.playback = { ...room.playback, trackKey: null, videoId: null, playing: false, startAt: null };
    $('codeInput').value = `${location.origin}/rooms?r=fixture`;
    $('joinBtn').click();
    await until(() => !$('roomView').hidden && room.sent.filter((message) => message.t === 'hello').length === helloCount + 1, 'room rejoin from a pasted invite');
    check($('artImg').hidden && $('chatLog').querySelector('.chat-empty'), 'rejoining resets artwork and conversation from the previous room lifetime');
    const beforeOldRoomActions = mutations().length;
    staleAdd.click(); staleRemove.click(); stalePromote.click(); closedAdd.click();
    oldSocket.receive({ t: 'chat', message: { id: 'late-old-room', name: 'Old room', text: 'This must not reach the new room.', at: Date.now() } });
    check(mutations().length === beforeOldRoomActions && !$('chatLog').textContent.includes('must not reach'), 'old-room actions and late chat cannot affect a newly joined room');
    const beforeFocus = fixture.requests.length;
    window.dispatchEvent(new Event('focus'));
    await until(() => fixture.requests.length > beforeFocus, 'rejoined room catalogue refresh');
    check(fixture.requests.slice(beforeFocus).some((request) => request.path.includes('/api/buckets/')), 'rejoin restores the catalogue refresh subscription');
    $('leaveBtn').click();
    check(localStorage.getItem('auraPlaylists') === fixture.playlist, 'room interactions leave playlist storage unchanged');
    check(document.documentElement.scrollWidth <= document.documentElement.clientWidth, 'join view has no horizontal overflow');
    check(fixture.errors.length === 0 && !fixture.requests.some((request) => ['dispatch', 'bucketUpload', 'setSecret', 'search'].includes(request.action)), 'room regressions have no uncaught errors or external submissions');
    fixture.roomTestResults = checks;
    return { page: fixture.page, passed: checks.length, checks };
  } finally {
    window.fetch = savedFetch;
    window.AudioContext = savedAudio;
    if (savedWebkitAudio) window.webkitAudioContext = savedWebkitAudio;
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor); else delete navigator.clipboard;
    if (!$('roomView').hidden) $('leaveBtn').click();
    if (!$('joinProgress').hidden) $('cancelJoinBtn').click();
    for (const context of contexts) if (context.state !== 'closed') await context.close();
  }
}
