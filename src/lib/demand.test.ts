import { describe, it, expect } from 'vitest';
import {
  isOpenIssue,
  buildCategoryDemand,
  buildStateDemand,
  buildDistrictDemand,
  buildNationalSummary,
} from './demand';
import { isTerminalStatus } from './workflow';
import type { Category, Issue, IssueStatus, MLAnalysis } from './types';

/**
 * The demand rollups are what the admin console and the "investment focus"
 * recommendation are built from. Two properties are worth locking down:
 *
 *  1. stateOf() used to read `issue.state || stateOf(issue)`, infinite
 *     recursion, silently dormant only because every seeded row had a state.
 *     These tests exercise the JSONB fallback directly so that regression cannot
 *     come back unnoticed.
 *  2. An issue with no state must roll up as "Unknown" rather than vanishing or
 *     crashing the whole national summary.
 */

const category: Category = {
  id: 'cat-pothole',
  code: 'POTHOLE',
  name: 'Potholes',
  description: 'Broken road surface',
  baseSeverityWeight: 1.0,
  defaultSlaHours: 72,
  responsibleDepartment: 'DEPT_PWD',
  iconName: 'construction',
};

const analysis: MLAnalysis = {
  predictedCategory: 'Potholes',
  categoryConfidence: 0.8,
  estimatedSeverity: 4,
  isCivicIssue: true,
  detectedHazards: [],
  inferenceLatencyMs: 12,
};

let seq = 0;
function makeIssue(overrides: Partial<Issue> = {}): Issue {
  seq += 1;
  return {
    id: `iss-${seq}`,
    categoryId: category.id,
    category,
    title: 'Test',
    description: '',
    latitude: 14.6819,
    longitude: 77.6006,
    formattedAddress: 'Test',
    status: 'reported' as IssueStatus,
    state: 'Andhra Pradesh',
    locationDetails: { state: 'Andhra Pradesh', district: 'Anantapur' },
    reportCount: 1,
    communityUpvotes: 0,
    mlSeverityScore: 4,
    priorityScore: 40,
    mlAnalysis: analysis,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Issue;
}

describe('isOpenIssue', () => {
  it('counts active statuses as open', () => {
    for (const s of ['reported', 'in_review', 'verified', 'assigned', 'in_progress'] as IssueStatus[]) {
      expect(isOpenIssue(makeIssue({ status: s })), `${s} should be open`).toBe(true);
    }
  });

  it('excludes every terminal status', () => {
    for (const s of ['resolved', 'merged', 'rejected'] as IssueStatus[]) {
      expect(isOpenIssue(makeIssue({ status: s })), `${s} should not be open`).toBe(false);
      expect(isTerminalStatus(s)).toBe(true);
    }
  });
});

describe('stateOf fallback', () => {
  it('uses the indexed state column when present', () => {
    const [row] = buildStateDemand(
      [makeIssue({ state: 'Karnataka', locationDetails: { state: 'Andhra Pradesh', district: 'X' } })],
      []
    );
    expect(row.state).toBe('Karnataka');
  });

  it('falls back to locationDetails when the state column is empty', () => {
    // The regression this guards: this used to call stateOf() recursively and
    // throw a stack overflow. The column is empty for any row written before the
    // column existed, so the fallback is genuinely reachable in production.
    const [row] = buildStateDemand(
      [makeIssue({ state: undefined, locationDetails: { state: 'Telangana', district: 'Hyderabad' } })],
      []
    );
    expect(row.state).toBe('Telangana');
  });

  it('labels a completely unknown state as Unknown rather than dropping it', () => {
    const [row] = buildStateDemand([makeIssue({ state: undefined, locationDetails: undefined })], []);
    expect(row.state).toBe('Unknown');
    expect(row.openCount).toBe(1);
  });

  it('handles an empty issue list without throwing', () => {
    expect(buildStateDemand([], [])).toEqual([]);
    expect(buildDistrictDemand([], [])).toEqual([]);
  });
});

describe('buildCategoryDemand', () => {
  it('groups by category and counts only open issues passed in', () => {
    const rows = buildCategoryDemand([
      makeIssue({ status: 'reported' }),
      makeIssue({ status: 'in_progress' }),
      makeIssue({ categoryId: 'cat-garbage', category: { ...category, id: 'cat-garbage', name: 'Garbage' } }),
    ]);
    expect(rows).toHaveLength(2);
    const potholes = rows.find((r) => r.id === 'cat-pothole')!;
    expect(potholes.openCount).toBe(2);
  });
});

describe('buildStateDemand', () => {
  it('separates states rather than merging them', () => {
    const rows = buildStateDemand(
      [
        makeIssue({ state: 'Andhra Pradesh', locationDetails: { state: 'Andhra Pradesh', district: 'Anantapur' } }),
        makeIssue({ state: 'Karnataka', locationDetails: { state: 'Karnataka', district: 'Bengaluru Urban' } }),
        makeIssue({ state: 'Karnataka', locationDetails: { state: 'Karnataka', district: 'Bengaluru Urban' } }),
      ],
      []
    );
    const byState = Object.fromEntries(rows.map((r) => [r.state, r.openCount]));
    expect(byState['Andhra Pradesh']).toBe(1);
    expect(byState['Karnataka']).toBe(2);
  });

  it('orders states by pressure score, highest first', () => {
    const rows = buildStateDemand(
      [
        makeIssue({ state: 'Andhra Pradesh', communityUpvotes: 1 }),
        makeIssue({ state: 'Karnataka', communityUpvotes: 50, mlSeverityScore: 5 }),
        makeIssue({ state: 'Delhi', communityUpvotes: 10 }),
      ],
      []
    );
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].pressureScore).toBeGreaterThanOrEqual(rows[i].pressureScore);
    }
  });
});

describe('buildNationalSummary', () => {
  it('counts distinct states and districts', () => {
    const issues = [
      makeIssue({ state: 'Andhra Pradesh', locationDetails: { state: 'Andhra Pradesh', district: 'Anantapur' } }),
      makeIssue({ state: 'Andhra Pradesh', locationDetails: { state: 'Andhra Pradesh', district: 'Kadapa' } }),
      makeIssue({ state: 'Karnataka', locationDetails: { state: 'Karnataka', district: 'Mysuru' } }),
    ];
    const stateDemand = buildStateDemand(issues, []);
    const categoryDemand = buildCategoryDemand(issues);
    const summary = buildNationalSummary(issues, [], stateDemand, categoryDemand);
    expect(summary.statesCovered).toBe(2);
    expect(summary.totalOpen).toBe(3);
    expect(summary.leadingState).toBeTruthy();
  });

  it('does not throw on an empty dataset', () => {
    const summary = buildNationalSummary([], [], [], []);
    expect(summary.totalOpen).toBe(0);
    expect(summary.statesCovered).toBe(0);
  });
});
