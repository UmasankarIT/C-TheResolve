-- =============================================================================
-- CivicResolve — database schema (reference)
-- =============================================================================
--
-- READ THIS FIRST
--   This file is a REFERENCE DOCUMENT, not a migration. It is not executed by
--   the application and nothing depends on it staying in sync automatically.
--
--   The authoritative definition of the schema is the numbered set in
--   database/migrations/, applied in filename order and recorded in
--   schema_migrations. To change the schema, add a new migration; never edit
--   the migrations that have already run, and never edit this file expecting it
--   to take effect.
--
--   This file was regenerated from the live database (PostgreSQL 16 + PostGIS)
--   and matches it exactly. Regenerate it with:
--
--     docker exec civicresolve_postgres pg_dump -U postgres -d civicresolve \
--       --schema-only --no-owner --no-privileges
--
--   The previous hand-written version of this file had drifted badly enough to
--   be misleading, so the corrections are worth knowing about:
--
--     * issues.id is TEXT, not UUID. Rows look like 'seed-anantapur-0001' or
--       'iss-1756...'. There are no UUIDs anywhere in this schema.
--     * issues.status is lowercase TEXT with these exact values:
--         reported, in_review, verified, assigned, in_progress, resolved,
--         rejected, merged
--       There is no issue_status enum type. The old file's function filtered on
--       'SUBMITTED', 'PENDING_TRIAGE', 'VERIFIED', 'ASSIGNED_TO_DEPT' and
--       'IN_PROGRESS', none of which exist, so it would have matched zero rows.
--     * There is no users table. Authentication is stateless JWT in an httpOnly
--       cookie; user records are not persisted. The old file described a users
--       table with email/phone/role columns that was never created.
--     * There is no issue_status_history table and no proof_of_work table.
--       Status history lives in audit_logs, and proof of work is a JSONB column
--       on issues. The old file described both as tables.
--     * issues has no tracking_number column. The old file's function returned
--       one, so it could not even compile against this schema.
--     * The correct nearby-issue function is at the bottom of this file.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

-- Applied migrations. Created by the app's migration runner, not by a migration
-- file, because a migration cannot record its own application.
CREATE TABLE schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- categories
-- The six civic problem types the pilot routes between departments.
CREATE TABLE categories (
    id                      TEXT PRIMARY KEY,
    code                    TEXT UNIQUE NOT NULL,
    name                    TEXT NOT NULL,
    description             TEXT NOT NULL DEFAULT '',
    base_severity_weight    NUMERIC(3,2) NOT NULL DEFAULT 1.00,
    default_sla_hours       INTEGER NOT NULL DEFAULT 72,
    responsible_department  TEXT NOT NULL DEFAULT '',
    icon_name               TEXT NOT NULL DEFAULT 'alert-circle',
    sort_order              INTEGER NOT NULL DEFAULT 0,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- --------------------------------------------------------------- departments
-- Routing targets. category_codes drives which categories reach which team.
CREATE TABLE departments (
    id             TEXT PRIMARY KEY,
    code           TEXT UNIQUE NOT NULL,
    name           TEXT NOT NULL,
    nodal_officer  TEXT NOT NULL DEFAULT 'Nodal Officer',
    sla_hours      INTEGER NOT NULL DEFAULT 72,
    disabled       BOOLEAN NOT NULL DEFAULT FALSE,
    category_codes TEXT[] NOT NULL DEFAULT '{}',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------------- issues
-- An aggregated civic incident at one physical location. Many citizen reports
-- collapse into one issue via spatial deduplication (see the function below).
CREATE TABLE issues (
    id                     TEXT PRIMARY KEY,
    category_id            TEXT NOT NULL REFERENCES categories(id),
    title                  TEXT NOT NULL,
    description            TEXT,

    -- WGS 84 geography point. geography (not geometry) so that distance is
    -- measured geodesically in metres; idx_issues_location_gist accelerates
    -- ST_DWithin on it.
    location               GEOGRAPHY(Point, 4326) NOT NULL,

    formatted_address      TEXT,
    ward_id                TEXT,
    location_details       JSONB,   -- { state, district, mandal } from Nominatim

    status                 TEXT NOT NULL DEFAULT 'reported',
    assigned_worker_name   TEXT,
    assigned_department    TEXT,
    department_id          TEXT REFERENCES departments(id),

    -- Ward/block scope, used to scope department queues. Populated from the
    -- reported sub-district (mandal) or PIN code.
    jurisdiction_code      TEXT,

    -- Reporter identity. DELIBERATELY NOT EXPOSED ON THE PUBLIC FEED:
    -- citizen_user_id is a phone-linked handle and citizen_name is a real name,
    -- and together they pin a person to an address. /api/issues strips both; a
    -- citizen reads their own reports from /api/citizen/my-reports, which scopes
    -- by session, and staff read identity from the admin endpoints.
    citizen_user_id        TEXT,
    citizen_name           TEXT,

    sla_deadline_at        TIMESTAMPTZ,
    verified_at            TIMESTAMPTZ,
    merged_into_id         TEXT,

    -- Voice notes are never stored. Only the Gemini transcription survives, so
    -- a citizen's raw audio cannot be replayed by staff or anyone else.
    transcript             TEXT,

    report_count           INTEGER NOT NULL DEFAULT 1,
    upvotes_count          INTEGER NOT NULL DEFAULT 0,
    ml_severity_score      NUMERIC(3,2) NOT NULL DEFAULT 1.00,
    priority_score         NUMERIC(6,3) NOT NULL DEFAULT 1.000,

    -- A path under /api/images once uploaded to S3/MinIO, or an inline
    -- data: URL when no bucket is configured or the upload fails.
    image_url              TEXT NOT NULL,

    ml_analysis            JSONB,
    reassign_request       JSONB,

    -- Proof of work, stored inline rather than as a table.
    proof                  JSONB,
    resolution_notes       TEXT,
    resolution_proof_url   TEXT,
    resolved_at            TIMESTAMPTZ,

    created_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Administrative state, promoted out of location_details so the state and
    -- national rollups can filter and index it. Backfilled by migration 0003.
    state                  TEXT,

    -- Absent by design: audio_url (removed in migration 0002 so voice recordings
    -- are not retained) and tracking_number (never existed; ids are the text
    -- primary key).
    CONSTRAINT issues_status_valid CHECK (status IN (
        'reported', 'in_review', 'verified', 'assigned',
        'in_progress', 'resolved', 'rejected', 'merged'
    ))
);

-- ------------------------------------------------------------- issue_reports
-- One row per citizen submission. A single issue accumulates many reports as
-- neighbours corroborate the same problem.
CREATE TABLE issue_reports (
    id               TEXT PRIMARY KEY,
    issue_id         TEXT NOT NULL REFERENCES issues(id),
    reporter_id      TEXT,
    citizen_user_id  TEXT,
    client_location  GEOGRAPHY(Point, 4326) NOT NULL,
    accuracy_meters  INTEGER NOT NULL DEFAULT 10,
    is_on_site       BOOLEAN NOT NULL DEFAULT TRUE,
    image_url        TEXT NOT NULL,
    citizen_notes    TEXT,
    transcript       TEXT,   -- transcription only; audio is never retained
    exif             JSONB,
    location_details JSONB,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------------- upvotes
CREATE TABLE upvotes (
    issue_id   TEXT NOT NULL REFERENCES issues(id),
    user_id    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_issue_user_upvote UNIQUE (issue_id, user_id)
);

-- -------------------------------------------------------------- notifications
CREATE TABLE notifications (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    issue_id   TEXT,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    read       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------- audit_logs
-- Every state transition, merge, assignment and proof submission. This is the
-- "immutable audit trail" the brief asks for; it replaced the issue_status_history
-- table the old version of this file described.
CREATE TABLE audit_logs (
    id         TEXT PRIMARY KEY,
    actor_id   TEXT,
    actor_name TEXT NOT NULL,
    role       TEXT NOT NULL,
    action     TEXT NOT NULL,
    issue_id   TEXT,
    detail     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- Spatial dedup. The GiST index is what makes ST_DWithin sub-linear; without it
-- every report submission degrades into a sequential scan.
CREATE INDEX idx_issues_location_gist ON issues USING GIST (location);

CREATE INDEX idx_issues_status           ON issues (status);
CREATE INDEX idx_issues_priority_score   ON issues (priority_score DESC);
CREATE INDEX idx_issues_category_id      ON issues (category_id);
CREATE INDEX idx_issues_citizen_user_id  ON issues (citizen_user_id);
CREATE INDEX idx_issues_department_id    ON issues (department_id);
CREATE INDEX idx_issues_created_at       ON issues (created_at DESC);
CREATE INDEX idx_issues_state            ON issues (state);
CREATE INDEX idx_issues_jurisdiction_code ON issues (jurisdiction_code);

CREATE INDEX idx_issue_reports_issue_id           ON issue_reports (issue_id);
CREATE INDEX idx_issue_reports_citizen_user_id    ON issue_reports (citizen_user_id);
CREATE INDEX idx_issue_reports_client_location_gist ON issue_reports USING GIST (client_location);
CREATE INDEX idx_issue_reports_created_at          ON issue_reports (created_at DESC);

CREATE INDEX idx_upvotes_issue_id  ON upvotes (issue_id);
CREATE INDEX idx_upvotes_user_id   ON upvotes (user_id);

CREATE INDEX idx_notifications_user     ON notifications (user_id, read);
CREATE INDEX idx_notifications_created_at ON notifications (created_at DESC);

CREATE INDEX idx_audit_logs_issue_id  ON audit_logs (issue_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs (created_at DESC);

-- =============================================================================
-- Spatial deduplication
-- =============================================================================
--
-- Report submission asks: is there already an open issue of the same category
-- within 25m of this location? If so the submission is attached to that issue
-- and its priority recomputed, rather than creating a duplicate.
--
-- The application does this through CivicStore.findNearbyActiveIssue(), which
-- runs the equivalent query inline against idx_issues_location_gist. The
-- function below is that same logic in SQL, installed by migration 0004 for
-- ad-hoc querying and reporting.
--
-- The status filter is load-bearing. resolved, merged and rejected are all
-- terminal: if merged were included, a fresh report landing near a merged issue
-- would be silently attached to it and vanish from active demand. That bug
-- existed in the application code until the terminal set was centralised in
-- src/lib/workflow.ts.

CREATE OR REPLACE FUNCTION find_nearby_active_issue(
    p_lat            DOUBLE PRECISION,
    p_lon            DOUBLE PRECISION,
    p_category_id    TEXT,
    p_radius_meters  DOUBLE PRECISION DEFAULT 25.0
)
RETURNS TABLE (
    issue_id         TEXT,
    distance_meters  DOUBLE PRECISION,
    current_status   TEXT
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        i.id,
        ST_Distance(
            i.location,
            ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography
        ) AS distance_meters,
        i.status
    FROM issues i
    WHERE i.category_id = p_category_id
      AND i.status NOT IN ('resolved', 'merged', 'rejected')
      AND ST_DWithin(
            i.location,
            ST_SetSRID(ST_MakePoint(p_lon, p_lat), 4326)::geography,
            p_radius_meters
          )
    ORDER BY distance_meters ASC
    LIMIT 1;
$$;
