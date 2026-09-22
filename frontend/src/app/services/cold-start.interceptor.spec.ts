import "@angular/compiler";
import { isRetryableBackendMethod } from "./cold-start.interceptor";

describe("cold-start retry policy", () => {
  it("retries only idempotent request methods", () => {
    expect(isRetryableBackendMethod("GET")).toBe(true);
    expect(isRetryableBackendMethod("HEAD")).toBe(true);
    expect(isRetryableBackendMethod("OPTIONS")).toBe(true);
  });

  it("never automatically retries unsafe request methods", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isRetryableBackendMethod(method)).toBe(false);
    }
  });
});