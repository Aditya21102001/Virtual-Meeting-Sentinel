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

export interface ClusterView {
  cluster_id: string;
  representative_question: string;
  size: number;
  priority_score: number;
  draft: string | null;
  citations: Citation[];
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
      `${environment.apiBase}/api/questions`,
      { text, attendeeId, weight },
      { headers: this.authHeaders() },
    );
  }

  getBoard(): Observable<ClusterView[]> {
    return this.http.get<ClusterView[]>(`${environment.apiBase}/api/clusters`, {
      headers: this.authHeaders(),
    });
  }

  requestDraft(clusterId: string, representativeQuestion: string): Observable<unknown> {
    return this.http.post(
      `${environment.apiBase}/api/clusters/${clusterId}/draft`,
      { representativeQuestion },
      { headers: this.authHeaders() },
    );
  }

  // ---- Setup / admin (moderator) ------------------------------------------

  knowledgeStatus(): Observable<KnowledgeStatus> {
    return this.http.get<KnowledgeStatus>(`${environment.apiBase}/api/admin/knowledge`, {
      headers: this.authHeaders(),
    });
  }

  /** Upload the annual-report PDF -> indexed into the RAG knowledge base. */
  uploadAnnualReport(file: File): Observable<{ filename: string; chunks_indexed: number } & KnowledgeStatus> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.http.post<{ filename: string; chunks_indexed: number } & KnowledgeStatus>(
      `${environment.apiBase}/api/admin/knowledge`,
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
      `${environment.apiBase}/api/admin/question-bank`,
      form,
      { headers: this.authHeaders() },
    );
  }

  // ---- Member directory / role management (moderator/admin) ----------------

  listUsers(): Observable<Member[]> {
    return this.http.get<Member[]>(`${environment.apiBase}/api/users`, { headers: this.authHeaders() });
  }

  setUserRole(id: string, role: string): Observable<Member> {
    return this.http.patch<Member>(
      `${environment.apiBase}/api/users/${id}/role`,
      { role },
      { headers: this.authHeaders() },
    );
  }
}
