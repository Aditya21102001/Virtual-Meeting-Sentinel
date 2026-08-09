import { Component, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService, MfaStatus, TotpInit } from '../services/auth.service';

@Component({
  selector: 'app-security',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="container" style="max-width:560px">
      <h1>Security & MFA</h1>
      <p class="muted">Signed in as <strong>{{ auth.username() }}</strong>. Enroll one or more
        second factors — they'll be required at your next sign-in.</p>

      @if (status(); as s) {
        <div class="card">
          <div class="q">Enrolled factors</div>
          <ul class="muted" style="margin:6px 0 0">
            <li>PIN: {{ s.pin ? '✅ set' : '— not set' }}</li>
            <li>Authenticator (OTP): {{ s.totp ? '✅ enabled' : '— not set' }}</li>
            <li>Passkey / biometric: {{ s.webauthn ? '✅ registered' : '— not set' }}</li>
          </ul>
        </div>
      }

      <!--
        Change or reset the password.

        Identity is re-proved here, not assumed from the session. Two ways, because the two users
        are different people: somebody who knows their password and wants a new one, and somebody
        who has forgotten it entirely. The second is the reason this section exists at all — without
        it, a user who forgets their password signs in by one-time code forever and never gets it
        back, which makes OTP a permanent workaround rather than a recovery.
      -->
      <div class="card">
        <div class="q">Password</div>

        <fieldset class="how">
          <legend class="muted" style="font-size:13px">How would you like to verify it is you?</legend>
          <label class="opt">
            <input type="radio" name="pwdmode" [checked]="pwdMode() === 'current'"
                   (change)="pwdMode.set('current')" />
            I know my current password
          </label>
          <label class="opt">
            <input type="radio" name="pwdmode" [checked]="pwdMode() === 'otp'"
                   (change)="pwdMode.set('otp')" />
            I have forgotten it — send a code to my email
          </label>
        </fieldset>

        @if (pwdMode() === 'current') {
          <label class="muted" style="display:block;margin-top:10px">Current password
            <input type="password" autocomplete="current-password"
                   [ngModel]="currentPassword()" (ngModelChange)="currentPassword.set($event)" />
          </label>
        } @else {
          <div class="row" style="margin-top:10px">
            <button class="ghost" (click)="sendResetCode()" [disabled]="pwdBusy()">
              {{ codeSent() ? 'Send another code' : 'Email me a code' }}
            </button>
            @if (codeSent()) {
              <span class="muted">Sent to the address on your account.</span>
            }
          </div>
          @if (codeSent()) {
            <label class="muted" style="display:block;margin-top:10px">Code from the email
              <input inputmode="numeric" autocomplete="one-time-code"
                     [ngModel]="resetCode()" (ngModelChange)="resetCode.set($event)" />
            </label>
          }
          @if (demoCode()) {
            <!-- Demo mode returns the code instead of emailing it. Shown so the flow is usable
                 without a mail provider — and labelled, because a code on screen is not a secret. -->
            <p class="hint">Demo mode — no email was sent. Your code is <strong>{{ demoCode() }}</strong>.</p>
          }
        }

        <label class="muted" style="display:block;margin-top:10px">New password
          <input type="password" autocomplete="new-password"
                 [ngModel]="newPassword()" (ngModelChange)="newPassword.set($event)" />
        </label>
        <div class="hint">At least 8 characters</div>

        <div class="row" style="margin-top:12px">
          <button (click)="changePassword()" [disabled]="!canChangePassword() || pwdBusy()">
            {{ pwdBusy() ? 'Saving…' : 'Set new password' }}
          </button>
        </div>

        @if (pwdMsg()) { <p class="muted" style="margin-top:8px">{{ pwdMsg() }}</p> }
        @if (pwdErr()) { <p class="error-box" style="margin-top:8px">{{ pwdErr() }}</p> }
      </div>

      <!-- PIN -->
      <div class="card">
        <div class="q">PIN</div>
        <div class="row" style="margin-top:8px">
          <input [ngModel]="pin()" (ngModelChange)="pin.set($event)" inputmode="numeric"
                 placeholder="4–8 digits" style="flex:1" />
          <button (click)="savePin()" [disabled]="busy() || pin().length < 4">Save PIN</button>
        </div>
      </div>

      <!-- TOTP -->
      <div class="card">
        <div class="q">Authenticator app (OTP)</div>
        @if (!totp()) {
          <button (click)="initTotp()" [disabled]="busy()" style="margin-top:8px">Set up authenticator</button>
        } @else {
          <p class="muted">Scan this QR in Google Authenticator / Authy, then enter the 6-digit code.</p>
          <img [src]="totp()!.qrDataUri" alt="TOTP QR" style="width:180px;height:180px;background:#fff;border-radius:8px" />
          <div class="row" style="margin-top:10px">
            <input [ngModel]="totpCode()" (ngModelChange)="totpCode.set($event)" inputmode="numeric"
                   placeholder="123456" style="flex:1" />
            <button (click)="enableTotp()" [disabled]="busy() || !totpCode()">Enable</button>
          </div>
        }
      </div>

      <!-- Passkey -->
      <div class="card">
        <div class="q">Passkey / biometric</div>
        <p class="muted">Register this device's Windows Hello / Touch ID / fingerprint.</p>
        <button (click)="addPasskey()" [disabled]="busy()">➕ Add passkey</button>
      </div>

      @if (msg()) { <p class="muted">{{ msg() }}</p> }
    </div>
  `,
})
export class SecurityComponent implements OnInit {
  // ---- password ------------------------------------------------------------
  //
  // Two verification paths because they serve two different people: somebody who knows their
  // password, and somebody who has forgotten it. The second is what turns OTP from a permanent
  // workaround into an actual recovery.

  readonly pwdMode = signal<'current' | 'otp'>('current');
  readonly currentPassword = signal('');
  readonly newPassword = signal('');
  readonly resetCode = signal('');
  readonly codeSent = signal(false);
  /** Only set while the server is in demo mode and returns the code instead of emailing it. */
  readonly demoCode = signal<string | null>(null);
  readonly pwdBusy = signal(false);
  readonly pwdMsg = signal('');
  readonly pwdErr = signal('');

  /** Enough to submit: a new password, plus whichever proof the chosen path needs. */
  readonly canChangePassword = computed(() => {
    if (this.newPassword().length < 8) return false;
    return this.pwdMode() === 'current'
      ? this.currentPassword().length > 0
      : this.resetCode().trim().length > 0;
  });

  /**
   * Send a code to the address on the account.
   *
   * <p>The destination is not asked for and not sent — the server uses what is registered. Letting
   * the page supply it would mean a signed-in session could reset any account whose email the user
   * happened to know.
   */
  sendResetCode(): void {
    this.pwdBusy.set(true);
    this.pwdErr.set('');
    // No address passed: the server sends to whatever is registered on this account.
    this.auth.requestResetCode().subscribe({
      next: (r) => {
        this.pwdBusy.set(false);
        this.codeSent.set(true);
        this.demoCode.set(r.demoCode ?? null);
        this.pwdMsg.set(r.sent ? 'Code sent — check your email.' : '');
      },
      error: (e) => {
        this.pwdBusy.set(false);
        this.pwdErr.set(e?.error?.message ?? 'Could not send a code. Try again shortly.');
      },
    });
  }

  changePassword(): void {
    this.pwdBusy.set(true);
    this.pwdErr.set('');
    this.pwdMsg.set('');
    this.auth
      .changePassword(
        this.pwdMode() === 'current'
          ? { currentPassword: this.currentPassword(), newPassword: this.newPassword() }
          : { otpChannel: 'email', otpCode: this.resetCode().trim(), newPassword: this.newPassword() },
      )
      .subscribe({
        next: (r) => {
          this.pwdBusy.set(false);
          // Cleared on success: leaving a password sitting in a field on a shared screen is the
          // kind of small carelessness this page exists to discourage.
          this.currentPassword.set('');
          this.newPassword.set('');
          this.resetCode.set('');
          this.codeSent.set(false);
          this.demoCode.set(null);
          // Name the account explicitly. "Password updated" alone is what let somebody set a
          // password on a Google-created account (username generated from their display name) and
          // then be told "invalid username or password" for it — the password was right, the
          // username was not the one they were typing.
          this.pwdMsg.set(
            `Password updated. Sign in with the username "${r.username}".`);
        },
        error: (e) => {
          this.pwdBusy.set(false);
          this.pwdErr.set(e?.error?.message ?? 'Could not change the password.');
        },
      });
  }

  readonly status = signal<MfaStatus | null>(null);
  readonly pin = signal('');
  readonly totp = signal<TotpInit | null>(null);
  readonly totpCode = signal('');
  readonly busy = signal(false);
  readonly msg = signal('');

  constructor(public auth: AuthService) {}

  ngOnInit(): void { this.refresh(); }

  private refresh(): void {
    this.auth.enrollStatus().subscribe({ next: (s) => this.status.set(s) });
  }

  savePin(): void {
    this.busy.set(true); this.msg.set('');
    this.auth.setPin(this.pin()).subscribe({
      next: (s) => { this.status.set(s); this.pin.set(''); this.busy.set(false); this.msg.set('✓ PIN saved.'); },
      error: () => { this.busy.set(false); this.msg.set('✗ PIN must be 4–8 digits.'); },
    });
  }

  initTotp(): void {
    this.busy.set(true); this.msg.set('');
    this.auth.totpInit().subscribe({
      next: (t) => { this.totp.set(t); this.busy.set(false); },
      error: () => { this.busy.set(false); this.msg.set('✗ Could not start authenticator setup.'); },
    });
  }

  enableTotp(): void {
    this.busy.set(true); this.msg.set('');
    this.auth.totpEnable(this.totpCode()).subscribe({
      next: (s) => { this.status.set(s); this.totp.set(null); this.totpCode.set(''); this.busy.set(false); this.msg.set('✓ Authenticator enabled.'); },
      error: () => { this.busy.set(false); this.msg.set('✗ Code did not match — try the current code.'); },
    });
  }

  async addPasskey(): Promise<void> {
    this.busy.set(true); this.msg.set('');
    try {
      await this.auth.enrollPasskey();
      this.msg.set('✓ Passkey registered.');
      this.refresh();
    } catch {
      this.msg.set('✗ Passkey registration failed or was cancelled.');
    } finally {
      this.busy.set(false);
    }
  }
}
