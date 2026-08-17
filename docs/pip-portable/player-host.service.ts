import { Injectable, InjectionToken, OnDestroy, inject, signal } from '@angular/core';
import { PipBox, PipHost } from './pip-host';

/**
 * Angular adapter over {@link PipHost}: the same decisions, exposed as signals.
 *
 * <h2>Why the player cannot live on the page that shows it</h2>
 * A picture-in-picture session ends the moment its `<video>` element leaves the document, and
 * `appendChild` into a different parent counts as leaving — it removes before it inserts. So the
 * element cannot be owned by anything the router destroys, and it cannot be rescued by moving it
 * somewhere safe on the way out. See `pip-host.ts` for the specification text.
 *
 * <h2>The arrangement</h2>
 * <pre>
 *   AppComponent  (never destroyed by routing)
 *   │
 *   ├── &lt;main&gt;&lt;router-outlet&gt;              ← pages come and go here
 *   │        └── LibraryPage
 *   │             └── &lt;div class="player-slot"&gt;   ← empty; only reserves space
 *   │
 *   └── &lt;div class="player-layer"&gt;         ← OUTSIDE the outlet
 *            └── &lt;app-video-player&gt;        ← the one &lt;video&gt;, never moved
 * </pre>
 *
 * Navigation changes only CSS.
 *
 * <h2>Wiring</h2>
 * <ol>
 *   <li>Provide {@link PLAYER_HOST_CONFIG} with a return-navigation route.</li>
 *   <li>Render the layer in your root component, driven by {@link item} and {@link box}.</li>
 *   <li>Each page renders an empty slot and calls {@link attach} / {@link detach}.</li>
 * </ol>
 *
 * @typeParam T your media-item type. Instantiate the token with a concrete type in your app; the
 *   service itself stays generic so this file needs no edits.
 */

/** What the service needs to know about the host application. */
export interface PlayerHostConfig<T = unknown> {
  /**
   * Take the viewer back to `item` after they return the video to the tab.
   *
   * <p>Typically `router.navigate(['/recordings'], { queryParams: { v: id, t: at } })`. If the
   * arriving page reads those params from `route.snapshot`, that is correct here: the viewer is by
   * definition on another page when this fires, so arriving mounts it fresh.
   */
  navigateToItem: (item: T, atSeconds: number) => void;

  /** Stable id, for diagnostics and for the route param above. */
  idOf?: (item: T) => string;

  /**
   * Whether a picture-in-picture element belongs to this host. Supply it if the application has any
   * other `<video>` on screen, or the layer will park for a session it does not own.
   *
   * @default (el) => !!el.closest('.player-layer')
   */
  ownsElement?: (element: Element) => boolean;
}

export const PLAYER_HOST_CONFIG = new InjectionToken<PlayerHostConfig>('PLAYER_HOST_CONFIG');

export { PipBox };

@Injectable({ providedIn: 'root' })
export class PlayerHostService<T = unknown> implements OnDestroy {

  private readonly config = inject(PLAYER_HOST_CONFIG) as PlayerHostConfig<T>;

  /** The item being played, or null. Drives whether the player exists at all. */
  readonly item = signal<T | null>(null);

  /** Where to start, honoured once when {@link item} changes. */
  readonly startAt = signal<number | null>(null);

  /** Where to draw the layer, or null to park it off-screen. */
  readonly box = signal<PipBox | null>(null);

  /**
   * The live player instance, published by whichever component renders it.
   *
   * <p>Needed because a page that no longer owns the player still has to talk to it — seeking from a
   * transcript line or a comment, reading the playhead. It used to come from `viewChild`; the
   * instance travels through here instead.
   *
   * <p>Declaring the `viewChild` and forgetting to call {@link registerPlayer} silently breaks every
   * one of those features while playback itself looks perfect. Worth a test.
   */
  readonly player = signal<unknown>(null);

  private readonly host = new PipHost<T>({
    onChange: (state) => {
      this.item.set(state.item);
      this.startAt.set(state.startAt);
      this.box.set(state.box);
    },
    onReturn: (item, atSeconds) => this.config.navigateToItem(item, atSeconds),
    idOf: this.config.idOf,
    ownsElement:
      this.config.ownsElement ?? ((element) => !!element.closest('.player-layer')),
  });

  /** Called by the component that renders the player, as it comes and goes. */
  registerPlayer(player: unknown): void {
    this.player.set(player);
  }

  /**
   * Show `item` over the slot this page reserves.
   *
   * <p>Drive it from an effect on (selection, slot) rather than a lifecycle hook — the slot only
   * exists once something is selected, so both have to be present:
   *
   * <pre>
   *   effect(() => {
   *     const item = this.selected();
   *     const slot = this.playerSlot();
   *     if (item &amp;&amp; slot) {
   *       untracked(() =&gt; this.playerHost.attach(item, this.startAt(), slot.nativeElement));
   *     }
   *   });
   * </pre>
   *
   * `untracked` is not optional. attach() reads and writes signals; without it this effect depends on
   * its own output and re-runs forever.
   */
  attach(item: T, startAt: number | null, anchor: HTMLElement): void {
    this.host.attach(item, startAt, anchor);
  }

  /** Call from the page's `ngOnDestroy`. Parks if in picture-in-picture, otherwise stops playback. */
  detach(): void {
    this.host.detach();
  }

  /** Expose as `__pipState()` on window; see README.md. */
  snapshot(): Record<string, unknown> {
    return { ...this.host.snapshot(), playerMounted: this.player() !== null };
  }

  ngOnDestroy(): void {
    this.host.destroy();
  }
}
