import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';

export type MeetingStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED';

/** What a backfill actually moved. */
export interface BackfillResult {
  meetingId: string;
  meetingTitle: string;
  questionsAdopted: number;
  topicsAdopted: number;
}

export interface MeetingView {
  id: string;
  title: string;
  description: string | null;
  scheduledAt: string | null;
  status: MeetingStatus;
  active: boolean;
  createdBy: string | null;
  activatedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  memberCount: number;
  /** Share of total entitlement that must be represented for the meeting's decisions to be valid. */
  quorumThresholdPercent: number;
}

export interface MeetingMemberView {
  id: string;
  meetingId: string;
  username: string;
  /** What they are at this meeting — descriptive, never an authorisation grant. */
  roleInMeeting: string;
  /**
   * How much their vote counts for: shares held, or 1 for one-member-one-vote.
   *
   * Set here by a user manager and never sent by the voter — see the backend `MeetingMember`.
   */
  votingWeight: number;
  addedBy: string | null;
  createdAt: string;
}

/**
 * Meetings, and who belongs to them.
 *
 * <p>The active meeting is cached here rather than fetched per page: several screens want to show
 * which meeting is live, and there is only ever one.
 */
@Injectable({ providedIn: 'root' })
export class MeetingService {
  private readonly base = `${environment.apiBase}/api/meetings`;
  private readonly auth = inject(AuthService);

  /** The live meeting, or null. Populated by refreshActive(). */
  readonly active = signal<MeetingView | null>(null);
  readonly hasActive = computed(() => this.active() !== null);

  constructor(private http: HttpClient) {}

  private headers(): Record<string, string> {
    const token = this.auth.token();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** Any signed-in user may ask what is live — every screen needs to know. */
  refreshActive(): Observable<MeetingView | null> {
    return this.http
      .post<MeetingView | null>(`${this.base}/active-meeting`, {}, { headers: this.headers() })
      .pipe(tap((meeting) => this.active.set(meeting)));
  }

  list(): Observable<MeetingView[]> {
    return this.http.post<MeetingView[]>(`${this.base}/list-meetings`, {}, { headers: this.headers() });
  }

  create(title: string, description: string, scheduledAt: string | null): Observable<MeetingView> {
    return this.http.post<MeetingView>(
      `${this.base}/create-meeting`,
      { title, description, scheduledAt },
      { headers: this.headers() },
    );
  }

  update(
    id: string,
    title: string,
    description: string,
    scheduledAt: string | null,
    quorumThresholdPercent?: number,
  ): Observable<MeetingView> {
    return this.http.post<MeetingView>(
      `${this.base}/update-meeting`,
      { id, title, description, scheduledAt, quorumThresholdPercent },
      { headers: this.headers() },
    );
  }

  /** Activating one closes whichever meeting was live — the server does the swap atomically. */
  activate(id: string): Observable<MeetingView> {
    return this.http
      .post<MeetingView>(`${this.base}/activate-meeting`, { id }, { headers: this.headers() })
      .pipe(tap((meeting) => this.active.set(meeting)));
  }

  close(id: string): Observable<MeetingView> {
    return this.http
      .post<MeetingView>(`${this.base}/close-meeting`, { id }, { headers: this.headers() })
      .pipe(
        tap((meeting) => {
          if (this.active()?.id === meeting.id) this.active.set(null);
        }),
      );
  }

  remove(id: string): Observable<unknown> {
    return this.http.post(`${this.base}/delete-meeting`, { id }, { headers: this.headers() });
  }

  /**
   * How many questions and topics belong to no meeting.
   *
   * Everything recorded before meetings existed carries no meeting. Switching on per-meeting
   * filtering without adopting those first makes the board appear empty — every question ever
   * asked becomes invisible at once.
   */
  unattributedCount(): Observable<{ questions: number; topics: number }> {
    return this.http.post<{ questions: number; topics: number }>(
      `${this.base}/unattributed-count`,
      {},
      { headers: this.headers() },
    );
  }

  /**
   * Adopt everything unattributed into one meeting.
   *
   * Only ever claims rows with no meeting, so it cannot move anything between meetings and running
   * it twice is harmless.
   */
  backfillInto(id: string): Observable<BackfillResult> {
    return this.http.post<BackfillResult>(
      `${this.base}/backfill-into-meeting`,
      { id },
      { headers: this.headers() },
    );
  }

  members(id: string): Observable<MeetingMemberView[]> {
    return this.http.post<MeetingMemberView[]>(
      `${this.base}/list-members`,
      { id },
      { headers: this.headers() },
    );
  }

  /**
   * Map a user to a meeting. Idempotent — adding somebody twice updates them rather than failing.
   *
   * `votingWeight` is their entitlement. Omit it to leave an existing member's weight alone, or to
   * take the default of 1 for a new one.
   */
  addMember(
    id: string,
    username: string,
    roleInMeeting: string,
    votingWeight?: number,
  ): Observable<MeetingMemberView> {
    return this.http.post<MeetingMemberView>(
      `${this.base}/add-member`,
      { id, username, roleInMeeting, votingWeight },
      { headers: this.headers() },
    );
  }

  removeMember(id: string, username: string): Observable<unknown> {
    return this.http.post(
      `${this.base}/remove-member`,
      { id, username },
      { headers: this.headers() },
    );
  }
}
