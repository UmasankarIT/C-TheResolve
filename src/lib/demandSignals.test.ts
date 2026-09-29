import { describe, it, expect } from 'vitest';
import {
  MAX_BUCKET_SIZE,
  bucketComplaints,
  cosineSimilarity,
  agglomerativeAverageLinkage,
  clusterVectors,
  resolveLocation,
  normalizeIssueType,
  splitByVerdicts,
  deterministicSummary,
  pickLead,
  toDemandSignal,
  toDemandSignalJson,
  complaintsFromIssues,
  buildDemandSignals,
  type PipelineAi,
} from './demandSignals';
import type { Complaint, Issue } from './types';
import { scoreDemandSignals } from './priorityScore';

// These tests lock down the three places the demand-signal pipeline can fail
// quietly: a bucket key that lets two different problems meet, an average-
// linkage implementation that actually behaves like single linkage, and a
// stage 4 that re-bills Gemini for a summary it already paid for. Each of
// those produces plausible-looking output, so none of them would show up as
// a crash in a demo.

function makeComplaint(overrides: Partial<Complaint> = {}): Complaint {
  return {
    id: 'cmp-1',
    issueType: 'pot_hole',
    locationState: 'Andhra Pradesh',
    locationDistrict: 'Visakhapatnam',
    locationWard: 'WARD-42',
    location: 'Visakhapatnam, Andhra Pradesh — WARD-42',
    locationGranularity: 'ward',
    urgencyScore: 3,
    originalLanguage: 'Telugu',
    originalText: 'రోడ్డు పూడు ఉంది',
    translatedText: 'There is a large pothole on the road.',
    extractionEngine: 'heuristic',
    ...overrides,
  };
}

const A = [1, 0, 0];
const B = [0.9, 0.43589, 0];
const C = [0.5, 0.8, 0.33166];

describe('resolveLocation', () => {
  it('buckets on the finest granularity actually supplied', () => {
    expect(resolveLocation('Telangana', 'Hyderabad', 'WARD-07').granularity).toBe('ward');
    expect(resolveLocation('Telangana', 'Hyderabad', undefined).granularity).toBe('district');
    expect(resolveLocation('Telangana', undefined, undefined).granularity).toBe('state');
    expect(resolveLocation(undefined, undefined, undefined).granularity).toBe('unknown');
  });

  it('treats the placeholders geocoders emit as "not supplied"', () => {
    // A model that answers "unknown" must not be able to invent a bucket that
    // real reports never join.
    expect(resolveLocation('Karnataka', 'unknown', 'Not Provided').key).toBe(resolveLocation('Karnataka').key);
  });

  it('keeps same-named districts in different states apart', () => {
    // Rampur exists in several states; merging a UP complaint into an
    // identical-looking one in Bihar would be invisible and wrong.
    expect(resolveLocation('Uttar Pradesh', 'Rampur').key).not.toBe(resolveLocation('Bihar', 'Rampur').key);
  });
});

describe('normalizeIssueType', () => {
  it('reduces spelling variants to one bucket key', () => {
    expect(normalizeIssueType('Pothole & Road Damage')).toBe('pothole_road_damage');
    expect(normalizeIssueType('  Street Light Outage  ')).toBe('street_light_outage');
    expect(normalizeIssueType('')).toBe('');
  });

  it('folds observed synonyms onto one canonical slug', () => {
    // These pairs were all present in the same corpus. Because stage 1 is an
    // exact match, each pair was two buckets and neither could ever merge.
    expect(normalizeIssueType('pot_hole')).toBe('pothole');
    expect(normalizeIssueType('road_pothole')).toBe('pothole');
    expect(normalizeIssueType('ROAD_POTHOLE')).toBe('pothole');
    expect(normalizeIssueType('streetlight_outage')).toBe('street_light_outage');
    expect(normalizeIssueType('street_light_outage')).toBe('street_light_outage');
    expect(normalizeIssueType('water_supply_burst')).toBe('water_pipe_burst');
    expect(normalizeIssueType('dangling_live_wire')).toBe('dangling_live_wiring');
    expect(normalizeIssueType('broken_storm_gutter')).toBe('storm_drain_blockage');
  });

  it('reduces a compound category to its first recognisable component', () => {
    // Compound labels are two unrelated problems under one name, so they can
    // never match the pure form of either half.
    expect(normalizeIssueType('damaged_bench_and_garbage_dump')).toBe('garbage_dump');
    expect(normalizeIssueType('damaged_public_bench_and_garbage_dump')).toBe('garbage_dump');
    expect(normalizeIssueType('public_infrastructure_damage_and_waste_accumulation')).toBe('garbage_dump');
  });

  it('keeps an unrecognised category rather than discarding it', () => {
    expect(normalizeIssueType('fallen_tree')).toBe('fallen_tree');
    expect(normalizeIssueType('broken_handrail')).toBe('broken_handrail');
    // A compound with no recognisable component is kept, not half-dropped.
    expect(normalizeIssueType('damaged_public_infrastructure')).toBe('damaged_public_infrastructure');
  });

  it('unions a complaint carrying a seed variant with its canonical bucket', async () => {
    // A friend's own word for "pothole" filing under ROAD_POTHOLE used to land
    // in a bucket of one, permanently unable to merge with the potholes.
    const mixed = [
      makeComplaint({ id: 'p1', issueType: 'pothole' }),
      makeComplaint({ id: 'p2', issueType: 'pothole' }),
      makeComplaint({ id: 'r1', issueType: 'road_pothole' }),
    ];
    const { signals } = await buildDemandSignals(mixed, stubAi());
    expect(signals).toHaveLength(1);
    expect(signals[0].volume).toBe(3);
  });
});

describe('stage 1 — bucketComplaints', () => {
  it('never puts two issue types in the same bucket', () => {
    const buckets = bucketComplaints([
      makeComplaint({ id: 'c1', issueType: 'pot_hole' }),
      makeComplaint({ id: 'c2', issueType: 'open_manhole' }),
    ]);
    expect(buckets).toHaveLength(2);
    expect(buckets[0].complaints).toHaveLength(1);
  });

  it('never puts two districts in the same bucket', () => {
    const buckets = bucketComplaints([
      makeComplaint({ id: 'c1' }),
      makeComplaint({
        id: 'c2',
        locationDistrict: 'Guntur',
        locationWard: 'GNT-1',
        location: 'Guntur, Andhra Pradesh — GNT-1',
      }),
    ]);
    expect(buckets).toHaveLength(2);
  });

  it('never puts two states in the same bucket even with the same district name', () => {
    const buckets = bucketComplaints([
      makeComplaint({ id: 'c1', locationDistrict: 'Central', locationWard: undefined }),
      makeComplaint({
        id: 'c2',
        locationState: 'Tamil Nadu',
        locationDistrict: 'Central',
        locationWard: undefined,
      }),
    ]);
    expect(buckets).toHaveLength(2);
  });

  it('defaults to district, so a ward complaint and a district-only one meet', () => {
    // Ward-level bucketing put 260 seeded complaints into 256 buckets, leaving
    // average linkage nothing to merge. District is both the complaint-register
    // level and coarse enough to actually cluster.
    const narrow = makeComplaint({ id: 'c1' });
    const wide = makeComplaint({
      id: 'c2',
      locationWard: undefined,
      location: 'Visakhapatnam, Andhra Pradesh',
      locationGranularity: 'district',
    });
    const buckets = bucketComplaints([narrow, wide]);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].complaints.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    expect(buckets[0].location.granularity).toBe('district');
  });

  it('keeps a ward complaint out of a district bucket when ward resolution is asked for', () => {
    // The ward complaint has been narrowed; merging it district-wide would
    // report a problem at the wrong scale.
    const narrow = makeComplaint({ id: 'c1' });
    const wide = makeComplaint({
      id: 'c2',
      locationWard: undefined,
      location: 'Visakhapatnam, Andhra Pradesh',
      locationGranularity: 'district',
    });
    const buckets = bucketComplaints([narrow, wide], 'ward');
    expect(buckets).toHaveLength(2);
  });

  it('coarsens every complaint to state level when asked', () => {
    const buckets = bucketComplaints(
      [
        makeComplaint({ id: 'c1' }),
        makeComplaint({ id: 'c2', locationDistrict: 'Guntur', locationWard: 'GNT-1' }),
      ],
      'state'
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].location.granularity).toBe('state');
  });

  it('produces the same buckets for the same input regardless of order', () => {
    const complaints = [
      makeComplaint({ id: 'c1' }),
      makeComplaint({ id: 'c2', issueType: 'garbage_dump' }),
      makeComplaint({ id: 'c3' }),
    ];
    const forward = bucketComplaints(complaints).map((b) => b.key);
    const reversed = bucketComplaints([...complaints].reverse()).map((b) => b.key);
    expect(reversed).toEqual(forward);
  });

  it('keeps a complaint with no location rather than dropping it', () => {
    const buckets = bucketComplaints([
      makeComplaint({ id: 'c1', locationState: undefined, locationDistrict: undefined, locationWard: undefined }),
    ]);
    expect(buckets[0].complaints.map((c) => c.id)).toEqual(['c1']);
  });
});

describe('cosineSimilarity', () => {
  it('scores identical directions as 1 and orthogonal as 0', () => {
    expect(cosineSimilarity(A, A)).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('is scale invariant', () => {
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1, 10);
  });

  it('reports a zero vector as no similarity instead of NaN', () => {
    // A zero vector has no direction; NaN would poison the distance matrix and
    // silently decide the cluster for everything downstream of it.
    expect(cosineSimilarity([0, 0, 0], A)).toBe(0);
  });

  it('refuses to compare vectors of different dimensions', () => {
    expect(() => cosineSimilarity([1, 0, 0], [1, 0])).toThrow(/different dimensions/);
  });
});

describe('stage 3 — agglomerativeAverageLinkage', () => {
  it('returns no groups for no input and one singleton for a single input', () => {
    expect(agglomerativeAverageLinkage([], 0.75)).toEqual([]);
    expect(agglomerativeAverageLinkage([A], 0.75)).toEqual([[0]]);
  });

  it('merges complaints that clear the threshold', () => {
    expect(agglomerativeAverageLinkage([A, B], 0.75)).toEqual([[0, 1]]);
  });

  it('leaves complaints below the threshold apart', () => {
    expect(agglomerativeAverageLinkage([A, C], 0.75)).toEqual([[0], [1]]);
  });

  it('does not chain, unlike single linkage', () => {
    // cos(A,B)=0.90 and cos(B,C)=0.80 both clear 0.75, but cos(A,C)=0.50 does
    // not. Average linkage merges A+B, then computes the group-to-C distance
    // as (0.50+0.20)/2 = 0.35 > 0.25 and stops. Single linkage would look
    // only at B-C (0.20) and drag C in, producing a demand signal that spans
    // two unrelated problems.
    expect(agglomerativeAverageLinkage([A, B, C], 0.75)).toEqual([[0, 1], [2]]);
  });

  it('merges everything at a zero threshold and nothing above one', () => {
    expect(agglomerativeAverageLinkage([A, B, C], 0)).toEqual([[0, 1, 2]]);
    // Cosine 1.0 cutoff means only exact duplicates merge.
    expect(agglomerativeAverageLinkage([A, B, C], 1)).toEqual([[0], [1], [2]]);
  });

  it('is deterministic for tied distances', () => {
    const run = () => agglomerativeAverageLinkage([A, B, C, [1, 0, 0]], 0.75);
    expect(run()).toEqual(run());
  });
});

describe('clusterVectors', () => {
  it('uses average linkage for an ordinary bucket', () => {
    const outcome = clusterVectors([A, B, C], 0.75);
    expect(outcome.algorithm).toBe('average-linkage');
    expect(outcome.groups).toEqual([[0, 1], [2]]);
  });

  it('stays average linkage past the size limit', () => {
    // There is deliberately no cheaper algorithm to fall back to: the centroid
    // pass was order-dependent and kicked in on exactly the largest buckets.
    const vectors = Array.from({ length: MAX_BUCKET_SIZE + 1 }, (_, i) =>
      i % 2 === 0 ? [1, 0] : [0.98, 0.2]
    );
    const outcome = clusterVectors(vectors, 0.75);
    expect(outcome.algorithm).toBe('average-linkage');
    // Every input is placed exactly once, and nothing is dropped.
    expect(outcome.groups.flat().sort((a, b) => a - b)).toEqual(vectors.map((_, i) => i));
  });
});

describe('stage 4 — splitByVerdicts', () => {
  const group = [
    makeComplaint({ id: 'c1' }),
    makeComplaint({ id: 'c2' }),
    makeComplaint({ id: 'c3' }),
  ];

  it('leaves a fully confirmed group alone', () => {
    const verdicts = new Map([['c1', true], ['c2', true], ['c3', true]]);
    const [result] = splitByVerdicts([group], verdicts);
    expect(result).toHaveLength(3);
  });

  it('splits a rejected complaint out as its own cluster', () => {
    const verdicts = new Map([['c1', true], ['c2', false], ['c3', true]]);
    const pieces = splitByVerdicts([group], verdicts);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].map((c) => c.id)).toEqual(['c1', 'c3']);
    expect(pieces[1].map((c) => c.id)).toEqual(['c2']);
  });

  it('keeps a singleton group as-is', () => {
    const pieces = splitByVerdicts([[group[0]]], new Map([['c1', false]]));
    expect(pieces).toEqual([[group[0]]]);
  });

  it('loses no complaint when everything is rejected', () => {
    const verdicts = new Map([['c1', false], ['c2', false], ['c3', false]]);
    const pieces = splitByVerdicts([group], verdicts);
    expect(pieces.flat().map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(pieces).toHaveLength(3);
  });
});

describe('deterministicSummary', () => {
  it('uses the citizen own words for a lone complaint', () => {
    const summary = deterministicSummary([makeComplaint()]);
    expect(summary).toBe('There is a large pothole on the road.');
  });

  it('attaches the corroborating count to a merged group', () => {
    const summary = deterministicSummary([
      makeComplaint({ id: 'c1' }),
      makeComplaint({ id: 'c2' }),
    ]);
    expect(summary).toContain('2 citizen reports');
  });
});

describe('toDemandSignal', () => {
  it('emits every field the spec requires', () => {
    const signal = toDemandSignal(
      [
        makeComplaint({ id: 'c1', urgencyScore: 2, originalLanguage: 'Telugu' }),
        makeComplaint({ id: 'c2', urgencyScore: 4, originalLanguage: 'Hindi' }),
      ],
      'Residents report a deep pothole on the main road.',
      0.75,
      'gemini',
      1
    );

    // The eight fields the output contract names, under the casing this
    // codebase uses everywhere else.
    expect(signal).toHaveProperty('clusterId');
    expect(signal).toHaveProperty('issueType');
    expect(signal).toHaveProperty('location');
    expect(signal).toHaveProperty('memberComplaintIds');
    expect(signal).toHaveProperty('volume');
    expect(signal).toHaveProperty('avgUrgency');
    expect(signal).toHaveProperty('summary');
    expect(signal).toHaveProperty('languagesRepresented');
    // Plus the provenance of the two numbers a policymaker would otherwise
    // have to take on trust.
    expect(signal.similarityThreshold).toBe(0.75);
    expect(signal.verificationEngine).toBe('gemini');
  });

  it('averages member urgency', () => {
    const signal = toDemandSignal(
      [
        makeComplaint({ id: 'c1', urgencyScore: 2 }),
        makeComplaint({ id: 'c2', urgencyScore: 5 }),
      ],
      's',
      0.75,
      'gemini',
      1
    );
    expect(signal.avgUrgency).toBe(3.5);
  });

  it('counts members as volume and takes the location from the members', () => {
    const signal = toDemandSignal(
      [makeComplaint({ id: 'c1' }), makeComplaint({ id: 'c2' }), makeComplaint({ id: 'c3' })],
      's',
      0.75,
      'gemini',
      7
    );
    expect(signal.volume).toBe(3);
    expect(signal.clusterId).toBe('DS-0007');
    expect(signal.location).toBe('Visakhapatnam, Andhra Pradesh — WARD-42');
  });

  it('lists each distinct language once and drops undetected ones', () => {
    const signal = toDemandSignal(
      [
        makeComplaint({ id: 'c1', originalLanguage: 'Telugu' }),
        makeComplaint({ id: 'c2', originalLanguage: 'Telugu' }),
        makeComplaint({ id: 'c3', originalLanguage: 'Hindi' }),
        makeComplaint({ id: 'c4', originalLanguage: 'Unknown' }),
      ],
      's',
      0.75,
      'gemini',
      1
    );
    // "Unknown" is the absence of a detection, not a language, and listing it
    // beside Tamil would misreport who the signal came from.
    expect(signal.languagesRepresented).toEqual(['Hindi', 'Telugu']);
  });
});

describe('complaintsFromIssues', () => {
  const issue = (overrides: Partial<Issue> = {}): Issue =>
    ({
      id: 'iss-1',
      categoryId: 'cat-road-pothole',
      category: { code: 'ROAD_POTHOLE', name: 'Pothole & Surface Damage' },
      description: 'Deep crater near the school gate.',
      state: 'Andhra Pradesh',
      locationDetails: { state: 'Andhra Pradesh', district: 'Visakhapatnam' },
      wardId: 'WARD-42',
      mlSeverityScore: 3.5,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    }) as Issue;

  it('reads location from the geocoded fields at the finest level present', () => {
    const [complaint] = complaintsFromIssues([issue()]);
    expect(complaint.locationGranularity).toBe('ward');
    expect(complaint.locationWard).toBe('WARD-42');
  });

  it('emits one complaint per citizen submission', () => {
    const withReports = issue({
      reports: [
        { id: 'rep-1', citizenNotes: 'First report' },
        { id: 'rep-2', citizenNotes: 'Second report' },
      ] as Issue['reports'],
    });
    const complaints = complaintsFromIssues([withReports]);
    expect(complaints.map((c) => c.id)).toEqual(['cmp-rep-1', 'cmp-rep-2']);
  });

  it('emits one complaint for an issue that carries no submissions', () => {
    const complaints = complaintsFromIssues([issue()]);
    expect(complaints).toHaveLength(1);
    expect(complaints[0].id).toBe('cmp-iss-1');
  });

  it('carries the English line out of a voice transcript', () => {
    const [complaint] = complaintsFromIssues([
      issue({ transcript: 'రోడ్డు పూడు ఉంది\nEnglish: There is a pothole on the road.' }),
    ]);
    expect(complaint.originalText).toBe('Deep crater near the school gate.');
    expect(complaint.translatedText).toBe('There is a pothole on the road.');
  });
});

// ---------------------------------------------------------------------------
// End-to-end, with the Gemini calls replaced by a stub.
// ---------------------------------------------------------------------------

const SAME: number[] = [1, 0, 0];
const DIFFERENT: number[] = [0, 1, 0];

function stubAi(overrides: Partial<PipelineAi> = {}): PipelineAi {
  return {
    embed: async (texts) => ({
      model: 'stub-embedding',
      dimensions: 2,
      vectors: texts.map((t) => (t.includes('manhole') ? DIFFERENT : SAME)),
    }),
    verify: async () => null,
    ...overrides,
  };
}

describe('buildDemandSignals', () => {
  const complaints = [
    makeComplaint({ id: 'c1', translatedText: 'Deep pothole on the main road.' }),
    makeComplaint({ id: 'c2', translatedText: 'A big crater in the roadway.' }),
    makeComplaint({ id: 'c3', translatedText: 'Road surface has collapsed here.' }),
    makeComplaint({ id: 'c4', translatedText: 'Deep pothole on the main road.' }),
    makeComplaint({
      id: 'c5',
      locationWard: 'WARD-77',
      location: 'Visakhapatnam, Andhra Pradesh — WARD-77',
      translatedText: 'Deep pothole near the hospital.',
    }),
  ];

  it('collapses overlapping complaints into one signal', () => {
    // The acceptance case: complaints in one district describing one problem
    // must produce one demand signal, not one each.
    return buildDemandSignals(complaints, stubAi()).then(({ signals, stats }) => {
      expect(signals).toHaveLength(1);
      expect(signals[0].volume).toBe(5);
      expect(signals[0].memberComplaintIds.sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
      expect(stats.mergedClusterCount).toBe(1);
      expect(stats.bucketCount).toBe(1);
    });
  });

  it('keeps wards apart when ward resolution is requested', () => {
    // Same corpus, but the caller explicitly asked not to coarsen. WARD-42 and
    // WARD-77 must then stay in separate buckets and never be compared.
    return buildDemandSignals(complaints, stubAi(), { bucketGranularity: 'ward' }).then(
      ({ signals, stats }) => {
        expect(stats.bucketCount).toBe(2);
        expect(signals).toHaveLength(2);
        const inWard42 = signals.filter((s) => s.location.includes('WARD-42'));
        expect(inWard42).toHaveLength(1);
        expect(inWard42[0].volume).toBe(4);
        expect(inWard42[0].memberComplaintIds.sort()).toEqual(['c1', 'c2', 'c3', 'c4']);
        expect(stats.mergedClusterCount).toBe(1);
      }
    );
  });

  it('persists every vector it computes and reuses stored ones', async () => {
    // Mirrors the build route: complaints live in the store, vectors are
    // written back through saveEmbedding, and the next build reads them from
    // the store rather than from anything this run left in memory.
    const store = new Map<string, Complaint>(complaints.map((c) => [c.id, { ...c }]));
    let embedCalls = 0;
    const ai = stubAi({
      embed: async (texts) => {
        embedCalls++;
        return { model: 'stub-embedding', dimensions: 2, vectors: texts.map(() => SAME) };
      },
    });

    const first = await buildDemandSignals(Array.from(store.values()), ai, {
      saveEmbedding: async (id, vector, model) => {
        const existing = store.get(id);
        if (existing) store.set(id, { ...existing, embedding: vector, embeddingModel: model });
      },
    });
    expect(first.stats.embeddedCount).toBe(5);
    expect(embedCalls).toBe(1);

    // Second pass over the same corpus: the vectors are already stored, so a
    // rebuild must not re-bill the embedding call.
    const second = await buildDemandSignals(Array.from(store.values()), ai);
    expect(embedCalls).toBe(1);
    expect(second.stats.embeddedCount).toBe(0);
    expect(second.stats.reusedEmbeddingCount).toBe(5);
    expect(second.signals.map((s) => s.clusterId)).toEqual(first.signals.map((s) => s.clusterId));
  });

  it('leaves the caller complaint objects untouched', async () => {
    const input = complaints.map((c) => ({ ...c }));
    await buildDemandSignals(input, stubAi());
    // The orchestrator fills vectors in as it goes; writing them onto the
    // caller's objects would quietly rewrite the list it also persists.
    expect(input.every((c) => c.embedding === undefined)).toBe(true);
  });

  it('splits out a complaint the verification pass rejects', async () => {
    const { signals, stats } = await buildDemandSignals(
      complaints,
      stubAi({
        verify: async (members) => {
          const verdicts = new Map(members.map((m) => [m.id, m.id !== 'c3']));
          return { verdicts, summary: 'Residents report a collapsed road surface.' };
        },
      })
    );

    const inWard42 = signals.filter((s) => s.location.includes('WARD-42'));
    expect(inWard42).toHaveLength(2);
    const rejected = inWard42.find((s) => s.memberComplaintIds.includes('c3'));
    expect(rejected?.volume).toBe(1);
    expect(stats.splitOutCount).toBe(1);
  });

  it('uses the summary returned by the verification pass', async () => {
    const { signals } = await buildDemandSignals(
      complaints,
      stubAi({
        verify: async (members) => ({
          verdicts: new Map(members.map((m) => [m.id, true])),
          summary: 'A collapsed stretch of road is endangering two-wheelers.',
        }),
      })
    );
    const merged = signals.find((s) => s.volume > 1);
    expect(merged?.summary).toBe('A collapsed stretch of road is endangering two-wheelers.');
    expect(merged?.verificationEngine).toBe('gemini');
  });

  it('verifies a group once, not once to split and again to summarise', async () => {
    let calls = 0;
    await buildDemandSignals(
      complaints,
      stubAi({
        verify: async (members) => {
          calls++;
          return { verdicts: new Map(members.map((m) => [m.id, true])), summary: 's' };
        },
      })
    );
    // Two multi-member groups confirmed on the first round and no second round
    // needed, so exactly two calls. Summarising by re-verifying would be four.
    expect(calls).toBe(2);
  });

  it('still produces signals with no Gemini key configured', async () => {
    // No embedding call means no vectors, which must degrade to singletons
    // rather than an exception or an empty response.
    const { signals, stats } = await buildDemandSignals(complaints, stubAi({ embed: async () => null }));
    expect(signals).toHaveLength(complaints.length);
    expect(stats.embeddingEngine).toBe('unavailable');
    expect(stats.verificationEngine).toBe('unavailable');
    expect(signals.every((s) => s.summary.length > 0)).toBe(true);
  });

  it('honours a configured similarity threshold', async () => {
    // Own corpus with hand-picked vectors, because the shared fixture's stub
    // hands out identical vectors and identical vectors merge at any cutoff.
    // cos(c1,c2) = 0.999 and cos(c1,c3) = 0.98.
    const spread = [
      makeComplaint({ id: 't1', embedding: [1, 0], embeddingModel: 'stub-embedding' }),
      makeComplaint({ id: 't2', embedding: [0.999, 0.0447], embeddingModel: 'stub-embedding' }),
      makeComplaint({ id: 't3', embedding: [0.98, 0.199], embeddingModel: 'stub-embedding' }),
    ];
    const ai = stubAi({ embed: async () => null });

    const loose = await buildDemandSignals(spread, ai, { similarityThreshold: 0.75 });
    const strict = await buildDemandSignals(spread, ai, { similarityThreshold: 0.995 });

    expect(loose.signals).toHaveLength(1);
    expect(loose.signals[0].volume).toBe(3);
    expect(strict.signals.length).toBeGreaterThan(loose.signals.length);
    expect(strict.stats.similarityThreshold).toBe(0.995);
  });

  it('returns the same clusters for the same corpus on a rerun', async () => {
    const first = await buildDemandSignals(complaints, stubAi());
    const second = await buildDemandSignals([...complaints].reverse(), stubAi());
    expect(second.signals).toEqual(first.signals);
  });

  it('buckets before it embeds, so no comparison ever crosses a bucket', async () => {
    // Stage order is a hard requirement, not a preference. This is only
    // observable through the counts: if embedding ran before bucketing, the
    // singleton complaints would be embedded and billed even though nothing can
    // ever merge them.
    const split = [
      makeComplaint({ id: 'a1', issueType: 'pothole', locationDistrict: 'Visakhapatnam', locationWard: 'W1' }),
      makeComplaint({ id: 'a2', issueType: 'pothole', locationDistrict: 'Visakhapatnam', locationWard: 'W1' }),
      // Same ward, different issue type: a separate bucket, and a singleton.
      makeComplaint({ id: 'b1', issueType: 'open_manhole', locationDistrict: 'Visakhapatnam', locationWard: 'W1' }),
      // Different ward, same issue type: also a separate bucket under 'ward'.
      makeComplaint({ id: 'c1', issueType: 'pothole', locationDistrict: 'Visakhapatnam', locationWard: 'W2' }),
    ];
    let embedded: string[] = [];
    const ai = stubAi({
      embed: async (texts) => {
        embedded.push(...texts);
        return { model: 'stub-embedding', dimensions: 2, vectors: texts.map(() => SAME) };
      },
    });

    const { stats } = await buildDemandSignals(split, ai, { bucketGranularity: 'ward' });
    expect(stats.bucketCount).toBe(3);
    // Only a1 and a2 share a bucket, so only they are worth a vector.
    expect(stats.embeddedCount).toBe(2);
    expect(embedded).toHaveLength(2);
  });

  it('re-embeds complaints stranded on another model when a new one arrives', async () => {
    // Vectors outlive the process that produced them and the model is
    // discovered per process, so a corpus can end up holding two embedding
    // spaces. Stage 3 will not compare across them, so the strays would be
    // frozen out of every merge forever unless they are re-embedded.
    //
    // A new complaint is what triggers it: the run has to make an embedding
    // call to learn which model is working now, and that is the moment the
    // rest of the corpus can be brought onto it.
    const mixed = [
      makeComplaint({ id: 'm1', embedding: [1, 0], embeddingModel: 'old-model' }),
      makeComplaint({ id: 'm2', embedding: [0.999, 0.04], embeddingModel: 'old-model' }),
      makeComplaint({ id: 'm3', embedding: [0.98, 0.2], embeddingModel: 'old-model' }),
      makeComplaint({ id: 'm4' }),
    ];
    const saved: { id: string; model: string }[] = [];
    const ai = stubAi({
      embed: async (texts) => ({
        model: 'new-model',
        dimensions: 2,
        vectors: texts.map(() => SAME),
      }),
    });

    const { stats } = await buildDemandSignals(mixed, ai, {
      saveEmbedding: async (id, _vector, model) => {
        saved.push({ id, model });
      },
    });

    expect(stats.reembeddedCount).toBe(3);
    expect(saved.filter((s) => s.id === 'm4').map((s) => s.model)).toEqual(['new-model']);
    expect(stats.embeddingModel).toBe('new-model');
    // Every complaint now sits in one space, so stage 3 can compare them all.
    expect(stats.mergedClusterCount).toBe(1);
  });

  it('leaves a fully-stored single-model corpus completely alone', async () => {
    const consistent = [
      makeComplaint({ id: 'k1', embedding: [1, 0], embeddingModel: 'only-model' }),
      makeComplaint({ id: 'k2', embedding: [0.999, 0.04], embeddingModel: 'only-model' }),
    ];
    let calls = 0;
    const ai = stubAi({
      embed: async (texts) => {
        calls++;
        return { model: 'only-model', dimensions: 2, vectors: texts.map(() => SAME) };
      },
    });

    const { stats } = await buildDemandSignals(consistent, ai);
    expect(calls).toBe(0);
    expect(stats.reembeddedCount).toBe(0);
    expect(stats.reusedEmbeddingCount).toBe(2);
  });
});

describe('pickLead', () => {
  it('picks the most urgent complaint', () => {
    const members = [
      makeComplaint({ id: 'x', urgencyScore: 1 }),
      makeComplaint({ id: 'y', urgencyScore: 5 }),
      makeComplaint({ id: 'z', urgencyScore: 3 }),
    ];
    expect(pickLead(members)?.id).toBe('y');
  });

  it('breaks an urgency tie on id, not on array order', () => {
    const members = [
      makeComplaint({ id: 'later', urgencyScore: 3 }),
      makeComplaint({ id: 'earlier', urgencyScore: 3 }),
    ];
    expect(pickLead(members)?.id).toBe('earlier');
    expect(pickLead([...members].reverse())?.id).toBe('earlier');
  });
});

describe('toDemandSignalJson', () => {
  const signal = toDemandSignal(
    [
      makeComplaint({ id: 'c1' }),
      makeComplaint({ id: 'c2', originalLanguage: 'Tamil', urgencyScore: 5 }),
    ],
    'A summary.',
    0.75,
    'gemini',
    1
  );

  it('emits the published snake_case field names', () => {
    const json = toDemandSignalJson(signal);
    expect(Object.keys(json).sort()).toEqual(
      [
        'avg_urgency',
        'cluster_id',
        'complaint_ids',
        'data_fusion_source',
        'data_unavailable',
        'existing_infrastructure_gap',
        'issue_type',
        'languages_represented',
        'location',
        'location_district',
        'location_state',
        'location_ward',
        'population_affected',
        'priority_breakdown',
        'priority_explanation',
        'priority_score',
        'similarity_threshold',
        'summary',
        'verification_engine',
        'volume',
      ].sort()
    );
    expect(json.cluster_id).toBe('DS-0001');
    expect(json.complaint_ids).toEqual(['c1', 'c2']);
    expect(json.avg_urgency).toBe(4);
    expect(json.languages_represented).toEqual(['Tamil', 'Telugu']);
  });

  it('never emits camelCase keys', () => {
    const serialised = JSON.stringify(toDemandSignalJson(signal));
    for (const key of [
      'clusterId',
      'memberComplaintIds',
      'avgUrgency',
      'languagesRepresented',
      'populationAffected',
      'priorityScore',
      'priorityExplanation',
      'priorityBreakdown',
      'dataUnavailable',
    ]) {
      expect(serialised).not.toContain(key);
    }
  });

  it('omits absent optional fields rather than nulling them', () => {
    const bare = toDemandSignal(
      [makeComplaint({ id: 'c1', locationState: undefined, locationDistrict: undefined, locationWard: undefined })],
      'A summary.',
      0.75,
      'heuristic',
      1
    );
    const json = toDemandSignalJson(bare);
    expect('location_state' in json).toBe(false);
    expect('location_ward' in json).toBe(false);
    expect(json.location).toBeDefined();
  });

  it('always serialises the fusion fields, null when not fused', () => {
    const json = toDemandSignalJson(signal);
    expect(json.population_affected).toBeNull();
    expect(json.existing_infrastructure_gap).toBeNull();
    expect(json.data_fusion_source).toBeNull();
  });

  it('serialises scored signals with snake_case priority fields', () => {
    // The describe-level `signal` has no district reference data, so scoring it
    // alone is exactly the "data unavailable" path: volume + urgency only.
    const scored = scoreDemandSignals([signal])[0];
    const json = toDemandSignalJson(scored);
    expect(json.priority_score).toBe(0.896);
    expect(json.priority_explanation).toMatch(/only reporting volume and urgency/);
    expect(json.data_unavailable).toBe(true);
    expect(json.priority_breakdown).not.toBeNull();
    expect(json.priority_breakdown?.weights).toMatchObject({
      volume: 0.583,
      avg_urgency: 0.417,
      infrastructure_gap: 0,
      population_affected: 0,
    });
    expect(json.priority_breakdown?.normalized_avg_urgency).toBe(0.75);
  });
});
