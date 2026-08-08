import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ApiService, Member } from '../services/api.service';
import { AuthService } from '../services/auth.service';
import {
  BackfillResult,
  MeetingMemberView,
  MeetingService,
  MeetingView,
} from '../services/meeting.service';

/**
 * Meeting management, and mapping users to meetings.
 *
 * <p>One screen, two duties. A MEETING_MANAGER sees the create form and the lifecycle actions; a
 * USER_MANAGER sees the member panel. Someone holding both sees everything, and ADMIN is a superset
 * of the two. The server enforces all of this — what is hidden here is only what would 403 anyway.
 */
@Component({
  selector: 'app-meetings',
  standalone: true,
  imports: [DatePipe],
  template: `
    <div class="container meetings-page">
      <header class="page-head">
        <h1>Meetings</h1>
        <p class="muted sub">
          Everything belongs to a meeting: the questions asked, the board they are ranked on, and
          the recording afterwards. Exactly one meeting is live at a time — activating another
          closes it.
        </p>
      </header>

      @if (error()) {
        <div class="error-box" role="alert">{{ error() }}</div>
      }

      <!--
        One list for the whole page rather than one per meeting: the roster is the same either way,
        and a datalist per expanded meeting would fetch and render the same names repeatedly.
      -->
      <datalist id="registered-users">
        @for (u of registeredUsers(); track u.id) {
          <option [value]="u.username">{{ u.username }} — {{ u.role }}</option>
        }
      </datalist>

      <!--
        The migration warning. Questions and topics recorded before meetings existed belong to no
        meeting, and once the board filters by meeting they stop appearing anywhere. Shown here,
        before anyone activates anything, because the fix is the same before or after but the
        discovery is far less alarming beforehand.
      -->
      @if (orphans(); as o) {
        @if (o.questions > 0 || o.topics > 0) {
          <div class="card orphans">
            <strong>{{ o.questions }} questions and {{ o.topics }} topics belong to no meeting.</strong>
            <p class="muted note">
              These were recorded before meetings existed. Once the board is filtered by meeting
              they will not appear on any of them. Adopt them into whichever meeting they actually
              belong to — this only ever claims items with no meeting, so it cannot move anything
              between meetings and running it again is harmless.
            </p>
            <div class="row" style="margin-top:8px">
              <label class="sr-only" for="backfill-target">Meeting to adopt them into</label>
              <select
                id="backfill-target"
                [value]="backfillTarget()"
                (change)="backfillTarget.set($any($event.target).value)"
              >
                <option value="">Choose a meeting…</option>
                @for (m of meetings(); track m.id) {
                  <option [value]="m.id">{{ m.title }}</option>
                }
              </select>
              <button (click)="runBackfill()" [disabled]="!backfillTarget() || busy()">
                Adopt them
              </button>
            </div>
          </div>
        }
      }
      @if (backfillDone(); as done) {
        <div class="card" role="status">
          Adopted {{ done.questionsAdopted }} questions and {{ done.topicsAdopted }} topics into
          <strong>{{ done.meetingTitle }}</strong>.
        </div>
      }

      <!-- What is live right now, for anyone who lands here. -->
      @if (active(); as live) {
        <section class="card live" aria-labelledby="live-heading">
          <div class="live-head">
            <span class="badge hot live-pill">
              <span class="live-dot" aria-hidden="true"></span>LIVE
            </span>
            <h2 id="live-heading" class="live-title">{{ live.title }}</h2>
          </div>
          <p class="muted note">
            {{ live.memberCount }} {{ live.memberCount === 1 ? 'member' : 'members' }} · questions
            asked now are attached to this meeting.
          </p>
          @if (canManageMeetings()) {
            <button class="ghost" (click)="close(live)" [disabled]="busy()">Close meeting</button>
          }
        </section>
      } @else {
        <div class="card">
          <span class="muted">
            No meeting is live. Questions submitted now are not attached to any meeting.
          </span>
        </div>
      }

      <!-- Create (MEETING_MANAGER) -->
      @if (canManageMeetings()) {
        <section class="card" aria-labelledby="create-heading">
          <h2 id="create-heading" class="section-title">Schedule a meeting</h2>
          <div class="field">
            <label class="label" for="new-title">Title</label>
            <input
              id="new-title"
              type="text"
              placeholder="Annual General Meeting 2026"
              [value]="title()"
              (input)="title.set($any($event.target).value)"
            />
          </div>
          <div class="field">
            <label class="label" for="new-desc">
              Description <span class="muted-inline">(optional)</span>
            </label>
            <textarea
              id="new-desc"
              rows="2"
              [value]="description()"
              (input)="description.set($any($event.target).value)"
            ></textarea>
          </div>
          <div class="field">
            <label class="label" for="when">
              Scheduled for <span class="muted-inline">(optional)</span>
            </label>
            <input
              id="when"
              type="datetime-local"
              [value]="scheduledAt()"
              (input)="scheduledAt.set($any($event.target).value)"
            />
          </div>
          <button (click)="create()" [disabled]="!title().trim() || busy()">
            {{ busy() ? 'Saving…' : 'Create meeting' }}
          </button>
        </section>
      }

      <!-- The schedule -->
      <h2 class="section">All meetings</h2>
      @if (loading()) {
        <div class="card"><span class="muted">Loading…</span></div>
      } @else if (!meetings().length) {
        <div class="card"><span class="muted">No meetings yet.</span></div>
      }

      @for (m of meetings(); track m.id) {
        <article class="card meeting" [attr.data-status]="m.status">
          <div class="meeting-head">
            <h3 class="meeting-title">{{ m.title }}</h3>
            <span class="badge" [class.hot]="m.active">{{ m.status }}</span>
          </div>

          <p class="muted meta">
            @if (m.scheduledAt) {
              <span>{{ m.scheduledAt | date: 'medium' }}</span>
            }
            <span>{{ m.memberCount }} {{ m.memberCount === 1 ? 'member' : 'members' }}</span>
            <span>quorum {{ m.quorumThresholdPercent }}%</span>
          </p>

          @if (m.description) {
            <p class="muted desc">{{ m.description }}</p>
          }

          <div class="actions">
            @if (canManageMeetings()) {
              @if (m.status === 'DRAFT') {
                <button (click)="activate(m)" [disabled]="busy()">Activate</button>
              }
              @if (m.status !== 'CLOSED') {
                <button class="ghost" (click)="close(m)" [disabled]="busy()">Close</button>
              }
              @if (m.status !== 'ACTIVE') {
                <button class="link" (click)="remove(m)" [disabled]="busy()">Delete</button>
              }
            }
            @if (canManageMembers()) {
              <button
                class="ghost"
                (click)="toggleMembers(m)"
                [attr.aria-expanded]="openMeetingId() === m.id"
              >
                {{ openMeetingId() === m.id ? '▾' : '▸' }} Members
              </button>
            }
          </div>

          <!-- Member mapping (USER_MANAGER) -->
          @if (openMeetingId() === m.id) {
            <div class="inspector">
              @if (m.status !== 'CLOSED') {
                <div class="row" style="margin:8px 0">
                  <!--
                    A picker AND free text, deliberately. Registered users autocomplete, because
                    typing a username from memory is how you map the wrong person — but the field
                    still accepts anything, because this is an invitation list: somebody can be
                    added before they have ever signed in, and a strict dropdown would make that
                    impossible. See MeetingMember on why the username is stored as plain text.
                  -->
                  <label class="sr-only" [attr.for]="'member-' + m.id">Username to add</label>
                  <input
                    [id]="'member-' + m.id"
                    type="text"
                    list="registered-users"
                    placeholder="Username (or type a new one)"
                    autocomplete="off"
                    [value]="newMember()"
                    (input)="newMember.set($any($event.target).value)"
                    (keyup.enter)="addMember(m)"
                  />
                  <label class="sr-only" [attr.for]="'role-' + m.id">Role at this meeting</label>
                  <select
                    [id]="'role-' + m.id"
                    [value]="newMemberRole()"
                    (change)="newMemberRole.set($any($event.target).value)"
                  >
                    <option value="ATTENDEE">Attendee</option>
                    <option value="PANELLIST">Panellist</option>
                    <option value="CHAIR">Chair</option>
                  </select>
                  <!--
                    Voting entitlement: shares held, or 1 for one-member-one-vote. It belongs here
                    because only a user manager may set it — a weight the voter's own browser could
                    send would be a weight the voter could inflate.
                  -->
                  <label class="weight">
                    <span class="sr-only">Voting weight</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      title="Voting weight — shares held, or 1 for one-member-one-vote"
                      placeholder="Votes"
                      [value]="newMemberWeight()"
                      (input)="newMemberWeight.set($any($event.target).value)"
                      (keyup.enter)="addMember(m)"
                    />
                  </label>
                  <button (click)="addMember(m)" [disabled]="!newMember().trim() || busy()">
                    Add
                  </button>
                </div>
                <p class="muted note">
                  A username can be mapped before that person has ever signed in — this is an
                  invitation list, not a lookup. The role here describes what they are at this
                  meeting and grants no permissions.
                </p>
                <p class="muted note">
                  Votes are how much this member's vote counts for — their shareholding, or 1 for
                  one-member-one-vote. It is also their share of quorum. Leave it blank for 1.
                  Re-adding an existing member updates their entitlement rather than duplicating
                  them.
                </p>
              }

              @if (membersLoading()) {
                <span class="muted">Loading members…</span>
              } @else if (!members().length) {
                <p class="muted note">Nobody mapped yet.</p>
              } @else {
                @for (member of members(); track member.id) {
                  <div class="member">
                    <strong>{{ member.username }}</strong>
                    <span class="badge">{{ member.roleInMeeting }}</span>
                    <span class="badge weight-badge" title="Voting weight">
                      {{ member.votingWeight }} {{ member.votingWeight === 1 ? 'vote' : 'votes' }}
                    </span>
                    @if (member.addedBy) {
                      <span class="muted-inline">added by {{ member.addedBy }}</span>
                    }
                    <span style="flex:1"></span>
                    @if (m.status !== 'CLOSED') {
                      <button class="link" (click)="removeMember(m, member)">Remove</button>
                    }
                  </div>
                }
              }
            </div>
          }
        </article>
      }
    </div>
  `,
  styles: [
    `
      /* Visible to screen readers only. The weight input is labelled by placeholder and title for
         sighted users, but neither is a reliable accessible name on its own. */
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
      .weight input {
        width: 88px;
      }
      /* Amber, not red: unattributed data is a migration step to take, not a failure. */
      .orphans {
        border-left: 4px solid #f59e0b;
      }

      .page-head h1 {
        margin-bottom: 4px;
      }
      .sub {
        margin: 0;
        max-width: 70ch;
      }
      .section-title {
        margin: 0 0 12px;
        font-size: 16px;
      }

      /* ---- the live meeting ---- */
      .live {
        border-left: 4px solid var(--hot);
      }
      .live-head {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .live-title {
        margin: 0;
        font-size: 17px;
      }
      .live-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex: 0 0 auto;
      }
      .live-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: currentColor;
        animation: meeting-pulse 2s ease-in-out infinite;
      }
      @keyframes meeting-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }

      /* ---- a meeting in the list ----
         Title first, meta underneath, actions on their own line. Previously the title competed
         with a badge, a date, a member count and five buttons on one wrapping row, which
         collapsed into an unreadable stack on anything narrow. */
      .meeting {
        border-left: 3px solid rgba(128, 128, 128, 0.3);
      }
      .meeting[data-status='ACTIVE'] {
        border-left-color: var(--hot);
      }
      .meeting[data-status='CLOSED'] {
        border-left-color: rgba(128, 128, 128, 0.18);
      }
      .meeting-head {
        display: flex;
        align-items: baseline;
        gap: 10px;
        flex-wrap: wrap;
      }
      .meeting-title {
        margin: 0;
        font-size: 16px;
        flex: 1 1 auto;
        min-width: 0;
      }
      /* Separators as generated content, so screen readers do not read a row of bullets. */
      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 14px;
        margin: 6px 0 0;
      }
      .meta span + span::before {
        content: '·';
        margin-right: 14px;
        opacity: 0.5;
      }
      .desc {
        margin: 8px 0 0;
        max-width: 70ch;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }

      /* ---- fields ---- */
      .field {
        margin-bottom: 12px;
      }
      .label {
        display: block;
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 5px;
      }

      /* ---- members ---- */
      .member {
        gap: 10px;
      }

      @media (max-width: 640px) {
        /* Actions go full width and stack: five of them side by side leaves no room for labels. */
        .actions button {
          width: 100%;
          min-width: 0;
        }
        .meta {
          gap: 4px 0;
          flex-direction: column;
        }
        .meta span + span::before {
          content: none;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .live-dot {
          animation: none;
        }
      }
      .weight-badge {
        font-variant-numeric: tabular-nums;
      }
      .live {
        border-color: #f59e0b;
      }
      .desc {
        margin: 6px 0 0;
      }
      .note {
        margin: 6px 0 0;
        font-size: 13px;
      }
      .inspector {
        margin-top: 10px;
        border-top: 1px solid #1f2937;
        padding-top: 8px;
      }
      .member {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 0;
        border-bottom: 1px solid #16202f;
        font-size: 14px;
      }
      .field label {
        display: block;
        margin-bottom: 4px;
        font-size: 13px;
      }
    `,
  ],
})
export class MeetingsComponent implements OnInit {
  private readonly service = inject(MeetingService);
  private readonly auth = inject(AuthService);
  /** Only for the registered-user roster that autocompletes the username field. */
  private readonly api = inject(ApiService);

  readonly meetings = signal<MeetingView[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal('');

  readonly active = computed(() => this.service.active());

  // Which duties this user holds. The server enforces the same split; hiding here only avoids
  // offering buttons that would come back 403.
  readonly canManageMeetings = computed(() => this.auth.isMeetingManager());
  readonly canManageMembers = computed(() => this.auth.isUserManager());

  // ---- create form ----
  readonly title = signal('');
  readonly description = signal('');
  readonly scheduledAt = signal('');

  // ---- member panel ----
  readonly openMeetingId = signal<string | null>(null);
  readonly members = signal<MeetingMemberView[]>([]);
  readonly membersLoading = signal(false);
  readonly newMember = signal('');
  readonly newMemberRole = signal('ATTENDEE');
  /**
   * Voting entitlement for the member being added, as typed.
   *
   * <p>Kept as the raw string rather than a number so "empty" stays distinguishable from "zero".
   * They mean opposite things: blank leaves an existing member's weight alone (and gives a new one
   * the default of 1), while 0 deliberately disenfranchises somebody. Coercing the input to a
   * number would collapse the two and silently strip entitlement from anyone re-added without the
   * field filled in.
   */
  readonly newMemberWeight = signal('');

  // ---- migration: adopting data that predates meetings -----------------------
  //
  // Everything recorded before meetings existed carries no meeting. Once the board filters by
  // meeting, those items stop appearing on any of them. Surfacing the count here — before anyone
  // activates anything — turns a frightening discovery into a one-click step.

  /**
   * Everyone with an account, to autocomplete the username field.
   *
   * <p>A convenience, not a constraint: the field still accepts a name that is not in this list,
   * because a meeting's member list is an invitation list and people are routinely added before
   * they sign up. Loaded once for the page.
   */
  readonly registeredUsers = signal<Member[]>([]);

  readonly orphans = signal<{ questions: number; topics: number } | null>(null);
  readonly backfillTarget = signal('');
  readonly backfillDone = signal<BackfillResult | null>(null);

  ngOnInit(): void {
    this.service.refreshActive().subscribe({ error: () => {} });
    this.refresh();
    this.checkOrphans();
    // Silent on failure: without it the field is still usable, just without autocomplete.
    this.api.listUsers().subscribe({
      next: (users) => this.registeredUsers.set(users),
      error: () => {},
    });
  }

  private checkOrphans(): void {
    // Silent on failure: this is an advisory panel, and an error banner over it would suggest the
    // meetings screen itself was broken.
    this.service.unattributedCount().subscribe({
      next: (counts) => this.orphans.set(counts),
      error: () => this.orphans.set(null),
    });
  }

  runBackfill(): void {
    const target = this.backfillTarget();
    if (!target || this.busy()) return;

    const meeting = this.meetings().find((m) => m.id === target);
    if (
      !confirm(
        `Adopt every question and topic that has no meeting into "${meeting?.title ?? target}"?\n\n` +
          'They will count towards that meeting from now on, including in its report.',
      )
    ) {
      return;
    }

    this.busy.set(true);
    this.error.set('');
    this.service.backfillInto(target).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.backfillDone.set(result);
        this.backfillTarget.set('');
        this.checkOrphans(); // should now report zero — re-read rather than assume
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(this.message(err, 'Could not adopt those items.'));
      },
    });
  }

  private refresh(): void {
    this.loading.set(true);
    this.service.list().subscribe({
      next: (list) => {
        this.meetings.set(list);
        this.loading.set(false);
      },
      error: (err) => {
        this.loading.set(false);
        this.error.set(this.message(err, 'Could not load meetings.'));
      },
    });
  }

  create(): void {
    const title = this.title().trim();
    if (!title || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    // datetime-local has no timezone; treat it as local time and send an instant.
    const when = this.scheduledAt() ? new Date(this.scheduledAt()).toISOString() : null;

    this.service.create(title, this.description().trim(), when).subscribe({
      next: () => {
        this.busy.set(false);
        this.title.set('');
        this.description.set('');
        this.scheduledAt.set('');
        this.refresh();
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(this.message(err, 'Could not create that meeting.'));
      },
    });
  }

  activate(meeting: MeetingView): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.service.activate(meeting.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.refresh();
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(this.message(err, 'Could not activate that meeting.'));
      },
    });
  }

  close(meeting: MeetingView): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.service.close(meeting.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.refresh();
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(this.message(err, 'Could not close that meeting.'));
      },
    });
  }

  remove(meeting: MeetingView): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.service.remove(meeting.id).subscribe({
      next: () => {
        this.busy.set(false);
        if (this.openMeetingId() === meeting.id) this.openMeetingId.set(null);
        this.refresh();
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(this.message(err, 'Could not delete that meeting.'));
      },
    });
  }

  // ---- members ----

  toggleMembers(meeting: MeetingView): void {
    if (this.openMeetingId() === meeting.id) {
      this.openMeetingId.set(null);
      return;
    }
    this.openMeetingId.set(meeting.id);
    this.members.set([]);
    this.newMember.set('');
    this.loadMembers(meeting);
  }

  /**
   * The weight to send, or undefined to leave it to the server.
   *
   * <p>Blank and anything unparseable both send nothing, so a typo cannot quietly rewrite an
   * entitlement. Zero is passed through — it is a real instruction, meaning "listed for this
   * meeting but holding no vote".
   */
  private weightToSend(): number | undefined {
    const raw = this.newMemberWeight().trim();
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  }

  private loadMembers(meeting: MeetingView): void {
    this.membersLoading.set(true);
    this.service.members(meeting.id).subscribe({
      next: (list) => {
        this.members.set(list);
        this.membersLoading.set(false);
      },
      error: (err) => {
        this.membersLoading.set(false);
        this.error.set(this.message(err, 'Could not load members.'));
      },
    });
  }

  addMember(meeting: MeetingView): void {
    const username = this.newMember().trim();
    if (!username || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.service.addMember(meeting.id, username, this.newMemberRole(), this.weightToSend()).subscribe({
      next: () => {
        this.busy.set(false);
        this.newMember.set('');
        this.newMemberWeight.set('');
        this.loadMembers(meeting);
        this.refresh();   // the count on the row moved
      },
      error: (err) => {
        this.busy.set(false);
        this.error.set(this.message(err, 'Could not add that member.'));
      },
    });
  }

  removeMember(meeting: MeetingView, member: MeetingMemberView): void {
    this.service.removeMember(meeting.id, member.username).subscribe({
      next: () => {
        this.members.update((list) => list.filter((m) => m.id !== member.id));
        this.refresh();
      },
      error: (err) => this.error.set(this.message(err, 'Could not remove that member.')),
    });
  }

  private message(err: unknown, fallback: string): string {
    const body = (err as { error?: { message?: string; error?: string } })?.error;
    return body?.message ?? body?.error ?? fallback;
  }
}
