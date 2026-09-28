/**
 * Public data layer — Government of India Open Government Data (OGD) platform.
 *
 * The portal is reached at https://api.data.gov.in/resource/<resource-id> and
 * requires a per-user API key, so nothing here is hard-wired: a key and the
 * resource IDs of the datasets you want are supplied through the environment.
 * Every call is cached, time-boxed and fails soft — a missing key, an unknown
 * resource or a portal outage must never break demand intelligence, it just
 * downgrades the fusion to citizen reports plus the curated baseline.
 *
 * Expected environment (see .env.example):
 *   DATA_GOV_IN_API_KEY            portal key from https://data.gov.in
 *   DATA_GOV_IN_PCA_RESOURCE       resource id of a Primary Census Abstract set
 *   DATA_GOV_IN_PCA_STATE_FIELD    column holding the state name  (e.g. "State Name")
 *   DATA_GOV_IN_PCA_DISTRICT_FIELD column holding the district name
 *   DATA_GOV_IN_PCA_STATE          state to filter on (e.g. "Andhra Pradesh")
 */

const OGD_BASE = 'https://api.data.gov.in/resource';
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface PublicDataResult {
  source: string;
  resourceId: string;
  fetchedAt: string;
  recordCount: number;
  records: Record<string, unknown>[];
}

export interface DistrictIndicators {
  district: string;
  population: number | null;
  households: number | null;
  literacyRate: number | null;
  sexRatio: number | null;
  slumPopulationShare: number | null;
  source: string;
}

const globalForPublicData = globalThis as unknown as {
  __civresPublicDataCache?: Map<string, { expiresAt: number; value: PublicDataResult | null }>;
};
const cache: Map<string, { expiresAt: number; value: PublicDataResult | null }> =
  globalForPublicData.__civresPublicDataCache || new Map();
globalForPublicData.__civresPublicDataCache = cache;

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    if (record[key] === undefined) continue;
    const value = Number(String(record[key]).replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/** Case/space-insensitive column lookup, so a differently cased header still hits. */
function resolveField(record: Record<string, unknown>, configured: string | undefined, aliases: string[]): string | undefined {
  if (configured) {
    const exact = Object.keys(record).find((k) => k.toLowerCase() === configured.toLowerCase());
    if (exact) return exact;
  }
  const normalized = Object.keys(record).map((k) => [k, k.toLowerCase().replace(/[^a-z0-9]/g, '')] as const);
  for (const alias of aliases) {
    const target = alias.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hit = normalized.find(([, norm]) => norm === target || norm.includes(target));
    if (hit) return hit[0];
  }
  return undefined;
}

export function publicDataConfig() {
  const apiKey = process.env.DATA_GOV_IN_API_KEY;
  const resourceId = process.env.DATA_GOV_IN_PCA_RESOURCE;
  return {
    configured: Boolean(apiKey && resourceId),
    apiKey,
    resourceId,
    stateField: process.env.DATA_GOV_IN_PCA_STATE_FIELD,
    districtField: process.env.DATA_GOV_IN_PCA_DISTRICT_FIELD,
    state: process.env.DATA_GOV_IN_PCA_STATE || 'Andhra Pradesh',
  };
}

export async function fetchDataGovIn(
  resourceId: string,
  opts: { limit?: number; filters?: Record<string, string>; stateField?: string; stateValue?: string } = {}
): Promise<PublicDataResult | null> {
  const { apiKey } = publicDataConfig();
  if (!apiKey) return null;

  const limit = Math.min(opts.limit || 100, 1000);
  const params = new URLSearchParams({ 'api-key': apiKey, format: 'json', limit: String(limit), offset: '0' });
  for (const field of Object.keys(opts.filters || {})) {
    params.set(`filters[${field}]`, String((opts.filters || {})[field]));
  }

  const url = `${OGD_BASE}/${encodeURIComponent(resourceId)}?${params.toString()}`;
  const cacheKey = url;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`[publicData] OGD request failed: ${res.status} ${res.statusText}`);
      cache.set(cacheKey, { expiresAt: Date.now() + 60_000, value: null });
      return null;
    }
    const body = (await res.json()) as { records?: Record<string, unknown>[]; total?: number };
    const value: PublicDataResult = {
      source: 'data.gov.in',
      resourceId,
      fetchedAt: new Date().toISOString(),
      recordCount: body.total ?? body.records?.length ?? 0,
      records: body.records || [],
    };
    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  } catch (err) {
    console.warn('[publicData] OGD request error:', err instanceof Error ? err.message : err);
    cache.set(cacheKey, { expiresAt: Date.now() + 60_000, value: null });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Real demographic indicators per district, aggregated from the OGD records.
 * Column names differ between resources, so aliases are probed and any
 * indicator that cannot be resolved is reported as null instead of guessed.
 */
export async function getDistrictIndicators(
  districts: string[]
): Promise<{ configured: boolean; source: string | null; fetchedAt: string | null; indicators: DistrictIndicators[] }> {
  const cfg = publicDataConfig();
  const empty = { configured: cfg.configured, source: null, fetchedAt: null, indicators: [] as DistrictIndicators[] };
  if (!cfg.configured || districts.length === 0) return empty;

  const result = await fetchDataGovIn(cfg.resourceId as string, {
    limit: 1000,
    ...(cfg.stateField ? { filters: { [cfg.stateField]: cfg.state } } : {}),
  });
  if (!result || result.records.length === 0) return empty;

  const wanted = new Map(districts.map((d) => [d.toLowerCase(), d]));
  const totals = new Map<string, DistrictIndicators & { _pop: number; _hh: number; _lit: number; _rows: number }>();

  for (const record of result.records) {
    const districtColumn = resolveField(record, cfg.districtField, [
      'District Name',
      'District',
      'District Name 3',
      'AName',
    ]);
    if (!districtColumn) return empty;

    const rawName = String(record[districtColumn] ?? '').trim();
    const canonical = wanted.get(rawName.toLowerCase());
    if (!canonical) continue;

    const population = readNumber(record, ['TRU_P', 'TOT_P', 'Total_Population', 'Population', 'TOT_POP']);
    const households = readNumber(record, ['No_HH', 'TOT_HH', 'Households', 'NO_HH']);
    const lit = readNumber(record, ['LIT', 'TOT_LIT', 'Literate', 'TOT_LITERATE']);
    const litFemale = readNumber(record, ['LIT_F', 'LITF']);
    const sexRatio = readNumber(record, ['TOT_F', 'FEMALE', 'Total_Female']);

    const entry = totals.get(canonical) || {
      district: canonical,
      population: 0,
      households: 0,
      literacyRate: null,
      sexRatio: null,
      slumPopulationShare: null,
      source: 'data.gov.in',
      _pop: 0,
      _hh: 0,
      _lit: 0,
      _rows: 0,
    };
    if (population) {
      entry.population = (entry.population || 0) + population;
      entry._pop += 1;
    }
    if (households) {
      entry.households = (entry.households || 0) + households;
      entry._hh += 1;
    }
    if (lit && population) {
      const femaleShare = litFemale && population ? litFemale / population : null;
      entry._lit += femaleShare === null ? lit / population : (lit / population) * (femaleShare > 0.6 ? 0.55 : 0.67);
    }
    if (sexRatio && population) entry.sexRatio = Math.round(1000 * (sexRatio / population));
    entry._rows += 1;
    totals.set(canonical, entry);
  }

  const indicators = Array.from(totals.values()).map((e) => ({
    district: e.district,
    population: e._pop > 0 ? e.population : null,
    households: e._hh > 0 ? e.households : null,
    literacyRate: e._lit > 0 ? Number(((e._lit / e._rows) * 100).toFixed(1)) : null,
    sexRatio: e.sexRatio,
    slumPopulationShare: e.slumPopulationShare,
    source: e.source,
  }));

  return { configured: true, source: result.source, fetchedAt: result.fetchedAt, indicators };
}
