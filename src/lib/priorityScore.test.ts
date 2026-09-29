import { describe, it, expect } from 'vitest';
import { DemandSignal } from './types';
import {
  scoreDemandSignals,
  combinePriorityComponents,
  normalizeAvgUrgency,
  infrastructureGapScore,
  minMax,
  minMaxNormalize,
  formatAffected,
  buildPriorityExplanation,
  priorityBand,
  componentBand,
} from './priorityScore';

function makeSignal(overrides: Partial<DemandSignal> = {}): DemandSignal {
  return {
    clusterId: 'DS-0001',
    issueType: 'pothole',
    location: 'Visakhapatnam, Andhra Pradesh',
    locationState: 'Andhra Pradesh',
    locationDistrict: 'Visakhapatnam',
    memberComplaintIds: ['c1'],
    volume: 1,
    avgUrgency: 3,
    summary: 'A pothole.',
    languagesRepresented: ['Telugu'],
    similarityThreshold: 0.75,
    verificationEngine: 'gemini',
    populationAffected: null,
    existingInfrastructureGap: null,
    dataFusionSource: null,
    ...overrides,
  };
}

describe('normalizeAvgUrgency', () => {
  it('maps the 1-5 urgency scale onto 0-1', () => {
    expect(normalizeAvgUrgency(1)).toBe(0);
    expect(normalizeAvgUrgency(3)).toBe(0.5);
    expect(normalizeAvgUrgency(5)).toBe(1);
  });

  it('clamps out-of-scale values and treats NaN as the floor', () => {
    expect(normalizeAvgUrgency(0)).toBe(0);
    expect(normalizeAvgUrgency(9)).toBe(1);
    expect(normalizeAvgUrgency(Number.NaN)).toBe(0);
  });
});

describe('infrastructureGapScore', () => {
  it('maps a 0-100 percentage onto 0-1 and keeps null as missing', () => {
    expect(infrastructureGapScore(null)).toBeNull();
    expect(infrastructureGapScore(0)).toBe(0);
    expect(infrastructureGapScore(48.7)).toBeCloseTo(0.487);
    expect(infrastructureGapScore(100)).toBe(1);
  });

  it('clamps out-of-range percentages', () => {
    expect(infrastructureGapScore(-10)).toBe(0);
    expect(infrastructureGapScore(250)).toBe(1);
  });
});

describe('minMax / minMaxNormalize', () => {
  it('reports no range when there is nothing to scale', () => {
    expect(minMax([])).toBeNull();
    expect(minMax([Number.NaN])).toBeNull();
  });

  it('scans the whole set for the observed min and max', () => {
    expect(minMax([3, 1, 2])).toEqual({ min: 1, max: 3 });
    expect(minMaxNormalize(5, { min: 2, max: 10 })).toBeCloseTo(0.375);
  });

  it('treats a collapsed range as fully normalised rather than all-zero', () => {
    expect(minMaxNormalize(5, { min: 5, max: 5 })).toBe(1);
  });

  it('turns a non-finite value into 0 rather than NaN escaping', () => {
    expect(minMaxNormalize(Number.NaN, { min: 0, max: 10 })).toBe(0);
  });
});

describe('combinePriorityComponents', () => {
  it('combines the four terms with the published weights', () => {
    const result = combinePriorityComponents({
      normalizedVolume: 1,
      normalizedAvgUrgency: 0.5,
      infrastructureGapScore: 0.487,
      normalizedPopulationAffected: 0.5,
    });
    expect(result.weights).toEqual({
      volume: 0.35,
      avgUrgency: 0.25,
      infrastructureGap: 0.25,
      populationAffected: 0.15,
    });
    // 0.35*1 + 0.25*0.5 + 0.25*0.487 + 0.15*0.5 = 0.67175
    expect(result.score).toBe(0.672);
  });

  it('renormalises the remaining weights when the gap term is missing', () => {
    const result = combinePriorityComponents({
      normalizedVolume: 1,
      normalizedAvgUrgency: 0.5,
      infrastructureGapScore: null,
      normalizedPopulationAffected: 0.5,
    });
    expect(result.weights).toEqual({
      volume: 0.467,
      avgUrgency: 0.333,
      infrastructureGap: 0,
      populationAffected: 0.2,
    });
    // (0.35/0.75)*1 + (0.25/0.75)*0.5 + (0.15/0.75)*0.5 = 0.7333…
    expect(result.score).toBe(0.733);
  });

  it('scores on volume and urgency alone when no district data exists', () => {
    const result = combinePriorityComponents({
      normalizedVolume: 1,
      normalizedAvgUrgency: 0.5,
      infrastructureGapScore: null,
      normalizedPopulationAffected: null,
    });
    expect(result.weights).toEqual({
      volume: 0.583,
      avgUrgency: 0.417,
      infrastructureGap: 0,
      populationAffected: 0,
    });
    // (0.35/0.6)*1 + (0.25/0.6)*0.5 = 0.7916…
    expect(result.score).toBe(0.792);
  });

  it('never lets a missing term silently become a zero-weight term', () => {
    const result = combinePriorityComponents({
      normalizedVolume: 1,
      normalizedAvgUrgency: 0.5,
      infrastructureGapScore: null,
      normalizedPopulationAffected: 0.5,
    });
    const stillSumToOne = Object.values(result.weights).reduce((a, b) => a + b, 0);
    expect(stillSumToOne).toBeCloseTo(1);
  });
});

describe('formatAffected', () => {
  it('renders readable resident counts from the actual population', () => {
    expect(formatAffected(12000)).toBe('~12,000 residents');
    expect(formatAffected(142004)).toBe('~142,004 residents');
    expect(formatAffected(4290589)).toBe('~4.29 million residents');
  });
});

describe('priority bands', () => {
  it('labels the whole-cluster score and its components from the same cutoffs', () => {
    expect(priorityBand(0.82)).toBe('high');
    expect(priorityBand(0.7)).toBe('high');
    expect(priorityBand(0.4)).toBe('medium');
    expect(priorityBand(0.39)).toBe('low');
    expect(componentBand(1)).toBe('high');
    expect(componentBand(0.66)).toBe('medium');
    expect(componentBand(0.3)).toBe('low');
  });
});

describe('buildPriorityExplanation', () => {
  it('builds the sentence from the numbers on the row, not a template', () => {
    expect(
      buildPriorityExplanation({
        volume: 40,
        normalizedVolume: 0.9,
        avgUrgency: 4.2,
        infrastructureGapScore: 0.71,
        populationAffected: 12000,
        score: 0.82,
        dataUnavailable: false,
      })
    ).toBe(
      'High priority (score 0.820): 40 reports (high volume), average urgency 4.2/5, ' +
        'infrastructure gap score 0.71 for this area ' +
        '(71.0% of households have no latrine within premises), affecting ~12,000 residents.'
    );
  });

  it('singularises a one-report cluster', () => {
    const text = buildPriorityExplanation({
      volume: 1,
      normalizedVolume: 0,
      avgUrgency: 3,
      infrastructureGapScore: 0.5,
      populationAffected: 5000,
      score: 0.5,
      dataUnavailable: false,
    });
    expect(text).toContain('1 report (low volume)');
    expect(text).not.toContain('1 reports');
  });

  it('says plainly when no reference data exists, and why the score still exists', () => {
    const text = buildPriorityExplanation({
      volume: 12,
      normalizedVolume: 0.4,
      avgUrgency: 2.3,
      infrastructureGapScore: null,
      populationAffected: null,
      score: 0.5,
      dataUnavailable: true,
    });
    expect(text).toContain(
      'Population and infrastructure gap data were not available for this area, ' +
        'so the score uses only reporting volume and urgency.'
    );
  });

  it('notes a gap-only gap without claiming the area has no data at all', () => {
    const text = buildPriorityExplanation({
      volume: 5,
      normalizedVolume: 0.2,
      avgUrgency: 3,
      infrastructureGapScore: null,
      populationAffected: 2240000,
      score: 0.63,
      dataUnavailable: false,
    });
    expect(text).toContain('affecting ~2.24 million residents');
    expect(text).toContain(
      'Infrastructure gap data were not available for this area, so the remaining components were reweighted.'
    );
  });
});

describe('scoreDemandSignals', () => {
  const corpus = [
    makeSignal({
      clusterId: 'DS-0001',
      locationDistrict: 'Visakhapatnam',
      volume: 8,
      avgUrgency: 4.8,
      populationAffected: 4290589,
      existingInfrastructureGap: 48.7,
    }),
    makeSignal({
      clusterId: 'DS-0002',
      locationDistrict: 'Bengaluru Urban',
      volume: 2,
      avgUrgency: 2,
      populationAffected: 9621551,
      existingInfrastructureGap: 5.2,
    }),
    makeSignal({
      clusterId: 'DS-0003',
      locationDistrict: 'Tirupati',
      volume: 5,
      avgUrgency: 3,
      populationAffected: 2240000,
      existingInfrastructureGap: null,
    }),
    makeSignal({
      clusterId: 'DS-0004',
      locationDistrict: 'Nowhere',
      volume: 1,
      avgUrgency: 1,
      populationAffected: null,
      existingInfrastructureGap: null,
    }),
  ];

  it('ranks clusters by priority, highest first', () => {
    const ranked = scoreDemandSignals(corpus);
    expect(ranked.map((s) => s.clusterId)).toEqual(['DS-0001', 'DS-0003', 'DS-0002', 'DS-0004']);
    expect(ranked.map((s) => s.priorityScore)).toEqual([0.751, 0.433, 0.275, 0]);
    const scores = ranked.map((s) => s.priorityScore);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('attaches a per-cluster explanation built from that cluster’s numbers', () => {
    const ranked = scoreDemandSignals(corpus);
    const top = ranked[0];
    // The mock corpus lines this up with a named Census 2011 row.
    expect(top.priorityExplanation).toContain('8 reports (high volume)');
    expect(top.priorityExplanation).toContain('average urgency 4.8/5');
    expect(top.priorityExplanation).toContain('infrastructure gap score 0.49 for this area');
    expect(top.priorityExplanation).toContain('48.7% of households have no latrine within premises');
    expect(top.priorityExplanation).toContain('~4.29 million residents');
    expect(top.priorityScore).toBe(0.751);
  });

  it('exposes the breakdown so the score can be re-derived by hand', () => {
    const ranked = scoreDemandSignals(corpus);
    const top = ranked[0];
    expect(top.priorityBreakdown).toMatchObject({
      normalizedVolume: 1,
      normalizedAvgUrgency: 0.95,
      infrastructureGapScore: 0.487,
      normalizedPopulationAffected: 0.278,
      weights: { volume: 0.35, avgUrgency: 0.25, infrastructureGap: 0.25, populationAffected: 0.15 },
    });
  });

  it('scores a data-less district on volume and urgency alone and says so', () => {
    const ranked = scoreDemandSignals(corpus);
    const nowhere = ranked.find((s) => s.clusterId === 'DS-0004') as DemandSignal & {
      priorityScore: number;
      dataUnavailable: boolean;
      priorityExplanation: string;
      priorityBreakdown?: DemandSignal['priorityBreakdown'];
    };
    expect(nowhere.dataUnavailable).toBe(true);
    expect(nowhere.priorityBreakdown?.weights).toEqual({
      volume: 0.583,
      avgUrgency: 0.417,
      infrastructureGap: 0,
      populationAffected: 0,
    });
    expect(nowhere.priorityExplanation).toMatch(/only reporting volume and urgency/);
  });

  it('scores a population-only district without the gap term and reweights', () => {
    const ranked = scoreDemandSignals(corpus);
    const tirupati = ranked.find((s) => s.clusterId === 'DS-0003')!;
    expect(tirupati.dataUnavailable).toBe(false);
    expect(tirupati.priorityBreakdown?.infrastructureGapScore).toBeNull();
    expect(tirupati.priorityBreakdown?.weights.infrastructureGap).toBe(0);
    expect(tirupati.priorityBreakdown?.weights.populationAffected).toBe(0.2);
    expect(tirupati.priorityExplanation).toMatch(/reweighted/);
  });

  it('renormalises the cluster-relative terms against each new set', () => {
    const target = makeSignal({
      clusterId: 'T',
      locationDistrict: 'X',
      volume: 50,
      avgUrgency: 3,
      populationAffected: 2000,
      existingInfrastructureGap: 10,
    });
    const sparse = scoreDemandSignals([
      target,
      makeSignal({ clusterId: 'S1', locationDistrict: 'Y', volume: 1, avgUrgency: 3, populationAffected: 2000, existingInfrastructureGap: 10 }),
    ]);
    const crowded = scoreDemandSignals([
      target,
      ...Array.from({ length: 9 }, (_, i) =>
        makeSignal({
          clusterId: `C${i}`,
          locationDistrict: `Z${i}`,
          volume: 1000 + i * 10,
          avgUrgency: 3,
          populationAffected: 2000,
          existingInfrastructureGap: 10,
        })
      ),
    ]);
    const inSparse = sparse.find((s) => s.clusterId === 'T')!;
    const inCrowded = crowded.find((s) => s.clusterId === 'T')!;
    expect(inSparse.priorityBreakdown.normalizedVolume).toBeGreaterThan(
      inCrowded.priorityBreakdown.normalizedVolume
    );
  });

  it('orders equal scores deterministically by volume then cluster id', () => {
    const a = makeSignal({ clusterId: 'DS-AA', volume: 1, avgUrgency: 3, populationAffected: 100, existingInfrastructureGap: 1 });
    const b = makeSignal({ clusterId: 'DS-BB', volume: 1, avgUrgency: 3, populationAffected: 100, existingInfrastructureGap: 1 });
    const first = scoreDemandSignals([b, a]);
    const second = scoreDemandSignals([b, a]);
    expect(first.map((s) => s.clusterId)).toEqual(['DS-AA', 'DS-BB']);
    expect(first.map((s) => s.clusterId)).toEqual(second.map((s) => s.clusterId));
  });

  it('returns an empty ranking for an empty set', () => {
    expect(scoreDemandSignals([])).toEqual([]);
  });
});