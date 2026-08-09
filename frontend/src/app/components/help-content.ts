/**
 * The help catalogue — every question the application can answer about itself.
 *
 * <h2>Why this is a module and not part of the help page</h2>
 * Two surfaces show this content: the full Help &amp; support page, and the help bubble that floats
 * on every screen. The page is lazy-loaded, so the bubble importing it would pull the entire page
 * into the initial bundle for everyone, whether or not they ever open help. A plain data module
 * costs nothing to share.
 *
 * <h2>Why it is held here rather than fetched</h2>
 * Help has to work when the network is unhappy or the AI service is asleep — those are precisely
 * the moments somebody opens it. Content that needed a working backend to explain why the backend
 * is not working would be useless exactly when it is needed.
 *
 * <p>Distinct from the RAG knowledge base, which holds the COMPANY's documents (annual reports,
 * transcripts). That answers "what dividend was declared"; this answers "how do I run a meeting".
 * Conflating the two is why asking the bubble about application flow used to return balance-sheet
 * extracts.
 */
import { FeatureKey } from '../services/feature.service';

export interface FaqEntry {
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

export interface FaqSection {
  title: string;
  blurb?: string;
  entries: FaqEntry[];
}

export const HELP_SECTIONS: FaqSection[] = [
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
        q: 'How does the whole thing work, start to finish?',
        keywords: 'flow process steps end to end overview pipeline lifecycle journey how it works stages',
        a: [
          'Someone sets up a meeting and makes it active, then uploads the documents the meeting will be answered from — usually the annual report, and any recordings worth searching.',
          'Attendees submit questions. The application reads each one and groups it with the questions that are really asking the same thing, so twenty phrasings of the same concern become one topic rather than twenty items on a list.',
          'Whoever is chairing sees those topics ranked by how many people asked and how strongly they backed them. They can draft an answer for a topic, grounded in the uploaded documents with citations, edit it, and publish it to the room.',
          'If there are resolutions to decide, they are put to the meeting, the ballot opens, votes are cast and weighted by holding, and quorum and the result are worked out for you.',
          'At the end the meeting report gathers all of it — the questions, what was answered, what was not, and how every resolution went.',
        ],
      },
      {
        q: 'I am running a meeting. What do I do, in order?',
        keywords: 'moderator chair steps order walkthrough guide run conduct organise prepare setup before during after',
        a: [
          'Before: create the meeting and activate it, add the members who may vote along with their holdings, and upload the documents under Knowledge base. Only one meeting is active at a time, and everything else follows whichever one that is.',
          'During: watch the board as questions arrive and group themselves. Order the topics you intend to cover, draft and publish answers, and put any resolutions to the meeting when you reach them.',
          'After: close the ballot so the result is final, then open the meeting report for the record of what was asked, answered and decided.',
        ],
      },
      {
        q: 'Which screen do I use for what?',
        keywords: 'navigation menu pages where find screen tab section layout',
        a: [
          'Ask a question and see published answers: the room. Everyone can reach it.',
          'The ranked topics, drafting and publishing: the moderator board.',
          'Resolutions, the ballot and quorum: Voting.',
          'Meetings, members and holdings: Meetings. Documents to answer from: Knowledge base. Both are for whoever is organising.',
          'What the deployment can do at all, and for which roles: Features, which is the administrator’s.',
          'If a menu entry is missing, it is either switched off for this deployment or not meant for your role — see the question above about seeing fewer things than a colleague.',
        ],
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
