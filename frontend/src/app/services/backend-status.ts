import { HttpClient, HttpContext, HttpContextToken } from "@angular/common/http";
import { Injectable, computed, signal } from "@angular/core";
import { catchError, finalize, of, timeout } from "rxjs";
import { environment } from "../../environments/environment";

export type BackendState =
  | "unknown"
  | "ready"
  | "warming"
  | "unreachable"
  | "offline";

/** Prevents the global interceptor from adding a second retry layer to a request. */
export const SKIP_BACKEND_RETRY = new HttpContextToken<boolean>(() => false);

const POLL_INTERVAL_MS = 10000;
const COLD_START_WINDOW_MS = 180000;

@Injectable({ providedIn: "root" })
export class BackendStatusService {
  private readonly state = signal<BackendState>("unknown");
  private readonly startedAt = signal<number | null>(null);
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;

  readonly status = this.state.asReadonly();
  readonly showNotice = computed(() => {
    const current = this.state();
    return current === "warming" || current === "unreachable" || current === "offline";
  });

  constructor(private readonly http: HttpClient) {
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.retryNow());
      window.addEventListener("offline", () => {
        this.state.set("offline");
        this.stopPolling();
      });
      if (!navigator.onLine) this.state.set("offline");
    }
  }

  markSuccess(): void {
    this.state.set("ready");
    this.startedAt.set(null);
    this.stopPolling();
  }

  markUnavailable(): void {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      this.state.set("offline");
      this.stopPolling();
      return;
    }

    if (this.startedAt() === null) this.startedAt.set(Date.now());
    this.state.set(
      Date.now() - (this.startedAt() ?? Date.now()) >= COLD_START_WINDOW_MS
        ? "unreachable"
        : "warming",
    );
    this.startPolling();
  }

  retryNow(): void {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      this.state.set("offline");
      return;
    }
    this.startedAt.set(Date.now());
    this.state.set("warming");
    this.stopPolling();
    this.pollHealth();
  }

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.schedulePoll(0);
  }

  private schedulePoll(delay: number): void {
    this.pollTimer = setTimeout(() => this.pollHealth(), delay);
  }

  private pollHealth(): void {
    if (!this.polling || (typeof navigator !== "undefined" && !navigator.onLine)) return;

    this.http
      .get(`${environment.apiBase}/health`, {
        context: new HttpContext().set(SKIP_BACKEND_RETRY, true),
      })
      .pipe(
        timeout(15000),
        catchError(() => of(null)),
        finalize(() => {
          if (!this.polling) return;
          if (this.state() === "warming" && Date.now() - (this.startedAt() ?? Date.now()) >= COLD_START_WINDOW_MS) {
            this.state.set("unreachable");
          }
          this.schedulePoll(POLL_INTERVAL_MS);
        }),
      )
      .subscribe((response) => {
        if (response !== null) this.markSuccess();
      });
  }

  private stopPolling(): void {
    this.polling = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}