import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import type Hls from 'hls.js';

/**
 * Keeps a picture-in-picture video playing after the page that started it has gone away, and takes
 * the viewer back to it when they return the video to the tab.
 *
 * <h2>The problem</h2>
 * The `<video>` element lives inside `VideoPlayerComponent`, which lives inside a routed page. Ask
 * for picture-in-picture, then navigate anywhere, and Angular destroys that component: `hls.destroy()`
 * runs and the element is removed from the document. The browser exits picture-in-picture the moment
 * its element leaves the DOM, so the floating window closes — which is the opposite of what
 * picture-in-picture is for. Somebody pops a recording into a corner *so that* they can go and read
 * the board while it plays.
 *
 * <h2>The approach</h2>
 * On destroy the player offers the element here instead of letting it die. This service moves the
 * node into a container parented to `document.body` — outside the router outlet, so nothing Angular
 * does to the page can reach it — and takes ownership of the hls.js instance so the stream is not
 * torn down underneath a video that is still playing.
 *
 * <p>The handover happens in `ngOnDestroy`, which runs *before* Angular detaches the component's DOM.
 * Re-parenting the node there means it is never orphaned, and the browser sees one continuous element
 * rather than a removal.
 *
 * <h2>Why body and not a component</h2>
 * The host must outlive every route, and the node guaranteed to do that is `document.body`. Putting
 * it in `AppComponent`'s template would work today and break the first time somebody wraps the outlet
 * in something conditional.
 *
 * <p>It is hidden by size and opacity rather than `display: none`. The visible window is drawn by the
 * operating system and does not need the source element to be seen — but an element that is not
 * rendered at all is a state browsers have historically disagreed about, and avoiding it costs
 * nothing.
 */
@Injectable({ providedIn: 'root' })
export class PipKeepAliveService {

  private readonly router = inject(Router);

  private host: HTMLElement | null = null;
  private video: HTMLVideoElement | null = null;
  private hls: Hls | null = null;
  private videoId: string | null = null;
  private save: ((seconds: number) => void) | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether a video is being kept alive outside the page that started it. */
  get active(): boolean {
    return this.video !== null;
  }

  /**
   * Take ownership of a video that is in picture-in-picture, so it survives its page.
   *
   * @param video   the element currently in picture-in-picture
   * @param hls     the hls.js instance feeding it, if any — ownership transfers with the element
   * @param videoId which recording this is, so the viewer can be returned to it
   * @param save    records the playback position; must not close over the component being destroyed.
   *                Closing over a root service is fine.
   * @returns true if adopted, in which case the caller must NOT destroy the hls instance
   */
  adopt(video: HTMLVideoElement, hls: Hls | null, videoId: string,
        save: (seconds: number) => void): boolean {
    // Only ever the element actually in picture-in-picture. Adopting a plain video would silently
    // keep an invisible one playing somewhere, which is a bug rather than a feature.
    if (document.pictureInPictureElement !== video) return false;

    // Already holding this exact element: nothing to do. Without this an accidental second call
    // would re-append the node and attach a DUPLICATE leavepictureinpicture listener, so closing
    // the window would fire the return-navigation twice.
    if (this.video === video) return true;

    // One at a time. A second request means an earlier one was left behind — release it rather than
    // accumulate hidden elements, each holding an hls instance and a network connection.
    if (this.video) this.release();

    this.ensureHost().appendChild(video);
    this.video = video;
    this.hls = hls;
    this.videoId = videoId;
    this.save = save;

    // The element is out of the page now, so nothing else is recording where the viewer has reached.
    // Persisted periodically instead, and again on release, so closing the window from the operating
    // system's own control still leaves the position remembered.
    this.saveTimer = setInterval(() => this.persist(), 5000);

    video.addEventListener('leavepictureinpicture', this.onLeave);
    return true;
  }

  /**
   * Stop keeping the video alive and let go of everything it holds.
   *
   * <p>Safe to call when nothing is being kept.
   */
  release(): void {
    const video = this.video;
    if (!video) return;

    this.persist();
    if (this.saveTimer) clearInterval(this.saveTimer);
    this.saveTimer = null;

    video.removeEventListener('leavepictureinpicture', this.onLeave);

    // Order matters: stop the element before tearing down the stream feeding it, or hls.js detaches
    // from a still-playing video and the console fills with errors nobody caused.
    try {
      video.pause();
    } catch {
      // Already gone; nothing to stop.
    }
    this.hls?.destroy();
    this.hls = null;

    // Exit before removing: taking the element out of the document while the window is still open
    // makes the browser tear it down on its own terms, mid-frame.
    if (document.pictureInPictureElement === video) {
      void document.exitPictureInPicture().catch(() => undefined);
    }
    video.remove();

    this.video = null;
    this.videoId = null;
    this.save = null;
  }

  /**
   * The floating window closed. Decide whether the viewer was coming back or finishing up.
   *
   * <h3>Telling the two apart</h3>
   * `leavepictureinpicture` fires for both of the window's buttons, and carries nothing to say
   * which. The observable difference is what happens to playback: returning the video to the tab
   * leaves it PLAYING, while closing the window PAUSES it. That is the signal used here.
   *
   * <p>It is a heuristic, so it is written to fail the harmless way. If the video is paused — closed,
   * or a browser that behaves differently — nothing happens beyond cleaning up, and the viewer stays
   * where they are. Navigating somebody who just said "I'm done" back to a video page would be far
   * more irritating than not navigating somebody who wanted to return, since they can click through
   * themselves.
   */
  private readonly onLeave = (): void => {
    const video = this.video;
    const returningToTab = video ? !video.paused : false;
    const resumeAt = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const videoId = this.videoId;

    this.release();

    if (returningToTab && videoId) {
      // The recordings page reads `v` and `t` from its route SNAPSHOT, which is read once when the
      // component is created — correct here, because the viewer is by definition on another page
      // when this fires, so arriving mounts it fresh.
      void this.router.navigate(['/recordings'], {
        queryParams: { v: videoId, t: Math.max(0, Math.floor(resumeAt)) },
      });
    }
  };

  private persist(): void {
    if (!this.video || !this.save) return;
    const at = this.video.currentTime;
    if (Number.isFinite(at) && at > 0) this.save(at);
  }

  private ensureHost(): HTMLElement {
    if (this.host?.isConnected) return this.host;
    const host = document.createElement('div');
    host.dataset['pipHost'] = '';
    host.setAttribute('aria-hidden', 'true');
    // Rendered, but out of the way and unreachable: the visible window belongs to the OS.
    host.style.cssText =
      'position:fixed;left:0;bottom:0;width:1px;height:1px;overflow:hidden;' +
      'opacity:0;pointer-events:none;z-index:-1';
    document.body.appendChild(host);
    this.host = host;
    return host;
  }
}
