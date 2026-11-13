import { expect, test } from '@playwright/test';
import { advanceContext, capturePlaybackVisit, createPlaybackContext, enqueueContext, previewPlayback, reorderContextUpcoming, setContextShuffle, stepContext, upcomingContextIds } from '../../src/core/playback-context';

test('collection end never leaks; repeat-all wraps only inside its source', () => {
  const context = createPlaybackContext(['gamma','alpha'],{source:'playlist',collectionId:'night'})!;
  expect(advanceContext(context,1,'off').id).toBe('alpha');
  expect(advanceContext(context,1,'off').ended).toBe(true);
  expect(advanceContext(context,1,'all')).toEqual({id:'gamma',ended:false,wrapped:true});
});
test('shuffle is a stable permutation anchored at the selected item', () => {
  const context = createPlaybackContext(['a','b','c','d'],{startId:'c'})!;
  const shuffled = setContextShuffle(context,true,'c',() => 0);
  expect(shuffled.playOrder[0]).toBe('c');
  expect(new Set(shuffled.playOrder)).toEqual(new Set(['a','b','c','d']));
  expect(upcomingContextIds(shuffled,'off',10)).toEqual(shuffled.playOrder.slice(1));
});
test('input IDs are normalized/deduplicated without invented null entries', () => {
  expect(createPlaybackContext([1,'1',2,2,3])!.order).toEqual(['1','2','3']);
  expect(createPlaybackContext([])).toBeNull();
});
test('manual queue overrides take priority then resume the collection', () => {
  const context = createPlaybackContext(['a','b','c'])!;
  enqueueContext(context,'x'); enqueueContext(context,'y',true);
  expect(advanceContext(context,1,'off').id).toBe('y');
  expect(advanceContext(context,1,'off').id).toBe('x');
  expect(advanceContext(context,1,'off').id).toBe('b');
});
test('Previous walks actual history including manual overrides; Next retraces it', () => {
  const context = createPlaybackContext(['a','b','c'])!;
  enqueueContext(context,'x');
  advanceContext(context,1,'off'); advanceContext(context,1,'off');
  expect(advanceContext(context,-1,'off').id).toBe('x');
  expect(advanceContext(context,-1,'off').id).toBe('a');
  expect(advanceContext(context,1,'off').id).toBe('x');
  expect(advanceContext(context,1,'off').id).toBe('b');
});
test('repeat-one is natural-end behavior, not a trap for manual Next', () => {
  const context = createPlaybackContext(['a','b'])!;
  expect(advanceContext(context,1,'one',() => true,'ended').id).toBe('a');
  expect(advanceContext(context,1,'one',() => true,'user').id).toBe('b');
});
test('missing queued and collection items are skipped in a bounded pass', () => {
  const context = createPlaybackContext(['a','lost','b'])!;
  enqueueContext(context,'missing');
  expect(advanceContext(context,1,'off',(id) => id==='b').id).toBe('b');
  expect(advanceContext(context,1,'all',() => false).ended).toBe(true);
});
test('shuffle during a manual override never turns the override into a collection anchor', () => {
  const context = createPlaybackContext(['a','b','c'])!;
  enqueueContext(context,'x'); advanceContext(context,1,'off');
  const shuffled = setContextShuffle(context,true,'x',() => 0);
  expect(shuffled.currentId).toBe('x'); expect(shuffled.overrideActive).toBe(true);
  expect(shuffled.playOrder).not.toContain('x');
  expect(advanceContext(shuffled,1,'off').id).not.toBe('a');
});
test('Up Next reordering changes temporary traversal, not saved canonical order', () => {
  const context = createPlaybackContext(['a','b','c','d'])!;
  reorderContextUpcoming(context,['c','b']);
  expect(context.order).toEqual(['a','b','c','d']); expect(stepContext(context,1,'off').id).toBe('c');
});

test('history rebases by identity after shuffle, including interruption anchors', () => {
  const context = createPlaybackContext(['a','b','c','d'])!;
  advanceContext(context,1,'off'); advanceContext(context,1,'off');
  context.playOrder = ['c','a','b','d']; context.cursor = 0;
  expect(advanceContext(context,-1,'off').id).toBe('b');
  expect(context.cursor).toBe(2);
  enqueueContext(context,'x');
  expect(advanceContext(context,1,'off').id).toBe('x');
  expect(capturePlaybackVisit(context).anchorId).toBe('b');
  expect(advanceContext(context,1,'off').id).toBe('d');
});
test('Up Next projection includes future, queued items and remaining collection in actual order', () => {
  const context = createPlaybackContext(['a','b','c'])!;
  enqueueContext(context,'x'); enqueueContext(context,'y');
  advanceContext(context,1,'off'); advanceContext(context,-1,'off');
  const before = JSON.stringify(context);
  const projected = previewPlayback(context,'off',10);
  expect(projected.map((entry) => entry.visit.id)).toEqual(['x','y','b','c']);
  expect(projected[0].kind).toBe('history');
  expect(projected[0].visit.anchorId).toBe('a');
  expect(JSON.stringify(context)).toBe(before);
});

test('queuing, shuffle and reorder keep pending interruptions from forward history', () => {
  for (const action of ['queue','shuffle','reorder']) {
    let context = createPlaybackContext(['a','b','c'])!;
    context.future = [{id:'x',cursor:0,anchorId:'a',override:true}, {id:'b',cursor:1,override:false}];
    context.queue = ['y'];
    if (action === 'queue') enqueueContext(context,'z',true);
    if (action === 'shuffle') context = setContextShuffle(context,true,'a',() => 0);
    if (action === 'reorder') reorderContextUpcoming(context,['c','b']);
    expect(context.queue).toEqual(action === 'queue' ? ['z','x','y'] : ['x','y']);
    expect(context.future).toEqual([]);
    expect(advanceContext(context,1,'off').id).toBe(action === 'queue' ? 'z' : 'x');
  }
});
