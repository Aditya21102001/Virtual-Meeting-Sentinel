import { HttpClient } from "@angular/common/http";
import { Injectable, computed, signal } from "@angular/core";
import { firstValueFrom, Observable } from "rxjs";
import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import { environment } from "../../environments/environment";
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

  constructor(
    private http: HttpClient,
    private api: ApiService,
  ) {
    if (this.token()) {
      this.api.setToken(this.token()!);
      if (!this.hasValidToken(this.token())) {
        this.logout();
      }
    }
  }

  // ---- session -----------------------------------------------------------
  completeLogin(token: string): void {
    const role = this.decodeRole(token) ?? "MODERATOR";
    const user = this.decodeSubject(token) ?? "";
    this.token.set(token);
    this.role.set(role);
    this.username.set(user);
    localStorage.setItem("agm_token", token);
    localStorage.setItem("agm_role", role);
    localStorage.setItem("agm_user", user);
    this.api.setToken(token);
  }

  logout(): void {
    this.token.set(null);
    this.role.set(null);
    this.username.set(null);
    localStorage.removeItem("agm_token");
    localStorage.removeItem("agm_role");
    localStorage.removeItem("agm_user");
    this.api.setToken("");
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
    return this.http.get<AuthConfig>(`${this.base}/api/auth/config`);
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
    return this.http.get<MfaStatus>(`${this.base}/api/auth/enroll/status`, {
      headers: this.authHeaders(),
    });
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
