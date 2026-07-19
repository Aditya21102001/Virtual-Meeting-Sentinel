import { Component, OnDestroy, OnInit, signal } from '@angular/core';
import { ApiService, ClusterView, parseCitation } from '../services/api.service';
import { BoardService } from '../services/board.service';

@Component({
  selector: 'app-moderator',
  standalone: true,
  template: `
    <div class="container">
      <div class="row">
        <h1 style="flex:1">Moderator board</h1>
        <span class="badge" [class.hot]="!board.connected()">
          {{ board.connected() ? 'live' : 'connecting…' }}
        </span>
      </div>
      <p class="muted">
        Questions ranked by how many people asked × shareholder weight. Updates in real time.
      </p>

      @if (error()) {
        <div class="card" style="border-color:var(--accent); color:var(--accent)">{{ error() }}</div>
      }

      @if (board.board().length === 0) {
        <div class="card muted">No questions yet. Open the “Ask a question” tab and submit a few.</div>
      }

      @for (c of board.board(); track c.cluster_id) {
        <div class="card">
          <div class="q">{{ c.representative_question }}</div>
          <div class="row">
            <span class="badge" [class.hot]="c.size >= 3">{{ c.size }} asked</span>
            <span class="muted">priority {{ c.priority_score }}</span>
            <span style="flex:1"></span>
            <button (click)="draft(c)" [disabled]="drafting().has(c.cluster_id)">
              {{ drafting().has(c.cluster_id) ? 'Drafting…' : 'Draft answer' }}
            </button>
          </div>
          @if (c.draft) {
            <div class="draft">{{ c.draft }}</div>
            @if (c.citations.length) {
              <div class="cite">
                <strong>Sources</strong> (from the annual report — click to open at the page):
                <ul style="margin:6px 0 0; padding-left:18px">
                  @for (cit of c.citations; track cit.source) {
                    <li>
                      <a [href]="link(cit.source).url" target="_blank" rel="noopener"
                         [title]="cit.snippet">
                        {{ cit.source }}
                      </a>
                    </li>
                  }
                </ul>
              </div>
            }
          }
        </div>
      }
    </div>
  `,
})
export class ModeratorComponent implements OnInit, OnDestroy {
  readonly drafting = signal<Set<string>>(new Set());
  readonly error = signal<string | null>(null);
  private pollHandle?: ReturnType<typeof setInterval>;

  constructor(private api: ApiService, protected board: BoardService) {}

  ngOnInit(): void {
    // Token is already set by AuthService — the route guard ensures a logged-in moderator.
    this.loadSnapshot();          // initial snapshot
    this.board.connect();         // then live pushes over STOMP

    // Fallback poll: live WebSocket pushes can drop (esp. behind free-tier proxies), and a
    // just-asked question needs a moment to cluster. Re-fetch every 30s so new questions
    // appear on the board without a manual page refresh.
    this.pollHandle = setInterval(() => this.loadSnapshot(), 30000);
  }

  /** Pull the current ranked board via REST; used for the initial load and the fallback poll. */
  private loadSnapshot(): void {
    this.error.set(null);
    this.api.getBoard().subscribe({
      next: (b) => {
        this.board.board.set(b);
        this.error.set(null);
      },
      error: (err) => {
        const message = err?.status === 403
          ? 'The board is temporarily unavailable. Please try again in a moment.'
          : 'We could not load the board right now.';
        this.error.set(message);
      },
    });
  }

  /** Build the page-anchored PDF link for a citation source string. */
  link(source: string) {
    return parseCitation(source);
  }

  draft(c: ClusterView): void {
    this.mutateDrafting((s) => s.add(c.cluster_id));
    this.api.requestDraft(c.cluster_id, c.representative_question).subscribe({
      next: () => this.mutateDrafting((s) => s.delete(c.cluster_id)),
      error: () => this.mutateDrafting((s) => s.delete(c.cluster_id)),
    });
  }

  /** Signals need a new reference to notify; clone the Set on each change. */
  private mutateDrafting(fn: (s: Set<string>) => void): void {
    const next = new Set(this.drafting());
    fn(next);
    this.drafting.set(next);
  }

  ngOnDestroy(): void {
    this.board.disconnect();
  }
}
