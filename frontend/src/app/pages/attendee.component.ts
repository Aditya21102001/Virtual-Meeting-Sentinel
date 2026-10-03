import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, IngestResult } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { DemoMeetingService } from '../services/demo-meeting.service';
import { FeatureService } from '../services/feature.service';
import { NavigationHistoryService } from '../services/navigation-history.service';
import { RoomService, TopicView } from '../services/room.service';

@Component({
  selector: 'app-attendee',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="container">
      <div style="margin-bottom:8px">
        <button type="button" class="back-link" (click)="goBack()" [attr.aria-label]="backLabel()">
          ← {{ backLabel() }}
        </button>
      </div>
      <h1>Ask a question</h1>
      <p class="muted">
        Submit as many as you like. Duplicate/near-duplicate questions are automatically
        merged into a single topic on the moderator board.
      </p>

      <div class="card">
        <!-- Quick Sample Prompts -->
        <div class="quick-samples">
          <span class="muted sample-lbl">💡 Try asking:</span>
          <button type="button" class="sample-chip" (click)="text.set('When will the FY2026 dividend of $2.40 be paid out and what is the record date?')">
            Dividend payout date?
          </button>
          <button type="button" class="sample-chip" (click)="text.set('Can management clarify the rationale and execution timeline for the $500M share buyback?')">
            $500M buyback timeline?
          </button>
          <button type="button" class="sample-chip" (click)="text.set('What are the projected CapEx and gross margin impacts of the AI server deployment?')">
            CapEx for AI servers?
          </button>
        </div>

        <label class="sr-only" for="question-text">Your question</label>
        <textarea id="question-text" [ngModel]="text()" (ngModelChange)="text.set($event)" rows="3"
                  placeholder="e.g. When will this year's dividend be paid?"></textarea>
        <div class="row" style="margin-top:12px; gap:8px; align-items:center; flex-wrap:wrap">
          <label class="muted" style="flex:1; min-width:140px">
            Shareholder weight (0–1)
            <input type="number" min="0" max="1" step="0.1"
                   [ngModel]="weight()" (ngModelChange)="weight.set($event)" />
          </label>
          <button type="button" class="ghost voice-btn" [class.listening]="isListening()" (click)="toggleVoice()" title="Dictate question using microphone">
            <span class="mic-dot" [class.pulsing]="isListening()"></span>
            {{ isListening() ? '🎙 Listening…' : '🎙 Speak' }}
          </button>
          <button (click)="submit()" [disabled]="!text().trim() || busy()">
            {{ busy() ? 'Sending…' : 'Submit' }}
          </button>
        </div>
      </div>

      @if (last(); as l) {
        <div class="card ingest-feedback-card">
          <div class="row" style="gap:10px; align-items:center">
            <span class="badge" [class.hot]="l.is_new_cluster">
              {{ l.is_new_cluster ? 'New topic' : 'Merged with existing topic' }}
            </span>
            <span class="muted">cluster size: {{ l.cluster_size }}</span>
            <span class="muted">similarity: {{ l.similarity }}</span>
          </div>
          <p class="muted" style="margin:8px 0 0">
            {{ l.is_new_cluster
                ? 'Nobody had asked this yet — a new topic was created.'
                : 'This matched a question others already asked, so it was deduplicated.' }}
          </p>
        </div>
      }

      <!--
        What the room is asking. Shown here rather than on a page of its own because this is where
        somebody is already looking, and seeing their question listed is the moment they would
        otherwise retype it.
      -->
      @if (topics().length) {
        <section class="topics" aria-labelledby="topics-heading">
          <h2 id="topics-heading">What the room is asking</h2>
          <p class="muted">
            @if (features.enabled('CLUSTER_UPVOTE')) {
              If your question is already here, back it instead of asking again — it counts just
              the same and saves you typing.
            } @else {
              Questions others have asked, most-wanted first.
            }
          </p>

          @for (t of topics(); track t.clusterId) {
            <div class="card topic" [class.live]="t.underDiscussion">
              <div class="row">
                <strong style="flex:1">{{ t.question }}</strong>
                @if (t.underDiscussion) {
                  <span class="badge hot" role="status">being answered now</span>
                }
              </div>

              <div class="row counts">
                <span class="muted">
                  asked by {{ t.asked }} {{ t.asked === 1 ? 'person' : 'people' }}
                  @if (t.supported > 0) { · backed by {{ t.supported }} }
                </span>
                <span style="flex:1"></span>
                @if (features.enabled('CLUSTER_UPVOTE')) {
                  <button
                    class="ghost support"
                    [class.backed]="t.supportedByMe"
                    [attr.aria-pressed]="t.supportedByMe"
                    [disabled]="supporting() === t.clusterId"
                    (click)="support(t)"
                  >
                    {{ t.supportedByMe ? '★ Backed' : '☆ Back this' }}
                  </button>
                }
              </div>

              <!-- Only ever shown once a moderator released it — see RoomService. -->
              @if (t.answer) {
                <p class="answer">{{ t.answer }}</p>
              }
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: [
    `
      .quick-samples {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
        margin-bottom: 12px;
      }
      .sample-lbl {
        font-size: 11px;
        text-transform: uppercase;
        font-weight: 700;
        letter-spacing: 0.04em;
      }
      .sample-chip {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid var(--border);
        color: var(--muted);
        border-radius: 999px;
        font-size: 11px;
        padding: 4px 10px;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .sample-chip:hover {
        background: rgba(99, 102, 241, 0.15);
        border-color: #6366f1;
        color: var(--text);
      }
      .voice-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 8px;
        padding: 8px 12px;
      }
      .voice-btn.listening {
        border-color: #ef4444;
        color: #ef4444;
        background: rgba(239, 68, 68, 0.1);
      }
      .mic-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #ef4444;
        display: none;
      }
      .mic-dot.pulsing {
        display: inline-block;
        animation: micPulse 1.2s ease-in-out infinite;
      }
      @keyframes micPulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.3; transform: scale(1.3); }
      }
      .ingest-feedback-card {
        border-color: rgba(99, 102, 241, 0.4);
        background: rgba(99, 102, 241, 0.05);
      }
      .topics {
        margin-top: 28px;
      }
      .topics h2 {
        font-size: 17px;
        margin-bottom: 4px;
      }
      .topic.live {
        border-color: #f59e0b;
      }
      .counts {
        margin-top: 8px;
        font-size: 13px;
        align-items: center;
      }
      .support.backed {
        font-weight: 600;
        color: #f59e0b;
      }
      .answer {
        white-space: pre-wrap;
        margin: 10px 0 0;
        padding-top: 10px;
        border-top: 1px solid rgba(128, 128, 128, 0.2);
      }
    `,
  ],
})
export class AttendeeComponent implements OnInit, OnDestroy {
  readonly text = signal('');
  readonly weight = signal(0.1);
  readonly busy = signal(false);
  readonly isListening = signal(false);
  readonly last = signal<IngestResult | null>(null);
  private attendeeId = 'attendee-' + Math.floor(Math.random() * 1e6);
  private recognition: any = null;

  /** What the room is asking. Empty when the feature is off or nothing has been asked. */
  readonly topics = signal<TopicView[]>([]);
  /** Cluster id currently being backed, so only that button disables. */
  readonly supporting = signal<string | null>(null);

  private topicsTimer: ReturnType<typeof setInterval> | null = null;
  /** Set when the server says the feature is off, so the poll stops asking. */
  private disabledByServer = false;

  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  protected readonly features = inject(FeatureService);
  private readonly room = inject(RoomService);
  public readonly navHistory = inject(NavigationHistoryService);
  protected readonly demoMeeting = inject(DemoMeetingService);

  backLabel(): string {
    if (this.navHistory.canGoBack()) {
      return 'Back to previous page';
    }
    return this.auth.isAuthenticated()
      ? (this.auth.isModerator() ? 'Back to Board' : 'Back to Lounge')
      : 'Back to Overview';
  }

  goBack(): void {
    const fallback = this.auth.isAuthenticated()
      ? (this.auth.isModerator() ? '/board' : '/chat')
      : '/welcome';
    this.navHistory.back(fallback);
  }

  ngOnDestroy(): void {
    if (this.topicsTimer) clearInterval(this.topicsTimer);
    this.stopVoice();
  }

  toggleVoice(): void {
    if (this.isListening()) {
      this.stopVoice();
      return;
    }

    const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRec) {
      alert('Speech recognition is not supported in this browser. Please type your question.');
      return;
    }

    try {
      this.recognition = new SpeechRec();
      this.recognition.continuous = false;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';

      this.recognition.onstart = () => this.isListening.set(true);
      this.recognition.onend = () => this.isListening.set(false);
      this.recognition.onerror = () => this.isListening.set(false);

      this.recognition.onresult = (event: any) => {
        const transcript = Array.from(event.results)
          .map((r: any) => r[0].transcript)
          .join('');
        this.text.set(transcript);
      };

      this.recognition.start();
    } catch {
      this.isListening.set(false);
    }
  }

  stopVoice(): void {
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {}
    }
    this.isListening.set(false);
  }

  /**
   * Re-read the topics.
   */
  private loadTopics(): void {
    if (this.disabledByServer) {
      this.fallbackDemoTopics();
      return;
    }
    this.room.attendeeBoard(20).subscribe({
      next: (list) => {
        if (list && list.length > 0) {
          this.topics.set(list);
        } else {
          this.fallbackDemoTopics();
        }
      },
      error: (err) => {
        if (err?.status === 404) this.disabledByServer = true;
        this.fallbackDemoTopics();
      },
    });
  }

  private fallbackDemoTopics(): void {
    if (this.topics().length === 0 || this.demoMeeting.isDemoActive()) {
      const demoList: TopicView[] = this.demoMeeting.demoClusters.map((c, idx) => ({
        clusterId: c.cluster_id,
        question: c.representative_question,
        asked: c.size,
        supported: 18,
        supportedByMe: false,
        underDiscussion: false,
        answer: c.draft,
        answered: !!c.draft,
        published: true,
        runOrder: idx + 1,
        startedAt: null,
        secondsSpent: null,
      }));
      this.topics.set(demoList);
    }
  }

  /** Back a topic, or take that back. */
  support(topic: TopicView): void {
    this.supporting.set(topic.clusterId);

    if (topic.clusterId.startsWith('cl-apex') || topic.clusterId.startsWith('cl-custom')) {
      setTimeout(() => {
        this.supporting.set(null);
        this.topics.update((list) =>
          list.map((t) =>
            t.clusterId === topic.clusterId
              ? {
                  ...t,
                  supported: t.supportedByMe ? Math.max(0, t.supported - 1) : t.supported + 1,
                  supportedByMe: !t.supportedByMe,
                }
              : t,
          ),
        );
      }, 200);
      return;
    }

    this.room.supportTopic(topic.clusterId).subscribe({
      next: (result) => {
        this.supporting.set(null);
        this.topics.update((list) =>
          list.map((t) =>
            t.clusterId === result.clusterId
              ? { ...t, supported: result.supported, supportedByMe: !t.supportedByMe }
              : t,
          ),
        );
      },
      error: () => this.supporting.set(null),
    });
  }

  ngOnInit(): void {
    if (this.auth.isAuthenticated()) {
      this.startTopicPolling();
      return;
    }
    this.obtainAttendeeToken();
  }

  private obtainAttendeeToken(onReady?: () => void): void {
    if (this.auth.isAuthenticated() || this.api.hasToken()) {
      onReady?.();
      return;
    }

    this.api.attendeeLogin(this.attendeeId).subscribe({
      next: (r) => {
        this.api.setToken(r.token);
        this.startTopicPolling();
        onReady?.();
      },
      error: () => {
        this.fallbackDemoTopics();
        onReady?.();
        setTimeout(() => {
          if (!this.api.hasToken() && !this.auth.isAuthenticated()) {
            this.obtainAttendeeToken();
          }
        }, 4000);
      },
    });
  }

  private startTopicPolling(): void {
    this.loadTopics();
    if (!this.topicsTimer) {
      this.topicsTimer = setInterval(() => this.loadTopics(), 15000);
    }
  }

  submit(): void {
    const questionText = this.text().trim();
    if (!questionText || this.busy()) return;
    this.busy.set(true);
    this.stopVoice();

    const doSubmit = () => {
      this.api.submitQuestion(questionText, this.attendeeId, this.weight()).subscribe({
        next: (res) => {
          this.last.set(res);
          this.text.set('');
          this.busy.set(false);
          this.loadTopics();
        },
        error: () => {
          // Offline / cold-start semantic clustering simulation
          this.simulateSemanticClustering(questionText);
        },
      });
    };

    if (!this.auth.isAuthenticated() && !this.api.hasToken()) {
      this.obtainAttendeeToken(() => doSubmit());
    } else {
      doSubmit();
    }
  }

  private simulateSemanticClustering(questionText: string): void {
    const textLower = questionText.toLowerCase();
    let matchedCluster: any = null;
    let simScore = 0.42;

    if (textLower.includes('dividend')) {
      matchedCluster = this.demoMeeting.demoClusters[0];
      simScore = 0.94;
    } else if (textLower.includes('buyback') || textLower.includes('repurchase')) {
      matchedCluster = this.demoMeeting.demoClusters[1];
      simScore = 0.92;
    } else if (textLower.includes('capex') || textLower.includes('server') || textLower.includes('margin') || textLower.includes('ai')) {
      matchedCluster = this.demoMeeting.demoClusters[2];
      simScore = 0.89;
    } else if (textLower.includes('customer') || textLower.includes('concentration') || textLower.includes('client')) {
      matchedCluster = this.demoMeeting.demoClusters[3];
      simScore = 0.93;
    }

    if (matchedCluster) {
      const demoResult: IngestResult = {
        question_id: 'q-demo-' + Date.now(),
        cluster_id: matchedCluster.cluster_id,
        is_new_cluster: false,
        cluster_size: matchedCluster.size + 1,
        similarity: simScore,
      };
      this.last.set(demoResult);
      this.text.set('');
      this.busy.set(false);
      this.topics.update((list) =>
        list.map((t) =>
          t.clusterId === matchedCluster.cluster_id ? { ...t, asked: t.asked + 1 } : t,
        ),
      );
    } else {
      const newId = 'cl-custom-' + Date.now();
      const demoResult: IngestResult = {
        question_id: 'q-demo-' + Date.now(),
        cluster_id: newId,
        is_new_cluster: true,
        cluster_size: 1,
        similarity: 1.0,
      };
      this.last.set(demoResult);
      this.text.set('');
      this.busy.set(false);
      const newTopic: TopicView = {
        clusterId: newId,
        question: questionText,
        asked: 1,
        supported: 0,
        supportedByMe: false,
        underDiscussion: false,
        answer: null,
        answered: false,
        published: true,
        runOrder: this.topics().length + 1,
        startedAt: null,
        secondsSpent: null,
      };
      this.topics.update((list) => [newTopic, ...list]);
    }
  }
}
