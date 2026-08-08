import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { FeatureKey, FeatureService } from '../services/feature.service';

/**
 * One question and its answer.
 *
 * <p>{@link needsFeature} and {@link needsModerator} let an entry disappear when it does not apply.
 * A help page that explains a button you do not have is worse than one that says nothing: the reader
 * goes looking for it and concludes the application is broken.
 */
interface FaqEntry {
  q: string;
  /** Plain sentences. Kept as text rather than HTML so nothing user-visible can inject markup. */
  a: string[];
  /** Hidden unless this feature is switched on for the reader. */
  needsFeature?: FeatureKey;
  /** Hidden from ordinary members. */
  needsModerator?: boolean;
  /** Extra words that should match in search but do not belong in the question itself. */
  keywords?: string;
}

interface FaqSection {
  title: string;
  blurb?: string;
  entries: FaqEntry[];
}

/**
 * Help and support: the questions people actually ask, and what to do when the answer is not here.
 *
 * <h2>How this relates to the help bubble</h2>
 * The floating widget answers "what was said about X at this meeting" — it searches the annual
 * report and the recordings. This page answers "how does this application work", which is a
 * different question with a fixed answer, and one that must still be readable when the AI service is
 * down or was never configured. So the content here is static and local: no request, no API key, no
 * failure mode.
 *
 * <h2>Why the content is filtered</h2>
 * Entries are hidden when the feature they describe is switched off, or when they only concern
 * moderators. Explaining a button the reader does not have sends them hunting for it and leaves them
 * thinking something is broken.
 *
 * <h2>Accessibility</h2>
 * Built from native {@code <details>}/{@code <summary>}, which give keyboard operation, correct
 * expanded/collapsed announcement and find-in-page for free. A hand-rolled accordion would have
 * needed all of that reimplemented, and usually gets the last one wrong.
 */
@Component({
  selector: 'app-help',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="container help-page">
      <header class="page-head">
        <h1>Help &amp; support</h1>
        <p class="muted sub">
          How this application works. For questions about what was <em>said</em> at a meeting, use
          the help bubble in the corner — it searches the report and the recordings.
        </p>
      </header>

      <div class="card search-card">
        <label class="field">
          <span class="sr-only">Search help topics</span>
          <input
            type="search"
            placeholder="Search help — try “change my vote” or “why can’t I sign in”"
            [value]="query()"
            (input)="query.set($any($event.target).value)"
            aria-describedby="search-count"
          />
        </label>
        <!-- Polite live region: the count updates as you type, and a screen reader should hear
             how many results there are without being interrupted mid-word. -->
        <p id="search-count" class="muted small" role="status">
          @if (query().trim()) {
            {{ matchCount() }} {{ matchCount() === 1 ? 'topic matches' : 'topics match' }} “{{ query() }}”.
          } @else {
            {{ totalCount() }} topics.
          }
        </p>
      </div>

      @if (query().trim() && matchCount() === 0) {
        <div class="card empty">
          <p>Nothing here matches that.</p>
          <p class="muted small">
            Try fewer words, or jump to <a href="#support">support</a> below.
          </p>
        </div>
      }

      @for (section of visibleSections(); track section.title) {
        <section class="card faq-section" [attr.aria-labelledby]="slug(section.title)">
          <h2 [id]="slug(section.title)" class="section-title">{{ section.title }}</h2>
          @if (section.blurb) {
            <p class="muted small blurb">{{ section.blurb }}</p>
          }

          @for (entry of section.entries; track entry.q) {
            <details class="faq" [open]="!!query().trim()">
              <summary>
                <span class="q">{{ entry.q }}</span>
                <span class="chev" aria-hidden="true"></span>
              </summary>
              <div class="a">
                @for (para of entry.a; track para) {
                  <p>{{ para }}</p>
                }
              </div>
            </details>
          }
        </section>
      }

      <section class="card support" id="support" aria-labelledby="support-heading">
        <h2 id="support-heading" class="section-title">Still stuck?</h2>
        <p class="muted small">
          Work down this list — most problems are solved by the first two.
        </p>

        <ol class="steps">
          <li>
            <strong>Reload the page.</strong>
            Sessions end after a period of inactivity, and an expired one can look like a broken
            button rather than a sign-in prompt.
          </li>
          <li>
            <strong>Check you are signed in as the right person.</strong>
            @if (auth.isAuthenticated()) {
              You are signed in as <strong>{{ auth.username() }}</strong
              >@if (roleSummary()) { , with the role {{ roleSummary() }} }.
            } @else {
              You are not signed in at the moment — <a routerLink="/login">sign in</a>.
            }
          </li>
          <li>
            <strong>Ask the organiser.</strong>
            Anything about who may vote, who is on the member list, or which meeting is live is set
            by the people running the meeting, not by the application.
          </li>
          <li>
            <strong>Ask the assistant.</strong>
            The help bubble searches the annual report and every indexed recording, and can draft an
            answer from what it finds.
          </li>
        </ol>

        <div class="links">
          <a routerLink="/security" class="link-card">
            <strong>Security &amp; sign-in</strong>
            <span class="muted small">Passwords, two-factor, active sessions</span>
          </a>
          @if (features.enabled('VOTING')) {
            <a routerLink="/voting" class="link-card">
              <strong>Voting</strong>
              <span class="muted small">The agenda and your ballot</span>
            </a>
          }
          @if (features.enabled('VIDEO_LIBRARY')) {
            <a routerLink="/recordings" class="link-card">
              <strong>Recordings</strong>
              <span class="muted small">Watch back, with captions</span>
            </a>
          }
        </div>
      </section>
    </div>
  `,
  styles: [
    `
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

      .help-page {
        --accent: #4c6ef5;
      }
      .page-head h1 {
        margin-bottom: 4px;
      }
      .sub {
        margin: 0;
        max-width: 62ch;
      }

      .search-card input {
        width: 100%;
        font-size: 15px;
        padding: 11px 14px;
      }
      .search-card .field {
        display: block;
        margin: 0 0 8px;
      }

      .section-title {
        margin: 0 0 4px;
        font-size: 16px;
      }
      .blurb {
        margin: 0 0 10px;
        max-width: 68ch;
      }

      .faq {
        border-top: 1px solid rgba(128, 128, 128, 0.22);
      }
      .faq:first-of-type {
        border-top: 0;
      }
      .faq summary {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 2px;
        cursor: pointer;
        font-weight: 600;
        list-style: none;
      }
      /* Safari draws its own disclosure triangle unless this is removed. */
      .faq summary::-webkit-details-marker {
        display: none;
      }
      .faq summary:focus-visible {
        outline: 3px solid var(--accent);
        outline-offset: 2px;
        border-radius: 6px;
      }
      .q {
        flex: 1;
      }
      .chev {
        flex: 0 0 auto;
        width: 9px;
        height: 9px;
        border-right: 2px solid currentColor;
        border-bottom: 2px solid currentColor;
        transform: rotate(45deg);
        opacity: 0.55;
        transition: transform 0.18s ease;
      }
      .faq[open] .chev {
        transform: rotate(-135deg);
      }
      .a {
        padding: 0 2px 14px;
        max-width: 72ch;
      }
      .a p {
        margin: 0 0 9px;
      }
      .a p:last-child {
        margin-bottom: 0;
      }

      .steps {
        margin: 8px 0 16px;
        padding-left: 22px;
        max-width: 72ch;
      }
      .steps li {
        margin-bottom: 9px;
      }

      .links {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      .link-card {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 12px 16px;
        border-radius: 12px;
        border: 1px solid rgba(128, 128, 128, 0.32);
        text-decoration: none;
        min-width: 190px;
        transition: border-color 0.15s, transform 0.15s;
      }
      .link-card:hover {
        border-color: var(--accent);
      }
      .link-card:focus-visible {
        outline: 3px solid var(--accent);
        outline-offset: 2px;
      }

      .empty {
        text-align: center;
      }

      @media (prefers-reduced-motion: reduce) {
        .chev,
        .link-card {
          transition: none;
        }
      }
    `,
  ],
})
export class HelpComponent {
  readonly auth = inject(AuthService);
  readonly features = inject(FeatureService);

  readonly query = signal('');

  /**
   * The whole catalogue.
   *
   * <p>Held in the component rather than fetched, deliberately. Help has to work when the network
   * is unhappy or the AI service is asleep — those are exactly the moments somebody opens it.
   */
  private readonly sections: FaqSection[] = [
    {
      title: 'Getting started',
      entries: [
        {
          q: 'What is this application for?',
          a: [
            'It collects questions from everyone attending a meeting, groups the ones that are really the same question, and helps whoever is running the meeting answer them properly rather than repeating themselves twenty times.',
            'Around that sit the pieces a meeting actually needs: recordings you can watch back, formal voting, and a record of what was decided.',
          ],
          keywords: 'purpose overview what does this do',
        },
        {
          q: 'Do I need an account?',
          a: [
            'To ask a question, no — you can join with just a display name.',
            'To vote, yes. Voting needs a registered account, because an anonymous pass proves nothing about who you are and a ballot has to know. The same goes for the Lounge and the recordings.',
          ],
          keywords: 'sign up register anonymous attendee login account',
        },
        {
          q: 'Why can I see fewer things than a colleague?',
          a: [
            'Two reasons. Features can be switched on and off per deployment by an administrator, and each one can be limited to particular roles.',
            'So a menu entry missing for you but present for someone else usually means either the feature is restricted to their role, or they hold a duty you do not — such as managing meetings.',
          ],
          keywords: 'missing menu permissions role feature flag hidden',
        },
      ],
    },
    {
      title: 'Asking questions',
      entries: [
        {
          q: 'Someone has already asked my question. Should I ask it anyway?',
          a: [
            'Yes, go ahead. Questions that mean the same thing are grouped automatically, and a bigger group is a stronger signal that it deserves an answer.',
            'Asking again does not annoy anybody — it is how the meeting works out what matters.',
          ],
          keywords: 'duplicate same question cluster repeat',
        },
        {
          q: 'What happens to my question after I submit it?',
          a: [
            'It is grouped with similar questions, and a draft answer is prepared straight away so whoever is running the meeting is not starting from a blank page.',
            'If the drafting service is unavailable, the question is still recorded and flagged for a person to answer by hand. Nothing is lost.',
          ],
          keywords: 'draft answer what happens next moderator',
        },
        {
          q: 'Can I see the answer later?',
          a: [
            'Yes. Answers stay on the board, and if the session was recorded you can watch the moment it was answered.',
          ],
          keywords: 'answer later transcript recording',
        },
      ],
    },
    {
      title: 'Voting',
      blurb:
        'Formal decisions at a meeting are put as “resolutions” — motions with exact wording that members vote on.',
      entries: [
        {
          q: 'Why can I see the agenda but not vote?',
          a: [
            'Voting is limited to people on the meeting’s member list, and that list is maintained by whoever organises the meeting.',
            'If you should be on it and are not, ask the organiser to add you. Nobody using the application can add themselves — that is the point of the list.',
          ],
          needsFeature: 'VOTING',
          keywords: 'cannot vote not entitled member list eligible',
        },
        {
          q: 'What does “abstain” mean? Is it the same as not voting?',
          a: [
            'No. Abstaining means “I am here and taking part, but I am not taking a side”.',
            'It counts towards quorum, because you were present and participating. It is left out of the majority calculation entirely, so abstaining neither helps nor hinders a motion.',
          ],
          needsFeature: 'VOTING',
          keywords: 'abstain abstention meaning difference',
        },
        {
          q: 'Can I change my vote?',
          a: [
            'Yes, as long as the vote is still open. Choosing again replaces your earlier choice — you never end up with two votes recorded.',
            'Once the chair closes the vote, the result is fixed and cannot be changed.',
          ],
          needsFeature: 'VOTING',
          keywords: 'change vote recast amend undo',
        },
        {
          q: 'Why can’t I see the results while voting is open?',
          a: [
            'Because a running count changes the votes still to come, which is exactly why a show of hands is taken all at once.',
            'The chair can choose to publish the count early. Unless they do, results appear when the vote closes.',
          ],
          needsFeature: 'VOTING',
          keywords: 'results hidden not published live count tally',
        },
        {
          q: 'Why does my vote count more than someone else’s?',
          a: [
            'Votes are usually weighted by shareholding: a member holding a thousand shares casts a thousand votes rather than one.',
            'Your entitlement is set by the organiser on the meeting’s member list. It is never sent by your browser, so it cannot be altered from your side.',
          ],
          needsFeature: 'VOTING',
          keywords: 'weight shares entitlement weighted voting',
        },
        {
          q: 'What is the difference between an ordinary and a special resolution?',
          a: [
            'An ordinary resolution passes on a simple majority — more votes for than against.',
            'A special resolution needs at least 75% of the votes cast, and is used for weightier decisions such as changing the company’s constitution. Exactly 75% is enough to carry.',
          ],
          needsFeature: 'VOTING',
          keywords: 'ordinary special majority 75% threshold type',
        },
        {
          q: 'What is quorum, and why does it say “not met”?',
          a: [
            'Quorum is the minimum share of the register that has to be taking part for the meeting’s decisions to be valid at all. A vote taken without quorum does not count, however lopsided the result.',
            'It rises as members vote — including members who abstain. “Not met” usually just means not enough people have voted yet.',
          ],
          needsFeature: 'QUORUM',
          keywords: 'quorum not met threshold represented',
        },
        {
          q: 'How do I put a motion to the meeting?',
          a: [
            'On the Voting page, fill in the title and the exact wording, choose whether it is ordinary or special, and add it to the agenda. It starts as a draft that only you can see.',
            'When you are ready, open the floor. Wording cannot be edited once voting has started — members vote on the text in front of them, so changing it underneath a cast vote would misrepresent what they agreed to. Withdraw it and put a new one instead.',
          ],
          needsFeature: 'VOTING',
          needsModerator: true,
          keywords: 'create resolution motion agenda chair open close',
        },
      ],
    },
    {
      title: 'Recordings',
      entries: [
        {
          q: 'Why does a recording say “processing”?',
          a: [
            'An uploaded video is converted into small chunks at several qualities, so it starts quickly and adapts to your connection. That takes a few minutes and the progress is shown while it runs.',
            'You can leave the page — processing continues on the server.',
          ],
          needsFeature: 'VIDEO_LIBRARY',
          keywords: 'processing transcode percent stuck upload',
        },
        {
          q: 'Does it remember where I stopped watching?',
          a: [
            'Yes. Reopening a recording offers to continue from where you left off, and only downloads the part of the video it needs to resume.',
          ],
          needsFeature: 'VIDEO_LIBRARY',
          keywords: 'resume continue where left off position',
        },
        {
          q: 'Are there captions or a transcript?',
          a: [
            'Where a transcript exists, captions can be turned on in the player and the text is searchable.',
            'A search result inside a recording carries the moment it was said, so following it opens the player at that point rather than at the beginning.',
          ],
          needsFeature: 'VIDEO_LIBRARY',
          keywords: 'captions subtitles transcript vtt search timestamp',
        },
      ],
    },
    {
      title: 'Account and security',
      entries: [
        {
          q: 'I was signed out without doing anything. Why?',
          a: [
            'Sessions end after a period of inactivity. Any activity extends them, so this only happens when the page has genuinely been left alone.',
            'Signing in again picks up where you were.',
          ],
          keywords: 'signed out session timeout expired logged out inactivity',
        },
        {
          q: 'How do I turn on two-factor authentication?',
          a: [
            'On the Security page. It is worth doing for any account that can run a meeting or change a result.',
          ],
          keywords: '2fa mfa two factor authenticator totp security',
        },
        {
          q: 'Who can see that I voted, and how?',
          a: [
            'Your own vote is always shown back to you. Whoever is running the meeting can see the tally, and once a vote closes the result is part of the meeting’s record.',
            'Votes are recorded against your account, because a vote that could not be attributed could not be audited either.',
          ],
          needsFeature: 'VOTING',
          keywords: 'privacy anonymous secret ballot who can see',
        },
      ],
    },
    {
      title: 'For moderators',
      entries: [
        {
          q: 'How do I switch a feature on or off?',
          a: [
            'An administrator can do it on the Features page, without a deploy. Each feature can also be limited to particular roles.',
            'Roles there are a ceiling, never a grant: listing a role cannot let anyone reach something they could not reach before.',
          ],
          needsModerator: true,
          keywords: 'feature flag enable disable toggle admin',
        },
        {
          q: 'Only one meeting can be active. Why?',
          a: [
            'Because attendees submit to whichever meeting is live, so “the live meeting” has to be unambiguous.',
            'Activating a meeting closes whichever one was live before, in a single step. A closed meeting stays closed — its questions and recordings are the record of what happened.',
          ],
          needsModerator: true,
          keywords: 'active meeting one at a time activate close',
        },
        {
          q: 'What happens when I delete a meeting or a recording?',
          a: [
            'Everything attached to it goes too: for a meeting, its member list and its ballot; for a recording, its video chunks, poster, captions and index.',
            'An active meeting cannot be deleted, and neither can a closed resolution — a recorded decision is not something the application should make easy to erase.',
          ],
          needsModerator: true,
          keywords: 'delete remove cascade meeting video permanent',
        },
      ],
    },
  ];

  /** Every entry the current reader is allowed to see, before any search is applied. */
  private readonly permitted = computed<FaqSection[]>(() => {
    const moderator = this.auth.isModerator();
    return this.sections
      .map((section) => ({
        ...section,
        entries: section.entries.filter((e) => {
          if (e.needsModerator && !moderator) return false;
          if (e.needsFeature && !this.features.enabled(e.needsFeature)) return false;
          return true;
        }),
      }))
      .filter((section) => section.entries.length > 0);
  });

  /**
   * Sections after searching.
   *
   * <p>Plain substring matching over the question, the answer and the extra keywords. Deliberately
   * not the semantic search used elsewhere: this content is small and local, and an offline help
   * page that needs a working model service to find "change my vote" would fail at the one moment
   * it is most needed.
   */
  readonly visibleSections = computed<FaqSection[]>(() => {
    const needle = this.query().trim().toLowerCase();
    if (!needle) return this.permitted();

    // Every word has to appear somewhere in the entry, so extra words narrow rather than widen.
    const words = needle.split(/\s+/);
    return this.permitted()
      .map((section) => ({
        ...section,
        entries: section.entries.filter((e) => {
          const haystack = `${e.q} ${e.a.join(' ')} ${e.keywords ?? ''} ${section.title}`.toLowerCase();
          return words.every((w) => haystack.includes(w));
        }),
      }))
      .filter((section) => section.entries.length > 0);
  });

  readonly matchCount = computed(() =>
    this.visibleSections().reduce((n, s) => n + s.entries.length, 0),
  );

  readonly totalCount = computed(() =>
    this.permitted().reduce((n, s) => n + s.entries.length, 0),
  );

  /** A readable description of who the reader is, for the "check who you are" step. */
  readonly roleSummary = computed(() => {
    const roles = this.auth.roles();
    return roles.length ? roles.join(', ') : '';
  });

  /** Section titles become heading ids, so each section can label its own region. */
  slug(title: string): string {
    return 'faq-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  }
}
