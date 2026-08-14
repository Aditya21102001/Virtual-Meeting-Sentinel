import { Injectable, inject, signal } from '@angular/core';
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

  private anchor: HTMLElement | null = null;
  private resize: ResizeObserver | null = null;
  private readonly onWindowResize = () => this.measure();

  /** Called by AppComponent when the player it renders comes and goes. */
  registerPlayer(player: VideoPlayerComponent | null): void {
    this.player.set(player);
  }

  /**
   * Show a recording in the slot the page has reserved for it.
   *
   * <p>Re-measures whenever the slot changes size — a responsive layout, the sidebar opening, the
   * window being resized — because the layer is positioned over it rather than inside it.
   */
  attach(card: VideoCard, startAt: number | null, anchor: HTMLElement): void {
    this.releaseAnchor();

    this.anchor = anchor;
    this.card.set(card);
    this.startAt.set(startAt);

    // ResizeObserver catches layout changes the window's resize event does not: the slot growing
    // when a description wraps, a font finishing loading, the transcript panel opening.
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(anchor);
    window.addEventListener('resize', this.onWindowResize);

    this.measure();
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

    if (this.inPictureInPicture()) {
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

    const onLeave = () => {
      video.removeEventListener('leavepictureinpicture', onLeave);

      const returningToTab = !video.paused;
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
  }

  /** Measure the slot and place the layer over it, in document coordinates. */
  private measure(): void {
    if (!this.anchor?.isConnected) {
      this.box.set(null);
      return;
    }
    const rect = this.anchor.getBoundingClientRect();
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
