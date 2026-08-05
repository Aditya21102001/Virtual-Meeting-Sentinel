import { Component, OnInit, signal } from '@angular/core';
import { concatMap, from, toArray } from 'rxjs';
import { ApiService, KnowledgeStatus } from '../services/api.service';

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
          <input #reportInput type="file" accept="application/pdf" multiple (change)="pickReport($event)" />
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
        @if (statusErr()) {
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
                  <span>{{ src }}</span>
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

          <!-- What the pipeline actually did, rather than a spinner that explains nothing. -->
          @if (s.last_index_run; as run) {
            <div class="trace">
              <div class="muted">
                <strong>{{ run.label }}</strong>
                — {{ run.running ? 'in progress…' : run.total_ms + ' ms' }}
              </div>
              @for (step of run.steps; track step.name) {
                <div class="trace-step">
                  <span class="badge" [class.failed]="step.status === 'failed'">
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
          <input type="file" accept=".txt,.csv" (change)="pickBank($event)" />
          <button (click)="uploadBank()" [disabled]="!bankFile() || bankBusy()">
            {{ bankBusy() ? 'Ingesting…' : 'Upload & ingest' }}
          </button>
        </div>
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
export class AdminComponent implements OnInit {
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

  constructor(private api: ApiService) {}

  ngOnInit(): void {
    // Token is already set by AuthService — the route guard ensures a logged-in moderator.
    this.refreshStatus();
  }

  /** Manual re-read, offered next to the error so a sleeping AI service is one click from fixed. */
  retryStatus(): void {
    this.refreshStatus();
  }

  private refreshStatus(): void {
    this.statusLoading.set(true);
    this.statusErr.set('');
    this.api.knowledgeStatus().subscribe({
      next: (s) => {
        this.status.set(s);
        this.statusErr.set('');
        this.statusLoading.set(false);
      },
      // Reported rather than swallowed. Without this an unreachable AI service leaves the panel
      // blank, which reads as "nothing is indexed" at the very moment the Remove controls vanish.
      //
      // The server's own sentence wins when it sent one: it knows whether the AI service is merely
      // waking or genuinely unreachable, and this page cannot tell the difference.
      error: (err) => {
        this.statusErr.set(
          err?.error?.error ?? 'Could not read the knowledge base. Is the AI service awake?',
        );
        this.statusLoading.set(false);
      },
    });
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
    // Sequential on purpose. The AI service holds one knowledge base behind one lock, so parallel
    // uploads would queue behind each other's re-embedding anyway — and would report progress in
    // an order unrelated to the list the user picked.
    from(files)
      .pipe(
        concatMap((f) => this.api.uploadAnnualReport(f)),
        toArray(),
      )
      .subscribe({
        next: (results) => {
          const chunks = results.reduce((n, r) => n + r.chunks_indexed, 0);
          // The last response already carries the post-index status; no second round-trip.
          this.status.set(results[results.length - 1]);
          this.statusErr.set('');
          this.reportMsg.set(
            `✓ Indexed ${results.length} document(s), ${chunks} chunk(s): ` +
              results.map((r) => r.filename).join(', '),
          );
          this.reportFiles.set([]);
          // Clear the picker, or the button stays armed with the same files and a stray second
          // click becomes a same-name re-upload — which re-embeds the entire knowledge base.
          if (input) input.value = '';
          this.reportBusy.set(false);
        },
        error: (err) => {
          this.reportMsg.set('✗ ' + (err?.error?.error ?? 'Upload failed. Is the server running?'));
          this.reportBusy.set(false);
          // Earlier files in the sequence may already be indexed, so re-read rather than assume.
          this.refreshStatus();
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
    this.api.uploadQuestionBank(file).subscribe({
      next: (res) => {
        this.bankMsg.set(`✓ Ingested ${res.ingested} of ${res.received} questions.`);
        this.bankBusy.set(false);
      },
      error: () => {
        this.bankMsg.set('✗ Upload failed. Is the server running?');
        this.bankBusy.set(false);
      },
    });
  }
}
