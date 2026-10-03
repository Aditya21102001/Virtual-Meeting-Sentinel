import { Injectable, inject, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import { BackendStatusService } from './backend-status';

export type WarmupPhase = 'idle' | 'warming' | 'ready' | 'failed';

/**
 * Proactively wakes up the Render backend and AI microservice behind the scenes.
 *
 * <h2>Why this exists</h2>
 * On Render's free tier, inactive instances spin down after 15 minutes of idle time.
 * When an attendee or shareholder visits the frontend on Vercel, the first API call
 * normally pays a 30–60 second cold-start penalty.
 *
 * By dispatching a silent, low-priority background ping to `/health` the moment the user
 * lands on the public pages, the backend starts booting immediately while the user is
 * exploring the overview, reading the FAQs, or preparing questions. By the time they
 * interact with an authenticated or live feature, the container is already warm and responsive.
 *
 * Uses low-priority fetch so it never contends with user-initiated network traffic or
 * triggers global error banners.
 */
@Injectable({ providedIn: 'root' })
export class WarmupService {
  constructor(private readonly backendStatus: BackendStatusService) {}

  readonly phase = signal<WarmupPhase>('idle');
  readonly pingMs = signal<number | null>(null);
  readonly startedAt = signal<number | null>(null);
  readonly elapsedSec = signal<number>(0);
  readonly aiReady = signal<boolean>(false);
  readonly statusMessage = signal<string>('Standby');

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private isWarming = false;

  /**
   * Start the background wake-up sequence.
   * Safe to call multiple times — will only run one active sequence.
   */
  warmUp(): void {
    if (this.isWarming || this.phase() === 'ready') return;
    this.isWarming = true;
    this.phase.set('warming');
    const start = Date.now();
    this.startedAt.set(start);
    this.statusMessage.set('Waking up cloud engine (Render free tier) in background…');

    if (typeof window !== 'undefined') {
      this.clearElapsedTimer();
      this.elapsedTimer = setInterval(() => {
        if (this.phase() === 'ready') {
          this.clearElapsedTimer();
          return;
        }
        this.elapsedSec.set(Math.floor((Date.now() - start) / 1000));
      }, 1000);
    }

    this.pingHealth();
  }

  retryNow(): void {
    this.clearTimers();
    this.isWarming = false;
    this.phase.set('idle');
    this.warmUp();
  }

  private async pingHealth(): Promise<void> {
    if (this.phase() === 'ready') return;

    const t0 = Date.now();
    try {
      // 15s timeout per probe attempt
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 15000) : null;

      const res = await fetch(`${environment.apiBase}/health`, {
        method: 'GET',
        mode: 'cors',
        signal: controller ? controller.signal : undefined,
        // Fetch priority 'low' deprioritizes background traffic
        priority: 'low' as RequestPriority,
      });

      if (timeoutId) clearTimeout(timeoutId);

      if (res.ok) {
        const latency = Math.max(1, Date.now() - t0);
        this.onSuccess(latency);
        return;
      }
    } catch {
      // Swallowed: expected while the Render instance is provisioning or restarting
    }

    // Still warming up — schedule next poll
    if (this.phase() !== 'ready') {
      const elapsed = this.elapsedSec();
      if (elapsed > 180) {
        this.phase.set('failed');
        this.statusMessage.set('Cloud engine response timed out after 3 minutes.');
        this.clearTimers();
        return;
      }

      this.statusMessage.set(
        `Waking up Render backend (${elapsed}s elapsed)… Priming in background.`
      );

      this.pollTimer = setTimeout(() => {
        this.pingHealth();
      }, 4000);
    }
  }

  private onSuccess(latency: number): void {
    this.clearTimers();
    this.phase.set('ready');
    this.pingMs.set(latency);
    this.statusMessage.set(`Cloud engine is online & ready (${latency}ms latency)`);
    this.backendStatus.markSuccess();

    // Trigger AI service wake-up call in the background
    this.pingAiService();
  }

  private async pingAiService(): Promise<void> {
    try {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), 20000) : null;

      const res = await fetch(`${environment.apiBase}/health/ai`, {
        method: 'GET',
        mode: 'cors',
        signal: controller ? controller.signal : undefined,
        priority: 'low' as RequestPriority,
      });

      if (timeoutId) clearTimeout(timeoutId);

      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (body && body.ai === 'UP') {
          this.aiReady.set(true);
        }
      }
    } catch {
      // AI health is non-critical for initial navigation
    }
  }

  private clearTimers(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.clearElapsedTimer();
  }

  private clearElapsedTimer(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }
}
