import { describe, it, expect, vi } from 'vitest';
import type { Complaint, DemandSignal, Issue } from '@/lib/types';

/**
 * Public read endpoints for the demand-signal pipeline: the ranked list, the
 * per-cluster drill-down (including the individual complaints that fed into
 * it), and the map-shaped projection. They are citizens-facing (no session is
 * consulted) but serve only aggregations of citizen reports, never citizen
 * identity, which is the trade-off that makes a public read safe. The scoring
 * and serialisation logic is shared with the admin endpoints, so what is
 * asserted here is the public contract and the drill-down/map resolution.
 */

const h = vi.hoisted(() => ({
  store: {
    getIssues: vi.fn(),
    listComplaints: vi.fn(),
    listDemandSignals: vi.fn(),
  },
}));

const store = h.store;

vi.mock('@/lib/store', () => ({ civicStore: h.store }));

import { GET as listGet } from './route';
import { GET as detailGet } from './[signalId]/route';
import { GET as mapGet } from './map/route';

function makeIssue(id: string, latitude: number, longitude: number): Issue {
  return { id, latitude, longitude } as Issue;
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
    urgencyReason: 'Dangerous to two-wheelers',
    originalLanguage: 'Telugu',
    originalText: 'రోడ్డు పూడు ఉంది',
    translatedText: 'There is a pothole on the road.',
    extractionEngine: 'heuristic',
    ...overrides,
  };
}

// One unfused cluster. Scored over a set of one, min-max collapses to 1 and the
// missing reference terms are dropped with the remaining weights renormalised:
// 0.5833 * 1 + 0.4167 * ((3 - 1) / 4) = 0.792. Shared by the list and the
// drill-down so the two can never disagree on the same row.
function makeSignal(overrides: Partial<DemandSignal> = {}): DemandSignal {
  return {
    clusterId: 'DS-0001',
    issueType: 'pothole',
    location: 'Visakhapatnam, Andhra Pradesh',
    locationState: 'Andhra Pradesh',
    locationDistrict: 'Visakhapatnam',
    memberComplaintIds: ['c1', 'c2'],
    volume: 2,
    avgUrgency: 3,
    summary: 'Deep pothole on the road.',
    languagesRepresented: ['Telugu'],
    similarityThreshold: 0.75,
    verificationEngine: 'gemini',
    ...overrides,
  };
}

describe('GET /api/demand-signals — public ranked list', () => {
  it('serves the ranked list without a session', async () => {
    store.listDemandSignals.mockResolvedValue([makeSignal()]);

    const res = await listGet(new Request('http://localhost/api/demand-signals') as never);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.complaints).toBe(2);
    expect(body.clusters).toHaveLength(1);
    expect(body.clusters[0]).toMatchObject({
      cluster_id: 'DS-0001',
      complaint_ids: ['c1', 'c2'],
      volume: 2,
      avg_urgency: 3,
      priority_score: 0.792,
      data_unavailable: true,
    });
    expect(typeof body.clusters[0].priority_explanation).toBe('string');
    expect(body.clusters[0].priority_explanation).toMatch(/only reporting volume and urgency/);
  });

  it('reports an empty set instead of erroring', async () => {
    store.listDemandSignals.mockResolvedValue([]);
    const res = await listGet(new Request('http://localhost/api/demand-signals') as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
    expect(body.clusters).toEqual([]);
  });

  it('serialises every cluster with its intent, defaulting to complaint', async () => {
    store.listDemandSignals.mockResolvedValue([
      makeSignal(),
      makeSignal({ clusterId: 'DS-0002', intent: 'development_request' }),
    ]);
    const body = await (await listGet(new Request('http://localhost/api/demand-signals') as never)).json();
    expect(body.clusters.map((c: { intent: string }) => c.intent)).toEqual([
      'complaint',
      'development_request',
    ]);
  });

  it('filters clusters by ?intent= and falls back to all on an unknown value', async () => {
    const mixed = [
      makeSignal({ clusterId: 'DS-0001', intent: 'complaint' }),
      makeSignal({ clusterId: 'DS-0002', intent: 'development_request' }),
    ];
    store.listDemandSignals.mockResolvedValue(mixed);

    const requests = await (
      await listGet(new Request('http://localhost/api/demand-signals?intent=development_request') as never)
    ).json();
    expect(requests.count).toBe(1);
    expect(requests.clusters[0].cluster_id).toBe('DS-0002');

    const complaints = await (
      await listGet(new Request('http://localhost/api/demand-signals?intent=complaint') as never)
    ).json();
    expect(complaints.count).toBe(1);
    expect(complaints.clusters[0].cluster_id).toBe('DS-0001');

    const everything = await (
      await listGet(new Request('http://localhost/api/demand-signals?intent=nonsense') as never)
    ).json();
    expect(everything.count).toBe(2);
  });

  it('scores each intent against its own peers so a request never pins to zero', async () => {
    store.listDemandSignals.mockResolvedValue([
      makeSignal({ clusterId: 'DS-01', volume: 10, avgUrgency: 3, intent: 'complaint' }),
      makeSignal({ clusterId: 'DS-02', volume: 30, avgUrgency: 3, intent: 'complaint' }),
      makeSignal({ clusterId: 'DS-REQ', volume: 1, avgUrgency: 3, intent: 'development_request' }),
    ]);
    const body = await (await listGet(new Request('http://localhost/api/demand-signals') as never)).json();
    const byId = Object.fromEntries(body.clusters.map((c: { cluster_id: string }) => [c.cluster_id, c]));
    // The request is alone in its peer group → full range, even though its
    // volume of 1 sits far below every complaint. Under a shared min-max it
    // would have normalised to 0 and been stuck at the bottom of the ranking.
    expect(byId['DS-REQ'].priority_breakdown.normalized_volume).toBe(1);
    // The complaint pair still scales against each other, unaffected.
    expect(byId['DS-01'].priority_breakdown.normalized_volume).toBe(0);
    expect(byId['DS-02'].priority_breakdown.normalized_volume).toBe(1);
  });
});

describe('GET /api/demand-signals/{signalId} — drill-down', () => {
  it('returns 404 for a signal that does not exist', async () => {
    store.listDemandSignals.mockResolvedValue([makeSignal()]);
    const res = await detailGet(new Request('http://localhost/api/demand-signals/DS-0999') as never, {
      params: { signalId: 'DS-0999' },
    });
    expect(res.status).toBe(404);
  });

  it('returns the signal scored identically to the list, with complaints resolved', async () => {
    store.listDemandSignals.mockResolvedValue([makeSignal()]);
    store.listComplaints.mockResolvedValue([
      makeComplaint('c1', 'i1', { urgencyScore: 2 }),
      makeComplaint('c2', 'i2', { urgencyScore: 4 }),
    ]);

    const res = await detailGet(new Request('http://localhost/api/demand-signals/DS-0001') as never, {
      params: { signalId: 'DS-0001' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Same score, explanation and breakdown the list shows for this row.
    expect(body.priority_score).toBe(0.792);
    expect(body.priority_breakdown).not.toBeNull();
    expect(body.priority_breakdown.weights.volume).toBe(0.583);
    expect(body.data_unavailable).toBe(true);

    // Member complaints carry their own urgency and both renderings of the text.
    expect(body.member_complaints).toHaveLength(2);
    expect(body.member_complaints[0]).toMatchObject({
      complaint_id: 'c1',
      source_issue_id: 'i1',
      urgency_score: 2,
      urgency_reason: 'Dangerous to two-wheelers',
      original_language: 'Telugu',
      original_text: 'రోడ్డు పూడు ఉంది',
      translated_text: 'There is a pothole on the road.',
    });
    expect(body.member_complaints[1].urgency_score).toBe(4);
  });

  it('keeps the member complaint list stable when a complaint is missing from the corpus', async () => {
    store.listDemandSignals.mockResolvedValue([makeSignal()]);
    store.listComplaints.mockResolvedValue([makeComplaint('c1', 'i1')]);

    const res = await detailGet(new Request('http://localhost/api/demand-signals/DS-0001') as never, {
      params: { signalId: 'DS-0001' },
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.member_complaints).toHaveLength(1);
    expect(body.member_complaints[0].complaint_id).toBe('c1');
  });
});

describe('GET /api/demand-signals/map — plot projection', () => {
  it('centroids each cluster at the mean of its members\u2019 source report coordinates', async () => {
    store.listDemandSignals.mockResolvedValue([makeSignal()]);
    store.listComplaints.mockResolvedValue([makeComplaint('c1', 'i1'), makeComplaint('c2', 'i2')]);
    store.getIssues.mockResolvedValue([
      makeIssue('i1', 17.7, 83.3),
      makeIssue('i2', 17.8, 83.2),
    ]);

    const res = await mapGet(new Request('http://localhost/api/demand-signals/map') as never);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.count).toBe(1);
    expect(body.plotted).toBe(1);
    expect(body.markers[0]).toMatchObject({
      cluster_id: 'DS-0001',
      issue_type: 'pothole',
      intent: 'complaint',
      location: 'Visakhapatnam, Andhra Pradesh',
      volume: 2,
      priority_score: 0.792,
    });
    expect(body.markers[0].latitude).toBeCloseTo(17.75, 5);
    expect(body.markers[0].longitude).toBeCloseTo(83.25, 5);
  });

  it('flags unplaceable clusters with null coordinates rather than snapping a pin', async () => {
    store.listDemandSignals.mockResolvedValue([makeSignal()]);
    store.listComplaints.mockResolvedValue([
      makeComplaint('c1', 'i1'),
      makeComplaint('c2', 'i9'), // source issue does not exist
    ]);
    store.getIssues.mockResolvedValue([makeIssue('i1', 17.7, 83.3)]);

    const body = await (await mapGet(new Request('http://localhost/api/demand-signals/map') as never)).json();
    // c2 has no coordinates, so the centroid falls back to c1 alone.
    expect(body.plotted).toBe(1);
    expect(body.markers[0].latitude).toBeCloseTo(17.7, 5);
    expect(body.markers[0].longitude).toBeCloseTo(83.3, 5);

    store.listComplaints.mockResolvedValue([makeComplaint('c2', 'i9')]);
    const none = await (await mapGet(new Request('http://localhost/api/demand-signals/map') as never)).json();
    expect(none.plotted).toBe(0);
    expect(none.markers[0].latitude).toBeNull();
    expect(none.markers[0].longitude).toBeNull();
  });
});