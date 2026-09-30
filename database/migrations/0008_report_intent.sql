-- A report is either a complaint (a problem that exists today) or a
-- development request (infrastructure that does not exist yet). The pipeline
-- buckets, scores and lists the two separately, so the intent has to be stored
-- on every row it flows through: the originating issue, the complaint derived
-- from it, and the cluster those complaints produce.
--
-- Default 'complaint' keeps every existing row valid without a backfill —
-- everything written before this migration was a complaint.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT 'complaint';
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT 'complaint';
ALTER TABLE demand_signals ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT 'complaint';

-- The application treats intent as a two-value enum; enforce that here too so
-- a stray write cannot create a third intent the reads would silently group.
DO $$
BEGIN
  ALTER TABLE issues
    ADD CONSTRAINT issues_intent_check CHECK (intent IN ('complaint', 'development_request'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE complaints
    ADD CONSTRAINT complaints_intent_check CHECK (intent IN ('complaint', 'development_request'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE demand_signals
    ADD CONSTRAINT demand_signals_intent_check CHECK (intent IN ('complaint', 'development_request'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
