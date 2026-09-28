import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { CivicStore, IssueStatusUpdate, ReassignRequest } from './civicStore';
import { INITIAL_CATEGORIES } from './categories';
import { DEFAULT_DEPARTMENTS } from './departments';
import { getPool, query } from './db';
import { calculatePriorityScore } from './scoring';
import { buildSeedIssues, SEED_CITIES } from './seedIssues';
import {
  AppNotification,
  AuditLogEntry,
  Category,
  Department,
  Issue,
  IssueReport,
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
              department_id, jurisdiction_code, citizen_user_id, citizen_name,
              sla_deadline_at, verified_at, merged_into_id, transcript,
              report_count, upvotes_count, ml_severity_score, priority_score, image_url,
              ml_analysis, reassign_request, proof, resolution_notes, resolution_proof_url,
              resolved_at, created_at, updated_at)
           VALUES
              ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7, $8,
               $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
               $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33)`,
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
      console.log(`[store] Seeded ${seeds.length} sample grievances across ${SEED_CITIES.length} ${SEED_CITIES[0].state} districts`);
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
          department_id, jurisdiction_code, citizen_user_id, citizen_name,
          sla_deadline_at, verified_at, merged_into_id, transcript,
          report_count, upvotes_count, ml_severity_score, priority_score, image_url,
          ml_analysis, reassign_request, proof, resolution_notes, resolution_proof_url,
          resolved_at, created_at, updated_at)
       VALUES
          ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7, $8,
           $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
           $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33)`,
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

  async getIssuesForDepartment(departmentId: string): Promise<Issue[]> {
    await this.ensureReady();
    const { rows } = await this.q<IssueRow>(
      `${ISSUE_SELECT}
       WHERE i.department_id = $1 AND i.status NOT IN ('merged', 'rejected')
       ORDER BY i.priority_score DESC`,
      [departmentId]
    );
    return this.attachReports(rows.map(toIssue));
  }

  async getAssignableForDepartment(departmentId: string): Promise<Issue[]> {
    await this.ensureReady();
    const { rows } = await this.q<IssueRow>(
      `${ISSUE_SELECT}
       WHERE i.department_id = $1
         AND i.status IN ('assigned', 'in_progress')
         AND i.status NOT IN ('merged', 'rejected')
       ORDER BY i.priority_score DESC`,
      [departmentId]
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