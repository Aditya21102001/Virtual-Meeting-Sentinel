/**
 * Keep a `<video>` playing in its picture-in-picture window after the page that started it is gone.
 *
 * <h2>The one constraint everything here follows from</h2>
 * From the Picture-in-Picture specification (https://w3c.github.io/picture-in-picture/):
 *
 *   > When a video element is REMOVED FROM ITS NODE DOCUMENT, the user agent must run the
 *   > exit Picture-in-Picture algorithm.
 *
 * `Node.appendChild()` on a node that already has a parent performs a *remove* and then an *insert*.
 * So moving a `<video>` anywhere — to another container in the same document, synchronously, in the
 * same tick — ends the session. There is no ordering, timing or lifecycle trick around it, because
 * the move IS the removal.
 *
 * Therefore: **the element must be neither moved nor destroyed.** It cannot be owned by anything the
 * router can tear down.
 *
 * <h2>What this class does</h2>
 * It does NOT own or move the element. It owns the *decision* and the *geometry*:
 *
 *  - the host application mounts the player ONCE, outside the router outlet, in a positioned layer;
 *  - a page that wants to show it renders an empty slot and calls {@link attach} with that element;
 *  - this class measures the slot and reports where the layer should be drawn;
 *  - on navigation the page calls {@link detach}, and this class decides: park (CSS only, keep
 *    playing) or stop.
 *
 * Navigation therefore changes only CSS. The element stays connected throughout.
 *
 * <h2>Framework-agnostic on purpose</h2>
 * No imports. State changes are pushed through {@link PipHostOptions.onChange}; navigation is
 * delegated to {@link PipHostOptions.onReturn}. Wire those to signals/useState/a store and to your
 * router. See `player-host.service.ts` for the Angular adapter and README.md for React/vanilla.
 *
 * @typeParam T the application's media-item type (whatever your player takes as input)
 */

/** Where the player layer should be drawn, in DOCUMENT coordinates. */
export interface PipBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Everything the host application needs in order to render. */
export interface PipHostState<T> {
  /** The item being played, or null when there is nothing. Drives whether the player exists. */
  item: T | null;
  /** Second to start at, honoured once when `item` changes. */
  startAt: number | null;
  /**
   * Where to draw the layer, or **null meaning "park it off-screen"**.
   *
   * <p>Park with CSS. Never with `display: none`, and never by unmounting — either ends the session
   * this whole class exists to preserve. See the `.parked` rule in README.md.
   */
  box: PipBox | null;
}

export interface PipHostOptions<T> {
  /**
   * Called whenever {@link PipHostState} changes. Push it into your reactive store and render.
   *
   * <p>Called synchronously, and possibly several times in one turn (attach measures immediately).
   * Assigning signals or calling `setState` is fine; doing real work is not.
   */
  onChange: (state: PipHostState<T>) => void;

  /**
   * The viewer returned the video to the tab while on another page — navigate back to `item`.
   *
   * <p>The element is parked off-screen, so leaving picture-in-picture would otherwise drop them on
   * a page with no video on it. Navigating back re-anchors this SAME element, still playing.
   *
   * @param atSeconds the playhead, floored — pass it as a route param so the arriving page is
   *                  consistent even though the player is already at that point
   */
  onReturn: (item: T, atSeconds: number) => void;

  /** Stable id for an item, used only for diagnostics. */
  idOf?: (item: T) => string;

  /**
   * Whether the element in the floating window is OURS.
   *
   * <p>Worth supplying if the page can contain a video this host does not manage — an advert, an
   * embed, a background loop. Without it the check is "some connected `<video>` is in
   * picture-in-picture", which is true for any of them, and this class would then park its layer for
   * a session it does not own.
   *
   * @example ownsElement: (el) => !!el.closest('.player-layer')
   */
  ownsElement?: (element: Element) => boolean;

  /**
   * Trace decisions to the console. A function is re-read on every call, so it can be a live flag.
   *
   * <p>Not decoration. This feature is hard to debug because the facts that decide it are held by
   * the browser and are not visible in the DOM: does it report a session at all, is the layer parked
   * or unmounted, what state was the element in when the window closed. Left unobservable, every fix
   * is a guess — which is how the original took three attempts.
   *
   * @default reads `localStorage.pip_debug === '1'`
   */
  debug?: boolean | (() => boolean);
}

export class PipHost<T> {

  private item: T | null = null;
  private startAt: number | null = null;
  private box: PipBox | null = null;

  /** The slot the layer is drawn over. Not a parent of the player — only a measuring reference. */
  private anchor: HTMLElement | null = null;
  private resize: ResizeObserver | null = null;
  /** The pending "floating window closed" listener, so it is never registered twice. */
  private leaveWatch: { video: HTMLVideoElement; handler: () => void } | null = null;

  private readonly onWindowResize = () => this.measure();

  constructor(private readonly options: PipHostOptions<T>) {}

  get state(): PipHostState<T> {
    return { item: this.item, startAt: this.startAt, box: this.box };
  }

  /**
   * Show `item` over the slot `anchor` reserves.
   *
   * <p>Call this when a page mounts its slot, and again if the selection changes. Safe to call
   * repeatedly: the previous anchor's observers are released first.
   *
   * @param anchor an empty element that only reserves space and reports its position. It must have
   *               the SAME box as the player draws itself into (same aspect-ratio and width), or the
   *               layer will sit slightly off it.
   */
  attach(item: T, startAt: number | null, anchor: HTMLElement): void {
    this.releaseAnchor();
    // Back on the page, so "they closed the floating window while away" no longer applies.
    this.stopWatching();

    this.anchor = anchor;
    this.item = item;
    this.startAt = startAt;

    // ResizeObserver, not just window.resize. It catches the layout changes a resize event does not:
    // a description wrapping, a font finishing loading, a panel opening above the slot. Those move
    // the slot without the window changing size, and the layer is positioned OVER the slot rather
    // than inside it, so nothing corrects it for free.
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(anchor);
    window.addEventListener('resize', this.onWindowResize);

    this.measure();
    this.trace('attach', { item: this.idOf(item), startAt });
  }

  /**
   * The page showing the player is going away. Park or stop.
   *
   * <p>The decision that matters: keep playing ONLY when the viewer explicitly asked for it by
   * putting the video in a floating window. Anything else leaves audio playing from a page nobody
   * can see, which reads as a bug however well-intentioned.
   */
  detach(): void {
    this.releaseAnchor();

    const keepPlaying = this.inPictureInPicture();
    // The single most important line here. If this logs false while a floating window IS open, the
    // player is about to be unmounted and the window will die — that is the failure signature.
    this.trace('detach', { keepPlaying });

    if (keepPlaying) {
      this.box = null;          // park: CSS only, nothing moves in the DOM
      this.emit();
      this.watchForReturn();
      return;
    }

    this.clear();
  }

  /**
   * A snapshot for the console. Reachable without the debug flag — reading state is harmless, and
   * being unable to ask these questions is what made the original undiagnosable.
   *
   * @example (window as any).__pipState = () => host.snapshot();
   */
  snapshot(): Record<string, unknown> {
    const pip = document.pictureInPictureElement;
    return {
      apiPresent: 'pictureInPictureEnabled' in document,
      pipElement: pip ? pip.tagName : 'NONE',
      pipIsOurs: pip ? this.inPictureInPicture() : false,
      itemId: this.item ? this.idOf(this.item) : null,
      parked: this.box === null,
      box: this.box,
      videosInDom: document.querySelectorAll('video').length,
      watching: this.leaveWatch !== null,
    };
  }

  /** Release every listener. Call from your root teardown; a page must call {@link detach}. */
  destroy(): void {
    this.releaseAnchor();
    this.stopWatching();
  }

  // ---- internals ------------------------------------------------------------

  private clear(): void {
    this.item = null;
    this.startAt = null;
    this.box = null;
    this.emit();
  }

  private emit(): void {
    this.options.onChange(this.state);
  }

  /** Measure the slot and place the layer over it, in document coordinates. */
  private measure(): void {
    if (!this.anchor?.isConnected) {
      // The slot has gone without detach() being called. Park rather than draw over nothing.
      this.box = null;
      this.emit();
      return;
    }
    const rect = this.anchor.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      // A zero-sized slot draws the layer over nothing, which looks exactly like "the player has
      // vanished" — a bug that is invisible in the DOM. Worth saying out loud.
      this.trace('slot measured as ZERO size — the player will be invisible', {
        top: rect.top,
        left: rect.left,
      });
    }
    this.box = {
      // DOCUMENT coordinates (add the scroll offset), not viewport ones. The layer then scrolls with
      // the page for free and needs no scroll listener — only resize and layout changes re-measure.
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
      height: rect.height,
    };
    this.emit();
  }

  private releaseAnchor(): void {
    this.resize?.disconnect();
    this.resize = null;
    window.removeEventListener('resize', this.onWindowResize);
    this.anchor = null;
  }

  /** Whether the element in the floating window is one of ours. */
  private inPictureInPicture(): boolean {
    const element = document.pictureInPictureElement;
    if (!(element instanceof HTMLVideoElement) || !element.isConnected) return false;
    return this.options.ownsElement ? this.options.ownsElement(element) : true;
  }

  /**
   * Watch for the floating window closing while the viewer is on another page.
   *
   * <h3>Telling "back to tab" from "close"</h3>
   * `leavepictureinpicture` fires for BOTH of the window's buttons and carries nothing to say which.
   * The observable difference is playback state: returning the video to the tab leaves it PLAYING,
   * closing the window PAUSES it. That is the signal used.
   *
   * <p>It is a heuristic, so it is written to fail the harmless way. Read as "closed", the player
   * stops and the viewer stays where they are. Dragging somebody who just said "I'm done" onto a
   * video page is worse than making somebody who wanted to return click once.
   */
  private watchForReturn(): void {
    const video = document.pictureInPictureElement;
    if (!(video instanceof HTMLVideoElement)) return;

    // Replace any previous watch rather than stack another. Two listeners fire two navigations for
    // one close.
    this.stopWatching();
    this.trace('watching for the window to close');

    const onLeave = () => {
      this.stopWatching();

      const returningToTab = !video.paused;
      const at = Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : 0;
      const item = this.item;

      this.trace('window closed', {
        paused: video.paused,
        readyState: video.readyState,
        currentTime: at,
        decision: returningToTab ? 'navigate back' : 'stop, viewer is finished',
      });

      if (returningToTab && item) {
        this.options.onReturn(item, Math.max(0, at));
        return;
      }

      // Finished with it. Clearing the item unmounts the player, which is safe now the session has
      // already ended — that is the difference between here and detach().
      this.clear();
    };

    video.addEventListener('leavepictureinpicture', onLeave);
    this.leaveWatch = { video, handler: onLeave };
  }

  private stopWatching(): void {
    if (!this.leaveWatch) return;
    this.leaveWatch.video.removeEventListener('leavepictureinpicture', this.leaveWatch.handler);
    this.leaveWatch = null;
  }

  private idOf(item: T): string {
    try {
      return this.options.idOf ? this.options.idOf(item) : String(item);
    } catch {
      return '<unknown>';
    }
  }

  private trace(event: string, detail: Record<string, unknown> = {}): void {
    let on: boolean;
    try {
      const flag = this.options.debug;
      on = typeof flag === 'function'
        ? flag()
        : flag ?? localStorage.getItem('pip_debug') === '1';
    } catch {
      return;   // storage blocked; stay quiet rather than throw from a log call
    }
    if (!on) return;

    const pip = document.pictureInPictureElement;
    // eslint-disable-next-line no-console
    console.info('[pip] ' + event, {
      ...detail,
      pipElement: pip ? pip.tagName : 'NONE',
      pipConnected: pip instanceof HTMLElement ? pip.isConnected : null,
      parked: this.box === null,
      apiPresent: 'pictureInPictureEnabled' in document,
    });
  }
}
