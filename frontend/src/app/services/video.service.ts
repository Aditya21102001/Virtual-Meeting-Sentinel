import { HttpClient, HttpContext, HttpEvent, HttpEventType } from "@angular/common/http";
import { Injectable, computed, inject, signal } from "@angular/core";
import { Observable, Subscription, map, timeout } from "rxjs";
import { environment } from "../../environments/environment";
import { SILENT } from "./loading.service";
import { AuthService } from "./auth.service";

export type VideoStatus = "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
export type DeliveryMode = "HLS" | "PROGRESSIVE";
/** Where the media bytes live: the NAS share, or rows in `video_assets`. */
export type StorageMode = "FILESYSTEM" | "DATABASE";

/** One rung of the adaptive ladder, as the quality menu sees it. */
export interface RenditionView {
  name: string;
  width: number;
  height: number;
  videoBitrateKbps: number;
  audioBitrateKbps: number;
  segmentCount: number;
  totalBytes: number;
  playlistPath: string;
}

/** Filmstrip geometry: one tile every `intervalSeconds`, laid out `columns` wide. */
export interface SpriteView {
  intervalSeconds: number;
  columns: number;
  tileWidth: number;
  tileHeight: number;
}

export interface SegmentView {
  seq: number;
  filename: string;
  durationSeconds: number;
  startSeconds: number;
  byteSize: number;
  url: string;
}

/**
 * The database's answer to "which slice covers second N", with enough context to read it as a
 * position. The player never waits for this — it resolves the same seek from the playlist it
 * already holds — so this is what the seek *landed on*, reported after the fact.
 */
export interface SegmentLocation {
  segment: SegmentView;
  rendition: string;
  /** Segments in this rung, so the answer reads "215 of 271". */
  segmentCount: number;
  /** Bytes before this segment in this rung. */
  byteOffset: number;
  renditionBytes: number;
}

/**
 * One way to download a recording.
 *
 * Every rung of the ladder is a complete copy at that quality, so discarding the original narrows
 * the choice of formats rather than removing the ability to download.
 */
export interface DownloadOption {
  /** ORIGINAL = the uploaded file; RENDITION = a rung, rebuilt from its stored segments. */
  kind: "ORIGINAL" | "RENDITION";
  /** Rung name for a RENDITION (`480p`); null for the original. */
  rendition: string | null;
  label: string;
  height: number;
  sizeBytes: number;
  filename: string;
  contentType: string;
  url: string;
}

export interface DownloadOptions {
  /** Highest quality first. */
  options: DownloadOption[];
  /** Explains the container when rungs are on offer. */
  note: string | null;
}

export interface VideoView {
  id: string;
  title: string;
  description: string | null;
  originalFilename: string;
  status: VideoStatus;
  deliveryMode: DeliveryMode;
  storageMode: StorageMode;
  progressPercent: number;
  errorMessage: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  hasAudio: boolean;
  sizeBytes: number;
  segmentSeconds: number | null;
  totalSegments: number;
  hasPoster: boolean;
  /** Whether WebVTT captions have been uploaded. */
  hasTranscript: boolean;
  sprite: SpriteView | null;
  renditions: RenditionView[];
  uploadedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Likes and comments, resolved for the signed-in viewer. */
export interface VideoEngagement {
  likes: number;
  /** Drives whether the like button renders as pressed. */
  likedByMe: boolean;
  comments: number;
  /**
   * Distinct members who have watched this — one per person, not per press of play.
   * For a board recording the honest question is how many shareholders saw it, once each.
   */
  viewers: number;
  /**
   * Where this member stopped, 0 if they have not watched it.
   * Only resolved on the single-recording call; the library list sends 0 to stay one query.
   */
  resumeAtSeconds: number;
}

export interface CommentView {
  id: string;
  author: string;
  body: string;
  /** Playhead position the comment refers to, or null for the recording as a whole. */
  atSeconds: number | null;
  createdAt: string;
  editedAt: string | null;
  mine: boolean;
  /** Own comment, or the viewer moderates. Decided server-side; this only shows the button. */
  canDelete: boolean;
}

/**
 * A catalogue entry plus its ticketed media URLs. The ticket is already baked into every URL,
 * which is what lets these go straight into `<img src>` / `<video src>` / hls.js — the browser's
 * media stack cannot attach an Authorization header.
 */
export interface VideoCard {
  video: VideoView;
  ticket: string | null;
  ticketExpiresInSeconds: number;
  /** HLS master playlist when `adaptive`, otherwise the Range-served original. */
  streamUrl: string | null;
  posterUrl: string | null;
  spriteUrl: string | null;
  /** WebVTT captions, when a transcript has been uploaded. */
  transcriptUrl: string | null;
  adaptive: boolean;
  /** Null on a card for a video that isn't READY yet. */
  engagement: VideoEngagement | null;
  /** Agenda items in playing order. Empty when nobody has marked any up. */
  chapters: VideoChapter[];
}

/**
 * One named point in a recording — "Item 4 — Auditor's Report" at 31:05.
 *
 * No end time: a chapter runs until the next one starts, and the last to the end of the recording.
 * The player derives the boundaries, so there is only ever one number per chapter to be wrong.
 */
export interface VideoChapter {
  id: string;
  startSeconds: number;
  title: string;
  ordinal: number;
}

/** A chapter as submitted for saving. Ordinals are assigned by the server from the start times. */
export interface VideoChapterInput {
  startSeconds: number;
  title: string;
}

export interface VideoStorageStatus {
  /** Which backend new uploads will use. */
  storageMode: StorageMode;
  /** Where bytes are written in filesystem mode — the NAS, or the local fallback. */
  storagePath: string;
  configuredNasPath: string;
  nasAvailable: boolean;
  storageProblem: string | null;
  usableSpaceBytes: number;
  /** Bytes held in `video_assets` across all videos (database mode). */
  databaseStoredBytes: number;
  /** Total budget for database storage; uploads are refused beyond it. */
  databaseMaxTotalBytes: number;
  /** false => ffmpeg is missing, so uploads play progressively instead of as a ladder. */
  segmentationAvailable: boolean;
  ffmpegVersion: string | null;
  segmentSeconds: number;
  ladder: number[];
  maxUploadBytes: number;
  videoCount: number;
  readyCount: number;
}

/** Upload progress, or the finished card once the server responds. */
export type UploadProgress =
  | { kind: "progress"; sentBytes: number; totalBytes: number; percent: number }
  | { kind: "done"; card: VideoCard };

@Injectable({ providedIn: "root" })
export class VideoService {
  private readonly base = `${environment.apiBase}/api/videos`;
  private readonly admin = `${environment.apiBase}/api/admin/videos`;
  private readonly auth = inject(AuthService);

  // ---- in-flight upload, owned by the service rather than by a component --------------------
  //
  // An upload has to outlive the page that started it. When this state lived in the component,
  // its ngOnDestroy unsubscribed on navigation — and unsubscribing an HttpClient request ABORTS
  // the underlying XHR, so simply clicking another tab silently cancelled a part-finished upload.
  // This service is `providedIn: 'root'`, so the subscription survives navigation and the user is
  // free to move around while a large recording finishes uploading.

  /** The upload currently in flight, or null. */
  readonly uploadingName = signal<string | null>(null);
  readonly uploadPercent = signal(0);
  readonly uploadSentBytes = signal(0);
  readonly uploadTotalBytes = signal(0);
  /** Set once on completion/failure so a returning page can show the outcome it missed. */
  readonly uploadMessage = signal("");
  readonly uploadError = signal("");
  readonly uploading = computed(() => this.uploadingName() !== null);

  private uploadSub: Subscription | null = null;
  /** Bumped whenever an upload finishes, so open pages know to refresh their list. */
  readonly libraryChanged = signal(0);

  constructor(private http: HttpClient) {}

  /**
   * Begin an upload and track it centrally. Returns immediately; watch the signals above.
   * Refuses to start a second upload while one is running — two concurrent multi-hundred-MB
   * uploads would compete for the same bandwidth and both crawl.
   */
  startUpload(file: File, title: string, description: string): void {
    if (this.uploading()) return;
    this.uploadingName.set(file.name);
    this.uploadPercent.set(0);
    this.uploadSentBytes.set(0);
    this.uploadTotalBytes.set(file.size);
    this.uploadMessage.set("");
    this.uploadError.set("");

    this.uploadSub = this.upload(file, title, description).subscribe({
      next: (event) => {
        if (event.kind === "progress") {
          this.uploadPercent.set(event.percent);
          this.uploadSentBytes.set(event.sentBytes);
          this.uploadTotalBytes.set(event.totalBytes);
        } else {
          this.uploadingName.set(null);
          this.uploadMessage.set(
            `✓ "${event.card.video.title}" uploaded. Segmenting now — you can leave this page.`,
          );
          this.libraryChanged.update((n) => n + 1);
        }
      },
      error: (err) => {
        this.uploadingName.set(null);
        this.uploadError.set(
          "✗ " +
            (err?.error?.message ??
              err?.error?.error ??
              "Upload failed. Is the server running?"),
        );
      },
    });
  }

  /** Explicit user-initiated cancel — the only thing that should abort an upload. */
  cancelUpload(): void {
    this.uploadSub?.unsubscribe();
    this.uploadSub = null;
    this.uploadingName.set(null);
    this.uploadError.set("Upload cancelled.");
  }

  /**
   * JSON calls carry the session bearer token, matching ApiService (there is no token-attaching
   * interceptor in this app). Media URLs deliberately do NOT — they are fetched by the browser's
   * media stack, which cannot set headers, so they authorise with the ticket in the URL instead.
   */
  private headers(): Record<string, string> {
    const token = this.auth.token();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // ---- viewer ---------------------------------------------------------------
  //
  // Every call below is a POST to a named route with the id in the body. The browser's network
  // panel labels a request with the last path segment, so the previous REST URLs
  // (`/api/videos/{uuid}`) produced a list of indistinguishable UUIDs; `list-library` and
  // `reprocess-video` say what the page is actually doing. The media URLs on a VideoCard are the
  // exception and stay GET — the browser's media stack issues those, and it only ever GETs.

  /** Every READY video, each with a fresh playback ticket. */
  library(): Observable<VideoCard[]> {
    return this.http
      .post<VideoCard[]>(`${this.base}/list-library`, {}, { headers: this.headers() })
      .pipe(map((cards) => cards.map((card) => this.normalizeMediaUrls(card))));
  }

  card(id: string): Observable<VideoCard> {
    return this.http
      .post<VideoCard>(`${this.base}/video-details`, { id }, { headers: this.headers() })
      .pipe(map((card) => this.normalizeMediaUrls(card)));
  }

  /** The segment index for one rung — what the "N segments" inspector shows. */
  segments(id: string, rendition?: string): Observable<SegmentView[]> {
    return this.http.post<SegmentView[]>(
      `${this.base}/list-segments`,
      { id, rendition: rendition ?? null },
      { headers: this.headers() },
    );
  }

  /**
   * Which segment covers a given second — the server-side seek lookup.
   *
   * <p>Informational, never blocking: playback resolves its own seeks from the playlist. This is
   * called alongside a resume so the UI can show where it landed in the index.
   */
  segmentAt(
    id: string,
    seconds: number,
    rendition?: string,
  ): Observable<SegmentLocation> {
    return this.http.post<SegmentLocation>(
      `${this.base}/find-segment-at`,
      { id, seconds, rendition: rendition ?? null },
      { headers: this.headers() },
    );
  }

  // ---- likes and comments ---------------------------------------------------

  /** Like, or un-like if already liked. Returns the server's resulting counts. */
  toggleLike(id: string): Observable<VideoEngagement> {
    return this.http.post<VideoEngagement>(
      `${this.base}/toggle-like`,
      { id },
      { headers: this.headers() },
    );
  }

  comments(id: string): Observable<CommentView[]> {
    return this.http.post<CommentView[]>(
      `${this.base}/list-comments`,
      { id },
      { headers: this.headers() },
    );
  }

  /** @param atSeconds playhead position to pin the comment to, or null for the whole recording */
  addComment(
    id: string,
    body: string,
    atSeconds: number | null,
  ): Observable<CommentView> {
    return this.http.post<CommentView>(
      `${this.base}/add-comment`,
      { id, body, atSeconds },
      { headers: this.headers() },
    );
  }

  deleteComment(commentId: string): Observable<{ commentId: string; deleted: boolean }> {
    return this.http.post<{ commentId: string; deleted: boolean }>(
      `${this.base}/delete-comment`,
      { commentId },
      { headers: this.headers() },
    );
  }

  // ---- transcript (admin) ---------------------------------------------------

  /**
   * Attach captions from a `.vtt` or `.srt` file. Multipart, and the server normalises SRT to
   * WebVTT — `<track>` accepts nothing else.
   */
  uploadTranscript(id: string, file: File): Observable<VideoCard> {
    const form = new FormData();
    form.append('id', id);
    form.append('file', file, file.name);
    return this.http
      .post<VideoCard>(`${this.admin}/upload-transcript`, form, {
        headers: this.headers(),
        context: new HttpContext().set(SILENT, true),   // slow: re-embeds the transcript
      })
      .pipe(map((card) => this.normalizeMediaUrls(card)));
  }

  /**
   * Add this recording's captions to the RAG knowledge base, so a drafted answer can cite what was
   * said on the call. Attempted automatically on upload; this is the retry, and the way to backfill
   * recordings whose captions predate the feature.
   */
  indexTranscript(id: string): Observable<{ passages_indexed: number }> {
    return this.http.post<{ passages_indexed: number }>(
      `${this.admin}/index-transcript`,
      { id },
      { headers: this.headers() },
    );
  }

  deleteTranscript(id: string): Observable<VideoCard> {
    return this.http
      .post<VideoCard>(`${this.admin}/delete-transcript`, { id }, { headers: this.headers() })
      .pipe(map((card) => this.normalizeMediaUrls(card)));
  }

  /**
   * Replace a recording's whole agenda.
   *
   * The entire list every time, not one row at a time: editing an agenda means renaming, moving and
   * deleting entries together, and a per-row API would let the markers on the progress bar disagree
   * with the chapter list beside them. Ordering and numbering are the server's job, so rows can be
   * sent in whatever order they were typed.
   */
  saveChapters(id: string, chapters: VideoChapterInput[]): Observable<VideoCard> {
    return this.http
      .post<VideoCard>(
        `${this.admin}/save-chapters`,
        { id, chapters },
        { headers: this.headers() },
      )
      .pipe(map((card) => this.normalizeMediaUrls(card)));
  }

  /** Read the agenda back — for the editor, and to confirm a save actually landed. */
  listChapters(id: string): Observable<VideoChapter[]> {
    return this.http.post<VideoChapter[]>(
      `${this.admin}/list-chapters`,
      { id },
      { headers: this.headers() },
    );
  }

  /**
   * Tell the server how far this member has watched.
   *
   * SILENT: fired on a timer during playback, so counting it would pin the global loading bar up for
   * the whole recording. It also returns 204 — there is nothing for the caller to wait on, which is
   * why nothing here surfaces an error: a lost progress report costs a few seconds of resume
   * accuracy, and interrupting someone's viewing to tell them so would cost more.
   */
  reportProgress(id: string, positionSeconds: number, durationSeconds: number | null): Observable<void> {
    return this.http.post<void>(
      `${this.base}/report-progress`,
      { id, positionSeconds, durationSeconds },
      { headers: this.headers(), context: new HttpContext().set(SILENT, true) },
    );
  }

  /** This member's unfinished recordings, most recently watched first. */
  continueWatching(): Observable<VideoCard[]> {
    return this.http
      .post<VideoCard[]>(`${this.base}/continue-watching`, {}, { headers: this.headers() })
      .pipe(map((cards) => cards.map((card) => this.normalizeMediaUrls(card))));
  }

  /**
   * Fetch and parse the captions for a recording.
   *
   * <p>A GET, because the ticket is already in the URL — this is the same media route a `<track>`
   * would have used, we just read it ourselves. Text rather than JSON, hence `responseType`.
   */
  transcript(transcriptUrl: string): Observable<TranscriptCue[]> {
    return this.http
      .get(transcriptUrl, { responseType: "text" })
      .pipe(map((vtt) => parseWebVtt(vtt)));
  }

  /**
   * Everything this recording can be downloaded as, each with a ticketed GET URL ready to use.
   *
   * <p>One call rather than one per option: only the server knows whether the original survived and
   * how large each rung is. The transfers themselves are browser navigations, so they stream to disk
   * and can be resumed rather than living in the tab's memory.
   */
  downloadOptions(id: string): Observable<DownloadOptions> {
    return this.http
      .post<DownloadOptions>(
        `${this.base}/download-options`,
        { id },
        { headers: this.headers() },
      )
      .pipe(
        map((plan) => ({
          ...plan,
          options: plan.options.map((o) => ({ ...o, url: this.absolute(o.url) })),
        })),
      );
  }

  // ---- admin ----------------------------------------------------------------

  status(): Observable<VideoStorageStatus> {
    return this.http.post<VideoStorageStatus>(
      `${this.admin}/storage-status`,
      {},
      { headers: this.headers() },
    );
  }

  /**
   * All videos including PROCESSING/FAILED, so the manage table can show them.
   *
   * @param silent true for the background poll that watches a transcode. The same call serves a
   *   user pressing refresh, which SHOULD show the loading bar — so the caller decides rather than
   *   the method, because only the caller knows whether a human is waiting on it.
   */
  listAll(silent = false): Observable<VideoCard[]> {
    return this.http
      .post<VideoCard[]>(`${this.admin}/list-all-videos`, {}, {
        headers: this.headers(),
        context: new HttpContext().set(SILENT, silent),
      })
      .pipe(map((cards) => cards.map((card) => this.normalizeMediaUrls(card))));
  }

  adminCard(id: string): Observable<VideoCard> {
    return this.http
      .post<VideoCard>(`${this.admin}/video-details`, { id }, { headers: this.headers() })
      .pipe(map((card) => this.normalizeMediaUrls(card)));
  }

  /**
   * Upload with a real progress stream. `reportProgress` + `observe: 'events'` is what turns the
   * XHR upload ticks into a usable percentage — a plain post() would give no feedback at all,
   * which is unusable for a multi-hundred-megabyte file.
   */
  upload(
    file: File,
    title: string,
    description: string,
  ): Observable<UploadProgress> {
    const form = new FormData();
    form.append("file", file, file.name);
    if (title.trim()) form.append("title", title.trim());
    if (description.trim()) form.append("description", description.trim());

    return this.http
      .post<VideoCard>(`${this.admin}/upload-video`, form, {
        // SILENT: a video upload has its own progress bar and can run for a long time. See
        // ApiService.uploadAnnualReport for why long work must never raise the global blocker.
        headers: this.headers(),
        reportProgress: true,
        observe: "events",
        context: new HttpContext().set(SILENT, true),
      })
      .pipe(map((event) => this.toProgress(event, file.size)));
  }

  updateMetadata(
    id: string,
    title: string,
    description: string,
  ): Observable<VideoCard> {
    return this.http.post<VideoCard>(
      `${this.admin}/update-video-details`,
      { id, title, description },
      {
        headers: this.headers(),
      },
    );
  }

  reprocess(id: string): Observable<VideoCard> {
    return this.http.post<VideoCard>(
      `${this.admin}/reprocess-video`,
      { id },
      {
        headers: this.headers(),
        // Kicks off a transcode that runs for minutes on the server. The card shows PROCESSING
        // and the list polls it — blocking the app behind it would be wrong on both counts.
        context: new HttpContext().set(SILENT, true),
      },
    );
  }

  remove(id: string): Observable<{ id: string; deleted: boolean }> {
    return this.http.post<{ id: string; deleted: boolean }>(
      `${this.admin}/delete-video`,
      { id },
      {
        headers: this.headers(),
        // SILENT, like reprocess() above. Deleting a recording removes its renditions, segments,
        // thumbnails and embeddings, so it is not instant — and the global overlay is modal, which
        // meant one admin deleting one card froze the whole application for everyone looking at it.
        // The card disables its own buttons and shows "Deleting…" while this runs, so the feedback
        // is local to the thing being deleted, which is where it belongs.
        context: new HttpContext().set(SILENT, true),
      },
    )
      // SILENT skips the interceptor, and its timeout with it. Without a ceiling here, a request
      // that never settles — what a sleeping instance behind a proxy actually produces — leaves the
      // card disabled on "Deleting…" until the page is reloaded. Erroring out restores the buttons
      // and shows why. Same two minutes the interceptor would have applied.
      .pipe(timeout(120000));
  }

  /** Backend media URLs are root-relative; resolve them against the Render API, not Vercel. */
  private normalizeMediaUrls(card: VideoCard): VideoCard {
    return {
      ...card,
      streamUrl: this.absolute(card.streamUrl),
      posterUrl: this.absolute(card.posterUrl),
      spriteUrl: this.absolute(card.spriteUrl),
      transcriptUrl: this.absolute(card.transcriptUrl),
    };
  }

  private absolute<T extends string | null>(url: T): T {
    if (!url || /^https?:\/\//i.test(url)) return url;
    return `${environment.apiBase}${url}` as T;
  }

  // ---- helpers --------------------------------------------------------------

  private toProgress(
    event: HttpEvent<VideoCard>,
    fallbackTotal: number,
  ): UploadProgress {
    if (event.type === HttpEventType.UploadProgress) {
      const total = event.total ?? fallbackTotal;
      return {
        kind: "progress",
        sentBytes: event.loaded,
        totalBytes: total,
        percent: total ? Math.round((event.loaded / total) * 100) : 0,
      };
    }
    if (event.type === HttpEventType.Response && event.body) {
      return { kind: "done", card: event.body };
    }
    // Sent / ResponseHeader / user events: nothing meaningful to show yet.
    return {
      kind: "progress",
      sentBytes: 0,
      totalBytes: fallbackTotal,
      percent: 0,
    };
  }
}

/** One caption line: when it starts, when it ends, and what is said. */
export interface TranscriptCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

/**
 * Parse WebVTT into cues.
 *
 * Done in JavaScript rather than handed to a `<track>` element, deliberately. A `<track>` is fetched
 * by the browser, which for a cross-origin URL — and the API is a different origin from this SPA —
 * requires putting `crossorigin="anonymous"` on the `<video>`. That attribute also changes how the
 * media itself and the poster are fetched, so a secondary feature would be able to break playback.
 * Parsing here costs one small request we need anyway for the searchable panel, and keeps captions
 * from being able to affect the video element at all.
 */
export function parseWebVtt(vtt: string): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  // Normalise line endings and drop a BOM, either of which stops the split matching.
  const lines = vtt.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const arrow = lines[i].indexOf("-->");
    if (arrow < 0) continue;

    const start = vttTime(lines[i].slice(0, arrow));
    // Cue settings (align, position…) can follow the end time on the same line; stop at whitespace.
    const end = vttTime(lines[i].slice(arrow + 3).trim().split(/\s+/)[0]);
    if (start === null || end === null) continue;

    // Text runs to the next blank line; a cue may span several.
    const text: string[] = [];
    while (++i < lines.length && lines[i].trim() !== "") {
      text.push(lines[i].trim());
    }
    const joined = text
      .join(" ")
      // Strip the inline tags VTT allows (<v Speaker>, <i>, <c.classname>) — the panel shows plain text.
      .replace(/<[^>]*>/g, "")
      .trim();
    if (joined) cues.push({ startSeconds: start, endSeconds: end, text: joined });
  }
  return cues;
}

/** `00:01:02.500` or `01:02.500` (the hour is optional in VTT) into seconds. */
function vttTime(raw: string): number | null {
  const parts = raw.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const seconds = parts.map((p) => Number(p.replace(",", ".")));
  if (seconds.some((n) => !Number.isFinite(n))) return null;
  return parts.length === 3
    ? seconds[0] * 3600 + seconds[1] * 60 + seconds[2]
    : seconds[0] * 60 + seconds[1];
}

/** "1.4 GB" — used in upload limits, segment sizes and the storage banner. */
export function humanBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** "1:23:45" / "4:07" — omit the hour component when the video is under an hour. */
export function timecode(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0)
    return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
