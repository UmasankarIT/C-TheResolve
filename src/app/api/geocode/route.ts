import { NextRequest, NextResponse } from 'next/server';
import { GeocodeHit } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Small in-memory cache keyed by normalized query so repeat searches are cheap
const cache = new Map<string, GeocodeHit[]>();

/** Nominatim (primary) — OpenStreetMap's free geocoder. */
async function searchNominatim(q: string): Promise<GeocodeHit[]> {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=8&addressdetails=1&accept-language=en`,
    {
      headers: {
        'User-Agent': 'C - TheResolve-DPG/1.0 (civic digital public good)',
        'Accept-Language': 'en',
      },
      cache: 'force-cache',
      next: { revalidate: 3600 },
    }
  );

  if (!res.ok) {
    throw new Error(`Nominatim returned ${res.status}`);
  }

  const data = await res.json();
  return (Array.isArray(data) ? data : [])
    .filter((r: any) => Number.isFinite(Number(r?.lat)) && Number.isFinite(Number(r?.lon)))
    .slice(0, 8)
    .map((r: any) => {
      const a = r.address || {};
      const city = a.city || a.town || a.village || a.county || a.state_district || a.municipality;
      const parts: string[] = [];
      if (city && !parts.includes(city)) parts.push(city);
      if (a.state && !parts.includes(a.state)) parts.push(a.state);
      if (a.postcode && !parts.includes(a.postcode)) parts.push(a.postcode);

      const display = typeof r.display_name === 'string' ? r.display_name : q;
      return {
        lat: Number(r.lat),
        lon: Number(r.lon),
        label: display.length > 110 ? `${display.slice(0, 107)}…` : display,
        sublabel: parts.join(', ') || undefined,
      };
    });
}

/** Photon (fallback) — Komoot's free OSM-based geocoder, keyless and CORS-friendly. */
async function searchPhoton(q: string): Promise<GeocodeHit[]> {
  const res = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8`, {
    headers: {
      'User-Agent': 'C - TheResolve-DPG/1.0 (civic digital public good)',
    },
    cache: 'force-cache',
    next: { revalidate: 3600 },
  });

  if (!res.ok) {
    throw new Error(`Photon returned ${res.status}`);
  }

  const data = await res.json();
  const hits: GeocodeHit[] = [];
  for (const f of (data?.features as any[]) || []) {
    const p = f?.properties || {};
    const lon = Number(f?.geometry?.coordinates?.[0]);
    const lat = Number(f?.geometry?.coordinates?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const label = [p.name, p.street, p.city, p.state, p.postcode]
      .filter((v: any) => typeof v === 'string' && v.length > 0)
      .join(', ');
    hits.push({
      lat,
      lon,
      label: label || q,
      sublabel: [p.city, p.state, p.country].filter(Boolean).join(', ') || undefined,
    });
    if (hits.length >= 8) break;
  }
  return hits;
}

/**
 * Forward-geocodes a free-text place query ("Dwaraka Nagar, Visakhapatnam",
 * "560001", "Gandhi Road") into coordinates, using Nominatim first and
 * falling back to Photon. Powers both the map's "search anywhere" box and
 * the report form's typed location field (remote reporting when GPS is
 * unavailable or denied).
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') || '').trim();

  if (q.length < 3) {
    return NextResponse.json({ results: [] });
  }

  const cacheKey = q.toLowerCase();
  if (cache.has(cacheKey)) {
    return NextResponse.json({ results: cache.get(cacheKey) });
  }

  try {
    let results: GeocodeHit[];
    try {
      results = await searchNominatim(q);
    } catch (err) {
      console.warn('[Geocode] Nominatim failed, trying Photon:', err);
      results = await searchPhoton(q);
    }

    cache.set(cacheKey, results);
    return NextResponse.json({ results });
  } catch (error) {
    console.error('[Geocode] Place search failed on all providers:', error);
    // Never crash the map or report flow if the geocoder is unreachable
    return NextResponse.json({ results: [] }, { status: 502 });
  }
}