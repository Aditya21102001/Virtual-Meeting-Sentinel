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
