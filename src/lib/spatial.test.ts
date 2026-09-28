import { describe, it, expect } from 'vitest';
import { findNearbyActiveIssue, calculateGeodesicDistanceMeters } from './spatial';
import { isTerminalStatus, TERMINAL_STATUSES } from './workflow';
import type { Category, Issue, IssueStatus } from './types';

/**
 * The spatial dedup rules are the part of this app where a silent regression is
 * worst: a wrong terminal-status set does not throw, it just quietly starts
 * merging new reports into dead issues, and the report is then invisible in
 * active demand.
 */

const category: Category = {
  id: 'cat-garbage-dump',
  code: 'GARBAGE',
  name: 'Illegal Garbage Dumping',
  description: 'Unauthorised waste dump',
  baseSeverityWeight: 1.0,
  defaultSlaHours: 48,
  responsibleDepartment: 'DEPT_SWMC',
  iconName: 'trash',
};

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'seed-test-1',
    categoryId: category.id,
    category,
    title: 'Test issue',
    description: '',
    latitude: 14.6819,
    longitude: 77.6006,
    formattedAddress: 'Test',
    status: 'reported' as IssueStatus,
    reportCount: 1,
    communityUpvotes: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Issue;
}

describe('isTerminalStatus', () => {
  it('treats resolved, merged and rejected as terminal', () => {
    // 'merged' is the one that matters most: aggregating into a merged issue
    // silently discards the new report from active demand.
    for (const s of ['resolved', 'merged', 'rejected'] as IssueStatus[]) {
      expect(isTerminalStatus(s), `${s} must be terminal`).toBe(true);
    }
  });

  it('does not treat active statuses as terminal', () => {
    for (const s of ['reported', 'in_review', 'verified', 'assigned', 'in_progress'] as IssueStatus[]) {
      expect(isTerminalStatus(s), `${s} must not be terminal`).toBe(false);
    }
  });

  it('exposes the same set the dedup path relies on', () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(['merged', 'rejected', 'resolved']);
  });
});

describe('findNearbyActiveIssue', () => {
  const here = { lat: 14.6819, lng: 77.6006 };

  it('matches an identical coordinate', () => {
    const issue = makeIssue();
    const found = findNearbyActiveIssue(here.lat, here.lng, issue.categoryId, [issue]);
    expect(found).not.toBeNull();
    expect(found!.issue.id).toBe(issue.id);
    expect(found!.distanceMeters).toBeCloseTo(0, 5);
  });

  it('does not match beyond the threshold', () => {
    // +0.0005 deg latitude is ~55.6m: outside the default 25m radius, inside 100m.
    const issue = makeIssue({ latitude: 14.6824 });
    expect(findNearbyActiveIssue(here.lat, here.lng, issue.categoryId, [issue], 25)).toBeNull();
    expect(findNearbyActiveIssue(here.lat, here.lng, issue.categoryId, [issue], 100)).not.toBeNull();
  });

  it('ignores issues in a different category', () => {
    const other = makeIssue({ categoryId: 'cat-pothole' });
    expect(findNearbyActiveIssue(here.lat, here.lng, 'cat-garbage-dump', [other])).toBeNull();
  });

  it('ignores every terminal status, including merged', () => {
    for (const status of ['resolved', 'merged', 'rejected'] as IssueStatus[]) {
      const issue = makeIssue({ status });
      expect(
        findNearbyActiveIssue(here.lat, here.lng, issue.categoryId, [issue]),
        `${status} issue must not absorb a new report`
      ).toBeNull();
    }
  });

  it('returns the closest match when several are in range', () => {
    const near = makeIssue({ id: 'near', latitude: 14.6821 });
    const far = makeIssue({ id: 'far', latitude: 14.6825 });
    const found = findNearbyActiveIssue(here.lat, here.lng, 'cat-garbage-dump', [far, near]);
    expect(found!.issue.id).toBe('near');
    expect(found!.distanceMeters).toBeLessThan(25);
  });

  it('skips a terminal issue even when it is the closest', () => {
    // dead is ~5.6m away, live ~22.3m: both inside 25m, so only the terminal
    // check can decide this. If terminal statuses stopped being skipped, the
    // resolved issue would win and the new report would vanish.
    const dead = makeIssue({ id: 'dead-resolved', status: 'resolved', latitude: 14.68195 });
    const live = makeIssue({ id: 'live-open', latitude: 14.6821 });
    const found = findNearbyActiveIssue(here.lat, here.lng, 'cat-garbage-dump', [dead, live]);
    expect(found!.issue.id).toBe('live-open');
  });

  it('returns null for an empty issue list', () => {
    expect(findNearbyActiveIssue(here.lat, here.lng, 'cat-garbage-dump', [])).toBeNull();
  });
});

describe('calculateGeodesicDistanceMeters', () => {
  it('is zero for the same point', () => {
    expect(calculateGeodesicDistanceMeters(17.385, 78.4867, 17.385, 78.4867)).toBe(0);
  });

  it('is symmetric', () => {
    const a = calculateGeodesicDistanceMeters(14.6819, 77.6006, 17.385, 78.4867);
    const b = calculateGeodesicDistanceMeters(17.385, 78.4867, 14.6819, 77.6006);
    expect(a).toBeCloseTo(b, 9);
  });

  it('matches PostGIS spherical distance to the metre', () => {
    // Hyderabad -> Bengaluru. PostGIS returns 499993.9m with use_spheroid=>false
    // and 497661.8m on the default WGS84 ellipsoid. This function is spherical,
    // so it must match the former exactly and be ~0.47% above the latter.
    // Pinning both numbers keeps the two store implementations honest about the
    // difference rather than letting either drift silently.
    const meters = calculateGeodesicDistanceMeters(17.385, 78.4867, 12.9716, 77.5946);
    expect(meters).toBeCloseTo(499993.9, 0);

    const vsSpheroid = (meters - 497661.8) / 497661.8;
    expect(vsSpheroid).toBeGreaterThan(0.004);
    expect(vsSpheroid).toBeLessThan(0.005);
  });

  it('handles a one-degree longitude step at the equator', () => {
    // ~111.3km at the equator, ~107.5km at 60N. Guards against a flat-earth
    // shortcut creeping in.
    const eq = calculateGeodesicDistanceMeters(0, 0, 0, 1);
    expect(eq).toBeGreaterThan(110_000);
    expect(eq).toBeLessThan(112_000);
    const high = calculateGeodesicDistanceMeters(60, 0, 60, 1);
    expect(high).toBeLessThan(eq);
  });
});

