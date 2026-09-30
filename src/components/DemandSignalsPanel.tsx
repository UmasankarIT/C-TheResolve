'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type * as L from 'leaflet';
import type { DemandSignalJson, IntentFilter } from '@/lib/demandSignals';
import { Loader2, MapPinned, X, ChevronDown } from 'lucide-react';

/**
 * Priority-ranked clusters from the Step 3-5 pipeline: a Leaflet map sized and
 * coloured by priority_score, the ranked list beside it, and a drill-down that
 * shows the score's four weighted components and the original complaints
 * (original language + translation side by side) that produced each cluster.
 * Every number on screen comes from the public /api/demand-signals endpoints.
 */

type MapMarker = {
  cluster_id: string;
  issue_type: string;
  location: string;
  location_state: string | null;
  location_district: string | null;
  volume: number;
  priority_score: number | null;
  latitude: number | null;
  longitude: number | null;
};

type MemberComplaint = {
  complaint_id: string;
  issue_type: string;
  location: string;
  urgency_score: number;
  urgency_reason: string | null;
  original_language: string;
  original_text: string;
  translated_text: string;
};

type DemandSignalDetail = DemandSignalJson & { member_complaints: MemberComplaint[] };

function scoreHue(score: number | null): string {
  if (score === null) return 'bg-slate-400';
  if (score >= 0.7) return 'bg-rose-500';
  if (score >= 0.4) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function scoreText(score: number | null): string {
  return score === null ? '—' : score.toFixed(3);
}

function bandLabel(score: number | null): string {
  if (score === null) return 'unscored';
  if (score >= 0.7) return 'High';
  if (score >= 0.4) return 'Medium';
  return 'Low';
}

function formatAffected(value: number | null): string {
  if (value === null) return 'No population data';
  if (value >= 1_000_000) return `~${(value / 1_000_000).toFixed(2)} million residents`;
  return `~${value.toLocaleString('en-IN')} residents`;
}

function ComponentBar({ label, note, value, weight }: { label: string; note: string; value: number | null; weight: number }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-bold text-slate-700 dark:text-slate-200">{label}</span>
        <span className="text-slate-500 dark:text-slate-400">{note}</span>
      </div>
      <div className="mt-1 h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
        <div
          className="h-full rounded-full bg-sky-500"
          style={{ width: `${value === null ? 0 : Math.max(4, value * 100)}%`, opacity: value === null ? 0.25 : 1 }}
        />
      </div>
      <p className="mt-1 text-[10px] text-slate-400">weight {weight.toFixed(3)} in the score</p>
    </div>
  );
}

function DrillDownPanel({ signal, onClose }: { signal: DemandSignalDetail; onClose: () => void }) {
  const breakdown = signal.priority_breakdown;
  return (
    <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
      <div className="flex items-start justify-between gap-3 p-4 border-b border-slate-100 dark:border-slate-800">
        <div className="min-w-0">
          <p className="font-mono text-[10px] text-slate-400">{signal.cluster_id}</p>
          <h3 className="text-sm font-bold truncate">
            {signal.issue_type} · {signal.location}
          </h3>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
            {signal.volume} {signal.volume === 1 ? 'report' : 'reports'} · avg urgency {signal.avg_urgency.toFixed(1)}/5 ·{' '}
            {formatAffected(signal.population_affected)}
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <span className={`shrink-0 inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold ${scoreHue(signal.priority_score)}`}>
            <span>{bandLabel(signal.priority_score)}</span>
            <span className="font-mono">{scoreText(signal.priority_score)}</span>
          </span>
          <button onClick={onClose} className="p-1.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Close drill-down">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="p-4 space-y-4">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Why this is ranked here</p>
          <p className="mt-1.5 text-[13px] text-slate-700 dark:text-slate-200">{signal.priority_explanation}</p>
        </div>

        {breakdown && (
          <div>
            <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Score breakdown · each term you can verify by hand</p>
            <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <ComponentBar
                label="Reporting volume"
                note={`${signal.volume} ${signal.volume === 1 ? 'report' : 'reports'} → ${breakdown.normalized_volume.toFixed(3)}`}
                value={breakdown.normalized_volume}
                weight={breakdown.weights.volume}
              />
              <ComponentBar
                label="Urgency"
                note={`avg ${signal.avg_urgency.toFixed(1)}/5 → ${breakdown.normalized_avg_urgency.toFixed(3)}`}
                value={breakdown.normalized_avg_urgency}
                weight={breakdown.weights.avg_urgency}
              />
              <ComponentBar
                label="Infrastructure gap"
                note={
                  breakdown.infrastructure_gap_score === null
                    ? 'no data for this district'
                    : `${(signal.existing_infrastructure_gap ?? 0).toFixed(1)}% households → ${breakdown.infrastructure_gap_score.toFixed(3)}`
                }
                value={breakdown.infrastructure_gap_score}
                weight={breakdown.weights.infrastructure_gap}
              />
              <ComponentBar
                label="Population affected"
                note={
                  breakdown.normalized_population_affected === null
                    ? 'no population data'
                    : `${formatAffected(signal.population_affected)} → ${breakdown.normalized_population_affected.toFixed(3)}`
                }
                value={breakdown.normalized_population_affected}
                weight={breakdown.weights.population_affected}
              />
            </div>
            {signal.data_unavailable && (
              <p className="mt-2 text-[10px] text-amber-700 dark:text-amber-300">
                This district has no reference population or infrastructure data — the score uses only the terms that exist and reweights the rest.
              </p>
            )}
          </div>
        )}

        <div>
          <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Original reports behind this cluster</p>
          {signal.member_complaints.length === 0 ? (
            <p className="mt-2 text-[11px] text-slate-500">No source complaints could be resolved.</p>
          ) : (
            <div className="mt-2.5 space-y-2">
              {signal.member_complaints.map((c) => (
                <div key={c.complaint_id} className="rounded-2xl border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3">
                  <div className="flex items-center justify-between gap-2 text-[10px] text-slate-500 dark:text-slate-400">
                    <span className="font-mono">{c.complaint_id}</span>
                    <span>
                      {c.issue_type} · urgency {c.urgency_score}/5
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[12px]">
                    <div className="rounded-xl bg-white dark:bg-slate-900 p-2.5">
                      <p className="text-[9px] uppercase tracking-wider font-bold text-slate-400">{c.original_language} (as spoken)</p>
                      <p className="mt-1 text-slate-800 dark:text-slate-100">{c.original_text}</p>
                    </div>
                    <div className="rounded-xl bg-white dark:bg-slate-900 p-2.5">
                      <p className="text-[9px] uppercase tracking-wider font-bold text-slate-400">English (translated)</p>
                      <p className="mt-1 text-slate-800 dark:text-slate-100">{c.translated_text}</p>
                      {c.urgency_reason && <p className="mt-1 text-[10px] italic text-slate-500">“{c.urgency_reason}”</p>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DemandSignalMap({
  markers,
  onSelect,
  selectedId,
}: {
  markers: MapMarker[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const latestRef = useRef<{ markers: MapMarker[]; selectedId: string | null }>({ markers, selectedId });
  latestRef.current = { markers, selectedId };

  // Create the map once. Leaflet is loaded by an async import so it never runs
  // during SSR; the same keyless OSM tiles the citizen map uses (CARTO now
  // demands a key). The layer is redrawn on every prop change below.
  useEffect(() => {
    let disposed = false;
    let leaflet: typeof import('leaflet') | null = null;
    import('leaflet').then((L) => {
      if (disposed || !containerRef.current) return;
      leaflet = L;
      const map = L.map(containerRef.current, {
        center: [20.5937, 78.9629],
        zoom: 5,
        zoomControl: false,
      });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 18,
      }).addTo(map);
      L.control.zoom({ position: 'bottomright' }).addTo(map);
      instanceRef.current = map;
      layerRef.current = L.layerGroup().addTo(map);
      draw(L, latestRef.current.markers, latestRef.current.selectedId);
    });
    return () => {
      disposed = true;
      instanceRef.current?.remove();
      instanceRef.current = null;
      layerRef.current = null;
      void leaflet;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const draw = useCallback((L: typeof import('leaflet'), markers: MapMarker[], selectedId: string | null) => {
    const group = layerRef.current;
    const map = instanceRef.current;
    if (!group || !map) return;
    group.clearLayers();
    const placed = markers.filter((m) => m.latitude !== null && m.longitude !== null);
    for (const m of placed) {
      const score = m.priority_score ?? 0;
      const radius = 6 + score * 18;
      const hue = score >= 0.7 ? '#f43f5e' : score >= 0.4 ? '#f59e0b' : '#10b981';
      const circle = L.circleMarker([m.latitude as number, m.longitude as number], {
        radius,
        color: selectedId === m.cluster_id ? '#0ea5e9' : hue,
        weight: selectedId === m.cluster_id ? 3 : 2,
        fillColor: hue,
        fillOpacity: selectedId === m.cluster_id ? 0.55 : 0.4,
        opacity: 1,
      }).addTo(group);
      circle.bindTooltip(`${m.cluster_id} · ${m.issue_type} · priority ${scoreText(m.priority_score)}`, { direction: 'top' });
      circle.on('click', () => onSelect(m.cluster_id));
    }
    if (placed.length > 0) {
      map.fitBounds(
        L.latLngBounds(placed.map((m) => [m.latitude as number, m.longitude as number] as [number, number])),
        { padding: [28, 28], maxZoom: 11 }
      );
    }
  }, [onSelect]);

  useEffect(() => {
    if (!instanceRef.current) return;
    import('leaflet').then((L) => draw(L, markers, selectedId));
  }, [markers, selectedId, draw]);

  return (
    <div className="relative rounded-3xl overflow-hidden border border-slate-200 dark:border-slate-800">
      <div ref={containerRef} className="h-[320px] w-full z-0" />
      <div className="absolute top-2.5 left-2.5 z-[500] rounded-xl bg-white/95 dark:bg-slate-900/95 backdrop-blur px-3 py-1.5 text-[10px] font-bold text-slate-600 dark:text-slate-300 shadow">
        {markers.filter((m) => m.latitude !== null).length}/{markers.length} clusters plotted · size &amp; colour = priority score
      </div>
    </div>
  );
}

/** Two peer views of the same pipeline: what is broken vs what is missing. */
function IntentTabs({
  value,
  onChange,
}: {
  value: Exclude<IntentFilter, 'all'>;
  onChange: (next: Exclude<IntentFilter, 'all'>) => void;
}) {
  const tabs: { key: Exclude<IntentFilter, 'all'>; label: string }[] = [
    { key: 'complaint', label: 'Civic problems' },
    { key: 'development_request', label: 'Development requests' },
  ];
  return (
    <div className="flex rounded-full bg-slate-100 dark:bg-slate-800 p-1 w-fit text-[11px] font-bold">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onChange(tab.key)}
          className={`px-4 py-1.5 rounded-full transition ${
            value === tab.key
              ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-white shadow-sm'
              : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function DemandSignalsPanel() {
  const [list, setList] = useState<DemandSignalJson[] | null>(null);
  const [markers, setMarkers] = useState<MapMarker[]>([]);
  const [detail, setDetail] = useState<DemandSignalDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Two peer views: today's problems vs demands for what does not exist yet.
  // Complaints are the default view; requests are one tab away.
  const [intentFilter, setIntentFilter] = useState<Exclude<IntentFilter, 'all'>>('complaint');

  // `load` is deliberately stable so a tab change is its only trigger besides
  // mount and the Refresh button — it reads the live values through refs
  // instead of closing over them, which would re-run it on every detail
  // change (detail is set by load itself, so that would loop).
  const intentFilterRef = useRef(intentFilter);
  intentFilterRef.current = intentFilter;
  const detailIdRef = useRef<string | null>(null);
  detailIdRef.current = detail?.cluster_id ?? null;

  const loadDetail = useCallback(async (signalId: string) => {
    setDetail(null);
    try {
      const res = await fetch(`/api/demand-signals/${encodeURIComponent(signalId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load cluster detail.');
      setDetail((await res.json()) as DemandSignalDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const intent = intentFilterRef.current;
      const query = `?intent=${intent}`;
      const [listRes, mapRes] = await Promise.all([
        fetch(`/api/demand-signals${query}`, { cache: 'no-store' }),
        fetch(`/api/demand-signals/map${query}`, { cache: 'no-store' }),
      ]);
      if (!listRes.ok) throw new Error('Failed to load ranked demand signals.');
      const listJson = await listRes.json();
      const mapJson = mapRes.ok ? await mapRes.json() : { markers: [] as MapMarker[] };
      const clusters = (listJson.clusters ?? []) as DemandSignalJson[];
      setList(clusters);
      setMarkers((mapJson.markers as MapMarker[]) ?? []);
      // If a drill-down was open: refresh it when the cluster still exists in
      // this view, close it when the tab switch left it behind.
      const open = detailIdRef.current;
      if (open) {
        if (clusters.some((c) => c.cluster_id === open)) loadDetail(open);
        else setDetail(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setList(null);
    } finally {
      setLoading(false);
    }
  }, [loadDetail]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentFilter]);

  const selectCluster = useCallback(
    (signalId: string) => {
      if (detail?.cluster_id === signalId) {
        setDetail(null);
        return;
      }
      loadDetail(signalId);
    },
    [detail, loadDetail]
  );

  if (loading && !list) {
    return (
      <div className="rounded-3xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center flex items-center justify-center space-x-2">
        <Loader2 className="w-5 h-5 animate-spin text-emerald-500" />
        <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">Loading ranked demand signals…</p>
      </div>
    );
  }

  if (error && !list) {
    return (
      <div className="rounded-3xl border border-dashed border-rose-300 dark:border-rose-500/40 p-8 text-center">
        <p className="text-sm font-semibold text-rose-600 dark:text-rose-300">{error}</p>
        <button onClick={load} className="mt-3 text-xs font-bold text-emerald-600 dark:text-emerald-400 hover:underline">
          Retry
        </button>
      </div>
    );
  }

  if (!list || list.length === 0) {
    return (
      <div className="space-y-4">
        <IntentTabs value={intentFilter} onChange={setIntentFilter} />
        <div className="rounded-3xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center">
          <MapPinned className="w-10 h-10 mx-auto text-slate-300 dark:text-slate-600" />
          <p className="mt-3 text-sm font-semibold">
            {intentFilter === 'development_request'
              ? 'No development requests clustered yet'
              : 'No demand signals yet'}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            {error ??
              (intentFilter === 'development_request'
                ? 'Citizens can submit development requests from the report form; cluster them with a build.'
                : 'Run a build to cluster reports and rank them by priority.')}
          </p>
        </div>
      </div>
    );
  }

  const totalComplaints = list.reduce((sum, s) => sum + s.volume, 0);
  const volumeNoun = intentFilter === 'development_request' ? 'requests' : 'complaints';

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3 text-[11px] text-amber-800 dark:text-amber-200">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center space-x-2">
          <MapPinned className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Demand signals · priority-ranked</h3>
        </div>
        <button onClick={load} className="shrink-0 inline-flex items-center space-x-1.5 rounded-full px-3 py-1.5 text-[10px] font-bold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition">
          <Loader2 className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          <span>Refresh</span>
        </button>
      </div>

      <IntentTabs value={intentFilter} onChange={setIntentFilter} />

      <DemandSignalMap markers={markers} onSelect={selectCluster} selectedId={detail?.cluster_id ?? null} />

      {detail && <DrillDownPanel signal={detail} onClose={() => setDetail(null)} />}

      <div className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800">
          <p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
            Ranked list · {list.length} clusters · {totalComplaints} {volumeNoun} · highest priority first
          </p>
          <span className="text-[10px] text-slate-400">click a row to drill down</span>
        </div>
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {list.map((signal, idx) => {
            const isSelected = detail?.cluster_id === signal.cluster_id;
            return (
              <li key={signal.cluster_id}>
                <button onClick={() => selectCluster(signal.cluster_id)} className="w-full text-left p-4 hover:bg-slate-50 dark:hover:bg-slate-950 transition">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center space-x-2">
                        <span className="font-mono text-[10px] text-slate-400 w-8 shrink-0">{idx + 1}.</span>
                        <span className="font-mono text-[10px] text-slate-400">{signal.cluster_id}</span>
                        <span className="text-[11px] font-bold text-slate-800 dark:text-slate-100 truncate">{signal.issue_type}</span>
                      </div>
                      <p className="mt-1.5 pl-10 text-[11px] text-slate-600 dark:text-slate-300 leading-relaxed">{signal.priority_explanation}</p>
                      <div className="mt-1.5 pl-10 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-slate-500 dark:text-slate-400">
                        <span>
                          {signal.volume} {signal.volume === 1 ? 'report' : 'reports'}
                        </span>
                        <span>urgency {signal.avg_urgency.toFixed(1)}/5</span>
                        {signal.existing_infrastructure_gap !== null && <span>gap {signal.existing_infrastructure_gap.toFixed(1)}%</span>}
                        {signal.population_affected !== null && <span>{formatAffected(signal.population_affected)}</span>}
                        {signal.data_unavailable && <span className="text-amber-600 dark:text-amber-400">no reference data</span>}
                      </div>
                    </div>
                    <div className="shrink-0 flex flex-col items-end">
                      <div className="h-2 w-16 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                        <div className={`h-full rounded-full ${scoreHue(signal.priority_score)}`} style={{ width: `${(signal.priority_score ?? 0) * 100}%` }} />
                      </div>
                      <span className="mt-1 font-mono text-[11px] font-bold text-slate-800 dark:text-slate-100">{scoreText(signal.priority_score)}</span>
                      <span className="text-[9px] uppercase tracking-wider text-slate-400">{bandLabel(signal.priority_score)}</span>
                      {isSelected && <ChevronDown className="w-3.5 h-3.5 mt-1 text-sky-500" />}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <p className="text-[10px] text-slate-400 leading-relaxed">
        Every score is a weighted sum you can recompute from the numbers shown: volume and population are min-max normalised across the current
        cluster set, urgency maps (x−1)/4, and the infrastructure gap is a household-share percentage. Missing reference data drops that term and
        reweights the rest — it is never zeroed or guessed.
      </p>
    </div>
  );
}