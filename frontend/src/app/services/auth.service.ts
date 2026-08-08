import { HttpClient, HttpContext } from "@angular/common/http";
import { Injectable, computed, inject, signal } from "@angular/core";
import { Router } from "@angular/router";
import { firstValueFrom, Observable } from "rxjs";
import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import { environment } from "../../environments/environment";
import { SILENT } from "./loading.service";
import { ApiService } from "./api.service";

export interface LoginResult {
  status: "AUTHENTICATED" | "MFA_REQUIRED";
  token: string | null;
  mfaToken: string | null;
  methods: string[] | null;
}
export interface MfaStatus {
  pin: boolean;
  totp: boolean;
  webauthn: boolean;
}
export interface TotpInit {
  secret: string;
  qrDataUri: string;
  otpauthUri: string;
}
export interface AuthConfig {
  googleEnabled: boolean;
  otpDemoMode: boolean;
}
export interface OtpRequestResult {
  sent: boolean;
  demoCode: string | null;
}

/**
 * Authentication + MFA client. Owns the session (token/role/username as signals, persisted
 * to localStorage) and drives the WebAuthn browser ceremonies. Sets the token on ApiService
 * so the existing feature calls (board, submit, uploads) are authenticated.
 */
@Injectable({ providedIn: "root" })
export class AuthService {
  private readonly base = environment.apiBase;

  readonly token = signal<string | null>(localStorage.getItem("agm_token"));
  readonly role = signal<string | null>(localStorage.getItem("agm_role"));
  readonly username = signal<string | null>(localStorage.getItem("agm_user"));
  readonly isAuthenticated = computed(() => this.hasValidToken(this.token()));
  readonly isModerator = computed(() => {
    const r = this.role();
    return (
      this.hasValidToken(this.token()) && (r === "MODERATOR" || r === "ADMIN")
    );
  });
  readonly isShareholder = computed(
    () => this.hasValidToken(this.token()) && this.role() === "SHAREHOLDER",
  );

  /**
   * Every role in the current token — the primary one plus any additional duties.
   *
   * <p>Read from the token's `roles` claim, falling back to the single `role` for tokens issued
   * before additional roles existed. That fallback is what stops a deploy signing everyone out or
   * silently stripping their menu.
   */
  readonly roles = computed<string[]>(() => {
    const token = this.token();
    if (!token || !this.hasValidToken(token)) return [];
    const claim = this.claim(token, "roles");
    if (Array.isArray(claim) && claim.length) return claim.map(String);
    const single = this.role();
    return single ? [single] : [];
  });

  /** ADMIN is deliberately a superset: it can do anything either manager can. */
  hasRole(role: string): boolean {
    const held = this.roles();
    return held.includes(role) || held.includes("ADMIN");
  }

  readonly isMeetingManager = computed(() => this.hasRole("MEETING_MANAGER"));
  readonly isUserManager = computed(() => this.hasRole("USER_MANAGER"));
  /** Either duty gets the Meetings screen; what they can do there differs. */
  readonly managesMeetings = computed(
    () => this.isMeetingManager() || this.isUserManager(),
  );

  private readonly router = inject(Router);

  /** Fires when the current token's `exp` passes. Null when there is no live session. */
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private http: HttpClient,
    private api: ApiService,
  ) {
    if (this.token()) {
      this.api.setToken(this.token()!);
      if (this.hasValidToken(this.token())) {
        // A restored token keeps the expiry it was last renewed with, so what is left of the idle
        // window may be minutes. The first interaction renews it; until then this holds the line.
        this.scheduleExpiry(this.token()!);
      } else {
        this.logout();
      }
    }
    this.watchOtherTabs();
    this.watchActivity();
  }

  // ---- session -----------------------------------------------------------
  completeLogin(token: string): void {
    // An unreadable role is NO role, deliberately. This used to fall back to "MODERATOR", which
    // fails open in the worst direction: when the claim could not be decoded the client awarded
    // itself the highest privilege, the route guards then admitted the user to /board, and every
    // call from that page came back 403 from a server that had read the same token and disagreed.
    // The result is a session that looks privileged, is not, and offers no clue why — the server
    // is the only authority on the role, so guessing it here can only ever guess wrong.
    const role = this.decodeRole(token);
    const user = this.decodeSubject(token) ?? "";
    this.token.set(token);
    this.role.set(role);
    this.username.set(user);
    localStorage.setItem("agm_token", token);
    // Remove rather than store "null": a literal would read back as a truthy role on next load.
    if (role) localStorage.setItem("agm_role", role);
    else localStorage.removeItem("agm_role");
    localStorage.setItem("agm_user", user);
    this.api.setToken(token);
    this.scheduleExpiry(token);
    this.lastRenewedAt = Date.now();
  }

  logout(): void {
    this.cancelExpiry();
    this.token.set(null);
    this.role.set(null);
    this.username.set(null);
    localStorage.removeItem("agm_token");
    localStorage.removeItem("agm_role");
    localStorage.removeItem("agm_user");
    this.api.setToken("");
  }

  // ---- inactivity timeout ------------------------------------------------
  //
  // The session ends after `jwt.ttl-seconds` (8 hours) with no activity. The token's own lifetime is
  // that window: this renews it while the user is doing things, so the clock effectively restarts on
  // each interaction, and stops being pushed forward the moment they stop.
  //
  // The renewal is what makes it an *inactivity* timeout rather than an absolute one, and the server
  // is what enforces it — a token that has already expired cannot be renewed.

  /** Don't renew more often than this; an interaction every few seconds must not be a request each. */
  private static readonly RENEW_EVERY_MS = 5 * 60 * 1000;

  /** Renewal in flight, so a burst of activity cannot fire several at once. */
  private renewing = false;
  private lastRenewedAt = 0;

  /**
   * Renew the session if the user is active and the token has aged enough to be worth it.
   *
   * <p>The cadence matters for how sharp the timeout is. Renewing at most every 5 minutes means the
   * token always has at least 7 h 55 m left when someone walks away, so the effective idle window is
   * 8 hours give or take five minutes. Renewing only when nearly expired would be cheaper but would
   * make the timeout anywhere between 4 and 8 hours depending on when they happened to stop.
   */
  private renewIfActive(): void {
    const token = this.token();
    if (!token || this.renewing) return;
    if (Date.now() - this.lastRenewedAt < AuthService.RENEW_EVERY_MS) return;
    if (!this.hasValidToken(token)) return;   // already gone; the expiry timer owns this

    this.renewing = true;
    this.lastRenewedAt = Date.now();
    this.http
      .post<{ token: string }>(
        `${this.base}/api/auth/refresh-session`,
        {},
        // SILENT, and this one matters most: session renewal runs on a timer regardless of what
        // the user is doing, so counting it would make the loading bar appear on its own with no
        // interaction at all — which reads as the application doing something unexplained.
        { headers: this.authHeaders(), context: new HttpContext().set(SILENT, true) },
      )
      .subscribe({
        next: (r) => {
          this.renewing = false;
          // completeLogin re-arms the expiry timer against the new `exp`.
          if (r.token) this.completeLogin(r.token);
        },
        error: (err) => {
          this.renewing = false;
          // A 401 is the server declining to extend this session — past the absolute cap, or the
          // token lapsed in flight. End it now: the current token may still have hours left, and
          // waiting for that would make the cap mean "24 hours, plus up to another 8".
          //
          // Anything else (offline, instance asleep) is not an answer about the session, so the
          // existing expiry timer stays in charge and a passing outage signs nobody out early.
          // The auth interceptor deliberately ignores /api/auth/ paths, so this is the only place
          // that decision gets made.
          if (err?.status === 401) this.expireSession();
        },
      });
  }

  /**
   * Watch for the user doing something.
   *
   * <p>Passive listeners on the events that indicate a person is present, not merely that the page
   * is open — a timer or a background poll must not count as activity, or the session would never
   * time out for anyone with a tab left open. `visibilitychange` is included because returning to a
   * backgrounded tab is a real interaction and is often the moment a renewal is most needed.
   */
  private watchActivity(): void {
    const onActivity = () => this.renewIfActive();
    for (const event of ["pointerdown", "keydown", "wheel", "touchstart"]) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.renewIfActive();
    });
  }

  /**
   * End the session the moment the token expires, rather than whenever something notices.
   *
   * <p>This is not belt-and-braces on top of the interceptor — it closes a real hole.
   * {@link isAuthenticated} is a computed over the `token` signal, and the expiry check inside it
   * reads `Date.now()`, which is not reactive. So the value is cached until the token *changes*:
   * a tab left open past the 8-hour mark keeps rendering as signed in, and the route guards keep
   * letting the user in, until some request happens to come back 401. A timer that clears the token
   * is what makes the expiry actually observable — every guard and every computed re-evaluates
   * because the signal it depends on changed.
   *
   * <p>The delay comes from the token's own `exp`, so the frontend never carries its own idea of how
   * long a session lasts; changing `JWT_TTL_SECONDS` on the server moves this with it.
   */
  private scheduleExpiry(token: string): void {
    this.cancelExpiry();
    const expiry = this.decodeExpiry(token);
    if (expiry == null) return;   // no exp claim: nothing to schedule against

    const remaining = expiry * 1000 - Date.now();
    if (remaining <= 0) {
      this.expireSession();
      return;
    }
    // setTimeout takes a signed 32-bit delay; anything larger overflows and fires immediately.
    // 8 hours is nowhere near that, but a misconfigured TTL should degrade to "check later"
    // rather than "log out now".
    const MAX_DELAY = 2 ** 31 - 1;
    this.expiryTimer = setTimeout(
      () => (remaining > MAX_DELAY ? this.scheduleExpiry(token) : this.expireSession()),
      Math.min(remaining, MAX_DELAY),
    );
  }

  private cancelExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  /**
   * Clear the session and send the user to sign in again, keeping where they were.
   *
   * <p>Not redirected from public pages: an attendee on `/ask` never signed in, and bouncing them to
   * a login form they have no account for would be worse than letting the page be.
   */
  private expireSession(): void {
    const wasHere = this.router.url;
    this.logout();

    // Pages that need no session. Being signed out on one of these changes nothing about what the
    // reader can see, so redirecting them is pure interruption — and on /help it is worse than
    // that: "why can I not sign in" is a help question, so throwing somebody off the help page at
    // the moment their session dies takes away the answer exactly when they need it.
    const publicPage =
      wasHere.startsWith("/login") ||
      wasHere.startsWith("/ask") ||
      wasHere.startsWith("/help");
    if (publicPage) return;
    this.router.navigate(["/login"], {
      queryParams: { expired: "1", returnUrl: wasHere },
    });
  }

  /**
   * Keep tabs in step. `localStorage` is shared, so signing out in one tab must not leave another
   * showing a session whose token is already gone — the next request from it would fail with no
   * explanation. The `storage` event fires only in *other* tabs, so this cannot loop.
   */
  private watchOtherTabs(): void {
    window.addEventListener("storage", (event) => {
      if (event.key !== null && event.key !== "agm_token") return;
      const stored = localStorage.getItem("agm_token");
      if (!stored) {
        if (this.token()) this.expireSession();
        return;
      }
      if (stored !== this.token()) {
        // Signed in (or re-signed in) elsewhere; adopt it rather than keeping a stale token.
        this.completeLogin(stored);
      }
    });
  }

  private authHeaders(): Record<string, string> {
    const t = this.token();
    return t ? { Authorization: `Bearer ${t}` } : {};
  }

  // ---- register / password login -----------------------------------------
  register(
    username: string,
    email: string,
    phone: string,
    password: string,
  ): Observable<LoginResult> {
    return this.http.post<LoginResult>(`${this.base}/api/auth/register`, {
      username,
      email,
      phone,
      password,
    });
  }
  login(username: string, password: string): Observable<LoginResult> {
    return this.http.post<LoginResult>(`${this.base}/api/auth/login`, {
      username,
      password,
    });
  }
  verifyCode(
    mfaToken: string,
    method: "pin" | "totp",
    code: string,
  ): Observable<{ token: string }> {
    return this.http.post<{ token: string }>(
      `${this.base}/api/auth/mfa/verify`,
      { mfaToken, method, code },
    );
  }

  // ---- public config (which login methods to show) -----------------------
  config(): Observable<AuthConfig> {
    return this.http.post<AuthConfig>(`${this.base}/api/auth/login-options`, {});
  }

  // ---- passwordless OTP login (email / SMS) ------------------------------
  otpRequest(
    channel: "email" | "sms",
    destination: string,
  ): Observable<OtpRequestResult> {
    return this.http.post<OtpRequestResult>(
      `${this.base}/api/auth/otp/request`,
      { channel, destination },
    );
  }
  otpVerify(
    channel: "email" | "sms",
    destination: string,
    code: string,
  ): Observable<{ token: string }> {
    return this.http.post<{ token: string }>(
      `${this.base}/api/auth/otp/verify`,
      { channel, destination, code },
    );
  }

  // ---- Google OAuth2 (browser redirects to the backend handshake) --------
  googleLoginUrl(): string {
    return `${this.base}/oauth2/authorization/google`;
  }

  // ---- enrollment (needs a full access token) ----------------------------
  enrollStatus(): Observable<MfaStatus> {
    return this.http.post<MfaStatus>(
      `${this.base}/api/auth/enroll/status`,
      {},
      { headers: this.authHeaders() },
    );
  }
  setPin(pin: string): Observable<MfaStatus> {
    return this.http.post<MfaStatus>(
      `${this.base}/api/auth/enroll/pin`,
      { pin },
      { headers: this.authHeaders() },
    );
  }
  totpInit(): Observable<TotpInit> {
    return this.http.post<TotpInit>(
      `${this.base}/api/auth/enroll/totp/init`,
      {},
      { headers: this.authHeaders() },
    );
  }
  totpEnable(code: string): Observable<MfaStatus> {
    return this.http.post<MfaStatus>(
      `${this.base}/api/auth/enroll/totp/enable`,
      { code },
      { headers: this.authHeaders() },
    );
  }

  // ---- WebAuthn passkey (biometric) --------------------------------------

  /**
   * Enroll a passkey for the logged-in user (registration ceremony):
   * 1. ask the backend for creation options (challenge, rp, user, algorithms);
   * 2. startRegistration() triggers the device authenticator (Windows Hello / Touch ID) to
   *    create a key pair — the private key + biometric NEVER leave the device;
   * 3. send the resulting public-key credential back so the backend stores the PUBLIC key.
   */
  async enrollPasskey(): Promise<void> {
    const optionsText = await firstValueFrom(
      this.http.post(
        `${this.base}/api/auth/enroll/webauthn/start`,
        {},
        {
          headers: this.authHeaders(),
          responseType: "text",
        },
      ),
    );
    // Yubico wraps the options as { publicKey: {...} }; @simplewebauthn wants the inner object.
    const options = JSON.parse(optionsText);
    const attResp = await startRegistration({ optionsJSON: options.publicKey });
    await firstValueFrom(
      this.http.post(
        `${this.base}/api/auth/enroll/webauthn/finish`,
        { credential: attResp },
        { headers: this.authHeaders() },
      ),
    );
  }

  /**
   * Log in with a passkey (assertion ceremony), used as an MFA second factor:
   * 1. get an assertion challenge for the pending MFA session;
   * 2. startAuthentication() has the device sign the challenge after a local biometric check;
   * 3. the backend verifies the signature against the stored public key and returns a full token.
   */
  async loginPasskey(mfaToken: string): Promise<string> {
    const optionsText = await firstValueFrom(
      this.http.post(
        `${this.base}/api/auth/mfa/webauthn/start`,
        { mfaToken },
        { responseType: "text" },
      ),
    );
    const options = JSON.parse(optionsText);
    const asnResp = await startAuthentication({
      optionsJSON: options.publicKey,
    });
    const res = await firstValueFrom(
      this.http.post<{ token: string }>(
        `${this.base}/api/auth/mfa/webauthn/finish`,
        { mfaToken, credential: asnResp },
      ),
    );
    return res.token;
  }

  // ---- JWT helpers (read claims client-side; not for trust decisions) -----
  private decodeRole(token: string): string | null {
    const value = this.claim(token, "role");
    return typeof value === "string" ? value : null;
  }

  private decodeSubject(token: string): string | null {
    const value = this.claim(token, "sub");
    return typeof value === "string" ? value : null;
  }

  private hasValidToken(token: string | null): boolean {
    if (!token) return false;
    const expiry = this.decodeExpiry(token);
    if (expiry == null) return true;
    return Date.now() < expiry * 1000;
  }

  private decodeExpiry(token: string): number | null {
    const value = this.claim(token, "exp");
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private claim(token: string, name: string): unknown {
    try {
      // A JWT is header.payload.signature (base64url). Decode the middle segment's JSON to read
      // a claim (e.g. role/sub/exp). base64url → base64 (swap -/_ ) before atob. This is for UI
      // convenience only — the server re-verifies the signature; the client never trusts this.
      const payload = JSON.parse(
        atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
      );
      return payload[name] ?? null;
    } catch {
      return null;
    }
  }
}
