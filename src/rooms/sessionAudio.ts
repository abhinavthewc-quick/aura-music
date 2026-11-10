import { WebAudioTarget, type WebAudioTargetOptions } from './audioEngine';

/**
 * A room can close while decode/unlock is awaited by the sync engine. Fence
 * that retired target so its continuation cannot start sound after leaving,
 * and discard a decoded buffer that arrives after disposal.
 */
export class SessionAudioTarget extends WebAudioTarget {
  private retired = false;
  private unlocking = 0;
  private requestedKey: string | null = null;
  private reportError: (message: string) => void;

  constructor(options: WebAudioTargetOptions) {
    let target: SessionAudioTarget;
    super({
      ...options,
      onTrackChanged: (track) => {
        if (target && !target.retired && target.requestedKey === track.key) options.onTrackChanged?.(track);
      },
    });
    target = this;
    this.reportError = options.onError ?? (() => {});
  }

  override async load(key: string): Promise<void> {
    if (this.retired) return;
    this.requestedKey = key;
    if (this.getTrackKey() !== key) super.pause();
    try {
      await super.load(key);
      if (!this.retired && this.requestedKey !== key) throw new DOMException('The room changed tracks', 'AbortError');
    }
    catch (error) {
      if (!this.retired) {
        if (this.requestedKey === key) {
          this.reportError(error instanceof Error ? error.message : 'The track could not be loaded.');
        }
        throw error;
      }
    } finally {
      if (this.retired) super.dispose();
    }
  }

  override async unlock(): Promise<boolean> {
    if (this.retired) return false;
    this.unlocking++;
    try { return await super.unlock() && !this.retired; }
    finally { this.unlocking--; }
  }
  // Some browsers leave resume() pending until the next trusted gesture.
  // Surface that state immediately instead of silently waiting for its promise.
  override isBlocked(): boolean { return !this.retired && (this.unlocking > 0 || super.isBlocked()); }
  override seek(ms: number): void { if (!this.retired) super.seek(ms); }
  override schedulePlay(at: number, from: number, now: number): boolean {
    return !this.retired && super.schedulePlay(at, from, now);
  }
  override setRate(rate: number): void { if (!this.retired) super.setRate(rate); }
  override setVolume(volume: number): void { if (!this.retired) super.setVolume(volume); }
  override dispose(): void {
    if (this.retired) return;
    this.retired = true;
    super.dispose();
  }
}
