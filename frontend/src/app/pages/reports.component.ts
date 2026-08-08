import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { MeetingService, MeetingView } from '../services/meeting.service';
import { MeetingReport, ReportService } from '../services/report.service';

/**
 * What happened at a meeting, in the order a minute would set it out.
 *
 * <h2>What this is for</h2>
 * A meeting produces a record whether or not the software helps: what was decided, what was asked,
 * what was left hanging. Everything needed is already stored, so someone reconstructing it
 * afterwards from the board and a notepad was doing work the application was creating for them.
 *
 * <h2>Two things shown that a tidier report would hide</h2>
 * <b>Unanswered questions get their own section</b>, near the top rather than buried at the end.
 * They are the part people actually need after a meeting, and the part most easily lost.
 *
 * <p><b>Coverage gaps are stated.</b> Questions asked before the application recorded which meeting
 * they belonged to are counted separately and disclosed. A report that quietly omitted them would
 * be a report you could not trust the totals of.
 */
@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [DecimalPipe, DatePipe],
  template: `
    <div class="container report-page">
      <header class="page-head">
        <h1>Meeting report</h1>
        <p class="muted sub">
          Decisions taken, questions answered, and anything left unanswered.
        </p>
      </header>

      <div class="card picker">
        <label class="field">
          <span class="label">Meeting</span>
          <select [value]="selectedId()" (change)="select($any($event.target).value)">
            <option value="">Choose a meeting…</option>
            @for (m of meetings(); track m.id) {
              <option [value]="m.id">{{ m.title }} ({{ m.status }})</option>
            }
          </select>
        </label>
        @if (report()) {
          <button (click)="download()" [disabled]="downloading()">
            {{ downloading() ? 'Preparing…' : 'Download minutes (.md)' }}
          </button>
        }
      </div>

      @if (error()) {
        <div class="error-box" role="alert">{{ error() }}</div>
      }
      @if (loading()) {
        <div class="card"><span class="muted">Building the report…</span></div>
      }

      @if (report(); as r) {
        <!-- Quorum first, and loudly if it was not met: every decision below depends on it. -->
        <section class="card summary" [class.warn]="!r.quorum.met">
          <h2 class="section-title">{{ r.title }}</h2>
          <p class="muted small">
            {{ r.status }}
            @if (r.activatedAt) { · opened {{ r.activatedAt | date: 'medium' }} }
            @if (r.closedAt) { · closed {{ r.closedAt | date: 'medium' }} }
          </p>

          <div class="stats">
            <div class="stat">
              <b class="num">{{ r.memberCount }}</b>
              <span class="muted small">members</span>
            </div>
            <div class="stat">
              <b class="num">{{ r.totalVotingWeight }}</b>
              <span class="muted small">votes on the register</span>
            </div>
            <div class="stat">
              <b class="num">{{ r.questionsAsked }}</b>
              <span class="muted small">questions asked</span>
            </div>
            <div class="stat">
              <b class="num">{{ r.resolutions.length }}</b>
              <span class="muted small">resolutions</span>
            </div>
          </div>

          <p class="quorum-line" [class.met]="r.quorum.met">
            <strong>{{ r.quorum.met ? 'Quorum met' : 'Quorum NOT met' }}</strong> —
            {{ r.quorum.representedWeight }} of {{ r.quorum.totalWeight }} votes represented
            ({{ r.quorum.representedPercent | number: '1.0-1' }}%, threshold
            {{ r.quorum.thresholdPercent | number: '1.0-1' }}%).
          </p>
          @if (!r.quorum.met) {
            <p class="warn-note">
              Business transacted at this meeting may not be valid. Anything below should be read
              with that in mind.
            </p>
          }
        </section>

        <!--
          Unanswered before answered. This is the section somebody opens the report for; putting it
          after a long list of things that went fine would bury it.
        -->
        @if (r.unansweredTopics.length) {
          <section class="card unanswered">
            <h2 class="section-title">Left unanswered ({{ r.unansweredTopics.length }})</h2>
            <p class="muted small">Raised but not answered. Most-asked first.</p>
            <ul class="topics">
              @for (t of r.unansweredTopics; track t.clusterId) {
                <li>
                  <strong>{{ t.question }}</strong>
                  <span class="muted small">
                    — asked by {{ t.askedHere }}
                    {{ t.askedHere === 1 ? 'person' : 'people' }}
                  </span>
                </li>
              }
            </ul>
          </section>
        }

        <section class="card">
          <h2 class="section-title">Resolutions</h2>
          @if (!r.resolutions.length) {
            <p class="muted small">No resolutions were put to this meeting.</p>
          }
          @for (o of r.resolutions; track o.id) {
            <article class="resolution">
              <div class="row">
                <strong>{{ o.seq }}. {{ o.title }}</strong>
                <span class="badge quiet">
                  {{ o.type === 'SPECIAL' ? 'Special' : 'Ordinary' }} —
                  needs {{ o.requiredMajorityPercent | number: '1.0-0' }}%
                </span>
                <span style="flex:1"></span>
                @if (o.status === 'CLOSED') {
                  <span class="verdict" [class.carried]="o.carried">
                    {{ o.carried ? 'Carried' : 'Not carried' }}
                  </span>
                } @else {
                  <span class="muted-inline">
                    {{ o.status === 'OPEN' ? 'Still open' : 'Not yet put' }}
                  </span>
                }
              </div>
              @if (o.text) {
                <p class="text">{{ o.text }}</p>
              }
              <p class="muted small">
                For <b class="num">{{ o.forWeight }}</b> ({{ o.forCount }} members) ·
                Against <b class="num">{{ o.againstWeight }}</b> ({{ o.againstCount }}) ·
                Abstained <b class="num">{{ o.abstainWeight }}</b> ({{ o.abstainCount }}) ·
                {{ o.forPercent | number: '1.0-1' }}% in favour of votes cast
              </p>
            </article>
          }
        </section>

        <section class="card">
          <h2 class="section-title">Questions answered ({{ r.answeredTopics.length }})</h2>
          @if (!r.answeredTopics.length) {
            <p class="muted small">None recorded.</p>
          }
          @for (t of r.answeredTopics; track t.clusterId) {
            <article class="topic">
              <strong>{{ t.question }}</strong>
              <p class="muted small">
                Asked by {{ t.askedHere }} {{ t.askedHere === 1 ? 'person' : 'people' }}
                @if (t.answeredBy) { · answered by {{ t.answeredBy }} }
              </p>
              <p class="answer">{{ t.answer }}</p>
            </article>
          }
        </section>

        <p class="muted small footnote">
          {{ r.questionsAsked }} questions recorded for this meeting.
          @if (r.questionsNotAttributedToAnyMeeting > 0) {
            A further {{ r.questionsNotAttributedToAnyMeeting }} in the system predate per-meeting
            recording and are counted here against no meeting at all.
          }
          Generated {{ r.generatedAt | date: 'medium' }}.
        </p>
      }
    </div>
  `,
  styles: [
    `
      .report-page {
        --for: #2e9e5b;
        --against: #d1495b;
      }
      .page-head h1 {
        margin-bottom: 4px;
      }
      .sub {
        margin: 0;
      }
      .picker {
        display: flex;
        gap: 14px;
        align-items: flex-end;
        flex-wrap: wrap;
      }
      .field {
        display: block;
      }
      .label {
        display: block;
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 5px;
      }
      .section-title {
        margin: 0 0 8px;
        font-size: 16px;
      }
      .stats {
        display: flex;
        flex-wrap: wrap;
        gap: 26px;
        margin: 12px 0;
      }
      .stat {
        display: flex;
        flex-direction: column;
      }
      .stat b {
        font-size: 22px;
      }
      .num {
        font-variant-numeric: tabular-nums;
      }
      .quorum-line {
        margin: 6px 0 0;
        color: var(--against);
      }
      .quorum-line.met {
        color: var(--for);
      }
      .summary.warn {
        border-left: 4px solid var(--against);
      }
      .warn-note {
        margin: 6px 0 0;
        font-weight: 600;
        color: var(--against);
      }
      .unanswered {
        border-left: 4px solid #e0a800;
      }
      .topics {
        margin: 8px 0 0;
        padding-left: 20px;
      }
      .topics li {
        margin-bottom: 7px;
      }
      .resolution,
      .topic {
        padding: 12px 0;
        border-top: 1px solid rgba(128, 128, 128, 0.2);
      }
      .resolution:first-of-type,
      .topic:first-of-type {
        border-top: 0;
      }
      .text {
        white-space: pre-wrap;
        margin: 6px 0;
        font-style: italic;
      }
      .answer {
        white-space: pre-wrap;
        margin: 6px 0 0;
      }
      .verdict {
        font-weight: 700;
        color: var(--against);
      }
      .verdict.carried {
        color: var(--for);
      }
      .badge.quiet {
        background: transparent;
        border: 1px solid rgba(128, 128, 128, 0.4);
      }
      .footnote {
        margin-top: 16px;
      }
    `,
  ],
})
export class ReportsComponent implements OnInit {
  private readonly reports = inject(ReportService);
  private readonly meetingService = inject(MeetingService);

  readonly meetings = signal<MeetingView[]>([]);
  readonly selectedId = signal('');
  readonly report = signal<MeetingReport | null>(null);
  readonly loading = signal(false);
  readonly downloading = signal(false);
  readonly error = signal('');

  ngOnInit(): void {
    this.meetingService.list().subscribe({
      next: (list) => {
        this.meetings.set(list);
        // Default to whichever meeting is live, or the most recent one — the report somebody
        // opening this page almost always wants, without a click.
        const preferred = list.find((m) => m.active) ?? list[0];
        if (preferred) this.select(preferred.id);
      },
      error: () =>
        this.error.set(
          'Could not load the list of meetings. Reports need the meetings feature switched on.',
        ),
    });
  }

  select(meetingId: string): void {
    this.selectedId.set(meetingId);
    this.report.set(null);
    if (!meetingId) return;

    this.loading.set(true);
    this.error.set('');
    this.reports.report(meetingId).subscribe({
      next: (r) => {
        this.report.set(r);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(
          err?.status === 404
            ? 'Reports are switched off for this deployment.'
            : (err?.error?.message ?? 'Could not build that report.'),
        );
      },
    });
  }

  /**
   * Save the minutes.
   *
   * <p>Fetched as a blob and handed to a temporary link rather than opened as a URL, because the
   * request has to carry the Authorization header — a plain navigation would arrive unauthenticated
   * and download a 401 page instead of the minutes.
   */
  download(): void {
    const id = this.selectedId();
    if (!id) return;
    this.downloading.set(true);
    this.reports.minutes(id).subscribe({
      next: (blob) => {
        this.downloading.set(false);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${this.slug(this.report()?.title ?? 'meeting')}-minutes.md`;
        link.click();
        // Release the object URL, or the blob stays in memory for the life of the page.
        URL.revokeObjectURL(url);
      },
      error: () => {
        this.downloading.set(false);
        this.error.set('Could not prepare the minutes.');
      },
    });
  }

  private slug(title: string): string {
    return (
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'meeting'
    );
  }
}
