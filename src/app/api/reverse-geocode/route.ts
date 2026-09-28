import { NextRequest, NextResponse } from 'next/server';
import {
  reverseGeocode,
  emptyReverseGeocode,
  type ReverseGeocodeResult,
} from '@/lib/geocoding';

export const dynamic = 'force-dynamic';

export type { ReverseGeocodeResult };

/**
 * Reverse geocodes a WGS 84 coordinate into Indian administrative divisions plus
 * street-level context: State, District, Mandal (sub-district), PIN code, road,
 * suburb and nearest town.
 *
 * The lookup itself lives in src/lib/geocoding.ts so the report submission
 * handler can share it instead of calling this endpoint over HTTP.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get('lat'));
  const lon = Number(searchParams.get('lon'));

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return NextResponse.json({ error: 'Invalid latitude/longitude.' }, { status: 400 });
  }

  try {
    return NextResponse.json(await reverseGeocode(lat, lon));
  } catch (error) {
    console.error('[Reverse Geocode] Failed to resolve location:', error);
    // Never crash the report flow if the geocoder is unreachable
    return NextResponse.json(emptyReverseGeocode(), { status: 502 });
  }
}
