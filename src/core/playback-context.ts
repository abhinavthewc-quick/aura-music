export type PlaybackSource = 'library' | 'playlist' | 'artist' | 'search' | 'manual';
export type RepeatMode = 'off' | 'all' | 'one';
export type PlaybackReason = 'user' | 'ended';

export interface PlaybackVisit {
  id: string;
  cursor: number;
  override: boolean;
  /** Stable collection anchor for a manually queued interruption. */
  anchorId?: string;
}

/** The collection is the source; a YouTube iframe or HTML audio is only a backend.
 * Radio/rooms deliberately own their transport separately and never traverse this context.
 */
export interface PlaybackContext {
  source: PlaybackSource;
  collectionId?: string;
  label?: string;
  order: string[];
  playOrder: string[];
  cursor: number;
  currentId: string;
  queue: string[];
  history: PlaybackVisit[];
  future: PlaybackVisit[];
  overrideActive: boolean;
}

export interface CreatePlaybackContextOptions {
  source?: PlaybackSource;
  collectionId?: string;
  label?: string;
  startId?: string | number;
  shuffle?: boolean;
  random?: () => number;
}

export interface ContextStep {
  id: string | null;
  ended: boolean;
  wrapped: boolean;
}

export const playbackId = (id: string | number): string => String(id);

export function uniquePlaybackIds(ids: Array<string | number>): string[] {
  return [...new Set(ids.filter((id) => id !== null && id !== undefined && String(id).trim()).map(playbackId))];
}

export function shuffledAfterStart(ids: string[], startId: string, random: () => number = Math.random): string[] {
  const rest = ids.filter((id) => id !== startId);
  for (let i = rest.length - 1; i > 0; i--) {
    const sample = Math.min(0.999999, Math.max(0, random()));
    const j = Math.floor(sample * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return ids.includes(startId) ? [startId, ...rest] : rest;
}

export function createPlaybackContext(
  rawIds: Array<string | number>,
  options: CreatePlaybackContextOptions = {},
): PlaybackContext | null {
  const order = uniquePlaybackIds(rawIds);
  if (!order.length) return null;
  const requested = options.startId === undefined ? order[0] : playbackId(options.startId);
  const startId = order.includes(requested) ? requested : order[0];
  const playOrder = options.shuffle ? shuffledAfterStart(order, startId, options.random) : [...order];
  return {
    source: options.source || 'library', collectionId: options.collectionId, label: options.label,
    order, playOrder, cursor: playOrder.indexOf(startId), currentId: startId,
    queue: [], history: [], future: [], overrideActive: false,
  };
}

export function setContextShuffle(
  context: PlaybackContext,
  enabled: boolean,
  _currentId: string | number = context.currentId,
  random: () => number = Math.random,
): PlaybackContext {
  // A queued track is an interruption, not a new collection anchor.
  const anchor = context.overrideActive ? context.playOrder[context.cursor] : context.currentId;
  const nextOrder = enabled ? shuffledAfterStart(context.order, anchor, random) : [...context.order];
  return {
    ...context, playOrder: nextOrder, cursor: nextOrder.indexOf(anchor),
    history: [...context.history], future: [], queue: [...context.queue],
  };
}

/** Peek without mutating; manual Next does not obey repeat-one. */
export function stepContext(context: PlaybackContext, direction: 1 | -1, repeat: RepeatMode): ContextStep {
  if (!context.playOrder.length) return { id: null, ended: true, wrapped: false };
  let cursor = context.cursor + direction;
  let wrapped = false;
  if (cursor >= context.playOrder.length || cursor < 0) {
    if (repeat !== 'all') return { id: null, ended: true, wrapped: false };
    cursor = cursor >= context.playOrder.length ? 0 : context.playOrder.length - 1;
    wrapped = true;
  }
  return { id: context.playOrder[cursor] || null, ended: false, wrapped };
}

export function capturePlaybackVisit(context: PlaybackContext): PlaybackVisit {
  return {id:context.currentId,cursor:context.cursor,override:context.overrideActive,anchorId:context.playOrder[context.cursor]};
}
const visit = capturePlaybackVisit;

export function applyPlaybackVisit(context: PlaybackContext,next: PlaybackVisit): void {
  context.currentId = next.id;
  context.cursor = context.playOrder.indexOf(next.override ? next.anchorId : next.id);
  context.overrideActive = next.override;
}
const applyVisit = applyPlaybackVisit;

function remember(context: PlaybackContext): void {
  if (context.currentId) context.history.push(visit(context));
  if (context.history.length > 250) context.history.shift();
}

export function enqueueContext(context: PlaybackContext, id: string | number, next = false): void {
  const value = playbackId(id);
  context.queue = context.queue.filter((item) => item !== value);
  if (next) context.queue.unshift(value); else context.queue.push(value);
  context.future = [];
}

/** Walks the actual listening history (including queue interruptions). Missing entries
 * are skipped in a bounded pass; no boundary can leak into the global catalogue.
 */
export function advanceContext(
  context: PlaybackContext,
  direction: 1 | -1,
  repeat: RepeatMode,
  available: (id: string) => boolean = () => true,
  reason: PlaybackReason = 'user',
): ContextStep {
  if (direction === 1 && reason === 'ended' && repeat === 'one' && available(context.currentId)) {
    return { id: context.currentId, ended: false, wrapped: false };
  }
  if (direction === -1) {
    while (context.history.length) {
      const previous = context.history.pop()!;
      if (!available(previous.id)) continue;
      context.future.unshift(visit(context));
      applyVisit(context, previous);
      return { id: previous.id, ended: false, wrapped: false };
    }
    // Before a history exists, Previous follows the collection's order.
    let cursor = context.cursor;
    for (let attempt = 0; attempt < context.playOrder.length; attempt++) {
      const peek = stepContext({ ...context, cursor }, -1, repeat);
      if (!peek.id) break;
      cursor = context.playOrder.indexOf(peek.id);
      if (!available(peek.id)) continue;
      context.future.unshift(visit(context));
      applyVisit(context, { id: peek.id, cursor, override: false });
      return peek;
    }
    return { id: null, ended: true, wrapped: false };
  }

  while (context.future.length) {
    const next = context.future.shift()!;
    if (next.override) context.queue = context.queue.filter((id) => id !== next.id);
    if (!available(next.id)) continue;
    remember(context);
    applyVisit(context, next);
    return { id: next.id, ended: false, wrapped: false };
  }
  while (context.queue.length) {
    const id = context.queue.shift()!;
    if (!available(id)) continue;
    remember(context);
    applyVisit(context, { id, cursor: context.cursor, override: true, anchorId:context.playOrder[context.cursor] });
    return { id, ended: false, wrapped: false };
  }
  let cursor = context.cursor;
  let wrapped = false;
  for (let attempt = 0; attempt < context.playOrder.length; attempt++) {
    const peek = stepContext({ ...context, cursor }, 1, repeat);
    if (!peek.id) break;
    cursor = context.playOrder.indexOf(peek.id);
    wrapped ||= peek.wrapped;
    if (!available(peek.id)) continue;
    remember(context);
    applyVisit(context, { id: peek.id, cursor, override: false });
    return { id: peek.id, ended: false, wrapped };
  }
  return { id: null, ended: true, wrapped: false };
}

export function upcomingContextIds(context: PlaybackContext, repeat: RepeatMode, limit: number): string[] {
  if (limit <= 0) return [];
  const result: string[] = [];
  let cursor = context.cursor;
  for (let attempt = 0; attempt < Math.min(limit, context.playOrder.length); attempt++) {
    const next = stepContext({ ...context, cursor }, 1, repeat);
    if (!next.id) break;
    cursor = context.playOrder.indexOf(next.id);
    result.push(next.id);
  }
  return result;
}

/** A temporary Up Next reorder changes effective traversal, not the saved playlist. */
export function reorderContextUpcoming(context: PlaybackContext, ids: string[], repeat: RepeatMode = 'off'): void {
  const anchor = context.playOrder[context.cursor];
  const unique = uniquePlaybackIds(ids).filter((id) => context.playOrder.includes(id) && id !== anchor
    && (repeat === 'all' || context.playOrder.indexOf(id) > context.cursor));
  if (repeat === 'all' && anchor) {
    const rest = upcomingContextIds(context,'all',context.playOrder.length).filter((id) => id !== anchor && !unique.includes(id));
    context.playOrder = [anchor,...unique,...rest];
    context.cursor = 0;
  } else {
    const before = context.playOrder.slice(0, context.cursor + 1);
    const rest = context.playOrder.slice(context.cursor + 1).filter((id) => !unique.includes(id));
    context.playOrder = [...before, ...unique, ...rest];
  }
  context.future = [];
}

export function clonePlaybackContext(context: PlaybackContext): PlaybackContext {
  return {...context,order:[...context.order],playOrder:[...context.playOrder],queue:[...context.queue],
    history:context.history.map((item) => ({...item})),future:context.future.map((item) => ({...item}))};
}
export interface PlaybackPreview {
  visit: PlaybackVisit;
  kind: 'explicit' | 'context' | 'history';
  position: number;
  after: PlaybackContext;
}
/** UI order is a dry run of the exact transport algorithm, not a second queue algorithm. */
export function previewPlayback(context: PlaybackContext,repeat: RepeatMode,limit: number,available: (id:string) => boolean = () => true): PlaybackPreview[] {
  const projected = clonePlaybackContext(context), result: PlaybackPreview[] = [];
  const maximum = Math.min(limit,context.playOrder.length + context.queue.length + context.future.length);
  for (let attempt = 0; attempt < maximum; attempt++) {
    const future = projected.future.find((item) => available(item.id));
    const next = advanceContext(projected,1,repeat,available);
    if (!next.id) break;
    const kind = future?.id === next.id ? 'history' : projected.overrideActive ? 'explicit' : 'context';
    result.push({visit:capturePlaybackVisit(projected),kind,
      position:kind === 'explicit' ? context.queue.indexOf(next.id) : context.playOrder.indexOf(next.id),
      after:clonePlaybackContext(projected)});
  }
  return result;
}
