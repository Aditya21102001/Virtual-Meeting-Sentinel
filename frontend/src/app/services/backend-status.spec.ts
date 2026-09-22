import "@angular/compiler";
import { of } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendStatusService, SKIP_BACKEND_RETRY } from "./backend-status";

describe("BackendStatusService", () => {
  let service: BackendStatusService;
  let http: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    http = { get: vi.fn(() => of({ status: "ok" })) };
    service = new BackendStatusService(http as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts without a notice and hides it after recovery", () => {
    expect(service.status()).toBe("unknown");
    expect(service.showNotice()).toBe(false);

    service.markUnavailable();
    expect(service.status()).toBe("warming");
    service.markSuccess();

    expect(service.status()).toBe("ready");
    expect(service.showNotice()).toBe(false);
  });

  it("polls health and recovers automatically", () => {
    vi.useFakeTimers();
    service.markUnavailable();
    vi.advanceTimersByTime(0);
    expect(http.get).toHaveBeenCalledOnce();
    expect(service.status()).toBe("ready");
    expect(service.showNotice()).toBe(false);
  });

  it("restarts polling immediately when retry is requested", () => {
    vi.useFakeTimers();
    service.markUnavailable();
    service.retryNow();
    vi.advanceTimersByTime(0);
    expect(http.get).toHaveBeenCalledTimes(1);
    const requestOptions = http.get.mock.calls[0][1];
    expect(requestOptions.context.get(SKIP_BACKEND_RETRY)).toBe(true);
  });
});