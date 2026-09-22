import "@angular/compiler";
import { HttpClientTestingModule, HttpTestingController } from "@angular/common/http/testing";
import { TestBed, fakeAsync, tick } from "@angular/core/testing";
import { BackendStatusService, SKIP_BACKEND_RETRY } from "./backend-status";

describe("BackendStatusService", () => {
  let service: BackendStatusService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HttpClientTestingModule] });
    service = TestBed.inject(BackendStatusService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it("starts without a notice and hides it after recovery", () => {
    expect(service.status()).toBe("unknown");
    expect(service.showNotice()).toBe(false);

    service.markUnavailable();
    expect(service.status()).toBe("warming");
    service.markSuccess();

    expect(service.status()).toBe("ready");
    expect(service.showNotice()).toBe(false);
  });

  it("polls health and recovers automatically", fakeAsync(() => {
    service.markUnavailable();
    tick();
    const request = http.expectOne((candidate) => candidate.url.endsWith("/health"));
    request.flush({ status: "ok" });
    expect(service.status()).toBe("ready");
    expect(service.showNotice()).toBe(false);
  }));

  it("restarts polling immediately when retry is requested", fakeAsync(() => {
    service.markUnavailable();
    service.retryNow();
    tick();
    const request = http.expectOne((candidate) => candidate.url.endsWith("/health"));
    expect(request.request.context.get(SKIP_BACKEND_RETRY)).toBe(true);
    request.flush({ status: "ok" });
  }));
});