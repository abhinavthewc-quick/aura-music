import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDIO, AUDIO_TWO, VIDEO_A, VIDEO_B, VIDEO_C, createPlaybackHarness, flush } from './harness.js';

const currentId = (h: ReturnType<typeof createPlaybackHarness>) => h.state.songs[h.state.currentIndex]?.id;
const artist = {source:'artist',collectionId:'artist:fixture',label:'Artist fixture'};
const playlist = {source:'playlist',collectionId:'fixture',label:'Playlist fixture'};

test('explicit Library albums remain scoped while the original public sequence API keeps its fallback', async () => {
  const h = createPlaybackHarness();
  h.queue.playTrackSequence([AUDIO.id,AUDIO_TWO.id], {source:'library',collectionId:'album:fixture',label:'Album'});
  await h.queue.playNext(); assert.equal(currentId(h),AUDIO_TWO.id);
  await h.queue.playNext(); assert.equal(h.state.isPlaying,false);
  assert.equal(currentId(h),AUDIO_TWO.id);
  assert.equal(h.queue.getRollingUpNextItems().length,0);
  h.queue.playTrackSequence([AUDIO.id,AUDIO_TWO.id]);
  await h.queue.playNext(); assert.equal(currentId(h),AUDIO_TWO.id);
  await h.queue.playNext(); assert.equal(currentId(h),AUDIO.id);
});

for (const options of [artist, playlist]) {
  test(`${options.source} Up Next selection retains skipped interruptions without reversing its collection anchor`, async () => {
    const h = createPlaybackHarness();
    h.queue.manualQueue.push(VIDEO_A.id,VIDEO_B.id);
    h.queue.playTrackSequence([AUDIO.id,AUDIO_TWO.id,VIDEO_C.id],options);
    h.queue.renderUpNext();
    const row = h.$('upNextList')!.querySelectorAll('.up-next-row').find(row => row.dataset.upNextId === (options.source === 'artist' ? AUDIO_TWO.id : 'id:'+AUDIO_TWO.id))!;
    row.querySelector('.up-next-play')!.click();
    assert.equal(currentId(h),AUDIO_TWO.id);
    assert.deepEqual(Array.from(h.queue.manualQueue),[VIDEO_A.id,VIDEO_B.id]);
    assert.deepEqual(Array.from(h.queue.getRollingUpNextItems(),(song:any) => song.id),[VIDEO_A.id,VIDEO_B.id,VIDEO_C.id]);
    await h.queue.playNext(); await flush(); assert.equal(currentId(h),VIDEO_A.id);
    await h.queue.playNext(); await flush(); assert.equal(currentId(h),VIDEO_B.id);
    await h.queue.playNext(); await flush(); assert.equal(currentId(h),VIDEO_C.id);
    assert.equal(h.queue.manualQueue.length,0);
    await h.queue.playPrevious(); await flush(); assert.equal(currentId(h),VIDEO_B.id);
  });

  test(`${options.source} queue insertion and direct handoff preserve interruptions held only in forward history`, async () => {
    const h = createPlaybackHarness();
    h.queue.playTrackSequence([AUDIO.id,AUDIO_TWO.id],options);
    h.queue.manualQueue.push(VIDEO_A.id);
    await h.queue.playNext(); await flush();
    await h.queue.playPrevious();
    assert.equal(currentId(h),AUDIO.id);
    assert.equal(h.queue.manualQueue.length,0);
    h.queue.queueSong(VIDEO_B.id,true);
    assert.deepEqual(Array.from(h.queue.manualQueue),[VIDEO_B.id,VIDEO_A.id]);
    await h.queue.playNext(); await flush(); assert.equal(currentId(h),VIDEO_B.id);
    h.player.playSong(h.state.songs.findIndex(song => song.id === AUDIO_TWO.id));
    assert.deepEqual(Array.from(h.queue.manualQueue),[VIDEO_A.id]);
    await h.queue.playNext(); await flush(); assert.equal(currentId(h),VIDEO_A.id);
  });

  test(`${options.source} shuffle retains replay interruptions and stale iframe ends cannot win a handoff`, async () => {
    const h = createPlaybackHarness();
    h.queue.playTrackSequence([AUDIO.id,AUDIO_TWO.id],options);
    h.queue.manualQueue.push(VIDEO_A.id);
    await h.queue.playNext(); await flush();
    const old = h.instances.at(-1)!; old.ready(); old.transition(h.PlayerState.PLAYING);
    old.transition(h.PlayerState.ENDED);
    const staleEnd = h.clock.timer(250)!;
    await h.queue.playPrevious();
    h.queue.syncPlaybackShuffle(true);
    assert.deepEqual(Array.from(h.queue.manualQueue),[VIDEO_A.id]);
    staleEnd(); await flush(); assert.equal(currentId(h),AUDIO.id);
    await h.queue.playNext(); await flush(); assert.equal(currentId(h),VIDEO_A.id);
  });
}
