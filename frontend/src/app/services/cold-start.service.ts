import { Injectable, computed, signal } from "@angular/core";

/**
 * Tracks whether the backend appears to be waking from sleep, so the whole application can say so
 * once instead of every screen inventing its own message.
 *
 * <h2>Why this is worth a global notice</h2>
 * The API sleeps when idle on a free tier and takes up to a couple of minutes to come back. During
 * that window every request fails, and the failures look exactly like a broken application: a login
 * that does nothing, an empty library, a chat that will not send. People retry, then report an
 * outage, then stop trusting the thing — for behaviour that resolves itself if they wait.
 *
 * <p>Individual screens already handled this where somebody thought to (the admin knowledge panel,
 * the help widget). Those are the screens whose authors happened to hit it. This covers the rest,
 * including the first screen a visitor sees, which is precisely where a cold start is most likely
 * and least explicable.
 *
 * <h2>What counts as "asleep" rather than "broken"</h2>
 * A gateway status (502/503/504) or a network-level failure (status 0). Those are what a sleeping
 * or restarting container behind a proxy produces. A 400 or a 500 is the application answering, so
 * it is a real fault and is deliberately NOT reported here — telling somebody to wait for a bug to
 * fix itself is worse than saying nothing.
 */
@Injectable({ providedIn: "root" })
export class ColdStartService {

  /**
   * Consecutive cold-start-shaped failures.
   *
   * <p>A counter, not a boolean, because one failed request is not evidence of anything: a single
   * dropped connection happens on a train. Two in a row, with nothing succeeding between them, is a
   * server that is not answering.
   */
  private readonly strikes = signal(0);

  /** When the first strike landed, so the notice can show how long the wait has been. */
  private readonly since = signal<number | null>(null);

  /** Ticks while waking, purely so the elapsed time on screen advances. */
  private readonly now = signal(Date.now());
  private timer: ReturnType<typeof setInterval> | null = null;

  private static readonly STRIKES_BEFORE_TELLING = 2;

  /** Whether to show the notice. */
  readonly waking = computed(() => this.strikes() >= ColdStartService.STRIKES_BEFORE_TELLING);

  /** Whole seconds since the first failure, for the "waiting Ns" line. */
  readonly elapsedSeconds = computed(() => {
    const from = this.since();
    return from === null ? 0 : Math.max(0, Math.round((this.now() - from) / 1000));
  });

  /** A request failed in a way consistent with the server being asleep. */
  recordFailure(): void {
    if (this.since() === null) this.since.set(Date.now());
    this.strikes.update((n) => n + 1);
    if (!this.timer) {
      this.timer = setInterval(() => this.now.set(Date.now()), 1000);
    }
  }

  /**
   * Any request succeeded — so the server is up, whatever else may be wrong.
   *
   * <p>Cleared on the first success rather than decremented: the question this answers is binary
   * and the evidence is conclusive. A response of any kind means something is listening.
   */
  recordSuccess(): void {
    if (this.strikes() === 0 && this.since() === null) return;
    this.strikes.set(0);
    this.since.set(null);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
