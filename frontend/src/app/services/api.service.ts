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
  /** e.g. "nimbus-annual-report-2024.pdf p.3" or "Recording: Q3 AGM @ 12:04" */
  source: string;
  snippet: string;
  /**
   * Set only for a passage from a recording's transcript. Explicit fields rather than parsing them
   * back out of `source`, since a recording title can contain any punctuation.
   */
  video_id?: string | null;
  at_seconds?: number | null;
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

/** One question inside a cluster, for the curation panel. */
export interface QuestionInCluster {
  id: string;
  text: string;
  createdAt: string;
}

/** A cluster that was folded into this one — kept so an unexpectedly large group is explainable. */
export interface MergedAway {
  clusterId: string;
  question: string | null;
  mergedBy: string | null;
  mergedAt: string;
}

export interface ClusterQuestionsView {
  clusterId: string;
  questions: QuestionInCluster[];
  mergedIn: MergedAway[];
}

export interface KnowledgeStatus {
  sources: string[];
  chunks_indexed: number;
  ready: boolean;
  /** The most recent indexing or removal run, so the UI can show what the pipeline actually did. */
  last_index_run?: IndexRun | null;
}

/** One stage of an indexing run, as reported by the AI service. */
export interface IndexStep {
  name: string;
  tool: string;
  detail: string;
  status: 'running' | 'done' | 'failed';
  ms: number | null;
}

export interface IndexRun {
  label: string;
  running: boolean;
  note: string | null;
  total_ms: number;
  steps: IndexStep[];
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

/** Where a citation leads, and how the UI should open it. */
export interface CitationTarget {
  /** `report` opens a PDF at a page; `recording` opens the player at a second. */
  kind: 'report' | 'recording';
  url: string;
  /** True for a recording — an in-app route, so it must not open in a new tab. */
  internal: boolean;
}

/**
 * Resolve a citation to something clickable.
 *
 * <p>Two kinds now reach the UI. A report citation opens the source PDF at its page, as before. A
 * recording citation opens the recordings page at the exact second the passage was spoken — the
 * `video_id` and `at_seconds` come from the AI service as explicit fields rather than being parsed
 * back out of the label, because a recording title can contain anything.
 */
export function citationTarget(citation: Citation): CitationTarget {
  if (citation.video_id) {
    const at = Math.max(0, Math.floor(citation.at_seconds ?? 0));
    const query = at > 0 ? `&t=${at}` : '';
    return {
      kind: 'recording',
      url: `/recordings?v=${encodeURIComponent(citation.video_id)}${query}`,
      internal: true,
    };
  }
  return { kind: 'report', url: parseCitation(citation.source).url, internal: false };
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

  // ---- Curation: fixing the grouping when it is wrong ----------------------

  /** The questions actually inside a cluster — what you read before deciding to split it. */
  clusterQuestions(clusterId: string): Observable<ClusterQuestionsView> {
    return this.http.post<ClusterQuestionsView>(
      `${environment.apiBase}/api/clusters/cluster-questions`,
      { clusterId },
      { headers: this.authHeaders() },
    );
  }

  /**
   * Fold one cluster into another — the fix for one topic split across two groups.
   *
   * Durable: questions the clusterer would later have filed under the merged-away group are
   * redirected too, so the merge does not quietly undo itself. Returns the rebuilt board.
   */
  mergeClusters(sourceClusterId: string, targetClusterId: string): Observable<ClusterView[]> {
    return this.http.post<ClusterView[]>(
      `${environment.apiBase}/api/clusters/merge-clusters`,
      { sourceClusterId, targetClusterId },
      { headers: this.authHeaders() },
    );
  }

  /**
   * Separate chosen questions into a cluster of their own.
   *
   * Applies only to questions already asked — the clusterer has no centroid for the new group, so
   * similar questions arriving later will land wherever it puts them.
   */
  splitCluster(clusterId: string, questionIds: string[]): Observable<ClusterView[]> {
    return this.http.post<ClusterView[]>(
      `${environment.apiBase}/api/clusters/split-cluster`,
      { clusterId, questionIds },
      { headers: this.authHeaders() },
    );
  }

  /** Move one misfiled question to another cluster. */
  moveQuestion(questionId: string, targetClusterId: string): Observable<ClusterView[]> {
    return this.http.post<ClusterView[]>(
      `${environment.apiBase}/api/clusters/move-question`,
      { questionId, targetClusterId },
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

  /**
   * Delete one indexed document — its file, its chunks and its embeddings.
   *
   * Returns the knowledge-base status as it stands *after* the rebuild, so the caller sets its panel
   * from this response rather than firing a second request that could race the rebuild it follows.
   */
  removeKnowledgeSource(filename: string): Observable<KnowledgeStatus> {
    return this.http.post<KnowledgeStatus>(
      `${environment.apiBase}/api/admin/remove-knowledge-source`,
      { filename },
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
