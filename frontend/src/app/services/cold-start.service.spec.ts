import { describe, expect, it, vi, afterEach } from 'vitest';
import { ColdStartService } from './cold-start.service';

/**
 * When the application tells somebody the server is waking, and when it stays quiet.
 *
 * <h2>Why the threshold is the thing worth testing</h2>
 * Both failure modes are bad, in opposite directions. Too eager and one dropped request on a train
 * puts a "the server is asleep" banner over a working application, which teaches people to ignore
 * it — and an ignored banner is worse than none, because it is still there during a real outage.
 * Too reluctant and the notice never appears in the window it exists for. Neither is visible from
 * outside the class, so neither would survive a refactor without this.
 */
describe('ColdStartService', () => {

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays quiet after a single failure', () => {
    const service = new ColdStartService();

    service.recordFailure();

    // One failed request is evidence of a network, not of a sleeping server.
    expect(service.waking()).toBe(false);
  });

  it('reports waking after two consecutive failures', () => {
    const service = new ColdStartService();

    service.recordFailure();
    service.recordFailure();

    expect(service.waking()).toBe(true);
  });

  it('a success in between resets the count, so alternating failures never trigger it', () => {
    const service = new ColdStartService();

    service.recordFailure();
    service.recordSuccess();
    service.recordFailure();

    // The server answered in between, so it is up. Whatever is failing is not a cold start, and
    // saying otherwise sends somebody away to wait out a bug that will not fix itself.
    expect(service.waking()).toBe(false);
  });

  it('clears as soon as anything succeeds', () => {
    const service = new ColdStartService();
    service.recordFailure();
    service.recordFailure();
    expect(service.waking()).toBe(true);

    service.recordSuccess();

    expect(service.waking()).toBe(false);
    expect(service.elapsedSeconds()).toBe(0);
  });

  it('a success with nothing outstanding changes no state', () => {
    const service = new ColdStartService();

    // Called on EVERY successful response, which is nearly all of them. It must not write signals
    // in the healthy case, or every request in the application would schedule change detection.
    service.recordSuccess();

    expect(service.waking()).toBe(false);
    expect(service.elapsedSeconds()).toBe(0);
  });

  it('counts elapsed time from the FIRST failure, not the most recent', () => {
    vi.useFakeTimers();
    const service = new ColdStartService();

    service.recordFailure();
    vi.advanceTimersByTime(5000);
    service.recordFailure();
    vi.advanceTimersByTime(1000);

    // 6s since the first failure, not 1s since the second. The viewer wants to know how long they
    // have been waiting, and that clock started when the first request failed.
    expect(service.elapsedSeconds()).toBe(6);
  });

  it('stops ticking once the server answers', () => {
    vi.useFakeTimers();
    const service = new ColdStartService();
    service.recordFailure();
    service.recordFailure();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    service.recordSuccess();

    // A 1s interval left running for the rest of the session would wake the tab forever for a
    // condition that has already resolved.
    expect(vi.getTimerCount()).toBe(0);
  });
});
