import { AuthUser, Issue, IssueStatus } from './types';

/**
 * Allowed state-machine transitions (RBAC-aware).
 * Generic adjacency first; role checks layered on top in `canTransition`.
 */
const ADJACENCY: Record<IssueStatus, IssueStatus[]> = {
  reported: ['in_review', 'verified', 'assigned', 'rejected', 'merged'],
  in_review: ['verified', 'assigned', 'rejected', 'merged'],
  verified: ['assigned', 'in_review', 'rejected', 'merged'],
  assigned: ['in_progress', 'verified', 'rejected', 'merged'],
  in_progress: ['resolved', 'in_review', 'assigned', 'rejected'],
  resolved: ['in_review', 'assigned'], // admin reopen
  rejected: ['in_review'],
  merged: [],
};

export type TransitionResult = { ok: boolean; reason?: string };

/**
 * Terminal statuses: the issue is closed and no longer counts as active civic
 * demand. Centralised because this set had drifted into three separate
 * hand-maintained copies (SLA checks, the citizen's "my reports" tab, and
 * spatial dedup) that had already diverged on whether `merged` is terminal.
 */
export const TERMINAL_STATUSES: readonly IssueStatus[] = ['resolved', 'merged', 'rejected'];

export function isTerminalStatus(status: IssueStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Assert a transition under the signed-in actor's role.
 *
 * - Citizen: never touches ticket state.
 * - Department staff: strictly isolated — only tickets routed to THEIR
 *   department, and only ASSIGNED -> IN_PROGRESS -> RESOLVED. RESOLVED
 *   additionally requires proof of work to have been uploaded first.
 * - City admin: verify / assign / reject / merge / reopen — but cannot
 *   resolve directly (separation of duties; resolution needs field proof)
 *   and cannot modify another actor's in-flight work without cause.
 */
export function canTransition(
  user: AuthUser,
  issue: Issue,
  next: IssueStatus
): TransitionResult {
  const from = issue.status;
  if (from === next) return { ok: false, reason: `Issue is already '${next}'.` };
  if (!ADJACENCY[from]?.includes(next)) {
    return { ok: false, reason: `Transition '${from}' → '${next}' is not allowed.` };
  }

  if (user.role === 'citizen') {
    return { ok: false, reason: 'Citizens cannot change ticket state.' };
  }

  if (user.role === 'department') {
    if (issue.departmentId && issue.departmentId !== user.departmentId) {
      return {
        ok: false,
        reason: 'Forbidden: this ticket belongs to another department.',
      };
    }
    // Staff may only start work on their assigned tickets, or mark them done.
    if (!['in_progress', 'resolved'].includes(next)) {
      return { ok: false, reason: 'Staff may only start or resolve their assigned tickets.' };
    }
    if (from !== 'assigned' && from !== 'in_progress') {
      return { ok: false, reason: 'Staff can only act on assigned tickets.' };
    }
    if (next === 'resolved' && !issue.proof) {
      return { ok: false, reason: 'Proof of work must be uploaded before resolving.' };
    }
  }

  if (user.role === 'city_admin') {
    if (next === 'resolved') {
      return {
        ok: false,
        reason: 'Resolution must be completed by field staff with proof of work.',
      };
    }
    if (next === 'in_progress') {
      return { ok: false, reason: 'Staff must start the work, not the admin.' };
    }
  }

  return { ok: true };
}

export function slaDeadlineFor(slaHours: number, now: Date = new Date()): string {
  return new Date(now.getTime() + slaHours * 3600_000).toISOString();
}

export function isSlaBreached(issue: Issue, now: Date = new Date()): boolean {
  if (!issue.slaDeadlineAt) return false;
    if (isTerminalStatus(issue.status)) {
      return false;
    }
  return new Date(issue.slaDeadlineAt).getTime() < now.getTime();
}

export function hoursOpen(issue: Issue, now: Date = new Date()): number {
  return Math.max(0, (now.getTime() - new Date(issue.createdAt).getTime()) / 3600_000);
}