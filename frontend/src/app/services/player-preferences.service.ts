import { Injectable } from "@angular/core";

/** What the player remembers between visits. Everything here is a preference, never content. */
export interface PlayerPreferences {
  /** 0–1. Applied to every recording. */
  volume: number;
  muted: boolean;
  /** Playback rate, one of the player's SPEEDS. */
  speed: number;
  /** Whether the caption overlay is on, for recordings that have a transcript. */
  captions: boolean;
}

const DEFAULTS: PlayerPreferences = { volume: 1, muted: false, speed: 1, captions: false };

/**
 * Remembers how someone likes to watch, across sessions.
 *
 * <h2>Why this is separate from PlaybackProgressService</h2>
 * That service remembers <em>where you were</em> in each recording — a growing map keyed by video,
 * pruned over time. This is a single small record about the person, not about any recording, and it
 * must never be evicted by that pruning. Mixing them would mean a viewer's volume being forgotten
 * because they had watched too many videos.
 *
 * <h2>Why every read and write is defensive</h2>
 * `localStorage` throws outright in some private-browsing modes, can be full, and can contain
 * whatever a previous version of this code wrote. A player that fails to start because it could not
 * read a volume setting would be a far worse bug than one that starts at full volume, so every
 * failure here degrades to the default.
 */
@Injectable({ providedIn: "root" })
export class PlayerPreferencesService {

  private static readonly KEY = "vms.player-prefs.v1";

  load(): PlayerPreferences {
    try {
      const raw = localStorage.getItem(PlayerPreferencesService.KEY);
      if (!raw) return { ...DEFAULTS };
      const parsed = JSON.parse(raw) as Partial<PlayerPreferences>;
      return {
        // Clamped and type-checked rather than trusted. A stored NaN would silence the player with
        // no way for the viewer to understand why, and `volume = NaN` throws on assignment.
        volume: this.clamp(parsed.volume, 0, 1, DEFAULTS.volume),
        muted: typeof parsed.muted === "boolean" ? parsed.muted : DEFAULTS.muted,
        // Bounded to the range the menu offers: a stored 16 would be unplayable and unreachable
        // from the UI, leaving no way back except clearing storage.
        speed: this.clamp(parsed.speed, 0.25, 2, DEFAULTS.speed),
        captions: typeof parsed.captions === "boolean" ? parsed.captions : DEFAULTS.captions,
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  save(prefs: Partial<PlayerPreferences>): void {
    try {
      const merged = { ...this.load(), ...prefs };
      localStorage.setItem(PlayerPreferencesService.KEY, JSON.stringify(merged));
    } catch {
      // Storage unavailable or full. The preference is lost for next time; this session is fine.
    }
  }

  private clamp(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
      ? value
      : fallback;
  }
}
