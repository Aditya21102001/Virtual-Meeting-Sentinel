import { HttpClient, HttpContext } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { environment } from '../../environments/environment';
import { AuthService } from '../services/auth.service';
import { SILENT } from '../services/loading.service';
import { FaqEntry, HELP_SECTIONS } from './help-content';

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

            <!--
              How-to guidance, matched locally against the help catalogue.

              Shown FIRST and separately from the document passages below, because they answer
              different questions. "How do I open the ballot?" is answered here; "what dividend was
              declared?" is answered by the passages. Previously only the passages existed, so any
              question about using the application was answered with extracts from the annual
              report — which is why it appeared to not work.

              Rendered from local content, so this half of the widget keeps working when the AI
              service is asleep or down. That is exactly when somebody opens help.
            -->
            @if (guides().length) {
              <p class="muted small">Using the application</p>
              @for (guide of guides(); track guide.q) {
                <div class="guide">
                  <div class="guide-q">{{ guide.q }}</div>
                  @for (para of guide.a; track para) {
                    <p class="guide-a">{{ para }}</p>
                  }
                </div>
              }
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
      .guide {
        border-left: 3px solid var(--accent, #6366f1);
        padding: 6px 0 6px 10px;
        margin: 8px 0;
      }
      .guide-q {
        font-weight: 600;
        font-size: 13px;
        margin-bottom: 4px;
      }
      .guide-a {
        font-size: 13px;
        line-height: 1.45;
        margin: 0 0 6px;
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
  /**
   * Words that carry no subject. Dropped before scoring — see matchGuides.
   *
   * <p>Kept deliberately small: only words that are pure question scaffolding. Anything that could
   * name a topic ("vote", "meeting", "report") must stay, or the entry about it becomes unfindable.
   */
  private static readonly FILLER = new Set([
    'how', 'what', 'why', 'when', 'who', 'where', 'does', 'did', 'the', 'and', 'for', 'you',
    'your', 'can', 'cannot', 'was', 'are', 'with', 'from', 'this', 'that', 'have', 'has',
    'should', 'would', 'could', 'there', 'their', 'will', 'not', 'but', 'any', 'get', 'got',
    'use', 'using', 'about', 'into', 'out', 'its', 'were', 'been', 'being', 'than',
    'then', 'them', 'they', 'she', 'her', 'his', 'him', 'our', 'ours',
  ]);

  /** Help-catalogue entries matching the query. Local, so they need no backend. */
  readonly guides = signal<FaqEntry[]>([]);
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
    // Matched before the request goes out, and deliberately never cleared by its failure: a
    // question about how the application works is answerable whether or not the AI service is
    // reachable, and pretending otherwise would be a worse answer than the one we already have.
    this.guides.set(this.matchGuides(query));

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
          // Only when the LOCAL catalogue came up empty too — otherwise the widget would tell
          // somebody nothing matched while displaying the answer directly above it.
          if (!results?.length && !this.guides().length) {
            this.error.set(
              'Nothing indexed matches that yet. A moderator can upload the annual report or a ' +
                'recording transcript under Setup.',
            );
          }
        },
        error: (err) => {
          this.searching.set(false);
          this.hits.set([]);
          // guides() is left alone on purpose — see matchGuides. If the catalogue answered the
          // question, an unreachable document index does not make that answer wrong.
          if (this.guides().length) {
            this.error.set('');
            return;
          }
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

  /**
   * Find help entries that answer this question, ranked.
   *
   * <p>Deliberately a plain keyword score rather than anything cleverer. The catalogue is a couple
   * of dozen entries written in the same vocabulary the interface uses, so a term appearing in the
   * question is already a strong signal — and unlike a vector search this costs nothing, returns
   * instantly as the user types, and cannot be taken away by an outage.
   *
   * <p>A hit in the entry's QUESTION outweighs one in its body, because the question is what the
   * entry is about; a body mention is often incidental.
   */
  private matchGuides(query: string): FaqEntry[] {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      // Short words ("do", "in", "my") and question filler ("how", "does", "work") appear in
      // almost every entry, so scoring them ranked nothing and surfaced three arbitrary answers
      // for any question at all. Only the words that carry the subject are allowed to score.
      .filter((t) => t.length > 2 && !HelpWidgetComponent.FILLER.has(t));
    if (!terms.length) return [];

    return HELP_SECTIONS.flatMap((section) => section.entries)
      .map((entry) => {
        // keywords carries the words somebody would actually type that do not appear in the
        // question as written — "flow", "steps", "how it works". Weighted like the question,
        // because it exists precisely to catch phrasings the question misses.
        const question = (entry.q + ' ' + (entry.keywords ?? '')).toLowerCase();
        const answer = entry.a.join(' ').toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (question.includes(term)) score += 3;
          else if (answer.includes(term)) score += 1;
        }
        return { entry, score };
      })
      // A body-text mention alone (score 1) is usually coincidence — "dividend" appears in the
      // resolution entry, but "what dividend was declared" is a question for the ANNUAL REPORT,
      // not for help. Requiring a question or keyword hit lets those fall through to document
      // search, which is where they are actually answered.
      .filter((scored) => scored.score >= 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)   // enough to answer; more turns a bubble into a wall of text
      .map((scored) => scored.entry);
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
