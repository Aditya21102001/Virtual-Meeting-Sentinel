import { Component, OnInit, signal } from '@angular/core';
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
