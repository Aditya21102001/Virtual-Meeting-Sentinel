import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { PlayerHostService } from '../services/player-host.service';
import { FeatureService } from '../services/feature.service';
import {
  CommentView,
  DownloadOption,
  SegmentView,
  VideoCard,
  VideoService,
  humanBytes,
  timecode,
} from '../services/video.service';

/**
 * The recordings library any signed-in member sees: pick a recording, watch it on demand.
 *
 * <p>The catalogue call returns each entry with its playback ticket already embedded in the media
 * URLs, so posters render and playback starts without a second round trip.
 */
@Component({
  selector: 'app-videos',
  standalone: true,
  imports: [DatePipe],
  template: `
    <div class="container">
      <h1>Meeting recordings</h1>
      <p class="muted">
        Recordings stream on demand — the player fetches the few seconds around the playhead, so a
        long meeting starts instantly and seeking anywhere in it is immediate.
      </p>

      @if (loading()) {
        <div class="card"><span class="muted">Loading library…</span></div>
      } @else if (error()) {
        <div class="error-box">{{ error() }}</div>
      } @else if (!cards().length) {
        <div class="card">
          <div class="q">No recordings yet</div>
          <p class="muted">
            A moderator can upload one under <strong>Setup → Video library</strong>.
          </p>
        </div>
      }

      <!-- Now playing -->
      @if (selected(); as card) {
        <div class="card">
          <!--
            An empty slot, not the player.

            The player is mounted once in AppComponent, outside the router outlet, and positioned
            over this box. It has to be: a picture-in-picture session ends the moment its <video>
            element leaves the document, and leaving this page would take the element with it.

            This div only reserves the space and reports where it is — see PlayerHostService.
          -->
          <div class="player-slot" [class.theater]="playerHost.theater()" #playerSlot></div>

          <h2 class="title">{{ card.video.title }}</h2>
          @if (card.video.description) {
            <p class="desc">{{ card.video.description }}</p>
          }

          <div class="row facts">
            <span class="badge">{{ timecode(card.video.durationSeconds) }}</span>
            @if (card.video.height) {
              <span class="badge">up to {{ card.video.height }}p</span>
            }
            @if (card.adaptive) {
              <span class="badge"
                >{{ card.video.renditions.length }} quality level(s)</span
              >
              <span class="badge"
                >{{ card.video.totalSegments }} segments ·
                {{ card.video.segmentSeconds }}s each</span
              >
            } @else {
              <span class="badge">progressive (HTTP Range)</span>
            }
            <span class="muted">{{ humanBytes(card.video.sizeBytes) }} source</span>

            <!--
              Distinct viewers, not plays. Hidden at zero rather than shown as "0 views": a board
              recording nobody has opened yet is the normal state right after a meeting, and saying
              so on every card reads as a failure rather than as a fact.
            -->
            @if (card.engagement?.viewers) {
              <span class="muted">{{ viewerLabel(card.engagement!.viewers) }}</span>
            }

            <button
              class="link"
              type="button"
              [class.liked]="card.engagement?.likedByMe"
              (click)="toggleLike(card)"
              [disabled]="liking()"
              [attr.aria-pressed]="card.engagement?.likedByMe"
            >
              {{ card.engagement?.likedByMe ? '♥' : '♡' }}
              {{ card.engagement?.likes ?? 0 }}
            </button>

            <button class="link" type="button" (click)="share(card)">⇪ Share</button>

            <!--
              Autoplay. Off by default and shown next to the recording it affects, rather than
              buried in settings — these are board meetings, and rolling into an unrelated one is
              something a viewer should be choosing on purpose each time.
            -->
            @if (playerHost.upNext(); as next) {
              <button
                class="link"
                type="button"
                [class.liked]="playerHost.autoplayNext()"
                (click)="playerHost.autoplayNext.set(!playerHost.autoplayNext())"
                [attr.aria-pressed]="playerHost.autoplayNext()"
                [title]="'Up next: ' + next.video.title"
              >
                Autoplay {{ playerHost.autoplayNext() ? 'on' : 'off' }}
              </button>
            }

            <button
              class="link"
              type="button"
              (click)="openDownloads(card)"
              [disabled]="downloading()"
            >
              {{ downloading() ? 'Loading…' : '⭳ Download' }}
            </button>
          </div>

          <!--
            Every rung is a complete copy of the recording, so each is its own download. The
            original appears only when it is still stored; its absence costs formats, not the feature.
          -->
          @if (downloadOptions().length) {
            <div class="downloads">
              @for (option of downloadOptions(); track option.url) {
                <button class="chip" type="button" (click)="startDownload(option)">
                  {{ option.label }}
                  <span class="muted-inline">{{ humanBytes(option.sizeBytes) }}</span>
                </button>
              }
              <button class="link" type="button" (click)="closeDownloads()">Cancel</button>
            </div>
          }

          @if (shareNote()) {
            <p class="muted note">{{ shareNote() }}</p>
            <input
              class="share-link"
              type="text"
              readonly
              [value]="shareLink()"
              (click)="$any($event.target).select()"
              aria-label="Shareable link"
            />
          }
          @if (downloadNote()) {
            <p class="muted note">{{ downloadNote() }}</p>
          }
          @if (downloadError()) {
            <p class="note error-note">{{ downloadError() }}</p>
          }

          @if (!card.adaptive && card.video.errorMessage) {
            <p class="muted note">{{ card.video.errorMessage }}</p>
          }

          <!-- Segment inspector: proves the recording really is stored as slices. -->
          @if (card.adaptive) {
            <div class="inspector">
              <button class="link" type="button" (click)="toggleSegments(card)">
                {{ segmentsOpen() ? '▾' : '▸' }} Segment index
              </button>
              @if (segmentsOpen()) {
                <div class="row" style="margin:8px 0">
                  @for (rendition of card.video.renditions; track rendition.name) {
                    <button
                      class="chip"
                      type="button"
                      [class.on]="activeRendition() === rendition.name"
                      (click)="loadSegments(card, rendition.name)"
                    >
                      {{ rendition.height }}p
                      <span class="muted-inline">{{ rendition.segmentCount }}</span>
                    </button>
                  }
                </div>
                @if (segmentsLoading()) {
                  <span class="muted">Loading…</span>
                } @else if (segments().length) {
                  <div class="seg-scroll">
                    <table class="seg-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Starts</th>
                          <th>Length</th>
                          <th>Size</th>
                          <th>File</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (segment of segments(); track segment.seq) {
                          <tr>
                            <td>{{ segment.seq }}</td>
                            <td>
                              <button
                                class="link"
                                type="button"
                                (click)="jumpTo(segment)"
                                title="Jump to this segment"
                              >
                                {{ timecode(segment.startSeconds) }}
                              </button>
                            </td>
                            <td>{{ segment.durationSeconds.toFixed(2) }}s</td>
                            <td>{{ humanBytes(segment.byteSize) }}</td>
                            <td class="mono">{{ segment.filename }}</td>
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                  <p class="muted note">
                    Seeking to any row costs one request for that slice — not the whole recording.
                  </p>
                }
              }
            </div>
          }

          <!-- Transcript: searchable, and every line is a seek target. -->
          @if (cues().length) {
            <div class="inspector">
              <button class="link" type="button" (click)="transcriptOpen.set(!transcriptOpen())">
                {{ transcriptOpen() ? '▾' : '▸' }} Transcript
                <span class="muted-inline">{{ cues().length }} lines</span>
              </button>
              @if (transcriptOpen()) {
                <input
                  class="search"
                  type="search"
                  placeholder="Search the transcript…"
                  [value]="transcriptQuery()"
                  (input)="transcriptQuery.set($any($event.target).value)"
                />
                @if (!visibleCues().length) {
                  <p class="muted note">Nothing matches “{{ transcriptQuery() }}”.</p>
                } @else {
                  <div class="cue-scroll">
                    @for (cue of visibleCues(); track cue.startSeconds) {
                      <button class="cue" type="button" (click)="jumpToCue(cue.startSeconds)">
                        <span class="cue-time">{{ timecode(cue.startSeconds) }}</span>
                        <span class="cue-text">{{ cue.text }}</span>
                      </button>
                    }
                  </div>
                }
              }
            </div>
          }

          <!-- Comments -->
          <div class="inspector">
            <button class="link" type="button" (click)="toggleComments(card)">
              {{ commentsOpen() ? '▾' : '▸' }} Comments
              <span class="muted-inline">{{ card.engagement?.comments ?? 0 }}</span>
            </button>

            @if (commentsOpen()) {
              <div class="composer">
                <textarea
                  rows="2"
                  placeholder="Add a comment…"
                  [value]="commentBody()"
                  (input)="commentBody.set($any($event.target).value)"
                ></textarea>
                <div class="row">
                  <label class="pin">
                    <input
                      type="checkbox"
                      [checked]="pinToTime()"
                      (change)="pinToTime.set($any($event.target).checked)"
                    />
                    at {{ timecode(playheadNow()) }}
                  </label>
                  <button (click)="postComment(card)" [disabled]="!commentBody().trim() || posting()">
                    {{ posting() ? 'Posting…' : 'Post' }}
                  </button>
                </div>
                @if (commentError()) {
                  <p class="note error-note">{{ commentError() }}</p>
                }
              </div>

              @if (commentsLoading()) {
                <span class="muted">Loading…</span>
              } @else if (!comments().length) {
                <p class="muted note">No comments yet. Be the first.</p>
              } @else {
                @for (c of comments(); track c.id) {
                  <div class="comment">
                    <div class="comment-head">
                      <strong>{{ c.author }}</strong>
                      @if (c.atSeconds !== null) {
                        <button
                          class="link"
                          type="button"
                          (click)="jumpToCue(c.atSeconds!)"
                          title="Jump to this moment"
                        >
                          {{ timecode(c.atSeconds) }}
                        </button>
                      }
                      <span class="muted-inline">{{ c.createdAt | date: 'short' }}</span>
                      <span style="flex:1"></span>
                      @if (c.canDelete) {
                        <button class="link" type="button" (click)="removeComment(card, c)">
                          Delete
                        </button>
                      }
                    </div>
                    <p class="comment-body">{{ c.body }}</p>
                  </div>
                }
              }
            }
          </div>
        </div>
      }

      <!--
        Continue watching. Above the library and only when there is something to continue: a row
        that is usually empty trains people to scroll past the top of the page.
      -->
      @if (!selected() && continueWatching().length) {
        <h2 class="section">Continue watching</h2>
        <div class="grid continue-grid">
          @for (card of continueWatching(); track card.video.id) {
            <button class="tile" type="button" (click)="play(card)">
              <span class="thumb">
                @if (card.posterUrl) {
                  <img [src]="card.posterUrl" alt="" loading="lazy" />
                }
                <!--
                  How far in they are, drawn over the thumbnail as YouTube does. The bar is the
                  whole point of this row — without it these are just recently-opened recordings.
                -->
                <span class="resume-bar">
                  <span class="resume-fill" [style.width.%]="watchedPercent(card)"></span>
                </span>
              </span>
              <span class="tile-title">{{ card.video.title }}</span>
              <span class="muted-inline">
                {{ timecode(card.engagement?.resumeAtSeconds ?? 0) }} watched
              </span>
            </button>
          }
        </div>
      }

      <!-- Library grid -->
      @if (cards().length) {
        <h2 class="section">{{ selected() ? 'More recordings' : 'Library' }}</h2>
        @if (anyProcessing()) {
          <p class="muted" style="margin:-4px 0 10px">
            Some recordings are still being prepared. This page does not poll the server —
            <button class="link" type="button" (click)="reload()" [disabled]="refreshing()">
              {{ refreshing() ? 'refreshing…' : 'refresh' }}
            </button>
            when you want the latest.
          </p>
        }
        <div class="grid">
          @for (card of others(); track card.video.id) {
            <button
              class="tile"
              type="button"
              [class.pending]="isProcessing(card)"
              [disabled]="isProcessing(card)"
              (click)="play(card)"
            >
              <span class="thumb">
                @if (card.posterUrl) {
                  <img [src]="card.posterUrl" [alt]="card.video.title" loading="lazy" />
                } @else {
                  <span class="thumb-fallback">{{ isProcessing(card) ? '⏳' : '▶' }}</span>
                }
                @if (!isProcessing(card)) {
                  <span class="thumb-time">{{ timecode(card.video.durationSeconds) }}</span>
                }
              </span>
              <span class="tile-title">{{ card.video.title }}</span>
              @if (isProcessing(card)) {
                <span class="bar"
                  ><span class="bar-fill" [style.width.%]="card.video.progressPercent"></span
                ></span>
                <span class="muted tile-meta">
                  Processing — {{ card.video.progressPercent }}%. It appears here when ready.
                </span>
              } @else {
                <span class="muted tile-meta">
                  @if (card.adaptive) {
                    {{ card.video.height }}p · {{ card.video.totalSegments }} segments
                  } @else {
                    {{ humanBytes(card.video.sizeBytes) }}
                  }
                </span>
              }
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      /*
        The same box the player draws itself into (see .player in VideoPlayerComponent): 16/9 and
        full width. If these two ever disagree the player will sit slightly off its slot, so they
        are deliberately identical.
      */
      /*
        Theater mode. Breaks out of the container's max-width with a viewport-wide negative margin,
        which is why it is a class on the SLOT and not on the player: the player is positioned over
        whatever box this element reports, so widening this is the whole implementation — the
        existing ResizeObserver re-measures and the layer follows.
      */
      .player-slot.theater {
        width: 100vw;
        max-width: 100vw;
        margin-left: calc(50% - 50vw);
        margin-right: calc(50% - 50vw);
        border-radius: 0;
      }
      .player-slot {
        aspect-ratio: 16 / 9;
        width: 100%;
        background: #000;
        border-radius: 12px;
      }
      .title {
        font-size: 18px;
        margin: 14px 0 4px;
      }
      .desc {
        margin: 0 0 10px;
        font-size: 14px;
        color: var(--text);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .facts {
        gap: 8px;
        margin-bottom: 4px;
      }
      .note {
        margin: 8px 0 0;
      }
      .error-note {
        color: #fca5a5;
      }
      .liked {
        color: #fb7185;
      }
      .downloads {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
      }
      .share-link {
        width: 100%;
        margin: 4px 0 0;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid #334155;
        background: #0b1220;
        color: var(--muted);
        font: inherit;
        font-size: 13px;
      }

      /* ---- transcript ---- */
      .search {
        width: 100%;
        margin: 8px 0;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid #334155;
        background: #0b1220;
        color: inherit;
        font: inherit;
      }
      .cue-scroll {
        max-height: 260px;
        overflow-y: auto;
        border: 1px solid #1f2937;
        border-radius: 8px;
      }
      .cue {
        display: flex;
        gap: 10px;
        width: 100%;
        padding: 6px 10px;
        background: none;
        border: none;
        border-bottom: 1px solid #16202f;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .cue:hover {
        background: #16202f;
      }
      .cue-time {
        flex: 0 0 auto;
        color: #93c5fd;
        font-variant-numeric: tabular-nums;
      }
      .cue-text {
        flex: 1;
      }

      /* ---- comments ---- */
      .composer {
        margin: 8px 0 12px;
      }
      .composer textarea {
        width: 100%;
        padding: 10px;
        border-radius: 8px;
        border: 1px solid #334155;
        background: #0b1220;
        color: inherit;
        font: inherit;
        resize: vertical;
      }
      .pin {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--muted);
        font-size: 13px;
      }
      .comment {
        padding: 8px 0;
        border-top: 1px solid #1f2937;
      }
      .comment-head {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
      }
      .comment-body {
        margin: 4px 0 0;
        /* Comments are user text: keep authored line breaks, and never let a long word overflow. */
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .section {
        font-size: 16px;
        margin: 20px 0 10px;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 12px;
      }
      .tile {
        display: flex;
        flex-direction: column;
        gap: 6px;
        background: var(--card);
        border: 1px solid #33415580;
        border-radius: 12px;
        padding: 10px;
        text-align: left;
        cursor: pointer;
        color: var(--text);
        width: 100%;
      }
      .tile:hover {
        border-color: var(--accent);
      }
      /* Still segmenting: listed so the upload is visible, but not yet something to click. */
      .tile.pending {
        cursor: default;
        opacity: 0.75;
      }
      .tile.pending:hover {
        border-color: #33415580;
      }
      .bar {
        display: block;
        height: 4px;
        background: #0b1220;
        border-radius: 999px;
        overflow: hidden;
      }
      .bar-fill {
        display: block;
        height: 100%;
        background: var(--accent);
        transition: width 0.25s;
      }
      .thumb {
        position: relative;
        display: block;
        aspect-ratio: 16 / 9;
        background: #0b1220;
        border-radius: 8px;
        overflow: hidden;
      }
      /* Progress along the bottom of the thumbnail — the whole reason the row exists. Sits on a
         dark track so it reads on a poster of any brightness, rather than only on dark footage. */
      .resume-bar {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 4px;
        background: #0f172acc;
      }
      .resume-fill {
        display: block;
        height: 100%;
        background: var(--accent, #38bdf8);
      }
      .thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .thumb-fallback {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--muted);
        font-size: 26px;
      }
      .thumb-time {
        position: absolute;
        right: 6px;
        bottom: 6px;
        background: #000000c4;
        border-radius: 4px;
        padding: 1px 5px;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      .tile-title {
        font-weight: 600;
        font-size: 14px;
        overflow-wrap: anywhere;
      }
      .tile-meta {
        font-size: 12px;
      }

      .inspector {
        margin-top: 12px;
        border-top: 1px solid #33415580;
        padding-top: 10px;
      }
      .link {
        background: none;
        border: none;
        color: var(--accent);
        cursor: pointer;
        padding: 0;
        font-weight: 600;
        width: auto;
        font-size: 13px;
      }
      .chip {
        background: #0b1220;
        border: 1px solid #334155;
        color: var(--muted);
        border-radius: 999px;
        padding: 4px 12px;
        font-size: 12px;
        cursor: pointer;
        width: auto;
      }
      .chip.on {
        border-color: var(--accent);
        color: var(--accent);
      }
      .muted-inline {
        color: var(--muted);
        font-size: 11px;
      }

      .seg-scroll {
        max-height: 260px;
        overflow: auto;
        border: 1px solid #33415580;
        border-radius: 8px;
      }
      .seg-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .seg-table th {
        position: sticky;
        top: 0;
        background: #0b1220;
        text-align: left;
        padding: 6px 8px;
        color: var(--muted);
        font-weight: 600;
      }
      .seg-table td {
        padding: 5px 8px;
        border-top: 1px solid #33415555;
        font-variant-numeric: tabular-nums;
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: var(--muted);
      }
    `,
  ],
})
export class VideosComponent implements OnInit, OnDestroy {
  readonly humanBytes = humanBytes;
  readonly timecode = timecode;

  readonly cards = signal<VideoCard[]>([]);
  readonly selected = signal<VideoCard | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');

  readonly segmentsOpen = signal(false);
  readonly segments = signal<SegmentView[]>([]);
  readonly segmentsLoading = signal(false);
  readonly activeRendition = signal<string | null>(null);

  /** Undefined until a video is selected — the player lives inside an `@if`. */
  /** Protected, not private: the template reads the up-next queue and the autoplay toggle off it. */
  protected readonly playerHost = inject(PlayerHostService);
  private readonly features = inject(FeatureService);

  /** The slot this page reserves; the hosted player is positioned over it. */
  private readonly playerSlot = viewChild<ElementRef<HTMLElement>>('playerSlot');

  /**
   * The live player, which this page no longer owns.
   *
   * <p>Used for the transcript, for seeking from a segment or a comment, and for the playhead on
   * the comment composer. It used to come from `viewChild`; the player is mounted in AppComponent
   * now, so it arrives through the host service instead. Every call site below is unchanged.
   */
  private readonly player = this.playerHost.player;

  /**
   * Keep the hosted player pointed at the selected recording, and at this page's slot.
   *
   * <p>Runs whenever the selection changes or the slot appears. Both are needed: the slot only
   * exists once a card is selected, because it is inside the same @if.
   */
  private readonly attachPlayer = effect(() => {
    const card = this.selected();
    const slot = this.playerSlot();
    if (card && slot) {
      untracked(() => this.playerHost.attach(card, this.startAt(), slot.nativeElement));
    }
  });

  /** The grid excludes whatever is already playing above it. */
  readonly others = computed(() => {
    const playing = this.selected()?.video.id;
    return this.cards().filter((card) => card.video.id !== playing);
  });

  /** True while a manual refresh is in flight, so the button can show it is doing something. */
  readonly refreshing = signal(false);

  /** Whether anything in the library is still being prepared — gates the refresh hint. */
  readonly anyProcessing = computed(() => this.cards().some((card) => this.isProcessing(card)));

  /**
   * Set what plays after this recording: the rest of the library, in the order it is shown.
   *
   * <p>Library order rather than a recommendation, because there is no signal here worth ranking on
   * — recordings are newest-first, and for a board archive "the next meeting down the list" is both
   * the obvious answer and the correct one. Anything cleverer would be guessing.
   *
   * <p>Recomputed on every play rather than once, so a queue never outlives the library it was built
   * from: refreshing, or a recording finishing processing, changes what should come next.
   */
  private refillQueue(current: VideoCard): void {
    const rest = this.cards().filter(
      (candidate) => candidate.video.id !== current.video.id && !this.isProcessing(candidate),
    );
    this.playerHost.queue.set(rest);
  }

  // ---- continue watching -------------------------------------------------------

  /**
   * This member's unfinished recordings, most recently watched first.
   *
   * <p>Its own signal rather than a slice of {@link cards}: the library list deliberately does not
   * carry per-member resume positions (that would be a query per card — see
   * VideoEngagementService.enrich), so the row has to come from the call that does.
   */
  readonly continueWatching = signal<VideoCard[]>([]);

  /**
   * How far through a recording this member is, as a percentage.
   *
   * <p>Clamped to 98 so the bar never renders as visually complete. A recording that looks finished
   * has no reason to be in a "Continue watching" row, and the last stretch of a board meeting is
   * usually procedural — someone at 99% has effectively finished and would read a full bar as a bug.
   */
  watchedPercent(card: VideoCard): number {
    const total = card.video.durationSeconds ?? 0;
    const at = card.engagement?.resumeAtSeconds ?? 0;
    if (total <= 0 || at <= 0) return 0;
    return Math.min(98, (at / total) * 100);
  }

  /**
   * "1 viewer" / "23 viewers" / "1.2K viewers".
   *
   * <p>Viewers rather than views, because that is what the number is — one row per member. Calling
   * it "views" would imply the YouTube meaning, where re-watching counts again, and overstate the
   * audience of a recording a handful of people opened twice.
   */
  viewerLabel(viewers: number): string {
    if (viewers === 1) return '1 viewer';
    if (viewers < 1000) return `${viewers} viewers`;
    // One decimal, trailing .0 dropped: "1K viewers", not "1.0K viewers".
    const thousands = (viewers / 1000).toFixed(1).replace(/\.0$/, '');
    return `${thousands}K viewers`;
  }

  // ---- engagement ------------------------------------------------------------

  readonly liking = signal(false);
  readonly shareNote = signal('');
  /** The generated link, shown so it can be copied by hand if the clipboard is unavailable. */
  readonly shareLink = signal('');

  readonly commentsOpen = signal(false);
  readonly comments = signal<CommentView[]>([]);
  readonly commentsLoading = signal(false);
  readonly commentBody = signal('');
  /** Pin the comment to the current playhead — the default, since most remarks are about a moment. */
  readonly pinToTime = signal(true);
  readonly posting = signal(false);
  readonly commentError = signal('');

  readonly transcriptOpen = signal(false);
  readonly transcriptQuery = signal('');

  /** Start time from a shared link (`?t=`), applied to the recording that link named. */
  readonly startAt = signal<number | null>(null);

  /** Captions come from the player, which already loads and parses them for its overlay. */
  readonly cues = computed(() => this.player()?.cues() ?? []);

  /** Cues matching the search box, or all of them when it is empty. */
  readonly visibleCues = computed(() => {
    const needle = this.transcriptQuery().trim().toLowerCase();
    const all = this.cues();
    return needle ? all.filter((c) => c.text.toLowerCase().includes(needle)) : all;
  });

  private readonly route = inject(ActivatedRoute);

  constructor(private videos: VideoService) {}

  /**
   * Loads once. Deliberately NOT polled.
   *
   * <p>A viewer does not need live progress on someone else's upload — that is the uploader's
   * concern, and the admin screen already shows it. Polling here meant every open library tab hit
   * the API every few seconds for as long as anything was mid-transcode; and because a transcode
   * killed with the server never leaves {@code PROCESSING}, "temporarily" became "forever". On a
   * host billed by instance-hours, idle tabs quietly keeping the service awake is a real cost.
   */
  ngOnInit(): void {
    this.refresh(true);
    this.loadContinueWatching();
  }

  /**
   * Load the resume row.
   *
   * <p>Separate from {@link refresh} and allowed to fail quietly: it is an extra convenience above
   * the library, so a failure should cost the row and nothing else. Failing the whole page because
   * a nice-to-have query did would be the wrong trade.
   */
  private loadContinueWatching(): void {
    // No flag, no request. The endpoint would 403 and the row would be empty either way, so the
    // call is pure cost.
    if (!this.features.enabled('VIDEO_WATCH_TRACKING')) return;
    this.videos.continueWatching().subscribe({
      next: (cards) => this.continueWatching.set(cards),
      error: () => this.continueWatching.set([]),
    });
  }

  /**
   * Open the recording a shared link named, at the moment it named.
   *
   * <p>Runs after the library has loaded, because a link can only open a card the viewer is actually
   * allowed to see — the catalogue is already scoped to them, so a link to something they cannot
   * access simply finds nothing rather than needing a separate permission check.
   *
   * <p>The start time is set before selecting so the player sees it on its first load, which is what
   * lets it begin at that segment instead of fetching from zero and seeking.
   */
  private openSharedLink(cards: VideoCard[]): void {
    const params = this.route.snapshot.queryParamMap;
    const videoId = params.get('v');
    if (!videoId) return;

    const target = cards.find((card) => card.video.id === videoId);
    if (!target || this.isProcessing(target)) return;

    const at = Number(params.get('t'));
    this.startAt.set(Number.isFinite(at) && at > 0 ? at : null);
    this.selected.set(target);
  }

  /** Explicit user-initiated reload, for when a recording was still processing. */
  reload(): void {
    this.refreshing.set(true);
    this.refresh(false);
  }

  private refresh(initial: boolean): void {
    this.videos.library().subscribe({
      next: (cards) => {
        this.cards.set(cards);
        this.loading.set(false);
        this.refreshing.set(false);
        this.error.set('');
        // Keep the open player in sync — a video that finished while being watched in the grid
        // should pick up its stream URL and ticket rather than staying a dead placeholder.
        const open = this.selected();
        if (open) {
          const fresh = cards.find((card) => card.video.id === open.video.id);
          if (fresh && fresh.streamUrl && !open.streamUrl) this.selected.set(fresh);
        }
        if (initial) this.openSharedLink(cards);
      },
      error: (err) => {
        this.loading.set(false);
        this.refreshing.set(false);
        this.error.set(
          err?.status === 0 || err?.status >= 502
            ? 'Cannot reach the server — it may be asleep or restarting. Try again in a moment.'
            : 'Could not load the recordings library.',
        );
      },
    });
  }

  /** Still segmenting: listed so the upload is visible, but there is nothing to play yet. */
  isProcessing(card: VideoCard): boolean {
    return card.video.status === 'PROCESSING';
  }

  play(card: VideoCard): void {
    if (this.isProcessing(card)) return;
    this.selected.set(card);
    this.refillQueue(card);
    this.segmentsOpen.set(false);
    this.segments.set([]);
    this.activeRendition.set(null);
    this.downloadNote.set('');
    this.downloadError.set('');
    this.downloadOptions.set([]);
    this.shareNote.set('');
    this.shareLink.set('');
    this.commentsOpen.set(false);
    this.comments.set([]);
    this.commentBody.set('');
    this.commentError.set('');
    this.transcriptOpen.set(false);
    this.transcriptQuery.set('');
    // A start time only applies to the recording the link named; picking another clears it.
    this.startAt.set(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---- download --------------------------------------------------------------

  readonly downloading = signal(false);
  /** The quality choices, once fetched. Empty when the menu is closed. */
  readonly downloadOptions = signal<DownloadOption[]>([]);
  /** Explains the container of the rebuilt qualities — see DownloadOptions.note. */
  readonly downloadNote = signal('');
  readonly downloadError = signal('');

  /**
   * Two steps on purpose. The POST resolves *what* will be downloaded — the stored original, or the
   * ladder joined back together when the original was discarded after segmenting — and the browser
   * then navigates to the ticketed URL it returns.
   *
   * <p>Navigating rather than fetching a blob matters for anything large: the transfer streams to
   * disk, shows the browser's own progress, and survives being resumed. A `fetch` + object URL would
   * have to hold the whole recording in the tab's memory first.
   */
  openDownloads(card: VideoCard): void {
    if (this.downloading()) return;
    if (this.downloadOptions().length) {
      this.closeDownloads();
      return;
    }
    this.downloading.set(true);
    this.downloadNote.set('');
    this.downloadError.set('');

    this.videos.downloadOptions(card.video.id).subscribe({
      next: (plan) => {
        this.downloading.set(false);
        this.downloadNote.set(plan.note ?? '');
        this.downloadOptions.set(plan.options);
        // Exactly one choice is not a choice — start it rather than making them click twice.
        if (plan.options.length === 1) this.startDownload(plan.options[0]);
      },
      error: (err) => {
        this.downloading.set(false);
        this.downloadError.set(
          err?.error?.message ??
            err?.error?.error ??
            'Could not work out how to download this recording.',
        );
      },
    });
  }

  closeDownloads(): void {
    this.downloadOptions.set([]);
    this.downloadNote.set('');
  }

  startDownload(option: DownloadOption): void {
    this.startTransfer(option.url);
    this.closeDownloads();
  }

  toggleSegments(card: VideoCard): void {
    const open = !this.segmentsOpen();
    this.segmentsOpen.set(open);
    if (open && !this.segments().length) {
      this.loadSegments(card, card.video.renditions[0]?.name);
    }
  }

  loadSegments(card: VideoCard, rendition?: string): void {
    this.segmentsLoading.set(true);
    this.activeRendition.set(rendition ?? null);
    this.videos.segments(card.video.id, rendition).subscribe({
      next: (segments) => {
        this.segments.set(segments);
        this.segmentsLoading.set(false);
      },
      error: () => {
        this.segments.set([]);
        this.segmentsLoading.set(false);
      },
    });
  }

  /**
   * Point a hidden iframe at the URL, rather than assigning `location`.
   *
   * <p>`Content-Disposition: attachment` means the browser saves the file either way and does not
   * navigate — but only when the request succeeds. If it fails (an expired ticket, the instance
   * asleep) assigning `location` replaces the whole app with a JSON error page and loses the
   * viewer's place. Inside an iframe that failure is invisible and the page is untouched.
   *
   * <p>The `download` attribute on an anchor is not an option: it has no effect cross-origin, and
   * the API is a different origin from the SPA.
   */
  private startTransfer(url: string): void {
    let frame = this.transferFrame;
    if (!frame) {
      frame = document.createElement('iframe');
      frame.hidden = true;
      frame.setAttribute('aria-hidden', 'true');
      document.body.appendChild(frame);
      this.transferFrame = frame;
    }
    frame.src = url;
  }

  private transferFrame: HTMLIFrameElement | null = null;

  ngOnDestroy(): void {
    // Tell the host the slot is gone. It decides what that means: if the viewer put the recording
    // in a floating window it keeps playing, parked off-screen; otherwise playback stops, which is
    // what leaving a video page has always done.
    //
    // Nothing is unmounted or moved here — that is the entire reason the player is not ours.
    this.playerHost.detach();

    // The iframe lives on document.body, so leaving the page would otherwise leak it. Removing it
    // does not cancel a transfer already underway — the browser owns the download by then.
    this.transferFrame?.remove();
    this.transferFrame = null;
  }

  /**
   * Jump the player to a segment's start. This is a normal seek, not a direct fetch of the .ts —
   * the player then requests exactly that slice and resumes, which is the whole point.
   */
  jumpTo(segment: SegmentView): void {
    this.player()?.seekTo(segment.startSeconds);
  }

  /** Seek from a transcript line or a timestamped comment. */
  jumpToCue(seconds: number): void {
    this.player()?.seekTo(seconds);
  }

  /** Current playhead, for the "at 12:04" label on the comment composer. */
  playheadNow(): number {
    return this.player()?.currentTime() ?? 0;
  }

  // ---- likes -----------------------------------------------------------------

  /**
   * Toggle the like and take the server's counts as the answer.
   *
   * <p>Not optimistic: the count is shared state, so guessing it locally would show a number that
   * disagrees with everyone else's the moment two people press at once. The round trip is one small
   * call and the button is disabled meanwhile.
   */
  toggleLike(card: VideoCard): void {
    if (this.liking()) return;
    this.liking.set(true);
    this.videos.toggleLike(card.video.id).subscribe({
      next: (engagement) => {
        this.liking.set(false);
        this.patchCard(card.video.id, { engagement });
      },
      error: () => this.liking.set(false),
    });
  }

  // ---- share -----------------------------------------------------------------

  /**
   * Copy a link to this recording, at the current moment.
   *
   * <p>A deep link into this page rather than a public URL: playback is authorised by a short-lived,
   * per-viewer ticket, so a link that bypassed sign-in would have to bypass that too. The recipient
   * signs in, opens the same entry, and gets their own ticket — which is also what keeps a shared
   * link from still working for someone who has since left.
   */
  share(card: VideoCard): void {
    const at = Math.floor(this.playheadNow());
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('v', card.video.id);
    if (at > 0) url.searchParams.set('t', String(at));
    const link = url.toString();

    // Always shown, so there is something to copy by hand even when the clipboard is unavailable.
    this.shareLink.set(link);
    const from = at > 0 ? ` It starts at ${timecode(at)}.` : '';

    void this.copyToClipboard(link).then((copied) =>
      this.shareNote.set(
        copied ? `Link copied.${from}` : `Copy this link to share.${from}`,
      ),
    );
  }

  /**
   * Copy text, by whichever route the browser allows.
   *
   * <p>`navigator.clipboard` is only exposed in a secure context — over plain HTTP it is `undefined`,
   * not a rejecting promise. Calling `.then()` on it therefore threw a TypeError and the Share button
   * appeared to do nothing at all, which is what made this look broken rather than unsupported.
   *
   * <p>`execCommand('copy')` is deprecated but is the only thing that works without a secure
   * context, so it stays as the fallback; the link is displayed regardless if both routes fail.
   */
  private async copyToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Denied by permissions policy, or the document was not focused. Try the fallback.
    }
    try {
      const scratch = document.createElement('textarea');
      scratch.value = text;
      scratch.setAttribute('readonly', '');
      // Off-screen but still selectable; display:none would make select() a no-op.
      scratch.style.position = 'fixed';
      scratch.style.top = '-1000px';
      scratch.style.opacity = '0';
      document.body.appendChild(scratch);
      scratch.select();
      const copied = document.execCommand('copy');
      scratch.remove();
      return copied;
    } catch {
      return false;
    }
  }

  // ---- comments --------------------------------------------------------------

  toggleComments(card: VideoCard): void {
    const open = !this.commentsOpen();
    this.commentsOpen.set(open);
    if (open) this.loadComments(card);
  }

  private loadComments(card: VideoCard): void {
    this.commentsLoading.set(true);
    this.commentError.set('');
    this.videos.comments(card.video.id).subscribe({
      next: (list) => {
        this.comments.set(list);
        this.commentsLoading.set(false);
      },
      error: () => {
        this.comments.set([]);
        this.commentsLoading.set(false);
        this.commentError.set('Could not load comments.');
      },
    });
  }

  postComment(card: VideoCard): void {
    const body = this.commentBody().trim();
    if (!body || this.posting()) return;
    this.posting.set(true);
    this.commentError.set('');
    const at = this.pinToTime() ? Math.floor(this.playheadNow()) : null;

    this.videos.addComment(card.video.id, body, at).subscribe({
      next: (comment) => {
        this.posting.set(false);
        this.commentBody.set('');
        this.comments.update((list) => [...list, comment]);
        this.bumpCommentCount(card.video.id, 1);
      },
      error: (err) => {
        this.posting.set(false);
        this.commentError.set(
          err?.error?.message ?? err?.error?.error ?? 'Could not post that comment.',
        );
      },
    });
  }

  removeComment(card: VideoCard, comment: CommentView): void {
    this.videos.deleteComment(comment.id).subscribe({
      next: () => {
        this.comments.update((list) => list.filter((c) => c.id !== comment.id));
        this.bumpCommentCount(card.video.id, -1);
      },
      error: () => this.commentError.set('Could not delete that comment.'),
    });
  }

  /** Keep the header count in step without re-fetching the whole card for a ±1 change. */
  private bumpCommentCount(videoId: string, delta: number): void {
    const current = this.selected()?.engagement;
    if (!current) return;
    this.patchCard(videoId, {
      engagement: { ...current, comments: Math.max(0, current.comments + delta) },
    });
  }

  /**
   * Apply a change to a card in both places it appears — the player above and the grid below.
   *
   * <p>`selected()` holds its own copy, so updating only `cards()` would leave the header showing a
   * stale like count until the next reload.
   */
  private patchCard(videoId: string, patch: Partial<VideoCard>): void {
    this.cards.update((list) =>
      list.map((c) => (c.video.id === videoId ? { ...c, ...patch } : c)),
    );
    const open = this.selected();
    if (open && open.video.id === videoId) this.selected.set({ ...open, ...patch });
  }
}
