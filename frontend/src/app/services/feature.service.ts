import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

/** Keys must match the backend `Feature` enum — it is the catalogue. */
export type FeatureKey =
  | 'VIDEO_LIBRARY'
  | 'VIDEO_ENGAGEMENT'
  | 'VIDEO_DOWNLOAD'
  | 'LOUNGE_CHAT'
  | 'AI_DRAFTING'
  | 'MEETINGS'
  | 'SEMANTIC_SEARCH'
  | 'HELP_WIDGET'
  | 'AUTO_TRANSCRIPTION'
  | 'VOTING'
  | 'QUORUM'
  | 'CLUSTER_UPVOTE'
  | 'CLUSTER_CURATION'
  | 'RUN_OF_SHOW'
  | 'MEETING_REPORTS'
  | 'ATTENDEE_BOARD';

/** One feature as the admin screen sees it. */
export interface FeatureView {
  key: FeatureKey;
  label: string;
  description: string;
  enabled: boolean;
  allowedRoles: string[];
  /** False while it is still on its shipped default — nobody has touched it. */
  customised: boolean;
  enabledByDefault: boolean;
  updatedBy: string | null;
}

/**
 * What this deployment has switched on, and what this user may therefore see.
 *
 * <p>Loaded once per session and held in a signal: the answer gates navigation and page sections, so
 * asking the server on every render would put a round trip in front of the menu.
 *
 * <p>Fails **open** for features that ship enabled and **closed** for the rest — see `enabled()`.
 * That is deliberate: if the flag list cannot be fetched, the application should still behave as it
 * did before flags existed rather than appearing to have lost half its features.
 */
@Injectable({ providedIn: 'root' })
export class FeatureService {
  private readonly base = `${environment.apiBase}/api/features`;
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);

  /** Keys available to the signed-in user. Null until loaded. */
  private readonly available = signal<Set<FeatureKey> | null>(null);
  readonly loaded = computed(() => this.available() !== null);

  /**
   * Features that ship on. Used only as the fallback while the list is unknown, so a slow or failed
   * fetch degrades to "the application as it was" rather than to an empty shell.
   */
  private static readonly ON_BY_DEFAULT: ReadonlySet<string> = new Set([
    'VIDEO_LIBRARY',
    'VIDEO_ENGAGEMENT',
    'VIDEO_DOWNLOAD',
    'LOUNGE_CHAT',
    'AI_DRAFTING',
  ]);

  private headers(): Record<string, string> {
    const token = this.auth.token();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** Ask what this user may use. Safe to call repeatedly; the result replaces the cache. */
  refresh(): Observable<string[]> {
    return this.http
      .post<string[]>(`${this.base}/my-features`, {}, { headers: this.headers() })
      .pipe(tap((keys) => this.available.set(new Set(keys as FeatureKey[]))));
  }

  /** Forget the cache — call on sign-out, since the answer is per user. */
  clear(): void {
    this.available.set(null);
  }

  enabled(key: FeatureKey): boolean {
    const known = this.available();
    if (known === null) return FeatureService.ON_BY_DEFAULT.has(key);
    return known.has(key);
  }

  // ---- administration (ADMIN only; the server enforces it) -------------------

  list(): Observable<FeatureView[]> {
    return this.http.post<FeatureView[]>(`${this.base}/list-features`, {}, { headers: this.headers() });
  }

  assignableRoles(): Observable<string[]> {
    return this.http.post<string[]>(`${this.base}/assignable-roles`, {}, { headers: this.headers() });
  }

  set(key: FeatureKey, enabled: boolean, allowedRoles: string[]): Observable<FeatureView> {
    return this.http
      .post<FeatureView>(
        `${this.base}/set-feature`,
        { key, enabled, allowedRoles },
        { headers: this.headers() },
      )
      // The change may affect the current user's own menu, so re-read what they can see.
      .pipe(tap(() => this.refresh().subscribe({ error: () => {} })));
  }

  reset(key: FeatureKey): Observable<FeatureView> {
    return this.http
      .post<FeatureView>(`${this.base}/reset-feature`, { key }, { headers: this.headers() })
      .pipe(tap(() => this.refresh().subscribe({ error: () => {} })));
  }
}
