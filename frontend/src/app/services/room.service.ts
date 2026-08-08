import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { SILENT } from './loading.service';

/**
 * One topic, as the room or the chair sees it.
 *
 * `asked` and `supported` are kept apart on purpose: one counts people who wrote the question, the
 * other people who tapped a button. Averaging them into a single score would mean neither.
 */
export interface TopicView {
  clusterId: string;
  question: string;
  asked: number;
  supported: number;
  supportedByMe: boolean;
  /**
   * Null on the attendee board until a moderator publishes it.
   *
   * Nearly every answer starts as a model draft nobody has read; showing those to the room would
   * attribute to the company something it never said.
   */
  answer: string | null;
  answered: boolean;
  /**
   * Whether the room may see the answer.
   *
   * Explicit rather than inferred from `answer` being present: the moderator's view always returns
   * the answer, so "has an answer" and "the room can see it" are different questions.
   */
  published: boolean;
  runOrder: number | null;
  underDiscussion: boolean;
  startedAt: string | null;
  /** How long the topic took, once finished. Null while running or not yet started. */
  secondsSpent: number | null;
}

/**
 * The room: the ranked topics, support for them, and the chair's running order.
 *
 * <p>Anonymous attendees can reach the board and support a topic — an upvote ranks a discussion and
 * decides nothing. Voting on a resolution refuses that same identity; see `VotingService`.
 */
@Injectable({ providedIn: 'root' })
export class RoomService {
  private readonly base = `${environment.apiBase}/api/room`;
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);

  private headers(): Record<string, string> {
    const token = this.auth.token();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** The ranked topics for attendees. Published answers only. */
  attendeeBoard(limit = 20): Observable<TopicView[]> {
    return this.http.post<TopicView[]>(
      `${this.base}/attendee-board`,
      { limit },
      // SILENT: polled on a timer, so counting it would hold the global loading bar up
      // permanently. A user action on this page still raises the bar normally.
      { headers: this.headers(), context: new HttpContext().set(SILENT, true) },
    );
  }

  /** Add or withdraw support. Toggles — tapping again takes it back. */
  supportTopic(clusterId: string): Observable<{ clusterId: string; supported: number }> {
    return this.http.post<{ clusterId: string; supported: number }>(
      `${this.base}/support-topic`,
      { clusterId },
      { headers: this.headers() },
    );
  }

  // ---- the chair's controls (moderator; the server enforces it) --------------

  /** Every topic with position, timings and unpublished answers. */
  runOfShow(): Observable<TopicView[]> {
    return this.http.post<TopicView[]>(`${this.base}/run-of-show`, {}, {
      headers: this.headers(),
      context: new HttpContext().set(SILENT, true),   // polled alongside the board
    });
  }

  /** Set the whole order at once. Anything left out has its position cleared. */
  setRunOrder(clusterIds: string[]): Observable<TopicView[]> {
    return this.http.post<TopicView[]>(
      `${this.base}/set-run-order`,
      { clusterIds },
      { headers: this.headers() },
    );
  }

  /** Begin a topic. Whatever was running is closed off automatically. */
  startTopic(clusterId: string): Observable<TopicView[]> {
    return this.http.post<TopicView[]>(
      `${this.base}/start-topic`,
      { clusterId },
      { headers: this.headers() },
    );
  }

  endTopic(clusterId: string): Observable<TopicView[]> {
    return this.http.post<TopicView[]>(
      `${this.base}/end-topic`,
      { clusterId },
      { headers: this.headers() },
    );
  }

  /** Release an answer to the room, or take it back down. */
  publishAnswer(
    clusterId: string,
    published: boolean,
  ): Observable<{ clusterId: string; published: boolean }> {
    return this.http.post<{ clusterId: string; published: boolean }>(
      `${this.base}/publish-answer`,
      { clusterId, published },
      { headers: this.headers() },
    );
  }
}
