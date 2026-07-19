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
