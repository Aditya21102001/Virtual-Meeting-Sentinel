import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { SILENT } from './loading.service';

/** One motion and how it went. */
export interface ResolutionOutcome {
  id: string;
  seq: number;
  title: string;
  text: string | null;
  type: 'ORDINARY' | 'SPECIAL';
  status: 'DRAFT' | 'OPEN' | 'CLOSED';
  requiredMajorityPercent: number;
  forWeight: number;
  againstWeight: number;
  abstainWeight: number;
  forCount: number;
  againstCount: number;
  abstainCount: number;
  forPercent: number;
  carried: boolean;
  openedAt: string | null;
  closedAt: string | null;
}

/**
 * One topic raised, and the answer given.
 *
 * `askedHere` is this meeting's share of the group, not its global size — a topic carried over from
 * an earlier meeting must not inflate this meeting's numbers.
 */
export interface TopicOutcome {
  clusterId: string;
  question: string;
  askedHere: number;
  weightHere: number;
  answer: string | null;
  answeredBy: string | null;
  status: string;
  answered: boolean;
}

export interface QuorumSummary {
  representedWeight: number;
  totalWeight: number;
  representedPercent: number;
  thresholdPercent: number;
  met: boolean;
}

export interface MeetingReport {
  meetingId: string;
  title: string;
  description: string | null;
  status: string;
  scheduledAt: string | null;
  activatedAt: string | null;
  closedAt: string | null;
  memberCount: number;
  totalVotingWeight: number;
  quorum: QuorumSummary;
  resolutions: ResolutionOutcome[];
  answeredTopics: TopicOutcome[];
  unansweredTopics: TopicOutcome[];
  questionsAsked: number;
  /**
   * Questions that predate per-meeting recording. Disclosed rather than hidden: counting them here
   * would credit this meeting with another's questions, and omitting them silently would understate
   * what the system holds.
   */
  questionsNotAttributedToAnyMeeting: number;
  generatedAt: string;
}

/**
 * What happened at a meeting.
 *
 * <p>Assembled on demand from rows that are themselves the source of truth, so there is no stored
 * copy to fall out of step with them.
 */
@Injectable({ providedIn: 'root' })
export class ReportService {
  private readonly base = `${environment.apiBase}/api/reports`;
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);

  private headers(): Record<string, string> {
    const token = this.auth.token();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  report(meetingId: string): Observable<MeetingReport> {
    return this.http.post<MeetingReport>(
      `${this.base}/meeting-report`,
      { meetingId },
      { headers: this.headers() },
    );
  }

  /**
   * The Markdown minutes, as a blob.
   *
   * A POST rather than a link, so it travels with the Authorization header — a plain navigation
   * would carry no token and the download would come back as a 401 page.
   */
  minutes(meetingId: string): Observable<Blob> {
    return this.http.post(
      `${this.base}/download-minutes`,
      { meetingId },
      // The button shows "Preparing…" itself, and a download is something you should be able to
      // start and then keep working.
      {
        headers: this.headers(),
        responseType: 'blob',
        context: new HttpContext().set(SILENT, true),
      },
    );
  }
}
