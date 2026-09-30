export type UserRole = 'citizen' | 'department' | 'city_admin';

// Ticket lifecycle: SUBMITTED -> PENDING_TRIAGE | ASSIGNED_TO_DEPT -> IN_PROGRESS
// -> RESOLVED (requires proof of work) | REJECTED | MERGED_DUPLICATE
export type IssueStatus = 
  | 'reported'      // SUBMITTED — citizen submitted, public, awaiting triage
  | 'in_review'     // PENDING_TRIAGE — under admin review
  | 'verified'      // verified by city admin — ready for assignment
  | 'assigned'      // ASSIGNED_TO_DEPT — dispatched to a department + worker
  | 'in_progress'   // field staff started the work
  | 'resolved'      // RESOLVED by staff ONLY after proof of work is uploaded
  | 'rejected'      // admin rejected / spam
  | 'merged';       // duplicate merged into another issue (MERGED_DUPLICATE)

export interface AuthUser {
  userId: string;
  role: UserRole;
  name: string;
  phone?: string;
  email?: string;
  departmentId?: string;      // department scoping for staff (e.g. 'DEPT_WATER')
  jurisdictionCode?: string;  // ward/block scope
}

export interface Department {
  id: string;             // e.g. 'DEPT_WATER'
  code: string;           // display code
  name: string;
  nodalOfficer: string;
  slaHours: number;
  disabled: boolean;
  categoryCodes: string[]; // categories that route here
}

export interface AppNotification {
  id: string;
  userId: string;
  issueId?: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

export interface ProofOfWork {
  id: string;
  issueId: string;
  departmentId: string;
  submittedBy: string;   // staff display name
  photoUrl: string;      // after-photo (data URL)
  latitude?: number;
  longitude?: number;
  notes: string;
  submittedAt: string;
}

export interface AuditLogEntry {
  id: string;
  actorId: string;
  actorName: string;
  role: UserRole;
  action: string;   // 'reports.submit' | 'reports.verify' | 'reports.assign' ...
  issueId?: string;
  detail: string;
  createdAt: string;
}

export interface Category {
  id: string;
  code: string;
  name: string;
  description: string;
  baseSeverityWeight: number;
  defaultSlaHours: number;
  responsibleDepartment: string;
  iconName: string;
}

export interface MLAnalysis {
  predictedCategory: string;
  categoryConfidence: number;
  estimatedSeverity: number; // 1.0 to 5.0
  isCivicIssue: boolean;
  detectedHazards: string[];
  inferenceLatencyMs: number;
}

export interface ExifMetadata {
  capturedAt?: string;
  hasGps: boolean;
  exifLatitude?: number;
  exifLongitude?: number;
  deltaMeters?: number; // Distance between EXIF GPS and user reported GPS
  isSpoofed?: boolean;
  deviceMake?: string;
  deviceModel?: string;
}

export interface LocationFix {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
}

export interface GeocodeHit {
  lat: number;
  lon: number;
  label: string;
  sublabel?: string;
}

export interface LocationDetails {
  state?: string;
  district?: string;
  mandal?: string;
  pincode?: string;
}

export interface IssueReport {
  id: string;
  issueId: string;
  reporterId?: string;
  reporterName?: string;
  citizenUserId?: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  isOnSite: boolean;
  imageUrl: string;
  citizenNotes?: string;
  transcript?: string;
  exif?: ExifMetadata;
  locationDetails?: LocationDetails;
  createdAt: string;
}

export interface Issue {
  id: string;
  categoryId: string;
  category: Category;
  title: string;
  description: string;
  latitude: number;
  longitude: number;
  formattedAddress: string;
  wardId?: string;
  locationDetails?: LocationDetails;
  status: IssueStatus;
  assignedWorkerName?: string;
  assignedDepartment?: string;
    departmentId?: string;         // routing target (DEPT_*)
    jurisdictionCode?: string;     // ward/block scope
    state?: string;                // administrative state, promoted out of locationDetails for querying
  intent?: ReportIntent;          // complaint (default) vs development_request
  citizenUserId?: string;        // who reported it (for "My Reports")
  citizenName?: string;
  slaDeadlineAt?: string;        // SLA timer set on assignment
  verifiedAt?: string;
  mergedIntoId?: string;
  reassignRequest?: { byDepartment: string; reason: string; at: string };
  transcript?: string;           // transcription of the voice note (the recording itself is never stored)
  proof?: ProofOfWork;           // field staff proof of work
  reportCount: number;
  communityUpvotes: number;
  mlSeverityScore: number;
  priorityScore: number;
  imageUrl: string;
  resolutionNotes?: string;
  resolutionProofUrl?: string;
  resolvedAt?: string;
  createdAt: string;
  updatedAt: string;
  reports?: IssueReport[];
  mlAnalysis?: MLAnalysis;
}

export interface CreateReportRequest {
  categoryId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  isOnSite: boolean;
  imageUrl: string;
  /** Defaults to `complaint`. Development requests allow submitting without a photo. */
  intent?: ReportIntent;
  title?: string;
  citizenNotes?: string;
  transcript?: string;
  exif?: ExifMetadata;
  locationDetails?: LocationDetails;
}

export interface SubmissionResponse {
  issueId: string;
  isDuplicate: boolean;
  reportCount: number;
  status: IssueStatus;
  priorityScore: number;
  mlAnalysis: MLAnalysis;
  message: string;
}

/**
 * Finest-to-coarsest administrative granularity a complaint's location
 * resolved to. The clustering stage buckets on the finest level that is
 * actually known, so a report with a ward never merges with one that only
 * knows its district.
 */
export type LocationGranularity = 'ward' | 'district' | 'state' | 'unknown';

/** Which subsystem produced a field: Gemini, or the deterministic fallback. */
export type PipelineEngine = 'gemini' | 'heuristic' | 'unavailable';

/**
 * What a report is asking for. A `complaint` describes a problem that exists
 * today; a `development_request` asks for infrastructure that does not exist
 * yet (a new bus stop, a water pipeline extension). The pipeline buckets,
 * scores and lists the two separately — a complaint must never merge into a
 * development request or vice versa. Optional on every shape so rows written
 * before this existed read back as `complaint`, which is what they were.
 */
export type ReportIntent = 'complaint' | 'development_request';

/**
 * One citizen's account of a civic problem, with the structured fields the
 * demand-signal pipeline buckets on. Distinct from `Issue`: an issue is an
 * aggregated incident at a physical point, a complaint is a single account.
 */
export interface Complaint {
  id: string;
  sourceIssueId?: string;
  sourceReportId?: string;
  /** What kind of problem this is. Stage 1 never merges across two of these. */
  issueType: string;
  /** Complaint or development request. Stage 1 never merges across intents. */
  intent?: ReportIntent;
  locationState?: string;
  locationDistrict?: string;
  locationWard?: string;
  /** Human-readable bucket label, e.g. "Visakhapatnam, Andhra Pradesh — Ward 12". */
  location: string;
  locationGranularity: LocationGranularity;
  urgencyScore: number;
  urgencyReason?: string;
  originalLanguage: string;
  originalText: string;
  /** Faithful English rendering. This is what gets embedded. */
  translatedText: string;
  /** pgvector column, held in memory as a plain number array. */
  embedding?: number[];
  embeddingModel?: string;
  embeddingDimensions?: number;
  extractionEngine: PipelineEngine;
  createdAt?: string;
  updatedAt?: string;
}

/** The clustered output: many complaints describing one underlying problem. */
export interface DemandSignal {
  clusterId: string;
  issueType: string;
  /** All members share it (Stage 1 buckets per intent); `complaint` when unset. */
  intent?: ReportIntent;
  location: string;
  locationState?: string;
  locationDistrict?: string;
  locationWard?: string;
  memberComplaintIds: string[];
  volume: number;
  avgUrgency: number;
  summary: string;
  languagesRepresented: string[];
  similarityThreshold: number;
  verificationEngine: PipelineEngine;
  /**
   * Step 4 data fusion. Population and infrastructure gap for the signal's
   * district, joined from the district reference table. These default to null
   * (never undefined) once a signal passes through the fusion step: a missing
   * value is a fact about the open data, not an optional geo field, and the
   * Step 5 scorer must be able to tell "no data" apart from "data is zero".
   */
  populationAffected?: number | null;
  existingInfrastructureGap?: number | null;
  dataFusionSource?: string | null;
  /**
   * Step 5 priority scoring. Computed by `scoreDemandSignals` over the full
   * set of clusters and attached at serialisation time; absent on signals that
   * have not been scored. The effective weights after dropping missing
   * components are recorded in `priorityBreakdown` so the score can always be
   * re-derived by hand from the numbers on the row.
   */
  priorityScore?: number;
  priorityExplanation?: string;
  priorityBreakdown?: PriorityBreakdown;
  dataUnavailable?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** The effective weight applied to each component of the Step 5 formula. */
export interface PriorityWeights {
  /** 0 when the volume term had to be dropped (never in practice). */
  volume: number;
  /** 0 when the urgency term had to be dropped (never in practice). */
  avgUrgency: number;
  /** 0 when this district has no infrastructure gap data. */
  infrastructureGap: number;
  /** 0 when this district has no population data. */
  populationAffected: number;
}

/**
 * The component values that produced `priorityScore`, so the score is
 * re-computable by hand and missing components are visible as explicit nulls
 * rather than silent zeros.
 */
export interface PriorityBreakdown {
  /** Min-max scaled across the current cluster set (0-1). */
  normalizedVolume: number;
  /** Urgency 1-5 mapped to 0-1 via (x - 1) / 4. */
  normalizedAvgUrgency: number;
  /** Gap percentage (0-100) mapped to 0-1; null when the district has no data. */
  infrastructureGapScore: number | null;
  /** Min-max scaled across the current cluster set (0-1); null when no data. */
  normalizedPopulationAffected: number | null;
  /** The weights actually used, renormalised to sum to 1 over present terms. */
  weights: PriorityWeights;
}

/** Per-complaint verdict from the stage 4 verification pass. */
export interface ClusterVerdict {
  sameIssue: boolean;
  summary: string;
  engine: PipelineEngine;
}
