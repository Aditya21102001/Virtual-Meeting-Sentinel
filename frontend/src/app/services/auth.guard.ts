import { inject } from '@angular/core';
import { CanActivateFn, Router, RouterStateSnapshot } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Send an unauthenticated visitor to the login page, remembering where they were going.
 *
 * <p>Without the `returnUrl` a shared link is unusable by the person it was shared with: they open
 * `/recordings?v=…&t=…`, get bounced to `/login`, and after signing in land on the default page with
 * the recording and timestamp gone. Carrying the attempted URL through is what makes a link work for
 * someone who was not already signed in — which is the only case a shared link exists for.
 */
function toLogin(router: Router, state: RouterStateSnapshot) {
  return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
}

/** Protects moderator-only routes; redirects to /login when not signed in as a moderator. */
export const moderatorGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isModerator() ? true : toLogin(router, state);
};

/** Protects routes that only need a signed-in member (e.g. the Shareholder Lounge). */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.isAuthenticated() ? true : toLogin(router, state);
};
