-- ====================================================================
-- Step 4 — DATA FUSION. Real demographic and infrastructure context is
-- attached to every demand signal so the Step 5 priority score does not
-- rest on complaint volume alone.
--
-- `location_statistics` is the reference table the spec calls for (its
-- BigQuery analog): one row per district we pilot, keyed by the same
-- (state, district) granularity the demand-signal pipeline buckets on.
-- The numbers come from Census of India 2011 via the ORGI NADA open-data
-- portal, with per-column provenance kept in the source URLs. The single
-- source of truth is database/data/district_reference.csv; the store
-- seeds this table from it on boot, so the data is queryable directly
-- and edited in exactly one place.
--
-- The fusion columns on demand_signals hold the joined values and stay
-- NULL when a district has no reference row — a clearly-flagged null,
-- never an invented number. The spec is explicit here: "if a location
-- has no matching data ... default to a clearly-flagged null/unknown
-- value rather than silently guessing a number."
-- ====================================================================

CREATE TABLE IF NOT EXISTS location_statistics (
    state TEXT NOT NULL,
    -- District exactly as the demand-signal pipeline files it (the seed
    -- name). `census_district` records how the same place was called in
    -- the census file, which is how the seed names map onto the open data.
    district TEXT NOT NULL,
    census_district TEXT,
    population BIGINT NOT NULL,
    -- Percentage of households with NO latrine facility within premises
    -- (Census 2011 applies-within-premises breakdown, "latrine available
    -- within premises" vs not), on a 0-100 scale. NULL when the district
    -- has no census row (the post-2022 bifurcation districts).
    infrastructure_gap NUMERIC(5, 2),
    population_source TEXT NOT NULL,
    population_source_url TEXT NOT NULL,
    infrastructure_gap_source TEXT,
    infrastructure_gap_source_url TEXT,
    note TEXT,
    PRIMARY KEY (state, district)
);

-- The join is keyed on the district level, which is also the level the
-- pipeline buckets on, so the index is the standard bucketing lookup.
CREATE INDEX IF NOT EXISTS idx_location_statistics_lookup
    ON location_statistics (state, district);

-- Fusion columns join the reference data onto each clustered signal.
-- population_affected is the population of the signal's location,
-- existing_infrastructure_gap is that district's gap indicator, and
-- data_fusion_source records where the numbers came from so every value
-- on screen can be traced back to an open-data record.
ALTER TABLE demand_signals
    ADD COLUMN IF NOT EXISTS population_affected BIGINT,
    ADD COLUMN IF NOT EXISTS existing_infrastructure_gap NUMERIC(5, 2),
    ADD COLUMN IF NOT EXISTS data_fusion_source TEXT;