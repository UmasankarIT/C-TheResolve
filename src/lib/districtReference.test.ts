import { describe, it, expect } from 'vitest';
import {
  parseDistrictCsv,
  districtStatistics,
  statisticsByDistrict,
  withDistrictStatistics,
} from './districtReference';
import type { DemandSignal } from './types';

// ---------------------------------------------------------------------------
// Step 4 data fusion. These tests read the real reference CSV the way the
// stores do (process.cwd()/database/data/district_reference.csv), so a value
// the pipeline emits can always be traced back to the open-data record that
// produced it. The figures were extracted from Census of India 2011 files
// served by ORGI NADA (Series A-1 populations; "latrine not available within
// premises" households), and are locked down here to make a regression in the
// reference file visible as a number mismatch, not a silent null.
// ---------------------------------------------------------------------------

function signal(overrides: Partial<DemandSignal> = {}): DemandSignal {
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
    verificationEngine: 'heuristic',
    ...overrides,
  };
}

describe('districtStatistics — reference table integrity', () => {
  it('loads one row per seeded district', () => {
    const stats = districtStatistics();
    expect(stats.length).toBe(24);
  });

  it('holds the Census 2011 population and gap for a seeded district', () => {
    const east = districtStatistics().find((s) => s.district === 'East Godavari');
    expect(east?.state).toBe('Andhra Pradesh');
    expect(east?.population).toBe(5154296);
    expect(east?.infrastructureGap).toBe(43.1);
  });

  it('maps seed district names onto their census spellings', () => {
    expect(districtStatistics().find((s) => s.district === 'Sri Srikakulam')?.censusDistrict).toBe('Srikakulam');
    expect(districtStatistics().find((s) => s.district === 'YSR Kadapa')?.censusDistrict).toBe('Y.S.R.');
    expect(districtStatistics().find((s) => s.district === 'Bengaluru Urban')?.censusDistrict).toBe('Bangalore');
    expect(districtStatistics().find((s) => s.district === 'Mysuru')?.censusDistrict).toBe('Mysore');
  });

  it('keeps post-2022 districts with real population but a null infrastructure gap', () => {
    const tirupati = statisticsByDistrict('Andhra Pradesh', 'Tirupati');
    expect(tirupati?.population).toBe(2240000);
    expect(tirupati?.infrastructureGap).toBeNull();

    const ntr = statisticsByDistrict('Andhra Pradesh', 'NTR');
    expect(ntr?.population).toBe(2218591);
    expect(ntr?.infrastructureGap).toBeNull();
  });

  it('stamps a provenance string naming every dataset that contributed', () => {
    const east = statisticsByDistrict('Andhra Pradesh', 'East Godavari');
    expect(east?.dataFusionSource).toBe('Census of India 2011, Series A-1; Census of India 2011, HL-11');

    const ntr = statisticsByDistrict('Andhra Pradesh', 'NTR');
    expect(ntr?.dataFusionSource).toBe('Andhra Pradesh district portal (official)');
  });
});

describe('statisticsByDistrict', () => {
  it('matches on the exact pipeline granularity', () => {
    expect(statisticsByDistrict('Andhra Pradesh', 'Visakhapatnam')?.population).toBe(4290589);
  });

  it('returns undefined for an unknown district rather than guessing', () => {
    expect(statisticsByDistrict('Andhra Pradesh', 'Nowhere')).toBeUndefined();
  });

  it('returns undefined when the location is incomplete', () => {
    expect(statisticsByDistrict(undefined, 'Visakhapatnam')).toBeUndefined();
    expect(statisticsByDistrict('Andhra Pradesh', undefined)).toBeUndefined();
  });
});

describe('withDistrictStatistics', () => {
  it('fuses population and gap onto a signal for its district', () => {
    const [fused] = withDistrictStatistics([signal()]);
    expect(fused.populationAffected).toBe(4290589);
    expect(fused.existingInfrastructureGap).toBe(48.7);
    expect(fused.dataFusionSource).toContain('Census of India 2011');
  });

  it('marks a district with no reference row as null, part of the contract', () => {
    const [fused] = withDistrictStatistics([
      signal({ locationDistrict: 'Nowhere', locationState: 'Nowhere State' }),
    ]);
    expect(fused.populationAffected).toBeNull();
    expect(fused.existingInfrastructureGap).toBeNull();
    expect(fused.dataFusionSource).toBeNull();
  });

  it('never invents a gap for a district that has population but no census row', () => {
    const [fused] = withDistrictStatistics([signal({ locationDistrict: 'NTR' })]);
    expect(fused.populationAffected).toBe(2218591);
    expect(fused.existingInfrastructureGap).toBeNull();
  });

  it('leaves the caller-owned signals untouched', () => {
    const input = [signal()];
    const fused = withDistrictStatistics(input);
    expect(fused).not.toBe(input);
    expect(fused[0]).not.toBe(input[0]);
    expect(input[0].populationAffected).toBeUndefined();
  });
});

describe('parseDistrictCsv', () => {
  it('parses quoted fields, CRLF line endings and skips blank lines', () => {
    const rows = parseDistrictCsv(
      'a,b\n"hello, world","x""y"\r\n\r\none,two\n'
    );
    expect(rows).toEqual([
      ['a', 'b'],
      ['hello, world', 'x"y'],
      ['one', 'two'],
    ]);
  });
});