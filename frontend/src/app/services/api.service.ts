import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface IngestResult {
  question_id: string;
  cluster_id: string;
  is_new_cluster: boolean;
  similarity: number;
  cluster_size: number;
}

export interface Citation {
  source: string;   // e.g. "nimbus-annual-report-2024.pdf p.3"
  snippet: string;
}

/** How the answer on a cluster came to be, and whether anyone still needs to act. */
export type DraftStatus = 'PENDING' | 'DRAFTED' | 'NEEDS_MANUAL' | 'MANUAL';

export interface ClusterView {
  cluster_id: string;
  representative_question: string;
  size: number;
  priority_score: number;
  draft: string | null;
  citations: Citation[];
  /** PENDING = the model is still working; NEEDS_MANUAL = it gave up, write this one. */
  draft_status: DraftStatus | null;
  /** Why automatic drafting gave up — shown so the moderator knows what happened. */
  draft_error: string | null;
  /** Who wrote it, when a moderator answered by hand. */
  answered_by: string | null;
}

export interface KnowledgeStatus {
  sources: string[];
  chunks_indexed: number;
  ready: boolean;
}

export interface Member {
  id: string;
  username: string;
  email: string | null;
  role: string;
}

/**
 * Parse a citation source like "annual-report-2024.pdf p.3" into a clickable link that
 * opens the served PDF at that page (browser PDF viewers honour the #page=N anchor).
 */
export function parseCitation(source: string): { filename: string; page: number | null; url: string } {
  const match = source.match(/^(.*\.pdf)\s*(?:p\.?\s*(\d+))?/i);
  const filename = match?.[1] ?? source;
  const page = match?.[2] ? Number(match[2]) : null;
  const base = `${environment.apiBase}/api/source/${encodeURIComponent(filename)}`;
  return { filename, page, url: page ? `${base}#page=${page}` : base };
}

/**
 * Board / setup / member-directory calls.
 *
 * Every endpoint is a POST to a named route, with identifiers in the body rather than the URL.
 * The browser's network panel labels a request with the last path segment, so REST-style routes
 * showed up as a column of bare ids; `submit-question` and `set-member-role` are readable at a
 * glance. The only GETs left in the app are the ones the browser issues itself and cannot be
 * asked to POST: video media, and the PDF behind a citation link (see `parseCitation`).
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private token: string | null = null;

  constructor(private http: HttpClient) {}

  /** Anonymous attendee token (no password) — attendees just join and submit. */
  attendeeLogin(username: string): Observable<{ token: string }> {
    return this.http.post<{ token: string }>(
      `${environment.apiBase}/api/auth/attendee`,
      { username },
    );
  }

  setToken(token: string) {
    this.token = token;
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  submitQuestion(text: string, attendeeId: string, weight: number): Observable<IngestResult> {
    return this.http.post<IngestResult>(
      `${environment.apiBase}/api/questions/submit-question`,
      { text, attendeeId, weight },
      { headers: this.authHeaders() },
    );
  }

  getBoard(): Observable<ClusterView[]> {
    return this.http.post<ClusterView[]>(
      `${environment.apiBase}/api/clusters/question-board`,
      {},
      { headers: this.authHeaders() },
    );
  }

  requestDraft(clusterId: string, representativeQuestion: string): Observable<unknown> {
    return this.http.post(
      `${environment.apiBase}/api/clusters/draft-answer`,
      { clusterId, representativeQuestion },
      { headers: this.authHeaders() },
    );
  }

  /**
   * Store an answer a moderator wrote themselves — the fallback for when the model could not.
   * Saved as MANUAL, which automatic drafting will never overwrite.
   */
  saveAnswer(clusterId: string, answer: string): Observable<ClusterView> {
    return this.http.post<ClusterView>(
      `${environment.apiBase}/api/clusters/save-answer`,
      { clusterId, answer },
      { headers: this.authHeaders() },
    );
  }

  // ---- Setup / admin (moderator) ------------------------------------------

  knowledgeStatus(): Observable<KnowledgeStatus> {
    return this.http.post<KnowledgeStatus>(
      `${environment.apiBase}/api/admin/knowledge-status`,
      {},
      { headers: this.authHeaders() },
    );
  }

  /** Upload the annual-report PDF -> indexed into the RAG knowledge base. */
  uploadAnnualReport(file: File): Observable<{ filename: string; chunks_indexed: number } & KnowledgeStatus> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.http.post<{ filename: string; chunks_indexed: number } & KnowledgeStatus>(
      `${environment.apiBase}/api/admin/upload-annual-report`,
      form,
      { headers: this.authHeaders() },
    );
  }

  /** Upload a question bank (one question per line; .txt or .csv). */
  uploadQuestionBank(file: File, weight = 0.1): Observable<{ received: number; ingested: number }> {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('weight', String(weight));
    return this.http.post<{ received: number; ingested: number }>(
      `${environment.apiBase}/api/admin/upload-question-bank`,
      form,
      { headers: this.authHeaders() },
    );
  }

  // ---- Member directory / role management (moderator/admin) ----------------

  listUsers(): Observable<Member[]> {
    return this.http.post<Member[]>(
      `${environment.apiBase}/api/users/list-members`,
      {},
      { headers: this.authHeaders() },
    );
  }

  setUserRole(id: string, role: string): Observable<Member> {
    return this.http.post<Member>(
      `${environment.apiBase}/api/users/set-member-role`,
      { id, role },
      { headers: this.authHeaders() },
    );
  }
}
