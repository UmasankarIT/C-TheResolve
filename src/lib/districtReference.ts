import { readFileSync } from 'fs';
import { join } from 'path';
import type { DemandSignal } from './types';

// ---------------------------------------------------------------------------
// District reference data for Step 4 (DATA FUSION).
//
// One row per seeded district, all keyed by exactly the (state, district)
// names the demand-signal pipeline files complaints under, so the join is a
// plain lookup rather than a fuzzy match. The population figures and the
// infrastructure gap come from Census of India 2011 via the ORGI NADA open
// data portal; the single source of truth is database/data/
// district_reference.csv, and this module is the only runtime reader of it.
//
// The infrastructure gap is the percentage of households with no latrine
// facility within premises (Census 2011 households tables unfolded by that
// variable), a 0-100 value. Districts that did not exist at the 2011 census
// (the post-2022 bifurcation districts) carry an official population from
// their district portal and a null gap — missing data is reported as a
// clearly-flagged null, never silently guessed.
// ---------------------------------------------------------------------------

export interface DistrictStatistics {
  state: string;
  district: string;
  /** The district's name in the census files, when it differs from the seed name. */
  censusDistrict?: string;
  population: number;
  /** % of households without a latrine within premises (0-100); null when no census row exists. */
  infrastructureGap: number | null;
  populationSource: string;
  populationSourceUrl: string;
  infrastructureGapSource?: string;
  infrastructureGapSourceUrl?: string;
  note?: string;
  /** Human-readable provenance stamped onto signals fused from this row. */
  dataFusionSource: string;
}

interface CsvRow {
  state: string;
  district: string;
  census_district?: string;
  population: string;
  infrastructure_gap?: string;
  population_source: string;
  population_source_url: string;
  infrastructure_gap_source?: string;
  infrastructure_gap_source_url?: string;
  note?: string;
}

let cached: DistrictStatistics[] | null = null;

/**
 * Minimal RFC 4180 parser. The CSV is a curated reference file, so quoted
 * fields, escaped quotes and CRLF line endings are handled, but the whole
 * thing stays small and dependency-free rather than importing a parser for a
 * file the project owns.
 */
export function parseDistrictCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((cell) => cell !== '')) rows.push(row);
  }
  return rows;
}

function csvPath(): string {
  return join(process.cwd(), 'database', 'data', 'district_reference.csv');
}

function toStatistics(row: CsvRow): DistrictStatistics {
  const population = Number(row.population);
  if (!Number.isInteger(population) || population <= 0) {
    throw new Error(
      `district_reference.csv: invalid population for ${row.state}/${row.district}: '${row.population}'`
    );
  }

  const rawGap = row.infrastructure_gap?.trim();
  let infrastructureGap: number | null = null;
  if (rawGap && rawGap !== '') {
    infrastructureGap = Number(rawGap);
    if (!Number.isFinite(infrastructureGap) || infrastructureGap < 0 || infrastructureGap > 100) {
      throw new Error(
        `district_reference.csv: infrastructure_gap out of range for ${row.state}/${row.district}: '${rawGap}'`
      );
    }
  }

  const gapSource = deblank(row.infrastructure_gap_source);
  const dataFusionSource = infrastructureGap !== null && gapSource
    ? `${row.population_source}; ${gapSource}`
    : row.population_source;

  return {
    state: row.state,
    district: row.district,
    censusDistrict: deblank(row.census_district),
    population,
    infrastructureGap,
    populationSource: row.population_source,
    populationSourceUrl: row.population_source_url,
    infrastructureGapSource: gapSource,
    infrastructureGapSourceUrl: deblank(row.infrastructure_gap_source_url),
    note: deblank(row.note),
    dataFusionSource,
  };
}

function deblank(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed || undefined;
}

/**
 * Loads the district reference table. The file is read once and cached for
 * the life of the process, so a hot reload does not re-parse the CSV on every
 * build. A malformed row throws rather than being skipped, because a silently
 * dropped district would turn real data into a null signal with no warning.
 */
export function districtStatistics(): DistrictStatistics[] {
  if (cached) return cached;
  let rows: string[][];
  try {
    rows = parseDistrictCsv(readFileSync(csvPath(), 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read district reference CSV (${csvPath()}): ${(error as Error).message}`);
  }
  if (rows.length === 0) throw new Error('district_reference.csv is empty');

  const headerIndex = new Map(rows[0].map((name, i) => [name.trim(), i]));
  const required = ['state', 'district', 'population', 'population_source', 'population_source_url'];
  for (const name of required) {
    if (!headerIndex.has(name)) {
      throw new Error(`district_reference.csv is missing the required column '${name}'`);
    }
  }

  cached = rows.slice(1).map((cells) => {
    const pick = (name: string): string | undefined => {
      const i = headerIndex.get(name);
      return i === undefined ? undefined : cells[i]?.trim();
    };
    return toStatistics({
      state: pick('state') as string,
      district: pick('district') as string,
      census_district: pick('census_district') ?? undefined,
      population: pick('population') as string,
      infrastructure_gap: pick('infrastructure_gap') ?? undefined,
      population_source: pick('population_source') as string,
      population_source_url: pick('population_source_url') as string,
      infrastructure_gap_source: pick('infrastructure_gap_source') ?? undefined,
      infrastructure_gap_source_url: pick('infrastructure_gap_source_url') ?? undefined,
      note: pick('note') ?? undefined,
    });
  });
  return cached;
}

/**
 * The fusion lookup: the reference table row for a (state, district), keyed
 * exactly on the names the pipeline files complaints under. Returns undefined
 * for an unknown district — the caller reports that as a null, not an error.
 */
export function statisticsByDistrict(
  state?: string,
  district?: string
): DistrictStatistics | undefined {
  if (!state || !district) return undefined;
  return districtStatistics().find((d) => d.state === state && d.district === district);
}

/**
 * Marks every demand signal with the statistics for its district.
 *
 * `population_affected`, `existing_infrastructure_gap` and `data_fusion_source`
 * are set from the reference table, and are ALWAYS present afterwards: null
 * when no reference row matches, so the scoring step can tell "this district
 * has no data" from "this district has real data" without conflating the two.
 * Reports that resolve only to state granularity have no district row and so
 * produce nulls too.
 */
export function withDistrictStatistics(signals: DemandSignal[]): DemandSignal[] {
  return signals.map((signal) => {
    const stats = statisticsByDistrict(signal.locationState, signal.locationDistrict);
    return {
      ...signal,
      populationAffected: stats?.population ?? null,
      existingInfrastructureGap: stats?.infrastructureGap ?? null,
      dataFusionSource: stats?.dataFusionSource ?? null,
    };
  });
}