-- Schema for VIRTUAL MEETING Sentinel. Runs automatically on first Postgres boot (docker-compose),
-- and is the same DDL you run once on Neon (paste into the Neon SQL editor).

CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector

-- Raw questions as submitted by attendees.
CREATE TABLE IF NOT EXISTS questions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    text         TEXT        NOT NULL,
    attendee_id  TEXT        NOT NULL,
    weight       REAL        NOT NULL DEFAULT 0,
    cluster_id   UUID,
    embedding    vector(384),            -- all-MiniLM-L6-v2 => 384 dims
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deduplicated clusters (one row per distinct topic).
CREATE TABLE IF NOT EXISTS clusters (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    representative_question TEXT        NOT NULL,
    centroid                vector(384),
    size                    INT         NOT NULL DEFAULT 1,
    weight_sum              REAL        NOT NULL DEFAULT 0,
    priority_score          REAL        NOT NULL DEFAULT 0,
    draft_answer            TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Approximate-nearest-neighbour index for fast centroid lookups at scale.
CREATE INDEX IF NOT EXISTS clusters_centroid_idx
    ON clusters USING ivfflat (centroid vector_cosine_ops) WITH (lists = 100);

-- The backend's record of each cluster and the answer prepared for it.
--
-- Separate from `clusters` above because the two have different owners: that table belongs to the
-- AI service (it carries the pgvector centroid), this one to the Spring backend. One table written
-- by both would be two services racing on the same row.
--
-- It exists because the AI service keeps its clusters — drafts included — in memory, so everything
-- it knows disappears when it restarts, which on a free tier is whenever it has been idle. The
-- questions always survived; the answers did not, and a moderator's hand-written answer would have
-- been the most expensive thing to lose. Hibernate's ddl-auto=update creates this too; the DDL is
-- here so a fresh Postgres/Neon database matches exactly.
CREATE TABLE IF NOT EXISTS cluster_drafts (
    cluster_id              UUID PRIMARY KEY,          -- the AI service's id, used verbatim
    representative_question TEXT        NOT NULL,
    cluster_size            INT         NOT NULL DEFAULT 1,
    priority_score          DOUBLE PRECISION NOT NULL DEFAULT 0,
    draft_answer            TEXT,
    citations_json          TEXT,                      -- JSON, so the shape can follow the AI service
    -- PENDING = the model is still working · DRAFTED = it answered
    -- NEEDS_MANUAL = it gave up, a moderator must write this one · MANUAL = a moderator did
    draft_status            VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    draft_error             TEXT,                      -- why the last automatic attempt failed
    attempts                INT         NOT NULL DEFAULT 0,
    answered_by             TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cluster_drafts_status_idx ON cluster_drafts (draft_status);


CREATE INDEX IF NOT EXISTS questions_cluster_idx ON questions (cluster_id);

-- ---------------------------------------------------------------------------
-- Video library. The media bytes live on the NAS (VIDEO_NAS_PATH); these tables
-- are the catalogue and the SEGMENT INDEX that makes on-demand playback work:
-- videos -> video_renditions (one per ladder rung) -> video_segments (one per ~6s slice).
-- Hibernate's ddl-auto=update also creates these; the DDL is here so a fresh
-- Postgres/Neon database matches exactly what the backend expects.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS videos (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title                   TEXT        NOT NULL,
    description             TEXT,
    original_filename       TEXT        NOT NULL,
    content_type            TEXT,
    size_bytes              BIGINT      NOT NULL DEFAULT 0,
    storage_dir             TEXT        NOT NULL,          -- folder under the NAS root
    source_rel              TEXT,                          -- original file, relative to storage_dir
    master_playlist_rel     TEXT,                          -- hls/master.m3u8
    poster_rel              TEXT,
    sprite_rel              TEXT,                          -- seek-preview filmstrip
    transcript_rel          TEXT,                          -- uploaded WebVTT captions
    sprite_interval_seconds INT,
    sprite_columns          INT,
    sprite_tile_width       INT,
    sprite_tile_height      INT,
    duration_seconds        DOUBLE PRECISION,
    width                   INT,
    height                  INT,
    frame_rate              DOUBLE PRECISION,
    has_audio               BOOLEAN     NOT NULL DEFAULT TRUE,
    status                  VARCHAR(20) NOT NULL DEFAULT 'UPLOADED',  -- UPLOADED|PROCESSING|READY|FAILED
    delivery_mode           VARCHAR(20) NOT NULL DEFAULT 'HLS',       -- HLS|PROGRESSIVE
    -- Per-video, so changing the server default never strands existing recordings.
    storage_mode            VARCHAR(20) NOT NULL DEFAULT 'FILESYSTEM', -- FILESYSTEM|DATABASE
    progress_percent        INT         NOT NULL DEFAULT 0,
    error_message           TEXT,
    segment_seconds         INT,
    uploaded_by             TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS videos_status_idx  ON videos (status);
CREATE INDEX IF NOT EXISTS videos_created_idx ON videos (created_at);

-- One rung of the adaptive ladder (1080p / 720p / …), each with its own media playlist.
CREATE TABLE IF NOT EXISTS video_renditions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id           UUID        NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    name               VARCHAR(32) NOT NULL,
    width              INT         NOT NULL DEFAULT 0,
    height             INT         NOT NULL DEFAULT 0,
    video_bitrate_kbps INT         NOT NULL DEFAULT 0,
    audio_bitrate_kbps INT         NOT NULL DEFAULT 0,
    playlist_rel       TEXT        NOT NULL,
    segment_count      INT         NOT NULL DEFAULT 0,
    total_bytes        BIGINT      NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS video_renditions_video_idx ON video_renditions (video_id);

-- The segment index: one row per ~6s slice. start_seconds is what turns
-- "seek to 21:30" into "fetch segment 215" instead of streaming from zero.
CREATE TABLE IF NOT EXISTS video_segments (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rendition_id     UUID             NOT NULL REFERENCES video_renditions (id) ON DELETE CASCADE,
    seq              INT              NOT NULL,
    filename         TEXT             NOT NULL,
    duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
    start_seconds    DOUBLE PRECISION NOT NULL DEFAULT 0,
    byte_size        BIGINT           NOT NULL DEFAULT 0,
    CONSTRAINT video_segments_unique_seq UNIQUE (rendition_id, seq)
);

CREATE INDEX IF NOT EXISTS video_segments_rendition_seq_idx
    ON video_segments (rendition_id, seq);

-- Media bytes, for videos stored with storage_mode = 'DATABASE'. Used when the host has no
-- persistent volume: a container filesystem is wiped on redeploy, which destroys recordings
-- written to it. Addressed by (video_id, rel_path) — deliberately the same relative-path
-- addressing the filesystem layout uses ('hls/720p/seg_00042.ts', 'poster.jpg'), so both
-- backends answer the same question.
--
-- Kept in its own table rather than as a column on video_segments so the segment index stays
-- small: a seek lookup or a playlist listing must never drag segment payloads along with it.
CREATE TABLE IF NOT EXISTS video_assets (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id     UUID   NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    rel_path     TEXT   NOT NULL,       -- relative to the video's folder, forward slashes
    content_type TEXT,
    byte_size    BIGINT NOT NULL DEFAULT 0,
    data         BYTEA  NOT NULL,
    CONSTRAINT video_assets_unique_path UNIQUE (video_id, rel_path)
);

CREATE INDEX IF NOT EXISTS video_assets_video_idx ON video_assets (video_id);

-- Engagement on recordings. A row per like rather than a counter column on `videos`: a counter
-- cannot answer "have I liked this", which is the half the button needs, and two simultaneous likes
-- would race on an increment. The unique constraint makes double-liking impossible at the database
-- rather than trusting the UI to prevent it.
-- ON DELETE CASCADE, matching video_assets. The application deletes these explicitly
-- (VideoEngagementService.deleteAllFor) because the entity holds a plain video_id rather than a
-- relation — loading a like must not drag a whole Video graph with it. That makes the cascade a
-- backstop rather than the mechanism: it is what stops a deletion by any other route leaving likes
-- and comments pointing at a recording that no longer exists.
CREATE TABLE IF NOT EXISTS video_likes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id   UUID        NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    username   TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT video_likes_unique_member UNIQUE (video_id, username)
);

CREATE INDEX IF NOT EXISTS video_likes_video_idx ON video_likes (video_id);

-- Flat, not threaded: a meeting recording attracts questions and corrections, not conversation
-- trees. `at_seconds` lets a comment point at a moment, which the UI turns into a seek.
CREATE TABLE IF NOT EXISTS video_comments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id   UUID        NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    author     TEXT        NOT NULL,   -- taken from the principal, never from the request body
    body       TEXT        NOT NULL,
    at_seconds DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS video_comments_video_idx ON video_comments (video_id, created_at);

-- ---------------------------------------------------------------------------
-- Meetings. Everything else in the application belongs to one: until this table
-- existed, questions and recordings were global and a second meeting would have
-- piled its questions on top of the first one's board.
--
-- PHASE ONE IS ADDITIVE. questions.meeting_id and videos.meeting_id are nullable
-- and nothing filters on them yet, so existing rows stay valid and current
-- behaviour is unchanged. Turning on scoping is a separate, deliberate change.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meetings (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title        TEXT        NOT NULL,
    description  TEXT,
    scheduled_at TIMESTAMPTZ,                                  -- informational; activation is manual
    status       VARCHAR(20) NOT NULL DEFAULT 'DRAFT',          -- DRAFT | ACTIVE | CLOSED
    created_by   TEXT,
    activated_at TIMESTAMPTZ,
    closed_at    TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ONE ACTIVE MEETING AT A TIME, enforced by the database rather than by application logic.
--
-- A partial unique index indexes only the ACTIVE rows, so any number may be DRAFT or CLOSED while
-- at most one can ever be ACTIVE. This is what makes the rule hold when two managers press Activate
-- in the same instant: the service reads, swaps and writes in one transaction, but only the index
-- can promise that the second writer loses rather than both believing they won.
CREATE UNIQUE INDEX IF NOT EXISTS meetings_one_active_idx
    ON meetings (status) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS meetings_status_idx    ON meetings (status);
CREATE INDEX IF NOT EXISTS meetings_scheduled_idx ON meetings (scheduled_at);

-- Who is entitled to take part in a meeting.
--
-- username is text, with no foreign key to app_users: attendees can be mapped before they have ever
-- signed in, and an invitation list that could only hold existing rows would be useless for exactly
-- the case it exists for.
--
-- role_in_meeting says what somebody is AT THIS MEETING (attendee, panellist, chair). It is
-- descriptive and grants nothing — authorisation comes from the application roles, never from here.
CREATE TABLE IF NOT EXISTS meeting_members (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id      UUID        NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
    username        TEXT        NOT NULL,
    role_in_meeting VARCHAR(32) NOT NULL DEFAULT 'ATTENDEE',
    added_by        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT meeting_members_unique UNIQUE (meeting_id, username)
);

CREATE INDEX IF NOT EXISTS meeting_members_meeting_idx ON meeting_members (meeting_id);

-- Additional roles, granted on top of app_users.role.
--
-- A separate table rather than more values of that column, because these are orthogonal duties:
-- MEETING_MANAGER creates meetings, USER_MANAGER maps users to them, and both are routinely held by
-- someone who is also a MODERATOR. A single-valued role column would have forced a choice between
-- running the board and scheduling the meeting it belongs to.
CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
    role    VARCHAR(32) NOT NULL,          -- MEETING_MANAGER | USER_MANAGER
    CONSTRAINT user_roles_unique UNIQUE (user_id, role)
);

CREATE INDEX IF NOT EXISTS user_roles_user_idx ON user_roles (user_id);

-- Scoping columns. Nullable on purpose: rows created before meetings existed have no meeting, and
-- must stay valid rather than becoming orphans.
ALTER TABLE questions ADD COLUMN IF NOT EXISTS meeting_id UUID REFERENCES meetings (id);
ALTER TABLE videos    ADD COLUMN IF NOT EXISTS meeting_id UUID REFERENCES meetings (id);

CREATE INDEX IF NOT EXISTS questions_meeting_idx ON questions (meeting_id);
CREATE INDEX IF NOT EXISTS videos_meeting_idx    ON videos (meeting_id);

-- Feature flags: what an admin has switched on, and for whom.
--
-- Stores only the DECISION. What a feature is — its name, description and defaults — lives in the
-- Feature enum, so a row here is a small override rather than a duplicate of the catalogue, and a
-- feature with no row simply behaves as it ships. That is what lets a new capability deploy dark
-- without anyone having to remember to insert anything.
--
-- Keyed by the enum name rather than a generated id: already unique, already stable, and readable
-- when somebody inspects this table during an incident.
CREATE TABLE IF NOT EXISTS feature_flags (
    feature_key VARCHAR(64) PRIMARY KEY,
    enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
    updated_by  TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Which roles may use a feature. A CEILING, never a grant: SecurityConfig is checked first and
-- independently, so listing a role here cannot let anyone reach something they could not before.
CREATE TABLE IF NOT EXISTS feature_flag_roles (
    feature_key VARCHAR(64) NOT NULL REFERENCES feature_flags (feature_key) ON DELETE CASCADE,
    role        VARCHAR(32) NOT NULL,
    CONSTRAINT feature_flag_roles_unique UNIQUE (feature_key, role)
);

-- ---------------------------------------------------------------------------
-- VOTING: resolutions and the votes cast on them.
--
-- WHAT THIS IS, for anyone who has not sat through an AGM:
--
--   A "resolution" is a motion put to the meeting for a decision — approving the
--   accounts, re-electing a director, changing the company's constitution. The
--   chair opens the floor, members vote, the chair closes it, and the result is
--   recorded. That record is the point of the whole exercise: it is the evidence
--   of what the company's members decided.
--
--   Members vote FOR, AGAINST, or ABSTAIN. Abstaining is not the same as not
--   voting — it means "I am here and taking part, but I am not taking a side".
--   It counts towards quorum but is excluded from the majority.
--
--   Votes are usually weighted by shareholding: a member with 1,000 shares gets
--   1,000 votes, not one. That weight lives on meeting_members (see below).
--
--   An ORDINARY resolution needs more votes for than against. A SPECIAL one
--   needs at least 75% — those are used for bigger decisions. The threshold is
--   stored per resolution because both routinely appear on the same agenda.
--
-- Nothing here is created enabled: the VOTING feature flag ships off, so these
-- tables exist and stay empty until a deployment turns the feature on.
-- ---------------------------------------------------------------------------

-- How much a member's vote is worth at this meeting.
--
-- On the MEMBERSHIP rather than on the user, because entitlement is per meeting:
-- the same person may hold a different number of shares at the next one. Keeping
-- it here also means it is set by a user manager and never sent by the voter — a
-- weight the client could supply would be a weight the client could inflate.
--
-- Defaults to 1, which is one-member-one-vote. A deployment that does not track
-- shareholdings gets sensible behaviour without configuring anything.
ALTER TABLE meeting_members
    ADD COLUMN IF NOT EXISTS voting_weight INTEGER NOT NULL DEFAULT 1;

-- The share of total entitlement that must be represented for business to be
-- valid. Set by a company's articles, so it is configurable rather than assumed;
-- 25% is a common default but far from universal. Zero disables the check.
ALTER TABLE meetings
    ADD COLUMN IF NOT EXISTS quorum_threshold_percent DOUBLE PRECISION NOT NULL DEFAULT 25.0;

CREATE TABLE IF NOT EXISTS resolutions (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id           UUID        NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
    seq                  INTEGER     NOT NULL DEFAULT 0,   -- position on the agenda
    title                TEXT        NOT NULL,
    text                 TEXT,                             -- the wording put to the meeting, verbatim
    type                 VARCHAR(20) NOT NULL DEFAULT 'ORDINARY',  -- ORDINARY | SPECIAL
    status               VARCHAR(20) NOT NULL DEFAULT 'DRAFT',     -- DRAFT | OPEN | CLOSED
    -- Whether members may watch the tally while the floor is open. OFF by
    -- default: a visible running count influences the votes still to come,
    -- which is exactly why a show of hands is taken all at once. Publishing
    -- early should be the chair's deliberate choice.
    live_results_visible BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Evidence of when the floor was open. A tally means nothing without the
    -- window it was taken in, and "we opened it around eleven" is not a record.
    opened_at            TIMESTAMPTZ,
    closed_at            TIMESTAMPTZ,
    created_by           TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS resolutions_meeting_idx ON resolutions (meeting_id);
CREATE INDEX IF NOT EXISTS resolutions_status_idx  ON resolutions (status);

CREATE TABLE IF NOT EXISTS votes (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resolution_id UUID        NOT NULL REFERENCES resolutions (id) ON DELETE CASCADE,
    -- Copied from the resolution so quorum — "who took part in this meeting at
    -- all" — is one query over votes rather than a join back through every
    -- resolution on the agenda.
    meeting_id    UUID        NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
    username      TEXT        NOT NULL,
    choice        VARCHAR(10) NOT NULL,        -- FOR | AGAINST | ABSTAIN
    -- The member's entitlement AT THE MOMENT THEY VOTED, copied in rather than
    -- looked up when the result is counted. If a holding is corrected later, the
    -- votes already cast must not silently re-weight themselves — a recorded
    -- result would change after the fact with nothing to show for it.
    weight        INTEGER     NOT NULL DEFAULT 1,
    cast_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- ONE VOTE PER MEMBER PER RESOLUTION, enforced here rather than by a check in
    -- the service. Double-counting is the failure that matters most, and two
    -- requests arriving together — a double tap, a client retry — is exactly the
    -- case application logic gets wrong. Changing a vote UPDATES this row.
    CONSTRAINT votes_one_per_member UNIQUE (resolution_id, username)
);

CREATE INDEX IF NOT EXISTS votes_resolution_idx   ON votes (resolution_id);
CREATE INDEX IF NOT EXISTS votes_meeting_user_idx ON votes (meeting_id, username);

-- ---------------------------------------------------------------------------
-- CLUSTER CURATION: letting a moderator fix the automatic grouping.
--
-- Questions are grouped by meaning, and automatic grouping gets it wrong in
-- both directions — splitting one topic because people phrased it differently,
-- and lumping two topics together because they share vocabulary.
--
-- WHY A TABLE RATHER THAN JUST MOVING THE QUESTIONS:
--
--   The clustering maths lives in the Python AI service, which keeps a centroid
--   per cluster and assigns every INCOMING question to the nearest one. The
--   backend only records the result.
--
--   So moving rows would not hold. A moderator merges "when is the dividend
--   paid" into "dividend timing"; the next attendee asks about the dividend;
--   the AI service assigns them to the centroid it still has; and the cluster
--   that was merged away reappears. The merge would quietly undo itself, which
--   is worse than not offering the button.
--
--   This table is the durable part. Every cluster id coming back from the AI
--   service is resolved through it before anything is recorded, so a merge keeps
--   applying to questions that have not been asked yet.
--
-- Splitting has no equivalent row, and cannot: pulling three questions out of a
-- cluster gives the clusterer nothing to act on — there is no new centroid. A
-- split separates the questions already asked, and future similar ones land
-- wherever the clusterer puts them. The UI says so rather than implying more.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cluster_merges (
    -- The cluster that was merged away. PRIMARY KEY because it can only have
    -- been merged into one place, and that constraint is what stops the
    -- redirects forking into an unresolvable mess.
    source_cluster_id UUID PRIMARY KEY,
    -- Where it went. May itself have been merged onwards: merging B into A and
    -- later A into C leaves a chain, which the backend follows to its end rather
    -- than rewriting old rows, so the history of what went where stays readable.
    target_cluster_id UUID        NOT NULL,
    -- The question the merged-away cluster used to represent, kept so the merge
    -- can still be explained on the board after the draft row is gone.
    source_question   TEXT,
    merged_by         TEXT,
    merged_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cluster_merges_target_idx ON cluster_merges (target_cluster_id);

-- ---------------------------------------------------------------------------
-- THE ROOM: what attendees see, what they can support, and the chair's order.
--
-- Three capabilities that share one set of rows, because they are three views
-- of the same list of topics:
--
--   * the attendee board  — the ranked topics, shown back to the room
--   * upvoting            — "answer this one too", without retyping the question
--   * the run of show     — the order the chair takes them in, and how long each took
--
-- Each sits behind its own feature flag: a deployment may want attendees to see
-- topics without letting them influence the order, or a running order without
-- showing the room anything at all.
-- ---------------------------------------------------------------------------

-- WHEN AN ANSWER WAS RELEASED TO ATTENDEES. Null means they cannot see it.
--
-- Opt-in, and this is the important part. Nearly every answer on the board was
-- drafted by a model and read by nobody. Showing those to a room of shareholders
-- would attribute to the company something it never said — at an AGM that is not
-- a presentation bug, it is a statement on the record. So publishing is always a
-- deliberate act by a moderator, and the attendee board shows nothing else.
ALTER TABLE cluster_drafts ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- The chair's running order, and the timings.
--
-- On cluster_drafts rather than in an agenda table of its own: a cluster IS the
-- topic, so a separate table would hold a pointer back here plus an integer, and
-- would then have to be kept in step through every merge and split.
ALTER TABLE cluster_drafts ADD COLUMN IF NOT EXISTS run_order INTEGER;
ALTER TABLE cluster_drafts ADD COLUMN IF NOT EXISTS discussion_started_at TIMESTAMPTZ;
ALTER TABLE cluster_drafts ADD COLUMN IF NOT EXISTS discussion_ended_at   TIMESTAMPTZ;

-- "I want this answered too", without typing the question again.
--
-- Attendees who see their question already on the board otherwise have only one
-- way to add their weight to it: type it out again and hope the clusterer groups
-- the two. That is effort for them, another embedding for the AI service, and a
-- grouping decision that might go wrong. An upvote is one tap into exactly the
-- right place.
--
-- A SEPARATE SIGNAL FROM ASKING, deliberately. Questions carry a shareholder
-- weight and drive the drafting pipeline; an upvote is a bare show of hands.
-- Separate tables let the board say "asked by 4, supported by 30" rather than
-- blurring the two into one number that means neither.
--
-- voter_id is self-asserted for an anonymous attendee. That is acceptable here
-- and nowhere near acceptable for votes: this ranks a discussion topic, it does
-- not decide anything. Compare the votes table, which is restricted to accounts.
CREATE TABLE IF NOT EXISTS cluster_upvotes (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id UUID        NOT NULL,
    voter_id   TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- One per person per topic, enforced here rather than in the service. This is
    -- the one number attendees move directly, so it is the one somebody will try
    -- to move twice, and two taps arriving together is exactly the case a
    -- read-then-write gets wrong.
    CONSTRAINT cluster_upvotes_one_per_person UNIQUE (cluster_id, voter_id)
);

CREATE INDEX IF NOT EXISTS cluster_upvotes_cluster_idx ON cluster_upvotes (cluster_id);

-- ---------------------------------------------------------------------------
-- PER-MEETING SCOPING (phase two): one meeting's board at a time.
--
-- Activating a different meeting should give a fresh, clean board — WITHOUT
-- deleting the previous meeting's record. Those are different things, and
-- conflating them would be a mistake:
--
--   * "Fresh and clean" is about what people SEE. Filtering on meeting_id gives
--     that completely: the new meeting's board is empty because nothing carries
--     its id yet.
--   * Deleting would break the meeting reports, which read a past meeting's
--     questions, answers and votes — and an AGM record is exactly the kind of
--     thing that has to survive the next AGM.
--
-- So nothing here clears anything. The AI service's in-memory clustering state
-- is the part that genuinely resets on activation; the database keeps the record.
-- ---------------------------------------------------------------------------

-- Which meeting a topic belongs to. Stamped from whichever meeting was live when
-- the first question landed in the cluster.
--
-- NULLABLE, AND STAYS THAT WAY. Topics from before meeting tracking have no
-- meeting and never will, and so do topics raised while no meeting was active.
-- Making it NOT NULL would mean inventing a meeting for them or discarding them.
--
-- Recording this is UNCONDITIONAL; only filtering is conditional on the MEETINGS
-- feature flag. If the stamp followed the flag, every topic raised with the flag
-- off would carry null — and the moment somebody enabled the flag, the board
-- would filter to a meeting whose topics all carry null and show nothing.
ALTER TABLE cluster_drafts ADD COLUMN IF NOT EXISTS meeting_id UUID REFERENCES meetings (id);

CREATE INDEX IF NOT EXISTS cluster_drafts_meeting_idx ON cluster_drafts (meeting_id);

-- BEFORE SWITCHING FILTERING ON, adopt the orphans. Everything recorded before
-- meetings existed carries meeting_id = NULL, and filtering without adopting it
-- makes the board appear empty — every question ever asked becomes invisible at
-- once, which is an alarming thing to discover in production.
--
-- The application does this from Meetings → "unattributed data" rather than by
-- migration, so an administrator can see the count and choose the meeting. The
-- equivalent by hand, if you prefer SQL:
--
--   UPDATE questions      SET meeting_id = '<meeting-uuid>' WHERE meeting_id IS NULL;
--   UPDATE cluster_drafts SET meeting_id = '<meeting-uuid>' WHERE meeting_id IS NULL;
--
-- Both statements are scoped to IS NULL, so they only ever claim orphans: they
-- cannot move anything from one meeting to another, and re-running is harmless.
