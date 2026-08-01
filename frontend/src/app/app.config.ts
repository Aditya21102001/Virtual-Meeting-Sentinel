import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { authInterceptor } from './services/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    // Zoneless change detection (stable since Angular 20). No zone.js — CD is driven by
    // signals, the async pipe, template events and markForCheck().
    //
    // Note that every component here is also OnPush, without saying so. As of Angular 22 that is
    // the default: omitting `changeDetection` yields OnPush, the compiler strips the property when
    // it is written out explicitly, and opting *out* now means declaring
    // `ChangeDetectionStrategy.Eager` (`Default` survives as a deprecated alias for it). So the
    // absence of the property in these components is the strategy, not an oversight — do not "fix"
    // it by adding the line back.
    //
    // That makes the following a hard requirement rather than good practice: anything a template
    // reads must be a signal, an input, or a plain field written only from a template event
    // handler. A plain field mutated from a subscribe/setTimeout callback and rendered directly
    // will go stale, because nothing marks the view dirty. The code already holds to this — it is
    // why, for instance, every piece of player state is a signal written from its media listener.
    provideZonelessChangeDetection(),
    provideRouter(routes),
    // authInterceptor: on a dead session (401/403 with a stored token) it clears the
    // session and redirects to /login instead of failing silently.
    provideHttpClient(withInterceptors([authInterceptor])),
  ],
};
