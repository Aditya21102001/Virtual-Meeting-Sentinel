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
      // 401 — the server will not accept this token at all: the session is over.
      const rejected = err.status === 401 && auth.isAuthenticated();
      // 403 — the token is valid but carries the wrong role. Narrowed on purpose to the case where
      // the client believes it is a moderator and the server disagrees: those two cannot both be
      // right, so the local session is provably stale and signing in again is the cure. A
      // shareholder who touches a moderator-only endpoint is *legitimately* forbidden — that is a
      // correct answer, not a broken session, and must never sign them out.
      const roleStale = err.status === 403 && auth.isModerator();
      const sessionDead = rejected || roleStale;
      const isAuthCall = req.url.includes("/api/auth/");
      if (sessionDead && !isAuthCall) {
        // Captured before logout, which does not navigate but may trigger a guard elsewhere.
        const wasHere = router.url;
        auth.logout();
        router.navigate(["/login"], {
          // returnUrl so signing back in resumes the page they lost, rather than dropping them on
          // the role's home screen with whatever they were doing gone. `reason` distinguishes a
          // lapsed session from a role the server rejected: telling someone their session expired
          // when their permissions changed sends them round the same loop expecting a different end.
          queryParams: {
            expired: "1",
            reason: roleStale ? "role" : "expired",
            returnUrl: wasHere,
          },
        });
      }
      return throwError(() => err);
    }),
  );
};
