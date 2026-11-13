/* Artist transport is an opt-in, transient collection. The existing library,
   playlist and search queues retain their production behavior and saved keys. */
export interface PlaybackVisit {
  id: string;
  override: boolean;
  anchorId?: string;
}
export interface ArtistPlayback {
  collectionId: string;
  label: string;
  order: string[];
  playOrder: string[];
  currentId: string;
  cursor: number;
  shuffle: boolean;
  overrideActive: boolean;
  queue: string[];
  history: PlaybackVisit[];
  future: PlaybackVisit[];
}
export interface ArtistPlaybackOptions {
  collectionId: string;
  label: string;
  startId?: string | number;
  shuffle?: boolean;
  random?: () => number;
}
const unique = (ids: Array<string | number>) => [...new Set(ids.filter(id => id != null && String(id).trim()).map(String))];
function shuffledAfterStart(ids: string[], start: string, random = Math.random): string[] {
  const rest = ids.filter(id => id !== start);
  for(let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.min(.999999, Math.max(0, random())) * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [start, ...rest];
}
export function createArtistPlayback(ids: Array<string | number>, options: ArtistPlaybackOptions): ArtistPlayback | null {
  const order = unique(ids);
  if(!order.length) return null;
  const random = options.random || Math.random;
  const requested = options.startId == null
    ? order[options.shuffle ? Math.floor(Math.min(.999999, Math.max(0, random())) * order.length) : 0]
    : String(options.startId);
  const start = order.includes(requested) ? requested : order[0];
  const playOrder = options.shuffle ? shuffledAfterStart(order, start, random) : [...order];
  return { collectionId: options.collectionId, label: options.label, order, playOrder,
    currentId: start, cursor: playOrder.indexOf(start), shuffle: !!options.shuffle,
    overrideActive: false, queue: [], history: [], future: [] };
}
export function captureArtistVisit(context: ArtistPlayback): PlaybackVisit {
  return { id: context.currentId, override: context.overrideActive, anchorId: context.playOrder[context.cursor] };
}
function applyVisit(context: ArtistPlayback, visit: PlaybackVisit): void {
  context.currentId = visit.id;
  context.overrideActive = visit.override;
  context.cursor = context.playOrder.indexOf(visit.override ? visit.anchorId : visit.id);
}
function remember(context: ArtistPlayback): void {
  context.history.push(captureArtistVisit(context));
  if(context.history.length > 250) context.history.shift();
}
export function setArtistShuffle(context: ArtistPlayback, enabled: boolean, random = Math.random): void {
  const anchor = context.overrideActive ? context.playOrder[context.cursor] : context.currentId;
  context.playOrder = enabled ? shuffledAfterStart(context.order, anchor, random) : [...context.order];
  context.cursor = context.playOrder.indexOf(anchor);
  context.shuffle = enabled;
  context.future = [];
}
function step(context: ArtistPlayback, cursor: number, direction: 1 | -1, repeat: string): string | null {
  let next = cursor + direction;
  if(next < 0 || next >= context.playOrder.length) {
    if(repeat !== 'all') return null;
    next = next < 0 ? context.playOrder.length - 1 : 0;
  }
  return context.playOrder[next] || null;
}
/** Actual listening history includes explicitly queued interruptions. Every
    missing-file pass is bounded; collection boundaries never enter the library. */
export function advanceArtistPlayback(
  context: ArtistPlayback, direction: 1 | -1, repeat: string,
  available: (id: string) => boolean = () => true,
): string | null {
  if(direction === -1) {
    while(context.history.length) {
      const previous = context.history.pop()!;
      if(!available(previous.id)) continue;
      context.future.unshift(captureArtistVisit(context));
      applyVisit(context, previous);
      return previous.id;
    }
    let cursor = context.cursor;
    for(let attempt = 0; attempt < context.playOrder.length; attempt++) {
      const id = step(context, cursor, -1, repeat);
      if(!id) break;
      cursor = context.playOrder.indexOf(id);
      if(!available(id)) continue;
      context.future.unshift(captureArtistVisit(context));
      applyVisit(context, { id, override: false });
      return id;
    }
    return null;
  }
  while(context.future.length) {
    const next = context.future.shift()!;
    if(next.override) context.queue = context.queue.filter(id => id !== next.id);
    if(!available(next.id)) continue;
    remember(context); applyVisit(context, next);
    return next.id;
  }
  while(context.queue.length) {
    const id = context.queue.shift()!;
    if(!available(id)) continue;
    remember(context);
    applyVisit(context, { id, override: true, anchorId: context.playOrder[context.cursor] });
    return id;
  }
  let cursor = context.cursor;
  for(let attempt = 0; attempt < context.playOrder.length; attempt++) {
    const id = step(context, cursor, 1, repeat);
    if(!id) break;
    cursor = context.playOrder.indexOf(id);
    if(!available(id)) continue;
    remember(context); applyVisit(context, { id, override: false });
    return id;
  }
  return null;
}
export function previewArtistPlayback(context: ArtistPlayback, repeat: string, limit: number, available: (id: string) => boolean): string[] {
  const copy: ArtistPlayback = { ...context, order: [...context.order], playOrder: [...context.playOrder],
    queue: [...context.queue], history: context.history.map(visit => ({ ...visit })), future: context.future.map(visit => ({ ...visit })) };
  const result: string[] = [];
  const maximum = Math.min(limit, copy.playOrder.length + copy.queue.length + copy.future.length);
  for(let i = 0; i < maximum; i++) {
    const id = advanceArtistPlayback(copy, 1, repeat, available);
    if(!id) break;
    result.push(id);
  }
  return result;
}
/** Reorder the visible dry-run schedule, including manual interruptions, without
    changing the collection's saved order or replaying its consumed tracks. */
export function reorderArtistUpcoming(context: ArtistPlayback, ids: string[], repeat: string): void {
  const visible = unique(ids);
  const explicit = new Set([...context.queue, ...context.future.filter(visit => visit.override).map(visit => visit.id)]);
  let anchor = context.playOrder[context.cursor];
  const collection = visible.filter(id => !explicit.has(id) && context.playOrder.includes(id) && id !== anchor);
  if(repeat === 'all' && anchor) {
    const rest = [...context.playOrder.slice(context.cursor + 1), ...context.playOrder.slice(0, context.cursor)]
      .filter(id => !collection.includes(id));
    context.playOrder = [anchor, ...collection, ...rest];
    context.cursor = 0;
  } else {
    context.playOrder = [...context.playOrder.slice(0, context.cursor + 1), ...collection,
      ...context.playOrder.slice(context.cursor + 1).filter(id => !collection.includes(id))];
  }
  const pending = context.future.filter(visit => !visible.includes(visit.id));
  context.future = visible.map<PlaybackVisit>(id => {
    const override = explicit.has(id);
    if(!override) anchor = id;
    return { id, override, anchorId: anchor };
  }).concat(pending);
  // Keep unconsumed explicit entries in the production manual queue too. They
  // are removed only when heard, so a later direct selection or shuffle change
  // cannot discard interruptions that were moved into the visible schedule.
  context.queue = [...visible.filter(id => context.queue.includes(id)), ...context.queue.filter(id => !visible.includes(id))];
}
