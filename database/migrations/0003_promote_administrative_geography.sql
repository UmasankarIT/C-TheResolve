-- Promote administrative geography to queryable columns.
--
-- state was only ever reachable by digging into the location_details JSONB, and
-- jurisdiction_code was left NULL on every seeded issue, so ward scoping and
-- the "no ward" placeholder in the staff views had nothing to work with.
--
-- Both are backfilled from the existing JSONB rather than re-collected, so no
-- citizen data is lost and no reverse-geocoding call is needed.

ALTER TABLE issues ADD COLUMN IF NOT EXISTS state TEXT;

UPDATE issues
   SET state = NULLIF(location_details ->> 'state', '')
 WHERE state IS NULL
   AND location_details ->> 'state' IS NOT NULL
   AND location_details ->> 'state' <> '';

-- jurisdiction_code is ward/block scope. Citizen reports already stored the
-- sub-district (mandal) there; seeds never did. Prefer an explicit ward if one
-- was captured, otherwise fall back to the sub-district.
UPDATE issues
   SET jurisdiction_code = COALESCE(
         NULLIF(location_details ->> 'ward', ''),
         NULLIF(location_details ->> 'mandal', ''),
         NULLIF(location_details ->> 'pincode', '')
       )
 WHERE jurisdiction_code IS NULL
   AND location_details IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_issues_state ON issues (state);
CREATE INDEX IF NOT EXISTS idx_issues_jurisdiction_code ON issues (jurisdiction_code);
