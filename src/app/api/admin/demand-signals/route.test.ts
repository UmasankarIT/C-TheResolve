import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Complaint, DemandSignal, Issue } from '@/lib/types';

/** The snake_case shape the API returns. */
type DemandSignalJson = { complaint_ids: string[]; cluster_id: string };

// Route handlers for the demand-signal endpoints. The pipeline itself is
// covered in demandSignals.test.ts; what matters here is the wiring the routes
// own: who may trigger a build, what reaches the store, and the scoping of the
// complaint corpus.

// vi.mock factories are hoisted above every other statement, so the fakes they
// close over have to be hoisted with them.
const h = vi.hoisted(() => ({
  store: {
    getIssues: vi.fn(),
    upsertComplaints: vi.fn(),
    listComplaints: vi.fn(),
    setComplaintEmbedding: vi.fn(),
    replaceDemandSignals: vi.fn(),
    listDemandSignals: vi.fn(),
  },
  logAction: vi.fn(),
  session: { current: null as null | { userId: string; role: string } },
}));

const store = h.store;
const logAction = h.logAction;
const session = h.session;

vi.mock('@/lib/store', () => ({ civicStore: h.store }));
vi.mock('@/lib/events', () => ({ logAction: h.logAction }));
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getSession: async () => h.session.current,
  };
});
// The build route reaches Gemini through the orchestrator. Stubbed so these
// tests never make a network call or depend on an API key.
vi.mock('@/lib/demandSignals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/demandSignals')>();
  return {
    ...actual,
    geminiPipelineAi: { embed: async () => null, verify: async () => null },
  };
});

// vi.mock calls are hoisted above these imports by vitest, so the routes see
// the mocked store and auth.
import { POST } from './build/route';
import { GET } from './route';

const ADMIN = { userId: 'admin-1', role: 'city_admin' };
const CITIZEN = { userId: 'cit-1', role: 'citizen' };

function makeIssue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    title: `Issue ${id}`,
    description: `Description for ${id}`,
    status: 'reported',
    category: { id: 'cat-1', code: 'pot_hole', name: 'Pothole' },
    locationDetails: { district: 'Visakhapatnam' },
    state: 'Andhra Pradesh',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Issue;
}

function makeComplaint(id: string, sourceIssueId: string, overrides: Partial<Complaint> = {}): Complaint {
  return {
    id,
    sourceIssueId,
    issueType: 'pothole',
    location: 'Visakhapatnam, Andhra Pradesh',
    locationGranularity: 'district',
    locationState: 'Andhra Pradesh',
    locationDistrict: 'Visakhapatnam',
    urgencyScore: 3,
    originalLanguage: 'Telugu',
    originalText: 'రోడ్డు పూడు ఉంది',
    translatedText: 'There is a pothole on the road.',
    extractionEngine: 'heuristic',
    ...overrides,
  };
}

function post(body: unknown = {}) {
  return POST(
    new Request('http://localhost/api/admin/demand-signals/build', {
      method: 'POST',
      body: JSON.stringify(body),
    }) as never
  );
}

function get() {
  return GET(new Request('http://localhost/api/admin/demand-signals') as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  session.current = { ...ADMIN };
  store.getIssues.mockResolvedValue([makeIssue('i1'), makeIssue('i2')]);
  store.upsertComplaints.mockResolvedValue(0);
  store.listComplaints.mockResolvedValue([makeComplaint('c1', 'i1'), makeComplaint('c2', 'i2')]);
  store.replaceDemandSignals.mockResolvedValue(undefined);
  store.listDemandSignals.mockResolvedValue([]);
});

describe('POST /api/admin/demand-signals/build — access control', () => {
  it('refuses an unauthenticated caller', async () => {
    session.current = null;
    const res = await post();
    expect(res.status).toBe(401);
    expect(store.getIssues).not.toHaveBeenCalled();
  });

  it('refuses a signed-in citizen', async () => {
    session.current = { ...CITIZEN };
    const res = await post();
    expect(res.status).toBe(403);
    expect(store.getIssues).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/demand-signals/build — corpus scoping', () => {
  it('excludes complaints whose issue is no longer open', async () => {
    // A complaint derived from a since-resolved issue used to be carried into
    // the build, so a solved problem kept producing a demand signal.
    store.listComplaints.mockResolvedValue([
      makeComplaint('c1', 'i1'),
      makeComplaint('c2', 'i2'),
      makeComplaint('stale', 'resolved-1'),
    ]);

    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();

    // The complaint from the resolved issue is gone from the build, and the
    // route says so rather than dropping it silently.
    expect(body.stats.complaintCount).toBe(2);
    expect(body.clusters.every((c: DemandSignalJson) => !c.complaint_ids.includes('stale'))).toBe(true);
    expect(body.progress.join(' ')).toMatch(/no longer open/);
  });

  it('builds only from open issues', async () => {
    store.getIssues.mockResolvedValue([
      makeIssue('i1'),
      makeIssue('i2', { status: 'resolved' }),
      makeIssue('i3', { status: 'merged' }),
    ]);
    store.listComplaints.mockResolvedValue([makeComplaint('c1', 'i1')]);

    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stats.complaintCount).toBe(1);
  });

  it('refuses to build when nothing is open', async () => {
    store.getIssues.mockResolvedValue([makeIssue('i1', { status: 'resolved' })]);
    const res = await post();
    expect(res.status).toBe(400);
    expect(store.replaceDemandSignals).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/demand-signals/build — options', () => {
  it('does not persist signals or log an action on a dry run', async () => {
    const res = await post({ dryRun: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dry_run).toBe(true);
    expect(store.replaceDemandSignals).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it('persists and logs a real build', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(store.replaceDemandSignals).toHaveBeenCalledTimes(1);
    expect(logAction).toHaveBeenCalledTimes(1);
  });

  it('clamps an out-of-range threshold instead of trusting it', async () => {
    const high = await (await post({ similarityThreshold: 5 })).json();
    expect(high.stats.similarityThreshold).toBe(1);

    const low = await (await post({ similarityThreshold: -3 })).json();
    expect(low.stats.similarityThreshold).toBe(0);
  });

  it('falls back to the default when the threshold is not a number', async () => {
    // NaN would make every pair maximally distant and silently collapse the
    // corpus into one cluster per complaint.
    const body = await (await post({ similarityThreshold: 'abc' })).json();
    expect(body.stats.similarityThreshold).toBeGreaterThan(0);
    expect(Number.isNaN(body.stats.similarityThreshold)).toBe(false);
  });

  it('rejects an unknown bucket granularity rather than trusting it', async () => {
    const body = await (await post({ bucketGranularity: 'galaxy' })).json();
    expect(body.stats.bucketGranularity).toBe('district');
  });

  it('accepts a valid bucket granularity', async () => {
    const body = await (await post({ bucketGranularity: 'ward' })).json();
    expect(body.stats.bucketGranularity).toBe('ward');
  });

  it('skips the extraction pass when asked', async () => {
    const res = await post({ skipExtraction: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.progress.join(' ')).not.toMatch(/extracting structured fields/);
  });
});

describe('POST /api/admin/demand-signals/build — Step 4 data fusion', () => {
  it('joins real district population and infrastructure gap onto every cluster', async () => {
    // The mocked corpus files under Visakhapatnam, which has a Census 2011
    // reference row (4,290,589 people; 48.7% of households without a latrine
    // within premises). The reference file is read for real, so a value on
    // screen can be traced back to the open data.
    const res = await post({ dryRun: true, skipExtraction: true });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.clusters.length).toBeGreaterThan(0);
    for (const cluster of body.clusters) {
      expect(cluster.population_affected).toBe(4290589);
      expect(cluster.existing_infrastructure_gap).toBe(48.7);
      expect(typeof cluster.data_fusion_source).toBe('string');
      expect(cluster.data_fusion_source.length).toBeGreaterThan(0);
      // Every cluster is scored and explained with its own numbers.
      expect(typeof cluster.priority_score).toBe('number');
      expect(cluster.priority_score).toBeGreaterThanOrEqual(0);
      expect(cluster.priority_score).toBeLessThanOrEqual(1);
      expect(typeof cluster.priority_explanation).toBe('string');
      expect(cluster.priority_explanation.length).toBeGreaterThan(0);
      expect(cluster.priority_explanation).toMatch(/4\.29 million residents/);
      expect(cluster.priority_explanation).toMatch(/48\.7% of households/);
      expect(cluster.priority_breakdown).not.toBeNull();
    }
    expect(body.progress.join(' ')).toMatch(/reference data/);
    expect(body.progress.join(' ')).toMatch(/priority score/);
  });

  it('reports a clearly-flagged null for a district with no reference row', async () => {
    store.listComplaints.mockResolvedValue([
      makeComplaint('off-map', 'i1', { locationDistrict: 'Nowhere', locationState: 'Nowhere State' }),
    ]);

    const res = await post({ dryRun: true, skipExtraction: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clusters[0].population_affected).toBeNull();
    expect(body.clusters[0].existing_infrastructure_gap).toBeNull();
    expect(body.clusters[0].data_fusion_source).toBeNull();
    // No reference row ⇒ scored on volume and urgency alone, and the
    // explanation says so instead of pretending the terms were zero.
    expect(body.clusters[0].data_unavailable).toBe(true);
    expect(body.clusters[0].priority_breakdown.weights).toMatchObject({
      volume: 0.583,
      avg_urgency: 0.417,
      infrastructure_gap: 0,
      population_affected: 0,
    });
    expect(body.clusters[0].priority_explanation).toMatch(/only reporting volume and urgency/);
  });
});

describe('POST /api/admin/demand-signals/build — Step 5 priority scoring', () => {
  it('ranks clusters by priority score, highest first, ranked by real numbers', async () => {
    // Three singleton clusters, one per district, so urgency, gap and population
    // vary and the ranking is decided by those terms across the cluster set.
    store.getIssues.mockResolvedValue([makeIssue('i1'), makeIssue('i2'), makeIssue('i3')]);
    store.listComplaints.mockResolvedValue([
      makeComplaint('vizag', 'i1', { locationDistrict: 'Visakhapatnam', urgencyScore: 5 }),
      makeComplaint('blr', 'i2', { locationDistrict: 'Bengaluru Urban', locationState: 'Karnataka', urgencyScore: 1 }),
      makeComplaint('tir', 'i3', { locationDistrict: 'Tirupati', urgencyScore: 3 }),
    ]);

    const res = await post({ dryRun: true, skipExtraction: true });
    expect(res.status).toBe(200);
    const body = await res.json();

    const scores = body.clusters.map((c: { priority_score: number }) => c.priority_score);
    expect(scores).toEqual([0.763, 0.633, 0.513]);
    expect([...scores].sort((a: number, b: number) => b - a)).toEqual(scores);

    const byDistrict = Object.fromEntries(
      body.clusters.map((c: { location_district: string }) => [
        c.location_district,
        c,
      ])
    );
    expect(byDistrict['Visakhapatnam'].priority_explanation).toMatch(/average urgency 5\.0\/5/);
    expect(byDistrict['Visakhapatnam'].priority_explanation).toMatch(/~4\.29 million residents/);
    expect(byDistrict['Bengaluru Urban'].priority_explanation).toMatch(/average urgency 1\.0\/5/);
  });

  it('scores a district that has population but no gap data without that term', async () => {
    store.listComplaints.mockResolvedValue([
      makeComplaint('tir', 'i1', { locationDistrict: 'Tirupati', urgencyScore: 3 }),
    ]);

    const body = await (await post({ dryRun: true, skipExtraction: true })).json();
    const cluster = body.clusters[0];
    expect(cluster.population_affected).toBe(2240000);
    expect(cluster.existing_infrastructure_gap).toBeNull();
    expect(cluster.data_unavailable).toBe(false);
    expect(cluster.priority_breakdown.weights.infrastructure_gap).toBe(0);
    expect(cluster.priority_breakdown.weights.population_affected).toBe(0.2);
    expect(cluster.priority_explanation).toMatch(/reweighted/);
  });
});

describe('GET /api/admin/demand-signals', () => {
  it('refuses an unauthenticated caller', async () => {
    session.current = null;
    expect((await get()).status).toBe(401);
    expect(store.listDemandSignals).not.toHaveBeenCalled();
  });

  it('refuses a signed-in citizen', async () => {
    session.current = { ...CITIZEN };
    expect((await get()).status).toBe(403);
  });

  it('emits clusters in snake_case with aggregate totals', async () => {
    store.listDemandSignals.mockResolvedValue([
      {
        clusterId: 'DS-0001',
        issueType: 'pothole',
        location: 'Visakhapatnam, Andhra Pradesh',
        locationState: 'Andhra Pradesh',
        locationDistrict: 'Visakhapatnam',
        memberComplaintIds: ['c1', 'c2'],
        volume: 2,
        avgUrgency: 3,
        summary: 'Deep pothole.',
        languagesRepresented: ['Telugu'],
        similarityThreshold: 0.75,
        verificationEngine: 'gemini',
      },
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.generated_at).toBeTypeOf('string');
    expect(body.count).toBe(1);
    expect(body.complaints).toBe(2);
    expect(body.clusters[0]).toMatchObject({
      cluster_id: 'DS-0001',
      issue_type: 'pothole',
      complaint_ids: ['c1', 'c2'],
      avg_urgency: 3,
      languages_represented: ['Telugu'],
      // Fusion fields are part of the fixed contract: present even when the
      // store returned a signal that was never fused (a mocked/unfused signal
      // here, an unknown district in production), so a consumer can tell "no
      // data" apart from a missing field.
      population_affected: null,
      existing_infrastructure_gap: null,
      data_fusion_source: null,
    });
    // The read path scores what it returns, so a mocked unfused signal comes
    // out scored on volume and urgency only and flagged as data-unavailable.
    expect(body.clusters[0].priority_score).toBe(0.792);
    expect(body.clusters[0].data_unavailable).toBe(true);
    expect(body.clusters[0].priority_explanation).toMatch(/only reporting volume and urgency/);
    expect(body.clusters[0].priority_breakdown.weights).toMatchObject({
      volume: 0.583,
      avg_urgency: 0.417,
    });
    // The in-memory shape must not leak through the API.
    expect(body.clusters[0].clusterId).toBeUndefined();
    expect(body.clusters[0].memberComplaintIds).toBeUndefined();
    expect(JSON.stringify(body.clusters[0])).not.toContain('priorityBreakdown');
  });
});
