'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Issue, IssueStatus, Category, Department, AuthUser } from '@/lib/types';
import { StatusPill } from './StatusPill';
import {
  Search,
  CheckCircle2,
  XCircle,
  Send,
  GitMerge,
  Plus,
  Building2,
  BarChart3,
  Clock,
  AlertTriangle,
  Mic,
  Loader2,
  RefreshCw,
  MapPinned,
  Sparkles,
  Globe2,
} from 'lucide-react';

interface AdminPortalProps {
  user: AuthUser;
  issues: Issue[];
  categories: Category[];
  onStatusUpdate: (
    issueId: string,
    params: {
      status: IssueStatus;
      assignedWorkerName?: string;
      assignedDepartment?: string;
      departmentId?: string;
    }
  ) => Promise<void>;
  onMerge: (secondaryId: string, primaryId: string) => Promise<void>;
}

type Section = 'triage' | 'dispatch' | 'departments' | 'analytics' | 'policymaker';

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: 'triage', label: 'Triage', icon: <Search className="w-4 h-4" /> },
  { key: 'dispatch', label: 'Dispatch', icon: <Send className="w-4 h-4" /> },
  { key: 'departments', label: 'Departments', icon: <Building2 className="w-4 h-4" /> },
  { key: 'analytics', label: 'Analytics', icon: <BarChart3 className="w-4 h-4" /> },
  { key: 'policymaker', label: 'Policymaker', icon: <MapPinned className="w-4 h-4" /> },
];

const DEPT_WORKERS: Record<string, string[]> = {
  DEPT_WATER: ['Vikas Gowda', 'Reena Jose', 'Mohan Lal'],
  DEPT_DRAINAGE: ['Priya Nair', 'Suresh Kumar'],
  DEPT_PWD: ['Rajesh Kumar', 'Anil Sharma', 'Dinesh Verma'],
  DEPT_WASTE: ['Karthik Rao', 'Sundar Raj'],
  DEPT_ELECTRICITY: ['Suresh Babu', 'Divya Menon'],
  DEPT_HEALTH: ['Arjun Pillai'],
  DEPT_TOWN_PLANNING: ['Geetha Reddy'],
  DEPT_UNASSIGNED: ['Triage Officer'],
};

type AnalyticsData = {
  generatedAt: string;
  totals: Record<string, number>;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  byDepartment: Record<string, { name: string; open: number; avgHours: number; slaBreaches: number; resolved: number }>;
  slaBreachedIssues: { id: string; title: string; departmentId?: string; status: IssueStatus; slaDeadlineAt?: string }[];
  recentAudit: { id: string; actorName: string; role: string; action: string; detail: string; createdAt: string }[];
};

type Hotspot = {
  id: string;
  centroidLat: number;
  centroidLng: number;
  issueCount: number;
  totalUpvotes: number;
  avgPriority: number;
  avgSeverity: number;
  topCategories: { id: string; name: string; count: number }[];
  leadingIssueId: string;
  leadingIssueTitle: string;
  areaName: string;
  state: string;
  district: string;
  demandScore: number;
  radiusMeters: number;
};

type Recommendation = {
  rank: number;
  title: string;
  hotspotId: string;
  category: string;
  department: string;
  demandScore: number;
  rationale: string;
  estimatedImpact: string;
  indicativeInvestment: string;
  priority: string;
};

type CategoryDemandRow = { id: string; name: string; openCount: number; totalUpvotes: number; avgSeverity: number };

type StateDemand = {
  state: string;
  districts: string[];
  openCount: number;
  totalUpvotes: number;
  avgSeverity: number;
  hotspotCount: number;
  topCategories: { id: string; name: string; count: number }[];
  riskLabel: string;
  pressureScore: number;
};

type NationalSummary = {
  totalOpen: number;
  totalUpvotes: number;
  totalHotspots: number;
  statesCovered: number;
  districtsCovered: number;
  leadingState: string;
  leadingStateScore: number;
  leadingCategory: string;
  urgentStates: number;
  investmentFocus: string;
};

type DistrictDemand = {
  district: string;
  state: string;
  openCount: number;
  totalUpvotes: number;
  avgSeverity: number;
  hotspotCount: number;
  topCategories: { id: string; name: string; count: number }[];
  pressureScore: number;
};

type HotspotsData = {
  generatedAt: string;
  mode: 'gemini' | 'heuristic';
  dataSources: string[];
  counts: {
    totalOpen: number;
    totalResolved: number;
    totalUpvotes: number;
    hotspotCount: number;
    stateCount: number;
    districtCount: number;
  };
  hotspots: Hotspot[];
  recommendations: Recommendation[];
  categoryDemand: CategoryDemandRow[];
  stateDemand: StateDemand[];
  districtDemand: DistrictDemand[];
  national: NationalSummary;
};

export const AdminPortal: React.FC<AdminPortalProps> = ({ user, issues, categories, onStatusUpdate, onMerge }) => {
  const [section, setSection] = useState<Section>('triage');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [hotspotsData, setHotspotsData] = useState<HotspotsData | null>(null);
  const [hotspotsLoading, setHotspotsLoading] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadDepartments = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/departments', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setDepartments(data.departments || []);
      }
    } catch {
      // ignore
    }
  }, []);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/analytics', { cache: 'no-store' });
      if (res.ok) setAnalytics(await res.json());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHotspots = useCallback(async () => {
    setHotspotsLoading(true);
    try {
      const res = await fetch('/api/admin/hotspots', { cache: 'no-store' });
      if (res.ok) setHotspotsData(await res.json());
    } catch {
      // ignore
    } finally {
      setHotspotsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDepartments();
  }, [loadDepartments]);

  useEffect(() => {
    if (section === 'departments') loadDepartments();
    if (section === 'analytics') loadAnalytics();
    if (section === 'policymaker') loadHotspots();
  }, [section, loadDepartments, loadAnalytics, loadHotspots]);

  const activeIssues = issues.filter((i) => i.status !== 'merged');

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6 pb-28 md:pb-12 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold tracking-tight">City Admin Console</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Verified as {user.name} · full platform control — verify, dispatch, merge, govern departments.
          </p>
        </div>
        <button
          onClick={() =>
            section === 'analytics'
              ? loadAnalytics()
              : section === 'departments'
                ? loadDepartments()
                : section === 'policymaker'
                  ? loadHotspots()
                  : undefined
          }
          className="flex items-center space-x-1.5 px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-800 text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading || hotspotsLoading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Section tabs */}
      <div className="grid grid-cols-5 p-1 rounded-2xl bg-slate-100 dark:bg-slate-800/80 text-xs font-bold">
        {SECTIONS.map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => setSection(key)}
            className={`py-2.5 rounded-xl flex items-center justify-center space-x-1.5 transition ${
              section === key
                ? 'bg-white text-emerald-700 shadow-sm dark:bg-emerald-600 dark:text-white'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
            }`}
          >
            {icon}
            <span className="hidden sm:inline">{label}</span>
            <span className="sm:hidden">{label.slice(0, 6)}</span>
          </button>
        ))}
      </div>

      {section === 'triage' && (
        <TriageSection issues={issues} onStatusUpdate={onStatusUpdate} />
      )}
      {section === 'dispatch' && (
        <DispatchSection
          issues={activeIssues}
          departments={departments}
          onStatusUpdate={onStatusUpdate}
          onMerge={onMerge}
        />
      )}
      {section === 'departments' && (
        <DepartmentsSection departments={departments} onChanged={loadDepartments} />
      )}
      {section === 'analytics' && (
        <AnalyticsSection analytics={analytics} issues={issues} />
      )}
      {section === 'policymaker' && (
        <PolicymakerSection data={hotspotsData} loading={hotspotsLoading} />
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Triage — submitted/in-review issues: verify or reject               */
/* ------------------------------------------------------------------ */

function TriageSection({ issues, onStatusUpdate }: { issues: Issue[]; onStatusUpdate: AdminPortalProps['onStatusUpdate'] }) {
  const triage = issues.filter((i) => i.status === 'reported' || i.status === 'in_review');
  const [worker, setWorker] = useState('');

  if (triage.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center">
        <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-400" />
        <p className="mt-3 text-sm font-semibold">Triage queue is empty</p>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          New submissions land here. Verify them and they become assignable to a department.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {triage.map((issue) => (
        <IssueRow key={issue.id} issue={issue}>
          <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
            <button
              onClick={() => {
                setWorker('');
                onStatusUpdate(issue.id, { status: 'verified' });
              }}
              className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition flex items-center space-x-1.5"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Verify</span>
            </button>
            <button
              onClick={() => onStatusUpdate(issue.id, { status: 'rejected' })}
              className="px-3.5 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition flex items-center space-x-1.5"
            >
              <XCircle className="w-3.5 h-3.5" />
              <span>Reject</span>
            </button>
            <span className="text-[10px] text-slate-400 ml-auto">{issue.id}</span>
          </div>
        </IssueRow>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dispatch — verify-assigned tickets: assign, unassign, merge, reject */
/* ------------------------------------------------------------------ */

function DispatchSection({
  issues,
  departments,
  onStatusUpdate,
  onMerge,
}: {
  issues: Issue[];
  departments: Department[];
  onStatusUpdate: AdminPortalProps['onStatusUpdate'];
  onMerge: AdminPortalProps['onMerge'];
}) {
  const [assignDept, setAssignDept] = useState<Record<string, string>>({});
  const [assignWorker, setAssignWorker] = useState<Record<string, string>>({});
  const [mergeTarget, setMergeTarget] = useState<Record<string, string>>({});

  const assignables = issues.filter((i) => i.status === 'verified' || i.status === 'assigned' || i.status === 'in_progress');

  if (assignables.length === 0) {
    return (
      <div className="rounded-3xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center">
        <Send className="w-10 h-10 mx-auto text-slate-300 dark:text-slate-600" />
        <p className="mt-3 text-sm font-semibold">Nothing to dispatch</p>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Verify submissions in Triage first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {assignables.map((issue) => {
        const deptOptions = departments.filter((d) => !d.disabled);
        const chosenDept = assignDept[issue.id] || issue.departmentId || '';
        const chosenWorker = assignWorker[issue.id] || issue.assignedWorkerName || '';
        const workers = DEPT_WORKERS[chosenDept] || ['Field Crew'];

        return (
          <IssueRow key={issue.id} issue={issue}>
            {/* Reassignment request banner */}
            {issue.reassignRequest && (
              <div className="pt-3">
                <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30 text-amber-800 dark:text-amber-300">
                  <p className="text-[11px] font-bold">Reassignment requested by {issue.reassignRequest.byDepartment}</p>
                  <p className="text-[11px] mt-0.5 italic">“{issue.reassignRequest.reason}”</p>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-100 dark:border-slate-800">
              {(issue.status === 'verified' || issue.status === 'assigned') && (
                <>
                  <select
                    value={chosenDept}
                    onChange={(e) => setAssignDept((p) => ({ ...p, [issue.id]: e.target.value }))}
                    className="px-2.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold outline-none focus:border-emerald-500"
                  >
                    <option value="">Select department…</option>
                    {deptOptions.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <select
                    value={chosenWorker}
                    onChange={(e) => setAssignWorker((p) => ({ ...p, [issue.id]: e.target.value }))}
                    className="px-2.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold outline-none focus:border-emerald-500"
                  >
                    <option value="">Worker…</option>
                    {workers.map((w) => (
                      <option key={w} value={w}>
                        {w}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      const dept = departments.find((d) => d.id === chosenDept);
                      onStatusUpdate(issue.id, {
                        status: 'assigned',
                        departmentId: chosenDept,
                        assignedDepartment: dept?.name || chosenDept,
                        assignedWorkerName: chosenWorker || 'Field Crew',
                      });
                      setAssignDept((p) => ({ ...p, [issue.id]: '' }));
                      setAssignWorker((p) => ({ ...p, [issue.id]: '' }));
                    }}
                    disabled={!chosenDept}
                    className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition disabled:opacity-40 flex items-center space-x-1.5"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>Assign</span>
                  </button>
                  <button
                    onClick={() => onStatusUpdate(issue.id, { status: 'verified' })}
                    className="px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                  >
                    Unassign
                  </button>
                </>
              )}

              {/* Merge control */}
              <select
                value={mergeTarget[issue.id] || ''}
                onChange={(e) => setMergeTarget((p) => ({ ...p, [issue.id]: e.target.value }))}
                className="px-2.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-semibold outline-none focus:border-emerald-500"
              >
                <option value="">Merge into…</option>
                {issues
                  .filter((cand) => cand.id !== issue.id && cand.status !== 'merged' && cand.status !== 'rejected')
                  .map((cand) => (
                    <option key={cand.id} value={cand.id}>
                      {cand.id} — {cand.title.slice(0, 28)}
                    </option>
                  ))}
              </select>
              <button
                onClick={() => mergeTarget[issue.id] && onMerge(issue.id, mergeTarget[issue.id])}
                disabled={!mergeTarget[issue.id]}
                className="px-3 py-2 rounded-xl bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold transition disabled:opacity-40 flex items-center space-x-1.5"
              >
                <GitMerge className="w-3.5 h-3.5" />
                <span>Merge</span>
              </button>

              <button
                onClick={() => onStatusUpdate(issue.id, { status: 'rejected' })}
                className="px-3 py-2 rounded-xl border border-rose-300 dark:border-rose-500/40 text-rose-600 dark:text-rose-400 text-xs font-bold hover:bg-rose-500/10 transition"
              >
                Reject
              </button>
            </div>
          </IssueRow>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Departments — dynamic catalog CRUD                                   */
/* ------------------------------------------------------------------ */

function DepartmentsSection({ departments, onChanged }: { departments: Department[]; onChanged: () => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nodalOfficer, setNodalOfficer] = useState('');
  const [slaHours, setSlaHours] = useState(72);
  const [disabled, setDisabled] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const id = editingId || `DEPT_${name.trim().replace(/[^A-Za-z0-9]/g, '_').toUpperCase().slice(0, 24)}`;
    try {
      await fetch('/api/admin/departments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, name: name.trim(), nodalOfficer, slaHours, disabled }),
      });
      setEditingId(null);
      setName('');
      setNodalOfficer('');
      setSlaHours(72);
      setDisabled(false);
      onChanged();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Add / edit form */}
      <div className="p-4 rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {editingId ? `Editing ${editingId}` : 'Add a new department'}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Department name"
            className="px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs outline-none focus:border-emerald-500"
          />
          <input
            value={nodalOfficer}
            onChange={(e) => setNodalOfficer(e.target.value)}
            placeholder="Nodal officer"
            className="px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs outline-none focus:border-emerald-500"
          />
          <input
            value={slaHours}
            onChange={(e) => setSlaHours(Number(e.target.value) || 0)}
            type="number"
            min={1}
            placeholder="SLA (hours)"
            className="px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 text-xs outline-none focus:border-emerald-500"
          />
          <label className="flex items-center space-x-2 px-3 py-2.5 text-xs font-semibold text-slate-600 dark:text-slate-400">
            <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
            <span>Disabled (stop receiving routes)</span>
          </label>
        </div>
        <div className="flex space-x-2">
          <button
            onClick={save}
            disabled={!name.trim() || saving}
            className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition disabled:opacity-40 flex items-center space-x-1.5"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            <span>{editingId ? 'Save changes' : 'Create department'}</span>
          </button>
          {editingId && (
            <button
              onClick={() => {
                setEditingId(null);
                setName('');
                setNodalOfficer('');
                setSlaHours(72);
                setDisabled(false);
              }}
              className="px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-bold text-slate-500"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Catalog */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {departments.map((d) => (
          <div key={d.id} className={`p-4 rounded-3xl border transition ${
            d.disabled
              ? 'border-slate-200 dark:border-slate-800 opacity-60'
              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900'
          }`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h4 className="text-sm font-bold truncate">{d.name}</h4>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono">{d.id}</p>
              </div>
              <StatusPill status={d.disabled ? 'rejected' : 'verified'} className="shrink-0" />
            </div>
            <dl className="mt-2.5 space-y-1 text-[11px] text-slate-500 dark:text-slate-400">
              <div className="flex justify-between">
                <dt>Nodal officer</dt>
                <dd className="font-semibold text-slate-700 dark:text-slate-200">{d.nodalOfficer}</dd>
              </div>
              <div className="flex justify-between">
                <dt>SLA target</dt>
                <dd className="font-semibold text-slate-700 dark:text-slate-200">{d.slaHours}h</dd>
              </div>
              <div className="flex justify-between">
                <dt>Routed categories</dt>
                <dd className="font-mono">{d.categoryCodes.join(', ') || '—'}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Status</dt>
                <dd>{d.disabled ? 'Disabled' : 'Receiving routes'}</dd>
              </div>
            </dl>
            <button
              onClick={() => {
                setEditingId(d.id);
                setName(d.name);
                setNodalOfficer(d.nodalOfficer);
                setSlaHours(d.slaHours);
                setDisabled(d.disabled);
              }}
              className="mt-3 w-full py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-[11px] font-bold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
            >
              Edit
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Analytics — KPIs, SLA breaches, audit trail                         */
/* ------------------------------------------------------------------ */

function AnalyticsSection({ analytics, issues }: { analytics: AnalyticsData | null; issues: Issue[] }) {
  if (!analytics) {
    return (
      <div className="rounded-3xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center">
        <BarChart3 className="w-10 h-10 mx-auto text-slate-300 dark:text-slate-600" />
        <p className="mt-3 text-sm font-semibold">{issues.length === 0 ? 'No data yet' : 'Loading analytics…'}</p>
      </div>
    );
  }

  const kpis = [
    { label: 'Total work orders', value: analytics.totals.total ?? 0 },
    { label: 'Active', value: analytics.totals.active ?? 0 },
    { label: 'Resolved', value: analytics.totals.resolved ?? 0 },
    { label: 'Resolution rate', value: `${analytics.totals.resolutionRate ?? 0}%` },
    { label: 'Upvotes', value: analytics.totals.upvotes ?? 0 },
    { label: 'SLA breaches', value: analytics.slaBreachedIssues.length },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2.5">
        {kpis.map((k) => (
          <div key={k.label} className="p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">{k.label}</p>
            <p className="mt-1 text-xl font-bold text-slate-900 dark:text-white">{k.value}</p>
          </div>
        ))}
      </div>

      {/* Department SLA table */}
      <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center space-x-2">
          <Building2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          <h3 className="text-xs font-bold uppercase tracking-wider">Department health</h3>
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-100 dark:border-slate-800">
              <th className="px-4 py-2.5 font-semibold">Department</th>
              <th className="px-2 py-2.5 font-semibold text-center">Open</th>
              <th className="px-2 py-2.5 font-semibold text-center">Avg age (h)</th>
              <th className="px-2 py-2.5 font-semibold text-center">SLA breaches</th>
              <th className="px-4 py-2.5 font-semibold text-center">Resolved</th>
            </tr>
          </thead>
          <tbody>
            {Object.values(analytics.byDepartment).map((d) => (
              <tr key={d.name} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                <td className="px-4 py-2.5 font-semibold text-slate-700 dark:text-slate-200">{d.name}</td>
                <td className="px-2 py-2.5 text-center">{d.open}</td>
                <td className="px-2 py-2.5 text-center">{d.avgHours}</td>
                <td className="px-2 py-2.5 text-center">
                  {d.slaBreaches > 0 ? (
                    <span className="inline-flex items-center space-x-1 text-rose-600 dark:text-rose-400 font-bold">
                      <AlertTriangle className="w-3 h-3" />
                      <span>{d.slaBreaches}</span>
                    </span>
                  ) : (
                    <span className="text-emerald-600 dark:text-emerald-400">0</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-center">{d.resolved}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* SLA breached tickets */}
      {analytics.slaBreachedIssues.length > 0 && (
        <div className="rounded-3xl border border-rose-300 dark:border-rose-500/40 bg-rose-50/50 dark:bg-rose-500/5 overflow-hidden">
          <div className="px-4 py-3 border-b border-rose-200 dark:border-rose-500/30 flex items-center space-x-2">
            <Clock className="w-4 h-4 text-rose-600 dark:text-rose-400" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-rose-700 dark:text-rose-300">SLA breached</h3>
          </div>
          <div className="divide-y divide-rose-100 dark:divide-rose-500/20">
            {analytics.slaBreachedIssues.map((b) => (
              <div key={b.id} className="px-4 py-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-bold truncate">{b.title}</p>
                  <p className="text-[10px] text-slate-500 dark:text-slate-400 font-mono">{b.id}</p>
                </div>
                <div className="flex items-center space-x-2 shrink-0">
                  <StatusPill status={b.status} />
                  <span className="text-[10px] font-mono text-rose-600 dark:text-rose-400">
                    {b.slaDeadlineAt ? new Date(b.slaDeadlineAt).toLocaleString() : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Audit trail */}
      {analytics.recentAudit.length > 0 && (
        <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Recent audit trail
            </h3>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {analytics.recentAudit.map((a) => (
              <div key={a.id} className="px-4 py-2.5 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    <span className="text-emerald-600 dark:text-emerald-400 font-mono">{a.action}</span>
                    <span className="text-slate-400"> · </span>
                    {a.detail}
                  </p>
                </div>
                <span className="shrink-0 text-[10px] text-slate-400">
                  {a.actorName} · {new Date(a.createdAt).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Policymaker — AI Demand Intelligence dashboard                       */
/* ------------------------------------------------------------------ */

const PRIORITY_STYLES: Record<string, string> = {
  high: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
  low: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300',
};

function ScoreBar({ score }: { score: number }) {
  const hue = score >= 70 ? 'bg-rose-500' : score >= 40 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
      <div className={`h-full rounded-full ${hue}`} style={{ width: `${Math.max(4, score)}%` }} />
    </div>
  );
}

function PolicymakerSection({ data, loading }: { data: HotspotsData | null; loading: boolean }) {
  if (loading && !data) {
    return (
      <div className="rounded-3xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center flex items-center justify-center space-x-2">
        <Loader2 className="w-5 h-5 animate-spin text-emerald-500" />
        <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">Computing demand hotspots…</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-3xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center">
        <MapPinned className="w-10 h-10 mx-auto text-slate-300 dark:text-slate-600" />
        <p className="mt-3 text-sm font-semibold">No demand data yet</p>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
          Reports submitted by citizens are clustered into hotspots here, then ranked into recommended public projects.
        </p>
      </div>
    );
  }

  const topCategory = data.categoryDemand[0];
  const kpis = [
    { label: 'Open work orders', value: data.counts.totalOpen },
    { label: 'States / districts', value: `${data.counts.stateCount} / ${data.counts.districtCount}` },
    { label: 'Demand hotspots', value: data.counts.hotspotCount },
    { label: 'Top pressure point', value: topCategory?.name || '—' },
  ];

  return (
    <div className="space-y-4">
      {/* Header + AI mode chip */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-slate-400">
          Fusing live citizen grievances with contextual municipal data. Generated {new Date(data.generatedAt).toLocaleString()}.
        </p>
        <span
          className={`shrink-0 inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold ${
            data.mode === 'gemini'
              ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300'
              : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
          }`}
        >
          {data.mode === 'gemini' ? <Sparkles className="w-3.5 h-3.5" /> : <MapPinned className="w-3.5 h-3.5" />}
          <span>{data.mode === 'gemini' ? 'Gemini ranked' : 'Heuristic ranking'}</span>
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {kpis.map((k) => (
          <div key={k.label} className="p-3.5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold truncate">{k.label}</p>
            <p className="mt-1 text-xl font-bold text-slate-900 dark:text-white truncate">{k.value}</p>
          </div>
        ))}
      </div>

      {data.stateDemand.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex items-center space-x-2">
            <Globe2 className="w-4 h-4 text-sky-600 dark:text-sky-400" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              National rollup
            </h3>
          </div>
          <div className="rounded-3xl border border-sky-200 dark:border-sky-500/30 bg-sky-50/60 dark:bg-sky-500/5 p-4">
            <p className="text-xs text-slate-600 dark:text-slate-300">
              <span className="font-bold text-slate-900 dark:text-white">{data.national.totalOpen} open grievances</span>{' '}
              across {data.national.statesCovered} states and {data.national.districtsCovered} districts, clustered into{' '}
              {data.national.totalHotspots} hotspots with {data.national.totalUpvotes} community endorsements.
            </p>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-[11px]">
              <div className="rounded-2xl bg-white dark:bg-slate-900 p-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Highest civic pressure</p>
                <p className="mt-1 font-bold text-slate-900 dark:text-white">{data.national.leadingState}</p>
                <p className="text-slate-500 dark:text-slate-400">pressure {data.national.leadingStateScore}/100</p>
              </div>
              <div className="rounded-2xl bg-white dark:bg-slate-900 p-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Investment focus</p>
                <p className="mt-1 font-bold text-slate-900 dark:text-white">{data.national.leadingCategory}</p>
                <p className="text-slate-500 dark:text-slate-400">{data.national.urgentStates} state(s) above urgent threshold</p>
              </div>
              <div className="rounded-2xl bg-white dark:bg-slate-900 p-3">
                <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">National priority</p>
                <p className="mt-1 font-bold text-slate-900 dark:text-white">{data.national.investmentFocus}</p>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {data.stateDemand.map((s) => (
              <div key={s.state} className="p-4 rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="text-sm font-bold truncate">{s.state}</h4>
                    <p className="text-[10px] text-slate-400 truncate">{s.riskLabel}</p>
                  </div>
                  <span className="shrink-0 text-sm font-bold text-slate-900 dark:text-white">{s.pressureScore}</span>
                </div>
                <div className="mt-2"><ScoreBar score={s.pressureScore} /></div>
                <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="font-bold text-slate-700 dark:text-slate-200">{s.openCount} open</span>
                  <span>{s.hotspotCount} hotspots</span>
                  <span>{s.districts.length} districts</span>
                  <span>{s.totalUpvotes} upvotes</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.topCategories.map((c) => (
                    <span key={c.id} className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-[10px] font-bold text-slate-600 dark:text-slate-300">
                      {c.name} ×{c.count}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {data.districtDemand.length > 0 && (
            <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
              <div className="px-4 pt-4 pb-2 flex items-center space-x-2">
                <BarChart3 className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  District pressure index
                </h4>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[11px]">
                  <thead>
                    <tr className="text-slate-400 uppercase tracking-wider text-[10px]">
                      <th className="px-4 py-2 font-bold">District</th>
                      <th className="px-2 py-2 font-bold">Pressure</th>
                      <th className="px-2 py-2 font-bold text-right">Open</th>
                      <th className="px-2 py-2 font-bold text-right">Hotspots</th>
                      <th className="px-2 py-2 font-bold text-right">Severity</th>
                      <th className="px-4 py-2 font-bold">Top pressure</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.districtDemand.map((d) => (
                      <tr key={`${d.state}-${d.district}`} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-4 py-2 font-bold text-slate-800 dark:text-slate-100 whitespace-nowrap">{d.district}</td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-2 min-w-[110px]">
                            <span className="font-bold w-6 text-slate-900 dark:text-white">{d.pressureScore}</span>
                            <span className="flex-1"><ScoreBar score={d.pressureScore} /></span>
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right font-mono">{d.openCount}</td>
                        <td className="px-2 py-2 text-right font-mono">{d.hotspotCount}</td>
                        <td className="px-2 py-2 text-right font-mono">{d.avgSeverity}</td>
                        <td className="px-4 py-2 text-slate-500 dark:text-slate-400 whitespace-nowrap">
                          {d.topCategories[0]?.name || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {data.recommendations.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex items-center space-x-2">
            <Sparkles className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Recommended priority projects
            </h3>
          </div>
          {data.recommendations.map((r) => (
            <article key={`rec-${r.rank}`} className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
              <div className="flex items-start gap-3">
                <span className="w-8 h-8 rounded-xl bg-indigo-600 text-white text-xs font-bold flex items-center justify-center shrink-0">
                  {r.rank}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-bold leading-snug">{r.title}</h4>
                    <span className={`shrink-0 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase ${PRIORITY_STYLES[r.priority] || PRIORITY_STYLES.low}`}>
                      {r.priority}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {r.department} · hotlink {r.hotspotId} · demand {r.demandScore}/100
                  </p>
                  <div className="mt-2.5"><ScoreBar score={r.demandScore} /></div>
                  <p className="mt-2.5 text-xs text-slate-600 dark:text-slate-300">{r.rationale}</p>
                  <p className="mt-1 text-[11px] text-emerald-700 dark:text-emerald-300">{r.estimatedImpact}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-bold">
                    <span className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">Est. {r.indicativeInvestment}</span>
                    <span className="px-2 py-1 rounded-lg bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300">{r.category}</span>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {data.hotspots.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex items-center space-x-2">
            <MapPinned className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Demand hotspots</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {data.hotspots.map((h) => (
              <div key={h.id} className="p-4 rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="text-sm font-bold truncate">{h.areaName}</h4>
                    <p className="text-[10px] font-mono text-slate-400">
                      {h.centroidLat.toFixed(4)}, {h.centroidLng.toFixed(4)} · r{h.radiusMeters}m
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-bold text-slate-900 dark:text-white">{h.demandScore}</span>
                </div>
                <div className="mt-2"><ScoreBar score={h.demandScore} /></div>
                <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
                  <span className="font-bold text-slate-700 dark:text-slate-200">{h.state}</span>
                  <span className="font-bold text-slate-700 dark:text-slate-200">{h.issueCount} issues</span>
                  <span>{h.totalUpvotes} upvotes</span>
                  <span>P{h.avgPriority.toFixed(1)}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {h.topCategories.map((c) => (
                    <span key={c.id} className="px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-[10px] font-bold text-slate-600 dark:text-slate-300">
                      {c.name} ×{c.count}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400 truncate">{h.leadingIssueTitle}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared row                                                           */
/* ------------------------------------------------------------------ */

function IssueRow({ issue, children }: { issue: Issue; children?: React.ReactNode }) {
  return (
    <article className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
      <div className="flex items-start space-x-3 p-3.5">
        {issue.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={issue.imageUrl} alt={issue.title} className="w-20 h-20 rounded-2xl object-cover flex-shrink-0" />
        ) : (
          <div className="w-20 h-20 rounded-2xl bg-slate-100 dark:bg-slate-800 flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold truncate">{issue.title}</h3>
            <StatusPill status={issue.status} />
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{issue.description}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500 dark:text-slate-400">
            <span className="font-mono">{issue.id}</span>
            <span>{issue.category.name}</span>
            {issue.priorityScore > 0 && <span>P{Math.round(issue.priorityScore)}</span>}
            {issue.assignedWorkerName && <span>→ {issue.assignedWorkerName}</span>}
            {issue.assignedDepartment && <span>· {issue.assignedDepartment}</span>}
          </div>
          {issue.transcript && (
            <p className="mt-1.5 text-[11px] text-emerald-800 dark:text-emerald-300 italic flex items-start space-x-1">
              <Mic className="w-3 h-3 flex-shrink-0 mt-0.5" />
              <span>“{issue.transcript}”</span>
            </p>
          )}
        </div>
      </div>
      {children && <div className="px-3.5 pb-3.5">{children}</div>}
    </article>
  );
}