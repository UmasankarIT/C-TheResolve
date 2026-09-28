import {
  AppNotification,
  AuditLogEntry,
  Category,
  Department,
  Issue,
  IssueReport,
  ProofOfWork,
} from './types';

export interface IssueStatusUpdate {
  status: Issue['status'];
  assignedWorkerName?: string;
  assignedDepartment?: string;
  departmentId?: string;
  resolutionNotes?: string;
  resolutionProofUrl?: string;
  jurisdictionCode?: string;
}

export interface ReassignRequest {
  byDepartment: string;
  reason: string;
  at: string;
}

/**
 * Persistence-agnostic store contract. Both the volatile in-memory store and
 * the Postgres-backed store implement this so every API route works
 * identically whether or not DATABASE_URL is configured.
 */
export interface CivicStore {
  getCategories(): Promise<Category[]>;
  getCategoryById(id: string): Promise<Category | undefined>;

  getIssues(): Promise<Issue[]>;
  getIssueById(id: string): Promise<Issue | undefined>;
  addIssue(issue: Issue): Promise<Issue>;
  addReport(report: IssueReport): Promise<IssueReport>;
  incrementIssueReport(issueId: string, report: IssueReport): Promise<Issue | null>;
  upvoteIssue(issueId: string): Promise<Issue | null>;
  hasUpvoted(userId: string, issueId: string): Promise<boolean>;
  recordUpvote(userId: string, issueId: string): Promise<boolean>;

  /**
   * Finds the nearest open issue of the same category within `thresholdMeters`,
   * for spatial deduplication of incoming reports. Implementations must treat
   * terminal statuses (resolved / merged / rejected) as non-matching.
   *
   * Postgres answers this with an indexed ST_DWithin query rather than loading
   * the whole table, so report submission stays cheap as the dataset grows.
   */
  findNearbyActiveIssue(
    latitude: number,
    longitude: number,
    categoryId: string,
    thresholdMeters?: number
  ): Promise<{ issue: Issue; distanceMeters: number } | null>;

  getDepartments(): Promise<Department[]>;
  getDepartmentById(id: string): Promise<Department | undefined>;
  upsertDepartment(dept: Department): Promise<Department>;

  getIssuesForCitizen(userId: string): Promise<Issue[]>;

  addProofOfWork(proof: ProofOfWork): Promise<Issue | null>;
  requestReassign(issueId: string, req: ReassignRequest): Promise<Issue | null>;
  mergeIssue(secondaryId: string, primaryId: string): Promise<boolean>;
  updateIssueStatus(issueId: string, params: IssueStatusUpdate): Promise<Issue | null>;

  pushNotification(n: AppNotification): Promise<void>;
  getNotificationsForUser(userId: string): Promise<AppNotification[]>;
  markNotificationsRead(userId: string): Promise<void>;

  addAuditLog(entry: AuditLogEntry): Promise<void>;
  getAuditLogs(limit?: number): Promise<AuditLogEntry[]>;

  /** All statements executed inside fn share one transaction when supported. */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
}