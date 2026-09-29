-- ====================================================================
-- Demand signals: the complaint corpus, its Gemini embeddings, and the
-- clustered output the policymaker console reads.
--
-- `complaints` is the unit of analysis. It is deliberately separate from
-- `issues`/`issue_reports`: an issue is an aggregated incident at a
-- physical point, while a complaint is one citizen's account of a
-- problem. Several complaints from the same street collapse into one
-- demand signal, which is what the clustering pipeline computes.
--
-- The embedding lives on the complaint row (spec: "store the embedding
-- alongside the complaint record") as a pgvector column. It is
-- deliberately declared without a dimension typmod: text-embedding-004
-- emits 768 dims while gemini-embedding-001 emits 3072, and pinning the
-- column would make swapping models a table rewrite. The model name and
-- dimension are recorded per row instead, and the clustering step only
-- ever compares vectors produced by the same model — cosine similarity
-- between two different embedding spaces is meaningless.
-- ====================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- --------------------------------------------------------------------
-- Complaints — one row per citizen account, with the structured fields
-- the pipeline buckets on and the English text it embeds.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS complaints (
    id TEXT PRIMARY KEY,
    -- Deliberately NOT a foreign key: the issues table is treated as a
    -- disposable demo corpus and is wiped+re-seeded on every boot, and with ON
    -- DELETE CASCADE that wipe silently destroyed the complaint corpus and the
    -- Gemini embeddings stored on it. Complaints are pipeline artifacts; their
    -- source issue id is a lookup hint for drill-down and geocoding, not a
    -- referential link the database should police.
    source_issue_id TEXT,
    source_report_id TEXT,
    issue_type TEXT NOT NULL,
    -- Location is stored at every granularity we actually hold. The
    -- clustering step buckets on the finest one present, so two reports
    -- in the same district but different wards stay separate while two
    -- in the same ward merge.
    location_state TEXT,
    location_district TEXT,
    location_ward TEXT,
    location TEXT NOT NULL,
    location_granularity TEXT NOT NULL DEFAULT 'unknown',
    urgency_score NUMERIC(3, 2) NOT NULL DEFAULT 1.00,
    urgency_reason TEXT,
    original_language TEXT NOT NULL DEFAULT 'Unknown',
    original_text TEXT NOT NULL DEFAULT '',
    translated_text TEXT NOT NULL DEFAULT '',
    embedding vector,
    embedding_model TEXT,
    embedding_dimensions INTEGER,
    extraction_engine TEXT NOT NULL DEFAULT 'unavailable',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Stage 1 groups on exactly these two columns, so the index is the
-- bucket query rather than a scan of the whole corpus.
CREATE INDEX IF NOT EXISTS idx_complaints_bucket
    ON complaints (issue_type, location);
CREATE INDEX IF NOT EXISTS idx_complaints_source_issue ON complaints (source_issue_id);
-- Partially indexed: the pipeline only ever needs to re-embed the rows
-- that have no vector yet, and pgvector does not index NULLs usefully.
CREATE INDEX IF NOT EXISTS idx_complaints_pending_embedding
    ON complaints (id) WHERE embedding IS NULL;

-- --------------------------------------------------------------------
-- Demand signals — the clustered output. `volume` and `avg_urgency` are
-- denormalised from the members on purpose: the ranking in the next step
-- sorts on them across every signal, and a join back to the member rows
-- would be recomputed on every dashboard read.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS demand_signals (
    cluster_id TEXT PRIMARY KEY,
    issue_type TEXT NOT NULL,
    location TEXT NOT NULL,
    location_state TEXT,
    location_district TEXT,
    location_ward TEXT,
    member_complaint_ids TEXT[] NOT NULL DEFAULT '{}',
    volume INTEGER NOT NULL DEFAULT 0,
    avg_urgency NUMERIC(4, 3) NOT NULL DEFAULT 0,
    summary TEXT NOT NULL DEFAULT '',
    languages_represented TEXT[] NOT NULL DEFAULT '{}',
    similarity_threshold NUMERIC(4, 3) NOT NULL DEFAULT 0.750,
    verification_engine TEXT NOT NULL DEFAULT 'unavailable',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_demand_signals_volume ON demand_signals (volume DESC);
CREATE INDEX IF NOT EXISTS idx_demand_signals_issue_type ON demand_signals (issue_type);
