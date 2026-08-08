import { Component, OnDestroy, OnInit, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import {
  ApiService,
  Citation,
  CitationTarget,
  ClusterView,
  MergedAway,
  QuestionInCluster,
  citationTarget,
  parseCitation,
} from "../services/api.service";
import { BoardService } from "../services/board.service";
import { FeatureService } from "../services/feature.service";
import { RoomService, TopicView } from "../services/room.service";

@Component({
  selector: "app-moderator",
  imports: [RouterLink],
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

            <!--
              Run of show. The timer and the start/finish pair are how a chair keeps to time; the
              position number is what the attendee board orders by.
            -->
            @if (features.enabled("RUN_OF_SHOW")) {
              @if (runState(c); as r) {
                @if (r.runOrder !== null) {
                  <span class="badge" title="Position in the running order">#{{ r.runOrder }}</span>
                }
                @if (r.underDiscussion) {
                  <span class="badge hot" role="status">on now</span>
                } @else if (r.secondsSpent !== null) {
                  <span class="muted-inline">took {{ minutes(r.secondsSpent) }}</span>
                }
              }
            }

            <span style="flex:1"></span>

            @if (features.enabled("ATTENDEE_BOARD")) {
              <!--
                Publishing is opt-in and stays that way: nearly every answer here was written by a
                model and read by nobody, and showing one to the room states it as the company's.
              -->
              <button
                class="ghost"
                [disabled]="roomBusy() === c.cluster_id || !c.draft"
                [attr.aria-pressed]="isPublished(c)"
                [title]="c.draft ? '' : 'There is no answer to publish yet'"
                (click)="togglePublished(c)"
              >
                {{ isPublished(c) ? "👁 Published to room" : "Publish to room" }}
              </button>
            }
            @if (features.enabled("RUN_OF_SHOW")) {
              @if (runState(c)?.underDiscussion) {
                <button class="ghost" (click)="endTopic(c)" [disabled]="roomBusy() === c.cluster_id">
                  Finish topic
                </button>
              } @else {
                <button class="ghost" (click)="startTopic(c)" [disabled]="roomBusy() === c.cluster_id">
                  Take this next
                </button>
              }
            }
            @if (features.enabled("CLUSTER_CURATION") && editing() !== c.cluster_id) {
              <button class="ghost" (click)="toggleCuration(c)">
                {{ curating() === c.cluster_id ? "▾" : "▸" }} Grouping
              </button>
            }
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

          <!--
            Curation. Open on demand rather than always visible: most clusters are grouped
            correctly, and putting a merge control on every card invites fiddling with groupings
            that were fine.
          -->
          @if (curating() === c.cluster_id) {
            <div class="curation">
              @if (curationLoading()) {
                <p class="muted note">Loading the questions in this group…</p>
              } @else {
                <p class="muted note">
                  These are the questions grouped together here. Tick any that do not belong and
                  separate them out, or fold this whole group into another one.
                </p>

                <fieldset class="q-list">
                  <legend class="sr-only">Questions in this group</legend>
                  @for (q of curationQuestions(); track q.id) {
                    <label class="q-row">
                      <input
                        type="checkbox"
                        [checked]="selected().has(q.id)"
                        (change)="toggleSelected(q.id)"
                      />
                      <span>{{ q.text }}</span>
                    </label>
                  }
                </fieldset>

                @if (curationMerged().length) {
                  <p class="muted note">
                    Already folded in:
                    @for (m of curationMerged(); track m.clusterId) {
                      <em>“{{ m.question }}”</em>
                      @if (m.mergedBy) { (by {{ m.mergedBy }}) }
                    }
                  </p>
                }

                <div class="row curation-actions">
                  <button
                    class="ghost"
                    (click)="split(c)"
                    [disabled]="!selected().size || curationBusy()"
                  >
                    Separate {{ selected().size || "" }} out
                  </button>

                  <label class="merge-into">
                    <span class="sr-only">Fold this group into</span>
                    <select
                      [value]="mergeTarget()"
                      (change)="mergeTarget.set($any($event.target).value)"
                    >
                      <option value="">Fold this group into…</option>
                      @for (other of otherClusters(c); track other.cluster_id) {
                        <option [value]="other.cluster_id">
                          {{ other.representative_question }}
                        </option>
                      }
                    </select>
                  </label>
                  <button (click)="merge(c)" [disabled]="!mergeTarget() || curationBusy()">
                    Fold in
                  </button>
                </div>

                <p class="muted note">
                  Folding also applies to questions nobody has asked yet — later ones that would
                  have landed here go to the other group instead. Separating out only moves the
                  questions above; similar ones asked later will be grouped as normal.
                </p>
              }
            </div>
          }

          @if (c.draft && editing() !== c.cluster_id) {
            <div class="draft">{{ c.draft }}</div>
            @if (c.citations.length) {
              <div class="cite">
                <strong>Sources</strong> — a report page, or the moment it was
                said on the call:
                <ul style="margin:6px 0 0; padding-left:18px">
                  @for (cit of c.citations; track cit.source) {
                    <li>
                      @if (target(cit); as t) {
                        @if (t.internal) {
                          <!-- In-app route: routerLink, so it does not reload the SPA. -->
                          <a [routerLink]="['/recordings']" [queryParams]="recordingParams(cit)" [title]="cit.snippet">
                            ▶ {{ cit.source }}
                          </a>
                        } @else {
                          <a [href]="t.url" target="_blank" rel="noopener" [title]="cit.snippet">
                            {{ cit.source }}
                          </a>
                        }
                      }
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

      /* Screen-reader-only: the fieldset needs a name, but the paragraph above it already says
         the same thing to anyone who can see it. */
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
      }

      .curation {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px dashed #334155;
      }
      .q-list {
        border: 0;
        margin: 8px 0;
        padding: 0;
      }
      .q-row {
        display: flex;
        gap: 9px;
        align-items: flex-start;
        padding: 6px 0;
        cursor: pointer;
        font-size: 14px;
      }
      .q-row + .q-row {
        border-top: 1px solid rgba(128, 128, 128, 0.15);
      }
      .q-row input {
        margin-top: 3px;
        flex: 0 0 auto;
      }
      .curation-actions {
        gap: 10px;
        flex-wrap: wrap;
      }
      .merge-into select {
        max-width: 320px;
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

  // ---- curation: fixing the grouping ----------------------------------------
  //
  // Grouping is done automatically by meaning, and automatic grouping is wrong in both directions —
  // it splits one topic phrased two ways, and lumps two topics that share vocabulary. Until this
  // existed a moderator could see that and do nothing about it.

  /** Cluster id whose grouping panel is open, or null. */
  readonly curating = signal<string | null>(null);
  readonly curationLoading = signal(false);
  readonly curationBusy = signal(false);
  readonly curationQuestions = signal<QuestionInCluster[]>([]);
  readonly curationMerged = signal<MergedAway[]>([]);
  /** Question ids ticked for separating out. */
  readonly selected = signal<Set<string>>(new Set());
  readonly mergeTarget = signal('');

  toggleCuration(c: ClusterView): void {
    if (this.curating() === c.cluster_id) {
      this.closeCuration();
      return;
    }
    this.curating.set(c.cluster_id);
    this.selected.set(new Set());
    this.mergeTarget.set('');
    this.curationQuestions.set([]);
    this.curationMerged.set([]);
    this.curationLoading.set(true);

    this.api.clusterQuestions(c.cluster_id).subscribe({
      next: (view) => {
        this.curationQuestions.set(view.questions);
        this.curationMerged.set(view.mergedIn);
        this.curationLoading.set(false);
      },
      error: () => {
        this.curationLoading.set(false);
        this.error.set('Could not load the questions in that group.');
        this.closeCuration();
      },
    });
  }

  private closeCuration(): void {
    this.curating.set(null);
    this.curationQuestions.set([]);
    this.curationMerged.set([]);
    this.selected.set(new Set());
    this.mergeTarget.set('');
  }

  toggleSelected(questionId: string): void {
    // A new Set each time: signals compare by reference, and mutating in place would not notify.
    this.selected.update((current) => {
      const next = new Set(current);
      if (!next.delete(questionId)) next.add(questionId);
      return next;
    });
  }

  /** Everything except this cluster — the candidates to fold it into. */
  otherClusters(c: ClusterView): ClusterView[] {
    return this.board.board().filter((row) => row.cluster_id !== c.cluster_id);
  }

  split(c: ClusterView): void {
    const ids = [...this.selected()];
    if (!ids.length) return;
    this.curationBusy.set(true);
    this.error.set(null);
    this.api.splitCluster(c.cluster_id, ids).subscribe({
      next: (rebuilt) => {
        this.curationBusy.set(false);
        this.board.board.set(rebuilt);
        this.closeCuration();
      },
      error: (err) => {
        this.curationBusy.set(false);
        // The server's message is the specific one — "that would move every question out" — and it
        // tells the moderator what to do differently.
        this.error.set(err?.error?.message ?? 'Could not separate those questions out.');
      },
    });
  }

  merge(c: ClusterView): void {
    const target = this.mergeTarget();
    if (!target) return;
    this.curationBusy.set(true);
    this.error.set(null);
    this.api.mergeClusters(c.cluster_id, target).subscribe({
      next: (rebuilt) => {
        this.curationBusy.set(false);
        this.board.board.set(rebuilt);
        this.closeCuration();
      },
      error: (err) => {
        this.curationBusy.set(false);
        this.error.set(err?.error?.message ?? 'Could not fold those groups together.');
      },
    });
  }

  // ---- run of show, and releasing an answer to the room ---------------------
  //
  // The board itself is the AI service's ranking. This is the layer over it: which topic is being
  // taken now, how long each took, and which answers the room may see.

  /**
   * Run-of-show state per cluster, from a separate endpoint.
   *
   * <p>Kept beside the board rather than folded into it: the board's shape is the AI service's, and
   * widening it to carry meeting-running state would tie two things together that fail
   * independently — the run of show should still work when the clusterer is asleep.
   */
  readonly roomTopics = signal<Map<string, TopicView>>(new Map());
  /** Cluster id currently being changed, so only that card's buttons disable. */
  readonly roomBusy = signal<string | null>(null);

  runState(c: ClusterView): TopicView | undefined {
    return this.roomTopics().get(c.cluster_id);
  }

  /**
   * Whether the room can see this answer.
   *
   * <p>Read from the server's flag, not from whether an answer exists. This view returns every
   * answer including unpublished drafts, so inferring it would mark everything as published — and
   * a moderator trusting that button would believe the room had seen answers it never did.
   */
  isPublished(c: ClusterView): boolean {
    return this.runState(c)?.published === true;
  }

  /** "4m 12s" — seconds alone are hard to read at a glance while chairing. */
  minutes(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m ? `${m}m ${s}s` : `${s}s`;
  }

  private loadRoom(): void {
    if (!this.features.enabled('RUN_OF_SHOW') && !this.features.enabled('ATTENDEE_BOARD')) return;
    this.room.runOfShow().subscribe({
      next: (topics) => this.applyRoom(topics),
      // Silent: this is an overlay on a board that is useful without it.
      error: () => {},
    });
  }

  private applyRoom(topics: TopicView[]): void {
    this.roomTopics.set(new Map(topics.map((t) => [t.clusterId, t])));
  }

  startTopic(c: ClusterView): void {
    this.roomBusy.set(c.cluster_id);
    this.room.startTopic(c.cluster_id).subscribe({
      next: (topics) => {
        this.roomBusy.set(null);
        this.applyRoom(topics);
      },
      error: (err) => {
        this.roomBusy.set(null);
        this.error.set(err?.error?.message ?? 'Could not start that topic.');
      },
    });
  }

  endTopic(c: ClusterView): void {
    this.roomBusy.set(c.cluster_id);
    this.room.endTopic(c.cluster_id).subscribe({
      next: (topics) => {
        this.roomBusy.set(null);
        this.applyRoom(topics);
      },
      error: (err) => {
        this.roomBusy.set(null);
        this.error.set(err?.error?.message ?? 'Could not finish that topic.');
      },
    });
  }

  togglePublished(c: ClusterView): void {
    const next = !this.isPublished(c);
    this.roomBusy.set(c.cluster_id);
    this.room.publishAnswer(c.cluster_id, next).subscribe({
      next: () => {
        this.roomBusy.set(null);
        this.loadRoom();
      },
      error: (err) => {
        this.roomBusy.set(null);
        this.error.set(err?.error?.message ?? 'Could not change what the room can see.');
      },
    });
  }

  constructor(
    private api: ApiService,
    protected board: BoardService,
    protected features: FeatureService,
    private room: RoomService,
  ) {}

  ngOnInit(): void {
    // Token is already set by AuthService — the route guard ensures a logged-in moderator.
    this.loadSnapshot(); // initial snapshot
    this.loadRoom();     // the run-of-show layer over it
    this.board.connect(); // then live pushes over STOMP

    // Fallback poll: live WebSocket pushes can drop (esp. behind free-tier proxies), and a
    // just-asked question needs a moment to cluster. Re-fetch every 45s so new questions
    // appear on the board without a manual page refresh.
    this.pollHandle = setInterval(() => {
      if (this.destroyed) return;
      this.loadSnapshot();
      // Refreshed alongside, so a topic another moderator started shows as running here too.
      this.loadRoom();
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
        // A 403 is a permissions answer, not a transient one. Calling it "temporarily unavailable"
        // invites the user to retry something that will fail identically every time, and hides the
        // one fact that would help them: this account cannot load the board.
        const message =
          err?.status === 403
            ? "Your account does not have moderator access to the board. Sign in again, or ask an administrator to restore the role."
            : "We could not load the board right now.";
        this.error.set(message);
      },
    });
  }

  /** Build the page-anchored PDF link for a citation source string. */
  link(source: string) {
    return parseCitation(source);
  }

  /** Where this citation leads — a report page, or a moment in a recording. */
  target(citation: Citation): CitationTarget {
    return citationTarget(citation);
  }

  /** Query params for a recording citation, so routerLink can deep-link into the player. */
  recordingParams(citation: Citation): Record<string, string> {
    const at = Math.max(0, Math.floor(citation.at_seconds ?? 0));
    return at > 0
      ? { v: citation.video_id!, t: String(at) }
      : { v: citation.video_id! };
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
