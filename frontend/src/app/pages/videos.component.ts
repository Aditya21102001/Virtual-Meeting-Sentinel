import { Component, OnDestroy, OnInit, computed, signal, viewChild } from '@angular/core';
import { VideoPlayerComponent } from '../components/video-player.component';
import {
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
  imports: [VideoPlayerComponent],
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
          <app-video-player #player [card]="card" [autoplay]="true"></app-video-player>

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
          </div>

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
        </div>
      }

      <!-- Library grid -->
      @if (cards().length) {
        <h2 class="section">{{ selected() ? 'More recordings' : 'Library' }}</h2>
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
  private readonly player = viewChild<VideoPlayerComponent>('player');

  /** The grid excludes whatever is already playing above it. */
  readonly others = computed(() => {
    const playing = this.selected()?.video.id;
    return this.cards().filter((card) => card.video.id !== playing);
  });

  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(private videos: VideoService) {}

  ngOnInit(): void {
    this.refresh(true);
    // The library now includes recordings that are still segmenting, so keep it fresh while any
    // of them are — otherwise a viewer would sit on a stale "Processing — 40%" until they reloaded
    // the page. The interval costs nothing once everything is READY: the check short-circuits.
    this.poller = setInterval(() => {
      if (this.cards().some((card) => this.isProcessing(card))) this.refresh(false);
    }, 5000);
  }

  ngOnDestroy(): void {
    if (this.poller) clearInterval(this.poller);
  }

  private refresh(initial: boolean): void {
    this.videos.library().subscribe({
      next: (cards) => {
        this.cards.set(cards);
        this.loading.set(false);
        // Keep the open player in sync — a video that finished while being watched in the grid
        // should pick up its stream URL and ticket rather than staying a dead placeholder.
        const open = this.selected();
        if (open) {
          const fresh = cards.find((card) => card.video.id === open.video.id);
          if (fresh && fresh.streamUrl && !open.streamUrl) this.selected.set(fresh);
        }
      },
      error: () => {
        if (initial) {
          this.error.set('Could not load the recordings library. Is the server running?');
        }
        this.loading.set(false);
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
    this.segmentsOpen.set(false);
    this.segments.set([]);
    this.activeRendition.set(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
   * Jump the player to a segment's start. This is a normal seek, not a direct fetch of the .ts —
   * the player then requests exactly that slice and resumes, which is the whole point.
   */
  jumpTo(segment: SegmentView): void {
    this.player()?.seekTo(segment.startSeconds);
  }
}
