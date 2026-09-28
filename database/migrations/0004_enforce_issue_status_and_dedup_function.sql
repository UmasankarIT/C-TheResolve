-- Enforce the issue status set in the database, and publish the spatial dedup
-- helper as SQL.
--
-- The application validates status transitions in src/lib/workflow.ts and
-- screens incoming values with Zod, but nothing constrained the column itself,
-- so any writer that reached Postgres directly (a migration, a psql session, a
-- future service) could store a status the rest of the system has no case for.
--
-- Guarded so re-running is safe. NOT VALID is deliberately not used: all
-- existing rows already satisfy the constraint, and validating now means a
-- later violation fails loudly instead of sitting unnoticed.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'issues_status_valid'
  ) THEN
    ALTER TABLE issues ADD CONSTRAINT issues_status_valid
      CHECK (status IN (
        'reported', 'in_review', 'verified', 'assigned',
        'in_progress', 'resolved', 'rejected', 'merged'
      ));
  END IF;
END
$$;

-- The same dedup query the application runs through
-- CivicStore.findNearbyActiveIssue(), exposed for ad-hoc SQL and reporting.
-- The terminal statuses are load-bearing: including 'merged' here would attach
-- a new report to an already-merged issue and drop it out of active demand.
CREATE OR REPLACE FUNCTION find_nearby_active_issue(
    p_lat           DOUBLE PRECISION,
    p_lon           DOUBLE PRECISION,
    p_category_id   TEXT,
    p_radius_meters DOUBLE PRECISION DEFAULT 25.0
)
RETURNS TABLE (
    issue_id        TEXT,
    distance_meters DOUBLE PRECISION,
    current_status  TEXT
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
