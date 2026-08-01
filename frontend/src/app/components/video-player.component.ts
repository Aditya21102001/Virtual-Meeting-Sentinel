import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import Hls, { ErrorData, Events, Level } from 'hls.js';
import { VideoCard, timecode } from '../services/video.service';

/** One entry in the quality menu. `levelIndex` is -1 for Auto. */
interface QualityOption {
  levelIndex: number;
  label: string;
  detail: string;
}

/**
 * The video player: adaptive HLS playback with a full custom control surface.
 *
 * <h2>Why hls.js and not just `<video src="…m3u8">`</h2>
 * Only Safari plays HLS natively. Everywhere else hls.js does the work in JavaScript: it reads the
 * master playlist, picks a rung from the measured bandwidth, fetches segments through
 * `fetch`/XHR, and feeds them to the browser through Media Source Extensions. That indirection is
 * also what gives us the things the native element can't offer — a manual quality menu, a live
 * bandwidth estimate, and the segment counter in the stats panel.
 *
 * <h2>Why playback never downloads the whole file</h2>
 * hls.js keeps a bounded forward buffer (see `maxBufferLength`). It fetches the segment containing
 * the playhead plus roughly the next 30 s, and stops. Seeking clears the buffer and restarts from
 * the segment covering the target time, so jumping an hour into a recording costs one segment
 * request. When throughput drops it steps down a rung at the next segment boundary rather than
 * stalling — which is what "smooth, no buffering" actually means in practice.
 *
 * <h2>Zoneless change detection</h2>
 * This app runs without zone.js, so native media events (`timeupdate`, `progress`, …) do not
 * trigger change detection on their own. Every piece of UI state is therefore a signal written
 * from the listener; the template reacts to the signal, not to the event.
 */
@Component({
  selector: 'app-video-player',
  standalone: true,
  template: `
    <div
      class="player"
      #shell
      [class.controls-hidden]="!controlsVisible()"
      [class.fullscreen]="isFullscreen()"
      tabindex="0"
      (keydown)="onKeydown($event)"
      (mousemove)="wakeControls()"
      (mouseleave)="onMouseLeave()"
      (touchstart)="wakeControls()"
    >
      <video
        #media
        [poster]="card().posterUrl ?? ''"
        playsinline
        preload="metadata"
        (click)="togglePlay()"
        (dblclick)="toggleFullscreen()"
      ></video>

      <!-- Centre overlay: play affordance + buffering spinner. -->
      @if (!playing() && !fatalError()) {
        <button class="overlay-play" type="button" (click)="togglePlay()" aria-label="Play">▶</button>
      }
      @if (buffering() && playing()) {
        <div class="spinner" aria-label="Buffering"></div>
      }

      @if (fatalError()) {
        <div class="fatal">
          <div class="fatal-title">Playback failed</div>
          <p>{{ fatalError() }}</p>
          <button type="button" (click)="retry()">Retry</button>
        </div>
      }

      <!-- Stats: makes the adaptive behaviour visible instead of implied. -->
      @if (statsOpen()) {
        <div class="stats">
          <div class="stats-head">
            <strong>Stream</strong>
            <button class="icon" type="button" (click)="statsOpen.set(false)" aria-label="Close stats">
              ✕
            </button>
          </div>
          <dl>
            <dt>Delivery</dt>
            <dd>{{ card().adaptive ? 'HLS · adaptive' : 'progressive · HTTP Range' }}</dd>
            <dt>Playing</dt>
            <dd>{{ activeLevelLabel() }}</dd>
            <dt>Requested</dt>
            <dd>{{ selectedQualityLabel() }}</dd>
            <dt>Bandwidth</dt>
            <dd>{{ bandwidthLabel() }}</dd>
            <dt>Buffer ahead</dt>
            <dd>{{ bufferAhead().toFixed(1) }} s</dd>
            @if (card().adaptive) {
              <dt>Segment</dt>
              <dd>
                #{{ currentSegment() ?? '—' }}
                @if (card().video.totalSegments) {
                  <span class="muted-inline">of {{ segmentsPerRendition() }}</span>
                }
              </dd>
              <dt>Loaded</dt>
              <dd>{{ segmentsLoaded() }} segment(s)</dd>
            }
            <dt>Dropped</dt>
            <dd>{{ droppedFrames() }} frames</dd>
          </dl>
        </div>
      }

      <!-- Control bar -->
      <div class="controls" (click)="$event.stopPropagation()">
        <!-- Scrubber: buffered ranges behind, played progress in front, hover preview above. -->
        <div
          class="scrub"
          #scrub
          (pointerdown)="startScrub($event)"
          (pointermove)="onScrubHover($event)"
          (pointerleave)="hoverTime.set(null)"
        >
          <div class="track">
            @for (range of bufferedRanges(); track range.start) {
              <div
                class="buffered"
                [style.left.%]="range.start"
                [style.width.%]="range.width"
              ></div>
            }
            <div class="played" [style.width.%]="playedPercent()"></div>
            <div class="knob" [style.left.%]="playedPercent()"></div>
          </div>

          @if (hoverTime() !== null) {
            <div class="preview" [style.left.%]="hoverPercent()">
              @if (spriteStyle(); as sprite) {
                <div
                  class="preview-thumb"
                  [style.background-image]="sprite.image"
                  [style.background-position]="sprite.position"
                  [style.width.px]="sprite.width"
                  [style.height.px]="sprite.height"
                ></div>
              }
              <span class="preview-time">{{ timecode(hoverTime()!) }}</span>
            </div>
          }
        </div>

        <div class="buttons">
          <button class="icon" type="button" (click)="togglePlay()" [attr.aria-label]="playing() ? 'Pause' : 'Play'">
            {{ playing() ? '⏸' : '▶' }}
          </button>
          <button class="icon" type="button" (click)="skip(-10)" aria-label="Back 10 seconds">⏪</button>
          <button class="icon" type="button" (click)="skip(10)" aria-label="Forward 10 seconds">⏩</button>

          <div class="volume">
            <button class="icon" type="button" (click)="toggleMute()" [attr.aria-label]="muted() ? 'Unmute' : 'Mute'">
              {{ muted() || volume() === 0 ? '🔇' : volume() < 0.5 ? '🔉' : '🔊' }}
            </button>
            <input
              class="slider"
              type="range"
              min="0"
              max="1"
              step="0.01"
              [value]="muted() ? 0 : volume()"
              (input)="setVolume($event)"
              aria-label="Volume"
            />
          </div>

          <span class="time">{{ timecode(currentTime()) }} / {{ timecode(duration()) }}</span>

          <span class="spacer"></span>

          <!-- Speed -->
          <div class="menu-wrap">
            <button class="text-btn" type="button" (click)="toggleMenu('speed')">
              {{ speed() }}×
            </button>
            @if (openMenu() === 'speed') {
              <div class="menu">
                @for (option of SPEEDS; track option) {
                  <button
                    type="button"
                    [class.on]="speed() === option"
                    (click)="setSpeed(option)"
                  >
                    {{ option }}× @if (option === 1) { <span class="muted-inline">normal</span> }
                  </button>
                }
              </div>
            }
          </div>

          <!-- Quality -->
          @if (qualityOptions().length > 1) {
            <div class="menu-wrap">
              <button class="text-btn" type="button" (click)="toggleMenu('quality')">
                {{ selectedQualityLabel() }}
              </button>
              @if (openMenu() === 'quality') {
                <div class="menu wide">
                  @for (option of qualityOptions(); track option.levelIndex) {
                    <button
                      type="button"
                      [class.on]="selectedLevel() === option.levelIndex"
                      (click)="setLevel(option.levelIndex)"
                    >
                      {{ option.label }}
                      <span class="muted-inline">{{ option.detail }}</span>
                    </button>
                  }
                </div>
              }
            </div>
          }

          <button
            class="icon"
            type="button"
            [class.on]="statsOpen()"
            (click)="statsOpen.set(!statsOpen())"
            aria-label="Stream stats"
          >
            📊
          </button>

          @if (pipSupported) {
            <button class="icon" type="button" (click)="togglePip()" aria-label="Picture in picture">
              ⧉
            </button>
          }
          <button
            class="icon"
            type="button"
            (click)="toggleFullscreen()"
            [attr.aria-label]="isFullscreen() ? 'Exit fullscreen' : 'Fullscreen'"
          >
            {{ isFullscreen() ? '⤡' : '⛶' }}
          </button>
        </div>
      </div>
    </div>

    <p class="shortcuts muted">
      <strong>Keys:</strong> space play/pause · ←/→ 5s · J/L 10s · ↑/↓ volume · M mute · F fullscreen
      · P picture-in-picture · 0–9 jump to % · , / . frame step
    </p>
  `,
  styles: [
    `
      .player {
        position: relative;
        background: #000;
        border-radius: 12px;
        overflow: hidden;
        outline: none;
        aspect-ratio: 16 / 9;
        width: 100%;
      }
      .player:focus-visible {
        box-shadow: 0 0 0 2px var(--accent);
      }
      .player.fullscreen {
        border-radius: 0;
        aspect-ratio: auto;
        height: 100%;
      }
      video {
        width: 100%;
        height: 100%;
        display: block;
        background: #000;
        object-fit: contain;
      }

      /* ---- centre overlays ---- */
      .overlay-play {
        position: absolute;
        inset: 0;
        margin: auto;
        width: 76px;
        height: 76px;
        border-radius: 50%;
        border: none;
        background: #0f172acc;
        color: #fff;
        font-size: 28px;
        cursor: pointer;
        padding: 0;
      }
      .spinner {
        position: absolute;
        inset: 0;
        margin: auto;
        width: 46px;
        height: 46px;
        border: 3px solid #ffffff33;
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        pointer-events: none;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      .fatal {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        background: #0f172aee;
        text-align: center;
        padding: 20px;
      }
      .fatal-title {
        font-weight: 700;
        color: #fca5a5;
      }
      .fatal p {
        margin: 0;
        font-size: 13px;
        color: var(--muted);
        max-width: 420px;
      }

      /* ---- stats ---- */
      .stats {
        position: absolute;
        top: 10px;
        right: 10px;
        background: #0f172aee;
        border: 1px solid #334155;
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 12px;
        min-width: 218px;
        max-width: calc(100% - 20px);
      }
      .stats-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }
      .stats dl {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 3px 10px;
        margin: 0;
      }
      .stats dt {
        color: var(--muted);
      }
      .stats dd {
        margin: 0;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      /* ---- control bar ---- */
      .controls {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        padding: 24px 12px 8px;
        background: linear-gradient(transparent, #000000d9);
        transition: opacity 0.2s;
      }
      .controls-hidden .controls {
        opacity: 0;
        pointer-events: none;
      }
      .controls-hidden video {
        cursor: none;
      }

      .scrub {
        padding: 8px 0;
        cursor: pointer;
        position: relative;
        touch-action: none;
      }
      .track {
        position: relative;
        height: 5px;
        background: #ffffff2e;
        border-radius: 999px;
      }
      .buffered,
      .played {
        position: absolute;
        top: 0;
        bottom: 0;
        border-radius: 999px;
      }
      .buffered {
        background: #ffffff45;
      }
      .played {
        background: var(--accent);
        left: 0;
      }
      .knob {
        position: absolute;
        top: 50%;
        width: 13px;
        height: 13px;
        margin-left: -6.5px;
        border-radius: 50%;
        background: var(--accent);
        transform: translateY(-50%);
      }

      .preview {
        position: absolute;
        bottom: 26px;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        pointer-events: none;
      }
      .preview-thumb {
        background-repeat: no-repeat;
        border: 1px solid #475569;
        border-radius: 4px;
        max-width: 176px;
      }
      .preview-time {
        background: #000000cc;
        border-radius: 4px;
        padding: 1px 6px;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }

      .buttons {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .spacer {
        flex: 1;
      }
      .icon,
      .text-btn {
        background: none;
        border: none;
        color: #fff;
        cursor: pointer;
        padding: 5px 7px;
        border-radius: 6px;
        width: auto;
        font-size: 15px;
        line-height: 1;
      }
      .text-btn {
        font-size: 12px;
        font-weight: 700;
      }
      .icon:hover,
      .text-btn:hover {
        background: #ffffff26;
      }
      .icon.on {
        color: var(--accent);
      }
      .time {
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        color: #e2e8f0;
        margin-left: 6px;
        white-space: nowrap;
      }

      .volume {
        display: flex;
        align-items: center;
      }
      .slider {
        width: 74px;
        padding: 0;
        border: none;
        background: none;
        accent-color: var(--accent);
        cursor: pointer;
      }

      .menu-wrap {
        position: relative;
      }
      .menu {
        position: absolute;
        bottom: 34px;
        right: 0;
        background: #0f172af7;
        border: 1px solid #334155;
        border-radius: 8px;
        padding: 4px;
        min-width: 104px;
        z-index: 3;
      }
      .menu.wide {
        min-width: 168px;
      }
      .menu button {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        width: 100%;
        background: none;
        border: none;
        color: var(--text);
        text-align: left;
        padding: 7px 9px;
        border-radius: 6px;
        font-size: 13px;
        cursor: pointer;
      }
      .menu button:hover {
        background: #ffffff1a;
      }
      .menu button.on {
        color: var(--accent);
        font-weight: 700;
      }
      .muted-inline {
        color: var(--muted);
        font-size: 11px;
        font-weight: 400;
      }

      .shortcuts {
        margin: 8px 0 0;
      }

      @media (max-width: 640px) {
        .slider {
          width: 48px;
        }
        .time {
          font-size: 11px;
        }
        .icon {
          padding: 5px 4px;
        }
        .shortcuts {
          display: none;
        }
      }
    `,
  ],
})
export class VideoPlayerComponent implements OnDestroy {
  /**
   * The video to play. A **signal** input on purpose: when the library switches videos Angular
   * reuses this component and only updates the input, so a plain `@Input` would leave the setup
   * effect untracked and the previous stream still playing.
   */
  readonly card = input.required<VideoCard>();
  /** Start playing as soon as the manifest is parsed. */
  readonly autoplay = input(false);

  readonly SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  readonly timecode = timecode;
  readonly pipSupported = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document;

  private readonly mediaRef = viewChild.required<ElementRef<HTMLVideoElement>>('media');
  private readonly shellRef = viewChild.required<ElementRef<HTMLElement>>('shell');
  private readonly scrubRef = viewChild.required<ElementRef<HTMLElement>>('scrub');

  // ---- playback state (signals: zoneless CD reacts to these, not to media events) ----
  readonly playing = signal(false);
  readonly buffering = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly volume = signal(1);
  readonly muted = signal(false);
  readonly speed = signal(1);
  readonly isFullscreen = signal(false);
  readonly controlsVisible = signal(true);
  readonly statsOpen = signal(false);
  readonly openMenu = signal<'speed' | 'quality' | null>(null);
  readonly fatalError = signal<string | null>(null);
  readonly hoverTime = signal<number | null>(null);
  readonly bufferedRanges = signal<{ start: number; width: number }[]>([]);

  // ---- adaptive-stream state ----
  readonly levels = signal<Level[]>([]);
  readonly selectedLevel = signal(-1);   // -1 = Auto
  readonly activeLevel = signal(-1);
  readonly bandwidth = signal(0);
  readonly bufferAhead = signal(0);
  readonly currentSegment = signal<number | null>(null);
  readonly segmentsLoaded = signal(0);
  readonly droppedFrames = signal(0);

  readonly playedPercent = computed(() => {
    const total = this.duration();
    return total > 0 ? Math.min(100, (this.currentTime() / total) * 100) : 0;
  });

  readonly hoverPercent = computed(() => {
    const total = this.duration();
    const at = this.hoverTime();
    return total > 0 && at !== null ? Math.min(100, Math.max(0, (at / total) * 100)) : 0;
  });

  /** Auto plus one entry per ladder rung, highest quality first. */
  readonly qualityOptions = computed<QualityOption[]>(() => {
    const levels = this.levels();
    if (!levels.length) return [];
    const options: QualityOption[] = [{ levelIndex: -1, label: 'Auto', detail: 'adapts to network' }];
    // hls.js orders levels lowest-first; the menu reads better highest-first.
    levels
      .map((level, index) => ({ level, index }))
      .sort((a, b) => b.level.height - a.level.height)
      .forEach(({ level, index }) => {
        options.push({
          levelIndex: index,
          label: `${level.height}p`,
          detail: `${Math.round((level.bitrate ?? 0) / 1000)} kbps`,
        });
      });
    return options;
  });

  readonly selectedQualityLabel = computed(() => {
    const selected = this.selectedLevel();
    if (selected < 0) {
      const active = this.activeLevel();
      const level = this.levels()[active];
      return level ? `Auto (${level.height}p)` : 'Auto';
    }
    const level = this.levels()[selected];
    return level ? `${level.height}p` : 'Auto';
  });

  readonly activeLevelLabel = computed(() => {
    const level = this.levels()[this.activeLevel()];
    if (level) return `${level.width}×${level.height} · ${Math.round(level.bitrate / 1000)} kbps`;
    const video = this.card().video;
    return video.width ? `${video.width}×${video.height}` : '—';
  });

  readonly bandwidthLabel = computed(() => {
    const bits = this.bandwidth();
    if (!bits) return '—';
    return bits >= 1_000_000
      ? `${(bits / 1_000_000).toFixed(1)} Mbps`
      : `${Math.round(bits / 1000)} kbps`;
  });

  /** Segments in the rung being played (falls back to the catalogue total). */
  readonly segmentsPerRendition = computed(() => {
    const video = this.card().video;
    return video.renditions.length ? video.renditions[0].segmentCount : video.totalSegments;
  });

  /**
   * CSS to show the filmstrip tile for the hovered second. The sprite is one image; the tile is
   * selected purely by shifting the background — no extra network request per preview.
   */
  readonly spriteStyle = computed(() => {
    const card = this.card();
    const sprite = card.video.sprite;
    const url = card.spriteUrl;
    const at = this.hoverTime();
    if (!sprite || !url || at === null || !sprite.tileWidth || !sprite.intervalSeconds) return null;

    const index = Math.floor(at / sprite.intervalSeconds);
    const columns = Math.max(1, sprite.columns);
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      image: `url("${url}")`,
      position: `-${column * sprite.tileWidth}px -${row * sprite.tileHeight}px`,
      width: sprite.tileWidth,
      height: sprite.tileHeight,
    };
  });

  private hls: Hls | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private rafHandle = 0;
  private scrubbing = false;
  private wasPlayingBeforeScrub = false;
  private readonly onFullscreenChange = () =>
    this.isFullscreen.set(document.fullscreenElement === this.shellRef().nativeElement);

  private eventsBound = false;

  constructor() {
    // `card()` is the ONE tracked dependency: when the library switches videos this re-runs, the old
    // hls instance is torn down, per-video state is reset, and the new stream loads into the same
    // element. (viewChild signals resolve after the first render, which is also why setup is here.)
    //
    // The setup itself is `untracked` on purpose. It reads volume/speed to apply them to the new
    // element, and without this the effect would depend on them too — so nudging the volume slider
    // would re-run setup and restart the video from the beginning.
    effect((onCleanup) => {
      const card = this.card();
      untracked(() => {
        const element = this.mediaRef().nativeElement;
        // Listeners belong to the element, not the video — bind them exactly once.
        if (!this.eventsBound) {
          this.bindMediaEvents(element);
          this.eventsBound = true;
        }
        this.resetForNewVideo(card);
        this.loadStream(element);
        this.startClock();
      });
      onCleanup(() => this.teardown());
    });
    document.addEventListener('fullscreenchange', this.onFullscreenChange);
  }

  /**
   * Clear everything that described the previous video. Volume, mute and speed are deliberately
   * kept — those are the viewer's preferences, not properties of the recording.
   */
  private resetForNewVideo(card: VideoCard): void {
    this.playing.set(false);
    this.buffering.set(false);
    this.currentTime.set(0);
    this.duration.set(card.video.durationSeconds ?? 0);
    this.fatalError.set(null);
    this.hoverTime.set(null);
    this.bufferedRanges.set([]);
    this.levels.set([]);
    this.selectedLevel.set(-1);
    this.activeLevel.set(-1);
    this.currentSegment.set(null);
    this.segmentsLoaded.set(0);
    this.bufferAhead.set(0);
    this.openMenu.set(null);
    this.controlsVisible.set(true);
  }

  ngOnDestroy(): void {
    this.teardown();
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    if (this.hideTimer) clearTimeout(this.hideTimer);
  }

  // ---- setup ---------------------------------------------------------------

  /** Point the element at the stream. Safe to call again (retry, or a new card) — binds nothing. */
  private loadStream(element: HTMLVideoElement): void {
    const card = this.card();
    const source = card.streamUrl;
    if (!source) {
      this.fatalError.set('This video has no playable stream yet.');
      return;
    }
    element.volume = this.volume();
    element.playbackRate = this.speed();

    if (card.adaptive && Hls.isSupported()) {
      this.startHls(element, source);
    } else {
      // Safari plays HLS natively, and progressive files are a plain src with Range requests.
      element.src = source;
      if (this.autoplay()) void element.play().catch(() => undefined);
    }
  }

  private startHls(element: HTMLVideoElement, source: string): void {
    const hls = new Hls({
      // Bounded look-ahead. This is the setting that keeps playback from turning into a download:
      // never hold more than ~30 s / 60 MB of video, however long the recording is.
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      backBufferLength: 30,
      maxBufferSize: 60 * 1000 * 1000,
      // Start conservatively and let the ABR controller climb once it has measured throughput —
      // opening on the top rung is what causes the initial stall people read as "buffering".
      startLevel: -1,
      capLevelToPlayerSize: true,
      // Retry a flaky segment rather than killing the session; a single lost .ts is recoverable.
      fragLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 10_000,
          maxLoadTimeMs: 120_000,
          timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
          errorRetry: { maxNumRetry: 4, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
        },
      },
    });
    this.hls = hls;

    hls.on(Events.MANIFEST_PARSED, (_event, data) => {
      this.levels.set([...data.levels]);
      this.fatalError.set(null);
      if (this.autoplay()) void element.play().catch(() => undefined);
    });

    hls.on(Events.LEVEL_SWITCHED, (_event, data) => this.activeLevel.set(data.level));

    // FRAG_CHANGED fires as the playhead enters each segment — the clearest evidence that
    // playback is segment-by-segment rather than one long download.
    hls.on(Events.FRAG_CHANGED, (_event, data) => this.currentSegment.set(data.frag.sn as number));
    hls.on(Events.FRAG_BUFFERED, () => this.segmentsLoaded.update((n) => n + 1));
    hls.on(Events.ERROR, (_event, data) => this.onHlsError(data));

    hls.loadSource(source);
    hls.attachMedia(element);
  }

  /**
   * hls.js reports both survivable and fatal errors. Network and media errors are recovered in
   * place — a dropped segment or a decoder hiccup should not end the session; only a genuinely
   * fatal error surfaces to the user.
   */
  private onHlsError(data: ErrorData): void {
    if (!data.fatal) return;
    const hls = this.hls;
    if (!hls) return;

    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR
          || data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR) {
        this.fatalError.set(
          'Could not load the stream manifest. The playback link may have expired — reload the page.',
        );
        return;
      }
      hls.startLoad();
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      hls.recoverMediaError();
      return;
    }
    this.fatalError.set(data.details ?? 'The stream could not be played.');
    hls.destroy();
    this.hls = null;
  }

  private bindMediaEvents(element: HTMLVideoElement): void {
    element.addEventListener('play', () => {
      this.playing.set(true);
      this.scheduleHide();
    });
    element.addEventListener('pause', () => {
      this.playing.set(false);
      this.wakeControls();
    });
    element.addEventListener('ended', () => {
      this.playing.set(false);
      this.controlsVisible.set(true);
    });
    element.addEventListener('waiting', () => this.buffering.set(true));
    element.addEventListener('playing', () => this.buffering.set(false));
    element.addEventListener('canplay', () => this.buffering.set(false));
    element.addEventListener('loadedmetadata', () => this.duration.set(element.duration || 0));
    element.addEventListener('durationchange', () => this.duration.set(element.duration || 0));
    element.addEventListener('volumechange', () => {
      this.volume.set(element.volume);
      this.muted.set(element.muted);
    });
    element.addEventListener('ratechange', () => this.speed.set(element.playbackRate));
    element.addEventListener('progress', () => this.refreshBuffered(element));
    element.addEventListener('error', () => {
      if (!this.hls) this.fatalError.set('The browser could not decode this file.');
    });
  }

  /**
   * The scrubber is driven by rAF rather than `timeupdate`, which only fires ~4×/s and makes the
   * knob visibly step. Nothing else runs per-frame: buffered ranges and the stats numbers move
   * slowly, so they get a 500 ms timer instead — a signal write per frame is a change-detection
   * pass per frame, and there is no reason to pay that for a bandwidth readout.
   */
  private startClock(): void {
    const tick = () => {
      if (!this.scrubbing) this.currentTime.set(this.mediaRef().nativeElement.currentTime);
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);

    this.statsTimer = setInterval(() => {
      const element = this.mediaRef().nativeElement;
      this.refreshBuffered(element);
      this.bufferAhead.set(this.bufferedAheadOf(element));
      if (this.hls) this.bandwidth.set(this.hls.bandwidthEstimate ?? 0);
      const quality = element.getVideoPlaybackQuality?.();
      if (quality) this.droppedFrames.set(quality.droppedVideoFrames);
    }, 500);
  }

  /** Seconds of contiguous buffer in front of the playhead — how much stall headroom there is. */
  private bufferedAheadOf(element: HTMLVideoElement): number {
    const buffered = element.buffered;
    for (let i = 0; i < buffered.length; i++) {
      if (element.currentTime >= buffered.start(i) && element.currentTime <= buffered.end(i)) {
        return buffered.end(i) - element.currentTime;
      }
    }
    return 0;
  }

  private refreshBuffered(element: HTMLVideoElement): void {
    const total = element.duration;
    if (!total || !Number.isFinite(total)) return;
    const ranges: { start: number; width: number }[] = [];
    for (let i = 0; i < element.buffered.length; i++) {
      const start = (element.buffered.start(i) / total) * 100;
      const end = (element.buffered.end(i) / total) * 100;
      ranges.push({ start, width: Math.max(0, end - start) });
    }
    this.bufferedRanges.set(ranges);
  }

  private teardown(): void {
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.hls?.destroy();
    this.hls = null;
  }

  // ---- controls ------------------------------------------------------------

  togglePlay(): void {
    const element = this.mediaRef().nativeElement;
    if (element.paused) void element.play().catch(() => undefined);
    else element.pause();
  }

  skip(seconds: number): void {
    this.seekTo(this.mediaRef().nativeElement.currentTime + seconds);
  }

  /** Seeking is the point of segmentation: only the target segment is fetched. */
  seekTo(seconds: number): void {
    const element = this.mediaRef().nativeElement;
    const total = element.duration || this.duration();
    const target = Math.min(Math.max(0, seconds), total || 0);
    element.currentTime = target;
    this.currentTime.set(target);
  }

  setVolume(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    const element = this.mediaRef().nativeElement;
    element.volume = value;
    element.muted = value === 0;
  }

  toggleMute(): void {
    const element = this.mediaRef().nativeElement;
    element.muted = !element.muted;
  }

  setSpeed(rate: number): void {
    this.mediaRef().nativeElement.playbackRate = rate;
    this.openMenu.set(null);
  }

  /**
   * Pin a rung, or -1 to hand control back to the ABR controller. hls.js applies the change at the
   * next segment boundary, so the switch is seamless rather than a re-buffer.
   */
  setLevel(levelIndex: number): void {
    this.selectedLevel.set(levelIndex);
    if (this.hls) this.hls.currentLevel = levelIndex;
    this.openMenu.set(null);
  }

  toggleMenu(which: 'speed' | 'quality'): void {
    this.openMenu.update((open) => (open === which ? null : which));
    this.wakeControls();
  }

  async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await this.shellRef().nativeElement.requestFullscreen();
    } catch {
      /* The browser can refuse without a user gesture; nothing useful to report. */
    }
  }

  async togglePip(): Promise<void> {
    const element = this.mediaRef().nativeElement;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await element.requestPictureInPicture();
    } catch {
      /* Unsupported or blocked — the button simply does nothing. */
    }
  }

  retry(): void {
    this.fatalError.set(null);
    this.segmentsLoaded.set(0);
    this.hls?.destroy();
    this.hls = null;
    this.loadStream(this.mediaRef().nativeElement);
  }

  // ---- scrubbing -----------------------------------------------------------

  startScrub(event: PointerEvent): void {
    const track = this.scrubRef().nativeElement;
    track.setPointerCapture(event.pointerId);
    this.scrubbing = true;
    this.wasPlayingBeforeScrub = this.playing();
    // Pause while dragging so the preview time doesn't fight the advancing playhead.
    if (this.wasPlayingBeforeScrub) this.mediaRef().nativeElement.pause();
    this.applyScrub(event);

    const move = (e: PointerEvent) => this.applyScrub(e);
    const end = (e: PointerEvent) => {
      this.applyScrub(e);
      this.scrubbing = false;
      track.releasePointerCapture(e.pointerId);
      track.removeEventListener('pointermove', move);
      track.removeEventListener('pointerup', end);
      track.removeEventListener('pointercancel', end);
      if (this.wasPlayingBeforeScrub) void this.mediaRef().nativeElement.play().catch(() => undefined);
    };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
  }

  onScrubHover(event: PointerEvent): void {
    this.hoverTime.set(this.timeAt(event));
  }

  private applyScrub(event: PointerEvent): void {
    const at = this.timeAt(event);
    this.hoverTime.set(at);
    this.seekTo(at);
  }

  private timeAt(event: PointerEvent): number {
    const rect = this.scrubRef().nativeElement.getBoundingClientRect();
    const ratio = rect.width ? (event.clientX - rect.left) / rect.width : 0;
    return Math.min(1, Math.max(0, ratio)) * (this.duration() || 0);
  }

  // ---- auto-hide + keyboard ------------------------------------------------

  wakeControls(): void {
    this.controlsVisible.set(true);
    this.scheduleHide();
  }

  onMouseLeave(): void {
    this.hoverTime.set(null);
    if (this.playing()) this.controlsVisible.set(false);
  }

  private scheduleHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      // Never hide the bar while a menu is open or playback is parked.
      if (this.playing() && !this.openMenu()) this.controlsVisible.set(false);
    }, 2600);
  }

  /** Standard player shortcuts, active whenever the player has focus. */
  onKeydown(event: KeyboardEvent): void {
    const element = this.mediaRef().nativeElement;
    let handled = true;

    switch (event.key) {
      case ' ':
      case 'k':
      case 'K':
        this.togglePlay();
        break;
      case 'ArrowRight':
        this.skip(5);
        break;
      case 'ArrowLeft':
        this.skip(-5);
        break;
      case 'l':
      case 'L':
        this.skip(10);
        break;
      case 'j':
      case 'J':
        this.skip(-10);
        break;
      case 'ArrowUp':
        element.volume = Math.min(1, element.volume + 0.1);
        element.muted = false;
        break;
      case 'ArrowDown':
        element.volume = Math.max(0, element.volume - 0.1);
        break;
      case 'm':
      case 'M':
        this.toggleMute();
        break;
      case 'f':
      case 'F':
        void this.toggleFullscreen();
        break;
      case 'p':
      case 'P':
        void this.togglePip();
        break;
      case ',':
        // Frame step: 1/frameRate back, using the probed rate when we have it.
        this.skip(-1 / (this.card().video.frameRate || 25));
        break;
      case '.':
        this.skip(1 / (this.card().video.frameRate || 25));
        break;
      case 'Escape':
        this.openMenu.set(null);
        handled = false;
        break;
      default:
        if (/^[0-9]$/.test(event.key)) {
          this.seekTo(((this.duration() || 0) * Number(event.key)) / 10);
        } else {
          handled = false;
        }
    }

    if (handled) {
      event.preventDefault();
      this.wakeControls();
    }
  }
}
