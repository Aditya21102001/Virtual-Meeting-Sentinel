import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AuthService } from '../services/auth.service';
import {
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
    <div class="container">
      <h1>Meetings</h1>
      <p class="muted">
        Everything belongs to a meeting: the questions asked, the board they are ranked on, and the
        recording afterwards. Exactly one meeting is live at a time — activating another closes it.
      </p>

      @if (error()) {
        <div class="error-box">{{ error() }}</div>
      }

      <!-- What is live right now, for anyone who lands here. -->
      @if (active(); as live) {
        <div class="card live">
          <div class="row">
            <span class="badge hot">● LIVE</span>
            <strong>{{ live.title }}</strong>
            <span class="muted">{{ live.memberCount }} member(s)</span>
            <span style="flex:1"></span>
            @if (canManageMeetings()) {
              <button class="ghost" (click)="close(live)" [disabled]="busy()">Close meeting</button>
            }
          </div>
        </div>
      } @else {
        <div class="card">
          <span class="muted">
            No meeting is live. Questions submitted now are not attached to any meeting.
          </span>
        </div>
      }

      <!-- Create (MEETING_MANAGER) -->
      @if (canManageMeetings()) {
        <div class="card">
          <div class="q">Schedule a meeting</div>
          <div class="field">
            <input
              type="text"
              placeholder="Title, e.g. Annual General Meeting 2026"
              [value]="title()"
              (input)="title.set($any($event.target).value)"
            />
          </div>
          <div class="field">
            <textarea
              rows="2"
              placeholder="Description (optional)"
              [value]="description()"
              (input)="description.set($any($event.target).value)"
            ></textarea>
          </div>
          <div class="field">
            <label class="muted" for="when">Scheduled for (optional)</label>
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
        </div>
      }

      <!-- The schedule -->
      <h2 class="section">All meetings</h2>
      @if (loading()) {
        <div class="card"><span class="muted">Loading…</span></div>
      } @else if (!meetings().length) {
        <div class="card"><span class="muted">No meetings yet.</span></div>
      }

      @for (m of meetings(); track m.id) {
        <div class="card">
          <div class="row">
            <span class="badge" [class.hot]="m.active">{{ m.status }}</span>
            <strong>{{ m.title }}</strong>
            @if (m.scheduledAt) {
              <span class="muted">{{ m.scheduledAt | date: 'medium' }}</span>
            }
            <span class="muted">{{ m.memberCount }} member(s)</span>
            <span style="flex:1"></span>

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
              <button class="link" (click)="toggleMembers(m)">
                {{ openMeetingId() === m.id ? '▾' : '▸' }} Members
              </button>
            }
          </div>

          @if (m.description) {
            <p class="muted desc">{{ m.description }}</p>
          }

          <!-- Member mapping (USER_MANAGER) -->
          @if (openMeetingId() === m.id) {
            <div class="inspector">
              @if (m.status !== 'CLOSED') {
                <div class="row" style="margin:8px 0">
                  <input
                    type="text"
                    placeholder="Username"
                    [value]="newMember()"
                    (input)="newMember.set($any($event.target).value)"
                    (keyup.enter)="addMember(m)"
                  />
                  <select
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
        </div>
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

  ngOnInit(): void {
    this.service.refreshActive().subscribe({ error: () => {} });
    this.refresh();
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
