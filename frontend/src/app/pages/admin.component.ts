import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { concatMap, from, timeout } from 'rxjs';
import { FeatureService } from '../services/feature.service';
import { MeetingService, MeetingView } from '../services/meeting.service';
import {
  AnnualReportResult,
  ApiService,
  IndexRun,
  KnowledgeStatus,
} from '../services/api.service';

@Component({
  selector: 'app-admin',
  standalone: true,
  template: `
    <div class="container">
      <h1>Setup</h1>
      <p class="muted">
        Configure the meeting: index the company's source documents (used to draft grounded
        answers) and, optionally, a bank of expected questions to pre-populate the board.
      </p>

      <!-- Source document upload -->
      <div class="card">
        <div class="q">1 · Source documents (PDF)</div>
        <p class="muted">
          Indexed into the RAG knowledge base. Several documents can be indexed side by side, and
          every draft answer cites the document it came from. Removing one deletes it along with
          everything derived from it — its chunks and its embeddings.
        </p>
        <div class="row" style="margin-top:10px">
          <!--
            Which meeting these documents belong to.
            Shared is the default and is listed first: the articles, a standing policy and a
            reference report all apply to every meeting, and making somebody re-upload them per
            meeting would be busywork that also multiplies the index. Scoping is the deliberate
            choice, which is why it is a picker rather than an automatic tag from whatever happens
            to be live.
          -->
          <label class="label" for="upload-scope">Applies to</label>
          <select
            id="upload-scope"
            [value]="uploadMeetingId()"
            (change)="uploadMeetingId.set($any($event.target).value)"
            [disabled]="reportBusy()"
          >
            <option value="">Every meeting (shared)</option>
            @for (m of meetings(); track m.id) {
              <option [value]="m.id">Only “{{ m.title }}”</option>
            }
          </select>
          <!--
            Scoping only takes effect when the MEETINGS feature is on. Tagging a document happens
            unconditionally — that is deliberate, so switching the feature on later works
            immediately — but FILTERING is conditional, so a document scoped while the feature is
            off is still cited by everything.

            Saying so here is the whole point. Offering a choice the configuration will silently
            ignore is worse than not offering it: the operator does the right thing, sees the
            confirmation, and gets the opposite behaviour with nothing to explain why.
          -->
          @if (uploadMeetingId() && !features.enabled('MEETINGS')) {
            <p class="scope-warning" role="status">
              <strong>This will be recorded but not enforced.</strong>
              Per-meeting scoping only applies when the Meetings feature is switched on — until
              then every meeting can cite every document, whatever it is tagged with. An admin can
              enable it under Administration → Features. The tag is saved either way, so turning it
              on later takes effect immediately.
            </p>
          } @else {
            <p class="muted" style="margin:6px 0 10px; font-size:12px">
              @if (uploadMeetingId()) {
                Only answers for this meeting will cite these documents.
              } @else {
                Every meeting will be able to cite these documents — including meetings created
                later.
              }
            </p>
          }

          <label class="sr-only" for="report-file">Annual report PDFs to index</label>
          <input #reportInput id="report-file" type="file" accept="application/pdf" multiple
                 (change)="pickReport($event)" />
          <button (click)="uploadReport(reportInput)" [disabled]="!reportFiles().length || reportBusy()">
            {{ reportBusy() ? 'Indexing…' : 'Upload & index' }}
          </button>
        </div>
        @if (reportMsg()) { <p class="muted" style="margin-top:8px">{{ reportMsg() }}</p> }
        @if (statusLoading()) {
          <p class="muted" style="margin-top:8px">
            Reading the knowledge base… the AI service sleeps when idle, so the first read after a
            quiet spell can take up to a minute.
          </p>
        }
        <!--
          A cold start is not a failure, and must not look like one. The AI service sleeps when
          idle on a free tier, so the FIRST request after a quiet spell fails while every one after
          it succeeds. Showing that as a red error box teaches people to distrust a panel that was
          about to work on its own.

          So a 503 gets a calm, self-resolving "waking" state with the elapsed time visible, and
          anything else — a real failure — still gets the error box it deserves.

          NOTE the two states are SIBLINGS, not nested. This block used to sit inside
          @if (statusErr()), which made it unreachable: the 503 path deliberately does not set
          statusErr (that is what stops the red box appearing), so the outer condition was always
          false and the waking panel never rendered at all. The user got ~50 seconds of blank page
          followed by the failure message — the exact opposite of the intent.
        -->
        @if (waking()) {
          <p class="waking" role="status">
            <span class="spinner" aria-hidden="true"></span>
            Waking the AI service — it sleeps when idle and takes up to a minute to start.
            <span class="muted-inline">
              Retrying automatically ({{ wakeSeconds() }}s, attempt {{ wakeAttempt() }}).
            </span>
          </p>
        } @else if (statusErr()) {
          <p class="error-box" style="margin-top:8px">
            {{ statusErr() }}
            <button (click)="retryStatus()" [disabled]="statusLoading()" style="margin-left:8px">
              Retry
            </button>
          </p>
        }

        @if (status(); as s) {
          <div class="draft" style="margin-top:10px">
            <strong>Knowledge base:</strong>
            {{ s.ready ? s.chunks_indexed + ' chunks indexed' : 'no documents indexed yet' }}
          </div>

          @if (s.sources.length) {
            <ul class="sources">
              @for (src of s.sources; track src) {
                <li class="source-row">
                  <span class="source-name">
                    {{ src }}
                    <!--
                      Which meeting can cite this. Shown on every row rather than filtering the
                      list, because an administrator managing the knowledge base needs to see
                      everything in it — including documents belonging to a meeting that is not
                      currently live, which are exactly the ones they would otherwise think had
                      vanished.
                    -->
                    <span class="scope" [class.shared]="!scopeOf(src)">
                      {{ scopeOf(src) ?? 'all meetings' }}
                    </span>
                  </span>
                  @if (isRemovable(src)) {
                    <button
                      class="danger"
                      (click)="removeSource(src)"
                      [disabled]="removing() === src"
                    >
                      {{
                        removing() === src
                          ? 'Removing…'
                          : confirmingRemove() === src
                            ? 'Click again to remove'
                            : 'Remove'
                      }}
                    </button>
                  } @else {
                    <span class="muted">managed in Recordings</span>
                  }
                </li>
              }
            </ul>
          }

          <!--
            Live progress. Two phases, shown as two different things on purpose:

            * uploading — the browser measures this exactly, so it gets a real bar.
            * indexing  — the server measures this, so the bar comes from the pipeline's own
                          count of chunks embedded, and is absent until there is a real number.

            One combined bar would reach 100% the moment the bytes landed and then sit there for
            the whole embed, which is exactly when somebody most wants to know it is still alive.
          -->
          @if (uploadPhase() !== 'idle') {
            <div class="progress-panel" role="status" aria-live="polite">
              <div class="progress-head">
                <strong>
                  @if (uploadTotal() > 1) {
                    File {{ uploadIndex() }} of {{ uploadTotal() }} —
                  }
                  {{ uploadName() }}
                </strong>
                <span class="muted-inline">
                  {{ uploadPhase() === 'uploading' ? 'Uploading' : 'Indexing' }}
                </span>
              </div>

              @if (uploadPhase() === 'uploading') {
                <div
                  class="bar"
                  role="progressbar"
                  [attr.aria-valuenow]="uploadPercent()"
                  aria-valuemin="0"
                  aria-valuemax="100"
                  [attr.aria-valuetext]="'Uploading, ' + uploadPercent() + ' percent sent'"
                >
                  <span class="fill" [style.width.%]="uploadPercent()"></span>
                </div>
                <p class="muted small">
                  {{ uploadPercent() }}% sent · {{ 100 - uploadPercent() }}% remaining
                </p>
              } @else {
                <!-- The server's own measured progress, polled while it works. -->
                @if (indexRun(); as run) {
                  @if (run.percent !== null) {
                    <div
                      class="bar"
                      role="progressbar"
                      [attr.aria-valuenow]="run.percent"
                      aria-valuemin="0"
                      aria-valuemax="100"
                      [attr.aria-valuetext]="
                        'Indexing, ' + run.done + ' of ' + run.total + ' ' + run.unit + ' embedded'
                      "
                    >
                      <span class="fill indexing" [style.width.%]="run.percent"></span>
                    </div>
                    <p class="muted small">
                      {{ run.percent }}% · {{ run.done }} of {{ run.total }} {{ run.unit }} ·
                      {{ run.total - run.done }} remaining
                      @if (run.eta_ms) {
                        · about {{ etaText(run.eta_ms) }} left
                      }
                    </p>
                  } @else {
                    <p class="muted small">
                      Reading the document — the chunk count is not known yet.
                    </p>
                  }
                } @else {
                  <p class="muted small">Handed to the AI service…</p>
                }
              }
            </div>
          }

          <!-- What the pipeline actually did, rather than a spinner that explains nothing. -->
          @if (s.last_index_run; as run) {
            <div class="trace">
              <div class="muted">
                <strong>{{ run.label }}</strong>
                — {{ run.running ? 'in progress…' : run.total_ms + ' ms' }}
              </div>
              @for (step of run.steps; track step.name) {
                <div class="trace-step" [class.running]="step.status === 'running'">
                  <span
                    class="badge"
                    [class.failed]="step.status === 'failed'"
                    [class.active]="step.status === 'running'"
                  >
                    {{ step.status === 'done' ? '✓' : step.status === 'failed' ? '✗' : '…' }}
                  </span>
                  <span>
                    {{ step.name }}
                    <span class="muted">— {{ step.tool }}</span>
                    @if (step.detail) { <br /><span class="muted">{{ step.detail }}</span> }
                  </span>
                  <span class="muted">{{ step.ms === null ? '' : step.ms + ' ms' }}</span>
                </div>
              }
              @if (run.note) { <div class="muted">{{ run.note }}</div> }
            </div>
          }
        }
      </div>

      <!-- Question bank upload -->
      <div class="card">
        <div class="q">2 · Question bank (.txt / .csv — one question per line)</div>
        <p class="muted">
          Each line is clustered like a live question, so duplicates collapse automatically.
        </p>
        <div class="row" style="margin-top:10px">
          <label class="sr-only" for="bank-file">Question bank file</label>
          <input id="bank-file" type="file" accept=".txt,.csv" (change)="pickBank($event)" />
          <button (click)="uploadBank()" [disabled]="!bankFile() || bankBusy()">
            {{ bankBusy() ? 'Ingesting…' : 'Upload & ingest' }}
          </button>
        </div>
        <!--
          The bank's two phases. Only the upload has a real percentage: the server clusters each
          line as it goes and reports per question, not as a total, so the indexing phase says what
          it is doing rather than showing a bar it cannot honestly fill.
        -->
        @if (bankPhase() !== 'idle') {
          <div class="progress-panel" role="status" aria-live="polite">
            @if (bankPhase() === 'uploading') {
              <div
                class="bar"
                role="progressbar"
                [attr.aria-valuenow]="bankPercent()"
                aria-valuemin="0"
                aria-valuemax="100"
                [attr.aria-valuetext]="'Uploading, ' + bankPercent() + ' percent sent'"
              >
                <span class="fill" [style.width.%]="bankPercent()"></span>
              </div>
              <p class="muted small">
                {{ bankPercent() }}% sent · {{ 100 - bankPercent() }}% remaining
              </p>
            } @else {
              <p class="muted small">
                Clustering each question — this takes about as long as the same questions arriving
                live, because it is the same pipeline.
              </p>
            }
          </div>
        }

        @if (bankMsg()) { <p class="muted" style="margin-top:8px">{{ bankMsg() }}</p> }
      </div>

      <p class="muted">Then open the <strong>Moderator board</strong> to see the results.</p>
    </div>
  `,
  // Component-scoped: .danger exists on the video-admin page but is not global.
  // The rows are deliberately NOT .row — global CSS gives .row > button width:100% under 640px,
  // which would make every Remove button full-width on a phone.
  styles: [
    `
      button.danger { background: none; border: 1px solid #7f1d1d; color: #fca5a5; }

      /* Amber: the upload will work exactly as asked, but one consequence will not. That is a
         caveat to read, not an error to fear. */
      .scope-warning {
        margin: 6px 0 10px;
        padding: 9px 12px;
        border-radius: 8px;
        font-size: 12px;
        color: #fcd34d;
        background: #3b2f17;
        border: 1px solid #7c5e10;
      }

      .source-name {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        min-width: 0;
      }
      .scope {
        font-size: 11px;
        padding: 2px 9px;
        border-radius: 999px;
        border: 1px solid var(--accent);
        color: var(--accent);
        white-space: nowrap;
      }
      /* Shared is the default and by far the common case, so it is stated quietly — a loud badge
         on almost every row would drown out the ones that are actually scoped. */
      .scope.shared {
        border-color: #33415588;
        color: var(--muted);
      }

      .label {
        display: block;
        font-size: 13px;
        font-weight: 600;
        margin: 10px 0 5px;
      }

      /* ---- upload / indexing progress ---- */
      .progress-panel {
        margin-top: 10px;
        padding: 12px;
        border-radius: 8px;
        background: #0b1220;
        border: 1px solid #334155;
      }
      .progress-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
        margin-bottom: 8px;
        font-size: 14px;
      }
      .bar {
        height: 8px;
        border-radius: 999px;
        background: rgba(148, 163, 184, 0.25);
        overflow: hidden;
      }
      .fill {
        display: block;
        height: 100%;
        background: var(--accent);
        /* Eased, not animated on a loop: the width comes from a real measurement, so the only
           motion should be between one true value and the next. */
        transition: width 0.25s ease;
      }
      /* A different colour for the server's phase, so it is obvious the bar restarted for a
         different reason rather than appearing to jump backwards. */
      .fill.indexing {
        background: #34d399;
      }
      .small {
        font-size: 12px;
        margin: 6px 0 0;
        font-variant-numeric: tabular-nums;
      }

      /* The step being worked on right now, so a long run shows where it is. */
      .trace-step.running {
        color: var(--text);
      }
      .badge.active {
        background: var(--accent);
        color: #04222f;
      }

      @media (prefers-reduced-motion: reduce) {
        .fill { transition: none; }
      }

      /* Waiting, not failing. Deliberately NOT styled like .error-box: a cold start resolves
         itself, and dressing it in red teaches people to distrust a panel that was about to work.
         Amber and a moving spinner read as "in progress"; red reads as "you have a problem". */
      .waking {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 8px;
        padding: 10px 12px;
        border-radius: 8px;
        font-size: 14px;
        color: #fcd34d;
        background: #3b2f17;
        border: 1px solid #7c5e10;
      }
      .spinner {
        flex: 0 0 auto;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid currentColor;
        border-right-color: transparent;
        animation: waking-spin 0.8s linear infinite;
      }
      @keyframes waking-spin {
        to { transform: rotate(360deg); }
      }
      /* Without motion the spinner would be a static broken ring, which reads as an icon rather
         than as activity — so it becomes a steady dot and the text carries the meaning. */
      @media (prefers-reduced-motion: reduce) {
        .spinner {
          animation: none;
          border-right-color: currentColor;
          opacity: 0.6;
        }
      }
      .sources { list-style: none; padding: 0; margin: 8px 0 0; }
      .source-row {
        display: flex; align-items: center; gap: 10px; justify-content: space-between;
        padding: 6px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }
      .trace { margin-top: 12px; font-size: 0.9em; }
      .trace-step {
        display: flex; gap: 10px; align-items: baseline; padding: 3px 0;
      }
      .trace-step > span:nth-child(2) { flex: 1; }
      .badge { width: 1.2em; display: inline-block; }
      .badge.failed { color: #fca5a5; }
    `,
  ],
})
export class AdminComponent implements OnInit, OnDestroy {
  readonly reportFiles = signal<File[]>([]);
  readonly bankFile = signal<File | null>(null);
  readonly reportBusy = signal(false);
  readonly bankBusy = signal(false);
  readonly reportMsg = signal('');
  readonly bankMsg = signal('');
  readonly status = signal<KnowledgeStatus | null>(null);
  readonly statusErr = signal('');
  readonly statusLoading = signal(false);
  readonly removing = signal<string | null>(null);
  readonly confirmingRemove = signal<string | null>(null);

  // ---- cold-start handling --------------------------------------------------
  //
  // The AI service sleeps when idle. Rather than surface that as an error, the panel says it is
  // waking and retries until it answers — see refreshStatus.

  /** True while a cold start is being waited out. Not an error state. */
  readonly waking = signal(false);
  readonly wakeAttempt = signal(0);
  /** Roughly how long we have been waiting, so the wait is visibly bounded. */
  readonly wakeSeconds = signal(0);

  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- upload progress ------------------------------------------------------
  //
  // Two phases, tracked separately, because they measure different things: pushing bytes is the
  // browser's business and exactly measurable, while indexing is the server's and only knowable by
  // asking it. One combined bar would hit 100% the instant the bytes landed and then sit there for
  // the whole embed — which is exactly when somebody most wants to know it is still alive.

  readonly uploadPhase = signal<'idle' | 'uploading' | 'indexing'>('idle');
  readonly uploadPercent = signal(0);
  readonly uploadName = signal('');
  /** Which file of how many, so a multi-file upload is not an opaque wait. */
  readonly uploadIndex = signal(0);
  readonly uploadTotal = signal(0);

  /**
   * Which meeting an uploaded document belongs to. Empty means shared with all of them.
   *
   * <p>Defaults to shared deliberately. Most documents — the articles, a standing policy, a
   * reference report — apply to every meeting, and requiring a re-upload per meeting would be
   * busywork that also multiplies the index. Scoping is the deliberate choice.
   */
  readonly uploadMeetingId = signal('');
  readonly meetings = signal<MeetingView[]>([]);

  readonly bankPhase = signal<'idle' | 'uploading' | 'indexing'>('idle');
  readonly bankPercent = signal(0);

  private pipelineTimer: ReturnType<typeof setTimeout> | null = null;
  /** Guards against a second poll loop, and stops a re-arm after teardown. */
  private pipelinePolling = false;

  /**
   * The run currently in flight, or null.
   *
   * <p>Read through the polled status rather than tracked separately, so there is one source of
   * truth for what the pipeline is doing and no chance of the bar and the step list disagreeing.
   */
  readonly indexRun = computed<IndexRun | null>(() => this.status()?.last_index_run ?? null);

  /**
   * Which meeting may cite this document, or null when it is shared with all of them.
   *
   * <p>Resolved to the meeting's title rather than shown as a raw id — an operator deciding whether
   * to remove a document cannot do anything useful with a UUID.
   */
  scopeOf(filename: string): string | null {
    const meetingId = this.status()?.scoped_documents?.[filename];
    if (!meetingId) return null;
    const meeting = this.meetings().find((m) => m.id === meetingId);
    // Falls back to the id when the meeting has been deleted: "a meeting that no longer exists" is
    // still more informative than showing it as shared, which would be wrong.
    return meeting ? meeting.title : 'a deleted meeting';
  }

  /** "12s" / "2m 05s" — a duration is easier to judge at a glance than a millisecond count. */
  etaText(ms: number): string {
    const seconds = Math.max(1, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${m}m ${String(rest).padStart(2, '0')}s`;
  }

  private static readonly WAKE_DELAYS_MS = [3000, 5000, 8000, 13000, 21000];
  private static readonly MAX_WAKE_ATTEMPTS = 5;

  constructor(
    private api: ApiService,
    private meetingService: MeetingService,
    protected features: FeatureService,
  ) {}

  ngOnInit(): void {
    // The meeting list, for scoping an upload. Silent on failure: without it the picker simply
    // offers "shared", which is the default anyway.
    this.meetingService.list().subscribe({
      next: (list) => this.meetings.set(list),
      error: () => {},
    });
    // Token is already set by AuthService — the route guard ensures a logged-in moderator.
    this.refreshStatus();
  }

  ngOnDestroy(): void {
    // A pending retry or poll on a page nobody is looking at is a request for nothing.
    this.stopWaking();
    this.stopPipelinePolling();
  }

  /** Manual re-read. Still offered — an automatic retry that cannot be hurried is frustrating. */
  retryStatus(): void {
    this.stopWaking();
    this.refreshStatus();
  }

  /**
   * Re-read the knowledge base status, absorbing a cold start.
   *
   * <h3>Why 503 is treated differently from every other error</h3>
   * The AI service sleeps when idle on a free tier. The backend answers a request it cannot forward
   * with a deliberate <b>503</b> — see {@code AdminController.knowledgeStatus} — and that
   * specifically means "not awake yet", not "broken". A cold start resolves itself in well under a
   * minute, so the honest response is to say what is happening and keep trying, rather than to show
   * a red box for a condition that is about to clear on its own.
   *
   * <p>Any other status is a real failure and is reported immediately without retrying: retrying a
   * 401 or a 500 just delays the bad news behind a spinner.
   */
  private refreshStatus(): void {
    this.statusLoading.set(true);
    if (!this.waking()) this.statusErr.set('');

    this.api.knowledgeStatus().subscribe({
      next: (s) => {
        this.status.set(s);
        this.statusErr.set('');
        this.statusLoading.set(false);
        this.stopWaking();
      },
      error: (err) => {
        this.statusLoading.set(false);
        if (err?.status === 503) {
          this.scheduleWake();
          return;
        }
        // Not a cold start. Report it, and stop any wake loop that was running — continuing to
        // retry would hide a genuine fault behind a reassuring message.
        this.stopWaking();
        this.statusErr.set(
          err?.error?.error ?? 'Could not read the knowledge base. Is the AI service awake?',
        );
      },
    });
  }

  /**
   * Queue the next attempt while the service wakes.
   *
   * <p>Backs off rather than hammering: a service busy loading an embedding model does not benefit
   * from a request every second, and a cold boot is the moment it can least afford them.
   *
   * <p>Bounded. Past the cap this stops claiming the service is "waking" and says plainly that it
   * did not come back — an indefinite spinner is a lie told slowly.
   */
  private scheduleWake(): void {
    if (this.wakeAttempt() >= AdminComponent.MAX_WAKE_ATTEMPTS) {
      this.stopWaking();
      this.statusErr.set(
        'The AI service did not come back after about a minute. It may be down rather than ' +
          'asleep — check its logs, then use Retry.',
      );
      return;
    }

    this.waking.set(true);
    this.wakeAttempt.update((n) => n + 1);

    // 3s, 5s, 8s, 13s, 21s — roughly a minute in total, front-loaded so a quick wake is noticed
    // quickly and a slow one is not pestered.
    const delay = AdminComponent.WAKE_DELAYS_MS[
      Math.min(this.wakeAttempt() - 1, AdminComponent.WAKE_DELAYS_MS.length - 1)
    ];

    this.wakeTimer = setTimeout(() => {
      this.wakeSeconds.update((n) => n + Math.round(delay / 1000));
      this.refreshStatus();
    }, delay);
  }

  private stopWaking(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.waking.set(false);
    this.wakeAttempt.set(0);
    this.wakeSeconds.set(0);
  }

  /**
   * Whether this source can be removed from this screen.
   *
   * <p>Recordings cannot. A transcript is stored as {@code recording-<videoId>.vtt} but listed as
   * "Recording: &lt;title&gt;", and that label cannot be turned back into a filename — the title
   * lives inside the file. Recordings already have their own Remove on the Recordings screen, which
   * deletes the media too, so a second Remove here that did something different would be a trap.
   *
   * <p>A heuristic on the label, pending an explicit kind per source from the server.
   */
  isRemovable(source: string): boolean {
    return !source.startsWith('Recording: ') && source.toLowerCase().endsWith('.pdf');
  }

  pickReport(e: Event): void {
    this.reportFiles.set(Array.from((e.target as HTMLInputElement).files ?? []));
    this.reportMsg.set('');
  }

  pickBank(e: Event): void {
    this.bankFile.set((e.target as HTMLInputElement).files?.[0] ?? null);
    this.bankMsg.set('');
  }

  uploadReport(input?: HTMLInputElement): void {
    const files = this.reportFiles();
    if (!files.length) return;

    this.reportBusy.set(true);
    this.reportMsg.set('');
    this.uploadTotal.set(files.length);
    this.uploadIndex.set(0);
    const done: AnnualReportResult[] = [];

    // Sequential on purpose. The AI service holds one knowledge base behind one lock, so parallel
    // uploads would queue behind each other's re-embedding anyway — and would report progress in
    // an order unrelated to the list the user picked.
    from(files)
      .pipe(
        concatMap((f, i) => {
          this.uploadIndex.set(i + 1);
          this.uploadName.set(f.name);
          this.uploadPhase.set('uploading');
          this.uploadPercent.set(0);
          return this.api.uploadAnnualReport(f, this.uploadMeetingId() || null);
        }),
      )
      .subscribe({
        next: (phase) => {
          if (phase.phase === 'uploading') {
            this.uploadPhase.set('uploading');
            this.uploadPercent.set(phase.percent);
            return;
          }
          if (phase.phase === 'indexing') {
            // The bytes have landed; the wait is now the server's. Start polling so the pipeline's
            // own steps and percentage appear while it works, rather than all at once at the end.
            this.uploadPhase.set('indexing');
            this.uploadPercent.set(100);
            this.startPipelinePolling();
            return;
          }
          done.push(phase.result);
          this.status.set(phase.result);
          this.statusErr.set('');
        },
        error: (err) => {
          this.reportBusy.set(false);

          // THE REQUEST FAILING DOES NOT MEAN THE INDEXING STOPPED.
          //
          // The AI service never learns that the caller gave up: it carries on reading, splitting
          // and embedding to completion. So if a run is still in progress, keep watching it and
          // keep the progress panel up — tearing the view down here was why the percentage and
          // steps vanished mid-run on a large document, which looks far more like data loss than
          // like a timeout.
          const stillRunning = this.indexRun()?.running === true;
          if (stillRunning) {
            this.reportMsg.set(
              'The upload request timed out, but the AI service is still indexing — progress ' +
                'below is live. It will finish on its own.',
            );
            this.uploadPhase.set('indexing');
            this.startPipelinePolling();
            return;
          }

          this.stopPipelinePolling();
          this.reportMsg.set('✗ ' + (err?.error?.error ?? 'Upload failed. Is the server running?'));
          this.uploadPhase.set('idle');
          // Earlier files in the sequence may already be indexed, so re-read rather than assume.
          this.refreshStatus();
        },
        complete: () => {
          this.stopPipelinePolling();
          const chunks = done.reduce((n, r) => n + r.chunks_indexed, 0);
          this.reportMsg.set(
            `✓ Indexed ${done.length} document(s), ${chunks} chunk(s): ` +
              done.map((r) => r.filename).join(', '),
          );
          this.reportFiles.set([]);
          // Clear the picker, or the button stays armed with the same files and a stray second
          // click becomes a same-name re-upload — which re-embeds the entire knowledge base.
          if (input) input.value = '';
          this.reportBusy.set(false);
          this.uploadPhase.set('idle');
        },
      });
  }

  /**
   * Remove one document, on the second click.
   *
   * <p>Two-step rather than {@code window.confirm}: nothing else in this app opens a native dialog,
   * and this is irreversible — the file, its chunks and its embeddings all go, and any citation
   * already written into a drafted answer stops resolving.
   */
  removeSource(source: string): void {
    if (this.confirmingRemove() !== source) {
      this.confirmingRemove.set(source);
      window.setTimeout(() => {
        // Identity re-check: by now the user may have armed a different row, and this timer must
        // not disarm that one.
        if (this.confirmingRemove() === source) this.confirmingRemove.set(null);
      }, 4000);
      return;
    }
    this.confirmingRemove.set(null);
    this.removing.set(source);
    this.api.removeKnowledgeSource(source).subscribe({
      next: (s) => {
        this.status.set(s);
        this.statusErr.set('');
        this.reportMsg.set(
          `✓ Removed “${source}” — ${s.chunks_indexed} chunk(s) across ` +
            `${s.sources.length} source(s) remain.`,
        );
        this.removing.set(null);
      },
      error: (err) => {
        this.reportMsg.set('✗ ' + (err?.error?.error ?? 'Remove failed. Is the server running?'));
        this.removing.set(null);
      },
    });
  }

  uploadBank(): void {
    const file = this.bankFile();
    if (!file) return;

    this.bankBusy.set(true);
    this.bankMsg.set('');
    this.bankPhase.set('uploading');
    this.bankPercent.set(0);

    this.api.uploadQuestionBank(file).subscribe({
      next: (phase) => {
        if (phase.phase === 'uploading') {
          this.bankPercent.set(phase.percent);
          return;
        }
        if (phase.phase === 'indexing') {
          // Every line is embedded and clustered server-side, so this phase is the long one for a
          // bank of any size. No percentage is available for it — the AI service reports its
          // clustering per question, not as a total — so the UI says what is happening instead of
          // inventing a number.
          this.bankPhase.set('indexing');
          this.bankPercent.set(100);
          return;
        }
        this.bankMsg.set(
          `✓ Ingested ${phase.result.ingested} of ${phase.result.received} questions.`,
        );
        this.bankBusy.set(false);
        this.bankPhase.set('idle');
      },
      error: () => {
        this.bankMsg.set('✗ Upload failed. Is the server running?');
        this.bankBusy.set(false);
        this.bankPhase.set('idle');
      },
    });
  }

  // ---- watching the pipeline ------------------------------------------------
  //
  // Once the bytes are sent, the remaining wait is the server reading, splitting and embedding.
  // IndexTrace already records that as named steps with a measured percentage; polling is what
  // makes it visible WHILE it happens rather than in one lump once it has finished.

  private startPipelinePolling(): void {
    if (this.pipelinePolling) return;
    this.pipelinePolling = true;
    this.pollPipelineOnce();
  }

  /**
   * One poll, re-arming itself only after the previous one settles.
   *
   * <h3>Why not setInterval</h3>
   * A fixed 1.2 s interval assumes each poll finishes inside 1.2 s. When the AI service is busy —
   * which, during indexing, is precisely always — it does not. Each late poll still occupies a
   * Tomcat request thread on the backend while its 60-second server-side timeout runs down, so a
   * naive interval reaches roughly 50 requests in flight (60 s ÷ 1.2 s) against a pool of 20.
   *
   * <p>The backend then serves nothing at all — not the board, not sign-in — until the pile drains.
   * A progress bar that can take the whole application down is a bad trade for a progress bar.
   *
   * <p>Self-rearming caps it at ONE outstanding poll, whatever the server is doing. The 8-second
   * client timeout is the second half: it releases the thread long before the server's 60 s would,
   * because a status read that has not answered in 8 seconds is not going to say anything useful.
   */
  private pollPipelineOnce(): void {
    if (!this.pipelinePolling) return;

    this.api
      .knowledgeStatus()
      .pipe(timeout(8000))
      .subscribe({
        next: (s) => {
          this.status.set(s);
          // The poll owns the end of the run as well as its middle: when the upload request has
          // already timed out, this is the ONLY thing that will ever notice it finished.
          if (this.uploadPhase() === 'indexing' && s.last_index_run?.running === false) {
            this.stopPipelinePolling();
            this.uploadPhase.set('idle');
            this.reportMsg.set(
              `✓ Indexing finished — ${s.chunks_indexed} chunk(s) across ${s.sources.length} ` +
                'document(s).',
            );
          }
        },
        // Silent, and still re-arms: a dropped or slow poll during indexing is not worth an error
        // banner, and the upload's own error path still reports a genuine failure.
        error: () => this.rearmPipelinePoll(),
        complete: () => this.rearmPipelinePoll(),
      });
  }

  private rearmPipelinePoll(): void {
    if (!this.pipelinePolling) return;
    this.pipelineTimer = setTimeout(() => this.pollPipelineOnce(), 1200);
  }

  private stopPipelinePolling(): void {
    this.pipelinePolling = false;
    if (this.pipelineTimer) clearTimeout(this.pipelineTimer);
    this.pipelineTimer = null;
  }
}
