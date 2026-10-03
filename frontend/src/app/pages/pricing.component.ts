import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NavigationHistoryService } from '../services/navigation-history.service';

interface PricingTier {
  id: string;
  name: string;
  badge?: string;
  tagline: string;
  eventPrice: number;
  annualMonthlyPrice: number;
  highlight?: boolean;
  features: string[];
  ctaLabel: string;
}

@Component({
  selector: 'app-pricing',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="pricing-page">
      <!-- Back Link -->
      <div class="back-nav">
        <button type="button" class="back-link" (click)="navHistory.back('/welcome')">
          ← Back to Overview
        </button>
      </div>

      <!-- Header Section -->
      <header class="pricing-header">
        <div class="hero-badge">
          <span>Enterprise SaaS &amp; Event Licensing</span>
        </div>
        <h1 class="pricing-title">
          Transparent Pricing for <span class="gradient-text">Flawless Meeting Governance</span>
        </h1>
        <p class="pricing-subtitle">
          Whether you host an annual shareholder meeting once a year or conduct quarterly investor town halls,
          Sentinel eliminates repetitive question floods, ensures legal grounding, and guarantees certified voting quorum.
        </p>

        <!-- Billing Cycle Switcher -->
        <div class="billing-toggle" role="group" aria-label="Billing cycle selector">
          <button
            type="button"
            class="toggle-btn"
            [class.active]="billingCycle() === 'event'"
            (click)="billingCycle.set('event')"
          >
            Single Event Pass
          </button>
          <button
            type="button"
            class="toggle-btn"
            [class.active]="billingCycle() === 'annual'"
            (click)="billingCycle.set('annual')"
          >
            Annual Subscription <span class="discount-pill">Save 20%</span>
          </button>
        </div>
      </header>

      <!-- Pricing Cards Grid -->
      <section class="tiers-grid" aria-label="Pricing plans">
        @for (tier of tiers; track tier.id) {
          <article class="tier-card card" [class.highlight]="tier.highlight">
            @if (tier.badge) {
              <div class="tier-badge">{{ tier.badge }}</div>
            }
            <div class="tier-header">
              <h2 class="tier-name">{{ tier.name }}</h2>
              <p class="tier-tagline">{{ tier.tagline }}</p>
            </div>

            <div class="tier-price-box">
              <div class="price-row">
                <span class="currency">$</span>
                <span class="amount">
                  {{ billingCycle() === 'event' ? tier.eventPrice : tier.annualMonthlyPrice }}
                </span>
                <span class="period">
                  {{ billingCycle() === 'event' ? '/ event' : '/ mo billed annually' }}
                </span>
              </div>
              <p class="price-note">
                {{ billingCycle() === 'event' ? 'Single live AGM or town hall' : 'Up to 12 scheduled meetings / year' }}
              </p>
            </div>

            <div class="tier-divider"></div>

            <ul class="features-list">
              @for (feat of tier.features; track feat) {
                <li class="feature-item">
                  <span class="check-icon" aria-hidden="true">✓</span>
                  <span>{{ feat }}</span>
                </li>
              }
            </ul>

            <button
              type="button"
              class="tier-cta"
              [class.primary]="tier.highlight"
              [class.secondary]="!tier.highlight"
              (click)="selectTier(tier)"
            >
              {{ tier.ctaLabel }}
            </button>
          </article>
        }
      </section>

      <!-- ROI Calculator Section -->
      <section class="roi-section card" aria-labelledby="roi-heading">
        <div class="roi-header">
          <div class="badge-mini">Business Case Calculator</div>
          <h2 id="roi-heading">Calculate Your Meeting ROI &amp; Time Saved</h2>
          <p class="muted">
            See how much your organization saves in legal counsel time, moderator fatigue, and post-meeting documentation.
          </p>
        </div>

        <div class="roi-calculator-layout">
          <!-- Controls -->
          <div class="roi-controls">
            <div class="control-group">
              <div class="control-header">
                <label for="attendees-slider">Expected Shareholders / Attendees</label>
                <span class="control-val">{{ attendees() }} attendees</span>
              </div>
              <input
                id="attendees-slider"
                type="range"
                min="100"
                max="5000"
                step="100"
                [ngModel]="attendees()"
                (ngModelChange)="attendees.set($event)"
              />
            </div>

            <div class="control-group">
              <div class="control-header">
                <label for="question-rate-slider">Estimated Questions Asked (% of attendees)</label>
                <span class="control-val">{{ questionRate() }}% ({{ estimatedRawQuestions() }} questions)</span>
              </div>
              <input
                id="question-rate-slider"
                type="range"
                min="5"
                max="50"
                step="5"
                [ngModel]="questionRate()"
                (ngModelChange)="questionRate.set($event)"
              />
            </div>

            <div class="control-group">
              <div class="control-header">
                <label for="hourly-cost-slider">Counsel &amp; Moderation Hourly Cost ($/hr)</label>
                <span class="control-val">\${{ hourlyRate() }} / hr</span>
              </div>
              <input
                id="hourly-cost-slider"
                type="range"
                min="100"
                max="500"
                step="25"
                [ngModel]="hourlyRate()"
                (ngModelChange)="hourlyRate.set($event)"
              />
            </div>
          </div>

          <!-- Results Summary -->
          <div class="roi-results-box">
            <h3 class="results-title">Projected Meeting Impact</h3>

            <div class="metrics-grid">
              <div class="metric-card">
                <span class="metric-num">{{ deduplicationSavingsPercent() }}%</span>
                <span class="metric-label">Repetitive Noise Eliminated</span>
                <small class="metric-sub">{{ estimatedRawQuestions() }} questions → {{ estimatedDistinctTopics() }} consolidated topics</small>
              </div>

              <div class="metric-card">
                <span class="metric-num">{{ hoursSaved() }} hrs</span>
                <span class="metric-label">Executive &amp; Legal Hours Saved</span>
                <small class="metric-sub">Live answering + post-meeting minutes compilation</small>
              </div>

              <div class="metric-card highlight">
                <span class="metric-num">\${{ netSavingsFormatted() }}</span>
                <span class="metric-label">Net Financial Savings</span>
                <small class="metric-sub">After factoring Corporate Pass cost</small>
              </div>

              <div class="metric-card">
                <span class="metric-num">Zero</span>
                <span class="metric-label">Compliance Citation Risks</span>
                <small class="metric-sub">RAG grounding ensures answers cite official filings</small>
              </div>
            </div>

            <div class="roi-cta-wrap">
              <button type="button" class="action-btn" (click)="openBookingModal('Growth Corporate')">
                Lock In This ROI — Schedule Demo
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- Enterprise Compliance & Security Guarantees -->
      <section class="trust-section" aria-labelledby="trust-heading">
        <h2 id="trust-heading" class="trust-title">Built for Stringent Regulatory Standards</h2>
        <div class="trust-grid">
          <div class="trust-card card">
            <span class="trust-icon">⚖️</span>
            <h4>Statutory Quorum &amp; Weighted Ballots</h4>
            <p>
              Integer-precision majority verification (Ordinary >50%, Special ≥75%). Tamper-resistant voting records with immutable audit log.
            </p>
          </div>

          <div class="trust-card card">
            <span class="trust-icon">🔒</span>
            <h4>FIDO2 / WebAuthn Biometric Security</h4>
            <p>
              Hardware-backed authentication (Windows Hello, TouchID, YubiKey). Private keys never leave the attendee's secure enclave.
            </p>
          </div>

          <div class="trust-card card">
            <span class="trust-icon">📄</span>
            <h4>Verifiable RAG Grounding</h4>
            <p>
              Draft answers are strictly bounded by SEC/MCA company disclosures. Every answer includes verifiable page and paragraph citations.
            </p>
          </div>

          <div class="trust-card card">
            <span class="trust-icon">🌐</span>
            <h4>Self-Hosted or 100% Free Cloud</h4>
            <p>
              Deployable on corporate air-gapped clouds via Docker or zero-cost cloud tiers (Render, Vercel, Neon, HF Spaces) with no vendor lock-in.
            </p>
          </div>
        </div>
      </section>

      <!-- Booking / Demo Modal -->
      @if (bookingPlan(); as plan) {
        <div class="modal-backdrop" (click)="closeBookingModal()">
          <div class="modal-dialog card" (click)="$event.stopPropagation()" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <div class="modal-header">
              <h3 id="modal-title">Schedule Enterprise Meeting — {{ plan }}</h3>
              <button type="button" class="close-btn" (click)="closeBookingModal()" aria-label="Close dialog">✕</button>
            </div>

            <div class="modal-body">
              <p class="muted">
                Experience Sentinel customized for your upcoming AGM or investor town hall. We'll set up your private tenant,
                pre-index your annual report, and run a full rehearsal.
              </p>

              <form (submit)="submitBooking($event)" class="booking-form">
                <label class="form-field">
                  <span class="label">Organization / Company Name</span>
                  <input type="text" [(ngModel)]="bookingCompany" name="company" placeholder="e.g. Apex Global Corp" required />
                </label>

                <label class="form-field">
                  <span class="label">Work Email</span>
                  <input type="email" [(ngModel)]="bookingEmail" name="email" placeholder="corporate.secretary@apex.com" required />
                </label>

                <div class="form-row">
                  <label class="form-field">
                    <span class="label">Estimated Event Date</span>
                    <input type="date" [(ngModel)]="bookingDate" name="date" />
                  </label>
                  <label class="form-field">
                    <span class="label">Estimated Attendees</span>
                    <select [(ngModel)]="bookingAttendees" name="attendees">
                      <option value="500">Up to 500</option>
                      <option value="1500">500 – 2,000</option>
                      <option value="5000">2,000 – 10,000</option>
                      <option value="10000">10,000+</option>
                    </select>
                  </label>
                </div>

                @if (bookingSubmitted()) {
                  <div class="success-banner" role="status">
                    <span>✓</span>
                    <div>
                      <strong>Demo Request Confirmed!</strong>
                      <p>Our corporate governance specialist will reach out to {{ bookingEmail }} within 2 business hours.</p>
                    </div>
                  </div>
                } @else {
                  <div class="modal-actions">
                    <button type="submit" class="submit-booking-btn">Confirm Demo &amp; Event Booking</button>
                    <button type="button" class="ghost-btn" (click)="closeBookingModal()">Cancel</button>
                  </div>
                }
              </form>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .pricing-page {
        max-width: 1140px;
        margin: 0 auto;
        padding: 24px 20px 80px;
      }

      .back-nav {
        margin-bottom: 24px;
      }

      .back-link {
        background: none;
        border: none;
        color: var(--muted);
        font-size: 14px;
        cursor: pointer;
        padding: 0;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        transition: color 0.15s;
      }

      .back-link:hover {
        color: var(--text);
      }

      /* Header */
      .pricing-header {
        text-align: center;
        max-width: 820px;
        margin: 0 auto 48px;
      }

      .hero-badge {
        display: inline-flex;
        align-items: center;
        padding: 6px 16px;
        border-radius: 999px;
        background: rgba(56, 189, 248, 0.1);
        border: 1px solid rgba(56, 189, 248, 0.25);
        color: var(--accent);
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 20px;
      }

      .pricing-title {
        font-size: 38px;
        line-height: 1.18;
        font-weight: 800;
        margin: 0 0 16px;
        letter-spacing: -0.02em;
      }

      .gradient-text {
        background: linear-gradient(135deg, #38bdf8 0%, #818cf8 50%, #c084fc 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      .pricing-subtitle {
        font-size: 17px;
        line-height: 1.6;
        color: var(--muted);
        margin: 0 auto 32px;
      }

      /* Billing Switcher */
      .billing-toggle {
        display: inline-flex;
        align-items: center;
        padding: 4px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 999px;
      }

      .toggle-btn {
        padding: 8px 20px;
        border-radius: 999px;
        border: none;
        background: none;
        color: var(--muted);
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }

      .toggle-btn.active {
        background: var(--surface-hover);
        color: var(--text);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      }

      .discount-pill {
        background: rgba(16, 185, 129, 0.15);
        border: 1px solid rgba(16, 185, 129, 0.3);
        color: #10b981;
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 999px;
      }

      /* Tiers Grid */
      .tiers-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
        gap: 24px;
        margin-bottom: 64px;
      }

      .tier-card {
        display: flex;
        flex-direction: column;
        padding: 32px 24px;
        position: relative;
        border-radius: 16px;
        background: var(--surface);
        border: 1px solid var(--border);
        transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
      }

      .tier-card:hover {
        transform: translateY(-4px);
        border-color: rgba(56, 189, 248, 0.4);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
      }

      .tier-card.highlight {
        border-color: var(--accent);
        background: linear-gradient(180deg, rgba(56, 189, 248, 0.05) 0%, var(--surface) 100%);
        box-shadow: 0 0 24px rgba(56, 189, 248, 0.15);
      }

      .tier-badge {
        position: absolute;
        top: -12px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--accent);
        color: #0b0f19;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        padding: 4px 14px;
        border-radius: 999px;
        letter-spacing: 0.05em;
      }

      .tier-header {
        margin-bottom: 20px;
      }

      .tier-name {
        font-size: 22px;
        font-weight: 700;
        margin: 0 0 6px;
      }

      .tier-tagline {
        font-size: 14px;
        color: var(--muted);
        margin: 0;
        min-height: 40px;
      }

      .tier-price-box {
        margin-bottom: 24px;
      }

      .price-row {
        display: flex;
        align-items: baseline;
        gap: 4px;
      }

      .currency {
        font-size: 24px;
        font-weight: 700;
        color: var(--text);
      }

      .amount {
        font-size: 44px;
        font-weight: 800;
        color: var(--text);
        line-height: 1;
      }

      .period {
        font-size: 14px;
        color: var(--muted);
      }

      .price-note {
        font-size: 12px;
        color: var(--muted);
        margin: 6px 0 0;
      }

      .tier-divider {
        height: 1px;
        background: var(--border);
        margin-bottom: 24px;
      }

      .features-list {
        list-style: none;
        padding: 0;
        margin: 0 0 32px;
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .feature-item {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        font-size: 14px;
        line-height: 1.4;
      }

      .check-icon {
        color: #10b981;
        font-weight: bold;
        flex-shrink: 0;
      }

      .tier-cta {
        width: 100%;
        padding: 14px;
        border-radius: 10px;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
        border: 1px solid transparent;
      }

      .tier-cta.primary {
        background: var(--accent);
        color: #0b0f19;
      }

      .tier-cta.primary:hover {
        opacity: 0.92;
        transform: translateY(-1px);
      }

      .tier-cta.secondary {
        background: var(--surface-hover);
        color: var(--text);
        border-color: var(--border);
      }

      .tier-cta.secondary:hover {
        border-color: var(--accent);
        color: var(--accent);
      }

      /* ROI Calculator */
      .roi-section {
        padding: 36px 32px;
        margin-bottom: 64px;
        border-radius: 16px;
      }

      .roi-header {
        text-align: center;
        max-width: 680px;
        margin: 0 auto 36px;
      }

      .badge-mini {
        display: inline-block;
        font-size: 12px;
        font-weight: 700;
        color: #818cf8;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 8px;
      }

      .roi-header h2 {
        font-size: 28px;
        margin: 0 0 8px;
      }

      .roi-calculator-layout {
        display: grid;
        grid-template-columns: 1fr 1.2fr;
        gap: 36px;
        align-items: center;
      }

      @media (max-width: 860px) {
        .roi-calculator-layout {
          grid-template-columns: 1fr;
        }
      }

      .roi-controls {
        display: flex;
        flex-direction: column;
        gap: 24px;
      }

      .control-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .control-header {
        display: flex;
        justify-content: space-between;
        font-size: 14px;
        font-weight: 600;
      }

      .control-val {
        color: var(--accent);
        font-weight: 700;
      }

      input[type='range'] {
        width: 100%;
        accent-color: var(--accent);
        cursor: pointer;
      }

      /* Results */
      .roi-results-box {
        background: rgba(0, 0, 0, 0.2);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 24px;
      }

      .results-title {
        font-size: 18px;
        margin: 0 0 20px;
        font-weight: 700;
      }

      .metrics-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
        margin-bottom: 24px;
      }

      .metric-card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .metric-card.highlight {
        border-color: #10b981;
        background: rgba(16, 185, 129, 0.08);
      }

      .metric-num {
        font-size: 26px;
        font-weight: 800;
        color: var(--text);
      }

      .metric-card.highlight .metric-num {
        color: #10b981;
      }

      .metric-label {
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
      }

      .metric-sub {
        font-size: 11px;
        color: var(--muted);
        line-height: 1.3;
      }

      .roi-cta-wrap {
        text-align: center;
      }

      .action-btn {
        width: 100%;
        padding: 14px 20px;
        background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%);
        border: none;
        border-radius: 10px;
        color: #0b0f19;
        font-size: 15px;
        font-weight: 700;
        cursor: pointer;
        transition: opacity 0.15s, transform 0.15s;
      }

      .action-btn:hover {
        opacity: 0.92;
        transform: translateY(-1px);
      }

      /* Trust Section */
      .trust-section {
        margin-top: 48px;
      }

      .trust-title {
        text-align: center;
        font-size: 24px;
        margin-bottom: 28px;
      }

      .trust-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 20px;
      }

      .trust-card {
        padding: 24px;
        border-radius: 12px;
      }

      .trust-icon {
        font-size: 28px;
        margin-bottom: 12px;
        display: inline-block;
      }

      .trust-card h4 {
        margin: 0 0 8px;
        font-size: 16px;
      }

      .trust-card p {
        font-size: 13px;
        color: var(--muted);
        margin: 0;
        line-height: 1.5;
      }

      /* Modal */
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.75);
        backdrop-filter: blur(4px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        padding: 20px;
      }

      .modal-dialog {
        width: 100%;
        max-width: 520px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 28px;
        box-shadow: 0 20px 48px rgba(0, 0, 0, 0.5);
      }

      .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 16px;
      }

      .modal-header h3 {
        margin: 0;
        font-size: 20px;
      }

      .close-btn {
        background: none;
        border: none;
        color: var(--muted);
        font-size: 18px;
        cursor: pointer;
      }

      .booking-form {
        display: flex;
        flex-direction: column;
        gap: 16px;
        margin-top: 16px;
      }

      .form-field {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .form-field .label {
        font-size: 13px;
        font-weight: 600;
      }

      .form-field input,
      .form-field select {
        padding: 10px 12px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--text);
        font-size: 14px;
      }

      .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }

      .modal-actions {
        display: flex;
        gap: 12px;
        margin-top: 12px;
      }

      .submit-booking-btn {
        flex: 1;
        padding: 12px;
        background: var(--accent);
        border: none;
        border-radius: 8px;
        color: #0b0f19;
        font-weight: 700;
        cursor: pointer;
      }

      .ghost-btn {
        padding: 12px 18px;
        background: none;
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--text);
        cursor: pointer;
      }

      .success-banner {
        display: flex;
        gap: 12px;
        padding: 16px;
        border-radius: 8px;
        background: rgba(16, 185, 129, 0.15);
        border: 1px solid #10b981;
        color: #10b981;
        margin-top: 12px;
      }
    `,
  ],
})
export class PricingComponent {
  readonly navHistory = inject(NavigationHistoryService);

  readonly billingCycle = signal<'event' | 'annual'>('event');

  // ROI Calculator Signals
  readonly attendees = signal<number>(800);
  readonly questionRate = signal<number>(20); // 20%
  readonly hourlyRate = signal<number>(250); // $250/hr for legal & sec counsel

  // Estimated metrics
  readonly estimatedRawQuestions = computed(() =>
    Math.round((this.attendees() * this.questionRate()) / 100),
  );

  // In live AGMs, typically 65-75% questions are duplicates
  readonly deduplicationSavingsPercent = signal<number>(72);

  readonly estimatedDistinctTopics = computed(() => {
    const raw = this.estimatedRawQuestions();
    const distinct = Math.max(3, Math.round(raw * (1 - this.deduplicationSavingsPercent() / 100)));
    return distinct;
  });

  // Hours saved in live meeting + post-meeting legal minutes compilation
  readonly hoursSaved = computed(() => {
    const raw = this.estimatedRawQuestions();
    const distinct = this.estimatedDistinctTopics();
    // Handling raw questions takes ~3 mins each without AI vs 1 min for distinct topics with AI
    const manualMinutes = raw * 3.5 + 180; // plus 3 hours minutes drafting
    const aiMinutes = distinct * 2 + 30; // plus 30 mins minutes review
    return Math.max(2, Math.round((manualMinutes - aiMinutes) / 60));
  });

  // Dollar savings
  readonly netSavingsFormatted = computed(() => {
    const grossSaved = this.hoursSaved() * this.hourlyRate();
    const toolCost = this.billingCycle() === 'event' ? 1499 : 999;
    const net = Math.max(0, grossSaved - toolCost);
    return net.toLocaleString();
  });

  // Booking Modal State
  readonly bookingPlan = signal<string | null>(null);
  readonly bookingSubmitted = signal<boolean>(false);
  bookingCompany = '';
  bookingEmail = '';
  bookingDate = '';
  bookingAttendees = '1500';

  readonly tiers: PricingTier[] = [
    {
      id: 'starter',
      name: 'Event Starter',
      tagline: 'Ideal for non-profits, small cooperatives, and municipal meetings.',
      eventPrice: 499,
      annualMonthlyPrice: 399,
      features: [
        'Up to 500 concurrent attendees',
        'Real-time semantic question deduplication',
        'Live upvoting and priority ranking',
        'Ordinary & Special resolution voting',
        'Quorum threshold tracker',
        'Exportable minutes (.md)',
        'Community email support',
      ],
      ctaLabel: 'Choose Starter',
    },
    {
      id: 'growth',
      name: 'Growth Corporate',
      badge: 'Most Popular',
      tagline: 'Full intelligence for public companies, annual general meetings, and investor town halls.',
      eventPrice: 1499,
      annualMonthlyPrice: 999,
      highlight: true,
      features: [
        'Up to 5,000 concurrent attendees',
        'RAG AI answer drafting over Annual Reports (10-K)',
        'Clickable PDF citation links (page & paragraph)',
        'Live Moderator Board with Cluster Curation (Merge/Split)',
        'Adaptive HLS Video Recording & WebVTT Captions',
        'Shareholder Lounge (Direct chat + RAG AI Assistant)',
        'Passkeys & WebAuthn / FIDO2 biometric authentication',
        'Priority technical support & dry-run rehearsal',
      ],
      ctaLabel: 'Get Corporate Pass',
    },
    {
      id: 'enterprise',
      name: 'Enterprise Governance',
      tagline: 'Custom infrastructure and white-glove governance for large-cap enterprises.',
      eventPrice: 4999,
      annualMonthlyPrice: 2999,
      features: [
        'Unlimited concurrent attendees & shareholders',
        'Dedicated isolated AI vector database tenant',
        'Official Scrutineer Compliance Audit Certificate (SHA-256)',
        'Real-time Sentiment & Crisis Urgency Radar',
        'White-label corporate branding & custom domain',
        'Dedicated Virtual Meeting Master on live call standby',
        'Post-meeting executive intelligence summary pack',
        'Guaranteed 99.99% SLA & SOC2 compliance pack',
      ],
      ctaLabel: 'Contact Enterprise Team',
    },
  ];

  selectTier(tier: PricingTier) {
    this.openBookingModal(tier.name);
  }

  openBookingModal(planName: string) {
    this.bookingPlan.set(planName);
    this.bookingSubmitted.set(false);
  }

  closeBookingModal() {
    this.bookingPlan.set(null);
    this.bookingSubmitted.set(false);
  }

  submitBooking(event: Event) {
    event.preventDefault();
    if (!this.bookingCompany.trim() || !this.bookingEmail.trim()) return;
    this.bookingSubmitted.set(true);
  }
}
