import '@angular/compiler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WarmupService } from './warmup.service';
import { BackendStatusService } from './backend-status';

describe('WarmupService', () => {
  let service: WarmupService;
  let backendStatus: BackendStatusService;

  beforeEach(() => {
    backendStatus = {
      markSuccess: vi.fn(),
      markUnavailable: vi.fn(),
    } as unknown as BackendStatusService;

    service = new WarmupService(backendStatus);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('starts in idle phase and begins warming on warmUp()', async () => {
    expect(service.phase()).toBe('idle');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: 'UP' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    service.warmUp();
    expect(service.phase()).toBe('warming');

    // Wait for the async fetch to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchMock).toHaveBeenCalled();
    expect(service.phase()).toBe('ready');
    expect(backendStatus.markSuccess).toHaveBeenCalled();
  });

  it('polls until server is up', async () => {
    vi.useFakeTimers();

    let attempts = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 2) {
        return Promise.reject(new Error('Cold start 502'));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: 'UP' }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    service.warmUp();
    expect(service.phase()).toBe('warming');

    // First attempt fails
    await vi.advanceTimersByTimeAsync(10);
    expect(service.phase()).toBe('warming');

    // Advance 4s for retry poll
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(10);

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(service.phase()).toBe('ready');
    expect(backendStatus.markSuccess).toHaveBeenCalled();
  });
});
