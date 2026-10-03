import { Location } from '@angular/common';
import { Injectable, computed, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/**
 * Tracks route history within the single-page application to ensure smooth back navigation.
 *
 * <h2>Why this exists</h2>
 * In a complex SPA with auth guards, query parameters (e.g. `?returnUrl=...`), and dynamic
 * redirects, relying purely on the browser's raw history can trap users in redirect loops
 * (e.g. going back to an unauthorized route that immediately bounces forward again).
 *
 * This service maintains an in-app history stack, exposes reactive previous-URL signals,
 * and provides a safe `back()` action that defaults to an appropriate fallback if the user
 * landed directly on a deep link or refreshed the page.
 */
@Injectable({
  providedIn: 'root',
})
export class NavigationHistoryService {
  private history: string[] = [];
  readonly currentUrl = signal<string>('');
  readonly previousUrl = signal<string | null>(null);

  /** Whether the user has traversed at least two routes inside this application session. */
  readonly canGoBack = computed(() => this.history.length > 1);

  constructor(
    private readonly router: Router,
    private readonly location: Location,
  ) {
    this.init();
  }

  private init(): void {
    // Record initial URL if router already has one
    if (this.router.url && this.router.url !== '/') {
      this.pushUrl(this.router.url);
    }

    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => {
        this.pushUrl(event.urlAfterRedirects || event.url);
      });
  }

  private pushUrl(url: string): void {
    if (!url || url === '/') {
      return;
    }
    const last = this.history[this.history.length - 1];
    if (last === url) {
      return;
    }

    // Set previousUrl before appending current
    if (this.history.length > 0) {
      this.previousUrl.set(last);
    }

    this.history.push(url);
    this.currentUrl.set(url);

    // Keep history stack bounded
    if (this.history.length > 50) {
      this.history.shift();
    }
  }

  /**
   * Safely navigates backwards.
   * If the user has in-app history, navigates back via Location.
   * If there is no previous page in the session (e.g., opened via direct link or new tab),
   * falls back to the provided `fallbackUrl`.
   *
   * @param fallbackUrl Destination route if no in-app history exists (defaults to '/welcome')
   */
  back(fallbackUrl: string = '/welcome'): void {
    if (this.history.length > 1) {
      // Pop the current page from our internal tracker
      this.history.pop();
      const prev = this.history[this.history.length - 1];
      this.currentUrl.set(prev || '');
      this.previousUrl.set(this.history.length > 1 ? this.history[this.history.length - 2] : null);
      this.location.back();
    } else {
      this.history = [];
      this.previousUrl.set(null);
      void this.router.navigateByUrl(fallbackUrl);
    }
  }

  /**
   * Clears tracked history (useful on logout or session reset).
   */
  clear(): void {
    this.history = [];
    this.previousUrl.set(null);
    if (this.router.url && this.router.url !== '/') {
      this.pushUrl(this.router.url);
    }
  }
}
