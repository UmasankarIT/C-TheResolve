import { describe, it, expect } from 'vitest';
import { canTransition, slaDeadlineFor, isSlaBreached, hoursOpen } from './workflow';
import type { AuthUser, Category, Issue, IssueStatus, ProofOfWork } from './types';

/**
 * canTransition is the authorisation boundary for the whole ticket lifecycle:
 * department isolation and the "resolution needs field proof" rule both live
 * here. A regression would not throw, it would let staff close another
 * department's ticket, or let an admin resolve without proof.
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

const citizen: AuthUser = { userId: 'u-cit', role: 'citizen', name: 'Citizen' };
const staff: AuthUser = {
  userId: 'u-staff',
  role: 'department',
  name: 'Staff',
  departmentId: 'DEPT_PWD',
};
const admin: AuthUser = { userId: 'u-admin', role: 'city_admin', name: 'Admin' };

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: 'test-1',
    categoryId: 'cat-pothole',
    category,
    title: 'Test',
    description: '',
    latitude: 17.385,
    longitude: 78.4867,
    formattedAddress: 'Test',
    status: 'reported' as IssueStatus,
    departmentId: 'DEPT_PWD',
    reportCount: 1,
    communityUpvotes: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Issue;
}

function proof(): ProofOfWork {
  return {
    id: 'pow-1',
    issueId: 'test-1',
    departmentId: 'DEPT_PWD',
    submittedBy: 'Roads Field Staff',
    photoUrl: 'http://localhost:9010/civicresolve/issue/proof-1.jpg',
    notes: 'Patched',
    submittedAt: '2026-01-02T00:00:00.000Z',
  };
}

describe('canTransition - citizens', () => {
  it('refuses every status change', () => {
    for (const next of ['in_review', 'verified', 'assigned', 'resolved'] as IssueStatus[]) {
      const r = canTransition(citizen, makeIssue(), next);
      expect(r.ok, `citizen must not reach ${next}`).toBe(false);
    }
  });
});

describe('canTransition - department isolation', () => {
  it('blocks staff from acting on another department\'s ticket', () => {
    // PWD staff reaching for a SWMC-owned ticket.
    const issue = makeIssue({ status: 'assigned', departmentId: 'DEPT_SWMC' });
    const r = canTransition(staff, issue, 'in_progress');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/another department/i);
  });

  it('allows that same staff to act on their own department\'s ticket', () => {
    const issue = makeIssue({ status: 'assigned', departmentId: 'DEPT_PWD' });
    expect(canTransition(staff, issue, 'in_progress').ok).toBe(true);
  });

  it('allows staff to start their own department\'s ticket', () => {
    const issue = makeIssue({ status: 'assigned', departmentId: 'DEPT_PWD' });
    expect(canTransition(staff, issue, 'in_progress').ok).toBe(true);
  });
});

describe('canTransition - proof of work', () => {
  it('refuses to resolve without proof', () => {
    const issue = makeIssue({ status: 'in_progress' });
    const r = canTransition(staff, issue, 'resolved');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/proof/i);
  });

  it('allows resolving once proof is present', () => {
    const issue = makeIssue({ status: 'in_progress', proof: proof() });
    expect(canTransition(staff, issue, 'resolved').ok).toBe(true);
  });
});

describe('canTransition - staff cannot jump states', () => {
  it('refuses resolving straight from assigned without starting work', () => {
    const issue = makeIssue({ status: 'assigned', proof: proof() });
    const r = canTransition(staff, issue, 'resolved');
    expect(r.ok).toBe(false);
  });

  it('refuses verifying or rejecting, which is not staff work', () => {
    for (const next of ['verified', 'rejected', 'merged'] as IssueStatus[]) {
      const issue = makeIssue({ status: 'assigned' });
      expect(canTransition(staff, issue, next).ok, `staff must not ${next}`).toBe(false);
    }
  });
});

describe('canTransition - admin separation of duties', () => {
  it('refuses to resolve directly', () => {
    const r = canTransition(admin, makeIssue({ status: 'in_progress' }), 'resolved');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/field staff/i);
  });

  it('refuses to start work in place of staff', () => {
    const r = canTransition(admin, makeIssue({ status: 'assigned' }), 'in_progress');
    expect(r.ok).toBe(false);
  });

  it('allows admin to verify and assign', () => {
    expect(canTransition(admin, makeIssue({ status: 'reported' }), 'verified').ok).toBe(true);
    expect(canTransition(admin, makeIssue({ status: 'verified' }), 'assigned').ok).toBe(true);
  });
});

describe('canTransition - graph integrity', () => {
  it('rejects a no-op transition', () => {
    const r = canTransition(admin, makeIssue({ status: 'verified' }), 'verified');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already/i);
  });

  it('treats merged as final', () => {
    for (const next of ['reported', 'in_review', 'verified', 'assigned', 'resolved'] as IssueStatus[]) {
      const r = canTransition(admin, makeIssue({ status: 'merged' }), next);
      expect(r.ok, `merged must not reopen to ${next}`).toBe(false);
    }
  });

  it('rejects a non-adjacent jump', () => {
    // reported -> resolved skips the whole field workflow.
    const r = canTransition(admin, makeIssue({ status: 'reported' }), 'resolved');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not allowed/i);
  });

  it('lets admin reopen a resolved issue', () => {
    expect(canTransition(admin, makeIssue({ status: 'resolved' }), 'in_review').ok).toBe(true);
  });
});

describe('slaDeadlineFor', () => {
  it('is the creation time plus the department SLA', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const deadline = slaDeadlineFor(48, now);
    expect(new Date(deadline).getTime() - now.getTime()).toBe(48 * 60 * 60 * 1000);
  });
});

describe('isSlaBreached and hoursOpen', () => {
  const now = new Date('2026-01-10T00:00:00.000Z');

  it('reports no breach while the deadline is still ahead', () => {
    // Created 2026-01-10T00:00 with a 48h SLA, so the deadline is 2026-01-12
    // and `now` (the same instant) is well inside it.
    const created = '2026-01-10T00:00:00.000Z';
    const issue = makeIssue({
      status: 'in_progress',
      createdAt: created,
      slaDeadlineAt: slaDeadlineFor(48, new Date(created)),
    });
    expect(isSlaBreached(issue, now)).toBe(false);
  });

  it('reports a breach once the deadline passes while still open', () => {
    const issue = makeIssue({
      status: 'in_progress',
      createdAt: '2026-01-01T00:00:00.000Z',
      slaDeadlineAt: slaDeadlineFor(48, new Date('2026-01-01T00:00:00.000Z')),
    });
    expect(isSlaBreached(issue, now)).toBe(true);
  });

  it('does not report a breach on a closed issue, however late', () => {
    const issue = makeIssue({
      status: 'resolved',
      createdAt: '2026-01-01T00:00:00.000Z',
      slaDeadlineAt: slaDeadlineFor(48, new Date('2026-01-01T00:00:00.000Z')),
    });
    expect(isSlaBreached(issue, now)).toBe(false);
  });

  it('treats every terminal status as not breached', () => {
    for (const status of ['resolved', 'merged', 'rejected'] as IssueStatus[]) {
      const issue = makeIssue({
        status,
        createdAt: '2026-01-01T00:00:00.000Z',
        slaDeadlineAt: '2026-01-02T00:00:00.000Z',
      });
      expect(isSlaBreached(issue, now), `${status} must not count as breached`).toBe(false);
    }
  });

  it('never reports a breach without a deadline', () => {
    expect(isSlaBreached(makeIssue({ status: 'in_progress' }), now)).toBe(false);
  });

  it('measures elapsed hours from creation', () => {
    const issue = makeIssue({ createdAt: '2026-01-08T12:00:00.000Z' });
    expect(hoursOpen(issue, now)).toBeCloseTo(36, 1);
  });

  it('never returns negative hours for a future creation time', () => {
    const issue = makeIssue({ createdAt: '2026-01-11T00:00:00.000Z' });
    expect(hoursOpen(issue, now)).toBe(0);
  });
});


