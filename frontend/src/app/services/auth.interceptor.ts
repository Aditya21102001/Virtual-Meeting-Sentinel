import { HttpErrorResponse, HttpInterceptorFn } from "@angular/common/http";
import { inject } from "@angular/core";
import { Router } from "@angular/router";
import { catchError, throwError } from "rxjs";
import { AuthService } from "./auth.service";

/**
 * Session-expiry handling. When a request made on behalf of a signed-in user is rejected as
 * unauthenticated/forbidden — a stale or expired JWT (the 8h token lapsed, or the backend's
 * JWT_SECRET changed on redeploy) — clear the dead session and bounce to /login. Without this
 * the app fails silently with a cryptic 403 while still *looking* logged in (the route guards
 * only decode the token locally; they never verify it against the server).
 *
 * Scoped to sessions that actually have a stored token, so the anonymous attendee flow on
 * /ask is untouched, and auth endpoints (login/register/OTP/MFA) are excluded so a wrong
 * password just shows its error rather than triggering a redirect.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return next(req).pipe(
    catchError((err: HttpErrorResponse) => {
      const sessionDead = err.status === 401 && auth.isAuthenticated();
      const isAuthCall = req.url.includes("/api/auth/");
      if (sessionDead && !isAuthCall) {
        auth.logout();
        router.navigate(["/login"], { queryParams: { expired: "1" } });
      }
      return throwError(() => err);
    }),
  );
};
