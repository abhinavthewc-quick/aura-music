/* Estimating the difference between this machine's clock and the room server's.
 *
 * Why this is necessary: comparing a server timestamp against `Date.now()`
 * directly is wrong. The two clocks disagree by however much each machine has
 * drifted since it last synced with the world — commonly 100ms to 2s. Using
 * raw client time would leave every listener permanently out of step by that
 * much, and it would look like "sync is broken" for reasons unrelated to sync.
 *
 * The standard trick is to measure round-trip time and assume it is symmetric:
 *
 *   client                         server
 *     |--- ping,  t0 -------------->|
 *     |                             |  replies at server time t1
 *     |<-- pong (sentAt=t0, t1) ----|
 *     |  arrives at client time t2
 *
 *   rtt    = t2 - t0
 *   offset = t1 - (t0 + rtt / 2)    ... how far ahead the server is
 *
 * Round trips are rarely symmetric, so a single sample is noisy. We keep
 * several and always trust the sample with the *smallest* round trip, which is
 * the one least distorted by queueing and is therefore the most trustworthy.
 */

interface Sample {
  offset: number;
  rtt: number;
  at: number;
}

const SAMPLE_TTL_MS = 30_000;
const MAX_SAMPLES = 8;
/** Past this round trip the number is not worth believing. */
const MAX_USABLE_RTT_MS = 2000;

export class ClockSync {
  private samples: Sample[] = [];
  private offset = 0;
  private primed = false;

  /**
   * Feed a reply to a ping.
   * @param sentAt client timestamp when the ping left
   * @param serverTime server timestamp carried in the reply
   */
  addSample(sentAt: number, serverTime: number): void {
    const receivedAt = Date.now();
    const rtt = receivedAt - sentAt;
    if (rtt < 0 || rtt > MAX_USABLE_RTT_MS) return; // clock jumped, or hopeless

    this.samples.push({ offset: serverTime - (sentAt + rtt / 2), rtt, at: receivedAt });
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();

    const now = Date.now();
    this.samples = this.samples.filter((s) => now - s.at < SAMPLE_TTL_MS);

    // Lowest round trip == least asymmetric == most trustworthy.
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.offset = best.offset;
    this.primed = true;
  }

  /** True once at least one usable reply has been seen. */
  get ready(): boolean {
    return this.primed;
  }

  /** How far ahead of this machine's clock the server runs, in ms. */
  get offsetMs(): number {
    return this.offset;
  }

  /** The server's current time, to the best of our knowledge. */
  serverNow(): number {
    return Date.now() + this.offset;
  }

  /** Round trip of the most trustworthy recent sample, for diagnostics. */
  get bestRtt(): number {
    let best = Infinity;
    for (const s of this.samples) if (s.rtt < best) best = s.rtt;
    return best === Infinity ? NaN : best;
  }

  reset(): void {
    this.samples = [];
    this.offset = 0;
    this.primed = false;
  }
}