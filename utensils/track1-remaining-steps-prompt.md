# AGENT PROMPT — COMPLETE THE REMAINING PIPELINE (Steps 3-6)

You are continuing work on an existing hackathon prototype ("Build with AI: Code for Communities," Track 1 — AI for Digital Public Infrastructure & Governance). The intake pipeline (voice/text → transcription → translation → Gemini field extraction) is already built. Your job is to build the four remaining components so the pipeline is complete end-to-end. Do not modify the existing intake logic unless something is broken and blocking integration.

No predictive modelling / AutoML is used anywhere in this build. Every scoring step must be a transparent, explainable formula — never a black-box model. This is a deliberate scope decision, not something to "improve" on your own initiative.

---

## STEP 3 — CLUSTERING (merge near-duplicate complaints into demand signals)

**Goal:** many citizens reporting the same underlying issue should collapse into ONE record, not stay as separate rows.

**Input:** structured complaint records already extracted by Gemini, each with: `issue_type`, `location` (district/ward level), `urgency_score`, `urgency_reason`, `original_language`, `original_text`, `translated_text`, `timestamp`.

**Build:**
1. Group candidate duplicates first by exact match on `issue_type` + `location` (cheap first pass).
2. Within each group, compute semantic similarity between `translated_text` values — use Gemini embeddings (or a lightweight sentence-transformer if embeddings add too much latency) and a cosine-similarity threshold (start at 0.75, make it a config value, not hardcoded).
3. Merge complaints above the threshold into a single `demand_signal` record with fields:
   - `signal_id`
   - `issue_type`
   - `location`
   - `complaint_count` (how many individual complaints merged)
   - `avg_urgency` and `max_urgency`
   - `source_complaint_ids` (array, for drill-down later)
   - `representative_summary` — one Gemini call that reads all merged complaints and writes a single plain-language summary of the issue
4. Complaints that don't match any group become their own single-item demand signal.
5. Write output to a `demand_signals` table/collection.

**Do not** build a full ML clustering algorithm (e.g. HDBSCAN, k-means) — the threshold-based approach above is sufficient and easier to explain to judges.

---

## STEP 4 — DATA FUSION (join demand signals with real public data)

**Goal:** attach real demographic and infrastructure context to each demand signal so the priority score isn't based on complaint volume alone.

**Build:**
1. Source real data for your chosen district/state from data.gov.in or another Indian government open data portal — at minimum: population by ward/district, an existing infrastructure index or gap indicator (e.g. water access %, road condition data, or whatever is actually available for your region — don't force a dataset that doesn't exist, substitute the closest available real indicator).
2. Load this into BigQuery as a reference table, keyed by the same location granularity used in your `demand_signals` (district/ward).
3. Write a join query/service that, for each `demand_signal`, pulls in:
   - `population_affected` (population of that location)
   - `existing_infrastructure_gap` (whatever indicator you sourced — normalize it to a 0-1 or 0-100 scale if it isn't already)
4. Add these two fields to each `demand_signal` record.
5. If a location has no matching data (gaps are expected in open datasets), default to a clearly-flagged null/unknown value rather than silently guessing a number — the scoring step below must handle this case explicitly, not crash or fake a number.

---

## STEP 5 — EXPLAINABLE PRIORITY SCORE (no ML model)

**Goal:** rank demand signals by priority using a formula every judge can understand by reading it once.

**Build:**
1. Implement this scoring formula (adjust weights if needed, but keep it a simple weighted sum, not a model):
   ```
   priority_score = (w1 * normalized_complaint_count)
                  + (w2 * normalized_avg_urgency)
                  + (w3 * normalized_infrastructure_gap)
                  + (w4 * normalized_population_affected)
   ```
   Suggested starting weights: w1=0.3, w2=0.3, w3=0.25, w4=0.15 (make these config values).
2. Normalize each input to a 0-1 scale before applying weights (e.g. min-max normalization across all current demand signals).
3. For each demand signal, also generate a short explanation string, e.g.: `"Ranked high due to 42 complaints (top 10%), high urgency (avg 4.2/5), and an existing infrastructure gap in this area."` This can be templated from the numbers directly — no need for another Gemini call here, keep it fast and deterministic.
4. Handle missing data explicitly (e.g. if `infrastructure_gap` is unknown for a location, either exclude that term from the formula for that record and note it in the explanation, or use a documented neutral default — pick one approach and be consistent).
5. Sort all demand signals by `priority_score` descending. This sorted list is what step 6 displays.

---

## STEP 6 — POLICYMAKER DASHBOARD (frontend + serving API)

**Goal:** a clean, judge-facing view that shows the ranked output and lets you drill into any recommendation.

**Backend (FastAPI) — add these endpoints if not already present:**
- `GET /demand-signals` — returns the full ranked list with all fields (score, explanation, complaint count, location, etc.)
- `GET /demand-signals/{signal_id}` — returns one signal's full detail, including its `source_complaint_ids` resolved into the actual original complaints (original language text + translation + individual urgency/reason)
- `GET /demand-signals/map` — returns location + score + issue_type only, shaped for map plotting

**Frontend (React) — build these views:**
1. **Map view** (Google Maps Platform) — plot each demand signal as a marker/heat intensity at its location, colored/sized by `priority_score`.
2. **Ranked list view** — table or card list of demand signals sorted by score, showing: issue type, location, score, complaint count, and the one-line explanation.
3. **Drill-down view** — clicking a demand signal shows: the explanation, the score breakdown (each of the 4 weighted components as separate visible numbers, not just the final score), and the list of original source complaints (with original language + translation shown side by side).
4. Keep the UI simple — a functioning map + list + drill-down beats a heavily styled but incomplete dashboard.

**Deployment:** once steps 3-6 are working locally end-to-end, deploy the backend to Cloud Run and confirm the frontend can reach it via the live URL before considering this done.

---

## ACCEPTANCE CHECK (before calling this done)

Run through this manually:
- [ ] Submit 5+ overlapping sample complaints (same issue, same area) → confirm they merge into ONE demand signal, not five.
- [ ] Confirm each demand signal shows real population and infrastructure data pulled from your BigQuery table, not placeholder numbers.
- [ ] Confirm the priority score's 4 components are each independently visible somewhere in the UI (not just the final number).
- [ ] Confirm clicking a demand signal shows the original complaints that fed into it, in their original language.
- [ ] Confirm the whole flow works against the live Cloud Run deployment, not just localhost.
