import { HttpClient, HttpEvent, HttpEventType } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

export type VideoStatus = 'UPLOADED' | 'PROCESSING' | 'READY' | 'FAILED';
export type DeliveryMode = 'HLS' | 'PROGRESSIVE';
/** Where the media bytes live: the NAS share, or rows in `video_assets`. */
export type StorageMode = 'FILESYSTEM' | 'DATABASE';

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
  sprite: SpriteView | null;
  renditions: RenditionView[];
  uploadedBy: string | null;
  createdAt: string;
  updatedAt: string;
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
  adaptive: boolean;
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
  | { kind: 'progress'; sentBytes: number; totalBytes: number; percent: number }
  | { kind: 'done'; card: VideoCard };

@Injectable({ providedIn: 'root' })
export class VideoService {
  private readonly base = `${environment.apiBase}/api/videos`;
  private readonly admin = `${environment.apiBase}/api/admin/videos`;
  private readonly auth = inject(AuthService);

  constructor(private http: HttpClient) {}

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

  /** Every READY video, each with a fresh playback ticket. */
  library(): Observable<VideoCard[]> {
    return this.http.get<VideoCard[]>(this.base, { headers: this.headers() });
  }

  card(id: string): Observable<VideoCard> {
    return this.http.get<VideoCard>(`${this.base}/${id}`, { headers: this.headers() });
  }

  /** The segment index for one rung — what the "N segments" inspector shows. */
  segments(id: string, rendition?: string): Observable<SegmentView[]> {
    const query = rendition ? `?rendition=${encodeURIComponent(rendition)}` : '';
    return this.http.get<SegmentView[]>(`${this.base}/${id}/segments${query}`, {
      headers: this.headers(),
    });
  }

  /** Which segment covers a given second (server-side seek lookup). */
  segmentAt(id: string, seconds: number, rendition?: string): Observable<SegmentView> {
    const params = new URLSearchParams({ seconds: String(seconds) });
    if (rendition) params.set('rendition', rendition);
    return this.http.get<SegmentView>(`${this.base}/${id}/segment-at?${params}`, {
      headers: this.headers(),
    });
  }

  // ---- admin ----------------------------------------------------------------

  status(): Observable<VideoStorageStatus> {
    return this.http.get<VideoStorageStatus>(`${this.admin}/status`, { headers: this.headers() });
  }

  /** All videos including PROCESSING/FAILED, so the manage table can show them. */
  listAll(): Observable<VideoCard[]> {
    return this.http.get<VideoCard[]>(this.admin, { headers: this.headers() });
  }

  adminCard(id: string): Observable<VideoCard> {
    return this.http.get<VideoCard>(`${this.admin}/${id}`, { headers: this.headers() });
  }

  /**
   * Upload with a real progress stream. `reportProgress` + `observe: 'events'` is what turns the
   * XHR upload ticks into a usable percentage — a plain post() would give no feedback at all,
   * which is unusable for a multi-hundred-megabyte file.
   */
  upload(file: File, title: string, description: string): Observable<UploadProgress> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (title.trim()) form.append('title', title.trim());
    if (description.trim()) form.append('description', description.trim());

    return this.http
      .post<VideoCard>(this.admin, form, {
        headers: this.headers(),
        reportProgress: true,
        observe: 'events',
      })
      .pipe(map((event) => this.toProgress(event, file.size)));
  }

  updateMetadata(id: string, title: string, description: string): Observable<VideoCard> {
    return this.http.patch<VideoCard>(`${this.admin}/${id}`, { title, description }, {
      headers: this.headers(),
    });
  }

  reprocess(id: string): Observable<VideoCard> {
    return this.http.post<VideoCard>(`${this.admin}/${id}/reprocess`, {}, {
      headers: this.headers(),
    });
  }

  remove(id: string): Observable<void> {
    return this.http.delete<void>(`${this.admin}/${id}`, { headers: this.headers() });
  }

  // ---- helpers --------------------------------------------------------------

  private toProgress(event: HttpEvent<VideoCard>, fallbackTotal: number): UploadProgress {
    if (event.type === HttpEventType.UploadProgress) {
      const total = event.total ?? fallbackTotal;
      return {
        kind: 'progress',
        sentBytes: event.loaded,
        totalBytes: total,
        percent: total ? Math.round((event.loaded / total) * 100) : 0,
      };
    }
    if (event.type === HttpEventType.Response && event.body) {
      return { kind: 'done', card: event.body };
    }
    // Sent / ResponseHeader / user events: nothing meaningful to show yet.
    return { kind: 'progress', sentBytes: 0, totalBytes: fallbackTotal, percent: 0 };
  }
}

/** "1.4 GB" — used in upload limits, segment sizes and the storage banner. */
export function humanBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
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
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
