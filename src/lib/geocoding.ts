/**
 * Server-side reverse geocoding against OpenStreetMap's free Nominatim service.
 *
 * Lives in lib rather than only in the API route because the report submission
 * handler needs the same lookup. Calling our own /api/reverse-geocode over HTTP
 * from inside a request handler would be a pointless loop back through the
 * server, and would break whenever the app is called from something that is not
 * a browser.
 */
export interface ReverseGeocodeResult {
  // Deliberately `string | null` rather than LocationDetails' `string | undefined`:
  // a geocoder distinguishes "looked up, found nothing" from "never asked", and
  // the report handler relies on that to fall back to client-supplied details.
  state: string | null;
  district: string | null;
  mandal: string | null;
  pincode: string | null;
  /** Named road, street or footpath from OSM, when one is mapped at this point. */
  road: string | null;
  suburb: string | null;
  /** Nearest settlement: town, city or village. */
  town: string | null;
  /** Full human-readable label assembled by OSM, e.g. "12, Church Road, Vijayawada". */
  displayName: string | null;
}

export function emptyReverseGeocode(): ReverseGeocodeResult {
  return {
    state: null,
    district: null,
    mandal: null,
    pincode: null,
    road: null,
    suburb: null,
    town: null,
    displayName: null,
  };
}

/**
 * Cache so repeated lookups are cheap. The report flow reverse-geocodes on every
 * submission, and LocationPicker re-resolves whenever a citizen nudges the pin,
 * which would otherwise be one outbound request per interaction.
 *
 * Stashed on globalThis so it survives the dev server's module reloading; without
 * that, every edit would silently reset the cache and re-hammer Nominatim, whose
 * usage policy caps callers at roughly one request per second.
 */
const globalForGeocode = globalThis as unknown as {
  __civresReverseGeocodeCache?: Map<string, { expiresAt: number; value: ReverseGeocodeResult }>;
};
const cache: Map<string, { expiresAt: number; value: ReverseGeocodeResult }> =
  globalForGeocode.__civresReverseGeocodeCache ||
  (globalForGeocode.__civresReverseGeocodeCache = new Map());

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function readCache(key: string): ReverseGeocodeResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

export async function reverseGeocode(lat: number, lon: number): Promise<ReverseGeocodeResult> {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  const cached = readCache(key);
  if (cached) return cached;

  const res = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
    {
      headers: {
        // Nominatim's usage policy requires an identifying User-Agent.
        'User-Agent': 'C - TheResolve-DPG/1.0 (civic digital public good)',
        'Accept-Language': 'en',
      },
      cache: 'force-cache',
      next: { revalidate: 3600 },
    }
  );

  if (!res.ok) throw new Error(`Nominatim returned ${res.status}`);

  const data = await res.json();
  const a = data?.address ?? {};

  // India-specific mapping:
  // - district: state_district, falling back to county, which OSM uses where a
  //   district is not split out
  // - mandal: county is commonly the mandal/taluk/tehsil in Indian OSM data
  const district = a.state_district || a.county || a.municipality || null;
  const mandalRaw = a.state_district ? a.county : a.town || a.city || a.village || null;
  const mandal = mandalRaw !== district ? mandalRaw : a.town || a.village || null;
  const town = a.town || a.city || a.village || a.suburb || null;

  const result: ReverseGeocodeResult = {
    state: a.state || null,
    district,
    mandal,
    pincode: a.postcode || null,
    // OSM exposes several road-ish keys; road is the usual one but footpath and
    // pedestrian are mapped separately, and keeping them separate would lose
    // detail on exactly the kind of small civic defect this app is for.
    road: a.road || a.footpath || a.pedestrian || a.cycleway || null,
    suburb: a.suburb || a.neighbourhood || a.quarter || null,
    town,
    displayName: typeof data?.display_name === 'string' ? data.display_name : null,
  };

  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: result });
  return result;
}

/**
 * Human-readable address for a coordinate, assembled from real geography.
 *
 * Replaces a previous generator that picked a road and a landmark from two
 * six-element lists with `hash % 6` for both, so the indices always matched and
 * only six fixed strings could ever be produced. Every new report in a city
 * therefore got one of six addresses regardless of where it was filed.
 *
 * Degrades rather than invents: each part is used only if the geocoder actually
 * returned it, and the coordinate itself is always the last resort, so an
 * unreachable geocoder can never produce a wrong address.
 */
export function formatAddress(
  geo: ReverseGeocodeResult | null | undefined,
  lat: number,
  lon: number
): string {
  const parts: string[] = [];

  if (geo?.road) parts.push(geo.road);
  if (geo?.town) parts.push(geo.town);
  if (geo?.suburb && geo.suburb !== geo.town) parts.push(geo.suburb);
  if (geo?.district && geo.district !== geo.town && geo.district !== geo.suburb) {
    parts.push(geo.district);
  }
  if (geo?.state) parts.push(geo.state);
  if (geo?.pincode) parts.push(geo.pincode);

  if (parts.length > 0) {
    const unique = Array.from(new Set(parts));
    // Coordinates always trail the label so two issues on the same road remain
    // distinguishable on the map and in the admin list.
    unique.push(`${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    return unique.join(', ');
  }

  return `Dropped pin (${lat.toFixed(5)}, ${lon.toFixed(5)})`;
}
