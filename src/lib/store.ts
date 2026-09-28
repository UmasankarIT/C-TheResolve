import {
  AppNotification,
  AuditLogEntry,
  Category,
  Department,
  Issue,
  IssueReport,
  ProofOfWork,
} from './types';
import { calculatePriorityScore } from './scoring';
import { findNearbyActiveIssue } from './spatial';
import { DEFAULT_DEPARTMENTS } from './departments';
import { INITIAL_CATEGORIES } from './categories';
import { buildSeedIssues } from './seedIssues';
import { CivicStore, IssueStatusUpdate, ReassignRequest } from './civicStore';
import { PostgresStore } from './postgresStore';

export { INITIAL_CATEGORIES } from './categories';

// Volatile in-memory store — used when DATABASE_URL is not configured.
// Behaviourally identical to the Postgres store; resets on restart by design.
class MemoryStore implements CivicStore {
  private categories: Category[] = [...INITIAL_CATEGORIES];
  private issues: Issue[] = [];
  private reports: IssueReport[] = [];
  private departments: Department[] = DEFAULT_DEPARTMENTS.map((d) => ({ ...d }));
  private notifications: AppNotification[] = [];
  private auditLogs: AuditLogEntry[] = [];
  private upvoteKeys = new Set<string>();
  private proofOfWork: ProofOfWork[] = [];

  constructor() {
    this.issues = buildSeedIssues();
  }

  async getCategories(): Promise<Category[]> {
    return this.categories;
  }

  async getCategoryById(id: string): Promise<Category | undefined> {
    return this.categories.find((c) => c.id === id || c.code === id);
  }

  async getIssues(): Promise<Issue[]> {
    return [...this.issues].sort((a, b) => b.priorityScore - a.priorityScore);
  }

  async getIssueById(id: string): Promise<Issue | undefined> {
    return this.issues.find((i) => i.id === id);
  }

  async addIssue(issue: Issue): Promise<Issue> {
    this.issues.unshift(issue);
    return issue;
  }

  async addReport(report: IssueReport): Promise<IssueReport> {
    this.reports.push(report);
    return report;
  }

  async incrementIssueReport(issueId: string, report: IssueReport): Promise<Issue | null> {
    const issue = this.getIssueByIdSync(issueId);
    if (!issue) return null;

    issue.reportCount += 1;
    issue.updatedAt = new Date().toISOString();

    if (!issue.reports) issue.reports = [];
    issue.reports.push(report);

    const breakdown = calculatePriorityScore({
      mlSeverity: issue.mlSeverityScore,
      reportCount: issue.reportCount,
      communityUpvotes: issue.communityUpvotes,
      createdAt: issue.createdAt,
    });
    issue.priorityScore = breakdown.totalScore;

    return issue;
  }

  async upvoteIssue(issueId: string): Promise<Issue | null> {
    const issue = this.getIssueByIdSync(issueId);
    if (!issue) return null;

    issue.communityUpvotes += 1;
    issue.updatedAt = new Date().toISOString();

    const breakdown = calculatePriorityScore({
      mlSeverity: issue.mlSeverityScore,
      reportCount: issue.reportCount,
      communityUpvotes: issue.communityUpvotes,
      createdAt: issue.createdAt,
    });
    issue.priorityScore = breakdown.totalScore;

    return issue;
  }

  // --- RBAC: upvote uniqueness (1 citizen = 1 upvote per report) ---
  async hasUpvoted(userId: string, issueId: string): Promise<boolean> {
    return this.upvoteKeys.has(`${userId}:${issueId}`);
  }

  async recordUpvote(userId: string, issueId: string): Promise<boolean> {
    const key = `${userId}:${issueId}`;
    if (this.upvoteKeys.has(key)) return false;
    this.upvoteKeys.add(key);
    return true;
  }

  // --- Departments (dynamic catalog; admin CRUD) ---
  async getDepartments(): Promise<Department[]> {
    return [...this.departments].sort((a, b) => a.name.localeCompare(b.name));
  }

  async getDepartmentById(id: string): Promise<Department | undefined> {
    const found = this.departments.find(
      (d) => d.id === id || d.code.toLowerCase() === String(id).toLowerCase()
    );
    if (found) return found;
    return DEFAULT_DEPARTMENTS.find((d) => d.id === id || d.code === id);
  }

  async upsertDepartment(dept: Department): Promise<Department> {
    const idx = this.departments.findIndex((d) => d.id === dept.id);
    if (idx >= 0) {
      this.departments[idx] = dept;
      return this.departments[idx];
    }
    this.departments.push(dept);
    return dept;
  }

  // --- Scoped queries (department isolation at the data layer) ---
  async getIssuesForCitizen(userId: string): Promise<Issue[]> {
    return (await this.getIssues()).filter((i) => i.citizenUserId === userId);
  }

  /**
   * In-memory counterpart of the Postgres ST_DWithin query. Correctness must
   * match the SQL path exactly (same terminal-status handling, same 25m default)
   * so switching stores cannot change deduplication behaviour.
   */
  async findNearbyActiveIssue(
    latitude: number,
    longitude: number,
    categoryId: string,
    thresholdMeters: number = 25
  ): Promise<{ issue: Issue; distanceMeters: number } | null> {
    return findNearbyActiveIssue(latitude, longitude, categoryId, await this.getIssues(), thresholdMeters);
  }

  // --- Proof of work ---
  async addProofOfWork(proof: ProofOfWork): Promise<Issue | null> {
    const issue = this.getIssueByIdSync(proof.issueId);
    if (!issue) return null;
    this.proofOfWork.push(proof);
    issue.proof = proof;
    issue.updatedAt = new Date().toISOString();
    return issue;
  }

  // --- Dispatch reassign requests ---
  async requestReassign(
    issueId: string,
    req: ReassignRequest
  ): Promise<Issue | null> {
    const issue = this.getIssueByIdSync(issueId);
    if (!issue) return null;
    issue.reassignRequest = req;
    issue.updatedAt = new Date().toISOString();
    return issue;
  }

  // --- Merger (MERGED_DUPLICATE) ---
  async mergeIssue(secondaryId: string, primaryId: string): Promise<boolean> {
    const secondary = this.getIssueByIdSync(secondaryId);
    const primary = this.getIssueByIdSync(primaryId);
    if (!secondary || !primary || secondaryId === primaryId) return false;
    secondary.status = 'merged';
    secondary.mergedIntoId = primaryId;
    secondary.updatedAt = new Date().toISOString();
    primary.reportCount += 1;
    primary.updatedAt = new Date().toISOString();
    return true;
  }

  async updateIssueStatus(
    issueId: string,
    params: IssueStatusUpdate
  ): Promise<Issue | null> {
    const issue = this.getIssueByIdSync(issueId);
    if (!issue) return null;

    issue.status = params.status;
    if (params.assignedWorkerName !== undefined) issue.assignedWorkerName = params.assignedWorkerName;
    if (params.assignedDepartment !== undefined) issue.assignedDepartment = params.assignedDepartment;
    if (params.departmentId !== undefined) issue.departmentId = params.departmentId;
    if (params.jurisdictionCode !== undefined) issue.jurisdictionCode = params.jurisdictionCode;
    if (params.resolutionNotes !== undefined) issue.resolutionNotes = params.resolutionNotes;
    if (params.resolutionProofUrl !== undefined) issue.resolutionProofUrl = params.resolutionProofUrl;

    if (params.status === 'verified' && !issue.verifiedAt) {
      issue.verifiedAt = new Date().toISOString();
    }

    if (params.status === 'assigned') {
      const dept = await this.getDepartmentById(issue.departmentId || '');
      const slaHours = dept?.slaHours ?? issue.category.defaultSlaHours ?? 72;
      issue.slaDeadlineAt = new Date(Date.now() + slaHours * 3600_000).toISOString();
    }

    if (params.status === 'resolved') {
      issue.resolvedAt = new Date().toISOString();
    }

    issue.updatedAt = new Date().toISOString();
    return issue;
  }

  // --- Notifications ---
  async pushNotification(n: AppNotification): Promise<void> {
    this.notifications.unshift(n);
    if (this.notifications.length > 100) this.notifications.pop();
  }

  async getNotificationsForUser(userId: string): Promise<AppNotification[]> {
    return this.notifications.filter((n) => n.userId === userId);
  }

  async markNotificationsRead(userId: string): Promise<void> {
    this.notifications.forEach((n) => {
      if (n.userId === userId) n.read = true;
    });
  }

  // --- Audit log (append-only) ---
  async addAuditLog(entry: AuditLogEntry): Promise<void> {
    this.auditLogs.unshift(entry);
    if (this.auditLogs.length > 200) this.auditLogs.pop();
  }

  async getAuditLogs(limit = 50): Promise<AuditLogEntry[]> {
    return this.auditLogs.slice(0, limit);
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }

  private getIssueByIdSync(id: string): Issue | undefined {
    return this.issues.find((i) => i.id === id);
  }
}

// ---------------------------------------------------------------------------
// Store factory — Postgres when DATABASE_URL is configured, in-memory fallback
// when it isn't. Kept on globalThis so hot-reloads reuse the same pool/state.
// ---------------------------------------------------------------------------
function createStore(): CivicStore {
  if (process.env.DATABASE_URL) {
    return new PostgresStore();
  }
  return new MemoryStore();
}

const globalForStore = globalThis as unknown as { civicStore: CivicStore };
export const civicStore: CivicStore = globalForStore.civicStore || createStore();
if (process.env.NODE_ENV !== 'production') globalForStore.civicStore = civicStore;