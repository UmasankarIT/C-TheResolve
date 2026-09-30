import { embedComplaintTexts, extractComplaintFields, verifyClusterMembers } from './gemini';
import { isOpenIssue } from './demand';
import {
  Complaint,
  DemandSignal,
  Issue,
  LocationGranularity,
  PipelineEngine,
  ReportIntent,
} from './types';

// ---------------------------------------------------------------------------
// Demand-signal clustering pipeline.
//
// Four stages, in this order and never reordered:
//
//   1. Structured pre-bucketing  — group by issue_type + location. No text is
//      compared across a bucket boundary, so two unrelated complaints in
//      different districts can never be merged no matter how similar they read.
//   2. Semantic embedding       — one Gemini embedding per complaint, held on
//      the complaint row.
//   3. Similarity grouping      — agglomerative clustering, average linkage,
//      cosine distance, cut at a configurable similarity threshold.
//   4. LLM verification          — Gemini confirms each proposed merge and
//      writes the one-sentence summary; rejections split back out.
//
// Stages 1 and 3 are pure and unit-tested without network access. The Gemini
// calls arrive through the `PipelineAi` seam below so the orchestrator can be
// driven with a stub in tests and cannot silently grow an untestable branch.
// ---------------------------------------------------------------------------

/**
 * Cosine similarity two complaints must reach before they are considered the
 * same problem. Config, not a literal: the right value depends on the
 * embedding model (0.75 is a reasonable default for text-embedding-004 on
 * short civic complaints) and on how aggressive a merge the policy wants.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.75;

/**
 * A bucket larger than this is reported in the build stats rather than silently
 * handled. It no longer selects a different algorithm — stage 3 is always
 * average linkage — it only makes an unexpectedly coarse bucket level visible.
 */
export const MAX_BUCKET_SIZE = 500;

/**
 * How many times stage 4 may re-check the groups it just split. Splitting is
 * what produces new multi-member groups, so the loop needs a bound; two rounds
 * is enough to peel off the obvious outliers without turning verification into
 * a repeated clustering algorithm.
 */
export const MAX_VERIFICATION_ROUNDS = 2;

const EMBEDDING_BATCH_SIZE = 100;
const GEMINI_CONCURRENCY = 4;

export type ClusterAlgorithm = 'average-linkage';

// ---------------------------------------------------------------------------
// Stage 1 — structured pre-bucketing
// ---------------------------------------------------------------------------

/** Treats the placeholder values geocoders and models emit as "not supplied". */
function clean(value?: string): string {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  const lowered = trimmed.toLowerCase();
  if (lowered === 'unknown' || lowered === 'undefined' || lowered === 'null' || lowered === 'not provided') {
    return '';
  }
  return trimmed;
}

export interface ResolvedLocation {
  /** Bucket key. Always the same arity, so keys are comparable as strings. */
  key: string;
  label: string;
  granularity: LocationGranularity;
}

/**
 * Which administrative level stage 1 buckets on.
 *
 * `district` is the default because `ward` produces buckets too small to
 * cluster: measured on the seeded corpus, ward-level bucketing put 260
 * complaints into 256 buckets (1.02 each), so average linkage had nothing to
 * merge and the pipeline produced one demand signal per complaint. District is
 * also the level a municipal complaint register actually reports at.
 *
 * `ward` remains available for callers that genuinely want neighbourhood-level
 * resolution, and will produce many singletons on a sparse corpus.
 */
export type BucketGranularity = 'state' | 'district' | 'ward';

export const DEFAULT_BUCKET_GRANULARITY: BucketGranularity = 'district';

/**
 * Buckets on the finest administrative level the complaint actually names.
 *
 * `ceiling` caps how far the bucket is allowed to resolve. The rule that
 * mattered before still holds, just inverted: a complaint that names only a
 * district is not allowed to borrow a ward-level neighbour, because that would
 * overstate the resolution it actually has. The default ceiling is district, so
 * a ward complaint and a district-only complaint about the same place now land
 * together — which is the point, since they are the same city responsibility.
 *
 * The state is always part of the key so two districts sharing a name in
 * different states never collide.
 */
export function resolveLocation(
  state?: string,
  district?: string,
  ward?: string,
  ceiling: BucketGranularity = 'ward'
): ResolvedLocation {
  const s = clean(state);
  const d = clean(district);
  const w = clean(ward);

  const allowWard = ceiling === 'ward';
  const allowDistrict = ceiling === 'ward' || ceiling === 'district';

  if (w && allowWard) {
    const place = [d, s].filter(Boolean).join(', ');
    return { key: `${s}|${d}|${w}`, label: place ? `${place} — ${w}` : w, granularity: 'ward' };
  }
  if (d && allowDistrict) {
    const place = [d, s].filter(Boolean).join(', ');
    return { key: `${s}|${d}|`, label: place, granularity: 'district' };
  }
  if (s) {
    return { key: `${s}||`, label: s, granularity: 'state' };
  }
  return { key: '||', label: 'Unspecified location', granularity: 'unknown' };
}

/**
 * Canonical civic-problem slugs, and the aliases that fold into them.
 *
 * This exists because stage 1 buckets on an exact string match, so two spellings
 * of one problem are two buckets and can never merge. Real data contained
 * `street_light_outage` and `streetlight_outage` in the same corpus, and
 * `water_pipe_burst` and `water_supply_burst`; both pairs are the same
 * municipal complaint, and neither can be fixed after the fact by the
 * clustering stage because no cluster is ever proposed across a bucket boundary.
 *
 * Deliberately conservative: the table lists only spellings observed in this
 * corpus that are genuinely the same complaint. There is no fuzzy or edit-
 * distance matching, because merging `broken_handrail` into `fallen_tree`
 * because the strings are similar would be a worse failure than leaving two
 * singleton signals that a human can read and correct. Adding to this table is
 * the intended way to widen it.
 */
const ISSUE_TYPE_ALIASES: Record<string, string> = {
  // "pot hole" and "pothole" are one thing; slugifying alone keeps them apart.
  pot_hole: 'pothole',
  // The seed uses ROAD_POTHOLE as its canonical source category, and Gemini
  // extraction keeps it verbatim, leaving a type whose own bucket can never
  // match the "pothole" complaints filed under a neighbouring category.
  road_pothole: 'pothole',
  // The single most common split in the seeded data.
  streetlight_outage: 'street_light_outage',
  water_supply_burst: 'water_pipe_burst',
  // "wiring" is the noun a citizen uses; "wire" is the one a model emits.
  dangling_live_wire: 'dangling_live_wiring',
  // Municipal complaint registers treat a damaged kerbside drain and an
  // overflowing drain as one item.
  broken_storm_gutter: 'storm_drain_blockage',
  drainage_overflow: 'sewage_overflow',
};

/**
 * Token-level aliases, used only to reduce a composite slug to one canonical
 * value. Categories arrive with compound names — `damaged_bench_and_garbage_
 * dump`, `public_infrastructure_damage_and_waste_accumulation` — which are
 * two unrelated problems filed under one label. Leaving them whole guarantees a
 * bucket that can never match the pure form of either half.
 */
const ISSUE_TYPE_TOKEN_ALIASES: Record<string, string> = {
  waste: 'garbage_dump',
  waste_accumulation: 'garbage_dump',
  garbage: 'garbage_dump',
  rubbish: 'garbage_dump',
  drain: 'storm_drain_blockage',
  drainage: 'storm_drain_blockage',
  gutter: 'storm_drain_blockage',
  waterlogging: 'storm_drain_blockage',
  pipe: 'water_pipe_burst',
  pipeline: 'water_pipe_burst',
  water: 'water_pipe_burst',
  streetlight: 'street_light_outage',
  street_light: 'street_light_outage',
  light: 'street_light_outage',
};

/**
 * Reduces a raw issue type to a canonical slug.
 *
 * Three steps, in order: slugify, then fold whole-string aliases, then — only
 * if the slug is a compound — resolve it to its first recognisable component.
 * The compound step never runs on a slug that is already canonical, so it can
 * only ever make a label coarser, never move a known category somewhere new.
 */
export function normalizeIssueType(issueType: string): string {
  const slug = clean(issueType).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) return '';

  const direct = ISSUE_TYPE_ALIASES[slug];
  if (direct) return direct;

  const parts = slug.split('_').filter(Boolean);
  if (parts.length <= 1) return slug;

  for (const part of parts) {
    const aliased = ISSUE_TYPE_TOKEN_ALIASES[part];
    if (aliased) return aliased;
    // A multi-word canonical name may itself appear intact in the compound.
    for (const [token, canonical] of Object.entries(ISSUE_TYPE_TOKEN_ALIASES)) {
      if (slug.includes(token) && canonical.includes('_')) return canonical;
    }
  }

  // Nothing in the compound is recognised; keep it rather than bucket it away,
  // so an unseen category still produces its own signal.
  return slug;
}

export interface ComplaintBucket {
  key: string;
  issueType: string;
  location: ResolvedLocation;
  complaints: Complaint[];
}

/**
 * Stage 1. Groups on the two structured fields and nothing else. This runs
 * before any embedding is computed, which is the point: bucketing is a cheap
 * exact-match filter, so the expensive semantic pass only ever runs over
 * complaints that are already plausible neighbours.
 */
export function bucketComplaints(
  complaints: Complaint[],
  ceiling: BucketGranularity = DEFAULT_BUCKET_GRANULARITY
): ComplaintBucket[] {
  const buckets = new Map<string, ComplaintBucket>();

  for (const complaint of complaints) {
    const issueType = normalizeIssueType(complaint.issueType) || 'unknown';
    const location = resolveLocation(
      complaint.locationState,
      complaint.locationDistrict,
      complaint.locationWard,
      ceiling
    );
    // Intent prefixes the key so a complaint and a development request at the
    // same place with the same issue type stay in separate buckets — the
    // clustering stage only ever sees one intent at a time.
    const key = `${complaint.intent ?? 'complaint'}::${location.key}::${issueType}`;

    const existing = buckets.get(key);
    if (existing) {
      existing.complaints.push(complaint);
      continue;
    }
    buckets.set(key, { key, issueType, location, complaints: [complaint] });
  }

  // Sorted so a rebuild of an unchanged corpus produces an unchanged result.
  return Array.from(buckets.values()).sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  );
}

// ---------------------------------------------------------------------------
// Stage 3 — similarity-based grouping
// ---------------------------------------------------------------------------

/**
 * Cosine similarity in [-1, 1]. A zero vector has no direction, so it is
 * reported as 0 rather than NaN — it will simply never merge with anything.
 *
 * Dimension mismatch throws rather than returning a score: the clustering step
 * groups by embedding model and dimension first, so unequal lengths can only
 * mean a caller compared vectors from two different embedding spaces, which
 * has no meaningful answer and must not be papered over.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Cannot compare embeddings of different dimensions (${a.length} vs ${b.length}). ` +
        'Vectors from different embedding models are not comparable.'
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function cosineDistance(a: number[], b: number[]): number {
  return 1 - cosineSimilarity(a, b);
}

/**
 * Agglomerative clustering with average (UPGMA) linkage over cosine distance,
 * cut at `1 - threshold`.
 *
 * Standard bottom-up: every complaint starts alone, the closest pair of groups
 * merges, repeat until the closest remaining pair is further apart than the
 * cutoff. Average linkage rather than single linkage because single linkage
 * chains — with 0.75 cosine on short complaints, a chain of marginally
 * related pairs would drag a whole ward into one cluster, and one link in that
 * chain being wrong is enough to produce a nonsense demand signal.
 *
 * Distances are merged with the Lance-Williams update, so a merge costs O(n)
 * instead of re-averaging every cross pair. Ties break on the lowest index
 * pair, making the output deterministic for a given input order.
 *
 * Returns arrays of indices into `vectors`.
 */
export function agglomerativeAverageLinkage(vectors: number[][], threshold: number): number[][] {
  const n = vectors.length;
  if (n === 0) return [];
  if (n === 1) return [[0]];

  const cutoff = 1 - threshold;
  const sizes = new Array<number>(n).fill(1);
  const members: number[][] = Array.from({ length: n }, (_, i) => [i]);
  const active: number[] = Array.from({ length: n }, (_, i) => i);

  // distances[a][b] is the average cosine distance between any member of a
  // and any member of b. Maintained incrementally by Lance-Williams.
  const distances: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.min(2, Math.max(0, cosineDistance(vectors[i], vectors[j])));
      distances[i][j] = d;
      distances[j][i] = d;
    }
  }

  while (active.length > 1) {
    let bestA = -1;
    let bestB = -1;
    let best = Number.POSITIVE_INFINITY;

    for (let ai = 0; ai < active.length; ai++) {
      const a = active[ai];
      for (let bi = ai + 1; bi < active.length; bi++) {
        const b = active[bi];
        const d = distances[a][b];
        if (d < best) {
          best = d;
          bestA = ai;
          bestB = bi;
        }
      }
    }

    // Strict `<` above keeps the lowest index pair on a tie, so the merge order
    // is a function of the input alone.
    if (bestA < 0 || best > cutoff) break;

    const a = active[bestA];
    const b = active[bestB];
    const totalSize = sizes[a] + sizes[b];
    for (const c of active) {
      if (c === a || c === b) continue;
      const merged = (sizes[a] * distances[a][c] + sizes[b] * distances[b][c]) / totalSize;
      distances[a][c] = merged;
      distances[c][a] = merged;
    }
    members[a] = members[a].concat(members[b]);
    sizes[a] = totalSize;
    active.splice(bestB, 1);
  }

  return active.map((i) => members[i].slice().sort((x, y) => x - y));
}

export interface ClusterOutcome {
  groups: number[][];
  algorithm: ClusterAlgorithm;
}

/**
 * Always agglomerative average linkage.
 *
 * This previously fell back to a cheaper centroid pass past MAX_BUCKET_SIZE,
 * which silently changed the clustering algorithm on exactly the buckets with
 * the most complaints — the ones where a wrong merge does the most damage — and
 * left the output dependent on the order complaints happened to arrive in. The
 * cost is bounded instead: MAX_BUCKET_SIZE is reported in the build stats when
 * a bucket exceeds it, and the average-linkage implementation is O(n^2) in
 * memory with an O(n) Lance-Williams update per merge, which is comfortable for
 * the bucket sizes district-level bucketing actually produces.
 */
export function clusterVectors(vectors: number[][], threshold: number): ClusterOutcome {
  return { groups: agglomerativeAverageLinkage(vectors, threshold), algorithm: 'average-linkage' };
}

// ---------------------------------------------------------------------------
// Stage 4 — LLM verification
// ---------------------------------------------------------------------------

/**
 * Applies per-complaint verdicts to proposed groups. A rejected complaint is
 * split out as its own cluster rather than dropped, so a bad merge costs one
 * extra row, never a lost complaint. Returns null verdicts' groups untouched.
 */
export function splitByVerdicts(
  groups: Complaint[][],
  verdicts: Map<string, boolean>
): Complaint[][] {
  const out: Complaint[][] = [];
  for (const group of groups) {
    if (group.length < 2) {
      out.push(group);
      continue;
    }
    const kept = group.filter((c) => verdicts.get(c.id) !== false);
    const rejected = group.filter((c) => verdicts.get(c.id) === false);
    if (kept.length > 0) out.push(kept);
    for (const complaint of rejected) out.push([complaint]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output shaping
// ---------------------------------------------------------------------------

function firstSentence(text: string, maxChars = 280): string {
  const collapsed = (text || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const stop = collapsed.search(/[.!?](\s|$)/);
  const sentence = stop > 0 ? collapsed.slice(0, stop + 1) : collapsed;
  return sentence.length > maxChars ? `${sentence.slice(0, maxChars - 3).trimEnd()}...` : sentence;
}

function humanize(issueType: string): string {
  return normalizeIssueType(issueType).replace(/_/g, ' ') || 'civic issue';
}

/**
 * Summary used when Gemini is unavailable or declines to write one. For a
 * single complaint that complaint's own English text is the honest summary;
 * for a merged group it is the first member's account with the corroborating
 * count attached, which says what we know without inventing a claim no
 * citizen made.
 */
/**
 * The complaint whose fields describe the whole cluster: highest urgency first,
 * ties broken on id.
 *
 * The id tie-break is load-bearing. Clustering returns groups whose order
 * depends on the order the corpus was read in, so without it two builds over
 * the same complaints would report a different location and a different summary
 * for the same set of citizens purely because the rows came back in a
 * different order.
 */
export function pickLead(members: Complaint[]): Complaint | undefined {
  return members
    .slice()
    .sort((a, b) => {
      const urgency = (Number(b.urgencyScore) || 0) - (Number(a.urgencyScore) || 0);
      if (urgency !== 0) return urgency;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })[0];
}

export function deterministicSummary(members: Complaint[]): string {
  if (members.length === 0) return '';
  const lead = pickLead(members) as Complaint;
  const text = firstSentence(lead.translatedText || lead.originalText);
  if (members.length === 1) return text || `${humanize(lead.issueType)} reported in ${lead.location}.`;
  const where = lead.location ? ` in ${lead.location}` : '';
  return `${text || `A ${humanize(lead.issueType)} problem`} (${members.length} citizen reports of the same issue${where}).`;
}

function averageUrgency(members: Complaint[]): number {
  if (members.length === 0) return 0;
  const total = members.reduce((sum, c) => sum + (Number(c.urgencyScore) || 0), 0);
  return Number((total / members.length).toFixed(2));
}

/**
 * Distinct languages actually spoken in the cluster. "Unknown" is dropped: it
 * is the absence of a detection, not a language, and listing it alongside
 * Tamil would misreport who the signal came from.
 */
function languagesOf(members: Complaint[]): string[] {
  const seen = new Set<string>();
  for (const c of members) {
    const lang = clean(c.originalLanguage);
    if (!lang || lang.toLowerCase() === 'unknown') continue;
    seen.add(lang);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/**
 * Builds the final signal record. One representative (the highest-urgency
 * member) supplies the location and issue type, because every member of a
 * cluster shares them by construction — Stage 1 guarantees it.
 */
export function toDemandSignal(
  members: Complaint[],
  summary: string,
  threshold: number,
  verificationEngine: PipelineEngine,
  sequence: number
): DemandSignal {
  const representative = pickLead(members) as Complaint;
  return {
    clusterId: `DS-${String(sequence).padStart(4, '0')}`,
    issueType: normalizeIssueType(representative.issueType) || 'unknown',
    intent: representative.intent ?? 'complaint',
    location: representative.location,
    locationState: representative.locationState,
    locationDistrict: representative.locationDistrict,
    locationWard: representative.locationWard,
    memberComplaintIds: members.map((c) => c.id).sort((a, b) => a.localeCompare(b)),
    volume: members.length,
    avgUrgency: averageUrgency(members),
    summary,
    languagesRepresented: languagesOf(members),
    similarityThreshold: threshold,
    verificationEngine,
  };
}

// ---------------------------------------------------------------------------
// Complaint intake (Stage 0) — normalising citizen reports into complaints
// ---------------------------------------------------------------------------

function englishLineFromTranscript(transcript?: string): string {
  if (!transcript) return '';
  const marker = transcript.indexOf('English:');
  return marker >= 0 ? transcript.slice(marker + 'English:'.length).trim() : '';
}

/**
 * One complaint per citizen submission, falling back to one per issue when an
 * issue carries no stored submissions (the seeded demo dataset does not).
 * Returns the same shape either way so the pipeline never has to know which
 * it is looking at.
 */
export function complaintsFromIssues(issues: Issue[]): Complaint[] {
  const complaints: Complaint[] = [];

  for (const issue of issues) {
    const reports = issue.reports && issue.reports.length > 0 ? issue.reports : [null];

    for (const report of reports) {
      const location = resolveLocation(
        issue.state ?? issue.locationDetails?.state,
        issue.locationDetails?.district,
        issue.wardId ?? issue.locationDetails?.mandal
      );
      const originalText = report?.citizenNotes?.trim() || issue.description?.trim() || issue.title;
      const transcript = report?.transcript ?? issue.transcript;

      complaints.push({
        id: `cmp-${report ? report.id : issue.id}`,
        sourceIssueId: issue.id,
        sourceReportId: report?.id,
        issueType: normalizeIssueType(issue.category?.code || 'unknown'),
        intent: issue.intent ?? 'complaint',
        locationState: clean(issue.state ?? issue.locationDetails?.state) || undefined,
        locationDistrict: clean(issue.locationDetails?.district) || undefined,
        locationWard: clean(issue.wardId ?? issue.locationDetails?.mandal) || undefined,
        location: location.label,
        locationGranularity: location.granularity,
        urgencyScore: Number(issue.mlSeverityScore) || 1,
        urgencyReason: '',
        originalLanguage: 'Unknown',
        originalText,
        translatedText: englishLineFromTranscript(transcript) || originalText,
        extractionEngine: 'heuristic',
        createdAt: report?.createdAt ?? issue.createdAt,
      });
    }
  }

  return complaints;
}

/**
 * Replaces the deterministic fields with Gemini's, keeping the geocoded
 * location and the complaint id authoritative. Split out from
 * complaintsFromIssues so the no-key path is a plain function and this one is
 * the only place a network call can happen.
 */
export async function enrichComplaints(
  complaints: Complaint[],
  issues: Issue[],
  onProgress?: (done: number, total: number) => void
): Promise<Complaint[]> {
  const issueById = new Map(issues.map((i) => [i.id, i]));
  const results: Complaint[] = new Array(complaints.length);
  let done = 0;

  for (let i = 0; i < complaints.length; i += GEMINI_CONCURRENCY) {
    const slice = complaints.slice(i, i + GEMINI_CONCURRENCY);
    const settled = await Promise.all(
      slice.map(async (complaint, offset) => {
        const issue = issueById.get(complaint.sourceIssueId ?? '');
        const extracted = await extractComplaintFields({
          rawText: complaint.originalText,
          transcript: issue?.transcript,
          categoryName: issue?.category?.name ?? 'Civic issue',
          knownState: complaint.locationState,
          knownDistrict: complaint.locationDistrict,
          knownWard: complaint.locationWard,
        });
        if (!extracted) return complaint;

        const location = resolveLocation(extracted.locationState, extracted.locationDistrict, extracted.locationWard);
        const translatedText = extracted.translatedText || complaint.translatedText;
        // The stored vector was computed from the previous English text. If
        // re-extraction produced different words, that vector now represents a
        // complaint that no longer exists, so it is dropped and re-embedded
        // rather than silently clustering on stale semantics.
        const textChanged = translatedText !== complaint.translatedText;

        return {
          ...complaint,
          issueType: normalizeIssueType(extracted.issueType) || complaint.issueType,
          locationState: clean(extracted.locationState) || undefined,
          locationDistrict: clean(extracted.locationDistrict) || undefined,
          locationWard: clean(extracted.locationWard) || undefined,
          location: location.label,
          locationGranularity: location.granularity,
          urgencyScore: extracted.urgencyScore,
          urgencyReason: extracted.urgencyReason || complaint.urgencyReason,
          originalLanguage: extracted.originalLanguage || 'Unknown',
          originalText: extracted.originalText || complaint.originalText,
          translatedText,
          embedding: textChanged ? undefined : complaint.embedding,
          embeddingModel: textChanged ? undefined : complaint.embeddingModel,
          embeddingDimensions: textChanged ? undefined : complaint.embeddingDimensions,
          extractionEngine: 'gemini' as const,
        } satisfies Complaint;
      })
    );
    for (let k = 0; k < settled.length; k++) results[i + k] = settled[k];
    done += slice.length;
    onProgress?.(done, complaints.length);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** The three Gemini calls the pipeline needs, behind a seam for testing. */
export interface PipelineAi {
  embed(texts: string[]): Promise<{ model: string; dimensions: number; vectors: number[][] } | null>;
  verify(
    members: { id: string; translatedText: string; originalText: string }[]
  ): Promise<{ verdicts: Map<string, boolean>; summary: string } | null>;
}

export const geminiPipelineAi: PipelineAi = {
  embed: (texts) => embedComplaintTexts(texts),
  verify: (members) => verifyClusterMembers(members),
};

export interface BuildOptions {
  similarityThreshold?: number;
  /** Administrative level stage 1 buckets on. Defaults to district. */
  bucketGranularity?: BucketGranularity;
  /** Persist freshly computed vectors. Omit to keep the run read-only. */
  saveEmbedding?: (id: string, vector: number[], model: string) => Promise<void>;
  onProgress?: (message: string) => void;
}

export interface BuildStats {
  complaintCount: number;
  bucketCount: number;
  bucketGranularity: BucketGranularity;
  embeddedCount: number;
  reusedEmbeddingCount: number;
  reembeddedCount: number;
  embeddingModel: string | null;
  embeddingEngine: PipelineEngine;
  clusterCount: number;
  mergedClusterCount: number;
  splitOutCount: number;
  verificationCalls: number;
  verificationEngine: PipelineEngine;
  similarityThreshold: number;
  algorithms: Record<ClusterAlgorithm, number>;
  oversizedBuckets: number;
}

/**
 * The wire form of a demand signal.
 *
 * Field names are snake_case, matching the published output contract for this
 * pipeline and the `demand_signals` table it is stored in. The in-memory
 * `DemandSignal` stays camelCase because that is the convention everywhere else
 * in the codebase, so the rename happens once here at the API boundary instead
 * of propagating through the pipeline.
 */
export interface DemandSignalJson {
  cluster_id: string;
  issue_type: string;
  /**
   * Always present (`complaint` when unset): the cluster never mixes intents,
   * so this is a fixed two-value field, not an optional one.
   */
  intent: ReportIntent;
  location: string;
  location_state?: string;
  location_district?: string;
  location_ward?: string;
  complaint_ids: string[];
  volume: number;
  avg_urgency: number;
  summary: string;
  languages_represented: string[];
  similarity_threshold: number;
  verification_engine: PipelineEngine;
  /**
   * Step 4 data fusion. Always present: a null means the district has no
   * reference data, which is information the Step 5 scorer must act on (a
   * missing term, not a silent zero), so it cannot be conflated with an absent
   * field.
   */
  population_affected: number | null;
  existing_infrastructure_gap: number | null;
  data_fusion_source: string | null;
  /**
   * Step 5 priority scoring. Always present on a scored response (null when the
   * signal was never scored): the score itself, the human-readable why, the
   * component values that produced it, and whether the district had no
   * reference data at all.
   */
  priority_score: number | null;
  priority_explanation: string | null;
  data_unavailable: boolean | null;
  priority_breakdown: {
    normalized_volume: number;
    normalized_avg_urgency: number;
    infrastructure_gap_score: number | null;
    normalized_population_affected: number | null;
    weights: {
      volume: number;
      avg_urgency: number;
      infrastructure_gap: number;
      population_affected: number;
    };
  } | null;
  generated_at?: string;
  updated_at?: string;
}

/** Nudged to 3 decimals so API numbers match the in-memory breakdown exactly. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Converts a signal to its published snake_case form. */
export function toDemandSignalJson(signal: DemandSignal): DemandSignalJson {
  const noPopulation = signal.populationAffected === null || signal.populationAffected === undefined;
  const noGap = signal.existingInfrastructureGap === null || signal.existingInfrastructureGap === undefined;
  const json: DemandSignalJson = {
    cluster_id: signal.clusterId,
    issue_type: signal.issueType,
    intent: signal.intent ?? 'complaint',
    location: signal.location,
    complaint_ids: signal.memberComplaintIds,
    volume: signal.volume,
    avg_urgency: signal.avgUrgency,
    summary: signal.summary,
    languages_represented: signal.languagesRepresented,
    similarity_threshold: signal.similarityThreshold,
    verification_engine: signal.verificationEngine,
    // Fusion fields are part of the fixed contract and always serialised,
    // null included — a signal that has not been fused is indistinguishable
    // from one whose district has no data, and both must be visible.
    population_affected: signal.populationAffected ?? null,
    existing_infrastructure_gap: signal.existingInfrastructureGap ?? null,
    data_fusion_source: signal.dataFusionSource ?? null,
    // Priority fields share the same rule: always emitted so the dashboard
    // contract is uniform, null when this signal was never scored.
    priority_score: signal.priorityScore ?? null,
    priority_explanation: signal.priorityExplanation ?? null,
    data_unavailable: signal.dataUnavailable ?? (noPopulation && noGap),
    priority_breakdown: signal.priorityBreakdown
      ? {
          normalized_volume: round3(signal.priorityBreakdown.normalizedVolume),
          normalized_avg_urgency: round3(signal.priorityBreakdown.normalizedAvgUrgency),
          infrastructure_gap_score: signal.priorityBreakdown.infrastructureGapScore,
          normalized_population_affected: signal.priorityBreakdown.normalizedPopulationAffected,
          weights: {
            volume: round3(signal.priorityBreakdown.weights.volume),
            avg_urgency: round3(signal.priorityBreakdown.weights.avgUrgency),
            infrastructure_gap: round3(signal.priorityBreakdown.weights.infrastructureGap),
            population_affected: round3(signal.priorityBreakdown.weights.populationAffected),
          },
        }
      : null,
  };
  // Optional fields are omitted rather than serialised as null, so a consumer
  // can test for presence without also having to test for null.
  if (signal.locationState !== undefined) json.location_state = signal.locationState;
  if (signal.locationDistrict !== undefined) json.location_district = signal.locationDistrict;
  if (signal.locationWard !== undefined) json.location_ward = signal.locationWard;
  if (signal.createdAt !== undefined) json.generated_at = signal.createdAt;
  if (signal.updatedAt !== undefined) json.updated_at = signal.updatedAt;
  return json;
}

/** `?intent=` accepted by every demand-signal read endpoint. */
export type IntentFilter = ReportIntent | 'all';

/**
 * Parses an `intent` query parameter. Anything that is not one of the two
 * intents means `all` — an unknown value degrades to the unfiltered view
 * rather than to an empty one, so a typo in a client cannot blank the panel.
 */
export function parseIntentParam(raw: string | null | undefined): IntentFilter {
  if (raw === 'complaint' || raw === 'development_request') return raw;
  return 'all';
}

/** Applies an intent filter; rows written without an intent are complaints. */
export function filterByIntent<T extends { intent?: ReportIntent }>(
  rows: T[],
  filter: IntentFilter
): T[] {
  if (filter === 'all') return rows;
  return rows.filter((row) => (row.intent ?? 'complaint') === filter);
}

export interface BuildResult {
  signals: DemandSignal[];
  stats: BuildStats;
}

/**
 * Embeds the complaints that do not have a usable vector yet, leaving stored
 * ones alone. Re-embedding the whole corpus on every build would cost a full
 * Gemini sweep for no change in the vectors; the missing-only rule also means
 * a build with nothing new to embed makes zero embedding calls.
 *
 * A stored vector is only reused when it belongs to the model this run is
 * actually using. Vectors outlive the process that made them, and the model is
 * discovered per process, so an earlier build can leave a corpus holding two
 * embedding spaces at once. That is not a correctness bug — stage 3 never
 * compares across models — but it silently caps how much can merge, because a
 * complaint embedded by one model can never join a group built from the other.
 *
 * Convergence is therefore driven by the run making at least one embedding
 * call, which is what teaches it which model is working now. A rebuild with
 * nothing new to embed makes no call, learns nothing, and leaves a split corpus
 * split — deliberately, because the alternative is re-embedding the entire
 * corpus on every build, which is exactly what reusing stored vectors exists to
 * avoid. `stats.embeddingModel` reports the model in play so a split corpus is
 * at least visible.
 */
async function ensureEmbeddings(
  complaints: Complaint[],
  buckets: ComplaintBucket[],
  ai: PipelineAi,
  saveEmbedding?: BuildOptions['saveEmbedding']
): Promise<{
  engine: PipelineEngine;
  embedded: number;
  reused: number;
  reembedded: number;
  model: string | null;
  complaints: Complaint[];
}> {
  // Works on copies: the caller owns the array it passed in (in the build
  // route it is the list it also persists), so filling in vectors must not
  // silently rewrite objects the caller still holds.
  const prepared = complaints.map((c) => ({ ...c }));
  const byId = new Map(prepared.map((c) => [c.id, c]));

  const hasVector = (c: Complaint): boolean =>
    !!c.embedding && c.embedding.length > 0 && !!c.embeddingModel;

  // Only complaints stage 3 will actually compare need a vector, so only those
  // are worth paying for. Singletons of a single-complaint bucket are excluded.
  const comparable = new Set<string>();
  for (const bucket of buckets) {
    if (bucket.complaints.length > 1) {
      for (const c of bucket.complaints) comparable.add(c.id);
    }
  }

  const missing: Complaint[] = [];
  let reused = 0;
  for (const complaint of prepared) {
    if (hasVector(complaint)) reused++;
    else if (comparable.has(complaint.id)) missing.push(complaint);
  }

  // Nothing new to embed means no Gemini call at all — a rebuild over an
  // unchanged corpus is free.
  if (missing.length === 0) {
    return {
      engine: reused > 0 ? 'gemini' : 'unavailable',
      embedded: 0,
      reused,
      reembedded: 0,
      model: prepared.find((c) => c.embeddingModel)?.embeddingModel ?? null,
      complaints: prepared,
    };
  }

  // The first successful batch establishes the model for the whole run; every
  // later batch must agree, and any complaint already stored under a different
  // model is re-embedded so the corpus converges instead of staying split.
  let activeModel: string | null = null;
  const stale: Complaint[] = [];
  const pending = missing.slice();

  const texts = pending.map((c) => c.translatedText || c.originalText);
  let embedded = 0;
  let engine: PipelineEngine = 'unavailable';

  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = await ai.embed(texts.slice(i, i + EMBEDDING_BATCH_SIZE));
    if (!batch) continue;
    engine = 'gemini';

    if (!activeModel) {
      activeModel = batch.model;
      // Everything already holding a different model's vector is now stale.
      for (const complaint of prepared) {
        if (hasVector(complaint) && complaint.embeddingModel !== activeModel) {
          stale.push(complaint);
          reused--;
        }
      }
    } else if (batch.model !== activeModel) {
      // The provider handed back a different model mid-run. Stage 3 will keep
      // these apart rather than compare them, but it is worth being loud.
      console.error(
        `[demand-signals] embedding model changed mid-run (${activeModel} -> ${batch.model}); ` +
          'those complaints will be clustered separately'
      );
    }

    for (let k = 0; k < batch.vectors.length; k++) {
      const complaint = pending[i + k];
      complaint.embedding = batch.vectors[k];
      complaint.embeddingModel = batch.model;
      complaint.embeddingDimensions = batch.dimensions;
      embedded++;
      if (saveEmbedding) await saveEmbedding(complaint.id, batch.vectors[k], batch.model);
    }
  }

  for (let i = 0; i < stale.length; i += EMBEDDING_BATCH_SIZE) {
    const slice = stale.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batch = await ai.embed(slice.map((c) => c.translatedText || c.originalText));
    if (!batch) continue;
    engine = 'gemini';
    for (let k = 0; k < batch.vectors.length; k++) {
      const target = byId.get(slice[k].id);
      if (!target) continue;
      target.embedding = batch.vectors[k];
      target.embeddingModel = batch.model;
      target.embeddingDimensions = batch.dimensions;
      if (saveEmbedding) await saveEmbedding(slice[k].id, batch.vectors[k], batch.model);
    }
  }

  return { engine, embedded, reused, reembedded: stale.length, model: activeModel, complaints: prepared };
}

/**
 * Runs all four stages. Returns the final signals plus the stats that explain
 * how they were produced — a clustering pipeline nobody can audit is the thing
 * this whole design exists to avoid.
 */
export async function buildDemandSignals(
  complaints: Complaint[],
  ai: PipelineAi = geminiPipelineAi,
  options: BuildOptions = {}
): Promise<BuildResult> {
  const threshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const progress = options.onProgress ?? (() => {});

  // Stage 1 runs first and unconditionally. Bucketing is an exact-match filter
  // on structured fields, so it must be settled before anything expensive or
  // semantic happens: the only complaints worth embedding are the ones that
  // already share a bucket, and nothing outside a bucket is ever compared.
  progress('bucketing complaints by issue type and location');
  const buckets = bucketComplaints(complaints, options.bucketGranularity);

  progress('embedding complaint text');
  const embedding = await ensureEmbeddings(
    complaints,
    buckets,
    ai,
    options.saveEmbedding
  );

  // Carry the freshly computed vectors back onto the complaint objects the
  // bucket list points at, so stage 3 reads one consistent set of records.
  const embeddedById = new Map(embedding.complaints.map((c) => [c.id, c]));

  // --- Stage 3 -------------------------------------------------------------
  progress('clustering within buckets');
  const proposed: Complaint[][] = [];
  const algorithms: Record<ClusterAlgorithm, number> = { 'average-linkage': 0 };
  let oversizedBuckets = 0;

  for (const bucket of buckets) {
    if (bucket.complaints.length > MAX_BUCKET_SIZE) oversizedBuckets++;

    // Vectors from different models live in different spaces, so they are
    // clustered as separate sub-problems rather than compared. Complaints with
    // no vector at all (the embedding call failed) become singletons.
    const byModel = new Map<string, Complaint[]>();
    for (const original of bucket.complaints) {
      const complaint = embeddedById.get(original.id) ?? original;
      if (!complaint.embedding || !complaint.embeddingModel) continue;
      const key = `${complaint.embeddingModel}:${complaint.embedding.length}`;
      const list = byModel.get(key);
      if (list) list.push(complaint);
      else byModel.set(key, [complaint]);
    }

    for (const members of Array.from(byModel.values())) {
      const vectors = members.map((c) => c.embedding as number[]);
      const { groups, algorithm } = clusterVectors(vectors, threshold);
      algorithms[algorithm]++;
      for (const group of groups) proposed.push(group.map((i) => members[i]));
    }
    for (const original of bucket.complaints) {
      const complaint = embeddedById.get(original.id) ?? original;
      if (!complaint.embedding || !complaint.embeddingModel) proposed.push([complaint]);
    }
  }

  // --- Stage 4 -------------------------------------------------------------
  progress('verifying proposed clusters');
  let verificationCalls = 0;
  let verificationEngine: PipelineEngine = 'unavailable';
  let splitOut = 0;

  // Summary is captured as a side effect of verification and keyed by the
  // confirmed member set, so a group never gets verified twice just to obtain
  // a sentence that was already paid for.
  const summaries = new Map<string, string>();
  const memberKey = (members: Complaint[]): string =>
    members.map((c) => c.id).sort((a, b) => a.localeCompare(b)).join('|');

  let groups = proposed;
  for (let round = 0; round < MAX_VERIFICATION_ROUNDS; round++) {
    const pending = groups.map((g, i) => ({ g, i })).filter(({ g }) => g.length > 1);
    if (pending.length === 0) break;

    const settled = await Promise.all(
      pending.map(async ({ g }) => {
        const verdict = await ai.verify(
          g.map((c) => ({ id: c.id, translatedText: c.translatedText, originalText: c.originalText }))
        );
        return { g, verdict };
      })
    );

    verificationCalls += settled.length;
    if (settled.some(({ verdict }) => verdict !== null)) verificationEngine = 'gemini';

    const applied = new Map<number, { pieces: Complaint[][]; summary: string }>();
    settled.forEach(({ g, verdict }, slot) => {
      if (!verdict) return;
      applied.set(pending[slot].i, {
        pieces: splitByVerdicts([g], verdict.verdicts),
        summary: verdict.summary,
      });
    });

    const next: Complaint[][] = [];
    groups.forEach((group, i) => {
      const result = applied.get(i);
      if (!result) {
        next.push(group);
        return;
      }
      // The summary describes the group that survived, so it is filed against
      // that group's member set rather than the one that was submitted.
      const kept = result.pieces.find((p) => p.length > 1) ?? result.pieces[0];
      if (result.summary && kept.length > 1) summaries.set(memberKey(kept), result.summary);
      // Every extra piece is a complaint the model pulled out of a merge.
      splitOut += result.pieces.length - 1;
      next.push(...result.pieces);
    });
    groups = next;
  }

  // --- Output --------------------------------------------------------------
  progress('writing demand signals');
  const ordered = groups
    .map((members) => {
      const lead = pickLead(members) as Complaint;
      return {
        members,
        sortKey: `${normalizeIssueType(lead.issueType)}|${lead.location}|${memberKey(members)}`,
      };
    })
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  const signals = ordered.map(({ members }, i) =>
    toDemandSignal(
      members,
      summaries.get(memberKey(members)) || deterministicSummary(members),
      threshold,
      verificationEngine,
      i + 1
    )
  );

  return {
    signals,
    stats: {
      complaintCount: complaints.length,
      bucketCount: buckets.length,
      bucketGranularity: options.bucketGranularity ?? DEFAULT_BUCKET_GRANULARITY,
      embeddedCount: embedding.embedded,
      reusedEmbeddingCount: embedding.reused,
      reembeddedCount: embedding.reembedded,
      embeddingModel: embedding.model,
      embeddingEngine: embedding.engine,
      clusterCount: signals.length,
      mergedClusterCount: signals.filter((s) => s.volume > 1).length,
      splitOutCount: splitOut,
      verificationCalls,
      verificationEngine,
      similarityThreshold: threshold,
      algorithms,
      oversizedBuckets,
    },
  };
}
