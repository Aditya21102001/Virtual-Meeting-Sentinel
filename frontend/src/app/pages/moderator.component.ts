import { Component, OnDestroy, OnInit, computed, inject, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import {
  ApiService,
  Citation,
  CitationTarget,
  ClusterView,
  MergedAway,
  QuestionInCluster,
  citationTarget,
  parseCitation,
} from "../services/api.service";
import { BoardService } from "../services/board.service";
import { FeatureService } from "../services/feature.service";
import { RoomService, TopicView } from "../services/room.service";
import { DemoMeetingService, EnrichedClusterView } from "../services/demo-meeting.service";

@Component({
  selector: "app-moderator",
  imports: [RouterLink],
  standalone: true,
  template: `
    <div class="container">
      <div class="row header-row">
        <h1 style="flex:1">Moderator board</h1>
        <span class="badge" [class.hot]="!board.connected()">
          {{ board.connected() ? "live" : "connecting…" }}
        </span>
      </div>
      <p class="muted">
        Questions ranked by how many people asked × shareholder weight. Deduplicated and cited via RAG in real time.
      </p>

      <!-- Real-Time Crowd Sentiment & Urgency Radar -->
      <section class="radar-card card" aria-label="Meeting Intelligence Radar">
        <div class="radar-top">
          <div class="radar-title-group">
            <span class="radar-badge">AI Meeting Intelligence</span>
            <h2 class="radar-title">Real-Time Sentiment &amp; Urgency Radar</h2>
          </div>
          <div class="radar-quick-actions">
            @if (demoMeeting.isDemoActive()) {
              <span class="demo-active-pill">🚀 Demo AGM Active</span>
            }
            <a routerLink="/voting" class="quick-btn">🗳️ Quorum &amp; Voting</a>
            <a routerLink="/reports" class="quick-btn">📜 Scrutineer Report</a>
          </div>
        </div>

        <div class="radar-stats-grid">
          <div class="radar-metric">
            <span class="metric-val">{{ totalQuestionsCount() }}</span>
            <span class="metric-lbl">Total Questions</span>
          </div>
          <div class="radar-metric">
            <span class="metric-val">{{ allTopicsCount() }}</span>
            <span class="metric-lbl">Consolidated Topics</span>
          </div>
          <div class="radar-metric highlight">
            <span class="metric-val">{{ noiseReduction() }}%</span>
            <span class="metric-lbl">Noise Deduplicated</span>
          </div>
          <div class="radar-metric sentiment-metric">
            <div class="sentiment-chips">
              <span class="sent-chip pos">🟢 {{ sentimentCounts().positive }} Constructive</span>
              <span class="sent-chip neu">🟡 {{ sentimentCounts().neutral }} Inquisitive</span>
              <span class="sent-chip crit">🔴 {{ sentimentCounts().critical }} Critical Alert</span>
            </div>
            <span class="metric-lbl">Real-Time Crowd Tone</span>
          </div>
        </div>

        <!-- Filter Bar -->
        <div class="radar-filters">
          <span class="filter-lbl">Filter:</span>
          <button type="button" class="filter-chip" [class.active]="filterMode() === 'ALL'" (click)="filterMode.set('ALL')">
            All Topics ({{ allTopicsCount() }})
          </button>
          <button type="button" class="filter-chip crit" [class.active]="filterMode() === 'CRITICAL'" (click)="filterMode.set('CRITICAL')">
            🔴 Critical Urgency ({{ sentimentCounts().critical }})
          </button>
          <button type="button" class="filter-chip" [class.active]="filterMode() === 'HOT'" (click)="filterMode.set('HOT')">
            🔥 High Volume (≥3 asked)
          </button>
        </div>
      </section>

      <!-- Live Stage Floor / Active Run of Show Cockpit -->
      @if (features.enabled("RUN_OF_SHOW")) {
        @if (stageFloorTopic(); as onStage) {
          <section class="card stage-floor-card" role="region" aria-label="Floor Topic On Stage">
            <div class="stage-header-row">
              <div class="stage-status-group">
                <span class="pulse-red-dot"></span>
                <span class="stage-kicker">Active On Stage (Floor Discussion)</span>
                <span class="stage-timer">⏱️ {{ minutes(stageSeconds()) }}</span>
              </div>
              <div class="stage-actions">
                @if (features.enabled("ATTENDEE_BOARD")) {
                  <button
                    type="button"
                    class="stage-pub-btn"
                    [class.published]="isPublished(onStage)"
                    (click)="togglePublished(onStage)"
                  >
                    {{ isPublished(onStage) ? '👁 Published to Attendee Room' : 'Publish Verified Answer to Room' }}
                  </button>
                }
                <button type="button" class="stage-advance-btn" (click)="endTopic(onStage)">
                  🏁 Finish &amp; Advance Topic
                </button>
              </div>
            </div>

            <h2 class="stage-question">{{ onStage.representative_question }}</h2>

            @if (onStage.draft) {
              <div class="stage-draft-box">
                <div class="stage-draft-lbl">✨ RAG-Grounded Executive Guidance</div>
                <p class="stage-draft-text">{{ onStage.draft }}</p>
                @if (onStage.citations && onStage.citations.length > 0) {
                  <div class="stage-cites">
                    <span class="stage-cites-lbl">Verified Citations:</span>
                    @for (cite of onStage.citations; track cite.source) {
                      <span class="stage-cite-pill">📄 {{ cite.source }}</span>
                    }
                  </div>
                }
              </div>
            }
          </section>
        } @else if (nextQueueTopic(); as next) {
          <section class="card next-topic-banner">
            <div class="next-banner-content">
              <span class="next-kicker">⏭️ Up Next in Run of Show</span>
              <span class="next-title">"{{ next.representative_question }}"</span>
            </div>
            <button type="button" class="next-start-btn" (click)="startTopic(next)">
              🎙️ Call to Floor (Start Topic)
            </button>
          </section>
        }
      }

      @if (error()) {
        <div
          class="card"
          style="border-color:var(--accent); color:var(--accent)"
        >
          {{ error() }}
        </div>
      }

      @if (effectiveBoard().length === 0) {
        <div class="card empty-board-card">
          <h3>No Live Questions Yet</h3>
          <p class="muted">
            The board is currently clear. Submit questions via the Attendee Terminal, or launch the interactive demo AGM to experience full semantic clustering and RAG answers.
          </p>
          <div class="empty-board-actions">
            <button type="button" class="launch-demo-btn" (click)="demoMeeting.launchDemoMeeting('/board')">
              🚀 Load Interactive Demo AGM
            </button>
            <a routerLink="/ask" class="ghost-btn">Open Attendee Terminal →</a>
          </div>
        </div>
      }

      @for (c of effectiveBoard(); track c.cluster_id) {
        <div class="card cluster-card" [class.critical-card]="c.sentimentData?.sentiment === 'critical' || c.sentimentData?.urgency === 'critical'">
          @if (c.sentimentData; as s) {
            <div class="topic-meta-row">
              <span class="category-tag">📂 {{ s.category }}</span>
              @if (s.sentiment === 'critical' || s.urgency === 'critical') {
                <span class="critical-alert-tag">⚠ Critical Governance Risk Flagged</span>
              } @else if (s.sentiment === 'positive') {
                <span class="positive-tag">🟢 Constructive</span>
              }
            </div>
          }
          <div class="q">{{ c.representative_question }}</div>
          <div class="row">
            <span class="badge" [class.hot]="c.size >= 3"
              >{{ c.size }} asked</span
            >
            <span class="muted">priority {{ c.priority_score }}</span>

            <!-- Where the answer stands. PENDING means the model is still working on it. -->
            @switch (c.draft_status) {
              @case ("PENDING") {
                <span class="badge">⏳ drafting…</span>
              }
              @case ("NEEDS_MANUAL") {
                <span class="badge hot">✍ needs your answer</span>
              }
              @case ("MANUAL") {
                <span class="badge"
                  >✍ answered{{ c.answered_by ? " by " + c.answered_by : "" }}</span
                >
              }
            }

            <!--
              Run of show. The timer and the start/finish pair are how a chair keeps to time; the
              position number is what the attendee board orders by.
            -->
            @if (features.enabled("RUN_OF_SHOW")) {
              @if (runState(c); as r) {
                @if (r.runOrder !== null) {
                  <span class="badge" title="Position in the running order">#{{ r.runOrder }}</span>
                }
                @if (r.underDiscussion) {
                  <span class="badge hot" role="status">on now</span>
                } @else if (r.secondsSpent !== null) {
                  <span class="muted-inline">took {{ minutes(r.secondsSpent) }}</span>
                }
              }
            }

            <span style="flex:1"></span>

            @if (features.enabled("ATTENDEE_BOARD")) {
              <!--
                Publishing is opt-in and stays that way: nearly every answer here was written by a
                model and read by nobody, and showing one to the room states it as the company's.
              -->
              <button
                class="ghost"
                [disabled]="roomBusy() === c.cluster_id || !c.draft"
                [attr.aria-pressed]="isPublished(c)"
                [title]="c.draft ? '' : 'There is no answer to publish yet'"
                (click)="togglePublished(c)"
              >
                {{ isPublished(c) ? "👁 Published to room" : "Publish to room" }}
              </button>
            }
            @if (features.enabled("RUN_OF_SHOW")) {
              @if (runState(c)?.underDiscussion) {
                <button class="ghost" (click)="endTopic(c)" [disabled]="roomBusy() === c.cluster_id">
                  Finish topic
                </button>
              } @else {
                <button class="ghost" (click)="startTopic(c)" [disabled]="roomBusy() === c.cluster_id">
                  Take this next
                </button>
              }
            }
            @if (features.enabled("CLUSTER_CURATION") && editing() !== c.cluster_id) {
              <button class="ghost" (click)="toggleCuration(c)">
                {{ curating() === c.cluster_id ? "▾" : "▸" }} Grouping
              </button>
            }
            @if (editing() !== c.cluster_id) {
              <button class="ghost" (click)="startWriting(c)">
                {{ c.draft ? "Edit answer" : "Write answer" }}
              </button>
            }
            <button
              (click)="draft(c)"
              [disabled]="drafting().has(c.cluster_id)"
            >
              {{
                drafting().has(c.cluster_id)
                  ? "Drafting…"
                  : c.draft_status === "NEEDS_MANUAL"
                    ? "Try model again"
                    : "Draft answer"
              }}
            </button>
          </div>

          <!--
            The model could not answer this one. Say why, so the moderator knows whether to wait
            for the service to come back or just write it.
          -->
          @if (c.draft_status === "NEEDS_MANUAL" && c.draft_error && editing() !== c.cluster_id) {
            <p class="muted note">
              The model could not draft this: {{ c.draft_error }}
            </p>
          }

          @if (editing() === c.cluster_id) {
            <textarea
              rows="5"
              class="answer-box"
              [value]="answerDraft()"
              (input)="answerDraft.set($any($event.target).value)"
              placeholder="Write the answer to read out…"
            ></textarea>
            <div class="row">
              <button (click)="saveAnswer(c)" [disabled]="!answerDraft().trim() || saving()">
                {{ saving() ? "Saving…" : "Save answer" }}
              </button>
              <button class="ghost" (click)="cancelWriting()">Cancel</button>
            </div>
          }

          <!--
            Curation. Open on demand rather than always visible: most clusters are grouped
            correctly, and putting a merge control on every card invites fiddling with groupings
            that were fine.
          -->
          @if (curating() === c.cluster_id) {
            <div class="curation">
              @if (curationLoading()) {
                <p class="muted note">Loading the questions in this group…</p>
              } @else {
                <p class="muted note">
                  These are the questions grouped together here. Tick any that do not belong and
                  separate them out, or fold this whole group into another one.
                </p>

                <fieldset class="q-list">
                  <legend class="sr-only">Questions in this group</legend>
                  @for (q of curationQuestions(); track q.id) {
                    <label class="q-row">
                      <input
                        type="checkbox"
                        [checked]="selected().has(q.id)"
                        (change)="toggleSelected(q.id)"
                      />
                      <span>{{ q.text }}</span>
                    </label>
                  }
                </fieldset>

                @if (curationMerged().length) {
                  <p class="muted note">
                    Already folded in:
                    @for (m of curationMerged(); track m.clusterId) {
                      <em>“{{ m.question }}”</em>
                      @if (m.mergedBy) { (by {{ m.mergedBy }}) }
                    }
                  </p>
                }

                <div class="row curation-actions">
                  <button
                    class="ghost"
                    (click)="split(c)"
                    [disabled]="!selected().size || curationBusy()"
                  >
                    Separate {{ selected().size || "" }} out
                  </button>

                  <label class="merge-into">
                    <span class="sr-only">Fold this group into</span>
                    <select
                      [value]="mergeTarget()"
                      (change)="mergeTarget.set($any($event.target).value)"
                    >
                      <option value="">Fold this group into…</option>
                      @for (other of otherClusters(c); track other.cluster_id) {
                        <option [value]="other.cluster_id">
                          {{ other.representative_question }}
                        </option>
                      }
                    </select>
                  </label>
                  <button (click)="merge(c)" [disabled]="!mergeTarget() || curationBusy()">
                    Fold in
                  </button>
                </div>

                <p class="muted note">
                  Folding also applies to questions nobody has asked yet — later ones that would
                  have landed here go to the other group instead. Separating out only moves the
                  questions above; similar ones asked later will be grouped as normal.
                </p>
              }
            </div>
          }

          @if (c.draft && editing() !== c.cluster_id) {
            <div class="draft">{{ c.draft }}</div>
            @if (c.citations.length) {
              <div class="cite">
                <strong>Sources</strong> — a report page, or the moment it was
                said on the call:
                <ul style="margin:6px 0 0; padding-left:18px">
                  @for (cit of c.citations; track cit.source) {
                    <li>
                      @if (target(cit); as t) {
                        @if (t.internal) {
                          <!-- In-app route: routerLink, so it does not reload the SPA. -->
                          <a [routerLink]="['/recordings']" [queryParams]="recordingParams(cit)" [title]="cit.snippet">
                            ▶ {{ cit.source }}
                          </a>
                        } @else {
                          <a [href]="t.url" target="_blank" rel="noopener" [title]="cit.snippet">
                            {{ cit.source }}
                          </a>
                        }
                      }
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
  styles: [
    `
      .answer-box {
        width: 100%;
        margin: 10px 0 8px;
        padding: 10px;
        border-radius: 8px;
        border: 1px solid #334155;
        background: #0b1220;
        color: inherit;
        font: inherit;
        resize: vertical;
      }
      .note {
        margin: 8px 0 0;
        font-size: 13px;
      }

      /* Screen-reader-only: the fieldset needs a name, but the paragraph above it already says
         the same thing to anyone who can see it. */
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
      }

      .curation {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px dashed #334155;
      }
      .q-list {
        border: 0;
        margin: 8px 0;
        padding: 0;
      }
      .q-row {
        display: flex;
        gap: 9px;
        align-items: flex-start;
        padding: 6px 0;
        cursor: pointer;
        font-size: 14px;
      }
      .q-row + .q-row {
        border-top: 1px solid rgba(128, 128, 128, 0.15);
      }
      .q-row input {
        margin-top: 3px;
        flex: 0 0 auto;
      }
      .curation-actions {
        gap: 10px;
        flex-wrap: wrap;
      }
      .merge-into select {
        max-width: 320px;
      }

      /* Sentiment Radar & Urgency Styles */
      .radar-card {
        padding: 24px;
        margin-bottom: 24px;
        background: linear-gradient(180deg, rgba(56, 189, 248, 0.06) 0%, var(--surface) 100%);
        border: 1px solid rgba(56, 189, 248, 0.3);
        border-radius: 14px;
      }
      .radar-top {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        flex-wrap: wrap;
        gap: 16px;
        margin-bottom: 20px;
      }
      .radar-badge {
        display: inline-block;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--accent);
        margin-bottom: 4px;
      }
      .radar-title {
        margin: 0;
        font-size: 20px;
        font-weight: 800;
      }
      .radar-quick-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .demo-active-pill {
        background: rgba(16, 185, 129, 0.15);
        border: 1px solid #10b981;
        color: #10b981;
        font-size: 12px;
        font-weight: 700;
        padding: 4px 10px;
        border-radius: 999px;
      }
      .quick-btn {
        padding: 6px 14px;
        border-radius: 8px;
        background: var(--surface-hover);
        border: 1px solid var(--border);
        color: var(--text);
        text-decoration: none;
        font-size: 13px;
        font-weight: 600;
        transition: all 0.15s;
      }
      .quick-btn:hover {
        border-color: var(--accent);
        color: var(--accent);
      }
      .radar-stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 14px;
        margin-bottom: 20px;
      }
      .radar-metric {
        background: rgba(0, 0, 0, 0.25);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .radar-metric.highlight {
        border-color: #10b981;
        background: rgba(16, 185, 129, 0.08);
      }
      .radar-metric.highlight .metric-val {
        color: #10b981;
      }
      .metric-val {
        font-size: 22px;
        font-weight: 800;
      }
      .metric-lbl {
        font-size: 11px;
        color: var(--muted);
        text-transform: uppercase;
        font-weight: 600;
      }
      .sentiment-metric {
        grid-column: span 2;
      }
      @media (max-width: 640px) {
        .sentiment-metric {
          grid-column: span 1;
        }
      }
      .sentiment-chips {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .sent-chip {
        font-size: 11px;
        font-weight: 700;
        padding: 2px 8px;
        border-radius: 999px;
      }
      .sent-chip.pos {
        background: rgba(16, 185, 129, 0.15);
        color: #10b981;
      }
      .sent-chip.neu {
        background: rgba(245, 158, 11, 0.15);
        color: #f59e0b;
      }
      .sent-chip.crit {
        background: rgba(239, 68, 68, 0.15);
        color: #ef4444;
      }
      .radar-filters {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        padding-top: 14px;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
      }
      .filter-lbl {
        font-size: 12px;
        font-weight: 600;
        color: var(--muted);
      }
      .filter-chip {
        padding: 5px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        border: 1px solid var(--border);
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        transition: all 0.15s;
      }
      .filter-chip.active {
        background: var(--surface-hover);
        color: var(--text);
        border-color: var(--accent);
      }
      .filter-chip.crit.active {
        border-color: #ef4444;
        color: #ef4444;
      }
      /* Topic Card Badges */
      .cluster-card.critical-card {
        border-left: 4px solid #ef4444;
      }
      .topic-meta-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        flex-wrap: wrap;
      }
      .category-tag {
        font-size: 11px;
        font-weight: 700;
        color: #818cf8;
        background: rgba(129, 140, 248, 0.12);
        padding: 2px 8px;
        border-radius: 4px;
      }
      .critical-alert-tag {
        font-size: 11px;
        font-weight: 700;
        color: #ef4444;
        background: rgba(239, 68, 68, 0.15);
        border: 1px solid rgba(239, 68, 68, 0.35);
        padding: 2px 8px;
        border-radius: 4px;
      }
      .positive-tag {
        font-size: 11px;
        font-weight: 700;
        color: #10b981;
        background: rgba(16, 185, 129, 0.12);
        padding: 2px 8px;
        border-radius: 4px;
      }
      /* Empty State */
      .empty-board-card {
        text-align: center;
        padding: 36px 24px;
      }
      .empty-board-card h3 {
        margin: 0 0 8px;
      }
      .empty-board-actions {
        display: flex;
        justify-content: center;
        gap: 12px;
        margin-top: 20px;
        flex-wrap: wrap;
      }
      .launch-demo-btn {
        padding: 12px 20px;
        background: var(--accent);
        border: none;
        border-radius: 8px;
        color: #0b0f19;
        font-weight: 700;
        cursor: pointer;
      }
      .ghost-btn {
        padding: 12px 18px;
        background: none;
        border: 1px solid var(--border);
        border-radius: 8px;
        color: var(--text);
        text-decoration: none;
        font-weight: 600;
      }

      /* ---- Live Stage Floor Cockpit ---- */
      .stage-floor-card {
        background: linear-gradient(135deg, rgba(239, 68, 68, 0.08), rgba(245, 158, 11, 0.04));
        border: 2px solid rgba(239, 68, 68, 0.4);
        box-shadow: 0 8px 32px rgba(239, 68, 68, 0.12);
        margin-bottom: 24px;
        border-radius: 14px;
      }
      .stage-header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }
      .stage-status-group {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .pulse-red-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #ef4444;
        animation: pulseRed 1.2s ease-in-out infinite;
      }
      @keyframes pulseRed {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.3; transform: scale(1.3); }
      }
      .stage-kicker {
        font-size: 12px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #ef4444;
      }
      .stage-timer {
        font-size: 13px;
        font-weight: 700;
        background: rgba(0, 0, 0, 0.3);
        padding: 3px 8px;
        border-radius: 6px;
        color: #f59e0b;
      }
      .stage-actions {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .stage-pub-btn {
        background: rgba(99, 102, 241, 0.15);
        border: 1px solid #6366f1;
        color: #e0e7ff;
        border-radius: 8px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .stage-pub-btn.published {
        background: rgba(16, 185, 129, 0.2);
        border-color: #10b981;
        color: #10b981;
      }
      .stage-advance-btn {
        background: #ef4444;
        color: #fff;
        border: none;
        border-radius: 8px;
        padding: 6px 14px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }
      .stage-advance-btn:hover {
        background: #dc2626;
      }
      .stage-question {
        margin: 0 0 14px;
        font-size: 19px;
        font-weight: 700;
        line-height: 1.4;
      }
      .stage-draft-box {
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 14px;
      }
      .stage-draft-lbl {
        font-size: 11px;
        font-weight: 700;
        color: #a78bfa;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 6px;
      }
      .stage-draft-text {
        font-size: 14px;
        line-height: 1.6;
        margin: 0 0 10px;
        color: var(--text);
      }
      .stage-cites {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }
      .stage-cites-lbl {
        font-size: 11px;
        color: var(--muted);
      }
      .stage-cite-pill {
        font-size: 11px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid var(--border);
        padding: 2px 8px;
        border-radius: 4px;
        color: #67e8f9;
      }
      .next-topic-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
        padding: 14px 18px;
        background: rgba(245, 158, 11, 0.06);
        border: 1px solid rgba(245, 158, 11, 0.3);
        border-radius: 12px;
        margin-bottom: 24px;
      }
      .next-banner-content {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .next-kicker {
        font-size: 11px;
        font-weight: 700;
        color: #f59e0b;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .next-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--text);
      }
      .next-start-btn {
        background: #f59e0b;
        color: #000;
        font-weight: 700;
        border: none;
        border-radius: 8px;
        padding: 8px 16px;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .next-start-btn:hover {
        background: #d97706;
      }
    `,
  ],
})
export class ModeratorComponent implements OnInit, OnDestroy {
  protected readonly demoMeeting = inject(DemoMeetingService);
  readonly filterMode = signal<'ALL' | 'CRITICAL' | 'HOT'>('ALL');

  readonly stageSeconds = signal(0);
  private stageTimer: ReturnType<typeof setInterval> | null = null;

  readonly stageFloorTopic = computed(() =>
    this.effectiveBoard().find((c) => this.runState(c)?.underDiscussion),
  );

  readonly nextQueueTopic = computed(() =>
    this.effectiveBoard().find(
      (c) =>
        !this.runState(c)?.underDiscussion &&
        (this.runState(c)?.secondsSpent === null || this.runState(c)?.secondsSpent === undefined),
    ),
  );

  /** Effective board: live clusters if present, or demo clusters if demo is active or board is empty */
  readonly effectiveBoard = computed(() => {
    const live = this.board.board();
    const source: EnrichedClusterView[] = live.length > 0
      ? live.map(c => this.enrichCluster(c))
      : (this.demoMeeting.isDemoActive() ? this.demoMeeting.demoClusters : []);

    const filter = this.filterMode();
    if (filter === 'CRITICAL') {
      return source.filter(c => c.sentimentData?.sentiment === 'critical' || c.sentimentData?.urgency === 'critical');
    }
    if (filter === 'HOT') {
      return source.filter(c => c.size >= 3);
    }
    return source;
  });

  enrichCluster(c: ClusterView): EnrichedClusterView {
    const enriched = c as EnrichedClusterView;
    if (enriched.sentimentData) return enriched;

    const text = (c.representative_question || '').toLowerCase();
    let category: 'Capital Allocation' | 'AI Strategy' | 'Executive Governance' | 'ESG & Climate' | 'Operations' = 'Operations';
    let sentiment: 'positive' | 'neutral' | 'critical' = 'neutral';
    let urgency: 'routine' | 'elevated' | 'critical' = 'routine';

    if (text.includes('dividend') || text.includes('payout') || text.includes('capital') || text.includes('buyback')) {
      category = 'Capital Allocation';
      sentiment = 'positive';
    } else if (text.includes('ai') || text.includes('cloud') || text.includes('capex') || text.includes('tech')) {
      category = 'AI Strategy';
      sentiment = 'neutral';
    } else if (text.includes('compensation') || text.includes('salary') || text.includes('dilution') || text.includes('bonus') || text.includes('legal')) {
      category = 'Executive Governance';
      sentiment = 'critical';
      urgency = 'critical';
    } else if (text.includes('esg') || text.includes('carbon') || text.includes('emission') || text.includes('climate') || text.includes('green')) {
      category = 'ESG & Climate';
      sentiment = 'positive';
    }

    enriched.sentimentData = { category, sentiment, urgency, confidence: 0.92 };
    return enriched;
  }

  readonly allTopicsCount = computed(() => {
    const live = this.board.board();
    return live.length > 0 ? live.length : (this.demoMeeting.isDemoActive() ? this.demoMeeting.demoClusters.length : 0);
  });

  readonly totalQuestionsCount = computed(() => {
    const items = this.board.board().length > 0 ? this.board.board() : (this.demoMeeting.isDemoActive() ? this.demoMeeting.demoClusters : []);
    return items.reduce((acc, c) => acc + c.size, 0);
  });

  readonly noiseReduction = computed(() => {
    const total = this.totalQuestionsCount();
    const topics = this.allTopicsCount();
    if (total <= 1) return 0;
    return Math.round(((total - topics) / total) * 100);
  });

  readonly sentimentCounts = computed(() => {
    const items = (this.board.board().length > 0 ? this.board.board() : (this.demoMeeting.isDemoActive() ? this.demoMeeting.demoClusters : []))
      .map(c => this.enrichCluster(c));
    return {
      positive: items.filter(c => c.sentimentData?.sentiment === 'positive').length,
      neutral: items.filter(c => c.sentimentData?.sentiment === 'neutral').length,
      critical: items.filter(c => c.sentimentData?.sentiment === 'critical').length,
    };
  });

  readonly drafting = signal<Set<string>>(new Set());
  readonly error = signal<string | null>(null);
  private pollHandle?: ReturnType<typeof setInterval>;
  private destroyed = false;

  // ---- writing an answer by hand -------------------------------------------
  //
  // The fallback for a cluster the model could not answer. Also available for any cluster, since a
  // moderator reading a draft aloud may simply want to reword it.

  /** Cluster id whose answer box is open, or null. */
  readonly editing = signal<string | null>(null);
  readonly answerDraft = signal('');
  readonly saving = signal(false);

  /** Open the box, pre-filled with whatever answer already exists so an edit starts from it. */
  startWriting(c: ClusterView): void {
    this.editing.set(c.cluster_id);
    this.answerDraft.set(c.draft ?? '');
  }

  cancelWriting(): void {
    this.editing.set(null);
    this.answerDraft.set('');
  }

  saveAnswer(c: ClusterView): void {
    const answer = this.answerDraft().trim();
    if (!answer) return;
    this.saving.set(true);
    this.api.saveAnswer(c.cluster_id, answer).subscribe({
      next: (updated) => {
        this.saving.set(false);
        this.cancelWriting();
        // Patch the row in place rather than re-fetching: the board is ranked by the AI service and
        // a full reload could reorder the card the moderator is looking at.
        this.board.board.update((list) =>
          list.map((row) => (row.cluster_id === updated.cluster_id ? { ...row, ...updated } : row)),
        );
      },
      error: () => {
        this.saving.set(false);
        this.error.set('Could not save that answer. Try again in a moment.');
      },
    });
  }

  // ---- curation: fixing the grouping ----------------------------------------
  //
  // Grouping is done automatically by meaning, and automatic grouping is wrong in both directions —
  // it splits one topic phrased two ways, and lumps two topics that share vocabulary. Until this
  // existed a moderator could see that and do nothing about it.

  /** Cluster id whose grouping panel is open, or null. */
  readonly curating = signal<string | null>(null);
  readonly curationLoading = signal(false);
  readonly curationBusy = signal(false);
  readonly curationQuestions = signal<QuestionInCluster[]>([]);
  readonly curationMerged = signal<MergedAway[]>([]);
  /** Question ids ticked for separating out. */
  readonly selected = signal<Set<string>>(new Set());
  readonly mergeTarget = signal('');

  toggleCuration(c: ClusterView): void {
    if (this.curating() === c.cluster_id) {
      this.closeCuration();
      return;
    }
    this.curating.set(c.cluster_id);
    this.selected.set(new Set());
    this.mergeTarget.set('');
    this.curationQuestions.set([]);
    this.curationMerged.set([]);
    this.curationLoading.set(true);

    this.api.clusterQuestions(c.cluster_id).subscribe({
      next: (view) => {
        this.curationQuestions.set(view.questions);
        this.curationMerged.set(view.mergedIn);
        this.curationLoading.set(false);
      },
      error: () => {
        this.curationLoading.set(false);
        this.error.set('Could not load the questions in that group.');
        this.closeCuration();
      },
    });
  }

  private closeCuration(): void {
    this.curating.set(null);
    this.curationQuestions.set([]);
    this.curationMerged.set([]);
    this.selected.set(new Set());
    this.mergeTarget.set('');
  }

  toggleSelected(questionId: string): void {
    // A new Set each time: signals compare by reference, and mutating in place would not notify.
    this.selected.update((current) => {
      const next = new Set(current);
      if (!next.delete(questionId)) next.add(questionId);
      return next;
    });
  }

  /** Everything except this cluster — the candidates to fold it into. */
  otherClusters(c: ClusterView): ClusterView[] {
    return this.board.board().filter((row) => row.cluster_id !== c.cluster_id);
  }

  split(c: ClusterView): void {
    const ids = [...this.selected()];
    if (!ids.length) return;
    this.curationBusy.set(true);
    this.error.set(null);
    this.api.splitCluster(c.cluster_id, ids).subscribe({
      next: (rebuilt) => {
        this.curationBusy.set(false);
        this.board.board.set(rebuilt);
        this.closeCuration();
      },
      error: (err) => {
        this.curationBusy.set(false);
        // The server's message is the specific one — "that would move every question out" — and it
        // tells the moderator what to do differently.
        this.error.set(err?.error?.message ?? 'Could not separate those questions out.');
      },
    });
  }

  merge(c: ClusterView): void {
    const target = this.mergeTarget();
    if (!target) return;
    this.curationBusy.set(true);
    this.error.set(null);
    this.api.mergeClusters(c.cluster_id, target).subscribe({
      next: (rebuilt) => {
        this.curationBusy.set(false);
        this.board.board.set(rebuilt);
        this.closeCuration();
      },
      error: (err) => {
        this.curationBusy.set(false);
        this.error.set(err?.error?.message ?? 'Could not fold those groups together.');
      },
    });
  }

  // ---- run of show, and releasing an answer to the room ---------------------
  //
  // The board itself is the AI service's ranking. This is the layer over it: which topic is being
  // taken now, how long each took, and which answers the room may see.

  /**
   * Run-of-show state per cluster, from a separate endpoint.
   *
   * <p>Kept beside the board rather than folded into it: the board's shape is the AI service's, and
   * widening it to carry meeting-running state would tie two things together that fail
   * independently — the run of show should still work when the clusterer is asleep.
   */
  readonly roomTopics = signal<Map<string, TopicView>>(new Map());
  /** Cluster id currently being changed, so only that card's buttons disable. */
  readonly roomBusy = signal<string | null>(null);

  runState(c: ClusterView): TopicView | undefined {
    return this.roomTopics().get(c.cluster_id);
  }

  /**
   * Whether the room can see this answer.
   *
   * <p>Read from the server's flag, not from whether an answer exists. This view returns every
   * answer including unpublished drafts, so inferring it would mark everything as published — and
   * a moderator trusting that button would believe the room had seen answers it never did.
   */
  isPublished(c: ClusterView): boolean {
    return this.runState(c)?.published === true;
  }

  /** "4m 12s" — seconds alone are hard to read at a glance while chairing. */
  minutes(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m ? `${m}m ${s}s` : `${s}s`;
  }

  private loadRoom(): void {
    if (!this.features.enabled('RUN_OF_SHOW') && !this.features.enabled('ATTENDEE_BOARD')) return;
    this.room.runOfShow().subscribe({
      next: (topics) => this.applyRoom(topics),
      // Silent: this is an overlay on a board that is useful without it.
      error: () => {},
    });
  }

  private applyRoom(topics: TopicView[]): void {
    this.roomTopics.set(new Map(topics.map((t) => [t.clusterId, t])));
  }

  startTopic(c: ClusterView): void {
    this.stageSeconds.set(0);

    if (c.cluster_id.startsWith('cl-apex') || this.demoMeeting.isDemoActive()) {
      const current = new Map(this.roomTopics());
      for (const [id, topic] of current.entries()) {
        if (topic.underDiscussion) {
          current.set(id, { ...topic, underDiscussion: false });
        }
      }
      const existing: TopicView = current.get(c.cluster_id) ?? {
        clusterId: c.cluster_id,
        question: c.representative_question,
        asked: c.size,
        supported: 15,
        supportedByMe: false,
        underDiscussion: false,
        answer: c.draft,
        answered: !!c.draft,
        published: false,
        runOrder: 1,
        startedAt: null,
        secondsSpent: null,
      };
      current.set(c.cluster_id, {
        ...existing,
        underDiscussion: true,
        runOrder: 1,
        startedAt: new Date().toISOString(),
      });
      this.roomTopics.set(current);
      return;
    }

    this.roomBusy.set(c.cluster_id);
    this.room.startTopic(c.cluster_id).subscribe({
      next: (topics) => {
        this.roomBusy.set(null);
        this.applyRoom(topics);
      },
      error: (err) => {
        this.roomBusy.set(null);
        this.error.set(err?.error?.message ?? 'Could not start that topic.');
      },
    });
  }

  endTopic(c: ClusterView): void {
    if (c.cluster_id.startsWith('cl-apex') || this.demoMeeting.isDemoActive()) {
      const current = new Map(this.roomTopics());
      const existing = current.get(c.cluster_id);
      if (existing) {
        current.set(c.cluster_id, {
          ...existing,
          underDiscussion: false,
          secondsSpent: this.stageSeconds() || 120,
        });
      }
      this.roomTopics.set(current);
      return;
    }

    this.roomBusy.set(c.cluster_id);
    this.room.endTopic(c.cluster_id).subscribe({
      next: (topics) => {
        this.roomBusy.set(null);
        this.applyRoom(topics);
      },
      error: (err) => {
        this.roomBusy.set(null);
        this.error.set(err?.error?.message ?? 'Could not finish that topic.');
      },
    });
  }

  togglePublished(c: ClusterView): void {
    const next = !this.isPublished(c);

    if (c.cluster_id.startsWith('cl-apex') || this.demoMeeting.isDemoActive()) {
      const current = new Map(this.roomTopics());
      const existing = current.get(c.cluster_id);
      if (existing) {
        current.set(c.cluster_id, { ...existing, published: next });
      } else {
        current.set(c.cluster_id, {
          clusterId: c.cluster_id,
          question: c.representative_question,
          asked: c.size,
          supported: 15,
          supportedByMe: false,
          underDiscussion: false,
          published: next,
          answer: c.draft,
          answered: !!c.draft,
          runOrder: null,
          startedAt: null,
          secondsSpent: null,
        });
      }
      this.roomTopics.set(current);
      return;
    }

    this.roomBusy.set(c.cluster_id);
    this.room.publishAnswer(c.cluster_id, next).subscribe({
      next: () => {
        this.roomBusy.set(null);
        this.loadRoom();
      },
      error: (err) => {
        this.roomBusy.set(null);
        this.error.set(err?.error?.message ?? 'Could not change what the room can see.');
      },
    });
  }

  constructor(
    private api: ApiService,
    protected board: BoardService,
    protected features: FeatureService,
    private room: RoomService,
  ) {}

  ngOnInit(): void {
    // Token is already set by AuthService — the route guard ensures a logged-in moderator.
    this.loadSnapshot(); // initial snapshot
    this.loadRoom();     // the run-of-show layer over it
    this.board.connect(); // then live pushes over STOMP

    // Stage floor live elapsed timer
    this.stageTimer = setInterval(() => {
      if (this.stageFloorTopic()) {
        this.stageSeconds.update((s) => s + 1);
      }
    }, 1000);

    // Fallback poll: live WebSocket pushes can drop (esp. behind free-tier proxies), and a
    // just-asked question needs a moment to cluster. Re-fetch every 45s so new questions
    // appear on the board without a manual page refresh.
    this.pollHandle = setInterval(() => {
      if (this.destroyed) return;
      this.loadSnapshot();
      // Refreshed alongside, so a topic another moderator started shows as running here too.
      this.loadRoom();
    }, 45000);
  }

  /** Pull the current ranked board via REST; used for the initial load and the fallback poll. */
  private loadSnapshot(): void {
    if (this.destroyed) return;
    this.error.set(null);
    this.api.getBoard().subscribe({
      next: (b) => {
        this.board.board.set(b);
        this.error.set(null);
      },
      error: (err) => {
        // A 403 is a permissions answer, not a transient one. Calling it "temporarily unavailable"
        // invites the user to retry something that will fail identically every time, and hides the
        // one fact that would help them: this account cannot load the board.
        const message =
          err?.status === 403
            ? "Your account does not have moderator access to the board. Sign in again, or ask an administrator to restore the role."
            : "We could not load the board right now.";
        this.error.set(message);
      },
    });
  }

  /** Build the page-anchored PDF link for a citation source string. */
  link(source: string) {
    return parseCitation(source);
  }

  /** Where this citation leads — a report page, or a moment in a recording. */
  target(citation: Citation): CitationTarget {
    return citationTarget(citation);
  }

  /** Query params for a recording citation, so routerLink can deep-link into the player. */
  recordingParams(citation: Citation): Record<string, string> {
    const at = Math.max(0, Math.floor(citation.at_seconds ?? 0));
    return at > 0
      ? { v: citation.video_id!, t: String(at) }
      : { v: citation.video_id! };
  }

  /**
   * Ask the model for an answer now.
   *
   * <p>A failure here used to be swallowed: the button stopped saying "Drafting…" and nothing else
   * happened. That is the worst of the options — a moderator mid-meeting cannot tell whether the
   * model is thinking, has finished, or never started, so they press it again.
   *
   * <p>A cold start is called by its name. The AI service sleeps when idle, and 502/503/504 (or a
   * status of 0, which is what a dropped connection looks like from the browser) means it is waking
   * rather than broken — the difference between "wait a moment" and "something is wrong", and the
   * one the person running a meeting actually needs.
   */
  draft(c: ClusterView): void {
    this.mutateDrafting((s) => s.add(c.cluster_id));
    this.error.set(null);
    this.api.requestDraft(c.cluster_id, c.representative_question).subscribe({
      next: () => this.mutateDrafting((s) => s.delete(c.cluster_id)),
      error: (err) => {
        this.mutateDrafting((s) => s.delete(c.cluster_id));
        const waking = err?.status === 0 || err?.status >= 502;
        this.error.set(
          waking
            ? 'The AI service is waking up — it sleeps when idle and takes up to a minute. ' +
              'Try again shortly, or write the answer yourself in the meantime.'
            : (err?.error?.message ??
              'Could not draft that answer. You can write it by hand instead.'),
        );
      },
    });
  }

  /** Signals need a new reference to notify; clone the Set on each change. */
  private mutateDrafting(fn: (s: Set<string>) => void): void {
    const next = new Set(this.drafting());
    fn(next);
    this.drafting.set(next);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = undefined;
    }
    if (this.stageTimer) {
      clearInterval(this.stageTimer);
      this.stageTimer = null;
    }
    this.board.disconnect();
  }
}
