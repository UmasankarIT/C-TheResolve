-- 0002_stop_retaining_voice_recordings.sql
--
-- CivicResolve retains the TRANSCRIPT of a citizen voice note, never the audio.
-- PRIVACY.md promises the recording is "used for transcription and then
-- discarded", but the code was writing the base64 clip into these two columns.
-- This migration makes the storage match the published policy.
--
-- The transcript is deliberately kept: it is what the responsible department
-- reads, and it is what the AI analysis and severity scoring consume. Only the
-- audio payload goes away.
--
-- WHY THE PURGE IS WRITTEN AS A GUARDED DO BLOCK
-- src/lib/postgresStore.ts re-applies every file in database/migrations on each
-- boot rather than tracking which ones have already run, so every statement in
-- this file must survive being executed repeatedly. A bare
--   UPDATE issues SET audio_url = NULL
-- works exactly once: on the next boot the column is already gone, the
-- statement raises "column audio_url does not exist", and that failure aborts
-- the whole store initialisation -- which took down every authenticated route.
-- Guarding on the catalog turns the purge into a no-op once the column is gone.
--
-- Reclaiming the physical space is PostgreSQL's job, not this migration's: the
-- UPDATE rewrites each affected row so no readable value survives in the live
-- tuple, and the DROP removes the column for good. Dead-tuple space is handed
-- back by an ordinary VACUUM.

DO $$
BEGIN
  -- 1. Purge any audio payload still present, so the bytes are scrubbed from
  --    the live row before the column disappears.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name   = 'issues'
      AND column_name  = 'audio_url'
  ) THEN
    UPDATE issues SET audio_url = NULL WHERE audio_url IS NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name   = 'issue_reports'
      AND column_name  = 'audio_url'
  ) THEN
    UPDATE issue_reports SET audio_url = NULL WHERE audio_url IS NOT NULL;
  END IF;
END
$$;

-- 2. Drop the columns. Already written to be re-runnable.
ALTER TABLE issues        DROP COLUMN IF EXISTS audio_url;
ALTER TABLE issue_reports DROP COLUMN IF EXISTS audio_url;
