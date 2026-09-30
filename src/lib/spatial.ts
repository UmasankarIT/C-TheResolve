import { Issue, ReportIntent } from './types';
import { isTerminalStatus } from './workflow';

const EARTH_RADIUS_METERS = 6371008.8; // WGS 84 mean radius

/**
 * Calculates geodesic distance between two WGS 84 points using the Haversine formula.
 *
 * Spherical: this matches PostGIS ST_Distance(geography, geography,
 * use_spheroid => false) to the metre (verified 499993.9m for
 * Hyderabad -> Bengaluru). It is NOT identical to PostGIS's default, which uses
 * the WGS84 ellipsoid and returns 497661.8m for the same pair -- about 0.47%
 * lower. The two stores therefore disagree slightly at the very edge of the
 * dedup radius, by roughly 0.12m at 25m, which is well inside GPS accuracy and
 * not worth the cost of implementing the ellipsoid here.
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
  thresholdMeters: number = 25,
  intent: ReportIntent = 'complaint'
): { issue: Issue; distanceMeters: number } | null {
  let closest: { issue: Issue; distanceMeters: number } | null = null;

  for (const issue of issues) {
    // Only aggregate against active, unresolved issues with identical category
    if (issue.categoryId !== categoryId) continue;
    // Complaints and development requests are separate peer groups: a fresh
    // report must dedup against a row of its own intent only, never against
    // the other kind sitting at the same coordinates.
    if ((issue.intent ?? 'complaint') !== intent) continue;
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
