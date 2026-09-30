import { readFileSync } from 'fs';
import { join } from 'path';
import { parseDistrictCsv } from './districtReference';

// ---------------------------------------------------------------------------
// Planned public spending for the demand-vs-spending panel.
//
// The challenge asks for citizen demand to be read next to public investment
// plans, so the dashboard needs real rupee figures — but a wrong or invented
// number here is worse than no number, because it would look authoritative.
// This module therefore only ever serves what is in the cited reference file
// database/data/planned_spending.csv, and fails soft when the file is missing
// or malformed: an unavailable dataset is reported as `available: false` with
// a reason, never as zeroes or estimates.
//
// The committed file holds the Jal Jeevan Mission state-wise central
// allocation and expenditure for FY 2024-25, transcribed from the Ministry of
// Jal Shakti's own JJM report (Format D1) and cross-checked row by row
// against the data.gov.in publication of the same figures (Rajya Sabha
// Session 267, Unstarred Question No. 103, answered 03-02-2025). It is
// state-grain: district-level plan allocations are not published for this
// scheme, and the panel says so rather than apportioning state totals.
// ---------------------------------------------------------------------------

export type SpendingGrain = 'state' | 'district';

export interface PlannedSpendingRow {
  state: string;
  /** Empty for state-grain rows; district-grain rows key exactly like the demand pipeline. */
  district: string | null;
  scheme: string;
  financialYear: string;
  grain: SpendingGrain;
  /** Planned central allocation in ₹ crore, as published. */
  allocatedCrore: number;
  /** Expenditure released up to March of that financial year, in ₹ crore. */
  expenditureCrore: number;
  source: string;
  sourceUrl: string;
  note: string | null;
}

export interface PlannedSpendingDataset {
  available: boolean;
  /** Why the dataset is unavailable; only set when `available` is false. */
  reason?: string;
  rowCount: number;
  scheme: string | null;
  financialYear: string | null;
  source: string | null;
  sourceUrl: string | null;
  rows: PlannedSpendingRow[];
}

const REQUIRED_COLUMNS = [
  'state',
  'grain',
  'scheme',
  'financial_year',
  'allocated_crore',
  'expenditure_crore',
  'source',
  'source_url',
] as const;

function csvPath(): string {
  return join(process.cwd(), 'database', 'data', 'planned_spending.csv');
}

function parseAmount(raw: string | undefined, column: string, state: string): number {
  const value = Number((raw ?? '').trim());
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `planned_spending.csv: ${column} must be a non-negative number for '${state}', got '${raw ?? ''}'`
    );
  }
  return value;
}

/**
 * Parses the planned-spending CSV. Every row must carry its citation: a
 * figure without a source column is a guess, and a guess must fail the load
 * rather than reach the dashboard. Exported separately from the loader so
 * tests can exercise malformed inputs without touching the filesystem.
 */
export function parsePlannedSpendingCsv(text: string): PlannedSpendingRow[] {
  const rows = parseDistrictCsv(text);
  if (rows.length === 0) throw new Error('planned_spending.csv is empty');

  const headerIndex = new Map(rows[0].map((name, i) => [name.trim(), i]));
  for (const column of REQUIRED_COLUMNS) {
    if (!headerIndex.has(column)) {
      throw new Error(`planned_spending.csv is missing the required column '${column}'`);
    }
  }

  const pick = (cells: string[], name: string): string => {
    const i = headerIndex.get(name);
    return i === undefined ? '' : (cells[i] ?? '').trim();
  };

  return rows.slice(1).map((cells) => {
    const state = pick(cells, 'state');
    if (!state) throw new Error('planned_spending.csv has a row with no state');

    const grain = pick(cells, 'grain');
    if (grain !== 'state' && grain !== 'district') {
      throw new Error(`planned_spending.csv: grain must be 'state' or 'district' for '${state}', got '${grain}'`);
    }

    const source = pick(cells, 'source');
    const sourceUrl = pick(cells, 'source_url');
    if (!source || !sourceUrl) {
      throw new Error(`planned_spending.csv: every row needs source and source_url ('${state}' is missing one)`);
    }

    const note = pick(cells, 'note');
    const district = pick(cells, 'district');
    return {
      state,
      district: district || null,
      scheme: pick(cells, 'scheme'),
      financialYear: pick(cells, 'financial_year'),
      grain,
      allocatedCrore: parseAmount(pick(cells, 'allocated_crore'), 'allocated_crore', state),
      expenditureCrore: parseAmount(pick(cells, 'expenditure_crore'), 'expenditure_crore', state),
      source,
      sourceUrl,
      note: note || null,
    };
  });
}

let cached: PlannedSpendingDataset | null = null;

function unavailable(reason: string): PlannedSpendingDataset {
  return {
    available: false,
    reason,
    rowCount: 0,
    scheme: null,
    financialYear: null,
    source: null,
    sourceUrl: null,
    rows: [],
  };
}

/**
 * Loads the planned-spending dataset, cached for the life of the process.
 * Unlike the district reference table (which the scoring path depends on and
 * so must throw on), this dataset is optional enrichment: a missing or broken
 * file degrades the panel to an explicit "not configured" state and the rest
 * of the dashboard keeps working.
 */
export function plannedSpendingDataset(): PlannedSpendingDataset {
  if (cached) return cached;

  let text: string;
  try {
    text = readFileSync(csvPath(), 'utf8');
  } catch (error) {
    cached = unavailable(
      `planned_spending.csv is not readable (${(error as Error).message}); no spending figures are shown rather than guessed.`
    );
    return cached;
  }

  try {
    const rows = parsePlannedSpendingCsv(text);
    const scheme = rows[0]?.scheme ?? null;
    const financialYear = rows[0]?.financialYear ?? null;
    cached = {
      available: true,
      rowCount: rows.length,
      scheme,
      financialYear,
      source: rows[0]?.source ?? null,
      sourceUrl: rows[0]?.sourceUrl ?? null,
      rows,
    };
    return cached;
  } catch (error) {
    cached = unavailable(
      `planned_spending.csv failed validation (${(error as Error).message}); no spending figures are shown rather than guessed.`
    );
    return cached;
  }
}

/** The plan row for a state at state grain, or undefined when none is published. */
export function spendingByState(state: string | undefined): PlannedSpendingRow | undefined {
  if (!state) return undefined;
  return plannedSpendingDataset().rows.find(
    (row) => row.grain === 'state' && row.state.toLowerCase() === state.toLowerCase()
  );
}
