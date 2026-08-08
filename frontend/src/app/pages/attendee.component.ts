import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, IngestResult } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import { FeatureService } from '../services/feature.service';
import { RoomService, TopicView } from '../services/room.service';

@Component({
  selector: 'app-attendee',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="container">
      <h1>Ask a question</h1>
      <p class="muted">
        Submit as many as you like. Duplicate/near-duplicate questions are automatically
        merged into a single topic on the moderator board.
      </p>

      <div class="card">
        <label class="sr-only" for="question-text">Your question</label>
        <textarea id="question-text" [ngModel]="text()" (ngModelChange)="text.set($event)" rows="3"
                  placeholder="e.g. When will this year's dividend be paid?"></textarea>
        <div class="row" style="margin-top:12px">
          <label class="muted" style="flex:1">
            Shareholder weight (0–1)
            <input type="number" min="0" max="1" step="0.1"
                   [ngModel]="weight()" (ngModelChange)="weight.set($event)" />
          </label>
          <button (click)="submit()" [disabled]="!text().trim() || busy()">
            {{ busy() ? 'Sending…' : 'Submit' }}
          </button>
        </div>
      </div>

      @if (last(); as l) {
        <div class="card">
          <div class="row">
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
      @if (features.enabled('ATTENDEE_BOARD') && topics().length) {
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
  readonly last = signal<IngestResult | null>(null);
  private attendeeId = 'attendee-' + Math.floor(Math.random() * 1e6);

  /** What the room is asking. Empty when the feature is off or nothing has been asked. */
  readonly topics = signal<TopicView[]>([]);
  /** Cluster id currently being backed, so only that button disables. */
  readonly supporting = signal<string | null>(null);

  private topicsTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private api: ApiService,
    private auth: AuthService,
    protected features: FeatureService,
    private room: RoomService,
  ) {}

  ngOnDestroy(): void {
    if (this.topicsTimer) clearInterval(this.topicsTimer);
  }

  /**
   * Re-read the topics.
   *
   * <p>Failures are swallowed. This is a secondary panel on a page whose job is submitting a
   * question, and an error banner over it would suggest the thing they came to do had failed.
   */
  private loadTopics(): void {
    if (!this.features.enabled('ATTENDEE_BOARD')) return;
    this.room.attendeeBoard(20).subscribe({
      next: (list) => this.topics.set(list),
      error: () => {},
    });
  }

  /** Back a topic, or take that back. */
  support(topic: TopicView): void {
    this.supporting.set(topic.clusterId);
    this.room.supportTopic(topic.clusterId).subscribe({
      next: (result) => {
        this.supporting.set(null);
        // Patch in place. Reloading would re-sort the list under the finger that just tapped it,
        // which reads as the button having moved rather than worked.
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
    // Only borrow an anonymous ATTENDEE token when nobody is signed in.
    //
    // ApiService holds ONE token for the whole application, so fetching an attendee token
    // unconditionally used to overwrite a signed-in member's session the moment they opened this
    // page. The stored role in localStorage was untouched, so the UI still believed it was a
    // moderator and the route guards kept admitting it, while every request went out carrying an
    // ATTENDEE bearer — a valid token with the wrong role, which the server answered with 403 on
    // every role-gated endpoint. It reads as "the whole API broke" and it is really this page.
    //
    // A signed-in member needs no attendee token anyway: /api/questions/** already accepts
    // SHAREHOLDER, MODERATOR and ADMIN, so their own session can submit questions.
    if (this.auth.isAuthenticated()) {
      this.startTopicPolling();
      return;
    }
    this.api.attendeeLogin(this.attendeeId).subscribe((r) => {
      this.api.setToken(r.token);
      // Only after the token is set: the board needs one, and firing before it arrives would just
      // be a guaranteed 401 on first paint.
      this.startTopicPolling();
    });
  }

  /**
   * Load the topics, then keep them fresh.
   *
   * <p>Slower than the moderator board's refresh. Attendees are reading, not running the meeting,
   * and a room full of phones polling hard is load the free tier does not need.
   */
  private startTopicPolling(): void {
    this.loadTopics();
    this.topicsTimer = setInterval(() => this.loadTopics(), 15000);
  }

  submit(): void {
    this.busy.set(true);
    this.api.submitQuestion(this.text().trim(), this.attendeeId, this.weight()).subscribe({
      next: (res) => {
        this.last.set(res);
        this.text.set('');
        this.busy.set(false);
        // Straight away rather than on the next tick: the question they just asked should appear
        // in the list, and a fifteen-second wait would read as it having been dropped.
        this.loadTopics();
      },
      error: () => {
        this.busy.set(false);
        alert('Could not submit — the server may be waking up (free tier). Try again in a moment.');
      },
    });
  }
}
