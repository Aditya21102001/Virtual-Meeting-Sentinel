import { HttpClient, HttpContext } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { environment } from '../../environments/environment';
import { AuthService } from '../services/auth.service';
import { SILENT } from '../services/loading.service';

/** One retrieved passage — the same shape a citation has, plus how close it was. */
export interface SearchHit {
  source: string;
  snippet: string;
  video_id: string | null;
  at_seconds: number | null;
  score: number | null;
}

/**
 * A floating help bubble: ask a question from anywhere, without leaving the page.
 *
 * <h2>Search first, model second</h2>
 * Typing a question runs **semantic search** — a vector lookup over the annual report and every
 * indexed recording. That needs no API key, costs nothing per query, and returns in milliseconds,
 * so it is the default and it still works when the model provider is down or unconfigured.
 *
 * <p>Generating a written answer costs an LLM call, so it is a deliberate second step behind a
 * button rather than something that happens on every keystroke.
 *
 * <p>A hit inside a recording carries the second it was said, so it opens the player there — the
 * same deep link a drafted answer's citation uses.
 */
@Component({
  selector: 'app-help-widget',
  standalone: true,
  imports: [RouterLink],
  template: `
    @if (auth.isAuthenticated()) {
      @if (open()) {
        <div class="panel" role="dialog" aria-label="Ask a question">
          <div class="head">
            <strong>Ask about this meeting</strong>
            <span class="spacer"></span>
            <button class="icon" type="button" (click)="close()" aria-label="Close">✕</button>
          </div>

          <div class="body">
            <!-- FAQ: the questions people actually open this to ask. -->
            @if (!hits().length && !answer() && !searching()) {
              <p class="muted small">Common questions</p>
              <div class="chips">
                @for (q of faq; track q) {
                  <button class="chip" type="button" (click)="askFaq(q)">{{ q }}</button>
                }
              </div>
            }

            @if (searching()) {
              <p class="muted small">Searching…</p>
            }

            @if (error()) {
              <p class="small error">{{ error() }}</p>
            }

            @if (hits().length) {
              <p class="muted small">
                {{ hits().length }} passage(s) — from the annual report and the recordings
              </p>
              @for (hit of hits(); track hit.source + hit.snippet) {
                <div class="hit">
                  @if (hit.video_id) {
                    <a
                      class="hit-source"
                      [routerLink]="['/recordings']"
                      [queryParams]="linkParams(hit)"
                      (click)="close()"
                      >▶ {{ hit.source }}</a
                    >
                  } @else {
                    <span class="hit-source">{{ hit.source }}</span>
                  }
                  <p class="hit-text">{{ hit.snippet }}</p>
                </div>
              }
            }

            @if (answer()) {
              <div class="answer">
                <p class="muted small">Assistant</p>
                <p>{{ answer() }}</p>
              </div>
            }
          </div>

          <div class="foot">
            <input
              type="text"
              placeholder="Ask a question…"
              [value]="query()"
              (input)="query.set($any($event.target).value)"
              (keyup.enter)="search()"
              aria-label="Your question"
            />
            <button (click)="search()" [disabled]="!query().trim() || searching()">Search</button>
          </div>
          <div class="foot">
            <!--
              Generating prose costs a model call, so it is an explicit choice rather than something
              that happens while you type. Search above already answered without one.
            -->
            <button
              class="link"
              type="button"
              (click)="askAssistant()"
              [disabled]="!query().trim() || asking()"
            >
              {{ asking() ? 'Writing an answer…' : 'Write me an answer instead' }}
            </button>
          </div>
        </div>
      }

      <button
        class="bubble"
        type="button"
        (click)="toggle()"
        [attr.aria-expanded]="open()"
        aria-label="Ask a question"
        title="Ask a question"
      >
        {{ open() ? '✕' : '?' }}
      </button>
    }
  `,
  styles: [
    `
      .bubble {
        position: fixed;
        right: 20px;
        bottom: 20px;
        width: 52px;
        height: 52px;
        border-radius: 50%;
        border: none;
        background: #2563eb;
        color: #fff;
        font-size: 22px;
        cursor: pointer;
        box-shadow: 0 6px 20px #0008;
        z-index: 60;
      }
      .panel {
        position: fixed;
        right: 20px;
        bottom: 84px;
        width: min(420px, calc(100vw - 40px));
        max-height: min(70vh, 620px);
        display: flex;
        flex-direction: column;
        background: #0b1220;
        border: 1px solid #334155;
        border-radius: 12px;
        box-shadow: 0 12px 40px #000a;
        z-index: 60;
      }
      .head,
      .foot {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
      }
      .head {
        border-bottom: 1px solid #1f2937;
      }
      .foot {
        border-top: 1px solid #1f2937;
      }
      .foot input {
        flex: 1;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid #334155;
        background: #0f172a;
        color: inherit;
        font: inherit;
      }
      .spacer {
        flex: 1;
      }
      /* The only scrolling region — the header and composer stay put. */
      .body {
        flex: 1;
        overflow-y: auto;
        padding: 12px;
      }
      .small {
        font-size: 12px;
        margin: 0 0 6px;
      }
      .error {
        color: #fca5a5;
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .chip {
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid #334155;
        background: #0f172a;
        color: inherit;
        font: inherit;
        font-size: 12px;
        cursor: pointer;
        text-align: left;
      }
      .chip:hover {
        border-color: #2563eb;
      }
      .hit {
        padding: 8px 0;
        border-bottom: 1px solid #16202f;
      }
      .hit-source {
        font-size: 12px;
        color: #93c5fd;
      }
      .hit-text {
        margin: 4px 0 0;
        font-size: 13px;
        /* Retrieved passages are prose, and a long unbroken token must not widen the panel. */
        overflow-wrap: anywhere;
      }
      .answer {
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid #1f2937;
      }
    `,
  ],
})
export class HelpWidgetComponent {
  protected readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);

  readonly open = signal(false);
  readonly query = signal('');
  readonly hits = signal<SearchHit[]>([]);
  readonly answer = signal('');
  readonly searching = signal(false);
  readonly asking = signal(false);
  readonly error = signal('');

  /**
   * Starter questions.
   *
   * <p>Hard-coded rather than derived: on an empty knowledge base there is nothing to derive from,
   * and the point of these is to show what the assistant is *for* before anyone has typed anything.
   */
  readonly faq = [
    'When is the dividend being paid?',
    'What were the results this year?',
    'How do I submit a question?',
    'Where can I watch the recording?',
    'What was said about capital expenditure?',
  ];

  private readonly base = environment.apiBase;

  private headers(): Record<string, string> {
    const token = this.auth.token();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  toggle(): void {
    this.open.update((v) => !v);
  }

  close(): void {
    this.open.set(false);
  }

  askFaq(question: string): void {
    this.query.set(question);
    this.search();
  }

  /** Vector search — no model, so this is the cheap default. */
  search(): void {
    const query = this.query().trim();
    if (!query || this.searching()) return;
    this.searching.set(true);
    this.error.set('');
    this.answer.set('');

    this.http
      .post<SearchHit[]>(
        `${this.base}/api/chat/semantic-search`,
        { query, k: 6 },
        {
          headers: this.headers(),
          // SILENT: this is a search box. It already reports itself through searching(), which
          // disables its own button and shows its own spinner inside the widget. Letting it raise
          // the GLOBAL loader as well would freeze the entire application — every menu, every
          // page — while somebody types a question into a help panel, which is the opposite of
          // what a help panel is for.
          context: new HttpContext().set(SILENT, true),
        },
      )
      .subscribe({
        next: (results) => {
          this.searching.set(false);
          this.hits.set(results ?? []);
          if (!results?.length) {
            this.error.set(
              'Nothing indexed matches that yet. A moderator can upload the annual report or a ' +
                'recording transcript under Setup.',
            );
          }
        },
        error: (err) => {
          this.searching.set(false);
          this.hits.set([]);
          // Prefer the server's own sentence when it sent one. It is more specific than
          // anything guessable from the status alone — it names what failed and whether waiting
          // is likely to help. The status-based text remains the fallback for a request that
          // never reached the server at all (status 0).
          const fromServer = err?.error?.message;
          this.error.set(
            typeof fromServer === 'string' && fromServer.trim()
              ? fromServer
              : err?.status === 0 || err?.status >= 502
                ? 'The assistant service is asleep or restarting. Try again in a moment.'
                : 'Search failed. Try again.',
          );
        },
      });
  }

  /** Generate prose. Costs a model call, hence a separate, deliberate action. */
  askAssistant(): void {
    const body = this.query().trim();
    if (!body || this.asking()) return;
    this.asking.set(true);
    this.error.set('');

    this.http
      .post<{ answer: string }>(
        `${this.base}/api/chat/ask-assistant`,
        { body },
        {
          headers: this.headers(),
          // SILENT for the same reason, and more so: a model call runs for tens of seconds. Held
          // behind the global loader it would look exactly like the application having hung.
          // asking() already conveys it, in the one place the user is looking.
          context: new HttpContext().set(SILENT, true),
        },
      )
      .subscribe({
        next: (result) => {
          this.asking.set(false);
          this.answer.set(result?.answer ?? '');
        },
        error: () => {
          this.asking.set(false);
          this.error.set(
            'Could not write an answer — the model may be unconfigured or rate limited. The search ' +
              'results above come from the same sources and need no model.',
          );
        },
      });
  }

  linkParams(hit: SearchHit): Record<string, string> {
    const at = Math.max(0, Math.floor(hit.at_seconds ?? 0));
    return at > 0 ? { v: hit.video_id!, t: String(at) } : { v: hit.video_id! };
  }
}
