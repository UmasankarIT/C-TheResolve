-- Drop the complaints->issues cascade that the boot-time demo-seed refresh
-- used to wipe the whole complaint corpus (and its stored Gemini embeddings)
-- with. Complaints are pipeline artifacts whose source_issue_id is an
-- informational link for drill-down, not a referential constraint; the build
-- already scopes its corpus to currently-open issues at build time, so stale
-- rows keyed to deleted issues are harmless and are filtered out there.
ALTER TABLE complaints DROP CONSTRAINT IF EXISTS complaints_source_issue_id_fkey;