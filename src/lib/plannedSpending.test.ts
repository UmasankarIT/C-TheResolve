import { describe, it, expect } from 'vitest';
import {
  parsePlannedSpendingCsv,
  plannedSpendingDataset,
  spendingByState,
} from './plannedSpending';

// ---------------------------------------------------------------------------
// Planned-spending reference integrity. These tests read the real CSV the way
// the API route does (process.cwd()/database/data/planned_spending.csv) and
// lock down the figures with hand-verified values from the Ministry of Jal
// Shakti JJM Format D1 report, cross-checked against the data.gov.in
// publication of the same FY 2024-25 numbers (Rajya Sabha Session 267,
// Unstarred Question No. 103). A regression in the reference file must show
// up as a number mismatch, not as a silently wrong dashboard.
// ---------------------------------------------------------------------------

const HEADER =
  'state,district,scheme,financial_year,grain,allocated_crore,expenditure_crore,source,source_url,note';

const SOURCE = '"Ministry of Jal Shakti","https://example.gov.in/report"';

describe('plannedSpendingDataset — reference table integrity', () => {
  it('loads the committed dataset as available', () => {
    const dataset = plannedSpendingDataset();
    expect(dataset.available).toBe(true);
    expect(dataset.reason).toBeUndefined();
    expect(dataset.rowCount).toBe(34);
    expect(dataset.scheme).toBe('Jal Jeevan Mission (central share)');
    expect(dataset.financialYear).toBe('2024-25');
    expect(dataset.source).toContain('Ministry of Jal Shakti');
    expect(dataset.sourceUrl).toContain('ejalshakti.gov.in');
  });

  it('holds the hand-verified allocation for a seeded state', () => {
    const ap = spendingByState('Andhra Pradesh');
    expect(ap?.allocatedCrore).toBe(2520.97);
    expect(ap?.expenditureCrore).toBe(973.52);
    expect(ap?.grain).toBe('state');
    expect(ap?.financialYear).toBe('2024-25');
  });

  it('records the published zero for Telangana with an explanatory note', () => {
    const ts = spendingByState('Telangana');
    expect(ts?.allocatedCrore).toBe(0);
    expect(ts?.note).toBeTruthy();
  });

  it('has no row for Delhi, which is outside JJM coverage', () => {
    expect(spendingByState('Delhi')).toBeUndefined();
  });

  it('cites a source on every row', () => {
    const rows = plannedSpendingDataset().rows;
    for (const row of rows) {
      expect(row.source.length).toBeGreaterThan(0);
      expect(row.sourceUrl.length).toBeGreaterThan(0);
    }
  });
});

describe('parsePlannedSpendingCsv — validation fails loudly, never guesses', () => {
  it('rejects a header without the required columns', () => {
    expect(() => parsePlannedSpendingCsv('state,allocated_crore\nX,1')).toThrow('missing the required column');
  });

  it('rejects an empty file', () => {
    expect(() => parsePlannedSpendingCsv('')).toThrow('empty');
  });

  it('rejects a non-numeric allocation', () => {
    const csv = [
      HEADER,
      '"Karnataka",,"Jal Jeevan Mission (central share)","2024-25",state,many,10.0,' + SOURCE + ',""',
    ].join('\n');
    expect(() => parsePlannedSpendingCsv(csv)).toThrow('non-negative number');
  });

  it('rejects a row without a citation', () => {
    const csv = [
      HEADER,
      '"Karnataka",,"Jal Jeevan Mission (central share)","2024-25",state,3804.41,10842.68,"","",',
    ].join('\n');
    expect(() => parsePlannedSpendingCsv(csv)).toThrow('source and source_url');
  });

  it('rejects an unknown grain', () => {
    const csv = [HEADER, '"Karnataka",,"Jal Jeevan Mission (central share)","2024-25",village,1,2,' + SOURCE + ',""'].join(
      '\n'
    );
    expect(() => parsePlannedSpendingCsv(csv)).toThrow("grain must be 'state' or 'district'");
  });

  it('parses a valid row', () => {
    const csv = [HEADER, '"Karnataka",,"Jal Jeevan Mission (central share)","2024-25",state,3804.41,10842.68,' + SOURCE + ',"note"'].join('\n');
    const [row] = parsePlannedSpendingCsv(csv);
    expect(row.state).toBe('Karnataka');
    expect(row.allocatedCrore).toBe(3804.41);
    expect(row.expenditureCrore).toBe(10842.68);
    expect(row.note).toBe('note');
    expect(row.district).toBeNull();
  });
});
