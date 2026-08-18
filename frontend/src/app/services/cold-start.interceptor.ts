import { HttpErrorResponse, HttpInterceptorFn } from "@angular/common/http";
import { inject } from "@angular/core";
import { catchError, tap, throwError } from "rxjs";
import { ColdStartService } from "./cold-start.service";

/**
 * Watches every response for the shape a sleeping backend produces, and tells {@link ColdStartService}.
 *
 * <p>Deliberately does not swallow, retry or delay anything. Callers keep the exact error they
 * would have received, so every existing failure path still runs; this only observes on the way
 * past. An interceptor that started retrying would multiply requests against a server that is
 * already struggling, which is the opposite of helpful.
 *
 * <p>Applies to SILENT requests too. Polls and keep-alives are usually the FIRST thing to hit a
 * sleeping server — they run on a timer without anyone touching the page — so ignoring them would
 * discard the earliest and clearest evidence.
 */
export const coldStartInterceptor: HttpInterceptorFn = (req, next) => {
  const coldStart = inject(ColdStartService);

  return next(req).pipe(
    tap({
      next: (event) => {
        // Any response at all means something is listening. Progress events count: bytes are
        // flowing, so the connection was accepted.
        if (event) coldStart.recordSuccess();
      },
    }),
    catchError((error: unknown) => {
      if (error instanceof HttpErrorResponse && isAsleep(error.status)) {
        coldStart.recordFailure();
      }
      return throwError(() => error);
    }),
  );
};

/**
 * Is this the status a sleeping or restarting container behind a proxy produces?
 *
 * <p>0 is the browser reporting no HTTP response at all — DNS, connection refused, or a CORS
 * failure. That last one matters here: when the container is down, the proxy's error page carries
 * no CORS headers, so the browser reports a CORS error rather than the 502 that was actually sent.
 * A "CORS problem" that appears only intermittently is almost always this.
 *
 * <p>500 is excluded on purpose. That is the application running and failing, which is a bug to fix
 * rather than a wait to sit out.
 */
function isAsleep(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}
