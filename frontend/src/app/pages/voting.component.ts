import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { AuthService } from '../services/auth.service';
import { FeatureService } from '../services/feature.service';
import { MeetingService } from '../services/meeting.service';
import {
  QuorumView,
  ResolutionType,
  ResolutionView,
  TallyView,
  VoteChoice,
  VotingService,
} from '../services/voting.service';

/**
 * The ballot, and the chair's controls for running it.
 *
 * <h2>What you are looking at</h2>
 * At an AGM, formal decisions are put as "resolutions" — motions with exact wording. The chair opens
 * the floor, members vote FOR / AGAINST / ABSTAIN, and the chair closes it. This one screen serves
 * both sides: an ordinary member sees the agenda and their own ballot, while a moderator also gets
 * the controls to add motions and open and close voting.
 *
 * <p>One screen rather than two, because they are the same list. A separate chair's page would
 * drift out of step with what members are actually being shown, which is the last thing you want
 * while a vote is running.
 *
 * <h2>Why it polls</h2>
 * Tallies and quorum change while people vote. The page re-reads every few seconds rather than
 * holding a socket open — the payload is small, and a dropped websocket frame during a live vote
 * would leave the chair looking at a number that had silently stopped updating.
 *
 * <h2>Accessibility notes</h2>
 * The ballot is built from real {@code <input type="radio">} elements, visually hidden and styled
 * through their labels. Styled {@code <button>}s would have looked identical and been wrong: a group
 * of mutually exclusive choices is exactly what a radio group is, and using the real thing gives
 * arrow-key navigation, {@code aria-checked} and correct screen-reader announcement for free rather
 * than reimplementing all three badly.
 *
 * <p>Outcome is never carried by colour alone — every bar has the numbers beside it in text, and
 * carried / not carried is a word before it is a green or red. The quorum dial is a
 * {@code role="progressbar"} with a spoken {@code aria-valuetext}, because "62%" alone does not say
 * what it is 62% of. Status changes sit in polite live regions so a screen-reader user hears a vote
 * open or close without having to go looking.
 */
@Component({
  selector: 'app-voting',
  standalone: true,
  // Standalone components pull in only what they use, so the two pipes the template needs are
  // imported by name rather than dragging in the whole of CommonModule.
  imports: [DecimalPipe, DatePipe],
  template: `
    <div class="container vote-page">
      <header class="page-head">
        <div>
          <h1>Voting</h1>
          @if (meetingId()) {
            <p class="muted sub">
              Motions put to <strong>{{ meetingTitle() }}</strong>
            </p>
          }
        </div>
        @if (openCount(); as n) {
          <span class="live-pill" role="status">
            <span class="dot" aria-hidden="true"></span>
            {{ n }} {{ n === 1 ? 'vote' : 'votes' }} open
          </span>
        }
      </header>

      @if (!meetingId()) {
        <div class="card empty">
          <p class="muted">
            No meeting is live. A meeting has to be activated before motions can be put to it — ask
            a meeting manager to activate one.
          </p>
        </div>
      } @else {
        <!--
          Quorum: the minimum share of the register that must be taking part for the meeting's
          decisions to be valid. Shown even when unmet — especially then, since a vote taken without
          quorum does not count however lopsided it was.
        -->
        @if (quorum(); as q) {
          <section class="card quorum" [class.met]="q.met" aria-labelledby="quorum-heading">
            <div
              class="dial"
              role="progressbar"
              [attr.aria-valuenow]="q.representedPercent | number: '1.0-0'"
              aria-valuemin="0"
              aria-valuemax="100"
              [attr.aria-valuetext]="quorumSpoken(q)"
              [style.--pct.%]="barWidth(q)"
            >
              <span class="dial-num" aria-hidden="true">{{ q.representedPercent | number: '1.0-0' }}%</span>
            </div>
            <div class="quorum-copy">
              <h2 id="quorum-heading" class="quorum-title">
                {{ q.met ? 'Quorum met' : 'Quorum not met' }}
              </h2>
              <p class="muted small">
                <strong class="num">{{ q.representedWeight }}</strong> of
                <strong class="num">{{ q.totalWeight }}</strong> votes represented.
                Threshold {{ q.thresholdPercent | number: '1.0-1' }}%.
              </p>
              <p class="muted small">
                A member counts once they have cast any vote — an abstention counts too, because
                abstaining still means taking part.
              </p>
            </div>
          </section>
        }

        <!-- role="alert" so a failed vote is announced immediately, not on next focus. -->
        @if (error()) {
          <div class="error-box" role="alert">{{ error() }}</div>
        }

        @if (isModerator()) {
          <section class="card compose" aria-labelledby="compose-heading">
            <h2 id="compose-heading" class="section-title">Put a motion</h2>

            <label class="field">
              <span class="label">Title</span>
              <input
                [value]="newTitle()"
                (input)="newTitle.set($any($event.target).value)"
                placeholder="Approval of the annual accounts"
              />
            </label>

            <label class="field">
              <span class="label">Wording put to the meeting</span>
              <textarea
                rows="3"
                [value]="newText()"
                (input)="newText.set($any($event.target).value)"
                placeholder="That the accounts for the year ended 31 March be received and adopted."
              ></textarea>
            </label>

            <fieldset class="type-choice">
              <legend class="label">Majority required</legend>
              @for (t of types; track t) {
                <label class="pill-radio">
                  <input
                    type="radio"
                    name="newType"
                    [value]="t"
                    [checked]="newType() === t"
                    (change)="newType.set(t)"
                  />
                  <span class="pill">
                    <strong>{{ t === 'SPECIAL' ? 'Special' : 'Ordinary' }}</strong>
                    <small>{{ t === 'SPECIAL' ? 'at least 75%' : 'simple majority' }}</small>
                  </span>
                </label>
              }
            </fieldset>

            <button class="primary" (click)="create()" [disabled]="!newTitle().trim() || busy()">
              Add to agenda
            </button>
          </section>
        }

        @if (loading() && !resolutions().length) {
          <div class="card empty"><span class="muted">Loading the agenda…</span></div>
        } @else if (!resolutions().length) {
          <div class="card empty">
            <p class="muted">
              Nothing has been put to this meeting yet.
              @if (isModerator()) { Add the first motion above. }
            </p>
          </div>
        }

        <ol class="agenda">
          @for (r of resolutions(); track r.id) {
            <li class="card resolution" [attr.data-status]="r.status">
              <div class="res-head">
                <span class="seq" aria-hidden="true">{{ r.seq }}</span>
                <div class="res-title">
                  <h2 class="section-title">{{ r.title }}</h2>
                  <p class="tags">
                    <!-- role="status" so opening or closing a vote is announced as it happens. -->
                    <span class="badge" [class.live]="r.open" role="status">
                      @if (r.open) { <span class="dot" aria-hidden="true"></span> }
                      {{ statusLabel(r) }}
                    </span>
                    <span class="badge quiet">
                      {{ r.type === 'SPECIAL' ? 'Special — needs 75%' : 'Ordinary — simple majority' }}
                    </span>
                  </p>
                </div>
              </div>

              @if (r.text) {
                <p class="text">{{ r.text }}</p>
              }

              <!--
                A real radio group: mutually exclusive choices, so arrow keys, aria-checked and
                screen-reader announcement all come from the platform rather than from us.
              -->
              @if (r.open) {
                <fieldset class="ballot" [disabled]="busy()">
                  <legend class="sr-only">Your vote on {{ r.title }}</legend>
                  @for (choice of choices; track choice) {
                    <label class="pill-radio" [class.chosen]="r.myChoice === choice">
                      <input
                        type="radio"
                        [name]="'ballot-' + r.id"
                        [value]="choice"
                        [checked]="r.myChoice === choice"
                        (change)="cast(r, choice)"
                      />
                      <span class="pill choice" [attr.data-choice]="choice">
                        <span class="tick" aria-hidden="true">{{ r.myChoice === choice ? '✓' : '' }}</span>
                        {{ label(choice) }}
                      </span>
                    </label>
                  }
                </fieldset>
                @if (r.myChoice) {
                  <p class="muted small" role="status">
                    You voted {{ label(r.myChoice) }}. You can change it until the vote closes.
                  </p>
                }
              } @else if (r.myChoice) {
                <p class="muted small">You voted {{ label(r.myChoice) }}.</p>
              }

              @if (r.result; as t) {
                <div class="tally">
                  <!--
                    aria-hidden: the bar is a picture of the numbers spelled out underneath it, so
                    letting a screen reader walk its segments would just read the same figures twice.
                  -->
                  <div class="bar" aria-hidden="true">
                    <span class="seg for" [style.width.%]="sharePercent(t.forWeight, t)"></span>
                    <span class="seg against" [style.width.%]="sharePercent(t.againstWeight, t)"></span>
                  </div>

                  <ul class="legend">
                    <li><span class="swatch for" aria-hidden="true"></span> For <b class="num">{{ t.forWeight }}</b></li>
                    <li><span class="swatch against" aria-hidden="true"></span> Against <b class="num">{{ t.againstWeight }}</b></li>
                    <li><span class="swatch abstain" aria-hidden="true"></span> Abstained <b class="num">{{ t.abstainWeight }}</b></li>
                  </ul>

                  <p class="muted small">
                    {{ t.forPercent | number: '1.0-1' }}% of the
                    <b class="num">{{ t.decisiveWeight }}</b> votes that count towards the majority.
                    Abstentions are excluded. Members voting:
                    {{ t.forCount }} for, {{ t.againstCount }} against, {{ t.abstainCount }} abstained.
                  </p>

                  @if (r.status === 'CLOSED') {
                    <p class="verdict" [class.carried]="t.carried">
                      <span class="mark" aria-hidden="true">{{ t.carried ? '✓' : '✕' }}</span>
                      {{ t.carried ? 'Carried' : 'Not carried' }}
                    </p>
                  }
                </div>
              } @else if (r.open) {
                <p class="muted small withheld">
                  Results are not published while voting is open — a running count would sway the
                  votes still to come.
                </p>
              }

              @if (isModerator()) {
                <div class="chair">
                  @if (r.status === 'DRAFT') {
                    <button class="primary" (click)="open(r)" [disabled]="busy()">Open the floor</button>
                    <button class="link danger" (click)="remove(r)" [disabled]="busy()">Delete</button>
                  } @else if (r.open) {
                    <button class="primary" (click)="close(r)" [disabled]="busy()">Close the vote</button>
                    <label class="switch">
                      <input
                        type="checkbox"
                        [checked]="r.liveResultsVisible"
                        [disabled]="busy()"
                        (change)="publishLive(r, $any($event.target).checked)"
                      />
                      <span>Show the running count to members</span>
                    </label>
                  } @else {
                    <span class="muted-inline">
                      Closed {{ r.closedAt | date: 'short' }} — this result is final.
                    </span>
                  }
                </div>
              }
            </li>
          }
        </ol>
      }
    </div>
  `,
  styles: [
    `
      /* Content that only screen readers should reach. Clipped rather than display:none,
         which would remove it from the accessibility tree entirely. */
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

      .vote-page {
        --for: #2e9e5b;
        --against: #d1495b;
        --abstain: #9aa0a6;
        --accent: #4c6ef5;
      }

      .page-head {
        display: flex;
        align-items: flex-start;
        gap: 16px;
        flex-wrap: wrap;
      }
      .page-head h1 {
        margin-bottom: 2px;
      }
      .sub {
        margin: 0;
      }

      .live-pill {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 14px;
        border-radius: 999px;
        font-size: 13px;
        font-weight: 600;
        color: #fff;
        background: linear-gradient(135deg, var(--accent), #7048e8);
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: currentColor;
        animation: pulse 1.8s ease-in-out infinite;
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.35; transform: scale(0.8); }
      }

      /* ---- quorum dial ---- */
      .quorum {
        display: flex;
        gap: 20px;
        align-items: center;
        flex-wrap: wrap;
      }
      .dial {
        --pct: 0%;
        flex: 0 0 auto;
        width: 92px;
        height: 92px;
        border-radius: 50%;
        display: grid;
        place-items: center;
        background:
          conic-gradient(var(--against) 0 var(--pct), rgba(128, 128, 128, 0.18) var(--pct) 100%);
      }
      .quorum.met .dial {
        background:
          conic-gradient(var(--for) 0 var(--pct), rgba(128, 128, 128, 0.18) var(--pct) 100%);
      }
      /* The hole in the doughnut. --card is the card's own background, so the ring reads as a ring
         rather than a filled disc with a pale blob in it. (This was --card-bg, which is not a
         variable this application defines — it fell through to the #fff fallback and punched a
         white circle into a dark card.) */
      .dial::before {
        content: '';
        position: absolute;
        width: 68px;
        height: 68px;
        border-radius: 50%;
        background: var(--card);
      }
      .dial {
        position: relative;
      }
      .dial-num {
        position: relative;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .quorum-copy {
        flex: 1 1 260px;
      }
      .quorum-title {
        margin: 0 0 4px;
        font-size: 17px;
      }

      /* ---- agenda ---- */
      .agenda {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .resolution {
        position: relative;
        overflow: hidden;
      }
      /* A coloured rail rather than a whole tinted card: states stay distinguishable without
         relying on a background wash that fails in high-contrast mode. */
      .resolution::before {
        content: '';
        position: absolute;
        inset: 0 auto 0 0;
        width: 4px;
        background: rgba(128, 128, 128, 0.35);
      }
      .resolution[data-status='OPEN']::before {
        background: linear-gradient(180deg, var(--accent), #7048e8);
      }
      .resolution[data-status='CLOSED']::before {
        background: var(--abstain);
      }

      .res-head {
        display: flex;
        gap: 14px;
        align-items: flex-start;
      }
      .seq {
        flex: 0 0 auto;
        width: 30px;
        height: 30px;
        border-radius: 9px;
        display: grid;
        place-items: center;
        font-weight: 700;
        font-size: 13px;
        background: rgba(128, 128, 128, 0.15);
      }
      .res-title {
        flex: 1;
      }
      .section-title {
        margin: 0;
        font-size: 16px;
      }
      .tags {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin: 6px 0 0;
      }
      .badge.live {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        background: var(--accent);
        color: #fff;
      }
      .badge.quiet {
        background: transparent;
        border: 1px solid rgba(128, 128, 128, 0.4);
      }
      .text {
        white-space: pre-wrap;
        margin: 12px 0;
        padding-left: 44px;
      }

      /* ---- ballot ---- */
      .ballot {
        border: 0;
        margin: 12px 0 6px;
        padding: 0 0 0 44px;
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .pill-radio input {
        /* Hidden visually, still focusable and still announced. */
        position: absolute;
        opacity: 0;
        width: 0;
        height: 0;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 9px 16px;
        border-radius: 999px;
        border: 1.5px solid rgba(128, 128, 128, 0.4);
        cursor: pointer;
        font-size: 14px;
        transition: border-color 0.15s, background 0.15s, transform 0.15s;
      }
      .pill small {
        opacity: 0.7;
      }
      .pill-radio input:hover + .pill {
        border-color: currentColor;
      }
      /* Focus must be visible on the pill, since the real input is not. :focus-visible so it
         appears for keyboard users without ringing every mouse click. */
      .pill-radio input:focus-visible + .pill {
        outline: 3px solid var(--accent);
        outline-offset: 2px;
      }
      .pill-radio input:checked + .pill {
        font-weight: 600;
        border-width: 2px;
      }
      .pill-radio input:checked + .choice[data-choice='FOR'] {
        border-color: var(--for);
        background: color-mix(in srgb, var(--for) 14%, transparent);
      }
      .pill-radio input:checked + .choice[data-choice='AGAINST'] {
        border-color: var(--against);
        background: color-mix(in srgb, var(--against) 14%, transparent);
      }
      .pill-radio input:checked + .choice[data-choice='ABSTAIN'] {
        border-color: var(--abstain);
        background: color-mix(in srgb, var(--abstain) 18%, transparent);
      }
      .pill-radio input:checked + .pill:not(.choice) {
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 12%, transparent);
      }
      .tick {
        font-size: 12px;
        width: 10px;
      }
      fieldset[disabled] .pill {
        opacity: 0.55;
        cursor: not-allowed;
      }

      /* ---- tally ---- */
      .tally {
        margin: 14px 0 0;
        padding-left: 44px;
      }
      .bar {
        display: flex;
        height: 10px;
        border-radius: 999px;
        overflow: hidden;
        background: rgba(128, 128, 128, 0.2);
      }
      .seg {
        height: 100%;
        transition: width 0.35s ease;
      }
      .seg.for { background: var(--for); }
      .seg.against { background: var(--against); }

      .legend {
        list-style: none;
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        padding: 0;
        margin: 10px 0 6px;
        font-size: 13px;
      }
      .legend li {
        display: inline-flex;
        align-items: center;
        gap: 7px;
      }
      .swatch {
        width: 11px;
        height: 11px;
        border-radius: 3px;
      }
      .swatch.for { background: var(--for); }
      .swatch.against { background: var(--against); }
      .swatch.abstain { background: var(--abstain); }

      /* Tabular figures so numbers do not jitter sideways as they tick up during a live vote. */
      .num {
        font-variant-numeric: tabular-nums;
      }

      .verdict {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 10px 0 0;
        padding: 7px 15px;
        border-radius: 10px;
        font-weight: 700;
        color: var(--against);
        background: color-mix(in srgb, var(--against) 12%, transparent);
      }
      .verdict.carried {
        color: var(--for);
        background: color-mix(in srgb, var(--for) 12%, transparent);
      }
      .withheld {
        padding-left: 44px;
        font-style: italic;
      }

      /* ---- chair controls ---- */
      .chair {
        display: flex;
        align-items: center;
        gap: 14px;
        flex-wrap: wrap;
        margin-top: 14px;
        padding-top: 12px;
        border-top: 1px solid rgba(128, 128, 128, 0.22);
      }
      .switch {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        cursor: pointer;
      }
      .link.danger {
        color: var(--against);
      }

      /* ---- compose ---- */
      .field {
        display: block;
        margin-bottom: 12px;
      }
      .label {
        display: block;
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 5px;
      }
      .type-choice {
        border: 0;
        padding: 0;
        margin: 0 0 14px;
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }
      .type-choice legend {
        margin-bottom: 6px;
      }
      .pill small {
        font-size: 11px;
      }

      .empty {
        text-align: center;
      }

      /* Motion is decoration here. Anyone who has asked the OS to stop it gets the same
         information without the movement. */
      @media (prefers-reduced-motion: reduce) {
        .dot { animation: none; }
        .seg, .pill { transition: none; }
      }

      @media (max-width: 640px) {
        .text,
        .ballot,
        .tally,
        .withheld {
          padding-left: 0;
        }
      }
    `,
  ],
})
export class VotingComponent implements OnInit, OnDestroy {
  private readonly voting = inject(VotingService);
  private readonly meetings = inject(MeetingService);
  private readonly features = inject(FeatureService);
  private readonly auth = inject(AuthService);

  readonly resolutions = signal<ResolutionView[]>([]);
  readonly quorum = signal<QuorumView | null>(null);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');

  readonly newTitle = signal('');
  readonly newText = signal('');
  readonly newType = signal<ResolutionType>('ORDINARY');

  readonly isModerator = computed(() => this.auth.isModerator());
  readonly meetingId = computed(() => this.meetings.active()?.id ?? null);
  readonly meetingTitle = computed(() => this.meetings.active()?.title ?? '');
  readonly openCount = computed(() => this.resolutions().filter((r) => r.open).length);

  readonly choices: VoteChoice[] = ['FOR', 'AGAINST', 'ABSTAIN'];
  readonly types: ResolutionType[] = ['ORDINARY', 'SPECIAL'];

  /**
   * Poll handle. Cleared on destroy — a timer left running after the component goes away keeps
   * firing requests at a page nobody is looking at.
   */
  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    // The agenda belongs to whichever meeting is live, so that has to resolve first.
    this.meetings.refreshActive().subscribe({
      next: () => this.reload(),
      error: () => {
        this.loading.set(false);
        this.error.set('Could not find out which meeting is live.');
      },
    });
    this.timer = setInterval(() => this.reload(true), 5000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Re-read the agenda and quorum.
   *
   * @param quiet true for the background poll, so a transient network blip does not throw an error
   *              banner over a page that is otherwise showing perfectly good data.
   */
  private reload(quiet = false): void {
    const id = this.meetingId();
    if (!id) {
      this.loading.set(false);
      return;
    }

    this.voting.list(id).subscribe({
      next: (list) => {
        this.resolutions.set(list);
        this.loading.set(false);
        if (!quiet) this.error.set('');
      },
      error: (err) => {
        this.loading.set(false);
        if (!quiet) this.error.set(this.explain(err, 'Could not load the agenda.'));
      },
    });

    // Quorum has its own flag, so it can be off while voting is on. A failure here must not blank
    // the agenda — the vote still runs.
    if (this.features.enabled('QUORUM')) {
      this.voting.quorum(id).subscribe({
        next: (q) => this.quorum.set(q),
        error: () => this.quorum.set(null),
      });
    }
  }

  cast(resolution: ResolutionView, choice: VoteChoice): void {
    this.busy.set(true);
    this.error.set('');
    this.voting.vote(resolution.id, choice).subscribe({
      next: (updated) => {
        this.busy.set(false);
        this.patch(updated);
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(this.explain(err, 'Your vote was not recorded. Try again.'));
        // Re-read, so the radio group reflects what the server actually holds rather than the
        // choice the user just clicked. A ballot that lies about your own vote is worse than one
        // that admits it failed.
        this.reload();
      },
    });
  }

  create(): void {
    const id = this.meetingId();
    if (!id) return;
    this.busy.set(true);
    this.voting.create(id, this.newTitle().trim(), this.newText().trim(), this.newType()).subscribe({
      next: () => {
        this.busy.set(false);
        this.newTitle.set('');
        this.newText.set('');
        this.newType.set('ORDINARY');
        this.reload();
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(this.explain(err, 'Could not add the motion.'));
      },
    });
  }

  open(resolution: ResolutionView): void {
    this.act(this.voting.open(resolution.id));
  }

  close(resolution: ResolutionView): void {
    // Deliberately confirmed: closing fixes the result and cannot be undone.
    if (!confirm(`Close voting on "${resolution.title}"? The result becomes final.`)) return;
    this.act(this.voting.close(resolution.id));
  }

  publishLive(resolution: ResolutionView, visible: boolean): void {
    this.act(this.voting.update(resolution.id, { liveResultsVisible: visible }));
  }

  remove(resolution: ResolutionView): void {
    if (!confirm(`Delete "${resolution.title}"?`)) return;
    this.busy.set(true);
    this.voting.remove(resolution.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.reload();
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(this.explain(err, 'Could not delete the motion.'));
      },
    });
  }

  private act(call: ReturnType<VotingService['open']>): void {
    this.busy.set(true);
    this.error.set('');
    call.subscribe({
      next: (updated) => {
        this.busy.set(false);
        this.patch(updated);
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(this.explain(err, 'That did not work.'));
        this.reload();
      },
    });
  }

  /**
   * Prefer the server's message.
   *
   * It is the specific one — "you are not on the member list", "voting has closed" — and those tell
   * somebody what to do next, where a generic failure leaves them clicking again.
   */
  private explain(err: unknown, fallback: string): string {
    const e = err as { status?: number; error?: { message?: string } };
    if (e?.status === 404) return 'Voting is switched off for this deployment.';
    return e?.error?.message ?? fallback;
  }

  /** Replace one row in place, so the list does not jump while somebody is reading it. */
  private patch(updated: ResolutionView): void {
    this.resolutions.update((list) => list.map((r) => (r.id === updated.id ? updated : r)));
  }

  statusLabel(r: ResolutionView): string {
    if (r.status === 'DRAFT') return 'Not yet open';
    if (r.status === 'OPEN') return 'Voting open';
    return 'Closed';
  }

  label(choice: VoteChoice): string {
    if (choice === 'FOR') return 'For';
    if (choice === 'AGAINST') return 'Against';
    return 'Abstain';
  }

  /** What a screen reader says for the quorum dial — a bare "62%" does not say 62% of what. */
  quorumSpoken(q: QuorumView): string {
    const pct = q.representedPercent.toFixed(0);
    return `${pct}% of voting entitlement represented, ${q.thresholdPercent}% needed. Quorum ${
      q.met ? 'met' : 'not met'
    }.`;
  }

  /** Quorum dial, capped at 100 so an over-subscribed meeting cannot overfill the ring. */
  barWidth(q: QuorumView): number {
    return Math.min(100, q.representedPercent);
  }

  /** A choice's share of the votes that count towards the majority. */
  sharePercent(weight: number, t: TallyView): number {
    return t.decisiveWeight === 0 ? 0 : (weight * 100) / t.decisiveWeight;
  }
}
