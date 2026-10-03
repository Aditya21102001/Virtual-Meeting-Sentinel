import '@angular/compiler';
import { Location } from '@angular/common';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { NavigationEnd, Router } from '@angular/router';
import { NavigationHistoryService } from './navigation-history.service';

describe('NavigationHistoryService', () => {
  function createService(initialUrl = '') {
    const events$ = new Subject<any>();
    const mockRouter = {
      url: initialUrl,
      events: events$.asObservable(),
      navigateByUrl: vi.fn().mockResolvedValue(true),
    } as unknown as Router;

    const mockLocation = {
      back: vi.fn(),
    } as unknown as Location;

    const service = new NavigationHistoryService(mockRouter, mockLocation);

    return { service, mockRouter, mockLocation, events$ };
  }

  it('initializes empty when initial url is root or empty', () => {
    const { service } = createService('/');
    expect(service.canGoBack()).toBe(false);
    expect(service.currentUrl()).toBe('');
    expect(service.previousUrl()).toBe(null);
  });

  it('records initial non-root url', () => {
    const { service } = createService('/ask');
    expect(service.canGoBack()).toBe(false);
    expect(service.currentUrl()).toBe('/ask');
    expect(service.previousUrl()).toBe(null);
  });

  it('tracks sequential navigations and updates previousUrl', () => {
    const { service, events$ } = createService('/welcome');
    expect(service.currentUrl()).toBe('/welcome');

    events$.next(new NavigationEnd(1, '/ask', '/ask'));
    expect(service.currentUrl()).toBe('/ask');
    expect(service.previousUrl()).toBe('/welcome');
    expect(service.canGoBack()).toBe(true);

    events$.next(new NavigationEnd(2, '/help', '/help'));
    expect(service.currentUrl()).toBe('/help');
    expect(service.previousUrl()).toBe('/ask');
  });

  it('deduplicates identical consecutive routes', () => {
    const { service, events$ } = createService('/welcome');
    events$.next(new NavigationEnd(1, '/welcome', '/welcome'));
    expect(service.canGoBack()).toBe(false);
  });

  it('calls location.back() when history exists', () => {
    const { service, mockLocation, events$ } = createService('/welcome');
    events$.next(new NavigationEnd(1, '/login', '/login'));

    service.back('/fallback');
    expect(mockLocation.back).toHaveBeenCalled();
  });

  it('falls back to navigateByUrl when no prior in-app history exists', () => {
    const { service, mockRouter, mockLocation } = createService('/login');
    service.back('/welcome');

    expect(mockLocation.back).not.toHaveBeenCalled();
    expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/welcome');
  });
});
