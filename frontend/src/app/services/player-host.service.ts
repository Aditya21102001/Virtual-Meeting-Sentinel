import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { VideoPlayerComponent } from '../components/video-player.component';
import type { VideoCard } from './video.service';

/** Where the player should be drawn, in document coordinates. */
export interface PlayerBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Owns the one video player in the application, so playback can outlive the page that started it.
 *
 * <h2>Why the player cannot live on the recordings page</h2>
 * The first attempt at "keep picture-in-picture playing while you navigate" moved the `<video>`
 * element into a container on `document.body` as its page was destroyed. It could never have worked.
 * The Picture-in-Picture specification is explicit: <em>when a video element is removed from its node
 * document, the user agent must run the exit-Picture-in-Picture algorithm</em> — and `appendChild`
 * into a different parent removes the node before inserting it. The session died in the move, so the
 * floating window froze on its last frame.
 *
 * <p>There is no ordering trick that avoids that. The element simply must never be moved and never be
 * destroyed, which means it cannot be owned by anything the router can tear down.
 *
 * <h2>How this works instead</h2>
 * `AppComponent` renders the player once, outside the router outlet, inside a positioned layer. The
 * recordings page renders nothing but an empty slot and tells this service where that slot is; the
 * layer is placed over it in document coordinates. Navigation then changes only CSS — the element
 * stays connected to the document throughout, so picture-in-picture is never interrupted, and neither
 * is ordinary playback.
 *
 * <p>Positioned <b>absolutely, in document coordinates</b> rather than fixed in viewport ones, so
 * scrolling moves it naturally and no scroll listener is needed. Only a resize or a layout change has
 * to re-measure.
 *
 * <h2>What happens when you navigate away</h2>
 * <ul>
 *   <li><b>Not in picture-in-picture</b> — the card is cleared and the player is destroyed, exactly
 *       as before. Walking away from a video stops it, which is what anyone expects.</li>
 *   <li><b>In picture-in-picture</b> — the layer is parked off-screen with CSS and playback
 *       continues. Nothing is moved or unmounted.</li>
 * </ul>
 */
@Injectable({ providedIn: 'root' })
export class PlayerHostService {

  private readonly router = inject(Router);

  /** The recording being played, or null when there is none. Drives whether the player exists. */
  readonly card = signal<VideoCard | null>(null);

  /** Where to start, honoured once when the card changes. */
  readonly startAt = signal<number | null>(null);

  /** Where to draw the player, or null to park it off-screen. */
  readonly box = signal<PlayerBox | null>(null);

  /**
   * The live player instance.
   *
   * <p>Exposed because the recordings page needs it for the transcript (`cues()`), for seeking from
   * a segment or a comment (`seekTo()`), and for the playhead on the comment composer. It used to
   * reach it with `viewChild`; now that the player is mounted elsewhere, this is the way through.
   */
  readonly player = signal<VideoPlayerComponent | null>(null);

  /**
   * What plays after the current recording, in order.
   *
   * <p>Held here rather than in the recordings page because the player outlives that page — the
   * whole reason this service exists is that playback continues while the viewer navigates away, and
   * a queue owned by a destroyed component would end with it. The page fills this in; the service
   * only advances through it.
   */
  readonly queue = signal<VideoCard[]>([]);

  /**
   * Whether reaching the end starts the next recording.
   *
   * <p>Off by default, and that is a deliberate difference from YouTube. These are board meetings:
   * rolling automatically from one AGM into an unrelated one is far more likely to be an annoyance
   * than a convenience, so autoplay is something a viewer turns on.
   */
  readonly autoplayNext = signal(false);

  /** The recording that would play next, or null when the queue is exhausted. */
  readonly upNext = computed(() => this.queue()[0] ?? null);

  /**
   * Theater mode: a wider player, without leaving the page.
   *
   * <p>Lives here rather than in the player because the player does not control its own size — it is
   * drawn over a slot the recordings page reserves, and this service positions it from that slot's
   * measured box. Theater therefore has to be a property of the slot; the page widens it, the
   * existing ResizeObserver notices, and the layer follows with no repositioning code at all.
   *
   * <p>Kept across recordings on purpose, unlike loop. Theater is a statement about how this person
   * wants to watch, not about one recording, and having it reset on every video would be the
   * annoyance rather than the safeguard.
   */
  readonly theater = signal(false);

  /**
   * Move to the next recording in the queue.
   *
   * <p>Shifting the queue rather than tracking an index: an index would drift the moment the
   * library refreshed underneath it, and "what is left to play" is the only state anything here
   * actually reads.
   *
   * @return whether there was anything to advance to
   */
  playNext(): boolean {
    const [next, ...rest] = this.queue();
    if (!next) return false;
    this.queue.set(rest);
    // startAt null, not 0: a recording reached from the queue is a fresh viewing, and the stored
    // resume point for it should still apply if the viewer had started it before.
    this.startAt.set(null);
    this.card.set(next);
    this.trace('playNext', { videoId: next.video.id, remaining: rest.length });
    return true;
  }

  private anchor: HTMLElement | null = null;
  /** The pending "floating window closed" listener, so it is never registered twice. */
  private leaveWatch: { video: HTMLVideoElement; handler: () => void } | null = null;
  private resize: ResizeObserver | null = null;
  private readonly onWindowResize = () => this.measure();

  /**
   * Trace the handover, when asked to.
   *
   * <p>Off unless {@code localStorage.agm_pip_debug === '1'}, so it is silent in normal use. It
   * exists because this feature failed three times in a row on assumptions about what the browser
   * was doing — whether it reported a session at all, whether the player was parked or destroyed,
   * what state the element was in when the window closed. None of that was observable, so each fix
   * was a guess. These lines make the next failure diagnosable in one attempt instead of three.
   */
  private trace(event: string, detail: Record<string, unknown> = {}): void {
    try {
      if (localStorage.getItem('agm_pip_debug') !== '1') return;
    } catch {
      return;   // storage blocked; stay quiet rather than throw from a log call
    }
    const pip = document.pictureInPictureElement;
    // eslint-disable-next-line no-console
    console.info('[pip] ' + event, {
      ...detail,
      pipElement: pip ? pip.tagName : 'NONE',
      pipConnected: pip instanceof HTMLElement ? pip.isConnected : null,
      card: this.card()?.video.id ?? null,
      parked: this.box() === null,
      apiPresent: 'pictureInPictureEnabled' in document,
    });
  }

  /**
   * A snapshot for the browser console, for when something looks wrong.
   *
   * <p>Reachable without the debug flag: paste
   * {@code ng.getInjector(document.querySelector('app-root')).get(...)} is awkward, so this is
   * exposed on window as {@code __pipState()} by AppComponent instead.
   */
  snapshot(): Record<string, unknown> {
    const pip = document.pictureInPictureElement;
    return {
      apiPresent: 'pictureInPictureEnabled' in document,
      pipElement: pip ? pip.tagName : 'NONE',
      cardId: this.card()?.video.id ?? null,
      parked: this.box() === null,
      box: this.box(),
      playerMounted: this.player() !== null,
      videosInDom: document.querySelectorAll('video').length,
      layerInDom: !!document.querySelector('.player-layer'),
      layerParked: !!document.querySelector('.player-layer.parked'),
      watching: this.leaveWatch !== null,
    };
  }

  /** Called by AppComponent when the player it renders comes and goes. */
  registerPlayer(player: VideoPlayerComponent | null): void {
    this.player.set(player);
    this.trace('registerPlayer', { present: player !== null });
  }

  /**
   * Show a recording in the slot the page has reserved for it.
   *
   * <p>Re-measures whenever the slot changes size — a responsive layout, the sidebar opening, the
   * window being resized — because the layer is positioned over it rather than inside it.
   */
  attach(card: VideoCard, startAt: number | null, anchor: HTMLElement): void {
    this.releaseAnchor();
    // Back on the page, so the "they closed the floating window" watch no longer applies.
    this.stopWatching();

    this.anchor = anchor;
    this.card.set(card);
    this.startAt.set(startAt);

    // ResizeObserver catches layout changes the window's resize event does not: the slot growing
    // when a description wraps, a font finishing loading, the transcript panel opening.
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(anchor);
    window.addEventListener('resize', this.onWindowResize);

    this.measure();
    this.trace('attach', { videoId: card.video.id, startAt });
  }

  /**
   * The page showing the player is going away.
   *
   * <p>The decision that matters: keep playing only when the viewer explicitly asked for it by
   * putting the video in a floating window. Otherwise navigation stops it, as it always has —
   * anything else would leave audio playing from a page nobody can see.
   */
  detach(): void {
    this.releaseAnchor();

    const keepPlaying = this.inPictureInPicture();
    // The single most important line in this file. If this says false while a floating window is
    // open, the player is about to be unmounted and the window will die — and that is the failure
    // that has been reported three times.
    this.trace('detach', { keepPlaying });

    if (keepPlaying) {
      // Park it. CSS only: nothing is moved in the DOM, so the session is untouched.
      this.box.set(null);
      this.watchForReturn();
      return;
    }

    this.card.set(null);
    this.startAt.set(null);
    this.box.set(null);
  }

  /** Whether our player is the one in the floating window. */
  private inPictureInPicture(): boolean {
    const element = document.pictureInPictureElement;
    return element instanceof HTMLVideoElement && element.isConnected;
  }

  /**
   * Watch for the floating window closing while the viewer is on another page.
   *
   * <h3>Returning them to the recording</h3>
   * The element is parked off-screen, so leaving picture-in-picture would otherwise drop the viewer
   * back to a page with no video on it. Navigating to the recordings page re-anchors this same
   * element — still playing, mid-frame — which is the behaviour "back to tab" implies.
   *
   * <h3>Telling "back to tab" from "close"</h3>
   * The event fires for both buttons and says nothing about which. The observable difference is
   * playback: returning to the tab leaves the video PLAYING, closing PAUSES it. That is the signal
   * used, and it is written to fail harmlessly — if it is paused, the player is simply stopped and
   * the viewer stays where they are. Dragging somebody who just said "I'm done" onto a video page
   * is worse than making somebody who wanted to return click once.
   */
  private watchForReturn(): void {
    const video = document.pictureInPictureElement;
    if (!(video instanceof HTMLVideoElement)) return;

    // Replace any previous watch rather than stack another one. Two listeners would fire two
    // navigations for a single close.
    this.stopWatching();

    this.trace('watching for the window to close');

    const onLeave = () => {
      this.stopWatching();

      const returningToTab = !video.paused;
      this.trace('window closed', {
        paused: video.paused,
        readyState: video.readyState,
        currentTime: Math.round(video.currentTime),
        decision: returningToTab ? 'navigate back to the recording' : 'stop, viewer is finished',
      });
      const at = Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : 0;
      const id = this.card()?.video.id;

      if (returningToTab && id) {
        // The recordings page reads `v` and `t` from its route snapshot, which is read once on
        // creation — correct here, because the viewer is by definition elsewhere when this fires.
        void this.router.navigate(['/recordings'], { queryParams: { v: id, t: Math.max(0, at) } });
        return;
      }

      // Finished with it. Clearing the card unmounts the player, which is safe now that the
      // session has already ended.
      this.card.set(null);
      this.startAt.set(null);
      this.box.set(null);
    };

    video.addEventListener('leavepictureinpicture', onLeave);
    this.leaveWatch = { video, handler: onLeave };
  }

  private stopWatching(): void {
    if (!this.leaveWatch) return;
    this.leaveWatch.video.removeEventListener('leavepictureinpicture', this.leaveWatch.handler);
    this.leaveWatch = null;
  }

  /** Measure the slot and place the layer over it, in document coordinates. */
  private measure(): void {
    if (!this.anchor?.isConnected) {
      this.box.set(null);
      return;
    }
    const rect = this.anchor.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      // A zero-sized slot means the layer is drawn on top of nothing, which looks exactly like
      // "the player has vanished". Worth saying out loud rather than silently placing it.
      this.trace('slot measured as ZERO size — the player will be invisible', {
        top: rect.top, left: rect.left,
      });
    }
    this.box.set({
      // Document coordinates, so scrolling needs no listener — the layer scrolls with the page.
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
      width: rect.width,
      height: rect.height,
    });
  }

  private releaseAnchor(): void {
    this.resize?.disconnect();
    this.resize = null;
    window.removeEventListener('resize', this.onWindowResize);
    this.anchor = null;
  }
}
