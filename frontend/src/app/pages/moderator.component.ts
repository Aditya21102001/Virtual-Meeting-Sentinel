import { Component, OnDestroy, OnInit, signal } from "@angular/core";
import {
  ApiService,
  ClusterView,
  parseCitation,
} from "../services/api.service";
import { BoardService } from "../services/board.service";

@Component({
  selector: "app-moderator",
  standalone: true,
  template: `
    <div class="container">
      <div class="row">
        <h1 style="flex:1">Moderator board</h1>
        <span class="badge" [class.hot]="!board.connected()">
          {{ board.connected() ? "live" : "connecting…" }}
        </span>
      </div>
      <p class="muted">
        Questions ranked by how many people asked × shareholder weight. Updates
        in real time.
      </p>

      @if (error()) {
        <div
          class="card"
          style="border-color:var(--accent); color:var(--accent)"
        >
          {{ error() }}
        </div>
      }

      @if (board.board().length === 0) {
        <div class="card muted">
          No questions yet. Open the “Ask a question” tab and submit a few.
        </div>
      }

      @for (c of board.board(); track c.cluster_id) {
        <div class="card">
          <div class="q">{{ c.representative_question }}</div>
          <div class="row">
            <span class="badge" [class.hot]="c.size >= 3"
              >{{ c.size }} asked</span
            >
            <span class="muted">priority {{ c.priority_score }}</span>

            <!-- Where the answer stands. PENDING means the model is still working on it. -->
            @switch (c.draft_status) {
              @case ("PENDING") {
                <span class="badge">⏳ drafting…</span>
              }
              @case ("NEEDS_MANUAL") {
                <span class="badge hot">✍ needs your answer</span>
              }
              @case ("MANUAL") {
                <span class="badge"
                  >✍ answered{{ c.answered_by ? " by " + c.answered_by : "" }}</span
                >
              }
            }

            <span style="flex:1"></span>
            @if (editing() !== c.cluster_id) {
              <button class="ghost" (click)="startWriting(c)">
                {{ c.draft ? "Edit answer" : "Write answer" }}
              </button>
            }
            <button
              (click)="draft(c)"
              [disabled]="drafting().has(c.cluster_id)"
            >
              {{
                drafting().has(c.cluster_id)
                  ? "Drafting…"
                  : c.draft_status === "NEEDS_MANUAL"
                    ? "Try model again"
                    : "Draft answer"
              }}
            </button>
          </div>

          <!--
            The model could not answer this one. Say why, so the moderator knows whether to wait
            for the service to come back or just write it.
          -->
          @if (c.draft_status === "NEEDS_MANUAL" && c.draft_error && editing() !== c.cluster_id) {
            <p class="muted note">
              The model could not draft this: {{ c.draft_error }}
            </p>
          }

          @if (editing() === c.cluster_id) {
            <textarea
              rows="5"
              class="answer-box"
              [value]="answerDraft()"
              (input)="answerDraft.set($any($event.target).value)"
              placeholder="Write the answer to read out…"
            ></textarea>
            <div class="row">
              <button (click)="saveAnswer(c)" [disabled]="!answerDraft().trim() || saving()">
                {{ saving() ? "Saving…" : "Save answer" }}
              </button>
              <button class="ghost" (click)="cancelWriting()">Cancel</button>
            </div>
          }

          @if (c.draft && editing() !== c.cluster_id) {
            <div class="draft">{{ c.draft }}</div>
            @if (c.citations.length) {
              <div class="cite">
                <strong>Sources</strong> (from the annual report — click to open
                at the page):
                <ul style="margin:6px 0 0; padding-left:18px">
                  @for (cit of c.citations; track cit.source) {
                    <li>
                      <a
                        [href]="link(cit.source).url"
                        target="_blank"
                        rel="noopener"
                        [title]="cit.snippet"
                      >
                        {{ cit.source }}
                      </a>
                    </li>
                  }
                </ul>
              </div>
            }
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      .answer-box {
        width: 100%;
        margin: 10px 0 8px;
        padding: 10px;
        border-radius: 8px;
        border: 1px solid #334155;
        background: #0b1220;
        color: inherit;
        font: inherit;
        resize: vertical;
      }
      .note {
        margin: 8px 0 0;
        font-size: 13px;
      }
    `,
  ],
})
export class ModeratorComponent implements OnInit, OnDestroy {
  readonly drafting = signal<Set<string>>(new Set());
  readonly error = signal<string | null>(null);
  private pollHandle?: ReturnType<typeof setInterval>;
  private destroyed = false;

  // ---- writing an answer by hand -------------------------------------------
  //
  // The fallback for a cluster the model could not answer. Also available for any cluster, since a
  // moderator reading a draft aloud may simply want to reword it.

  /** Cluster id whose answer box is open, or null. */
  readonly editing = signal<string | null>(null);
  readonly answerDraft = signal('');
  readonly saving = signal(false);

  /** Open the box, pre-filled with whatever answer already exists so an edit starts from it. */
  startWriting(c: ClusterView): void {
    this.editing.set(c.cluster_id);
    this.answerDraft.set(c.draft ?? '');
  }

  cancelWriting(): void {
    this.editing.set(null);
    this.answerDraft.set('');
  }

  saveAnswer(c: ClusterView): void {
    const answer = this.answerDraft().trim();
    if (!answer) return;
    this.saving.set(true);
    this.api.saveAnswer(c.cluster_id, answer).subscribe({
      next: (updated) => {
        this.saving.set(false);
        this.cancelWriting();
        // Patch the row in place rather than re-fetching: the board is ranked by the AI service and
        // a full reload could reorder the card the moderator is looking at.
        this.board.board.update((list) =>
          list.map((row) => (row.cluster_id === updated.cluster_id ? { ...row, ...updated } : row)),
        );
      },
      error: () => {
        this.saving.set(false);
        this.error.set('Could not save that answer. Try again in a moment.');
      },
    });
  }

  constructor(
    private api: ApiService,
    protected board: BoardService,
  ) {}

  ngOnInit(): void {
    // Token is already set by AuthService — the route guard ensures a logged-in moderator.
    this.loadSnapshot(); // initial snapshot
    this.board.connect(); // then live pushes over STOMP

    // Fallback poll: live WebSocket pushes can drop (esp. behind free-tier proxies), and a
    // just-asked question needs a moment to cluster. Re-fetch every 45s so new questions
    // appear on the board without a manual page refresh.
    this.pollHandle = setInterval(() => {
      if (this.destroyed) return;
      this.loadSnapshot();
    }, 45000);
  }

  /** Pull the current ranked board via REST; used for the initial load and the fallback poll. */
  private loadSnapshot(): void {
    if (this.destroyed) return;
    this.error.set(null);
    this.api.getBoard().subscribe({
      next: (b) => {
        this.board.board.set(b);
        this.error.set(null);
      },
      error: (err) => {
        const message =
          err?.status === 403
            ? "The board is temporarily unavailable. Please try again in a moment."
            : "We could not load the board right now.";
        this.error.set(message);
      },
    });
  }

  /** Build the page-anchored PDF link for a citation source string. */
  link(source: string) {
    return parseCitation(source);
  }

  draft(c: ClusterView): void {
    this.mutateDrafting((s) => s.add(c.cluster_id));
    this.api.requestDraft(c.cluster_id, c.representative_question).subscribe({
      next: () => this.mutateDrafting((s) => s.delete(c.cluster_id)),
      error: () => this.mutateDrafting((s) => s.delete(c.cluster_id)),
    });
  }

  /** Signals need a new reference to notify; clone the Set on each change. */
  private mutateDrafting(fn: (s: Set<string>) => void): void {
    const next = new Set(this.drafting());
    fn(next);
    this.drafting.set(next);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
    this.board.disconnect();
  }
}
