export const AUDIO_VERSION_LABELS = {
  original: 'Original',
  bass: 'Bass boosted',
  'bass-reverb': 'Bass + reverb',
} as const;

export type AudioVersion = keyof typeof AUDIO_VERSION_LABELS;
export type ProcessedAudioVersion = Exclude<AudioVersion, 'original'>;
export interface AudioVersionFile { path: string; duration?: number }
export type AudioVersions = Partial<Record<ProcessedAudioVersion, AudioVersionFile>>;
export interface AudioVersionsIndex { v: 1; tracks: Record<string, AudioVersions> }
export const AUDIO_VERSION_PREFERENCE_KEY = 'auraAudioVersion_v1';

export function isAudioVersion(value: unknown): value is AudioVersion {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AUDIO_VERSION_LABELS, value);
}

/** This directory is an attachment store, never a second catalogue. */
export function isAudioVersionPath(path: string): boolean {
  return /^versions\//i.test(path);
}

export function normalizeAudioVersions(value: unknown): AudioVersions {
  const result: AudioVersions = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const mode of ['bass', 'bass-reverb'] as const) {
    const file = (value as Record<string, any>)[mode];
    const path = file?.path;
    const folderPath = typeof path === 'string' && new RegExp(`^versions/(?:[A-Za-z0-9_-]{11}|track-[a-f0-9]{20})/${mode}\\.mp3$`).test(path);
    if (typeof path !== 'string' || path.length > 1024 || (!path.startsWith(`versions/${mode}/`) && !folderPath) ||
      !/\.mp3$/i.test(path) || /[\\\x00-\x1f\x7f]/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..')) continue;
    result[mode] = {path};
    if (typeof file.duration === 'number' && Number.isFinite(file.duration) && file.duration > 0) {
      result[mode].duration = file.duration;
    }
  }
  return result;
}

export function parseAudioVersionsIndex(value: unknown): AudioVersionsIndex {
  const result: AudioVersionsIndex = {v: 1, tracks: {}};
  const data = value as any;
  if (data?.v !== 1 || !data.tracks || typeof data.tracks !== 'object' || Array.isArray(data.tracks)) return result;
  for (const [ref, files] of Object.entries(data.tracks)) {
    if (!/^video:[A-Za-z0-9_-]{11}$/.test(ref) && !/^id:hf:.+/.test(ref)) continue;
    result.tracks[ref] = normalizeAudioVersions(files);
  }
  return result;
}

export function resolveAudioVersion(song: any, preferred: AudioVersion): AudioVersion {
  if (!song?.isHf || song.isLocal || song.isYouTube || preferred === 'original') return 'original';
  return normalizeAudioVersions(song.audioVersions)[preferred] ? preferred : 'original';
}

export function readAudioVersionPreference(): AudioVersion {
  try {
    const value = localStorage.getItem(AUDIO_VERSION_PREFERENCE_KEY);
    return isAudioVersion(value) ? value : 'original';
  } catch { return 'original'; }
}
