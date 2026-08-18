import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { SILENT } from './loading.service';

/**
 * How a member voted.
 *
 * ABSTAIN is a real position, not an absence: it means "I am here and taking part, but I am not
 * taking a side". It counts towards quorum and is excluded from the majority.
 */
export type VoteChoice = 'FOR' | 'AGAINST' | 'ABSTAIN';

/**
 * The majority a motion needs.
 *
 * ORDINARY passes on a simple majority — more for than against. SPECIAL needs at least 75% and is
 * used for weightier decisions such as changing the company's constitution.
 */
export type ResolutionType = 'ORDINARY' | 'SPECIAL';

/** DRAFT → OPEN → CLOSED. Votes are accepted only while OPEN. */
export type ResolutionStatus = 'DRAFT' | 'OPEN' | 'CLOSED';

/**
 * A tally.
 *
 * Counts and weights are both reported because they answer different questions. "Eleven members
 * voted for" and "62% of the shares voted for" are two separate facts, and with weighted voting
 * they are rarely the same number.
 */
export interface TallyView {
  forCount: number;
  againstCount: number;
  abstainCount: number;
  forWeight: number;
  againstWeight: number;
  abstainWeight: number;
  /** for + against. Abstentions are excluded from the majority. */
  decisiveWeight: number;
  forPercent: number;
  carried: boolean;
}

export interface ResolutionView {
  id: string;
  meetingId: string;
  seq: number;
  title: string;
  text: string | null;
  type: ResolutionType;
  status: ResolutionStatus;
  open: boolean;
  /** The threshold this motion needs, for display beside the result. */
  requiredMajorityPercent: number;
  liveResultsVisible: boolean;
  openedAt: string | null;
  closedAt: string | null;
  /** How the signed-in user voted, or null if they have not. */
  myChoice: VoteChoice | null;
  /**
   * Null when the caller may not see the tally yet.
   *
   * Null rather than a zeroed tally on purpose: all-zero is indistinguishable from "nobody voted",
   * so the UI must say "results are not published yet" instead of implying no support.
   */
  result: TallyView | null;
}

/** Whether enough of the register is taking part for the meeting's decisions to be valid. */
export interface QuorumView {
  representedWeight: number;
  totalWeight: number;
  representedPercent: number;
  thresholdPercent: number;
  met: boolean;
}

/**
 * Resolutions, votes and quorum.
 *
 * <p>Note what a vote request carries: the resolution and the choice, and nothing else. Who is
 * voting comes from the auth token, and how much their vote is worth comes from the meeting's
 * member list on the server. Neither is sent from here — a weight this client could send would be a
 * weight this client could inflate.
 *
 * <p>Nothing is cached. A tally changes while people are voting, and a stale one shown next to a
 * live vote would be worse than no tally at all.
 */
@Injectable({ providedIn: 'root' })
export class VotingService {
  private readonly base = `${environment.apiBase}/api/voting`;
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);

  private headers(): Record<string, string> {
    const token = this.auth.token();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** The agenda, each motion carrying this user's own vote and the tally if they may see it. */
  list(meetingId: string): Observable<ResolutionView[]> {
    return this.http.post<ResolutionView[]>(
      `${this.base}/list-resolutions`,
      { meetingId },
      // SILENT: the ballot re-reads every few seconds so tallies stay live. Casting a vote is a
      // user action and still raises the bar.
      { headers: this.headers(), context: new HttpContext().set(SILENT, true) },
    );
  }

  details(id: string): Observable<ResolutionView> {
    return this.http.post<ResolutionView>(
      `${this.base}/resolution-details`,
      { id },
      {
        headers: this.headers(),
        // SILENT: one resolution's detail expanding inside the open list.
        context: new HttpContext().set(SILENT, true),
      },
    );
  }

  quorum(meetingId: string): Observable<QuorumView> {
    return this.http.post<QuorumView>(
      `${this.base}/meeting-quorum`,
      { meetingId },
      // SILENT: polled on the same timer as the ballot, so it has the same reason to stay quiet.
      { headers: this.headers(), context: new HttpContext().set(SILENT, true) },
    );
  }

  /** Cast or change a vote. Returns the motion as this user now sees it. */
  vote(resolutionId: string, choice: VoteChoice): Observable<ResolutionView> {
    return this.http.post<ResolutionView>(
      `${this.base}/cast-vote`,
      { resolutionId, choice },
      { headers: this.headers() },
    );
  }

  // ---- the chair's actions (moderator/admin; the server enforces it) ---------

  create(
    meetingId: string,
    title: string,
    text: string,
    type: ResolutionType,
  ): Observable<ResolutionView> {
    return this.http.post<ResolutionView>(
      `${this.base}/create-resolution`,
      { meetingId, title, text, type },
      { headers: this.headers() },
    );
  }

  /**
   * Edit a motion.
   *
   * Wording and type can only change while it is still a draft — the server refuses once voting has
   * started, because members voted on the text in front of them. Ordering and result visibility stay
   * editable throughout, since neither changes what is being decided.
   */
  update(
    id: string,
    patch: {
      title?: string;
      text?: string;
      type?: ResolutionType;
      seq?: number;
      liveResultsVisible?: boolean;
    },
  ): Observable<ResolutionView> {
    return this.http.post<ResolutionView>(
      `${this.base}/update-resolution`,
      { id, ...patch },
      { headers: this.headers() },
    );
  }

  /** Open the floor. Only from DRAFT, and only while the meeting is live. */
  open(id: string): Observable<ResolutionView> {
    return this.http.post<ResolutionView>(
      `${this.base}/open-resolution`,
      { id },
      { headers: this.headers() },
    );
  }

  /** Close the vote and fix the result. Closed is final — a new motion is the way to revisit it. */
  close(id: string): Observable<ResolutionView> {
    return this.http.post<ResolutionView>(
      `${this.base}/close-resolution`,
      { id },
      { headers: this.headers() },
    );
  }

  remove(id: string): Observable<unknown> {
    return this.http.post(`${this.base}/delete-resolution`, { id }, { headers: this.headers() });
  }
}
