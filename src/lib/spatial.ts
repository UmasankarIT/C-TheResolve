import { Issue } from './types';
import { isTerminalStatus } from './workflow';

const EARTH_RADIUS_METERS = 6371008.8; // WGS 84 mean radius

/**
 * Calculates geodesic distance between two WGS 84 points using the Haversine formula.
 * Accurately mirrors PostGIS ST_Distance(geography, geography).
 */
export function calculateGeodesicDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const radLat1 = toRad(lat1);
  const radLat2 = toRad(lat2);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLon / 2) * Math.sin(dLon / 2) * Math.cos(radLat1) * Math.cos(radLat2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

/**
 * Finds existing active issue within spatial threshold for deduplication.
 *
 * In-memory reference implementation. The Postgres store answers the same
 * question with an indexed ST_DWithin query instead of scanning in JS, so this
 * is only reached when DATABASE_URL is unset.
 */
export function findNearbyActiveIssue(
  lat: number,
  lng: number,
  categoryId: string,
  issues: Issue[],
  thresholdMeters: number = 25
): { issue: Issue; distanceMeters: number } | null {
  let closest: { issue: Issue; distanceMeters: number } | null = null;

  for (const issue of issues) {
    // Only aggregate against active, unresolved issues with identical category
    if (issue.categoryId !== categoryId) continue;
    // Terminal means terminal, including `merged`: aggregating a fresh report
    // into a merged issue would silently discard it from active demand.
    if (isTerminalStatus(issue.status)) continue;

    const distance = calculateGeodesicDistanceMeters(lat, lng, issue.latitude, issue.longitude);

    if (distance <= thresholdMeters) {
      if (!closest || distance < closest.distanceMeters) {
        closest = { issue, distanceMeters: Math.round(distance * 10) / 10 };
      }
    }
  }

  return closest;
}

/**
 * Approximate Reverse Geocoder for human-friendly street labels based on coordinates
 */
export function generateMockAddress(lat: number, lng: number): string {
  const sectors = ['Main Bazaar Road', 'Railway Station Road', 'Bus Stand Road', 'National Highway Service Road', 'Ring Road', 'Village Main Road'];
  const landmarks = ['Near Bus Stand', 'Opposite Primary Health Centre', 'Near Anganwadi Centre', 'At Village Entrance', 'Near Water Tank', 'Opposite Gram Panchayat Office'];
  
  const hash = Math.abs(Math.floor(lat * 1000 + lng * 1000));
  const sector = sectors[hash % sectors.length];
  const landmark = landmarks[hash % landmarks.length];

  return `${landmark}, ${sector}`;
}
