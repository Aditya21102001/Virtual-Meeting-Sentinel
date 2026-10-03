import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { DemoMeetingService } from '../services/demo-meeting.service';
import { WarmupService } from '../services/warmup.service';

interface DemoCluster {
  id: string;
  topic: string;
  representative: string;
  count: number;
  similarity: number;
  status: 'answering' | 'queued' | 'new';
  questions: string[];
}

@Component({
  selector: 'app-welcome',
  standalone: true,
  imports: [RouterLink, FormsModule],
  template: `
    <div class="welcome-page">
      <!-- ===== HERO SECTION ===== -->
      <header class="hero-section">
        <div class="hero-badge">
          <span class="pulse-indicator" [class.ready]="warmup.phase() === 'ready'"></span>
          <span>
            @if (warmup.phase() === 'ready') {
              Cloud Engine Primed &amp; Ready ({{ warmup.pingMs() }}ms)
            } @else if (warmup.phase() === 'warming') {
              Waking Cloud Engine behind the scenes ({{ warmup.elapsedSec() }}s)…
            } @else {
              Enterprise Shareholder Meeting Intelligence
            }
          </span>
        </div>

        <h1 class="hero-title">
          Intelligent Governance for
          <span class="gradient-text">Virtual Shareholder Meetings</span>
        </h1>

        <p class="hero-subtitle">
          Virtual Meeting Sentinel empowers AGM chairs, corporate secretaries, and attendees.
          High-throughput semantic AI consolidates repetitive shareholder questions in real time,
          synthesizes verifiable answers from company filings, and coordinates weighted voting.
        </p>

        <!-- Quick Action CTAs for Visitors & Evaluators -->
        <div class="hero-cta-group">
          <button type="button" class="cta-button demo-highlight" (click)="demoMeeting.launchDemoMeeting('/board')">
            <span class="icon">🚀</span>
            <div class="cta-text">
              <strong>Launch Interactive Demo AGM</strong>
              <small>Pre-seeded Apex AGM with real votes &amp; topics</small>
            </div>
            <span class="arrow">→</span>
          </button>

          <a routerLink="/ask" class="cta-button primary">
            <span class="icon">💬</span>
            <div class="cta-text">
              <strong>Ask a Question</strong>
              <small>Live attendee Q&amp;A • No sign-in needed</small>
            </div>
            <span class="arrow">→</span>
          </a>

          <a routerLink="/pricing" class="cta-button secondary">
            <span class="icon">💎</span>
            <div class="cta-text">
              <strong>Plans &amp; ROI Calculator</strong>
              <small>Event licensing &amp; cost savings analysis</small>
            </div>
            <span class="arrow">→</span>
          </a>

          <a routerLink="/login" class="cta-button secondary">
            <span class="icon">🔐</span>
            <div class="cta-text">
              <strong>Member Portal</strong>
              <small>Passkeys, WebAuthn &amp; Admin login</small>
            </div>
            <span class="arrow">→</span>
          </a>
        </div>
      </header>

      <!-- ===== LIVE ENGINE STATUS NOTICE ===== -->
      <section class="engine-status-card" [class.ready]="warmup.phase() === 'ready'" aria-label="Backend Status">
        <div class="status-icon" aria-hidden="true">
          {{ warmup.phase() === 'ready' ? '⚡' : '⏳' }}
        </div>
        <div class="status-content">
          <div class="status-header">
            <strong>
              @if (warmup.phase() === 'ready') {
                Render Cloud Engine is Online &amp; Warm
              } @else {
                Automatic Background Warm-Up in Progress
              }
            </strong>
            <span class="latency-pill" [class.ready]="warmup.phase() === 'ready'">
              {{ warmup.phase() === 'ready' ? (warmup.pingMs() + ' ms latency') : (warmup.elapsedSec() + 's elapsed') }}
            </span>
          </div>
          <p class="status-description">
            @if (warmup.phase() === 'ready') {
              The backend container and AI microservice have completed startup. Any question you submit or portal you sign into will respond with zero cold-start delay.
            } @else {
              To stay free, the backend on Render sleeps when idle. We proactively dispatched a background wake-up ping the moment you opened this page — explore below while it spins up!
            }
          </p>
        </div>
        <button type="button" class="ping-btn" (click)="warmup.retryNow()" [disabled]="warmup.phase() === 'warming'">
          {{ warmup.phase() === 'ready' ? 'Re-check Ping' : 'Warming up…' }}
        </button>
      </section>

      <!-- ===== INTERACTIVE DEMO: REAL-TIME DEDUPLICATION ===== -->
      <section class="demo-section" aria-labelledby="demo-heading">
        <div class="section-header">
          <span class="section-tag">Interactive Preview</span>
          <h2 id="demo-heading">Experience Real-Time Semantic Deduplication</h2>
          <p class="section-intro">
            During an AGM with hundreds of attendees, over 60% of questions ask the same thing in different words.
            Try submitting or clicking sample questions below to see how Sentinel's AI clusters near-duplicates instantly:
          </p>
        </div>

        <div class="demo-container">
          <!-- Interactive Input Simulator -->
          <div class="demo-box card">
            <label for="demo-input" class="demo-label">Type a shareholder question or pick an example:</label>
            <div class="demo-input-row">
              <input
                id="demo-input"
                type="text"
                [ngModel]="demoText()"
                (ngModelChange)="demoText.set($event)"
                (keyup.enter)="simulateSubmit()"
                placeholder="e.g. When will this year's dividend be paid out?"
              />
              <button type="button" class="simulate-btn" (click)="simulateSubmit()" [disabled]="!demoText().trim()">
                Simulate Ingest
              </button>
            </div>

            <!-- Sample Chips -->
            <div class="sample-chips" aria-label="Sample questions">
              <span class="chips-label">Try clicking:</span>
              @for (sample of sampleQuestions; track sample.text) {
                <button type="button" class="chip" (click)="pickSample(sample.text)">
                  {{ sample.text }}
                </button>
              }
            </div>

            @if (lastFeedback(); as fb) {
              <div class="feedback-banner" [class.merged]="fb.isMerged">
                <span class="fb-icon">{{ fb.isMerged ? '🔄' : '✨' }}</span>
                <div>
                  <strong>{{ fb.title }}</strong>
                  <p>{{ fb.message }}</p>
                </div>
              </div>
            }
          </div>

          <!-- Live Clustered Topics Board -->
          <div class="topics-board">
            <div class="topics-board-header">
              <h3>Live Moderator Topics ({{ clusters().length }})</h3>
              <button type="button" class="reset-link" (click)="resetDemo()">Reset Demo</button>
            </div>

            <div class="cluster-list">
              @for (c of clusters(); track c.id) {
                <div class="cluster-card card" [class.active-answering]="c.status === 'answering'">
                  <div class="cluster-top">
                    <span class="cluster-badge" [class.answering]="c.status === 'answering'">
                      {{ c.status === 'answering' ? '🔴 Being Answered Live' : '📋 Consolidated Topic' }}
                    </span>
                    <span class="cluster-count">
                      {{ c.count }} {{ c.count === 1 ? 'question' : 'questions merged' }}
                    </span>
                    <span class="similarity-tag">
                      Match: {{ (c.similarity * 100).toFixed(0) }}%
                    </span>
                  </div>

                  <h4 class="cluster-title">{{ c.topic }}</h4>
                  <p class="cluster-lead">"{{ c.representative }}"</p>

                  @if (c.questions.length > 1) {
                    <details class="merged-details">
                      <summary class="merged-summary">View {{ c.questions.length }} merged variations</summary>
                      <ul class="merged-list">
                        @for (q of c.questions; track q) {
                          <li>"{{ q }}"</li>
                        }
                      </ul>
                    </details>
                  }
                </div>
              }
            </div>
          </div>
        </div>
      </section>

      <!-- ===== THREE PUBLIC ACCESS PATHWAYS ===== -->
      <section class="pathways-section" aria-labelledby="pathways-heading">
        <div class="section-header">
          <span class="section-tag">Publicly Accessible</span>
          <h2 id="pathways-heading">Explore Without Authentication</h2>
          <p class="section-intro">
            These areas are accessible immediately without creating an account or logging in:
          </p>
        </div>

        <div class="pathway-cards-grid">
          <article class="pathway-card card">
            <div class="pathway-icon">🎤</div>
            <h3>Attendee Q&amp;A Terminal</h3>
            <p>
              Submit questions anonymously into the live meeting pool. Set optional shareholder weight,
              view what the room is asking, and back topics you care about.
            </p>
            <ul class="pathway-features">
              <li>Instant question ingestion</li>
              <li>Live merged topic display</li>
              <li>Upvoting and backing mechanism</li>
            </ul>
            <a routerLink="/ask" class="pathway-action-btn">
              Open Attendee Terminal →
            </a>
          </article>

          <article class="pathway-card card">
            <div class="pathway-icon">📖</div>
            <h3>Knowledge Base &amp; Help Desk</h3>
            <p>
              Complete self-service guides on how shareholder voting works, how proxy representation is
              calculated, and answers to common sign-in questions.
            </p>
            <ul class="pathway-features">
              <li>Instant searchable FAQ index</li>
              <li>Works 100% offline without backend</li>
              <li>Step-by-step voting and MFA instructions</li>
            </ul>
            <a routerLink="/help" class="pathway-action-btn">
              Browse Help Topics →
            </a>
          </article>

          <article class="pathway-card card">
            <div class="pathway-icon">🔐</div>
            <h3>Member &amp; Moderator Portal</h3>
            <p>
              Sign in with modern biometric passkeys (FaceID / TouchID / Windows Hello), passwordless
              email/SMS one-time codes, or Google Single Sign-On.
            </p>
            <ul class="pathway-features">
              <li>WebAuthn / FIDO2 Passkeys</li>
              <li>One-Time Passcode (OTP) recovery</li>
              <li>Moderator and Admin access</li>
            </ul>
            <a routerLink="/login" class="pathway-action-btn">
              Access Sign-In Portal →
            </a>
          </article>

          <article class="pathway-card card highlight-tier">
            <div class="pathway-icon">💎</div>
            <h3>Commercial Plans &amp; ROI</h3>
            <p>
              Compare single-meeting event passes ($499 - $1,499) with annual enterprise governance licensing,
              and calculate your net savings in counsel and moderation time.
            </p>
            <ul class="pathway-features">
              <li>Interactive ROI savings simulator</li>
              <li>Official Scrutineer audit certificates</li>
              <li>White-label enterprise deployment options</li>
            </ul>
            <a routerLink="/pricing" class="pathway-action-btn highlight">
              Calculate Meeting ROI →
            </a>
          </article>
        </div>
      </section>

      <!-- ===== CORE PLATFORM PILLARS ===== -->
      <section class="features-grid-section" aria-labelledby="features-heading">
        <div class="section-header">
          <span class="section-tag">Enterprise Architecture</span>
          <h2 id="features-heading">Engineered for High-Stakes Governance</h2>
        </div>

        <div class="features-grid">
          <div class="feature-item card">
            <div class="feature-icon">🤖</div>
            <h4>AI Copilot &amp; Fact Extraction</h4>
            <p>
              Retrieval-Augmented Generation (RAG) indexes hundreds of pages of annual reports and SEC/MCA filings to draft factual answers for the meeting chair.
            </p>
          </div>

          <div class="feature-item card">
            <div class="feature-icon">🗳️</div>
            <h4>Live Shareholder Voting</h4>
            <p>
              Weighted proxy voting per share held, real-time quorum threshold tracking, and tamper-evident ballots with cryptographic validation.
            </p>
          </div>

          <div class="feature-item card">
            <div class="feature-icon">🎬</div>
            <h4>Synchronized Video &amp; Transcripts</h4>
            <p>
              Adaptive HLS live recording with interactive transcript search. Clicking any transcript phrase jumps the video player to the exact second.
            </p>
          </div>

          <div class="feature-item card">
            <div class="feature-icon">⚡</div>
            <h4>Angular 22 Zoneless Performance</h4>
            <p>
              Next-generation signal-based reactive UI with zero zone.js overhead. Built for instant responsiveness across mobile, tablet, and desktop.
            </p>
          </div>
        </div>
      </section>
    </div>
  `,
  styles: [
    `
      .welcome-page {
        max-width: 1040px;
        margin: 0 auto;
        padding: 32px 20px 64px;
      }

      /* Hero Section */
      .hero-section {
        text-align: center;
        padding: 32px 0 40px;
      }

      .hero-badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 16px;
        border-radius: 999px;
        background: rgba(56, 189, 248, 0.1);
        border: 1px solid rgba(56, 189, 248, 0.25);
        color: var(--accent);
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 24px;
      }

      .pulse-indicator {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #f59e0b;
        box-shadow: 0 0 8px #f59e0b;
        animation: pulse 2s infinite;
      }

      .pulse-indicator.ready {
        background: #10b981;
        box-shadow: 0 0 10px #10b981;
        animation: none;
      }

      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.4; transform: scale(1.2); }
      }

      .hero-title {
        font-size: 40px;
        line-height: 1.15;
        font-weight: 800;
        margin: 0 auto 16px;
        max-width: 840px;
        letter-spacing: -0.02em;
      }

      .gradient-text {
        background: linear-gradient(135deg, #38bdf8 0%, #818cf8 50%, #c084fc 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      .hero-subtitle {
        font-size: 17px;
        line-height: 1.6;
        color: var(--muted);
        max-width: 720px;
        margin: 0 auto 36px;
      }

      /* Hero CTA Buttons */
      .hero-cta-group {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
        max-width: 840px;
        margin: 0 auto;
      }

      .cta-button {
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 16px 20px;
        border-radius: 12px;
        text-decoration: none;
        text-align: left;
        transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
      }

      .cta-button:hover {
        transform: translateY(-2px);
      }

      .cta-button.demo-highlight {
        background: linear-gradient(135deg, rgba(56, 189, 248, 0.2) 0%, rgba(129, 140, 248, 0.2) 100%);
        border: 1px solid rgba(56, 189, 248, 0.6);
        color: var(--text);
        box-shadow: 0 0 20px rgba(56, 189, 248, 0.2);
        cursor: pointer;
      }

      .cta-button.demo-highlight:hover {
        border-color: #38bdf8;
        background: linear-gradient(135deg, rgba(56, 189, 248, 0.3) 0%, rgba(129, 140, 248, 0.3) 100%);
        box-shadow: 0 0 28px rgba(56, 189, 248, 0.35);
      }

      .cta-button.primary {
        background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%);
        color: #ffffff;
        border: 1px solid rgba(255, 255, 255, 0.2);
        box-shadow: 0 8px 24px rgba(37, 99, 235, 0.25);
      }

      .cta-button.secondary {
        background: var(--card);
        color: var(--text);
        border: 1px solid #334155;
      }

      .cta-button.secondary:hover {
        border-color: var(--accent);
      }

      .pathway-card.highlight-tier {
        border-color: rgba(56, 189, 248, 0.4);
        background: linear-gradient(180deg, rgba(56, 189, 248, 0.05) 0%, var(--surface) 100%);
      }

      .pathway-action-btn.highlight {
        background: var(--accent);
        color: #0b0f19;
        font-weight: 700;
        border-color: transparent;
      }

      .pathway-action-btn.highlight:hover {
        opacity: 0.92;
      }

      .cta-button .icon {
        font-size: 24px;
      }

      .cta-text {
        flex: 1;
        display: flex;
        flex-direction: column;
      }

      .cta-text strong {
        font-size: 15px;
      }

      .cta-text small {
        font-size: 12px;
        color: var(--muted);
      }

      .cta-button.primary .cta-text small {
        color: rgba(255, 255, 255, 0.8);
      }

      .cta-button .arrow {
        font-size: 18px;
        color: var(--muted);
      }

      .cta-button.primary .arrow {
        color: #ffffff;
      }

      /* Engine Status Card */
      .engine-status-card {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 16px 20px;
        border-radius: 12px;
        background: rgba(30, 41, 59, 0.7);
        border: 1px solid #334155;
        margin-bottom: 48px;
        backdrop-filter: blur(8px);
      }

      .engine-status-card.ready {
        border-color: rgba(16, 185, 129, 0.4);
        background: rgba(6, 78, 59, 0.2);
      }

      .status-icon {
        font-size: 26px;
        flex-shrink: 0;
      }

      .status-content {
        flex: 1;
      }

      .status-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 4px;
        flex-wrap: wrap;
      }

      .latency-pill {
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        background: #334155;
        color: var(--muted);
        font-weight: 600;
      }

      .latency-pill.ready {
        background: #064e3b;
        color: #34d399;
      }

      .status-description {
        margin: 0;
        font-size: 13px;
        color: var(--muted);
      }

      .ping-btn {
        background: transparent;
        color: var(--accent);
        border: 1px solid rgba(56, 189, 248, 0.3);
        padding: 8px 14px;
        font-size: 13px;
        border-radius: 8px;
        cursor: pointer;
        flex-shrink: 0;
      }

      .ping-btn:hover:not(:disabled) {
        background: rgba(56, 189, 248, 0.1);
        border-color: var(--accent);
      }

      /* Section Common */
      .section-header {
        text-align: center;
        margin-bottom: 28px;
      }

      .section-tag {
        display: inline-block;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.1em;
        font-weight: 700;
        color: var(--accent);
        margin-bottom: 6px;
      }

      .section-header h2 {
        font-size: 26px;
        margin: 0 0 10px;
      }

      .section-intro {
        font-size: 15px;
        color: var(--muted);
        max-width: 640px;
        margin: 0 auto;
      }

      /* Interactive Demo */
      .demo-section {
        margin-bottom: 56px;
      }

      .demo-container {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 20px;
      }

      @media (max-width: 820px) {
        .demo-container {
          grid-template-columns: 1fr;
        }
      }

      .demo-box {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .demo-label {
        font-size: 14px;
        font-weight: 600;
      }

      .demo-input-row {
        display: flex;
        gap: 8px;
      }

      .simulate-btn {
        flex-shrink: 0;
        white-space: nowrap;
      }

      .sample-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        margin-top: 4px;
      }

      .chips-label {
        font-size: 12px;
        color: var(--muted);
        margin-right: 4px;
      }

      .chip {
        background: #0b1220;
        border: 1px solid #334155;
        color: var(--text);
        font-size: 12px;
        padding: 5px 10px;
        border-radius: 999px;
        cursor: pointer;
        transition: border-color 0.15s ease, background 0.15s ease;
      }

      .chip:hover {
        border-color: var(--accent);
        background: rgba(56, 189, 248, 0.08);
      }

      .feedback-banner {
        display: flex;
        gap: 10px;
        padding: 12px;
        border-radius: 8px;
        background: rgba(56, 189, 248, 0.1);
        border: 1px solid rgba(56, 189, 248, 0.25);
        font-size: 13px;
        margin-top: 6px;
      }

      .feedback-banner.merged {
        background: rgba(245, 158, 11, 0.1);
        border-color: rgba(245, 158, 11, 0.3);
      }

      .feedback-banner p {
        margin: 2px 0 0;
        color: var(--muted);
      }

      .fb-icon {
        font-size: 20px;
      }

      /* Topics Board */
      .topics-board-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }

      .topics-board-header h3 {
        margin: 0;
        font-size: 16px;
      }

      .reset-link {
        background: none;
        border: none;
        color: var(--accent);
        font-size: 12px;
        cursor: pointer;
        padding: 0;
        text-decoration: underline;
      }

      .cluster-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-height: 440px;
        overflow-y: auto;
      }

      .cluster-card {
        border-left: 3px solid var(--accent);
        transition: transform 0.15s ease;
      }

      .cluster-card.active-answering {
        border-left-color: var(--hot);
      }

      .cluster-top {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
        flex-wrap: wrap;
      }

      .cluster-badge {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 999px;
        background: #334155;
        color: var(--text);
        font-weight: 600;
      }

      .cluster-badge.answering {
        background: #78350f;
        color: #fde68a;
      }

      .cluster-count {
        font-size: 12px;
        color: var(--muted);
      }

      .similarity-tag {
        font-size: 11px;
        color: #38bdf8;
        font-weight: 600;
        margin-left: auto;
      }

      .cluster-title {
        font-size: 15px;
        margin: 0 0 4px;
      }

      .cluster-lead {
        margin: 0 0 8px;
        font-size: 13px;
        color: var(--muted);
        font-style: italic;
      }

      .merged-details {
        font-size: 12px;
        color: var(--muted);
      }

      .merged-summary {
        cursor: pointer;
        color: var(--accent);
      }

      .merged-list {
        margin: 6px 0 0 16px;
        padding: 0;
      }

      /* Pathways Grid */
      .pathways-section {
        margin-bottom: 56px;
      }

      .pathway-cards-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 20px;
      }

      .pathway-card {
        display: flex;
        flex-direction: column;
        border: 1px solid #334155;
        transition: transform 0.15s ease, border-color 0.15s ease;
      }

      .pathway-card:hover {
        transform: translateY(-2px);
        border-color: var(--accent);
      }

      .pathway-icon {
        font-size: 32px;
        margin-bottom: 12px;
      }

      .pathway-card h3 {
        font-size: 18px;
        margin: 0 0 8px;
      }

      .pathway-card p {
        font-size: 14px;
        color: var(--muted);
        line-height: 1.5;
        margin: 0 0 16px;
        flex: 1;
      }

      .pathway-features {
        list-style: none;
        padding: 0;
        margin: 0 0 20px;
        font-size: 13px;
        color: var(--text);
      }

      .pathway-features li {
        margin-bottom: 6px;
        padding-left: 18px;
        position: relative;
      }

      .pathway-features li::before {
        content: '✓';
        position: absolute;
        left: 0;
        color: #34d399;
        font-weight: 700;
      }

      .pathway-action-btn {
        display: inline-block;
        text-align: center;
        background: #0b1220;
        border: 1px solid #334155;
        color: var(--accent);
        padding: 10px 16px;
        border-radius: 8px;
        text-decoration: none;
        font-weight: 600;
        font-size: 14px;
        transition: background 0.15s ease, border-color 0.15s ease;
      }

      .pathway-action-btn:hover {
        background: rgba(56, 189, 248, 0.1);
        border-color: var(--accent);
      }

      /* Core Features Grid */
      .features-grid-section {
        margin-bottom: 32px;
      }

      .features-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
      }

      .feature-item {
        border: 1px solid #334155;
      }

      .feature-icon {
        font-size: 26px;
        margin-bottom: 10px;
      }

      .feature-item h4 {
        margin: 0 0 6px;
        font-size: 15px;
      }

      .feature-item p {
        margin: 0;
        font-size: 13px;
        color: var(--muted);
        line-height: 1.45;
      }

      @media (max-width: 640px) {
        .hero-title {
          font-size: 28px;
        }
        .hero-subtitle {
          font-size: 15px;
        }
        .engine-status-card {
          flex-direction: column;
          align-items: flex-start;
        }
      }
    `,
  ],
})
export class WelcomeComponent {
  protected readonly warmup = inject(WarmupService);
  protected readonly auth = inject(AuthService);
  protected readonly demoMeeting = inject(DemoMeetingService);

  readonly demoText = signal('');
  readonly lastFeedback = signal<{ title: string; message: string; isMerged: boolean } | null>(null);

  readonly sampleQuestions = [
    { text: 'When is this year’s dividend paid?' },
    { text: 'What is the dividend distribution date?' },
    { text: 'Will you repurchase company shares?' },
    { text: 'Are there any share buybacks planned?' },
    { text: 'What is the AI roadmap for next quarter?' },
  ];

  readonly clusters = signal<DemoCluster[]>([
    {
      id: 'cluster-1',
      topic: 'Dividend Timeline & Distribution',
      representative: 'When will this year’s dividend be paid out to registered shareholders?',
      count: 2,
      similarity: 0.94,
      status: 'answering',
      questions: [
        'When will this year’s dividend be paid out to registered shareholders?',
        'What date can shareholders expect dividend distribution in bank accounts?',
      ],
    },
    {
      id: 'cluster-2',
      topic: 'Share Buybacks & Capital Allocation',
      representative: 'Are there any plans for share repurchases in the coming fiscal year?',
      count: 2,
      similarity: 0.91,
      status: 'queued',
      questions: [
        'Are there any plans for share repurchases in the coming fiscal year?',
        'Will the board approve a stock buyback program this quarter?',
      ],
    },
    {
      id: 'cluster-3',
      topic: 'Executive Compensation & Governance',
      representative: 'What are the performance metrics tied to executive stock options?',
      count: 1,
      similarity: 0.88,
      status: 'queued',
      questions: ['What are the performance metrics tied to executive stock options?'],
    },
  ]);

  pickSample(text: string): void {
    this.demoText.set(text);
    this.simulateSubmit();
  }

  simulateSubmit(): void {
    const text = this.demoText().trim();
    if (!text) return;

    // Check semantic similarity heuristic against existing demo clusters
    const lower = text.toLowerCase();
    let matchedCluster: DemoCluster | null = null;
    let matchSimilarity = 0;

    if (lower.includes('dividend') || lower.includes('payout') || lower.includes('yield')) {
      matchedCluster = this.clusters().find((c) => c.id === 'cluster-1') ?? null;
      matchSimilarity = 0.93 + Math.random() * 0.05;
    } else if (lower.includes('buyback') || lower.includes('repurchase') || lower.includes('shares')) {
      matchedCluster = this.clusters().find((c) => c.id === 'cluster-2') ?? null;
      matchSimilarity = 0.9 + Math.random() * 0.06;
    } else if (lower.includes('compensation') || lower.includes('salary') || lower.includes('options')) {
      matchedCluster = this.clusters().find((c) => c.id === 'cluster-3') ?? null;
      matchSimilarity = 0.87 + Math.random() * 0.05;
    }

    if (matchedCluster) {
      // Merge into existing cluster
      this.clusters.update((list) =>
        list.map((c) => {
          if (c.id === matchedCluster!.id) {
            return {
              ...c,
              count: c.count + 1,
              similarity: Math.max(c.similarity, Math.min(0.99, matchSimilarity)),
              questions: [text, ...c.questions],
            };
          }
          return c;
        }),
      );

      this.lastFeedback.set({
        title: 'Merged with Existing Topic!',
        message: `Matched "${matchedCluster.topic}" with ${(matchSimilarity * 100).toFixed(0)}% semantic similarity. Deduplicated without taking up moderator time.`,
        isMerged: true,
      });
    } else {
      // Create new cluster
      const newCluster: DemoCluster = {
        id: 'cluster-' + Date.now(),
        topic: text.length > 40 ? text.substring(0, 37) + '…' : text,
        representative: text,
        count: 1,
        similarity: 0.82,
        status: 'new',
        questions: [text],
      };

      this.clusters.update((list) => [newCluster, ...list]);
      this.lastFeedback.set({
        title: 'New Topic Created',
        message: 'No near-duplicate question found. A fresh topic was opened for the moderator board.',
        isMerged: false,
      });
    }

    this.demoText.set('');
  }

  resetDemo(): void {
    this.clusters.set([
      {
        id: 'cluster-1',
        topic: 'Dividend Timeline & Distribution',
        representative: 'When will this year’s dividend be paid out to registered shareholders?',
        count: 2,
        similarity: 0.94,
        status: 'answering',
        questions: [
          'When will this year’s dividend be paid out to registered shareholders?',
          'What date can shareholders expect dividend distribution in bank accounts?',
        ],
      },
      {
        id: 'cluster-2',
        topic: 'Share Buybacks & Capital Allocation',
        representative: 'Are there any plans for share repurchases in the coming fiscal year?',
        count: 2,
        similarity: 0.91,
        status: 'queued',
        questions: [
          'Are there any plans for share repurchases in the coming fiscal year?',
          'Will the board approve a stock buyback program this quarter?',
        ],
      },
      {
        id: 'cluster-3',
        topic: 'Executive Compensation & Governance',
        representative: 'What are the performance metrics tied to executive stock options?',
        count: 1,
        similarity: 0.88,
        status: 'queued',
        questions: ['What are the performance metrics tied to executive stock options?'],
      },
    ]);
    this.lastFeedback.set(null);
  }
}
