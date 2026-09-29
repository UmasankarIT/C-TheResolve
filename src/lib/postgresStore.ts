import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { CivicStore, IssueStatusUpdate, ReassignRequest } from './civicStore';
import { INITIAL_CATEGORIES } from './categories';
import { DEFAULT_DEPARTMENTS } from './departments';
import { getPool, query } from './db';
import { calculatePriorityScore } from './scoring';
import { buildSeedIssues, SEED_CITIES } from './seedIssues';
import { districtStatistics, withDistrictStatistics } from './districtReference';
import {
  AppNotification,
  AuditLogEntry,
  Category,
  Complaint,
  DemandSignal,
  Department,
  Issue,
  IssueReport,
  LocationGranularity,
  PipelineEngine,
  ProofOfWork,
} from './types';

// ---------------------------------------------------------------------------
// Row shapes returned by the issues JOIN query (double-quoted aliases).
// NUMERIC columns come back from pg as strings, timestamps as Date.
// ---------------------------------------------------------------------------
interface IssueRow {
  id: string;
  categoryId: string;
  title: string;
  description: string | null;
  lat: number;
  lon: number;
  formattedAddress: string | null;
  wardId: string | null;
  locationDetails: Record<string, string> | null;
  status: Issue['status'];
  assignedWorkerName: string | null;
  assignedDepartment: string | null;
  departmentId: string | null;
  jurisdictionCode: string | null;
  state: string | null;
  citizenUserId: string | null;
  citizenName: string | null;
  slaDeadlineAt: Date | null;
  verifiedAt: Date | null;
  mergedIntoId: string | null;
  transcript: string | null;
  reportCount: number;
  upvotesCount: number;
  mlSeverityScore: string;
  priorityScore: string;
  imageUrl: string;
  mlAnalysis: Issue['mlAnalysis'] | null;
  reassignRequest: ReassignRequest | null;
  proof: ProofOfWork | null;
  resolutionNotes: string | null;
  resolutionProofUrl: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  cId: string;
  cCode: string;
  cName: string;
  cDescription: string;
  cBaseSeverityWeight: string;
  cDefaultSlaHours: number;
  cResponsibleDepartment: string;
  cIconName: string;
}

interface ReportRow {
  id: string;
  issueId: string;
  reporterId: string | null;
  citizenUserId: string | null;
  lat: number;
  lon: number;
  accuracyMeters: number;
  isOnSite: boolean;
  imageUrl: string;
  citizenNotes: string | null;
  transcript: string | null;
  exif: IssueReport['exif'] | null;
  locationDetails: IssueReport['locationDetails'] | null;
  createdAt: Date;
}

const ISSUE_SELECT = `
  SELECT
    i.id,
    i.category_id AS "categoryId",
    i.title,
    i.description,
    ST_Y(i.location::geometry) AS lat,
    ST_X(i.location::geometry) AS lon,
    i.formatted_address AS "formattedAddress",
    i.ward_id AS "wardId",
    i.location_details AS "locationDetails",
    i.status,
    i.assigned_worker_name AS "assignedWorkerName",
    i.assigned_department AS "assignedDepartment",
    i.department_id AS "departmentId",
    i.jurisdiction_code AS "jurisdictionCode",
    i.state,
    i.citizen_user_id AS "citizenUserId",
    i.citizen_name AS "citizenName",
    i.sla_deadline_at AS "slaDeadlineAt",
    i.verified_at AS "verifiedAt",
    i.merged_into_id AS "mergedIntoId",
    i.transcript,
    i.report_count AS "reportCount",
    i.upvotes_count AS "upvotesCount",
    i.ml_severity_score AS "mlSeverityScore",
    i.priority_score AS "priorityScore",
    i.image_url AS "imageUrl",
    i.ml_analysis AS "mlAnalysis",
    i.reassign_request AS "reassignRequest",
    i.proof,
    i.resolution_notes AS "resolutionNotes",
    i.resolution_proof_url AS "resolutionProofUrl",
    i.resolved_at AS "resolvedAt",
    i.created_at AS "createdAt",
    i.updated_at AS "updatedAt",
    c.id AS "cId",
    c.code AS "cCode",
    c.name AS "cName",
    c.description AS "cDescription",
    c.base_severity_weight AS "cBaseSeverityWeight",
    c.default_sla_hours AS "cDefaultSlaHours",
    c.responsible_department AS "cResponsibleDepartment",
    c.icon_name AS "cIconName"
  FROM issues i
  JOIN categories c ON c.id = i.category_id
`;

const REPORT_SELECT = `
  SELECT
    id,
    issue_id AS "issueId",
    reporter_id AS "reporterId",
    citizen_user_id AS "citizenUserId",
    ST_Y(client_location::geometry) AS lat,
    ST_X(client_location::geometry) AS lon,
    accuracy_meters AS "accuracyMeters",
    is_on_site AS "isOnSite",
    image_url AS "imageUrl",
    citizen_notes AS "citizenNotes",
    transcript,
    exif,
    location_details AS "locationDetails",
    created_at AS "createdAt"
  FROM issue_reports
`;

function iso(d: Date | null): string | undefined {
  return d ? d.toISOString() : undefined;
}

function toCategory(r: IssueRow): Category {
  return {
    id: r.cId,
    code: r.cCode,
    name: r.cName,
    description: r.cDescription ?? '',
    baseSeverityWeight: Number(r.cBaseSeverityWeight),
    defaultSlaHours: r.cDefaultSlaHours,
    responsibleDepartment: r.cResponsibleDepartment,
    iconName: r.cIconName,
  };
}

function toIssue(r: IssueRow): Issue {
  return {
    id: r.id,
    categoryId: r.categoryId,
    category: toCategory(r),
    title: r.title,
    description: r.description ?? '',
    latitude: Number(r.lat),
    longitude: Number(r.lon),
    formattedAddress: r.formattedAddress ?? '',
    wardId: r.wardId ?? undefined,
    locationDetails: r.locationDetails ?? undefined,
    status: r.status,
    assignedWorkerName: r.assignedWorkerName ?? undefined,
    assignedDepartment: r.assignedDepartment ?? undefined,
    departmentId: r.departmentId ?? undefined,
      jurisdictionCode: r.jurisdictionCode ?? undefined,
      state: r.state ?? undefined,
    citizenUserId: r.citizenUserId ?? undefined,
    citizenName: r.citizenName ?? undefined,
    slaDeadlineAt: iso(r.slaDeadlineAt),
    verifiedAt: iso(r.verifiedAt),
    mergedIntoId: r.mergedIntoId ?? undefined,
    reassignRequest: r.reassignRequest ?? undefined,
    transcript: r.transcript ?? undefined,
    proof: r.proof ?? undefined,
    reportCount: Number(r.reportCount),
    communityUpvotes: Number(r.upvotesCount),
    mlSeverityScore: Number(r.mlSeverityScore),
    priorityScore: Number(r.priorityScore),
    imageUrl: r.imageUrl,
    resolutionNotes: r.resolutionNotes ?? undefined,
    resolutionProofUrl: r.resolutionProofUrl ?? undefined,
    resolvedAt: iso(r.resolvedAt),
    createdAt: iso(r.createdAt)!,
    updatedAt: iso(r.updatedAt)!,
    mlAnalysis: r.mlAnalysis ?? undefined,
  };
}

function toReport(r: ReportRow): IssueReport {
  return {
    id: r.id,
    issueId: r.issueId,
    reporterId: r.reporterId ?? undefined,
    citizenUserId: r.citizenUserId ?? undefined,
    latitude: Number(r.lat),
    longitude: Number(r.lon),
    accuracyMeters: Number(r.accuracyMeters),
    isOnSite: r.isOnSite,
    imageUrl: r.imageUrl,
    citizenNotes: r.citizenNotes ?? undefined,
    transcript: r.transcript ?? undefined,
    exif: r.exif ?? undefined,
    locationDetails: r.locationDetails ?? undefined,
    createdAt: iso(r.createdAt)!,
  };
}

function toDepartment(r: Record<string, unknown>): Department {
  return {
    id: r.id as string,
    code: r.code as string,
    name: r.name as string,
    nodalOfficer: (r.nodalOfficer as string) ?? 'Nodal Officer',
    slaHours: Number(r.slaHours ?? 72),
    disabled: Boolean(r.disabled),
    categoryCodes: (r.categoryCodes as string[]) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Complaints and demand signals.
//
// pgvector has no node-pg type parser, so a `vector` column arrives as its
// text form ('[0.1,0.2]') and is parsed here. It is cast to text in SQL rather
// than left to pg so the parse is explicit and a malformed value is visible
// instead of surfacing as an opaque driver error.
// ---------------------------------------------------------------------------

interface ComplaintRow {
  id: string;
  sourceIssueId: string | null;
  sourceReportId: string | null;
  issueType: string;
  locationState: string | null;
  locationDistrict: string | null;
  locationWard: string | null;
  location: string;
  locationGranularity: string;
  urgencyScore: string;
  urgencyReason: string | null;
  originalLanguage: string;
  originalText: string;
  translatedText: string;
  embedding: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  extractionEngine: string;
  createdAt: Date;
}

interface DemandSignalRow {
  clusterId: string;
  issueType: string;
  location: string;
  locationState: string | null;
  locationDistrict: string | null;
  locationWard: string | null;
  memberComplaintIds: string[];
  volume: number;
  avgUrgency: string;
  summary: string;
  languagesRepresented: string[];
  similarityThreshold: string;
  verificationEngine: string;
  populationAffected: string | null;
  existingInfrastructureGap: string | null;
  dataFusionSource: string | null;
  createdAt: Date;
}

function parseVector(raw: string | null | undefined): number[] | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined;
  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];
  const values = body.split(',').map((x) => Number(x.trim()));
  return values.every((v) => Number.isFinite(v)) ? values : undefined;
}

function toComplaint(r: ComplaintRow): Complaint {
  return {
    id: r.id,
    sourceIssueId: r.sourceIssueId ?? undefined,
    sourceReportId: r.sourceReportId ?? undefined,
    issueType: r.issueType,
    locationState: r.locationState ?? undefined,
    locationDistrict: r.locationDistrict ?? undefined,
    locationWard: r.locationWard ?? undefined,
    location: r.location,
    locationGranularity: r.locationGranularity as LocationGranularity,
    urgencyScore: Number(r.urgencyScore),
    urgencyReason: r.urgencyReason ?? undefined,
    originalLanguage: r.originalLanguage,
    originalText: r.originalText,
    translatedText: r.translatedText,
    embedding: parseVector(r.embedding),
    embeddingModel: r.embeddingModel ?? undefined,
    embeddingDimensions: r.embeddingDimensions ?? undefined,
    extractionEngine: r.extractionEngine as PipelineEngine,
    createdAt: r.createdAt.toISOString(),
  };
}

function toDemandSignal(r: DemandSignalRow): DemandSignal {
  return {
    clusterId: r.clusterId,
    issueType: r.issueType,
    location: r.location,
    locationState: r.locationState ?? undefined,
    locationDistrict: r.locationDistrict ?? undefined,
    locationWard: r.locationWard ?? undefined,
    memberComplaintIds: r.memberComplaintIds ?? [],
    volume: Number(r.volume),
    avgUrgency: Number(r.avgUrgency),
    summary: r.summary,
    languagesRepresented: r.languagesRepresented ?? [],
    similarityThreshold: Number(r.similarityThreshold),
    verificationEngine: r.verificationEngine as PipelineEngine,
    populationAffected: r.populationAffected == null ? null : Number(r.populationAffected),
    existingInfrastructureGap:
      r.existingInfrastructureGap == null ? null : Number(r.existingInfrastructureGap),
    dataFusionSource: r.dataFusionSource ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------

export class PostgresStore implements CivicStore {
  private readyPromise: Promise<void> | null = null;
  private txClient: PoolClient | null = null;

  private ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this._init().catch((err) => {
        this.readyPromise = null; // allow retry on next request instead of bricking the store
        throw err;
      });
    }
    return this.readyPromise;
  }

  private async q<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    if (this.txClient) return this.txClient.query<T>(text, params);
    return query<T>(text, params);
  }

  private async _init(): Promise<void> {
    // Apply each migration in filename order exactly once. Previously every file
    // was re-run on every boot, which only worked because each one happened to
    // be idempotent. Applied filenames are recorded in schema_migrations so a
    // non-idempotent statement (ALTER TABLE ADD COLUMN without IF NOT EXISTS,
    // a backfill, an UPDATE) can never silently run twice.
    const migrationsDir = join(process.cwd(), 'database', 'migrations');
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const pool = getPool();
    const client = await pool.connect();
    let applied = 0;
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      const done = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
      const appliedNames = new Set(done.rows.map((r) => r.name));

      for (const file of files) {
        if (appliedNames.has(file)) continue;
        const sql = readFileSync(join(migrationsDir, file), 'utf8');
        // One transaction per file: a failure part-way through leaves the file
        // unrecorded and rolls back, so the next boot retries it cleanly.
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
          applied++;
          console.log(`[store] applied migration ${file}`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      client.release();
    }

    await this._seed();
    await this._seedIssues();
    console.log(
      `[store] Postgres + PostGIS ready (${applied} migration(s) applied, ${files.length} total, seeded)`
    );
  }

  private async _seedIssues(): Promise<void> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT COUNT(*)::int AS n FROM issues');
      if (existing.rows[0].n > 0) {
        // The demo dataset is disposable: refresh it when the table contains
        // nothing but seeds, so pilot geography changes show up without a
        // manual volume reset. Real citizen issues (iss-*) are never touched.
        const seedOnly = await client.query(
          `SELECT COUNT(*)::int AS n FROM issues WHERE id NOT LIKE 'seed-%'`
        );
        if (seedOnly.rows[0].n > 0) {
          await client.query('COMMIT');
          return;
        }
        await client.query('DELETE FROM issues');
        console.log('[store] Refreshed demo seed dataset (no citizen-authored issues present)');
      }
      const seeds = buildSeedIssues();
      for (const issue of seeds) {
        await client.query(
          `INSERT INTO issues
             (id, category_id, title, description, location, formatted_address, ward_id,
              location_details, status, assigned_worker_name, assigned_department,
              department_id, jurisdiction_code, state, citizen_user_id, citizen_name,
              sla_deadline_at, verified_at, merged_into_id, transcript,
              report_count, upvotes_count, ml_severity_score, priority_score, image_url,
              ml_analysis, reassign_request, proof, resolution_notes, resolution_proof_url,
              resolved_at, created_at, updated_at)
           VALUES
              ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7, $8,
               $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
               $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34)`,
          [
            issue.id,
            issue.categoryId,
            issue.title,
            issue.description ?? null,
            issue.longitude,
            issue.latitude,
            issue.formattedAddress ?? null,
            issue.wardId ?? null,
            issue.locationDetails ?? null,
            issue.status,
            issue.assignedWorkerName ?? null,
            issue.assignedDepartment ?? null,
            issue.departmentId ?? null,
            issue.jurisdictionCode ?? null,
            issue.state ?? null,
            issue.citizenUserId ?? null,
            issue.citizenName ?? null,
            issue.slaDeadlineAt ?? null,
            issue.verifiedAt ?? null,
            issue.mergedIntoId ?? null,
            issue.transcript ?? null,
            issue.reportCount,
            issue.communityUpvotes,
            issue.mlSeverityScore,
            issue.priorityScore,
            issue.imageUrl,
            issue.mlAnalysis ?? null,
            issue.reassignRequest ?? null,
            issue.proof ?? null,
            issue.resolutionNotes ?? null,
            issue.resolutionProofUrl ?? null,
            issue.resolvedAt ?? null,
            issue.createdAt,
            issue.updatedAt,
          ]
        );
      }
      await client.query('COMMIT');
      // Count the states actually present rather than naming SEED_CITIES[0]'s
      // state, which read as "24 Andhra Pradesh districts" once other states
      // were added and was quietly wrong.
      const seededStates = new Set(SEED_CITIES.map((c) => c.state));
      const seededDistricts = new Set(SEED_CITIES.map((c) => `${c.state}|${c.district}`));
      console.log(
        `[store] Seeded ${seeds.length} sample grievances across ${seededDistricts.size} districts in ${seededStates.size} states ` +
          `(${Array.from(seededStates).join(', ')})`
      );
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure — original error is what matters
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async _seed(): Promise<void> {
    for (let i = 0; i < INITIAL_CATEGORIES.length; i++) {
      const cat = INITIAL_CATEGORIES[i];
      await this.q(
        `INSERT INTO categories
           (id, code, name, description, base_severity_weight, default_sla_hours, responsible_department, icon_name, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           code = EXCLUDED.code,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           base_severity_weight = EXCLUDED.base_severity_weight,
           default_sla_hours = EXCLUDED.default_sla_hours,
           responsible_department = EXCLUDED.responsible_department,
           icon_name = EXCLUDED.icon_name,
           sort_order = EXCLUDED.sort_order`,
        [
          cat.id,
          cat.code,
          cat.name,
          cat.description,
          cat.baseSeverityWeight,
          cat.defaultSlaHours,
          cat.responsibleDepartment,
          cat.iconName,
          i,
        ]
      );
    }

for (const dept of DEFAULT_DEPARTMENTS) {
      await this.q(
        `INSERT INTO departments
           (id, code, name, nodal_officer, sla_hours, disabled, category_codes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           code = EXCLUDED.code,
           name = EXCLUDED.name,
           nodal_officer = EXCLUDED.nodal_officer,
           sla_hours = EXCLUDED.sla_hours,
           disabled = EXCLUDED.disabled,
           category_codes = EXCLUDED.category_codes,
           updated_at = CURRENT_TIMESTAMP`,
        [dept.id, dept.code, dept.name, dept.nodalOfficer, dept.slaHours, dept.disabled, dept.categoryCodes]
      );
    }

    // Step 4 reference data: upload the district table from its single source
    // of truth (database/data/district_reference.csv) so it is queryable here,
    // alongside the Postgres schema, and so an edit to the CSV shows up on the
    // next boot. Rows are keyed on (state, district) — the same granularity the
    // pipeline buckets on — which is what makes the fusion join a plain lookup.
    const statistics = districtStatistics();
    if (statistics.length > 0) {
      const columns = 10;
      const values: unknown[] = [];
      const tuples = statistics.map((s, row) => {
        const base = row * columns;
        values.push(
          s.state,
          s.district,
          s.censusDistrict ?? null,
          s.population,
          s.infrastructureGap,
          s.populationSource,
          s.populationSourceUrl,
          s.infrastructureGapSource ?? null,
          s.infrastructureGapSourceUrl ?? null,
          s.note ?? null
        );
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`;
      });
      await this.q(
        `INSERT INTO location_statistics
           (state, district, census_district, population, infrastructure_gap,
            population_source, population_source_url, infrastructure_gap_source,
            infrastructure_gap_source_url, note)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (state, district) DO UPDATE SET
           census_district = EXCLUDED.census_district,
           population = EXCLUDED.population,
           infrastructure_gap = EXCLUDED.infrastructure_gap,
           population_source = EXCLUDED.population_source,
           population_source_url = EXCLUDED.population_source_url,
           infrastructure_gap_source = EXCLUDED.infrastructure_gap_source,
           infrastructure_gap_source_url = EXCLUDED.infrastructure_gap_source_url,
           note = EXCLUDED.note`,
        values
      );
    }
  }

  // --- Categories ----------------------------------------------------------

  async getCategories(): Promise<Category[]> {
    await this.ensureReady();
    const { rows } = await this.q(
      `SELECT id, code, name, description,
              base_severity_weight AS "baseSeverityWeight",
              default_sla_hours AS "defaultSlaHours",
              responsible_department AS "responsibleDepartment",
              icon_name AS "iconName"
       FROM categories
       ORDER BY sort_order ASC, id ASC`
    );
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description ?? '',
      baseSeverityWeight: Number(r.baseSeverityWeight),
      defaultSlaHours: Number(r.defaultSlaHours),
      responsibleDepartment: r.responsibleDepartment ?? '',
      iconName: r.iconName,
    }));
  }

  async getCategoryById(id: string): Promise<Category | undefined> {
    await this.ensureReady();
    const { rows } = await this.q(
      `SELECT id, code, name, description,
              base_severity_weight AS "baseSeverityWeight",
              default_sla_hours AS "defaultSlaHours",
              responsible_department AS "responsibleDepartment",
              icon_name AS "iconName"
       FROM categories
       WHERE id = $1 OR code = $1
       LIMIT 1`,
      [id]
    );
    if (!rows[0]) return undefined;
    return {
      id: rows[0].id,
      code: rows[0].code,
      name: rows[0].name,
      description: rows[0].description ?? '',
      baseSeverityWeight: Number(rows[0].baseSeverityWeight),
      defaultSlaHours: Number(rows[0].defaultSlaHours),
      responsibleDepartment: rows[0].responsibleDepartment ?? '',
      iconName: rows[0].iconName,
    };
  }

  // --- Issues --------------------------------------------------------------

  private async attachReports(issues: Issue[]): Promise<Issue[]> {
    if (issues.length === 0) return issues;
    const ids = issues.map((i) => i.id);
    const { rows } = await this.q<ReportRow>(
      `${REPORT_SELECT} WHERE issue_id = ANY($1::text[]) ORDER BY created_at ASC`,
      [ids]
    );
    const byIssue = new Map<string, IssueReport[]>();
    for (const row of rows) {
      const list = byIssue.get(row.issueId) ?? [];
      list.push(toReport(row));
      byIssue.set(row.issueId, list);
    }
    for (const issue of issues) {
      const list = byIssue.get(issue.id);
      if (list && list.length > 0) issue.reports = list;
    }
    return issues;
  }

  async getIssues(): Promise<Issue[]> {
    await this.ensureReady();
    const { rows } = await this.q<IssueRow>(`${ISSUE_SELECT} ORDER BY i.priority_score DESC`);
    const issues = rows.map(toIssue);
    return this.attachReports(issues);
  }

  async getIssueById(id: string): Promise<Issue | undefined> {
    await this.ensureReady();
    const { rows } = await this.q<IssueRow>(`${ISSUE_SELECT} WHERE i.id = $1 LIMIT 1`, [id]);
    if (!rows[0]) return undefined;
    const issues = await this.attachReports([toIssue(rows[0])]);
    return issues[0];
  }

  /**
   * Spatial dedup via the GiST index on issues.location.
   *
   * ST_DWithin against a geography column is index-accelerated, so this touches
   * only the handful of candidate rows near the report instead of loading the
   * whole table the way the previous getIssues()-then-loop-in-JS path did.
   * Terminal statuses are excluded so a new report never aggregates into a
   * resolved, merged or rejected issue.
   */
  async findNearbyActiveIssue(
    latitude: number,
    longitude: number,
    categoryId: string,
    thresholdMeters: number = 25
  ): Promise<{ issue: Issue; distanceMeters: number } | null> {
    await this.ensureReady();
    const { rows } = await this.q<IssueRow & { distance_meters: number }>(
      `SELECT *, ST_Distance(i.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)
              AS distance_meters
         FROM issues i
         JOIN categories c ON c.id = i.category_id
        WHERE i.category_id = $3
          AND i.status NOT IN ('resolved', 'merged', 'rejected')
          AND ST_DWithin(
                i.location,
                ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                $4
              )
        ORDER BY distance_meters ASC
        LIMIT 1`,
      [longitude, latitude, categoryId, thresholdMeters]
    );
    if (!rows[0]) return null;
    const [issue] = await this.attachReports([toIssue(rows[0])]);
    const distance = Number(rows[0].distance_meters);
    return { issue, distanceMeters: Math.round(distance * 10) / 10 };
  }

  async addIssue(issue: Issue): Promise<Issue> {
    await this.ensureReady();
    await this.q(
      `INSERT INTO issues
         (id, category_id, title, description, location, formatted_address, ward_id,
          location_details, status, assigned_worker_name, assigned_department,
          department_id, jurisdiction_code, state, citizen_user_id, citizen_name,
          sla_deadline_at, verified_at, merged_into_id, transcript,
          report_count, upvotes_count, ml_severity_score, priority_score, image_url,
          ml_analysis, reassign_request, proof, resolution_notes, resolution_proof_url,
          resolved_at, created_at, updated_at)
       VALUES
          ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7, $8,
           $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
           $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34)`,
      [
        issue.id,
        issue.categoryId,
        issue.title,
        issue.description ?? null,
        issue.longitude,
        issue.latitude,
        issue.formattedAddress ?? null,
        issue.wardId ?? null,
        issue.locationDetails ?? null,
        issue.status,
        issue.assignedWorkerName ?? null,
        issue.assignedDepartment ?? null,
        issue.departmentId ?? null,
        issue.jurisdictionCode ?? null,
        issue.state ?? null,
        issue.citizenUserId ?? null,
        issue.citizenName ?? null,
        issue.slaDeadlineAt ?? null,
        issue.verifiedAt ?? null,
        issue.mergedIntoId ?? null,
        issue.transcript ?? null,
        issue.reportCount,
        issue.communityUpvotes,
        issue.mlSeverityScore,
        issue.priorityScore,
        issue.imageUrl,
        issue.mlAnalysis ?? null,
        issue.reassignRequest ?? null,
        issue.proof ?? null,
        issue.resolutionNotes ?? null,
        issue.resolutionProofUrl ?? null,
        issue.resolvedAt ?? null,
        issue.createdAt,
        issue.updatedAt,
      ]
    );
    return issue;
  }

  async addReport(report: IssueReport): Promise<IssueReport> {
    await this.ensureReady();
    await this.q(
      `INSERT INTO issue_reports
         (id, issue_id, reporter_id, citizen_user_id, client_location, accuracy_meters,
          is_on_site, image_url, citizen_notes, transcript, exif,
          location_details, created_at)
       VALUES
         ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7,
          $8, $9, $10, $11, $12, $13, $14)`,
      [
        report.id,
        report.issueId,
        report.reporterId ?? null,
        report.citizenUserId ?? null,
        report.longitude,
        report.latitude,
        report.accuracyMeters,
        report.isOnSite,
        report.imageUrl,
        report.citizenNotes ?? null,
        report.transcript ?? null,
        report.exif ?? null,
        report.locationDetails ?? null,
        report.createdAt,
      ]
    );
    return report;
  }

  async incrementIssueReport(issueId: string, report: IssueReport): Promise<Issue | null> {
    await this.ensureReady();
    const { rows } = await this.q<IssueRow>(
      `${ISSUE_SELECT} WHERE i.id = $1 FOR UPDATE`,
      [issueId]
    );
    if (!rows[0]) return null;
    const current = toIssue(rows[0]);
    const breakdown = calculatePriorityScore({
      mlSeverity: current.mlSeverityScore,
      reportCount: current.reportCount + 1,
      communityUpvotes: current.communityUpvotes,
      createdAt: current.createdAt,
    });
    await this.q(
      `UPDATE issues
       SET report_count = report_count + 1, priority_score = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [issueId, breakdown.totalScore]
    );
    return (await this.getIssueById(issueId)) ?? null;
  }

  async upvoteIssue(issueId: string): Promise<Issue | null> {
    await this.ensureReady();
    const { rows } = await this.q<IssueRow>(
      `${ISSUE_SELECT} WHERE i.id = $1 FOR UPDATE`,
      [issueId]
    );
    if (!rows[0]) return null;
    const current = toIssue(rows[0]);
    const breakdown = calculatePriorityScore({
      mlSeverity: current.mlSeverityScore,
      reportCount: current.reportCount,
      communityUpvotes: current.communityUpvotes + 1,
      createdAt: current.createdAt,
    });
    await this.q(
      `UPDATE issues
       SET upvotes_count = upvotes_count + 1, priority_score = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [issueId, breakdown.totalScore]
    );
    return (await this.getIssueById(issueId)) ?? null;
  }

  async hasUpvoted(userId: string, issueId: string): Promise<boolean> {
    await this.ensureReady();
    const { rowCount } = await this.q(
      `SELECT 1 FROM upvotes WHERE issue_id = $1 AND user_id = $2`,
      [issueId, userId]
    );
    return (rowCount ?? 0) > 0;
  }

  async recordUpvote(userId: string, issueId: string): Promise<boolean> {
    await this.ensureReady();
    const { rowCount } = await this.q(
      `INSERT INTO upvotes (issue_id, user_id) VALUES ($1, $2)
       ON CONFLICT (issue_id, user_id) DO NOTHING`,
      [issueId, userId]
    );
    return (rowCount ?? 0) > 0;
  }

  // --- Departments ---------------------------------------------------------

  async getDepartments(): Promise<Department[]> {
    await this.ensureReady();
    const { rows } = await this.q(
      `SELECT id, code, name, nodal_officer AS "nodalOfficer", sla_hours AS "slaHours",
              disabled, category_codes AS "categoryCodes"
       FROM departments
       ORDER BY name ASC`
    );
    return rows.map(toDepartment);
  }

  async getDepartmentById(id: string): Promise<Department | undefined> {
    await this.ensureReady();
    const { rows } = await this.q(
      `SELECT id, code, name, nodal_officer AS "nodalOfficer", sla_hours AS "slaHours",
              disabled, category_codes AS "categoryCodes"
       FROM departments
       WHERE id = $1 OR lower(code) = lower($1)
       LIMIT 1`,
      [id]
    );
    if (rows[0]) return toDepartment(rows[0]);
    return DEFAULT_DEPARTMENTS.find(
      (d) => d.id === id || d.code === id || d.code.toLowerCase() === String(id).toLowerCase()
    );
  }

  async upsertDepartment(dept: Department): Promise<Department> {
    await this.ensureReady();
    const {
      rows: [row],
    } = await this.q(
      `INSERT INTO departments (id, code, name, nodal_officer, sla_hours, disabled, category_codes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         code = EXCLUDED.code,
         name = EXCLUDED.name,
         nodal_officer = EXCLUDED.nodal_officer,
         sla_hours = EXCLUDED.sla_hours,
         disabled = EXCLUDED.disabled,
         category_codes = EXCLUDED.category_codes,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id, code, name, nodal_officer AS "nodalOfficer",
                 sla_hours AS "slaHours", disabled, category_codes AS "categoryCodes"`,
      [dept.id, dept.code, dept.name, dept.nodalOfficer, dept.slaHours, dept.disabled, dept.categoryCodes]
    );
    return toDepartment(row);
  }

  // --- Scoped queries ------------------------------------------------------

  async getIssuesForCitizen(userId: string): Promise<Issue[]> {
    await this.ensureReady();
    const { rows } = await this.q<IssueRow>(
      `${ISSUE_SELECT} WHERE i.citizen_user_id = $1 ORDER BY i.priority_score DESC`,
      [userId]
    );
    return this.attachReports(rows.map(toIssue));
  }

  // --- Proof of work -------------------------------------------------------

  async addProofOfWork(proof: ProofOfWork): Promise<Issue | null> {
    await this.ensureReady();
    const { rowCount } = await this.q(
      `UPDATE issues SET proof = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [proof.issueId, proof]
    );
    if ((rowCount ?? 0) === 0) return null;
    return (await this.getIssueById(proof.issueId)) ?? null;
  }

  async requestReassign(issueId: string, req: ReassignRequest): Promise<Issue | null> {
    await this.ensureReady();
    const { rowCount } = await this.q(
      `UPDATE issues SET reassign_request = $2::jsonb, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [issueId, req]
    );
    if ((rowCount ?? 0) === 0) return null;
    return (await this.getIssueById(issueId)) ?? null;
  }

  async mergeIssue(secondaryId: string, primaryId: string): Promise<boolean> {
    await this.ensureReady();
    return this.withTransaction(async () => {
      if (secondaryId === primaryId) return false;
      const check = await this.q<{ id: string }>(
        `SELECT id FROM issues WHERE id IN ($1, $2)`,
        [secondaryId, primaryId]
      );
      if ((check.rowCount ?? 0) !== 2) return false;
      await this.q(
        `UPDATE issues SET status = 'merged', merged_into_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [secondaryId, primaryId]
      );
      await this.q(
        `UPDATE issues SET report_count = report_count + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [primaryId]
      );
      return true;
    });
  }

  async updateIssueStatus(
    issueId: string,
    params: IssueStatusUpdate
  ): Promise<Issue | null> {
    await this.ensureReady();
    const issue = await this.getIssueById(issueId);
    if (!issue) return null;

    let verifiedAt: string | undefined;
    if (params.status === 'verified' && !issue.verifiedAt) {
      verifiedAt = new Date().toISOString();
    }

    let slaDeadlineAt: string | undefined;
    if (params.status === 'assigned') {
      const dept = await this.getDepartmentById(issue.departmentId || '');
      const slaHours = dept?.slaHours ?? issue.category.defaultSlaHours ?? 72;
      slaDeadlineAt = new Date(Date.now() + slaHours * 3600_000).toISOString();
    }

    let resolvedAt: string | undefined;
    if (params.status === 'resolved') {
      resolvedAt = new Date().toISOString();
    }

    const { rowCount } = await this.q(
      `UPDATE issues SET
         status = $2,
         assigned_worker_name = COALESCE($3, assigned_worker_name),
         assigned_department = COALESCE($4, assigned_department),
         department_id = COALESCE($5, department_id),
         jurisdiction_code = COALESCE($6, jurisdiction_code),
         resolution_notes = COALESCE($7, resolution_notes),
         resolution_proof_url = COALESCE($8, resolution_proof_url),
         verified_at = COALESCE($9, verified_at),
         sla_deadline_at = COALESCE($10, sla_deadline_at),
         resolved_at = COALESCE($11, resolved_at),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [
        issueId,
        params.status,
        params.assignedWorkerName ?? null,
        params.assignedDepartment ?? null,
        params.departmentId ?? null,
        params.jurisdictionCode ?? null,
        params.resolutionNotes ?? null,
        params.resolutionProofUrl ?? null,
        verifiedAt ?? null,
        slaDeadlineAt ?? null,
        resolvedAt ?? null,
      ]
    );
    if ((rowCount ?? 0) === 0) return null;
    return (await this.getIssueById(issueId)) ?? null;
  }

  // --- Notifications -------------------------------------------------------

  async pushNotification(n: AppNotification): Promise<void> {
    await this.ensureReady();
    await this.q(
      `INSERT INTO notifications (id, user_id, issue_id, title, body, read, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [n.id, n.userId, n.issueId ?? null, n.title, n.body, n.read, n.createdAt]
    );
  }

  async getNotificationsForUser(userId: string): Promise<AppNotification[]> {
    await this.ensureReady();
    const { rows } = await this.q<{
      id: string;
      userId: string;
      issueId: string | null;
      title: string;
      body: string;
      read: boolean;
      createdAt: Date;
    }>(
      `SELECT id, user_id AS "userId", issue_id AS "issueId", title, body, read,
              created_at AS "createdAt"
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      issueId: r.issueId ?? undefined,
      title: r.title,
      body: r.body,
      read: Boolean(r.read),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async markNotificationsRead(userId: string): Promise<void> {
    await this.ensureReady();
    await this.q(`UPDATE notifications SET read = TRUE WHERE user_id = $1`, [userId]);
  }

  // --- Audit log -----------------------------------------------------------

  async addAuditLog(entry: AuditLogEntry): Promise<void> {
    await this.ensureReady();
    await this.q(
      `INSERT INTO audit_logs (id, actor_id, actor_name, role, action, issue_id, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [entry.id, entry.actorId ?? null, entry.actorName, entry.role, entry.action, entry.issueId ?? null, entry.detail, entry.createdAt]
    );
  }

  async getAuditLogs(limit = 50): Promise<AuditLogEntry[]> {
    await this.ensureReady();
    const { rows } = await this.q<{
      id: string;
      actorId: string | null;
      actorName: string;
      role: AuditLogEntry['role'];
      action: string;
      issueId: string | null;
      detail: string | null;
      createdAt: Date;
    }>(
      `SELECT id, actor_id AS "actorId", actor_name AS "actorName", role, action,
              issue_id AS "issueId", detail, created_at AS "createdAt"
       FROM audit_logs
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return rows.map((r) => ({
      id: r.id,
      actorId: r.actorId ?? '',
      actorName: r.actorName,
      role: r.role,
      action: r.action,
      issueId: r.issueId ?? undefined,
      detail: r.detail ?? '',
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // --- Complaints and demand signals ---------------------------------------

  async listComplaints(options: { withEmbeddings?: boolean } = {}): Promise<Complaint[]> {
    await this.ensureReady();
    const embeddingColumn = options.withEmbeddings === false ? 'NULL::text AS embedding' : 'embedding::text AS embedding';
    const { rows } = await this.q<ComplaintRow>(
      `SELECT id,
              source_issue_id AS "sourceIssueId",
              source_report_id AS "sourceReportId",
              issue_type AS "issueType",
              location_state AS "locationState",
              location_district AS "locationDistrict",
              location_ward AS "locationWard",
              location,
              location_granularity AS "locationGranularity",
              urgency_score AS "urgencyScore",
              urgency_reason AS "urgencyReason",
              original_language AS "originalLanguage",
              original_text AS "originalText",
              translated_text AS "translatedText",
              ${embeddingColumn},
              embedding_model AS "embeddingModel",
              embedding_dimensions AS "embeddingDimensions",
              extraction_engine AS "extractionEngine",
              created_at AS "createdAt"
         FROM complaints
        ORDER BY id`
    );
    return rows.map(toComplaint);
  }

  async upsertComplaints(complaints: Complaint[]): Promise<number> {
    await this.ensureReady();
    if (complaints.length === 0) return 0;

    // One multi-row INSERT rather than N round trips: a full rebuild touches
    // every complaint in the corpus, and at a few hundred rows the per-statement
    // latency dominates everything else in the build.
    const columns = 15;
    const values: unknown[] = [];
    const tuples = complaints.map((c, row) => {
      const base = row * columns;
      values.push(
        c.id,
        c.sourceIssueId ?? null,
        c.sourceReportId ?? null,
        c.issueType,
        c.locationState ?? null,
        c.locationDistrict ?? null,
        c.locationWard ?? null,
        c.location,
        c.locationGranularity,
        c.urgencyScore,
        c.urgencyReason ?? null,
        c.originalLanguage,
        c.originalText,
        c.translatedText,
        c.extractionEngine
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15})`;
    });

    await this.q(
      `INSERT INTO complaints
         (id, source_issue_id, source_report_id, issue_type, location_state,
          location_district, location_ward, location, location_granularity,
          urgency_score, urgency_reason, original_language, original_text,
          translated_text, extraction_engine)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (id) DO UPDATE SET
         source_issue_id = EXCLUDED.source_issue_id,
         source_report_id = EXCLUDED.source_report_id,
         issue_type = EXCLUDED.issue_type,
         location_state = EXCLUDED.location_state,
         location_district = EXCLUDED.location_district,
         location_ward = EXCLUDED.location_ward,
         location = EXCLUDED.location,
         location_granularity = EXCLUDED.location_granularity,
         urgency_score = EXCLUDED.urgency_score,
         urgency_reason = EXCLUDED.urgency_reason,
         original_language = EXCLUDED.original_language,
         original_text = EXCLUDED.original_text,
         translated_text = EXCLUDED.translated_text,
         extraction_engine = EXCLUDED.extraction_engine,
         updated_at = CURRENT_TIMESTAMP`,
      values
    );
    return complaints.length;
  }

  async setComplaintEmbedding(id: string, embedding: number[], model: string): Promise<void> {
    await this.ensureReady();
    // The dimension is read back off the vector rather than passed in, so the
    // recorded value cannot drift from the data the column actually holds.
    // pgvector's text input format is "[1,2,3]", NOT the "{1,2,3}" Postgres
    // array literal the two look alike; the array form is rejected with
    // 'Vector contents must start with "["'. vector_dims() is used rather than
    // array_length($2::real[], 1) because casting to real[] would need the
    // array form and so fails for the same reason.
    await this.q(
      `UPDATE complaints
          SET embedding = $2::vector,
              embedding_model = $3,
              embedding_dimensions = vector_dims($2::vector),
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [id, `[${embedding.join(',')}]`, model]
    );
  }

  async replaceDemandSignals(signals: DemandSignal[]): Promise<void> {
    await this.ensureReady();

    // Step 4 data fusion runs at the persistence boundary so a stored signal
    // always carries its district's real population and infrastructure gap,
    // and a caller that skipped fusion cannot quietly write unfused rows.
    const fused = withDistrictStatistics(signals);

    await this.q('DELETE FROM demand_signals');
    if (fused.length === 0) return;

    const columns = 16;
    const values: unknown[] = [];
    const tuples = fused.map((s, row) => {
      const base = row * columns;
      values.push(
        s.clusterId,
        s.issueType,
        s.location,
        s.locationState ?? null,
        s.locationDistrict ?? null,
        s.locationWard ?? null,
        s.memberComplaintIds,
        s.volume,
        s.avgUrgency,
        s.summary,
        s.languagesRepresented,
        s.similarityThreshold,
        s.verificationEngine,
        s.populationAffected ?? null,
        s.existingInfrastructureGap ?? null,
        s.dataFusionSource ?? null
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16})`;
    });

    await this.q(
      `INSERT INTO demand_signals
         (cluster_id, issue_type, location, location_state, location_district,
          location_ward, member_complaint_ids, volume, avg_urgency, summary,
          languages_represented, similarity_threshold, verification_engine,
          population_affected, existing_infrastructure_gap, data_fusion_source)
       VALUES ${tuples.join(', ')}`,
      values
    );
  }

  async listDemandSignals(): Promise<DemandSignal[]> {
    await this.ensureReady();
    const { rows } = await this.q<DemandSignalRow>(
      `SELECT cluster_id AS "clusterId",
              issue_type AS "issueType",
              location,
              location_state AS "locationState",
              location_district AS "locationDistrict",
              location_ward AS "locationWard",
              member_complaint_ids AS "memberComplaintIds",
              volume,
              avg_urgency AS "avgUrgency",
              summary,
              languages_represented AS "languagesRepresented",
              similarity_threshold AS "similarityThreshold",
              verification_engine AS "verificationEngine",
              population_affected AS "populationAffected",
              existing_infrastructure_gap AS "existingInfrastructureGap",
              data_fusion_source AS "dataFusionSource",
              created_at AS "createdAt"
         FROM demand_signals
        ORDER BY volume DESC, cluster_id ASC`
    );
    return rows.map(toDemandSignal);
  }

  // --- Transactions --------------------------------------------------------

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureReady();
    if (this.txClient) return fn();
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      this.txClient = client;
      const result = await fn();
      await client.query('COMMIT');
      this.txClient = null;
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback failure — original error is what matters
      }
      this.txClient = null;
      throw err;
    } finally {
      this.txClient = null;
      client.release();
    }
  }
}