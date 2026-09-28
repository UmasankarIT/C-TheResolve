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

export interface GeocodeResponse {
  results: GeocodeHit[];
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
