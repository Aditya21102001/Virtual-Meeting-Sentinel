# Running a Meeting — Features, Flags, Voting and the Record

Everything the application does **during and after** a meeting, and the switches that control it.

For how a question becomes a clustered topic with a drafted answer, see
[HOW_IT_WORKS.md](HOW_IT_WORKS.md). For recordings, see [VIDEO_LIBRARY.md](VIDEO_LIBRARY.md). This
document covers what was added on top of those: meetings, feature flags, voting, curation, the room,
and reports.

---

## Table of contents

1. [Feature flags — the switchboard](#1-feature-flags--the-switchboard)
2. [Meetings and membership](#2-meetings-and-membership)
3. [Roles](#3-roles)
4. [Voting, resolutions and quorum](#4-voting-resolutions-and-quorum)
5. [Cluster curation — fixing the grouping](#5-cluster-curation--fixing-the-grouping)
6. [The room — attendee board, upvoting, run of show](#6-the-room--attendee-board-upvoting-run-of-show)
7. [Reports and minutes](#7-reports-and-minutes)
8. [Sessions and inactivity](#8-sessions-and-inactivity)
9. [Data model](#9-data-model)
10. [API surface](#10-api-surface)
11. [Security notes worth knowing](#11-security-notes-worth-knowing)
12. [Known limits](#12-known-limits)

---

## 1. Feature flags — the switchboard

Every capability below can be switched on or off by an **ADMIN** at `/features`, without a deploy,
and each can be narrowed to particular roles.

### The catalogue is the source of truth

`Feature` (a Java enum) holds every feature's key, label, description, default state and default
roles. The database stores **only what an admin changed**. A feature with no row simply behaves as it
ships.

That is what lets a new capability deploy dark: the flags arrive, nothing changes, and each one is
switched on deliberately when somebody is ready to watch it. Adding a feature is one enum constant —
the admin screen populates itself.

### Defaults are split on purpose

| Ship state | Features |
| --- | --- |
| **On** (already shipped before flags existed) | `VIDEO_LIBRARY`, `VIDEO_ENGAGEMENT`, `VIDEO_DOWNLOAD`, `LOUNGE_CHAT`, `AI_DRAFTING` |
| **Off** (everything new) | `MEETINGS`, `SEMANTIC_SEARCH`, `HELP_WIDGET`, `AUTO_TRANSCRIPTION`, `VOTING`, `QUORUM`, `CLUSTER_UPVOTE`, `CLUSTER_CURATION`, `RUN_OF_SHOW`, `MEETING_REPORTS`, `ATTENDEE_BOARD` |

> **Testing note.** Because the new ones default off, a fresh deployment shows none of them. Enable
> them at `/features` as an admin or the pages will not appear. This is the design working, but it
> surprises people who go looking for a menu entry.

### How enforcement works

`@RequiresFeature(Feature.X)` on a controller or method, checked by one `HandlerInterceptor`.

Declarative rather than a call at the top of each method, because the imperative version fails
**silently**: forget the check and the endpoint stays live with the feature off, which is precisely
what a flag exists to prevent.

Three properties that are easy to get wrong:

- **Annotations are ANDed, never ORed.** Class-level and method-level combine, and a method may carry
  two. A route guarded by two features needs both. Treating the list as alternatives would make
  adding a second guard *weaken* the first.
- **Roles are a ceiling, never a grant.** Spring Security is checked first and independently. Listing
  a role on a feature cannot let anyone reach something they could not reach before.
- **Disabled returns 404, not 403.** "You are not allowed" confirms the feature exists. "There is
  nothing here" does not.

### The repeatable annotation

`@RequiresFeature` is `@Repeatable`. Before it was, "needs both" could only be expressed by putting
one annotation on the class and the other on the method — which made a security property depend on
where a piece of code happened to sit. Move the method and one requirement vanishes silently.

```java
@RequiresFeature(Feature.VOTING)
@RequiresFeature(Feature.QUORUM)
@PostMapping("/meeting-quorum")
```

⚠️ The interceptor uses `getAnnotationsByType`, **not** `getAnnotation`. The plain getter returns
`null` when an element carries repeated annotations — using it would disable the guard on exactly the
routes asking for the most protection.

### The coverage test

`FeatureCoverageTest` walks every `@RestController` and asserts each catalogue entry is guarded
somewhere. `AUTO_TRANSCRIPTION` is an explicit allow-list entry (it runs on a background worker after
upload, so there is no route to annotate).

This exists because seven of sixteen flags were once decorative — toggleable in the admin screen,
ignored by the backend. A flag that hides a menu entry while leaving the endpoint live is worse than
no flag, because the administrator reasonably believes the capability is gone.

`HELP_WIDGET` is mostly UI, but it is still enforced on the server: `semantic-search` requires it
*as well as* `SEMANTIC_SEARCH`, because that route exists to serve the widget. If another surface
ever needs semantic search, give it its own route gated on `SEMANTIC_SEARCH` alone rather than
loosening that one.

---

## 2. Meetings and membership

A **meeting** is the thing everything else belongs to. Before it existed the application had no
notion of *which* meeting a question or recording was part of — everything was global, and a second
meeting would have piled its questions on top of the first one's board.

### One active at a time

Attendees submit to whichever meeting is live, so "the active meeting" has to be unambiguous.

Enforced by a **partial unique index**, not by application logic:

```sql
CREATE UNIQUE INDEX meetings_one_active_idx ON meetings (status) WHERE status = 'ACTIVE';
```

The service reads, swaps and writes in one transaction — but only the database can promise that two
managers pressing *Activate* in the same instant do not both succeed. The loser gets a 409 telling
them to reload.

Activating a meeting **closes** whichever was live. Closing rather than returning it to DRAFT: a
meeting that has run has questions attached, and "not started yet" would be a lie about something
that already happened. A closed meeting stays closed.

### Membership

`meeting_members` maps usernames to a meeting. Usernames are stored as **text with no foreign key** —
attendees can be invited before they have ever signed in, and an invitation list that could only hold
existing rows would be useless for the case it exists for.

Two fields worth understanding:

| Field | Meaning |
| --- | --- |
| `role_in_meeting` | ATTENDEE / PANELLIST / CHAIR. **Descriptive, grants nothing.** Authorisation always comes from the application roles. |
| `voting_weight` | Shares held, or 1 for one-member-one-vote. Also their share of quorum. |

`voting_weight` lives on the **membership**, not the user, because entitlement is per meeting — the
same person may hold a different number of shares at the next one. It is set by a user manager and
**never sent by the voter**: a weight the client could supply is a weight the client could inflate.

Adding a member is idempotent — re-adding updates their role and weight rather than failing. Leaving
the weight field blank leaves an existing member's entitlement alone; `0` deliberately means "listed
but holding no vote".

---

## 3. Roles

### Primary roles — one per user, on `app_users.role`

| Role | What it is |
| --- | --- |
| `ADMIN` | Full control, including assigning roles and switching features |
| `MODERATOR` | Runs the board — clusters, drafts, the run of show |
| `SHAREHOLDER` | A registered member: the Lounge, recordings, **voting** |
| `ATTENDEE` | Ephemeral anonymous pass for asking questions. No user row. |

### Additional roles — any number per user, in `user_roles`

| Role | Duty |
| --- | --- |
| `MEETING_MANAGER` | Creates meetings, decides which is active |
| `USER_MANAGER` | Maps users to meetings and sets entitlements |

Separate on purpose so a MODERATOR can also manage meetings. Folding them into the primary role would
force a choice between running the board and scheduling the meeting it belongs to — two jobs the same
person routinely does.

Granting these is **ADMIN only**. A moderator promoting themselves to meeting manager would make the
separation of duties decorative.

> The JWT carries both a `role` claim and a `roles` claim. `refresh()` carries the full set forward —
> without that, extra roles would silently disappear within minutes of signing in.

---

## 4. Voting, resolutions and quorum

> Flags: `VOTING`, `QUORUM`. Both default **off**.

### What the domain means

A **resolution** is a motion put to the meeting: a title plus the exact wording, such as *"That the
accounts for the year ended 31 March be received and adopted."* The chair opens the floor, members
vote, the chair closes it, and the outcome is recorded. That record is the point of the exercise.

Members vote one of three ways:

- **FOR** — in favour
- **AGAINST** — opposed
- **ABSTAIN** — *"I am here and taking part, but I am not taking a side."*

Abstaining is **not** the same as not voting. It counts towards quorum — the member was present and
participating — and is excluded from the majority entirely, so it neither helps nor hinders.

Votes are **weighted** by shareholding: a member holding 1,000 shares casts 1,000 votes.

| Type | Carries when |
| --- | --- |
| `ORDINARY` | More votes for than against (a tie fails) |
| `SPECIAL` | At least 75% of votes cast. **Exactly 75% carries.** |

### The rules the code enforces

**1. Only an OPEN resolution accepts a vote.** A vote outside the window is invalid rather than late.

**2. Entitlement comes from the member list, never the request.** A vote request carries the
resolution and the choice — that is all. Who is voting comes from the token; how much it is worth
comes from the server.

**3. One vote per member per resolution**, enforced by a unique constraint rather than a service
check. Two requests arriving together — a double tap, a client retry — would both find no existing
row and both insert. On a constraint violation the service re-reads and treats it as the change of
vote it effectively is.

**4. The weight is copied onto the vote**, not looked up at tally time. It is the entitlement *at the
moment they voted*. If a holding is corrected later, votes already cast must not silently re-weight
themselves — a recorded result would change after the fact with nothing to show for it.

**5. Wording cannot change once voting starts.** Members voted on the text in front of them.
Withdraw the motion and put a new one. Ordering and result visibility stay editable — neither changes
what is being decided.

**6. Closed is final.** Reopening would let a result be revised after members had seen it.

### Carried is integer arithmetic

```java
ORDINARY: forWeight > againstWeight
SPECIAL:  forWeight > 0 && forWeight * 4 >= (forWeight + againstWeight) * 3
```

Deciding by comparing a computed percentage against a threshold puts a binary rounding error on
exactly the boundary that matters: 3 for and 1 against is *precisely* 75%, and whether that carries
must not depend on how the division rounded.

The `forWeight > 0` guard is load-bearing. Without it, `0 >= 0` reports an **unvoted motion as
carried**.

`ResolutionTypeTest` covers both boundaries, the tie, the empty case and all-against.

### Results are withheld while voting is open

Unless the chair publishes them. A running tally changes the votes still to come — which is why a
show of hands is taken all at once.

The `result` field is **null** in that case rather than zeroed. An all-zero tally is
indistinguishable from "nobody has voted", so the UI must say *"results are not published yet"*
rather than implying no support.

### Quorum

The minimum share of the register that must be taking part for the meeting's decisions to be valid at
all. A vote taken without quorum does not count, however lopsided.

```
represented = Σ voting_weight of members who cast at least one vote in this meeting
total       = Σ voting_weight of all members mapped to the meeting
met         = total > 0 && represented / total >= meetings.quorum_threshold_percent
```

Participation, not agreement — **an abstention counts**. The threshold is per meeting (default 25%)
because it is set by a company's articles, not by convention.

Computed in **one query** joining through the member list, not by listing voters and looking each one
up. Joining through membership is also what makes the number trustworthy: summing weights off the
votes themselves would count anyone whose entitlement had since been removed.

A meeting with nobody mapped has **no** quorum, rather than a vacuous 100%.

---

## 5. Cluster curation — fixing the grouping

> Flag: `CLUSTER_CURATION`. Defaults **off**.

Questions are grouped automatically by meaning, and automatic grouping is wrong in both directions:
it splits one topic phrased two ways, and lumps two topics together because they share vocabulary.
Until this existed, a moderator could see that and do nothing.

### Merge is durable; split is a one-off

**This asymmetry is the important thing**, and it comes from where the maths lives.

The AI service owns the centroids and assigns every **incoming** question to the nearest one. So a
merge cannot just move rows:

```
1. Moderator merges "when is the dividend paid" into "dividend timing"
2. Next attendee asks about the dividend
3. AI service assigns them to the centroid it still has
4. The cluster that was merged away reappears
```

The merge would quietly undo itself — worse than not offering the button.

So a merge also writes a **`cluster_merges` redirect**, and every cluster id coming back from the AI
service is resolved through it before anything is recorded. It keeps applying to questions nobody has
asked yet.

> Resolution happens in `QuestionService.submit`, `submitBulk` **and** `queueDraft`. Miss any one and
> the merged-away cluster comes back through that path.

A **split** cannot work that way. Pulling three questions out of a cluster gives the clusterer nothing
to act on — there is no new centroid, and no way to express "questions like these three" without
doing the vector maths in the backend. So a split separates the questions **already asked**, and
future similar ones land wherever the clusterer puts them. The UI says so rather than implying more.

### Chains and cycles

Merging B into A and later A into C leaves `B → A → C`. Resolution follows the chain to its end
rather than rewriting old rows, so the history of what was merged into what stays readable.

`merge()` refuses to close a cycle, and `resolve()` still guards against one with a hop limit and a
seen-set — the data could be edited by hand, and an infinite loop in the path *every incoming
question travels* would take the whole board down. `ClusterCurationServiceResolveTest` covers
single hops, chains, cycles and over-long chains.

### What a merge carries with it

| Thing | What happens |
| --- | --- |
| Questions | Reassigned in one bulk statement |
| Upvotes | Moved — **duplicates dropped first**, or the one-per-person constraint fails the whole merge |
| Machine-written draft | **Reset to PENDING.** It answered a different set of questions. |
| Hand-written answer | **Never touched** (see below) |
| Source draft row | Deleted |

**A moderator's own answer is never overwritten.** That invariant holds across the application, and
curation is not the place to break it: someone who wrote an answer by hand and then tidied up the
grouping would lose their work *to the tidying*, which teaches them not to tidy up. Their answer
stays; the size beside it tells them whether it still fits.

---

## 6. The room — attendee board, upvoting, run of show

> Flags: `ATTENDEE_BOARD`, `CLUSTER_UPVOTE`, `RUN_OF_SHOW`. All default **off**.

Three capabilities that share one service, because they are three views of the same list of topics.

### The safety property that shapes all of it

**Answers are not shown to attendees until a moderator publishes them.**

Nearly every answer on the board was drafted by a model and read by nobody. Showing those to a room
of shareholders would attribute to the company something it never said — at an AGM that is not a
presentation bug, it is a statement on the record.

So publishing is always deliberate, opt-in and reversible (`cluster_drafts.published_at`). Publishing
an empty answer is refused: the attendee board would show the topic with nothing under it, which
reads as *"we answered this"*.

⚠️ The moderator's view returns **unpublished** answers too. So `published` is carried as an explicit
field — inferring it from "has an answer" marks every drafted answer as published, and a moderator
trusting that would believe the room had seen answers it never did.

### Upvoting

Attendees who see their question already on the board otherwise have one way to add weight to it:
type it out again and hope the clusterer groups the two. That is effort for them, another embedding
for the AI service, and a grouping decision that might go wrong. An upvote is one tap into exactly
the right place.

Deliberately a **separate signal** from asking. Questions carry a shareholder weight and drive the
drafting pipeline; an upvote is a bare show of hands. Separate tables let the board say *"asked by 4,
supported by 30"* rather than blurring them into one number that means neither.

It **toggles** — tapping again withdraws. A count that can only go up only ever drifts.

> **Why anonymous identity is acceptable here and not for voting.** An attendee pass is
> self-asserted: anybody can claim any name. That is fine for ranking a discussion topic, which
> decides nothing. It is fatal for a resolution — see §11.

### Run of show

The order the chair intends to take topics in, and how long each took. Stored on `cluster_drafts`
(`run_order`, `discussion_started_at`, `discussion_ended_at`) rather than a separate agenda table: a
cluster **is** the topic, so a second table would hold a pointer back plus an integer, and would then
have to be kept in step through every merge and split.

Starting a topic **closes whatever was running**. A chair moving on has finished with the previous
topic, and requiring them to say so twice means the timings only record correctly when they remember.

The board is ordered by the run of show where one is set, and by demand otherwise — so it is useful
before anyone has organised it, which is most of the time.

---

## 7. Reports and minutes

> Flag: `MEETING_REPORTS`. Defaults **off**. MODERATOR/ADMIN only.

A meeting produces a record whether or not the software helps: what was asked, what was answered,
what was decided. Everything needed is already stored, so reconstructing it afterwards from the board
and a notepad was work the application was creating for people.

Assembled **on demand** from rows that are themselves the source of truth — a stored copy would only
be one more thing that could disagree with them.

Two shapes from one assembler, so screen and file cannot drift apart:

- `meeting-report` → JSON for the screen
- `download-minutes` → Markdown as a file attachment

Markdown rather than PDF: it reads fine as plain text, pastes into any editor with structure intact,
and needs no rendering library on a container already short of memory. Print it if you want a PDF.

### What it refuses to hide

**Unanswered questions get their own section, near the top.** That is the part people actually need
after a meeting, and the part most easily lost. Sorted most-asked first — which is also the order to
chase them in.

**Quorum failure is stated in words.** If quorum was not met, the report says *"Business transacted
at this meeting may not be valid"* rather than leaving the reader to infer it from two percentages.
It is the single most important sentence in the document.

**Coverage gaps are disclosed.** Questions asked before the application recorded which meeting they
belonged to carry no meeting, and always will. They are counted separately — including them would
credit this meeting with another's questions; omitting them silently would understate what the system
holds.

> **Prerequisite fix.** Questions never recorded their meeting, so a per-meeting report had nothing
> to filter on. `QuestionService` now stamps the active meeting on submit. It is deliberately not
> required — a question asked with no meeting live is still accepted, and null honestly means "we do
> not know".

Per-cluster counts are **scoped to the meeting**, so a topic carried over from an earlier meeting
does not inflate this one's numbers.

---

## 8. Sessions and inactivity

Sessions end after a period of **inactivity**, not a fixed lifetime. Any activity extends them.

The JWT carries an `ost` (original session start) claim. `refresh-session` requires a live session —
declared ahead of the public `/api/auth/**` rule, because an expired session that could still renew
itself would not be a timeout.

`refresh()` carries the **full role set** forward. Without that, additional roles would vanish within
minutes.

---

## 9. Data model

Additions on top of the model in [ARCHITECTURE.md §7](ARCHITECTURE.md#7-data-model).

```
meetings(id, title, description, scheduled_at, status, quorum_threshold_percent,
         created_by, activated_at, closed_at, created_at, updated_at)
  └─ UNIQUE INDEX WHERE status = 'ACTIVE'          -- one live meeting, enforced by the database

meeting_members(id, meeting_id→meetings, username, role_in_meeting, voting_weight, added_by, created_at)
  └─ UNIQUE (meeting_id, username)

user_roles(user_id→app_users, role)                -- MEETING_MANAGER | USER_MANAGER
  └─ UNIQUE (user_id, role)

feature_flags(feature_key PK, enabled, updated_by, updated_at)   -- only what an admin CHANGED
feature_flag_roles(feature_key→feature_flags, role)
  └─ UNIQUE (feature_key, role)

resolutions(id, meeting_id→meetings, seq, title, text, type, status,
            live_results_visible, opened_at, closed_at, created_by, created_at, updated_at)

votes(id, resolution_id→resolutions, meeting_id→meetings, username, choice, weight, cast_at)
  └─ UNIQUE (resolution_id, username)              -- one vote per member, enforced by the database

cluster_merges(source_cluster_id PK, target_cluster_id, source_question, merged_by, merged_at)

cluster_upvotes(id, cluster_id, voter_id, created_at)
  └─ UNIQUE (cluster_id, voter_id)

cluster_drafts  += published_at, run_order, discussion_started_at, discussion_ended_at
questions       += meeting_id (nullable)
```

Three constraints do real work rather than documenting intent:

| Constraint | Prevents |
| --- | --- |
| `meetings_one_active_idx` | Two managers both believing they activated a meeting |
| `votes_one_per_member` | A double tap counting twice in a legal record |
| `cluster_upvotes_one_per_person` | The one number attendees move directly drifting upward |

`votes.meeting_id` is denormalised from the resolution so quorum is one query over votes rather than
a join back through every resolution on the agenda.

DDL with the reasoning written out is in [`ai-service/db/init.sql`](../ai-service/db/init.sql).
Hibernate runs `ddl-auto: update`, so the tables also appear on first boot.

---

## 10. API surface

All POST with identifiers in the body — the network panel labels a request by its last path segment,
so `activate-meeting` is readable where `/api/meetings/{uuid}` was a column of indistinguishable ids.

### Features — `/api/features`

| Path | Role | Purpose |
| --- | --- | --- |
| `my-features` | any signed-in | Keys this caller may use (drives the SPA) |
| `list-features` | ADMIN | Full state for the admin screen |
| `set-feature` | ADMIN | Toggle + set allowed roles |
| `reset-feature` | ADMIN | Drop the override, return to shipped default |
| `assignable-roles` | ADMIN | Roles the screen can offer |

### Meetings — `/api/meetings` · flag `MEETINGS`

| Path | Role |
| --- | --- |
| `active-meeting` | any signed-in |
| `list-meetings`, `list-members` | MEETING_MANAGER / USER_MANAGER / ADMIN |
| `add-member`, `remove-member` | USER_MANAGER / ADMIN |
| `create-`, `update-`, `activate-`, `close-`, `delete-meeting` | MEETING_MANAGER / ADMIN |

### Voting — `/api/voting` · flag `VOTING`

| Path | Role |
| --- | --- |
| `list-resolutions`, `resolution-details`, `cast-vote`, `my-vote` | SHAREHOLDER / MODERATOR / ADMIN |
| `meeting-quorum` | same, **+ flag `QUORUM`** |
| `create-`, `update-`, `open-`, `close-`, `delete-resolution` | MODERATOR / ADMIN |

### Curation — `/api/clusters` · flag `CLUSTER_CURATION`

| Path | Purpose |
| --- | --- |
| `cluster-questions` | What is actually in a group, plus what was merged in |
| `merge-clusters` | Fold one group into another (durable) |
| `split-cluster` | Separate chosen questions out (one-off) |
| `move-question` | Move a single misfiled question |

### The room — `/api/room`

| Path | Role | Flag |
| --- | --- | --- |
| `attendee-board` | ATTENDEE / SHAREHOLDER / MODERATOR / ADMIN | `ATTENDEE_BOARD` |
| `support-topic` | same | `CLUSTER_UPVOTE` |
| `run-of-show`, `set-run-order`, `start-topic`, `end-topic` | MODERATOR / ADMIN | `RUN_OF_SHOW` |
| `publish-answer` | MODERATOR / ADMIN | `ATTENDEE_BOARD` |

### Reports — `/api/reports` · flag `MEETING_REPORTS` · MODERATOR/ADMIN

| Path | Purpose |
| --- | --- |
| `meeting-report` | The whole record as JSON |
| `download-minutes` | The same as a Markdown file attachment |

---

## 11. Security notes worth knowing

### Anonymous attendee passes cannot vote

`/api/auth/attendee` is **public** and issues a token whose subject is **whatever username the caller
sends** — no password, no verification. That is deliberate and harmless for asking a question, where
the name is a label on a card.

It is fatal for a ballot. With voting on a plain `authenticated()` rule, anyone on the internet could
request a token as `alice` and cast alice's vote.

Two layers, deliberately redundant:

1. `SecurityConfig` restricts voting routes to `SHAREHOLDER` / `MODERATOR` / `ADMIN` — roles only a
   real account can hold.
2. `VotingController.requireRealAccount()` rejects `ATTENDEE` independently.

The cost of the two disagreeing — a route added later under a looser matcher, a role renamed — is a
forged vote in a legal record. Worth paying for twice.

### Agenda access is scoped to membership

Without it, any signed-in user could read any meeting's motions by guessing a meeting id, including
the wording of business not yet put. Moderators are exempt — they run meetings and are not
necessarily members of the ones they run.

### Nested feature gates narrow, never escape

`meeting-quorum` needs `VOTING` **and** `QUORUM`. The natural-reading alternative — method wins over
class — fails open: the quorum route would stay live with voting switched off.

### Roles on features cannot widen access

Spring Security runs first and independently. `allowedRoles` narrows; it never grants.

---

## 12. Known limits

Stated because a document that omits them is one you cannot trust the rest of.

| Limit | Detail |
| --- | --- |
| **Split is not durable** | Future similar questions land wherever the clusterer puts them. Merge is durable; split is not. |
| **Quorum is inferred from voting** | "Represented" means "cast at least one vote". The application has no register of who is in the room, and inferring presence from a websocket would count someone who opened the page and left. |
| **Questions before meeting-stamping** | Carry no meeting and always will. Reports disclose the count rather than guessing. |
| **Meeting scoping is phase one** | `questions.meeting_id` and `videos.meeting_id` are recorded but **nothing filters on them yet**. The board is still global. Turning scoping on is a separate, deliberate change. |
| **Attendee identity is self-asserted** | Fine for upvotes, refused for votes (§11). |
| **Not yet exercised** | Everything here compiles and is unit-tested at the points where being wrong is expensive (the carried/not-carried boundary, merge resolution, flag coverage). None of it has been run end to end. |

---

_Last updated alongside the voting, curation, room and reporting features. Companion documents:
[ARCHITECTURE.md](ARCHITECTURE.md) · [HOW_IT_WORKS.md](HOW_IT_WORKS.md) ·
[VIDEO_LIBRARY.md](VIDEO_LIBRARY.md) · [LOUNGE.md](LOUNGE.md)_
