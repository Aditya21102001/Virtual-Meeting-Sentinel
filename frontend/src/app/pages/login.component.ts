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

      @if (mode() !== 'login' && mode() !== 'register') {
        <a class="muted" style="cursor:pointer" (click)="backToLogin()">← Back to sign in</a>
      }
      @if (error()) { <p class="error-box">⚠️ {{ error() }}</p> }
    </div>
  `,
})
export class LoginComponent implements OnInit {
  readonly mode = signal<'login' | 'register' | 'mfa' | 'otp'>('login');
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
    if (token) { this.auth.completeLogin(token); this.router.navigate([this.dest()]); return; }
    // The auth interceptor redirects here with ?expired=1 when a stale/expired session is
    // rejected by the server — tell the user why they're back at the sign-in screen.
    if (this.route.snapshot.queryParamMap.get('expired')) {
      this.error.set('Your session expired. Please sign in again.');
    }
    this.auth.config().subscribe({ next: (c) => this.googleEnabled.set(c.googleEnabled) });
  }

  heading(): string {
    switch (this.mode()) {
      case 'register': return 'Create moderator account';
      case 'mfa': return 'Verify it\'s you';
      case 'otp': return 'One-time code sign-in';
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
          this.router.navigate([this.mode() === 'register' ? '/security' : this.dest()]);
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
      next: (r) => { this.auth.completeLogin(r.token); this.router.navigate([this.dest()]); },
      error: (e) => { this.busy.set(false); this.error.set(this.msg(e)); },
    });
  }

  async usePasskey(): Promise<void> {
    this.busy.set(true); this.error.set('');
    try {
      const token = await this.auth.loginPasskey(this.mfaToken);
      this.auth.completeLogin(token); this.router.navigate([this.dest()]);
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
      next: (r) => { this.auth.completeLogin(r.token); this.router.navigate([this.dest()]); },
      error: (e) => { this.busy.set(false); this.error.set(this.msg(e)); },
    });
  }

  /** Where to land after login: shareholders → Lounge, moderators/admins → board. */
  private dest(): string { return this.auth.isShareholder() ? '/chat' : '/board'; }

  private msg(e: any): string {
    return e?.error?.message || e?.error?.error || 'Something went wrong. Try again.';
  }
}
