import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
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
          }
        </div>
        @if (busy()) {
          <div class="bar"><div class="bar-fill" [style.width.%]="uploadPercent()"></div></div>
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
  readonly humanBytes = humanBytes;
  readonly timecode = timecode;

  readonly status = signal<VideoStorageStatus | null>(null);
  readonly cards = signal<VideoCard[]>([]);

  readonly file = signal<File | null>(null);
  title = '';
  description = '';
  readonly busy = signal(false);
  readonly uploadPercent = signal(0);
  readonly sentBytes = signal(0);
  readonly totalBytes = signal(0);
  readonly message = signal('');
  readonly uploadError = signal('');

  readonly editing = signal<string | null>(null);
  editTitle = '';
  editDescription = '';
  readonly working = signal<string | null>(null);
  readonly confirming = signal<string | null>(null);

  private poller: ReturnType<typeof setInterval> | null = null;
  private uploadSub: Subscription | null = null;

  constructor(private videos: VideoService) {}

  ngOnInit(): void {
    this.refreshStatus();
    this.refreshList();
    // Poll only while something is mid-transcode; the interval stops itself otherwise.
    this.poller = setInterval(() => {
      if (this.cards().some((card) => card.video.status === 'PROCESSING')) this.refreshList();
    }, 2000);
  }

  ngOnDestroy(): void {
    if (this.poller) clearInterval(this.poller);
    this.uploadSub?.unsubscribe();
  }

  // ---- data ----------------------------------------------------------------

  private refreshStatus(): void {
    this.videos.status().subscribe({ next: (s) => this.status.set(s) });
  }

  private refreshList(): void {
    this.videos.listAll().subscribe({ next: (cards) => this.cards.set(cards) });
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
    this.uploadError.set('');
    this.message.set('');
    const limit = this.status()?.maxUploadBytes;
    if (chosen && limit && chosen.size > limit) {
      this.uploadError.set(
        `That file is ${humanBytes(chosen.size)} — over the ${humanBytes(limit)} limit.`,
      );
    }
  }

  upload(): void {
    const chosen = this.file();
    if (!chosen || this.uploadError()) return;

    this.busy.set(true);
    this.uploadPercent.set(0);
    this.sentBytes.set(0);
    this.totalBytes.set(chosen.size);
    this.message.set('');

    this.uploadSub = this.videos.upload(chosen, this.title, this.description).subscribe({
      next: (event) => {
        if (event.kind === 'progress') {
          this.uploadPercent.set(event.percent);
          this.sentBytes.set(event.sentBytes);
          this.totalBytes.set(event.totalBytes);
        } else {
          this.busy.set(false);
          this.title = '';
          this.description = '';
          this.file.set(null);
          this.message.set(
            `✓ "${event.card.video.title}" uploaded. Segmenting now — progress appears below.`,
          );
          this.refreshList();
          this.refreshStatus();
        }
      },
      error: (err) => {
        this.busy.set(false);
        this.uploadError.set(
          '✗ ' + (err?.error?.message ?? err?.error?.error ?? 'Upload failed. Is the server running?'),
        );
      },
    });
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
    this.videos.reprocess(card.video.id).subscribe({
      next: () => {
        this.working.set(null);
        this.refreshList();
      },
      error: () => this.working.set(null),
    });
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
      error: () => this.working.set(null),
    });
  }
}
