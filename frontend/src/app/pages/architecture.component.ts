import {
  Component,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  signal,
  viewChildren,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { NavigationHistoryService } from '../services/navigation-history.service';

type ArchTab = 'context' | 'containers' | 'components' | 'workflows' | 'adrs' | 'security';

declare global {
  interface Window {
    mermaid?: {
      initialize: (config: unknown) => void;
      run: (options: { nodes: NodeListOf<Element> | Element[] }) => Promise<void>;
    };
  }
}

@Component({
  selector: 'app-architecture',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="arch-container">
      <!-- Top Navigation & Controls -->
      <div class="top-bar">
        <button
          type="button"
          class="back-btn"
          (click)="navHistory.back('/welcome')"
          aria-label="Back to previous page"
        >
          ← Back
        </button>
        <div class="top-meta">
          <span class="badge-pill">Enterprise C4 Blueprint</span>
          <span class="status-indicator">
            <span class="pulse-dot"></span> System Live &amp; Grounded
          </span>
        </div>
      </div>

      <!-- Hero Header -->
      <header class="arch-header">
        <h1 class="arch-title">
          System Architecture <span class="gradient-text">&amp; C4 Blueprint</span>
        </h1>
        <p class="arch-subtitle">
          Comprehensive architectural model for real-time crowd-question intelligence,
          semantic deduplication, grounded RAG answering, and resilient video distribution.
        </p>
      </header>

      <!-- Navigation Tabs -->
      <nav class="tab-bar" aria-label="Architecture Views">
        <button
          type="button"
          class="tab-btn"
          [class.active]="activeTab() === 'context'"
          (click)="setTab('context')"
        >
          <span class="tab-icon">🌐</span>
          <span>1. System Context</span>
        </button>
        <button
          type="button"
          class="tab-btn"
          [class.active]="activeTab() === 'containers'"
          (click)="setTab('containers')"
        >
          <span class="tab-icon">📦</span>
          <span>2. Containers</span>
        </button>
        <button
          type="button"
          class="tab-btn"
          [class.active]="activeTab() === 'components'"
          (click)="setTab('components')"
        >
          <span class="tab-icon">🧩</span>
          <span>3. Components</span>
        </button>
        <button
          type="button"
          class="tab-btn"
          [class.active]="activeTab() === 'workflows'"
          (click)="setTab('workflows')"
        >
          <span class="tab-icon">⚡</span>
          <span>4. Workflows</span>
        </button>
        <button
          type="button"
          class="tab-btn"
          [class.active]="activeTab() === 'adrs'"
          (click)="setTab('adrs')"
        >
          <span class="tab-icon">📜</span>
          <span>5. ADRs</span>
        </button>
        <button
          type="button"
          class="tab-btn"
          [class.active]="activeTab() === 'security'"
          (click)="setTab('security')"
        >
          <span class="tab-icon">🛡️</span>
          <span>6. Security</span>
        </button>
      </nav>

      <!-- Tab Content Area -->
      <main class="tab-content">
        <!-- TAB 1: SYSTEM CONTEXT (L1) -->
        @if (activeTab() === 'context') {
          <section class="section-card">
            <div class="card-head">
              <h2>C4 Level 1 — System Context</h2>
              <span class="scope-tag">Global Boundaries &amp; External Actors</span>
            </div>
            <p class="desc">
              Describes how human actors (Shareholders, Moderators, System Administrators) interact with
              Virtual Meeting Sentinel, and how the core system communicates with external identity,
              messaging, LLM inference, and storage networks.
            </p>

            <div class="diagram-shell">
              <pre class="mermaid" #diagramNode>{{ contextDiagram }}</pre>
            </div>

            <div class="grid-3">
              <div class="info-card">
                <h3>Shareholder / Attendee</h3>
                <p>Submits live questions over REST/WSS, receives cluster feedback, casts legally weighted votes, and streams HLS recordings.</p>
              </div>
              <div class="info-card">
                <h3>Moderator / Chair</h3>
                <p>Curates real-time ranked clusters, inspects citations, publishes grounded answers, and controls ballot motion opening.</p>
              </div>
              <div class="info-card">
                <h3>Inference &amp; Identity</h3>
                <p>Google OAuth2 / Brevo for identity and MFA; Groq (Llama-3.3-70b) / Gemini for zero-hallucination RAG answers.</p>
              </div>
            </div>
          </section>
        }

        <!-- TAB 2: CONTAINERS (L2) -->
        @if (activeTab() === 'containers') {
          <section class="section-card">
            <div class="card-head">
              <h2>C4 Level 2 — Container Topology</h2>
              <span class="scope-tag">Microservices &amp; Communication Protocols</span>
            </div>
            <p class="desc">
              Virtual Meeting Sentinel is built as a polyglot microservice architecture designed for
              high-throughput asynchronous processing and real-time WebSocket fan-out.
            </p>

            <div class="diagram-shell">
              <pre class="mermaid" #diagramNode>{{ containerDiagram }}</pre>
            </div>

            <div class="table-container">
              <table class="arch-table">
                <thead>
                  <tr>
                    <th>Container</th>
                    <th>Technology</th>
                    <th>Responsibility</th>
                    <th>Scaling &amp; Protocol</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><strong>Frontend SPA</strong></td>
                    <td>Angular 19+, Signals, HLS.js</td>
                    <td>Reactive live board, ballot voting, persistent PiP video player</td>
                    <td>Edge CDN (Vercel/Cloudflare) / HTTPS</td>
                  </tr>
                  <tr>
                    <td><strong>Core API Gateway</strong></td>
                    <td>Spring Boot 3.x, Java 17/21</td>
                    <td>Enterprise RBAC, durable persistence, STOMP broker, transcode jobs</td>
                    <td>Stateless JVM replicas / REST &amp; WSS (8080)</td>
                  </tr>
                  <tr>
                    <td><strong>AI Service</strong></td>
                    <td>Python 3.11, FastAPI, LangChain</td>
                    <td>Vector embedding, online centroid clustering, FAISS vector search</td>
                    <td>Uvicorn ASGI / HTTP (8000) &amp; Kafka</td>
                  </tr>
                  <tr>
                    <td><strong>Message Bus</strong></td>
                    <td>Apache Kafka (KRaft mode)</td>
                    <td>Durable event stream (<code>questions.incoming</code>), broker decoupling</td>
                    <td>Partitioned by <code>meeting_id</code> (9092/9093)</td>
                  </tr>
                  <tr>
                    <td><strong>Relational Database</strong></td>
                    <td>PostgreSQL 15+</td>
                    <td>Canonical store for identities, questions, resolutions, video catalog</td>
                    <td>ACID compliance, connection pooled (5432)</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        }

        <!-- TAB 3: COMPONENTS (L3) -->
        @if (activeTab() === 'components') {
          <section class="section-card">
            <div class="card-head">
              <h2>C4 Level 3 — Component Breakdown</h2>
              <span class="scope-tag">Internal Module Architecture</span>
            </div>

            <div class="component-grid">
              <div class="comp-box">
                <div class="comp-box-header">
                  <span class="comp-icon">☕</span>
                  <h3>Spring Boot Core Components</h3>
                </div>
                <ul class="comp-list">
                  <li><strong>QuestionService:</strong> Orchestrates durable save, Kafka/HTTP branch, and board pushes.</li>
                  <li><strong>ClusterDraftWorker:</strong> Background off-thread worker executing asynchronous LLM drafts.</li>
                  <li><strong>BoardRefreshScheduler:</strong> Keeps AI service warm and pushes scheduled cluster updates.</li>
                  <li><strong>VotingService:</strong> Enforces two-phase shareholder authentication and vote weighting.</li>
                  <li><strong>VideoTranscodeService:</strong> FFmpeg multi-rendition HLS segmentation &amp; VTT seek filmstrips.</li>
                </ul>
              </div>

              <div class="comp-box">
                <div class="comp-box-header">
                  <span class="comp-icon">🐍</span>
                  <h3>FastAPI AI Components</h3>
                </div>
                <ul class="comp-list">
                  <li><strong>OnlineClusterer:</strong> Incremental cosine nearest-centroid clustering in 384-dim space.</li>
                  <li><strong>SentenceTransformer:</strong> Local <code>all-MiniLM-L6-v2</code> zero-cost ONNX embedding.</li>
                  <li><strong>LangChain RAG Chain:</strong> Retrieval-Augmented Generation strictly bounded to annual reports.</li>
                  <li><strong>FAISS Vector Store:</strong> Fast in-memory similarity search over report chunks.</li>
                  <li><strong>KafkaStreamWorker:</strong> Replay-then-live consumer rebuilding cluster states on boot.</li>
                </ul>
              </div>

              <div class="comp-box">
                <div class="comp-box-header">
                  <span class="comp-icon">🅰️</span>
                  <h3>Angular SPA Components</h3>
                </div>
                <ul class="comp-list">
                  <li><strong>PlayerHostService:</strong> Root document-level video anchoring for W3C PiP persistence.</li>
                  <li><strong>BoardService:</strong> STOMP WebSocket subscriber updating signals with zero Zone.js overhead.</li>
                  <li><strong>AuthService:</strong> Reactive session, role signals, and WebAuthn/TOTP challenge triggers.</li>
                  <li><strong>VotingComponent:</strong> Dynamic shareholder ballot with real-time tally updates.</li>
                </ul>
              </div>
            </div>
          </section>
        }

        <!-- TAB 4: WORKFLOWS (L4) -->
        @if (activeTab() === 'workflows') {
          <section class="section-card">
            <div class="card-head">
              <h2>C4 Level 4 — Operational Sequence Workflows</h2>
              <span class="scope-tag">Live Ingest &amp; Safe Route Transitions</span>
            </div>

            <div class="diagram-shell">
              <pre class="mermaid" #diagramNode>{{ workflowDiagram }}</pre>
            </div>

            <div class="highlight-callout">
              <h4>W3C Picture-in-Picture Preservation Heuristic</h4>
              <p>
                By W3C specification, unmounting or re-parenting a <code>&lt;video&gt;</code> element immediately terminates any
                active Picture-in-Picture window. In Virtual Meeting Sentinel, the player element is owned permanently by
                <code>AppComponent</code> and repositioned in document coordinates by <code>PlayerHostService</code>.
                When returning from PiP, an interaction-aware guard checks the current URL so users actively moderating or
                asking questions are never forcibly ripped away from their work.
              </p>
            </div>
          </section>
        }

        <!-- TAB 5: ADRS -->
        @if (activeTab() === 'adrs') {
          <section class="section-card">
            <div class="card-head">
              <h2>Architectural Decision Records (ADRs)</h2>
              <span class="scope-tag">Key Engineering Decisions &amp; Trade-offs</span>
            </div>

            <div class="adr-grid">
              <article class="adr-card">
                <div class="adr-header">
                  <span class="adr-id">ADR-01</span>
                  <h3>Polyglot Microservices Topology</h3>
                </div>
                <p><strong>Decision:</strong> Angular 19 for type-safe zoneless UI, Spring Boot for transactional RBAC &amp; WebSocket fan-out, Python FastAPI for native PyTorch &amp; LangChain ML.</p>
                <div class="adr-footer"><span class="pill-green">Verified</span> Decoupled scalability.</div>
              </article>

              <article class="adr-card">
                <div class="adr-header">
                  <span class="adr-id">ADR-02</span>
                  <h3>Document-Level Video Anchoring</h3>
                </div>
                <p><strong>Decision:</strong> Anchor video element to document root rather than component tree to prevent W3C PiP destruction upon route transitions.</p>
                <div class="adr-footer"><span class="pill-green">Verified</span> Zero interrupted streams.</div>
              </article>

              <article class="adr-card">
                <div class="adr-header">
                  <span class="adr-id">ADR-03</span>
                  <h3>Durable Persistence Prior to Messaging</h3>
                </div>
                <p><strong>Decision:</strong> Persist all submitted questions to PostgreSQL with <code>status=RECEIVED</code> before dispatching to Kafka or AI service.</p>
                <div class="adr-footer"><span class="pill-green">Verified</span> Zero question loss guarantee.</div>
              </article>

              <article class="adr-card">
                <div class="adr-header">
                  <span class="adr-id">ADR-04</span>
                  <h3>Producer Fail-Fast Timeouts</h3>
                </div>
                <p><strong>Decision:</strong> Reduced Kafka timeouts to <code>max.block.ms=3000</code> to prevent 60-second broker thread locks during outage.</p>
                <div class="adr-footer"><span class="pill-green">Verified</span> Resilience in under 3s.</div>
              </article>

              <article class="adr-card">
                <div class="adr-header">
                  <span class="adr-id">ADR-05</span>
                  <h3>Off-Thread Answering on Arrival</h3>
                </div>
                <p><strong>Decision:</strong> <code>ClusterDraftWorker</code> auto-drafts cited RAG answers asynchronously upon cluster initialization without delaying attendee submissions.</p>
                <div class="adr-footer"><span class="pill-green">Verified</span> Pre-grounded answers.</div>
              </article>

              <article class="adr-card">
                <div class="adr-header">
                  <span class="adr-id">ADR-06</span>
                  <h3>Two-Phase Voting Authentication</h3>
                </div>
                <p><strong>Decision:</strong> Decouple public attendee tokens from certified shareholder balloting. Share weights are server-stamped at vote time.</p>
                <div class="adr-footer"><span class="pill-green">Verified</span> Audit non-repudiation.</div>
              </article>
            </div>
          </section>
        }

        <!-- TAB 6: SECURITY -->
        @if (activeTab() === 'security') {
          <section class="section-card">
            <div class="card-head">
              <h2>Security Architecture &amp; Threat Model</h2>
              <span class="scope-tag">Zero-Trust Boundaries &amp; Non-Repudiation</span>
            </div>

            <div class="diagram-shell">
              <pre class="mermaid" #diagramNode>{{ securityDiagram }}</pre>
            </div>

            <div class="grid-2">
              <div class="security-card">
                <h4>1. Authentication &amp; Multi-Factor Defense</h4>
                <p>
                  Stateless HMAC-SHA256 JWT tokens with role claims. Sensitive administrative actions require
                  TOTP (RFC 6238) or FIDO2/WebAuthn hardware passkeys. Pre-auth challenge tokens carry no
                  application roles and cannot be used as sessions.
                </p>
              </div>
              <div class="security-card">
                <h4>2. Legal Ballot Non-Repudiation</h4>
                <p>
                  Anonymous attendee tokens are rejected by <code>VotingService</code>. Shareholder identity and
                  voting power are derived from the server's signed member ledger and stamped into immutable
                  ballot audit rows.
                </p>
              </div>
              <div class="security-card">
                <h4>3. Media Tokenization</h4>
                <p>
                  HLS video playlists and chunks are protected by short-lived HMAC playback tickets
                  (<code>PlaybackTicketService</code>), preventing hotlinking or unauthorized distribution.
                </p>
              </div>
              <div class="security-card">
                <h4>4. RAG Hallucination Defense</h4>
                <p>
                  Prompts strictly prohibit external hallucination and mandate source citations. If regulatory
                  filings do not contain the answer, the LLM is instructed to explicitly recommend escalation.
                </p>
              </div>
            </div>
          </section>
        }
      </main>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        min-height: 100vh;
        background: #090d16;
        color: #f1f5f9;
        font-family: 'Inter', system-ui, -apple-system, sans-serif;
      }

      .arch-container {
        max-width: 1240px;
        margin: 0 auto;
        padding: 32px 24px 80px 24px;
      }

      .top-bar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 24px;
      }

      .back-btn {
        background: #1e293b;
        color: #94a3b8;
        border: 1px solid #334155;
        padding: 8px 16px;
        border-radius: 8px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .back-btn:hover {
        background: #334155;
        color: #fff;
      }

      .top-meta {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .badge-pill {
        font-size: 0.75rem;
        background: rgba(56, 189, 248, 0.12);
        color: #38bdf8;
        border: 1px solid rgba(56, 189, 248, 0.3);
        padding: 4px 10px;
        border-radius: 9999px;
        font-weight: 600;
      }

      .status-indicator {
        font-size: 0.75rem;
        color: #4ade80;
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 500;
      }

      .pulse-dot {
        width: 8px;
        height: 8px;
        background: #4ade80;
        border-radius: 50%;
        box-shadow: 0 0 10px #4ade80;
      }

      .arch-header {
        margin-bottom: 32px;
      }

      .arch-title {
        font-size: 2.4rem;
        font-weight: 800;
        letter-spacing: -0.02em;
        margin-bottom: 12px;
        color: #ffffff;
      }

      .gradient-text {
        background: linear-gradient(135deg, #38bdf8 0%, #818cf8 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      .arch-subtitle {
        font-size: 1.05rem;
        color: #94a3b8;
        max-width: 820px;
        line-height: 1.6;
      }

      /* Navigation Tabs */
      .tab-bar {
        display: flex;
        gap: 8px;
        overflow-x: auto;
        padding-bottom: 8px;
        margin-bottom: 32px;
        border-bottom: 1px solid #1e293b;
      }

      .tab-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: transparent;
        border: 1px solid transparent;
        color: #94a3b8;
        padding: 10px 18px;
        border-radius: 8px;
        font-size: 0.92rem;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.15s ease;
      }

      .tab-btn:hover {
        color: #f1f5f9;
        background: #131c2e;
      }

      .tab-btn.active {
        color: #38bdf8;
        background: rgba(56, 189, 248, 0.1);
        border-color: rgba(56, 189, 248, 0.3);
      }

      /* Content Sections */
      .section-card {
        background: #0f172a;
        border: 1px solid #1e293b;
        border-radius: 16px;
        padding: 32px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
      }

      .card-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 12px;
      }

      .card-head h2 {
        font-size: 1.5rem;
        font-weight: 700;
        color: #ffffff;
      }

      .scope-tag {
        font-size: 0.8rem;
        color: #818cf8;
        font-weight: 600;
      }

      .desc {
        color: #94a3b8;
        font-size: 0.98rem;
        line-height: 1.6;
        margin-bottom: 24px;
      }

      /* Diagram Container */
      .diagram-shell {
        background: #070b12;
        border: 1px solid #1e293b;
        border-radius: 12px;
        padding: 24px;
        margin: 24px 0;
        overflow-x: auto;
        display: flex;
        justify-content: center;
      }

      .mermaid {
        width: 100%;
        max-width: 1000px;
        text-align: center;
      }

      /* Grids & Cards */
      .grid-3 {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 16px;
        margin-top: 24px;
      }

      .grid-2 {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
        gap: 16px;
        margin-top: 24px;
      }

      .info-card, .security-card {
        background: #131d31;
        border: 1px solid #1e293b;
        border-radius: 10px;
        padding: 20px;
      }

      .info-card h3, .security-card h4 {
        font-size: 1.05rem;
        font-weight: 600;
        color: #38bdf8;
        margin-bottom: 8px;
      }

      .info-card p, .security-card p {
        font-size: 0.88rem;
        color: #94a3b8;
        line-height: 1.55;
      }

      /* Component Grid */
      .component-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 20px;
        margin-top: 20px;
      }

      .comp-box {
        background: #131d31;
        border: 1px solid #1e293b;
        border-radius: 12px;
        padding: 24px;
      }

      .comp-box-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 16px;
        padding-bottom: 12px;
        border-bottom: 1px solid #1e293b;
      }

      .comp-icon {
        font-size: 1.4rem;
      }

      .comp-box-header h3 {
        font-size: 1.1rem;
        color: #ffffff;
      }

      .comp-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .comp-list li {
        font-size: 0.88rem;
        color: #94a3b8;
        line-height: 1.5;
      }

      .comp-list strong {
        color: #38bdf8;
      }

      /* ADR Grid */
      .adr-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 18px;
      }

      .adr-card {
        background: #131d31;
        border: 1px solid #1e293b;
        border-radius: 12px;
        padding: 22px;
        display: flex;
        flex-direction: column;
      }

      .adr-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 12px;
      }

      .adr-id {
        font-size: 0.72rem;
        background: #1e293b;
        color: #38bdf8;
        padding: 2px 8px;
        border-radius: 6px;
        font-weight: 700;
      }

      .adr-header h3 {
        font-size: 1rem;
        color: #ffffff;
      }

      .adr-card p {
        font-size: 0.88rem;
        color: #94a3b8;
        line-height: 1.55;
        margin-bottom: 16px;
      }

      .adr-footer {
        margin-top: auto;
        padding-top: 12px;
        border-top: 1px solid #1e293b;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.82rem;
        color: #cbd5e1;
      }

      .pill-green {
        font-size: 0.7rem;
        background: rgba(74, 222, 128, 0.15);
        color: #4ade80;
        padding: 2px 6px;
        border-radius: 4px;
        font-weight: 600;
      }

      /* Tables */
      .table-container {
        overflow-x: auto;
        margin-top: 24px;
      }

      .arch-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.9rem;
      }

      .arch-table th, .arch-table td {
        padding: 12px 16px;
        text-align: left;
        border-bottom: 1px solid #1e293b;
      }

      .arch-table th {
        background: #131c2e;
        color: #ffffff;
        font-weight: 600;
      }

      .arch-table td {
        color: #94a3b8;
      }

      .arch-table tr:hover td {
        background: rgba(255, 255, 255, 0.02);
      }

      .highlight-callout {
        background: rgba(56, 189, 248, 0.06);
        border: 1px solid rgba(56, 189, 248, 0.2);
        border-radius: 10px;
        padding: 20px;
        margin-top: 24px;
      }

      .highlight-callout h4 {
        color: #38bdf8;
        font-size: 1rem;
        margin-bottom: 8px;
      }

      .highlight-callout p {
        color: #cbd5e1;
        font-size: 0.9rem;
        line-height: 1.6;
      }
    `
  ]
})
export class ArchitectureComponent {
  readonly navHistory = inject(NavigationHistoryService);
  readonly activeTab = signal<ArchTab>('context');
  readonly diagramNodes = viewChildren<ElementRef<HTMLElement>>('diagramNode');

  // Diagrams in Mermaid syntax
  readonly contextDiagram = `
C4Context
    title System Context — Virtual Meeting Sentinel
    Person(attendee, "Attendee / Shareholder", "Submits questions, casts weighted votes")
    Person(moderator, "Moderator / Chair", "Reviews ranked clusters, publishes answers")
    System(sentinel, "Virtual Meeting Sentinel", "Clusters live questions, auto-drafts cited RAG answers")
    System_Ext(google_auth, "Google Identity", "OAuth 2.0 Auth")
    System_Ext(llm_gateway, "LLM Gateway", "Groq / Gemini Inference")
    System_Ext(storage_nas, "NAS / Shared Storage", "Stores PDFs & HLS chunks")
    Rel(attendee, sentinel, "Asks, Votes, Streams", "HTTPS / WSS")
    Rel(moderator, sentinel, "Moderates & Ballots", "HTTPS / WSS")
    Rel(sentinel, google_auth, "Validates OAuth", "HTTPS")
    Rel(sentinel, llm_gateway, "Drafts answers", "HTTPS")
    Rel(sentinel, storage_nas, "HLS Segments & PDFs", "POSIX")
  `.trim();

  readonly containerDiagram = `
C4Container
    title Container Architecture — Virtual Meeting Sentinel
    Person(user, "User (Attendee / Moderator)", "Web Browser")
    Container(spa, "Angular 19+ SPA", "Signals, HLS.js, StompJS", "Reactive live board & persistent PiP video")
    Container(api, "Spring Boot Core API", "Java 17/21, Spring Security", "Auth, durable store, WebSocket broker, transcode")
    Container(ai_service, "FastAPI AI Service", "Python, LangChain, FAISS", "384-dim embed, online clustering, cited RAG")
    ContainerQueue(kafka, "Apache Kafka", "Topic: questions.incoming", "Durable event stream buffer")
    ContainerDb(postgres, "PostgreSQL", "Relational Store", "Users, questions, drafts, ballots, video index")
    Rel(user, spa, "Interacts", "HTTPS")
    Rel(spa, api, "REST & STOMP", "HTTPS / WSS (8080)")
    Rel(api, postgres, "Reads/Writes", "JDBC")
    Rel(api, kafka, "Publishes events", "Kafka Protocol")
    Rel(kafka, ai_service, "Consumes events", "Kafka Consumer")
    Rel(api, ai_service, "Direct Ingest & Draft", "HTTP (8000)")
  `.trim();

  readonly workflowDiagram = `
sequenceDiagram
    autonumber
    actor Attendee
    participant SPA as Angular SPA
    participant API as Spring Boot API
    participant DB as PostgreSQL
    participant Worker as ClusterDraftWorker
    participant AI as AI Service (FastAPI)
    participant STOMP as WebSocket /topic/board
    actor Moderator

    Attendee->>SPA: Types question
    SPA->>API: POST /api/questions/submit-question
    API->>DB: INSERT question (status=RECEIVED)
    API->>AI: POST /ingest (embed & nearest centroid)
    AI-->>API: {cluster_id, is_new}
    API->>DB: UPDATE question SET cluster_id
    API-->>SPA: Return IngestResult
    API->>Worker: enqueue(cluster_id, text)
    Worker-->>AI: POST /draft (Async off-thread)
    AI-->>Worker: {draft_answer, citations}
    Worker->>STOMP: Broadcast updated board
    STOMP-->>Moderator: Real-time board update with cited answer
  `.trim();

  readonly securityDiagram = `
flowchart LR
    subgraph Untrusted_Network ["Public Internet"]
        Client[Client Browser]
    end
    subgraph Edge ["Security Perimeter"]
        SSL[TLS & CORS Validation]
    end
    subgraph Core_Services ["Spring Boot Protected Layer"]
        Filter[JwtAuthFilter]
        RBAC[Spring Security RBAC]
        DB[(PostgreSQL)]
        AI_SVC[FastAPI Service]
    end
    Client -->|HTTPS / WSS| SSL
    SSL --> Filter
    Filter --> RBAC
    RBAC --> DB
    RBAC --> AI_SVC
  `.trim();

  constructor() {
    afterNextRender(() => {
      this.ensureMermaidLoaded();
    });

    effect(() => {
      // Trigger diagram render whenever tab changes
      const currentTab = this.activeTab();
      if (currentTab) {
        setTimeout(() => this.renderDiagrams(), 50);
      }
    });
  }

  setTab(tab: ArchTab): void {
    this.activeTab.set(tab);
  }

  private ensureMermaidLoaded(): void {
    if (typeof window === 'undefined') return;

    if (!window.mermaid) {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';
      script.async = true;
      script.onload = () => {
        if (window.mermaid) {
          window.mermaid.initialize({
            startOnLoad: false,
            theme: 'dark',
            themeVariables: {
              darkMode: true,
              background: '#070b12',
              primaryColor: '#38bdf8',
              primaryTextColor: '#f8fafc',
              primaryBorderColor: '#0284c7',
              lineColor: '#64748b',
              secondaryColor: '#6366f1',
              tertiaryColor: '#1e293b',
            },
            securityLevel: 'loose',
          });
          this.renderDiagrams();
        }
      };
      document.head.appendChild(script);
    } else {
      this.renderDiagrams();
    }
  }

  private async renderDiagrams(): Promise<void> {
    if (typeof window === 'undefined' || !window.mermaid) return;

    const nodes = this.diagramNodes();
    if (!nodes || nodes.length === 0) return;

    try {
      const elements = nodes.map((n) => n.nativeElement);
      await window.mermaid.run({ nodes: elements });
    } catch {
      // Mermaid render errors fall back cleanly to raw text
    }
  }
}
