import { Injectable } from "@angular/core";

/** Where a viewer got to in one recording, and when. */
export interface ResumePoint {
  seconds: number;
  duration: number;
  /** Epoch millis, used only to decide which entries to evict. */
  savedAt: number;
}

/**
 * Remembers where each recording was left off, in `localStorage`.
 *
 * <p>Per browser rather than per account, deliberately: a resume point is a convenience, not data
 * worth a table, a migration and a write on every `timeupdate`. Moving it server-side later is a
 * matter of swapping the two methods below — nothing else knows where it lives.
 *
 * <p>Every read is defensive. `localStorage` throws in private-browsing modes, can be full, and can
 * contain whatever a previous version of this code wrote; none of that is worth breaking playback
 * over, so a failure here degrades to "start from the beginning".
 */
@Injectable({ providedIn: "root" })
export class PlaybackProgressService {
  private static readonly KEY = "vms.playback-progress.v1";

  /**
   * Ignore anything under this. Resuming someone 4 seconds in is worse than not resuming: it looks
   * like a bug, and the "Start over" they then reach for was where they were going anyway.
   */
  private static readonly MIN_RESUME_SECONDS = 15;

  /** Within this of the end, treat the recording as watched and start it again from zero. */
  private static readonly END_MARGIN_SECONDS = 20;

  /** Cap the store so a large library cannot grow it without bound. Oldest go first. */
  private static readonly MAX_ENTRIES = 50;

  /**
   * Where to resume this recording, or null to start from the beginning.
   *
   * @param duration the video's length, used to discard a point past the end — the stored duration
   *                 can be stale if the recording was re-processed
   */
  resumeAt(videoId: string, duration: number | null | undefined): number | null {
    const point = this.all()[videoId];
    if (!point) return null;

    const seconds = point.seconds;
    if (!Number.isFinite(seconds) || seconds < PlaybackProgressService.MIN_RESUME_SECONDS) {
      return null;
    }
    const total = duration ?? point.duration;
    if (total > 0 && seconds > total - PlaybackProgressService.END_MARGIN_SECONDS) return null;
    return seconds;
  }

  /** Record the playhead. Callers throttle; this does not. */
  save(videoId: string, seconds: number, duration: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const store = this.all();
    store[videoId] = { seconds, duration, savedAt: Date.now() };
    this.write(this.prune(store));
  }

  /** Forget a recording — on finishing it, or when the viewer chooses to start over. */
  clear(videoId: string): void {
    const store = this.all();
    if (!(videoId in store)) return;
    delete store[videoId];
    this.write(store);
  }

  // ---- storage --------------------------------------------------------------

  private all(): Record<string, ResumePoint> {
    try {
      const raw = localStorage.getItem(PlaybackProgressService.KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as unknown;
      // Anything that isn't the shape we wrote is treated as absent rather than trusted.
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, ResumePoint>)
        : {};
    } catch {
      return {};
    }
  }

  private write(store: Record<string, ResumePoint>): void {
    try {
      localStorage.setItem(PlaybackProgressService.KEY, JSON.stringify(store));
    } catch {
      // Full, or storage is denied. Losing a resume point is not worth surfacing.
    }
  }

  private prune(store: Record<string, ResumePoint>): Record<string, ResumePoint> {
    const entries = Object.entries(store);
    if (entries.length <= PlaybackProgressService.MAX_ENTRIES) return store;
    entries.sort((a, b) => (b[1]?.savedAt ?? 0) - (a[1]?.savedAt ?? 0));
    return Object.fromEntries(entries.slice(0, PlaybackProgressService.MAX_ENTRIES));
  }
}
