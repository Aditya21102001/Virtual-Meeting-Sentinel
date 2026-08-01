import { Component, OnDestroy, OnInit, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  VideoCard,
  VideoService,
  VideoStorageStatus,
  humanBytes,
  timecode,
} from '../services/video.service';

/**
 * Moderator screen for the video library: upload a recording, watch it segment, manage the result.
 *
 * <p>Upload and processing are two separate phases and the UI shows both. The POST finishes once
 * the bytes reach the NAS (progress from the XHR upload events); segmentation then runs on the
 * server, and this page polls while anything is still {@code PROCESSING}. Holding one request open
 * for an ffmpeg run would simply time out.
 */
@Component({
  selector: 'app-video-admin',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="container">
      <h1>Video library</h1>
      <p class="muted">
        Upload a meeting recording. It is stored on the NAS and split into an adaptive ladder of
        short segments, so members can watch it on demand without downloading the file.
      </p>

      <!-- Storage / tooling health -->
      @if (status(); as s) {
        @if (s.storageMode === 'DATABASE') {
          <div class="info-box">
            <strong>Database storage — keep recordings short.</strong> Segments are stored in the
            database rather than on disk, so they survive a redeploy on a host with no persistent
            volume. A database is not bulk storage, so uploads are capped at
            <strong>{{ humanBytes(s.maxUploadBytes) }}</strong> each.
            <div class="bar" style="margin-top:8px">
              <div
                class="bar-fill"
                [class.full]="dbUsedPercent(s) >= 90"
                [style.width.%]="dbUsedPercent(s)"
              ></div>
            </div>
            <span class="muted">
              {{ humanBytes(s.databaseStoredBytes) }} of
              {{ humanBytes(s.databaseMaxTotalBytes) }} used ({{ dbUsedPercent(s) }}%) —
              {{ humanBytes(s.databaseMaxTotalBytes - s.databaseStoredBytes) }} free
            </span>
          </div>
        } @else if (!s.nasAvailable) {
          <div class="error-box">
            <strong>NAS unavailable.</strong> {{ s.storageProblem }}<br />
            Configured: <code>{{ s.configuredNasPath }}</code><br />
            Falling back to <code>{{ s.storagePath }}</code> — set
            <code>VIDEO_NAS_PATH</code> to the share before uploading anything you need to keep.
            On a host with no persistent disk, set <code>VIDEO_STORAGE_MODE=database</code> instead.
          </div>
        }
        @if (!s.segmentationAvailable) {
          <div class="warn-box">
            <strong>FFmpeg not found.</strong> Uploads will still play, streamed progressively over
            HTTP Range, but they won't be segmented into quality levels. Install FFmpeg and use
            <em>Re-process</em> on each video to build the ladder.
          </div>
        }
        <div class="card facts">
          <div class="fact">
            <span class="muted">Storage</span>
            @if (s.storageMode === 'DATABASE') {
              <span
                >database · {{ humanBytes(s.databaseStoredBytes) }} /
                {{ humanBytes(s.databaseMaxTotalBytes) }}</span
              >
            } @else {
              <code>{{ s.storagePath }}</code>
            }
          </div>
          <div class="fact">
            <span class="muted">{{ s.storageMode === 'DATABASE' ? 'Working disk free' : 'Free space' }}</span>
            <span>{{ humanBytes(s.usableSpaceBytes) }}</span>
          </div>
          <div class="fact">
            <span class="muted">Segment length</span><span>{{ s.segmentSeconds }}s</span>
          </div>
          <div class="fact">
            <span class="muted">Ladder</span>
            <span>{{ s.ladder.join('p / ') }}p</span>
          </div>
          <div class="fact">
            <span class="muted">Max upload</span><span>{{ humanBytes(s.maxUploadBytes) }}</span>
          </div>
          <div class="fact">
            <span class="muted">Library</span>
            <span>{{ s.readyCount }} ready / {{ s.videoCount }} total</span>
          </div>
          @if (s.ffmpegVersion) {
            <div class="fact wide">
              <span class="muted">FFmpeg</span><span class="mono">{{ s.ffmpegVersion }}</span>
            </div>
          }
        </div>
      }

      <!-- Upload -->
      <div class="card">
        <div class="q">Upload a recording</div>
        <div class="field">
          <input type="file" accept="video/*,.mkv" (change)="pick($event)" />
        </div>
        @if (file(); as f) {
          <p class="muted">{{ f.name }} — {{ humanBytes(f.size) }}</p>
        }
        <div class="field">
          <input
            type="text"
            placeholder="Title (defaults to the filename)"
            [(ngModel)]="title"
            [disabled]="busy()"
          />
        </div>
        <div class="field">
          <textarea
            rows="2"
            placeholder="Description (optional)"
            [(ngModel)]="description"
            [disabled]="busy()"
          ></textarea>
        </div>
        <div class="row">
          <button (click)="upload()" [disabled]="!file() || busy()">
            {{ busy() ? 'Uploading…' : 'Upload & segment' }}
          </button>
          @if (busy()) {
            <span class="muted">
              {{ uploadPercent() }}% — {{ humanBytes(sentBytes()) }} of
              {{ humanBytes(totalBytes()) }}
            </span>
            <button class="ghost" (click)="cancelUpload()">Cancel</button>
          }
        </div>
        @if (busy()) {
          <div class="bar"><div class="bar-fill" [style.width.%]="uploadPercent()"></div></div>
          <p class="muted" style="margin-top:6px">
            The upload continues if you go to another page — it is no longer tied to this screen.
            Segmenting then runs on the server, so you can close the tab entirely once it reaches
            100%.
          </p>
        }
        @if (message()) {
          <p class="muted" style="margin-top:8px">{{ message() }}</p>
        }
        @if (uploadError()) {
          <div class="error-box">{{ uploadError() }}</div>
        }
      </div>

      <!-- Manage -->
      <h2 class="section">Recordings</h2>
      @if (serverError()) {
        <div class="error-box">
          {{ serverError() }}
          <div style="margin-top:8px">
            <button class="ghost" (click)="retryConnection()">Try again</button>
          </div>
        </div>
      }
      @if (!cards().length) {
        <div class="card"><span class="muted">Nothing uploaded yet.</span></div>
      }

      @for (card of cards(); track card.video.id) {
        <div class="card">
          <div class="head">
            @if (card.posterUrl) {
              <img class="thumb" [src]="card.posterUrl" [alt]="card.video.title" />
            } @else {
              <span class="thumb empty">{{ icon(card) }}</span>
            }

            <div class="head-main">
              @if (editing() === card.video.id) {
                <div class="field">
                  <input type="text" [(ngModel)]="editTitle" placeholder="Title" />
                </div>
                <div class="field">
                  <textarea rows="2" [(ngModel)]="editDescription" placeholder="Description"></textarea>
                </div>
                <div class="row">
                  <button (click)="saveEdit(card)">Save</button>
                  <button class="ghost" (click)="editing.set(null)">Cancel</button>
                </div>
              } @else {
                <div class="q">{{ card.video.title }}</div>
                @if (card.video.description) {
                  <p class="muted desc">{{ card.video.description }}</p>
                }
                <div class="row meta">
                  <span class="badge" [class.hot]="card.video.status === 'FAILED'">
                    {{ card.video.status }}
                  </span>
                  @if (card.video.status === 'READY') {
                    <span class="badge">{{ timecode(card.video.durationSeconds) }}</span>
                    @if (card.adaptive) {
                      <span class="badge"
                        >{{ card.video.renditions.length }} levels ·
                        {{ card.video.totalSegments }} segments</span
                      >
                    } @else {
                      <span class="badge">progressive</span>
                    }
                  }
                  @if (card.video.storageMode === 'DATABASE') {
                    <span class="badge">in database</span>
                  }
                  <span class="muted">
                    {{ humanBytes(card.video.sizeBytes) }} ·
                    {{ card.video.originalFilename }}
                    @if (card.video.uploadedBy) { · {{ card.video.uploadedBy }} }
                  </span>
                </div>
              }
            </div>
          </div>

          <!-- Processing progress -->
          @if (card.video.status === 'PROCESSING') {
            <div class="bar"><div class="bar-fill" [style.width.%]="card.video.progressPercent"></div></div>
            <p class="muted">
              Segmenting — {{ card.video.progressPercent }}%. This runs on the server; you can leave
              this page.
            </p>
          }

          @if (card.video.errorMessage) {
            <p [class]="card.video.status === 'FAILED' ? 'error-box' : 'muted note'">
              {{ card.video.errorMessage }}
            </p>
          }

          <!-- Rendition breakdown -->
          @if (card.video.renditions.length) {
            <div class="rendition-scroll">
              <table class="rendition-table">
                <thead>
                  <tr>
                    <th>Level</th>
                    <th>Resolution</th>
                    <th>Video</th>
                    <th>Audio</th>
                    <th>Segments</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  @for (rendition of card.video.renditions; track rendition.name) {
                    <tr>
                      <td>{{ rendition.name }}</td>
                      <td>{{ rendition.width }}×{{ rendition.height }}</td>
                      <td>{{ rendition.videoBitrateKbps }} kbps</td>
                      <td>{{ rendition.audioBitrateKbps }} kbps</td>
                      <td>{{ rendition.segmentCount }}</td>
                      <td>{{ humanBytes(rendition.totalBytes) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }

          @if (actionError(); as failure) {
            @if (failure.id === card.video.id) {
              <div class="error-box">{{ failure.message }}</div>
            }
          }

          <div class="row actions">
            @if (editing() !== card.video.id) {
              <button class="ghost" (click)="startEdit(card)">Edit details</button>
            }
            <button
              class="ghost"
              (click)="reprocess(card)"
              [disabled]="card.video.status === 'PROCESSING' || working() === card.video.id"
            >
              Re-process
            </button>
            <button class="danger" (click)="remove(card)" [disabled]="working() === card.video.id">
              {{ confirming() === card.video.id ? 'Click again to delete' : 'Delete' }}
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .section {
        font-size: 16px;
        margin: 22px 0 10px;
      }
      .field {
        margin-bottom: 8px;
      }
      .warn-box {
        color: #fde68a;
        background: #3b2f17;
        border: 1px solid #92400e;
        padding: 10px 12px;
        border-radius: 8px;
        margin-bottom: 12px;
        font-size: 14px;
      }
      .info-box {
        color: #bae6fd;
        background: #0c2a3a;
        border: 1px solid #0369a1;
        padding: 10px 12px;
        border-radius: 8px;
        margin-bottom: 12px;
        font-size: 14px;
      }
      code {
        background: #0b1220;
        padding: 1px 5px;
        border-radius: 4px;
        font-size: 12px;
        overflow-wrap: anywhere;
      }

      .facts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
        gap: 10px;
      }
      .fact {
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: 13px;
        min-width: 0;
      }
      .fact.wide {
        grid-column: 1 / -1;
      }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
        overflow-wrap: anywhere;
      }

      .bar {
        height: 6px;
        background: #0b1220;
        border-radius: 999px;
        overflow: hidden;
        margin-top: 10px;
      }
      .bar-fill {
        height: 100%;
        background: var(--accent);
        transition: width 0.25s;
      }
      .bar-fill.full {
        background: var(--hot);
      }

      .head {
        display: flex;
        gap: 12px;
        align-items: flex-start;
      }
      .head-main {
        flex: 1;
        min-width: 0;
      }
      .thumb {
        width: 132px;
        aspect-ratio: 16 / 9;
        object-fit: cover;
        border-radius: 8px;
        background: #0b1220;
        flex: none;
      }
      .thumb.empty {
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 22px;
        color: var(--muted);
      }
      .desc {
        margin: 2px 0 6px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .meta {
        gap: 8px;
      }
      .note {
        margin: 8px 0 0;
      }
      .actions {
        margin-top: 12px;
      }
      button.ghost {
        background: none;
        border: 1px solid #334155;
        color: var(--text);
      }
      button.danger {
        background: none;
        border: 1px solid #7f1d1d;
        color: #fca5a5;
      }

      .rendition-scroll {
        overflow-x: auto;
        margin-top: 10px;
      }
      .rendition-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 12px;
        min-width: 460px;
      }
      .rendition-table th {
        text-align: left;
        color: var(--muted);
        font-weight: 600;
        padding: 5px 8px;
      }
      .rendition-table td {
        padding: 5px 8px;
        border-top: 1px solid #33415555;
        font-variant-numeric: tabular-nums;
      }

      @media (max-width: 640px) {
        .head {
          flex-direction: column;
        }
        .thumb {
          width: 100%;
        }
      }
    `,
  ],
})
export class VideoAdminComponent implements OnInit, OnDestroy {
  // inject() rather than constructor injection: the signal fields below read `videos` in their
  // initialisers, which run before a constructor parameter property would be assigned.
  private readonly videos = inject(VideoService);

  readonly humanBytes = humanBytes;
  readonly timecode = timecode;

  readonly status = signal<VideoStorageStatus | null>(null);
  readonly cards = signal<VideoCard[]>([]);

  readonly file = signal<File | null>(null);
  title = '';
  description = '';
  /** Client-side objection to the chosen file (too large) — distinct from a server-side failure. */
  readonly localError = signal('');

  // Upload state lives on the service so it survives navigation; these are just views onto it.
  readonly busy = this.videos.uploading;
  readonly uploadPercent = this.videos.uploadPercent;
  readonly sentBytes = this.videos.uploadSentBytes;
  readonly totalBytes = this.videos.uploadTotalBytes;
  readonly message = this.videos.uploadMessage;
  readonly uploadError = computed(() => this.localError() || this.videos.uploadError());

  readonly editing = signal<string | null>(null);
  editTitle = '';
  editDescription = '';
  readonly working = signal<string | null>(null);
  readonly confirming = signal<string | null>(null);
  /** Why the last action on a specific card failed, shown on that card. */
  readonly actionError = signal<{ id: string; message: string } | null>(null);

  /** Set when polling gives up, so the page explains the outage instead of failing silently. */
  readonly serverError = signal('');
  private consecutiveFailures = 0;

  /**
   * How often to re-read the list while something is transcoding.
   *
   * <p>12 s, not the 5 s it used to be. A transcode reports whole percentages and a big one moves
   * a percent every several seconds, so the faster poll was mostly re-fetching a number that had
   * not changed — and each tick re-serialises the entire library, mints a playback ticket per card
   * and wakes a free-tier instance that is meant to be spending its CPU on ffmpeg. Progress
   * arriving a few seconds late costs nothing; the transcode finishing sooner is worth a lot.
   */
  private static readonly POLL_MS = 12_000;

  private poller: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // An upload that finishes while this page is open should show up without waiting for the
    // next poll tick. The service bumps libraryChanged on completion; re-read the list then.
    // This also covers the FIRST load — the effect runs once on creation — so ngOnInit must not
    // fetch again or every visit to the page would open two of each request.
    effect(() => {
      this.videos.libraryChanged();
      this.refreshList();
      this.refreshStatus();
    });
  }

  ngOnInit(): void {
    this.startPolling();
  }

  /**
   * Poll only while something is mid-transcode, and only when a tick can tell you something new.
   * A hidden tab is skipped too — a background page polling a free-tier host burns its monthly
   * instance-hours while nobody is watching.
   *
   * <p>Nothing is fetched here on the way in: the constructor's effect has already done the
   * initial load.
   */
  private startPolling(): void {
    if (this.poller) return;
    this.poller = setInterval(() => {
      if (document.hidden) return;
      if (this.serverError()) return;        // the server is known to be down; stop knocking
      if (this.videos.uploading()) return;   // the upload's own progress events already drive the UI
      if (this.cards().some((card) => card.video.status === 'PROCESSING')) this.refreshList();
    }, VideoAdminComponent.POLL_MS);
  }

  ngOnDestroy(): void {
    this.stopPolling();
    // Deliberately does NOT cancel an in-flight upload. Unsubscribing an HttpClient request aborts
    // the XHR, so tearing it down here meant navigating away silently killed a part-done upload.
    // The service owns that subscription now; only an explicit Cancel stops it.
  }

  // ---- data ----------------------------------------------------------------

  /**
   * The storage banner. Skipped once we know the server is down, and silent on failure — the list
   * request beside it is the one that decides whether there is an outage and says so.
   */
  private refreshStatus(): void {
    if (this.serverError()) return;
    this.videos.status().subscribe({
      next: (s) => this.status.set(s),
      error: () => {},
    });
  }

  /**
   * Refresh the list, and stop knocking when the server is unreachable.
   *
   * <p>Originally there was no error branch at all, so a backend that was down got hammered every
   * poll tick. Then it took three consecutive failures to give up — which is right for a one-off
   * blip, but wrong for the common case here: a container that has been restarted mid-transcode
   * answers nothing at all for a minute or more, and three more requests into a dead socket tell
   * nobody anything. A transport-level failure (status 0) or a gateway error is conclusive on the
   * first try, so it trips the outage immediately; anything else still gets the three attempts.
   */
  private refreshList(): void {
    this.videos.listAll().subscribe({
      next: (cards) => {
        this.cards.set(cards);
        this.consecutiveFailures = 0;
        this.serverError.set('');
      },
      error: (err) => {
        this.consecutiveFailures++;
        if (this.isServerDown(err) || this.consecutiveFailures >= 3) {
          this.stopPolling();
          this.serverError.set(this.describeOutage(err));
        }
      },
    });
  }

  /**
   * True when the response could only have come from the platform's proxy, not the application.
   * Status 0 means the request never completed at all — including the "blocked by CORS" case,
   * which is what a browser reports when an error page arrives without CORS headers.
   */
  private isServerDown(err: unknown): boolean {
    const status = (err as { status?: number })?.status;
    return status === 0 || status === 502 || status === 503 || status === 504;
  }

  private stopPolling(): void {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  /**
   * Name the outage from what the browser could observe. A cross-origin request to a server that
   * never answered surfaces as status 0 with a CORS complaint, which reads as a configuration
   * problem — it almost never is. The server simply is not up.
   */
  private describeOutage(err: unknown): string {
    const status = (err as { status?: number })?.status;
    if (status === 0) {
      return 'Cannot reach the server. It is asleep, restarting, or was just restarted — free '
           + 'hosting tiers suspend a service after a period of inactivity, and a transcode that '
           + 'exhausts the instance can get the container killed mid-job. Any "CORS" error in the '
           + 'console is a side effect of that, not the cause: an error page from the platform\'s '
           + 'proxy carries no CORS headers. Check the server logs, then reload.';
    }
    if (status === 502 || status === 503 || status === 504) {
      return `The server returned ${status}. It is starting up, overloaded, or was killed while `
           + 'transcoding — check the server logs. Reload once it is back.';
    }
    return 'Could not load the video list. Reload to try again.';
  }

  /** How full database storage is, for the budget bar. */
  dbUsedPercent(s: VideoStorageStatus): number {
    if (!s.databaseMaxTotalBytes) return 0;
    return Math.min(100, Math.round((s.databaseStoredBytes / s.databaseMaxTotalBytes) * 100));
  }

  icon(card: VideoCard): string {
    switch (card.video.status) {
      case 'PROCESSING':
        return '⏳';
      case 'FAILED':
        return '⚠';
      default:
        return '🎬';
    }
  }

  // ---- upload --------------------------------------------------------------

  pick(event: Event): void {
    const chosen = (event.target as HTMLInputElement).files?.[0] ?? null;
    this.file.set(chosen);
    this.localError.set('');
    const limit = this.status()?.maxUploadBytes;
    if (chosen && limit && chosen.size > limit) {
      this.localError.set(
        `That file is ${humanBytes(chosen.size)} — over the ${humanBytes(limit)} limit.`,
      );
    }
  }

  /**
   * Hand the upload to the service and return. The service owns the subscription, so navigating
   * away no longer aborts it — the transfer continues in the background and this page picks the
   * progress back up from the shared signals when the user returns.
   */
  upload(): void {
    const chosen = this.file();
    if (!chosen || this.localError()) return;
    this.videos.startUpload(chosen, this.title, this.description);
    this.title = '';
    this.description = '';
    this.file.set(null);
  }

  cancelUpload(): void {
    this.videos.cancelUpload();
  }

  /** Clear the outage state and start polling again — for when the server has come back. */
  retryConnection(): void {
    this.consecutiveFailures = 0;
    this.serverError.set('');
    this.refreshStatus();
    this.refreshList();
    this.startPolling();
  }

  // ---- manage --------------------------------------------------------------

  startEdit(card: VideoCard): void {
    this.editing.set(card.video.id);
    this.editTitle = card.video.title;
    this.editDescription = card.video.description ?? '';
  }

  saveEdit(card: VideoCard): void {
    this.videos.updateMetadata(card.video.id, this.editTitle, this.editDescription).subscribe({
      next: () => {
        this.editing.set(null);
        this.refreshList();
      },
    });
  }

  reprocess(card: VideoCard): void {
    this.working.set(card.video.id);
    this.actionError.set(null);
    this.videos.reprocess(card.video.id).subscribe({
      next: () => {
        this.working.set(null);
        this.refreshList();
      },
      error: (err) => {
        this.working.set(null);
        // The server explains refusals precisely (a 409 says the original is gone and why).
        // Swallowing that left the button looking broken and pushed the real answer into the
        // browser console, where nobody using the app would ever see it.
        this.actionError.set({ id: card.video.id, message: this.serverMessage(err) });
      },
    });
  }

  /** Pull the server's own explanation out of an error response, falling back sensibly. */
  private serverMessage(err: unknown): string {
    const e = err as { status?: number; error?: { message?: string; error?: string } };
    const fromBody = e?.error?.message ?? e?.error?.error;
    if (fromBody) return fromBody;
    if (e?.status === 0) return 'Could not reach the server — it may be asleep or restarting.';
    if (e?.status) return `The server returned ${e.status}.`;
    return 'That action failed.';
  }

  /** Two-step delete: the first click arms it, the second confirms. */
  remove(card: VideoCard): void {
    if (this.confirming() !== card.video.id) {
      this.confirming.set(card.video.id);
      setTimeout(() => {
        if (this.confirming() === card.video.id) this.confirming.set(null);
      }, 4000);
      return;
    }
    this.confirming.set(null);
    this.working.set(card.video.id);
    this.videos.remove(card.video.id).subscribe({
      next: () => {
        this.working.set(null);
        this.refreshList();
        this.refreshStatus();
      },
      error: (err) => {
        this.working.set(null);
        this.actionError.set({ id: card.video.id, message: this.serverMessage(err) });
      },
    });
  }
}
