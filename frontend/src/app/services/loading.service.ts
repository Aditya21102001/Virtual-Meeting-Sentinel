import { HttpContextToken } from '@angular/common/http';
import { Injectable, computed, signal, untracked } from '@angular/core';

/**
 * Mark a request as background work that should not raise the loading bar.
 *
 * <p>Set it on polls and keep-alives. Without it, a screen that polls every second or two holds the
 * bar up permanently, and a progress indicator that is always on tells you nothing — worse, it
 * trains people to ignore the one time it means something.
 *
 * <p>An explicit token rather than a list of URLs to exclude: a URL list is a second place to
 * remember, and the failure when somebody forgets is a bar that never goes out.
 *
 * <pre>
 *   this.http.post(url, body, { context: new HttpContext().set(SILENT, true) })
 * </pre>
 */
export const SILENT = new HttpContextToken<boolean>(() => false);

/**
 * Whether the application is waiting on the network, for the bar at the top of the page.
 *
 * <h2>Why this exists</h2>
 * Individual screens had their own spinners, but nothing covered the gaps between them — a slow
 * navigation, a request fired from a service, the first call after a cold start. During those the
 * application simply looked frozen, which is indistinguishable from broken.
 *
 * <h2>Counted, not boolean</h2>
 * Several requests overlap constantly. A boolean flag would be switched off by the first one to
 * finish while three were still running, so the bar would disappear mid-wait. The counter only
 * reaches zero when the last one lands.
 */
@Injectable({ providedIn: 'root' })
export class LoadingService {
  /** Requests in flight that are not marked SILENT. */
  private readonly inFlight = signal(0);

  /**
   * True once something has been pending long enough to be worth mentioning.
   *
   * <p>Delayed on purpose. Most requests here finish in tens of milliseconds, and a bar that
   * flashes on every one of them is visual noise that makes the page feel unstable rather than
   * responsive. The delay means the bar appears only when there is a genuine wait.
   */
  readonly visible = signal(false);

  readonly pending = computed(() => this.inFlight() > 0);

  /** How long a request must be outstanding before the bar appears. */
  private static readonly SHOW_AFTER_MS = 250;

  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private failsafeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Hard ceiling on how long the blocking overlay may stay up.
   *
   * <p>THE MOST IMPORTANT LINE IN THIS FILE. The overlay stops the user interacting with anything,
   * so if the counter ever sticks above zero — a request that neither completes nor errors, a bug
   * in this class, an interceptor that swallows an event — the application is bricked until the
   * page is reloaded. There is no recovery from inside it.
   *
   * <p>A stuck indicator is a cosmetic bug. A stuck *blocker* is an unusable application, so it is
   * released unconditionally after this long whatever the counter says. Being briefly wrong about
   * whether something is loading is a far cheaper failure than taking the app away.
   */
  private static readonly MAX_BLOCK_MS = 20000;

  start(): void {
    this.inFlight.update((n) => n + 1);
    // untracked, and this is not defensive tidying.
    //
    // start() is reached from the HTTP interceptor, which a component effect can reach
    // synchronously just by subscribing to a request. A tracked read here makes that effect depend
    // on the loading bar — so raising the bar re-runs it, and if the effect is what issued the
    // request, it issues another, which raises the bar again. That is an endless request loop that
    // looks like a bug in the calling page. Nothing in this class may become a dependency of the
    // code it is measuring; writes are safe, reads are not.
    if (this.showTimer === null && !untracked(this.visible)) {
      this.showTimer = setTimeout(() => {
        this.showTimer = null;
        // Re-checked: everything may have finished inside the delay, which is the common case.
        if (this.inFlight() > 0) {
          this.visible.set(true);
          this.armFailsafe();
        }
      }, LoadingService.SHOW_AFTER_MS);
    }
  }

  /** Release the overlay come what may — see MAX_BLOCK_MS. */
  private armFailsafe(): void {
    if (this.failsafeTimer !== null) return;
    this.failsafeTimer = setTimeout(() => {
      this.failsafeTimer = null;
      if (this.visible()) {
        console.warn(
          '[loading] Releasing the blocking overlay after ' +
            `${LoadingService.MAX_BLOCK_MS}ms with ${this.inFlight()} request(s) still counted. ` +
            'Something did not settle — the app stays usable, but this is worth investigating.',
        );
        this.visible.set(false);
        // Reset the counter too, not just the overlay.
        //
        // Hiding the overlay while leaving the count poisoned only postpones the problem: the very
        // next request pushes the count above zero again and the overlay returns immediately, so
        // the failsafe appears to work once and then never again. A stuck count is unrecoverable
        // state, and this is the only place that can clear it.
        this.inFlight.set(0);
      }
    }, LoadingService.MAX_BLOCK_MS);
  }

  stop(): void {
    // Floored at zero. A stray extra stop() — a double-completing observable, a retry that
    // finishes twice — would otherwise push the count negative and leave the bar stuck on for the
    // rest of the session.
    this.inFlight.update((n) => Math.max(0, n - 1));
    // untracked for the same reason as start(): finalize() can run synchronously on unsubscribe,
    // which puts this back inside whatever reactive context tore the request down.
    const idle = untracked(this.inFlight) === 0;
    if (idle) {
      if (this.showTimer !== null) {
        clearTimeout(this.showTimer);
        this.showTimer = null;
      }
      this.visible.set(false);
    }
    if (idle && this.failsafeTimer !== null) {
      clearTimeout(this.failsafeTimer);
      this.failsafeTimer = null;
    }
  }
}
