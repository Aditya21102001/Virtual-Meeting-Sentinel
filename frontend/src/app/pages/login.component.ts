import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="container" style="max-width:460px">
      <h1>{{ heading() }}</h1>

      <!-- ===== password login / register ===== -->
      @if (mode() === 'login' || mode() === 'register') {
        <div class="card">
          <label class="muted">Username
            <input [ngModel]="username()" (ngModelChange)="username.set($event)" autocomplete="username" />
          </label>
          @if (mode() === 'register') {
            <div class="hint">3–40 characters</div>
            <label class="muted" style="display:block;margin-top:10px">Email
              <input type="email" [ngModel]="email()" (ngModelChange)="email.set($event)"
                     placeholder="you@example.com" autocomplete="email" />
            </label>
            <div class="hint">Used for email one-time-code sign-in</div>
            <label class="muted" style="display:block;margin-top:10px">Mobile number
              <input type="tel" [ngModel]="phone()" (ngModelChange)="phone.set($event)"
                     placeholder="+91 90000 00000" autocomplete="tel" />
            </label>
            <div class="hint">Used for mobile one-time-code sign-in</div>
          }
          <label class="muted" style="display:block;margin-top:10px">Password
            <input type="password" [ngModel]="password()" (ngModelChange)="password.set($event)"
                   autocomplete="current-password" />
          </label>
          @if (mode() === 'register') { <div class="hint">At least 8 characters</div> }
          <div class="row" style="margin-top:14px">
            <button (click)="submit()" [disabled]="busy() || !username() || !password()">
              {{ busy() ? '…' : (mode() === 'register' ? 'Register' : 'Sign in') }}
            </button>
            <span style="flex:1"></span>
            <a class="muted" style="cursor:pointer" (click)="toggleMode()">
              {{ mode() === 'register' ? 'Have an account? Sign in' : 'New moderator? Register' }}
            </a>
          </div>

          <!--
            THE RECOVERY PATH, called by the name people look for.

            There is no password-reset flow, and there does not need to be: an email address is
            required at registration, and a one-time code to it signs you in without the password.
            What was missing was the signpost — somebody who has forgotten their password looks for
            "forgot password", not for "sign in with a one-time code", and never connects the two.

            So this is a label over a capability that already existed, not a new mechanism.
          -->
          @if (mode() === 'login') {
            <p class="hint" style="margin-top:12px">
              <a style="cursor:pointer" (click)="startOtp('email')">Forgot your password?</a>
              — sign in with a one-time code sent to your email instead.
            </p>
          }
        </div>

        <!-- alternative sign-in methods -->
        <div class="card">
          <p class="muted" style="margin-top:0">Or sign in with</p>
          @if (googleEnabled()) {
            <a [href]="googleUrl()"><button style="width:100%;margin-bottom:10px">🔵 Continue with Google</button></a>
          }
          <button (click)="startOtp('email')" style="width:100%;margin-bottom:10px">✉️ Email one-time code</button>
          <button (click)="startOtp('sms')" style="width:100%">📱 Mobile one-time code</button>
        </div>
      }

      <!-- ===== MFA second factor ===== -->
      @if (mode() === 'mfa') {
        <div class="card">
          <p class="muted">Second factor required. Choose a method:</p>
          @if (methods().includes('webauthn')) {
            <button (click)="usePasskey()" [disabled]="busy()" style="width:100%;margin-bottom:12px">
              🔐 Use passkey / biometric
            </button>
          }
          @if (methods().includes('totp') || methods().includes('pin')) {
            <label class="muted">{{ methods().includes('totp') ? 'Authenticator code (or PIN)' : 'PIN' }}
              <input [ngModel]="code()" (ngModelChange)="code.set($event)" inputmode="numeric" placeholder="123456" />
            </label>
            <div class="row" style="margin-top:12px">
              @if (methods().includes('totp')) { <button (click)="verify('totp')" [disabled]="busy() || !code()">Verify code</button> }
              @if (methods().includes('pin')) { <button (click)="verify('pin')" [disabled]="busy() || !code()">Verify PIN</button> }
            </div>
          }
        </div>
      }

      <!-- ===== OTP (email / mobile) passwordless login ===== -->
      @if (mode() === 'otp') {
        <div class="card">
          <p class="muted" style="margin-top:0">
            {{ otpChannel() === 'email' ? 'Sign in with an email code' : 'Sign in with a mobile code' }}
          </p>
          @if (!otpSent()) {
            <label class="muted">{{ otpChannel() === 'email' ? 'Email address' : 'Mobile number' }}
              <input [ngModel]="otpDest()" (ngModelChange)="otpDest.set($event)"
                     [type]="otpChannel() === 'email' ? 'email' : 'tel'"
                     [placeholder]="otpChannel() === 'email' ? 'you@example.com' : '+91 90000 00000'" />
            </label>
            <button (click)="sendOtp()" [disabled]="busy() || !otpDest()" style="margin-top:12px">Send code</button>
          } @else {
            <p class="muted">We sent a 6-digit code to <strong>{{ otpDest() }}</strong>.</p>
            @if (demoCode()) {
              <div class="hint">Demo mode (no real {{ otpChannel() === 'email' ? 'email' : 'SMS' }} sent): your code is
                <strong style="color:var(--accent)">{{ demoCode() }}</strong></div>
            }
            <label class="muted" style="display:block;margin-top:8px">Enter code
              <input [ngModel]="code()" (ngModelChange)="code.set($event)" inputmode="numeric" placeholder="123456" />
            </label>
            <div class="row" style="margin-top:12px">
              <button (click)="verifyOtp()" [disabled]="busy() || !code()">Verify & sign in</button>
              <a class="muted" style="cursor:pointer" (click)="otpSent.set(false)">Change {{ otpChannel() === 'email' ? 'email' : 'number' }}</a>
            </div>
          }
        </div>
      }

      <!-- ===== set a password, after signing in with a code ===== -->
      @if (mode() === 'setpwd') {
        <div class="card">
          <p class="muted" style="margin-top:0">
            You are signed in@if (signedInAs()) { as <strong>{{ signedInAs() }}</strong>}. Most
            people arrive here because they forgot their password — set a new one now and you can
            use it next time.
          </p>
          @if (signedInAs()) {
            <!--
              Naming the username is the point of this line, not decoration. A code is sent to an
              EMAIL address and finds the account that owns it; sign-in is by USERNAME. For anyone
              who arrived through Google those differ — the username was generated from their
              display name — so they would set a password here and then be told "invalid username
              or password" while typing something the account was never keyed by.
            -->
            <p class="hint" style="margin-top:-4px">
              Sign in with the username <strong>{{ signedInAs() }}</strong> — or with your email
              address, which also works.
            </p>
          }
          <label class="muted" style="display:block">New password
            <input type="password" autocomplete="new-password"
                   [ngModel]="newPassword()" (ngModelChange)="newPassword.set($event)"
                   (keyup.enter)="savePassword()" />
          </label>
          <div class="hint">At least 8 characters</div>
          <div class="row" style="margin-top:14px">
            <button (click)="savePassword()" [disabled]="newPassword().length < 8 || busy()">
              {{ busy() ? 'Saving…' : 'Set password & continue' }}
            </button>
            <span style="flex:1"></span>
            <!--
              Skippable on purpose. Somebody may have used a code for convenience rather than
              because they forgot anything, and blocking their way into a live meeting to insist on
              a password would be the application serving itself. The prompt is the useful part.
            -->
            <a class="muted" style="cursor:pointer" (click)="skipPassword()">Not now</a>
          </div>
        </div>
      }

      @if (mode() !== 'login' && mode() !== 'register' && mode() !== 'setpwd') {
        <a class="muted" style="cursor:pointer" (click)="backToLogin()">← Back to sign in</a>
      }
      @if (error()) { <p class="error-box">⚠️ {{ error() }}</p> }
    </div>
  `,
})
export class LoginComponent implements OnInit {
  readonly mode = signal<'login' | 'register' | 'mfa' | 'otp' | 'setpwd'>('login');
  readonly newPassword = signal('');
  /** The account the code signed us in to — shown so the user knows what to sign in with. */
  readonly signedInAs = signal('');
  readonly username = signal('');
  readonly email = signal('');
  readonly phone = signal('');
  readonly password = signal('');
  readonly code = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly methods = signal<string[]>([]);
  readonly googleEnabled = signal(false);
  // OTP state
  readonly otpChannel = signal<'email' | 'sms'>('email');
  readonly otpDest = signal('');
  readonly otpSent = signal(false);
  readonly demoCode = signal<string | null>(null);
  private mfaToken = '';

  constructor(private auth: AuthService, private router: Router, private route: ActivatedRoute) {}

  ngOnInit(): void {
    // Google OAuth redirect lands here with ?token=... — complete the session.
    const token = this.route.snapshot.queryParamMap.get('token');
    if (token) { this.auth.completeLogin(token); this.router.navigateByUrl(this.dest()); return; }

    // ...or with ?error=... when Google authenticated somebody we have no account for. That is an
    // ordinary outcome, not a fault, and the reason has to be shown here — the alternative is the
    // user being left on the backend's own error page, off-site, with no way back.
    const oauthError = this.route.snapshot.queryParamMap.get('error');
    if (oauthError) {
      this.error.set(oauthError);
      return;
    }
    // The auth interceptor redirects here with ?expired=1 when a stale/expired session is
    // rejected by the server — tell the user why they're back at the sign-in screen.
    if (this.route.snapshot.queryParamMap.get('expired')) {
      this.error.set(
        this.route.snapshot.queryParamMap.get('reason') === 'role'
          ? 'Your account no longer has moderator access. Sign in again to refresh your permissions.'
          : 'Your session expired. Please sign in again.',
      );
    }
    this.auth.config().subscribe({ next: (c) => this.googleEnabled.set(c.googleEnabled) });
  }

  heading(): string {
    switch (this.mode()) {
      case 'register': return 'Create moderator account';
      case 'mfa': return 'Verify it\'s you';
      case 'otp': return 'One-time code sign-in';
      case 'setpwd': return 'Set a new password';
      default: return 'Moderator sign in';
    }
  }

  googleUrl(): string { return this.auth.googleLoginUrl(); }

  toggleMode(): void { this.error.set(''); this.mode.set(this.mode() === 'register' ? 'login' : 'register'); }
  backToLogin(): void { this.error.set(''); this.otpSent.set(false); this.code.set(''); this.mode.set('login'); }

  submit(): void {
    this.busy.set(true); this.error.set('');
    const req = this.mode() === 'register'
      ? this.auth.register(this.username(), this.email(), this.phone(), this.password())
      : this.auth.login(this.username(), this.password());
    req.subscribe({
      next: (r) => {
        this.busy.set(false);
        if (r.status === 'AUTHENTICATED' && r.token) {
          this.auth.completeLogin(r.token);
          this.router.navigateByUrl(this.mode() === 'register' ? '/security' : this.dest());
        } else {
          this.mfaToken = r.mfaToken ?? '';
          this.methods.set(r.methods ?? []);
          this.mode.set('mfa');
        }
      },
      error: (e) => { this.busy.set(false); this.error.set(this.msg(e)); },
    });
  }

  verify(method: 'pin' | 'totp'): void {
    this.busy.set(true); this.error.set('');
    this.auth.verifyCode(this.mfaToken, method, this.code()).subscribe({
      next: (r) => { this.auth.completeLogin(r.token); this.router.navigateByUrl(this.dest()); },
      error: (e) => { this.busy.set(false); this.error.set(this.msg(e)); },
    });
  }

  async usePasskey(): Promise<void> {
    this.busy.set(true); this.error.set('');
    try {
      const token = await this.auth.loginPasskey(this.mfaToken);
      this.auth.completeLogin(token); this.router.navigateByUrl(this.dest());
    } catch { this.busy.set(false); this.error.set('Passkey login failed or cancelled.'); }
  }

  // ---- OTP ----
  startOtp(channel: 'email' | 'sms'): void {
    this.error.set(''); this.otpSent.set(false); this.otpDest.set(''); this.code.set('');
    this.demoCode.set(null); this.otpChannel.set(channel); this.mode.set('otp');
  }

  sendOtp(): void {
    this.busy.set(true); this.error.set('');
    this.auth.otpRequest(this.otpChannel(), this.otpDest()).subscribe({
      next: (r) => { this.busy.set(false); this.demoCode.set(r.demoCode); this.otpSent.set(true); },
      error: (e) => { this.busy.set(false); this.error.set(this.msg(e)); },
    });
  }

  verifyOtp(): void {
    this.busy.set(true); this.error.set('');
    this.auth.otpVerify(this.otpChannel(), this.otpDest(), this.code()).subscribe({
      next: (r) => {
        this.auth.completeLogin(r.token);
        this.busy.set(false);
        // Signed in — but offer a password before going on. Without this, somebody who forgot
        // their password signs in by code every time and never gets it back, which makes the code
        // a permanent workaround rather than a recovery.
        //
        // The token from this exchange is marked as verified-by-code, so setting a password needs
        // no old password and no second code. That window is short and the server enforces it.
        this.newPassword.set('');
        this.signedInAs.set(this.auth.username() ?? '');
        this.mode.set('setpwd');
      },
      error: (e) => { this.busy.set(false); this.error.set(this.msg(e)); },
    });
  }

  /** Set the new password, then go where the user was originally headed. */
  savePassword(): void {
    if (this.newPassword().length < 8) return;
    this.busy.set(true); this.error.set('');
    this.auth.changePassword({ newPassword: this.newPassword() }).subscribe({
      next: (r) => {
        this.busy.set(false);
        this.newPassword.set('');
        if (r.username) this.signedInAs.set(r.username);
        this.router.navigateByUrl(this.dest());
      },
      error: (e) => { this.busy.set(false); this.error.set(this.msg(e)); },
    });
  }

  /** Continue without setting one. They are already signed in; this only skips the offer. */
  skipPassword(): void {
    this.newPassword.set('');
    this.router.navigateByUrl(this.dest());
  }

  /** Where to land after login: shareholders → Lounge, moderators/admins → board. */
  /**
   * Where to go after a successful sign-in.
   *
   * <p>Prefers the `returnUrl` a guard attached when it intercepted the visit, so a shared link
   * survives the detour through this page. Falls back to the role's home.
   *
   * <p>Only app-relative paths are honoured. A `returnUrl` is attacker-controllable — it arrives in
   * a query string — so accepting `//evil.example` or `https://evil.example` would turn this into an
   * open redirect that borrows the site's credibility for a phishing page. A leading `//` is
   * protocol-relative and therefore off-site, which is why it is rejected alongside absolute URLs.
   */
  private dest(): string {
    const requested = this.route.snapshot.queryParamMap.get('returnUrl');
    if (requested && requested.startsWith('/') && !requested.startsWith('//')) {
      return requested;
    }
    // Land on a page this role can actually open. `/board` used to be the catch-all, so a session
    // that was neither moderator nor shareholder was sent straight into a guard and bounced back
    // here — a sign-in that visibly succeeds and then returns you to the login form.
    if (this.auth.isModerator()) return '/board';
    if (this.auth.isShareholder()) return '/chat';
    return '/ask';
  }

  private msg(e: any): string {
    return e?.error?.message || e?.error?.error || 'Something went wrong. Try again.';
  }
}
