import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { routes } from './app.routes';
import { authInterceptor } from './services/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    // Zoneless change detection (stable since Angular 20). No zone.js — CD is driven by
    // signals, the async pipe, template events and markForCheck().
    provideZonelessChangeDetection(),
    provideRouter(routes),
    // authInterceptor: on a dead session (401/403 with a stored token) it clears the
    // session and redirects to /login instead of failing silently.
    provideHttpClient(withInterceptors([authInterceptor])),
  ],
};
