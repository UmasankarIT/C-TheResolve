'use client';

import React, { useEffect, useState } from 'react';
import type { DemandSignalJson } from '@/lib/demandSignals';
import { computeSpendingAlignment, type AlignmentRow } from '@/lib/spendingAlignment';
import { Loader2, Scale } from 'lucide-react';

/**
 * Demand vs planned public spending: development-request demand aggregated by
 * state next to the published allocation figures in /api/planned-spending.
 * The two shares are comparable only inside the set of states that have both,
 * which the maths in spendingAlignment enforces; a state with demand but no
 * published plan row is labelled as such instead of being drawn as zero
 * spending. If the cited spending dataset is not configured the panel says so
 * and shows no rupee numbers at all.
 */

type SpendingRow = {
  state: string;
  allocatedCrore: number;
  expenditureCrore: number;
  note: string | null;
};

type SpendingDataset = {
  available: boolean;
  reason?: string;
  rowCount: number;
  scheme: string | null;
  financialYear: string | null;
  source: string | null;
  sourceUrl: string | null;
  rows: SpendingRow[];
};

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function crore(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function gapText(value: number | null): string {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)} pp`;
}

const STATUS_BADGE: Record<AlignmentRow['status'], { label: string; hue: string }> = {
  no_plan_data: { label: 'no plan row', hue: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' },
  demand_higher: { label: 'demand share higher', hue: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' },
  plan_higher: { label: 'plan share higher', hue: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300' },
  balanced: { label: 'in line', hue: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300' },
};

export function SpendingAlignmentPanel() {
  const [signals, setSignals] = useState<DemandSignalJson[] | null>(null);
  const [spending, setSpending] = useState<SpendingDataset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [demandRes, spendRes] = await Promise.all([
          fetch('/api/demand-signals?intent=development_request'),
          fetch('/api/planned-spending'),
        ]);
        const demandJson = await demandRes.json();
        const spendJson = await spendRes.json();
        if (cancelled) return;
        setSignals(Array.isArray(demandJson.clusters) ? demandJson.clusters : []);
        setSpending(spendJson);
        if (!demandRes.ok || !spendRes.ok) setError('One of the sources failed to load.');
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = computeSpendingAlignment(
    (signals ?? []).map((cluster) => ({ state: cluster.location_state, volume: cluster.volume })),
    spending?.rows ?? []
  );

  const comparisonTotal = rows.filter((r) => r.status !== 'no_plan_data');
  const totalRequests = rows.reduce((sum, r) => sum + r.demandVolume, 0);
  const totalPlanned = comparisonTotal.reduce((sum, r) => sum + (r.allocatedCrore ?? 0), 0);

  return (
    <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
      <div className="flex items-start justify-between gap-3 p-4 border-b border-slate-100 dark:border-slate-800">
        <div className="min-w-0">
          <h3 className="text-sm font-bold flex items-center space-x-2">
            <Scale className="w-4 h-4 text-emerald-500" />
            <span>Demand vs planned spending</span>
          </h3>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            Development-request demand by state against published public investment plans.
          </p>
        </div>
        {spending?.available && (
          <span className="shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
            {spending.rowCount} plan rows
          </span>
        )}
      </div>

      <div className="p-4">
        {loading && (
          <div className="flex items-center space-x-2 py-6 justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-emerald-500" />
            <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">Loading alignment…</p>
          </div>
        )}

        {!loading && error && !spending && (
          <p className="text-sm text-rose-600 dark:text-rose-400">Could not load the alignment: {error}</p>
        )}

        {!loading && spending && !spending.available && (
          <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center">
            <p className="text-sm font-semibold">Planned-spending data not configured</p>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{spending.reason}</p>
            <p className="mt-2 text-[11px] text-slate-400">
              No rupee figures are shown rather than estimated. Add a cited dataset at database/data/planned_spending.csv to enable this panel.
            </p>
          </div>
        )}

        {!loading && spending?.available && signals !== null && rows.length === 0 && (
          <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 p-6 text-center">
            <p className="text-sm font-semibold">No development requests yet</p>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              File development requests in the field app; they will be compared against the published plan below.
            </p>
          </div>
        )}

        {!loading && spending?.available && rows.length > 0 && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mb-4">
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60">
                <p className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Requests compared</p>
                <p className="mt-0.5 text-lg font-bold">{totalRequests.toLocaleString('en-IN')}</p>
              </div>
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60">
                <p className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Plan allocation</p>
                <p className="mt-0.5 text-lg font-bold">₹{crore(totalPlanned)} cr</p>
              </div>
              <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60">
                <p className="text-[10px] uppercase tracking-wider font-bold text-slate-400">States compared</p>
                <p className="mt-0.5 text-lg font-bold">
                  {comparisonTotal.length} / {spending.rowCount}
                </p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-3 font-bold">State</th>
                    <th className="py-2 pr-3 font-bold text-right">Requests</th>
                    <th className="py-2 pr-3 font-bold text-right">Demand share</th>
                    <th className="py-2 pr-3 font-bold text-right">Planned (₹ cr)</th>
                    <th className="py-2 pr-3 font-bold text-right">Released (₹ cr)</th>
                    <th className="py-2 pr-3 font-bold text-right">Plan share</th>
                    <th className="py-2 pr-3 font-bold text-right">Gap</th>
                    <th className="py-2 font-bold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const badge = STATUS_BADGE[row.status];
                    return (
                      <tr key={row.state} className="border-t border-slate-100 dark:border-slate-800 align-top">
                        <td className="py-2.5 pr-3 font-bold">
                          {row.state}
                          {row.allocatedCrore !== null && row.allocatedCrore === 0 && row.demandVolume > 0 && (
                            <span className="block text-[10px] font-normal text-slate-400">
                              No central allocation recorded this year.
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pr-3 text-right">{row.demandVolume}</td>
                        <td className="py-2.5 pr-3 text-right font-mono">{pct(row.demandShare)}</td>
                        <td className="py-2.5 pr-3 text-right font-mono">{crore(row.allocatedCrore)}</td>
                        <td className="py-2.5 pr-3 text-right font-mono">{crore(row.expenditureCrore)}</td>
                        <td className="py-2.5 pr-3 text-right font-mono">{pct(row.spendShare)}</td>
                        <td className="py-2.5 pr-3 text-right font-mono font-bold">{gapText(row.gapPoints)}</td>
                        <td className="py-2.5">
                          <span className={`inline-flex px-2 py-1 rounded-lg text-[10px] font-bold whitespace-nowrap ${badge.hue}`}>
                            {badge.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {!loading && spending?.available && rows.length > 0 && (
        <div className="px-4 pb-4 space-y-1.5">
          <p className="text-[10px] text-slate-400 leading-relaxed">
            Shares are computed over states that have both recorded demand and a published plan row ({comparisonTotal.length}{' '}
            {comparisonTotal.length === 1 ? 'state' : 'states'}); gap = demand share − plan share in percentage points.
            Plan figures are state-grain — district-level allocations are not published for this scheme — so no state total is
            apportioned to districts here.
          </p>
          <p className="text-[10px] text-slate-400 leading-relaxed">
            Plan source: {spending.scheme ?? '—'}, FY {spending.financialYear ?? '—'} — {spending.source ?? '—'}.
            {spending.sourceUrl && (
              <>
                {' '}
                <a
                  href={spending.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline text-sky-600 dark:text-sky-400"
                >
                  View report
                </a>
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
