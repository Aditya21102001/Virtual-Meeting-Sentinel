import {
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import Hls, { ErrorData, Events, Level } from 'hls.js';
import { createMediaLoader } from '../services/sealed-key-loader';
import { PlaybackProgressService } from '../services/playback-progress.service';
import { PlayerHostService } from '../services/player-host.service';
import { FeatureService } from '../services/feature.service';
import {
  SegmentLocation,
  TranscriptCue,
  VideoCard,
  VideoService,
  humanBytes,
  timecode,
} from '../services/video.service';

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
        [style.transform]="videoTransform()"
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

      <!--
        Resume notice. Playback has already started at the right place by the time this renders —
        it exists so the jump is explained rather than surprising, and so there is a way back.
        The segment line arrives a moment later from the server's index lookup.
      -->
      @if (resumedFrom() !== null) {
        <div class="resume-note">
          <span class="resume-main">Resumed from {{ timecode(resumedFrom()!) }}</span>
          @if (resumeLocation(); as at) {
            <span class="resume-detail">
              segment {{ at.segment.seq }} of {{ at.segmentCount }} ·
              {{ at.rendition }} · {{ bytes(at.byteOffset) }} into
              {{ bytes(at.renditionBytes) }}
            </span>
          }
          <button class="resume-action" type="button" (click)="startOver()">Start over</button>
          <button class="icon" type="button" (click)="dismissResumeNotice()" aria-label="Dismiss">
            ✕
          </button>
        </div>
      }

      <!--
        Captions, drawn by us rather than by a <track>. A <track> would need
        crossorigin="anonymous" on the <video> for a cross-origin URL, which also changes how the
        media and poster are fetched — letting a secondary feature break playback.
      -->
      @if (captionsOn() && activeCue(); as cue) {
        <div class="caption"><span>{{ cue.text }}</span></div>
      }

      <!--
        Chapter list. An overlay rather than a column beside the video: the player is embedded at
        whatever width the page gives it, and a side panel would have to steal that width from the
        picture on exactly the small screens where the picture matters most.
      -->
      @if (chaptersOpen() && chapterSpans().length) {
        <div class="chapters">
          <div class="chapters-head">
            <strong>Chapters</strong>
            <button
              class="icon"
              type="button"
              (click)="chaptersOpen.set(false)"
              aria-label="Close chapters"
            >
              ✕
            </button>
          </div>
          <ol>
            @for (chapter of chapterSpans(); track chapter.id) {
              <li>
                <button
                  type="button"
                  class="chapter-row"
                  [class.current]="activeChapter()?.id === chapter.id"
                  (click)="jumpToChapter(chapter.startSeconds)"
                  [attr.aria-current]="activeChapter()?.id === chapter.id ? 'true' : null"
                >
                  <span class="chapter-time">{{ timecode(chapter.startSeconds) }}</span>
                  <span class="chapter-title">{{ chapter.title }}</span>
                </button>
              </li>
            }
          </ol>
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
            <!--
              Chapter dividers. Thin gaps cut into the bar at each boundary rather than separate
              sub-bars: the played fill and buffered ranges already span the whole track, so drawing
              per-chapter bars would mean re-implementing both on top of them.
            -->
            @for (chapter of chapterSpans(); track chapter.id) {
              @if (chapter.leftPercent > 0) {
                <div class="chapter-divider" [style.left.%]="chapter.leftPercent"></div>
              }
            }
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
              <!-- Which agenda item you would land on, above the timecode, as YouTube does. -->
              @if (hoveredChapter(); as chapter) {
                <span class="preview-chapter">{{ chapter.title }}</span>
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

          <!--
            Which agenda item is playing, next to the clock as YouTube shows it. Clicking it opens
            the list, which is the gesture people already expect from that label.
          -->
          @if (activeChapter(); as chapter) {
            <button
              type="button"
              class="now-chapter"
              (click)="chaptersOpen.set(!chaptersOpen())"
              [title]="chapter.title"
            >
              {{ chapter.title }}
            </button>
          }

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
            [class.on]="rotation() !== 0"
            (click)="rotate()"
            [attr.aria-label]="'Rotate (currently ' + rotation() + ' degrees)'"
            title="Rotate — for footage recorded sideways"
          >
            ⟳
          </button>

          <!-- Only offered when there is actually a transcript to show. -->
          @if (cues().length) {
            <button
              class="icon"
              type="button"
              [class.on]="captionsOn()"
              (click)="captionsOn.set(!captionsOn())"
              [attr.aria-label]="captionsOn() ? 'Hide captions' : 'Show captions'"
              [attr.aria-pressed]="captionsOn()"
            >
              CC
            </button>
          }

          <button
            class="icon"
            type="button"
            [class.on]="loopEnabled()"
            (click)="loopEnabled.set(!loopEnabled())"
            [attr.aria-label]="loopEnabled() ? 'Turn off loop' : 'Loop this recording'"
            [attr.aria-pressed]="loopEnabled()"
            title="Loop"
          >
            ↻
          </button>

          <!-- Same rule as captions: no agenda, no button. -->
          @if (chapterSpans().length) {
            <button
              class="icon"
              type="button"
              [class.on]="chaptersOpen()"
              (click)="chaptersOpen.set(!chaptersOpen())"
              [attr.aria-label]="chaptersOpen() ? 'Hide chapters' : 'Show chapters'"
              [attr.aria-pressed]="chaptersOpen()"
              title="Chapters"
            >
              ☰
            </button>
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
          <!--
            Theater mode. Hidden in fullscreen, where it would do nothing: fullscreen is already
            strictly wider, so offering both would present a choice with no visible effect.
          -->
          @if (!isFullscreen()) {
            <button
              class="icon"
              type="button"
              [class.on]="theater()"
              (click)="toggleTheater()"
              [attr.aria-label]="theater() ? 'Exit theater mode' : 'Theater mode'"
              [attr.aria-pressed]="theater()"
              title="Theater mode (t)"
            >
              {{ theater() ? '▭' : '▬' }}
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
      · T theater · P picture-in-picture · 0–9 jump to % · , / . frame step
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

      /* ---- captions ---- */
      .caption {
        position: absolute;
        /* Above the control bar, so it is not covered when the controls are showing. */
        bottom: 72px;
        left: 50%;
        transform: translateX(-50%);
        max-width: 84%;
        text-align: center;
        pointer-events: none;
        z-index: 2;
      }
      .caption span {
        display: inline-block;
        padding: 4px 10px;
        border-radius: 6px;
        background: #000000b8;
        color: #fff;
        font-size: 17px;
        line-height: 1.35;
        /* Keeps the text legible over a bright frame without a full-width bar. */
        text-shadow: 0 1px 2px #000;
      }
      .controls-hidden .caption {
        bottom: 24px;
      }

      /* ---- resume notice ---- */
      .resume-note {
        position: absolute;
        top: 10px;
        left: 10px;
        right: 10px;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 4px 10px;
        padding: 8px 10px;
        border-radius: 8px;
        background: #0f172aee;
        border: 1px solid #334155;
        font-size: 13px;
        /* Above the video, below the fatal-error overlay and the controls. */
        z-index: 2;
      }
      .resume-main {
        font-weight: 600;
      }
      .resume-detail {
        color: var(--muted);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }
      .resume-action {
        margin-left: auto;
        background: none;
        border: none;
        color: #93c5fd;
        cursor: pointer;
        font: inherit;
        padding: 0;
        text-decoration: underline;
      }

      /* ---- stats ---- */
      /* ---- chapters ---- */
      /* Left, mirroring the stats panel on the right, so both can be open without overlapping. */
      .chapters {
        position: absolute;
        top: 10px;
        left: 10px;
        background: #0f172aee;
        border: 1px solid #334155;
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 12px;
        min-width: 220px;
        max-width: min(360px, calc(100% - 20px));
        /* A long agenda scrolls inside the panel rather than growing past the video. */
        max-height: calc(100% - 20px);
        overflow-y: auto;
        z-index: 3;
      }
      .chapters-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }
      .chapters ol {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .chapter-row {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 10px;
        width: 100%;
        text-align: left;
        background: none;
        border: 0;
        color: inherit;
        font: inherit;
        padding: 5px 6px;
        border-radius: 6px;
        cursor: pointer;
      }
      .chapter-row:hover,
      .chapter-row:focus-visible {
        background: #1e293b;
      }
      .chapter-row.current {
        background: #1e293b;
        /* The bar, not colour alone — the current row must be identifiable without colour vision. */
        box-shadow: inset 3px 0 0 var(--accent, #38bdf8);
      }
      .chapter-time {
        color: var(--muted);
        font-variant-numeric: tabular-nums;
      }
      .chapter-row.current .chapter-title {
        font-weight: 600;
      }
      /* Divider cut into the scrubber at each boundary. Non-interactive: the click belongs to the
         track underneath, so seeking still works when the pointer lands exactly on a marker. */
      .chapter-divider {
        position: absolute;
        top: 0;
        bottom: 0;
        width: 2px;
        margin-left: -1px;
        background: #0f172a;
        pointer-events: none;
      }
      .preview-chapter {
        display: block;
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: center;
        font-size: 11px;
        color: #e2e8f0;
      }
      /* Truncates rather than pushing the controls around as chapter titles change length. */
      .now-chapter {
        background: none;
        border: 0;
        color: var(--muted);
        font: inherit;
        cursor: pointer;
        padding: 0 4px;
        max-width: 22ch;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .now-chapter:hover {
        color: #e2e8f0;
      }

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

  /**
   * Fired when the recording reaches the end and is not looping.
   *
   * <p>An event rather than the player picking the next recording itself: what plays next is a
   * property of the library, and a player that reached into the catalogue could not be reused
   * anywhere the catalogue is not (Picture-in-Picture, a shared link, an embedded preview).
   */
  readonly finished = output<void>();

  /**
   * Repeat this recording instead of ending.
   *
   * <p>Local to the player and off by default. Deliberately not remembered between recordings: loop
   * is a decision about the thing being watched right now, and silently carrying it into the next
   * recording would trap someone in a replay they never asked for.
   */
  readonly loopEnabled = signal(false);

  /**
   * Theater mode, owned by the host service.
   *
   * <p>Read through rather than duplicated: the player cannot resize itself — it is drawn over a
   * slot the page reserves — so the single copy of this state has to be the one the page reads.
   *
   * <p>A getter, not a field. Field initialisers run in declaration order, and the injected host
   * service is declared further down with the rest of them — reading it here would be reading
   * `undefined`. The getter defers the read to call time, when everything is constructed.
   */
  get theater() {
    return this.host.theater;
  }

  toggleTheater(): void {
    this.host.theater.set(!this.host.theater());
  }
  /**
   * Second to begin at, overriding any stored resume point.
   *
   * <p>Set from a shared link (`?t=`). It wins over the remembered position because it is an
   * explicit choice by whoever opened the link, and it suppresses the "resumed from" notice — that
   * exists to explain a jump the viewer did not ask for, which this is not.
   */
  readonly startAt = input<number | null>(null);

  readonly SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  readonly timecode = timecode;
  readonly bytes = humanBytes;
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

  // ---- resume ----------------------------------------------------------------

  private readonly progress = inject(PlaybackProgressService);
  private readonly videos = inject(VideoService);
  /** Theater mode and the up-next queue live here — the player is drawn over its slot. */
  private readonly host = inject(PlayerHostService);
  private readonly features = inject(FeatureService);

  /** Set when this video started somewhere other than zero, so the UI can offer "start over". */
  readonly resumedFrom = signal<number | null>(null);
  /** Where the resume landed in the segment index. Arrives after playback has already begun. */
  readonly resumeLocation = signal<SegmentLocation | null>(null);

  // ---- rotation --------------------------------------------------------------
  //
  // Viewer-side only: a CSS transform on the element, costing the server nothing. Footage that
  // carries rotation metadata is already upright by this point — FFmpeg auto-rotates on decode and
  // `probe` swaps the dimensions so the ladder is built on the displayed shape. What this fixes is
  // the case nothing can detect: video shot sideways with no metadata saying so.
  //
  // Rotating permanently would mean re-encoding the whole ladder, since MPEG-TS carries no rotation
  // flag to set — an expensive job on a host that already struggles to transcode once.

  /** Quarter turns clockwise: 0, 90, 180 or 270 degrees. */
  readonly rotation = signal(0);

  /**
   * The transform applied to the video element.
   *
   * <p>A quarter turn swaps which way the element's width and height run, so a 16:9 element rotated
   * inside a 16:9 box overflows badly. Scaling by the shorter/longer side ratio brings it back
   * inside — the same reason a rotated photo has to shrink to fit the page it was upright on.
   */
  readonly videoTransform = computed(() => {
    const degrees = this.rotation();
    if (degrees === 0) return 'none';
    if (degrees === 180) return 'rotate(180deg)';
    return `rotate(${degrees}deg) scale(${this.quarterTurnScale()})`;
  });

  /** Recomputed on rotate, on resize and on entering fullscreen — the box changes shape each time. */
  private readonly quarterTurnScale = signal(1);

  private measureRotationFit(): void {
    const shell = this.shellRef().nativeElement;
    const width = shell.clientWidth;
    const height = shell.clientHeight;
    if (!width || !height) return;
    this.quarterTurnScale.set(Math.min(width / height, height / width));
  }

  /** Cycle a quarter turn clockwise. */
  rotate(): void {
    this.rotation.update((degrees) => (degrees + 90) % 360);
    this.measureRotationFit();
  }

  // ---- captions --------------------------------------------------------------

  /** Parsed caption cues, empty when the recording has no transcript. */
  readonly cues = signal<TranscriptCue[]>([]);
  /** Whether to draw the caption line over the video. Off by default, like every player. */
  readonly captionsOn = signal(false);

  /**
   * The cue covering the playhead.
   *
   * <p>A linear scan, and deliberately not indexed: `currentTime` is written every frame, so this
   * recomputes ~60×/s, but even a three-hour recording is only a few thousand cues and the scan
   * short-circuits. A binary search would be faster in principle and slower to get right.
   */
  readonly activeCue = computed(() => {
    const at = this.currentTime();
    return this.cues().find((c) => at >= c.startSeconds && at < c.endSeconds) ?? null;
  });

  // ---- chapters ---------------------------------------------------------------

  /**
   * The agenda, with each chapter's end filled in.
   *
   * <p>The server sends only start times, because an end is the next chapter's start and storing
   * both invites the two to disagree. The player needs spans though — to size the marker segments on
   * the progress bar and to decide which chapter the playhead is inside — so the ends are derived
   * here, once, rather than at every read. The last chapter runs to the duration; while the metadata
   * is still loading that is 0, so it falls back to the start and simply renders as a zero-width
   * final segment until the duration arrives.
   */
  readonly chapterSpans = computed(() => {
    const chapters = this.card()?.chapters ?? [];
    const total = this.duration();
    return chapters.map((chapter, index) => {
      const next = chapters[index + 1];
      const end = next ? next.startSeconds : Math.max(total, chapter.startSeconds);
      return { ...chapter, endSeconds: end, widthPercent: total > 0 ? ((end - chapter.startSeconds) / total) * 100 : 0, leftPercent: total > 0 ? (chapter.startSeconds / total) * 100 : 0 };
    });
  });

  /** Whether to show the chapter list. Only ever offered when there is an agenda to show. */
  readonly chaptersOpen = signal(false);

  /**
   * The chapter containing the playhead.
   *
   * <p>Found from the end backwards: the first chapter whose start is at or before now is the one we
   * are in, and scanning in reverse means the answer is the first match rather than the last. Cheap
   * enough to recompute on every time update — an agenda is tens of rows, not thousands like cues.
   */
  readonly activeChapter = computed(() => {
    const at = this.currentTime();
    const spans = this.chapterSpans();
    for (let i = spans.length - 1; i >= 0; i--) {
      if (at >= spans[i].startSeconds) return spans[i];
    }
    return null;
  });

  /** The chapter under the scrub cursor, so the seek preview can name where you would land. */
  readonly hoveredChapter = computed(() => {
    const at = this.hoverTime();
    if (at === null) return null;
    const spans = this.chapterSpans();
    for (let i = spans.length - 1; i >= 0; i--) {
      if (at >= spans[i].startSeconds) return spans[i];
    }
    return null;
  });

  /** Jump to a chapter. Closing the list is deliberate: the point of the click was to watch. */
  jumpToChapter(startSeconds: number): void {
    this.seekTo(startSeconds);
    this.chaptersOpen.set(false);
    const element = this.mediaRef().nativeElement;
    if (element.paused) void element.play().catch(() => undefined);
  }

  /** Ticks of the 500 ms stats timer since the last write; see {@link rememberPosition}. */
  private sinceLastSave = 0;

  /**
   * The video currently loaded into the element — <b>not</b> {@code card()}.
   *
   * <p>When the library switches recordings, the effect's cleanup runs after the signal has already
   * changed, so reading {@code card()} during teardown yields the video being switched *to*. Saving
   * the outgoing playhead under that id would stamp one recording's position onto another.
   */
  private activeVideoId: string | null = null;

  private hls: Hls | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private rafHandle = 0;
  private scrubbing = false;
  private wasPlayingBeforeScrub = false;
  private readonly onFullscreenChange = () => {
    this.isFullscreen.set(document.fullscreenElement === this.shellRef().nativeElement);
    this.measureRotationFit();
  };

  /** A rotated video is fitted to the box, so a resize changes how much it must shrink. */
  private readonly onWindowResize = () => {
    if (this.rotation() !== 0) this.measureRotationFit();
  };

  private eventsBound = false;

  /**
   * What actually justifies tearing down and reloading: a different recording, or the same one
   * gaining a stream it did not have (a transcode finishing while it is on screen).
   *
   * <p>The effect below tracks this string rather than the `card` input, and that distinction is
   * load-bearing. `card` is a record the parent replaces to update anything on it — a like count, a
   * comment count — and a new object reference would re-run setup, which destroys the hls instance
   * and restarts playback from zero. Liking a video mid-playback did exactly that. A computed only
   * notifies when its *value* changes, so unrelated fields on the card are now inert.
   */
  private readonly loadKey = computed(() => {
    const card = this.card();
    return `${card.video.id}|${card.streamUrl ?? ''}`;
  });

  constructor() {
    // `card()` is the ONE tracked dependency: when the library switches videos this re-runs, the old
    // hls instance is torn down, per-video state is reset, and the new stream loads into the same
    // element. (viewChild signals resolve after the first render, which is also why setup is here.)
    //
    // The setup itself is `untracked` on purpose. It reads volume/speed to apply them to the new
    // element, and without this the effect would depend on them too — so nudging the volume slider
    // would re-run setup and restart the video from the beginning.
    effect((onCleanup) => {
      this.loadKey();
      untracked(() => {
        const card = this.card();
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
    window.addEventListener('resize', this.onWindowResize);
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
    this.resumedFrom.set(null);
    this.resumeLocation.set(null);
    this.sinceLastSave = 0;
    this.activeVideoId = card.video.id;
    this.cues.set([]);
    this.rotation.set(0);
    this.loadCaptions(card);
  }

  /**
   * Fetch and parse the transcript, if there is one.
   *
   * <p>Silent on failure: captions are an enhancement, and a recording plays perfectly without them.
   * Surfacing an error here would put a warning on a video that is working.
   */
  private loadCaptions(card: VideoCard): void {
    const url = card.transcriptUrl;
    if (!url) return;
    this.videos.transcript(url).subscribe({
      next: (cues) => this.cues.set(cues),
      error: () => this.cues.set([]),
    });
  }

  ngOnDestroy(): void {
    this.teardown();
    document.removeEventListener('fullscreenchange', this.onFullscreenChange);
    window.removeEventListener('resize', this.onWindowResize);
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

    // Resolved BEFORE anything is fetched. That ordering is the whole trick — see startHls.
    const requested = this.startAt();
    const resumeAt = requested !== null && requested > 0
      ? requested
      : this.progress.resumeAt(card.video.id, card.video.durationSeconds);
    if (resumeAt !== null) {
      this.currentTime.set(resumeAt);
      // Only announce a jump the viewer did not choose.
      if (requested === null) this.resumedFrom.set(resumeAt);
      this.locateResumePoint(card, resumeAt);
    }

    if (card.adaptive && Hls.isSupported()) {
      this.startHls(element, source, resumeAt);
    } else {
      // Safari plays HLS natively, and progressive files are a plain src with Range requests.
      // Neither exposes a "start here" hook, so the seek has to happen once metadata exists.
      // Native HLS then discards the first segment it fetched; there is no way around that
      // without controlling the requests, which is exactly what hls.js gives us below.
      element.src = source;
      if (resumeAt !== null) {
        element.addEventListener(
          'loadedmetadata',
          () => { element.currentTime = resumeAt; },
          { once: true },
        );
      }
      if (this.autoplay()) void element.play().catch(() => undefined);
    }
  }

  /**
   * Ask the server which segment the resume landed in, purely to show it.
   *
   * <p>Fire-and-forget on purpose: hls.js resolves the same seek locally from the playlist, so
   * waiting on this round-trip would delay playback to display a label. A failure is silent — the
   * video is already playing, and the absence of a caption is not worth an error.
   */
  private locateResumePoint(card: VideoCard, seconds: number): void {
    if (!card.adaptive) return;
    this.videos.segmentAt(card.video.id, seconds).subscribe({
      next: (location) => this.resumeLocation.set(location),
      error: () => this.resumeLocation.set(null),
    });
  }

  /**
   * @param resumeAt second to begin at, or null for the beginning
   */
  private startHls(element: HTMLVideoElement, source: string, resumeAt: number | null): void {
    const hls = new Hls({
      // Every request hls.js makes — master playlist, rung playlist, segments, decryption key —
      // goes out as POST, with the ticket in the body instead of the URL. The key is agreed by
      // ECDH, so neither side transmits a secret. Anything unrecognised falls through to the stock
      // loader and the GET routes. See createMediaLoader.
      loader: createMediaLoader(),
      // Nothing loads until startLoad() below. This is what makes resuming cost one segment
      // instead of two: left to itself hls.js begins fetching fragment 0 the moment the manifest
      // parses, so setting currentTime afterwards throws that download away and then stalls while
      // the real fragment arrives — which is the "buffering" a resume is supposed to avoid.
      autoStartLoad: false,
      // Bounded look-ahead. This is the setting that keeps playback from turning into a download:
      // never hold more than ~30 s / 60 MB of video, however long the recording is.
      maxBufferLength: 30,
      maxMaxBufferLength: 60,
      backBufferLength: 30,
      maxBufferSize: 60 * 1000 * 1000,
      // Start conservatively and let the ABR controller climb once it has measured throughput —
      // opening on the top rung is what causes the initial stall people read as "buffering".
      startLevel: -1,
      // OFF. When on, hls.js refuses any rendition taller than the <video> element, so a player
      // laid out ~360 px tall served 360p to everyone on every connection — the recording looked
      // permanently softer in the app than the same file played locally, and no amount of work on
      // the ladder could change it, because bandwidth was never what decided. These recordings top
      // out at 480p, so the pixels this used to save were never many; letting ABR choose on
      // throughput alone is the difference between viewers seeing the master and seeing half of it.
      capLevelToPlayerSize: false,
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
      // Where loading actually begins, and the documented place to call it with autoStartLoad off:
      // the master playlist is parsed, so hls.js knows the levels, and the FIRST fragment it asks
      // for is the one covering `resumeAt`. -1 means "from the start".
      hls.startLoad(resumeAt ?? -1);
      if (this.autoplay()) void element.play().catch(() => undefined);
    });

    hls.on(Events.LEVEL_SWITCHED, (_event, data) => this.activeLevel.set(data.level));

    // FRAG_CHANGED fires as the playhead enters each segment — the clearest evidence that
    // playback is segment-by-segment rather than one long download.
    hls.on(Events.FRAG_CHANGED, (_event, data) => this.currentSegment.set(data.frag.sn as number));
    hls.on(Events.FRAG_BUFFERED, () => this.segmentsLoaded.update((n) => n + 1));
    hls.on(Events.ERROR, (_event, data) => this.onHlsError(data));

    // Loads the master playlist only; fragments wait for startLoad() in MANIFEST_PARSED above.
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
      this.rememberPosition(true);   // pausing is the likeliest moment to close the tab
    });
    element.addEventListener('ended', () => {
      this.playing.set(false);
      this.controlsVisible.set(true);
      // Watched to the end: the next visit should start at the beginning, not two seconds before
      // the credits. Also clears the "resumed from" caption.
      this.clearResumePoint();
      this.resumedFrom.set(null);
      this.resumeLocation.set(null);

      // Tell the server it was finished, so it leaves "Continue watching". Forced past the throttle
      // because this is the last report there will be for this recording.
      if (this.activeVideoId && this.features.enabled('VIDEO_WATCH_TRACKING')) {
        const total = element.duration;
        this.videos
            .reportProgress(this.activeVideoId, Number.isFinite(total) ? total : element.currentTime,
                            Number.isFinite(total) ? total : null)
            .subscribe({ error: () => undefined });
      }

      if (this.loopEnabled()) {
        // Loop wins over up-next: it is an explicit instruction to repeat this recording, and the
        // queue would otherwise silently override it.
        this.seekTo(0);
        void element.play().catch(() => undefined);
        return;
      }
      this.finished.emit();
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
      // hls.js reports its own failures through Events.ERROR with far better detail, so only
      // handle the native element error when it is actually driving playback.
      if (!this.hls) this.fatalError.set(this.decodeFailureReason());
    });
  }

  /**
   * Turn the native `MediaError` into something a viewer can act on.
   *
   * <p>"The browser could not decode this file" is true but useless — it gives no hint that the
   * cause is usually a container the browser has no decoder for, served untouched because the
   * server has no FFmpeg to convert it. The distinction that matters is SRC_NOT_SUPPORTED (wrong
   * format — a server-side problem needing a re-process) versus DECODE (a corrupt or truncated
   * file) versus NETWORK (the stream died mid-flight, usually an expired ticket).
   */
  private decodeFailureReason(): string {
    const error = this.mediaRef().nativeElement.error;
    const progressive = !this.card().adaptive;

    switch (error?.code) {
      case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
        return progressive
          ? 'This browser has no decoder for this file, and the server is serving it exactly as '
            + 'uploaded because FFmpeg is not installed. Install FFmpeg and re-process the video, '
            + 'or re-upload it as MP4 (H.264) or WebM.'
          : 'This browser cannot play the stream format.';
      case MediaError.MEDIA_ERR_DECODE:
        return 'The file is readable but its contents could not be decoded — it may be corrupt or '
             + 'have been truncated during upload.';
      case MediaError.MEDIA_ERR_NETWORK:
        return 'The stream stopped mid-download. The playback link may have expired — reload the '
             + 'page to get a fresh one.';
      case MediaError.MEDIA_ERR_ABORTED:
        return 'Playback was cancelled before it could start.';
      default:
        return 'This video could not be played.';
    }
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
      this.rememberPosition(false);
    }, 500);
  }

  /**
   * Persist the playhead so the next visit can resume.
   *
   * <p>Piggy-backs on the existing 500 ms stats timer but only writes every tenth tick — a
   * `localStorage` write is synchronous and JSON-serialises the whole store, which is not something
   * to do twice a second for the sake of five seconds' precision. `force` skips the throttle for
   * the moments that might be the last one we get: a pause, or the component going away.
   */
  private rememberPosition(force: boolean): void {
    if (!force && ++this.sinceLastSave < 10) return;
    this.sinceLastSave = 0;

    const element = this.mediaRef().nativeElement;
    const seconds = element.currentTime;
    const total = element.duration;
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    if (element.ended) return;   // 'ended' clears the point; do not immediately re-save it
    if (!this.activeVideoId) return;
    this.progress.save(this.activeVideoId, seconds, Number.isFinite(total) ? total : 0);
    this.reportProgressToServer(this.activeVideoId, seconds, total);
  }

  /**
   * Mirror the playhead to the server, far less often than to `localStorage`.
   *
   * <p>Both are needed and neither replaces the other: local storage is instant and survives an
   * offline tab, the server is what lets a shareholder start on a laptop and finish on a phone, and
   * what makes the view count and the "Continue watching" row possible at all.
   *
   * <p>Every sixth write — so roughly every thirty seconds of playback rather than every five. This
   * is a network round-trip per recording per viewer, and resume accuracy to the nearest half-minute
   * is indistinguishable from perfect to the person watching.
   *
   * <p>Errors are swallowed on purpose. A dropped report costs a little resume precision; surfacing
   * it would interrupt playback to report something the viewer cannot act on.
   */
  private serverReportsSkipped = 0;
  private reportProgressToServer(videoId: string, seconds: number, total: number): void {
    // Checked client-side as well as server-side. With the flag off the endpoint returns 403, and
    // this fires on a timer — so without this the console and network panel would fill with a
    // rejected request every thirty seconds for the whole length of every recording.
    if (!this.features.enabled('VIDEO_WATCH_TRACKING')) return;
    if (++this.serverReportsSkipped < 6) return;
    this.serverReportsSkipped = 0;
    this.videos
        .reportProgress(videoId, seconds, Number.isFinite(total) ? total : null)
        .subscribe({ error: () => undefined });
  }

  /** Discard the resume point and jump back to the beginning. */
  startOver(): void {
    this.clearResumePoint();
    this.resumedFrom.set(null);
    this.resumeLocation.set(null);
    this.seekTo(0);
  }

  private clearResumePoint(): void {
    if (this.activeVideoId) this.progress.clear(this.activeVideoId);
  }

  /** Dismiss the "resumed from…" caption without moving the playhead. */
  dismissResumeNotice(): void {
    this.resumedFrom.set(null);
    this.resumeLocation.set(null);
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
    // Last chance to record where they got to: this runs when the card switches and on destroy.
    // Guarded because teardown can also run before the view exists.
    try {
      this.rememberPosition(true);
    } catch {
      // No element yet, or storage refused. Neither should block teardown.
    }
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
      // 't' for theater, the same key YouTube uses.
      case 't':
      case 'T':
        this.toggleTheater();
        break;
      case 'r':
      case 'R':
        this.rotate();
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
