import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { finalize, timeout } from 'rxjs';
import { LoadingService, SILENT } from './loading.service';

/**
 * Raises the loading bar while requests are in flight.
 *
 * <p>One interceptor rather than a spinner per screen: the gaps a per-screen spinner leaves — a
 * slow navigation, a request fired from a service, the first call after a cold start — are exactly
 * the moments the application looked frozen.
 *
 * <p>Requests carrying {@link SILENT} are ignored. Polls and keep-alives would otherwise hold the
 * bar up permanently, and an indicator that is always on conveys nothing.
 *
 * <p>{@code finalize} rather than tapping next/error: it runs on success, on failure <em>and on
 * unsubscribe</em>. That last case is the one that matters — a component destroyed mid-request
 * cancels it, and without finalize the count would never come back down and the bar would stay lit
 * for the rest of the session.
 */
export const loadingInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.context.get(SILENT)) return next(req);

  const loading = inject(LoadingService);
  loading.start();
  return next(req).pipe(
    // A hard ceiling on every counted request.
    //
    // finalize() covers success, failure and cancellation — but NOT a request that simply never
    // settles, which is exactly what a sleeping server behind a proxy produces. Without this the
    // counter stays poisoned for the rest of the session: the overlay's own failsafe hides it once,
    // then it reappears on the next request and never clears.
    //
    // Two minutes is generous by design. Everything genuinely long — uploads, indexing, transcodes
    // — is marked SILENT and never reaches this line, so anything still here after two minutes is
    // not working, it is stuck.
    timeout(120000),
    finalize(() => loading.stop()),
  );
};
