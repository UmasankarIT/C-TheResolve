'use client';

import React, { useRef, useState } from 'react';
import { Issue, AuthUser, IssueStatus } from '@/lib/types';
import { StatusPill } from './StatusPill';
import {
  MapPin,
  Clock,
  Mic,
  PlayCircle,
  Camera,
  ClipboardList,
  ArrowLeftRight,
  CheckCircle2,
  Loader2,
  FileCheck2,
} from 'lucide-react';

interface StaffTasksProps {
  user: AuthUser;
  issues: Issue[];
  onStatusUpdate: (
    issueId: string,
    params: { status: IssueStatus; resolutionNotes?: string; resolutionProofUrl?: string }
  ) => Promise<void>;
  onSubmitProof: (issueId: string, payload: { photoUrl: string; notes: string; latitude?: number; longitude?: number }) => Promise<void>;
  onReassignRequest: (issueId: string, reason: string) => Promise<void>;
  onSelectOnMap: (issue: Issue) => void;
}

export const StaffTasks: React.FC<StaffTasksProps> = ({
  user,
  issues,
  onStatusUpdate,
  onSubmitProof,
  onReassignRequest,
  onSelectOnMap,
}) => {
  const queue = issues.filter(
    (i) => i.departmentId === user.departmentId && (i.status === 'assigned' || i.status === 'in_progress')
  );
  const pendingReassign = issues.filter(
    (i) => i.departmentId === user.departmentId && i.reassignRequest
  ).length;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-8 py-6 pb-28 md:pb-12 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold tracking-tight">Department Queue</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {user.departmentId} · {user.jurisdictionCode || 'all wards'} — {queue.length} open tasks
            {pendingReassign > 0 && ` · ${pendingReassign} reassign request(s)`}
          </p>
        </div>
        <StatusPill status="in_progress" />
      </div>

      {queue.length === 0 && (
        <div className="rounded-3xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center">
          <ClipboardList className="w-10 h-10 mx-auto text-slate-300 dark:text-slate-600" />
          <p className="mt-3 text-sm font-semibold">Queue clear</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            New tickets routed to your department after admin verification will appear here.
          </p>
        </div>
      )}

      {queue.map((issue) => (
        <TaskCard
          key={issue.id}
          issue={issue}
          onStatusUpdate={onStatusUpdate}
          onSubmitProof={onSubmitProof}
          onReassignRequest={onReassignRequest}
          onSelectOnMap={onSelectOnMap}
        />
      ))}
    </div>
  );
};

function TaskCard({
  issue,
  onStatusUpdate,
  onSubmitProof,
  onReassignRequest,
  onSelectOnMap,
}: {
  issue: Issue;
  onStatusUpdate: StaffTasksProps['onStatusUpdate'];
  onSubmitProof: StaffTasksProps['onSubmitProof'];
  onReassignRequest: StaffTasksProps['onReassignRequest'];
  onSelectOnMap: (issue: Issue) => void;
}) {
  const [proofOpen, setProofOpen] = useState(false);
  const [proofPhoto, setProofPhoto] = useState<string>('');
  const [proofNotes, setProofNotes] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const readFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setProofPhoto(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  const handleProofSubmit = async () => {
    if (!proofPhoto) return;
    setBusy('proof');
    await onSubmitProof(issue.id, {
      photoUrl: proofPhoto,
      notes: proofNotes,
      latitude: issue.latitude,
      longitude: issue.longitude,
    });
    setBusy(null);
    setProofOpen(false);
    setProofNotes('');
  };

  const handleStart = async () => {
    setBusy('start');
    await onStatusUpdate(issue.id, { status: 'in_progress' });
    setBusy(null);
  };

  const handleResolve = async () => {
    setBusy('resolve');
    await onStatusUpdate(issue.id, { status: 'resolved', resolutionProofUrl: issue.proof?.photoUrl, resolutionNotes: issue.proof?.notes });
    setBusy(null);
  };

  const handleReassign = async () => {
    const reason = window.prompt('Reason for reassignment (e.g. miscategorised, wrong department):');
    if (!reason || reason.trim().length < 3) return;
    setBusy('reassign');
    await onReassignRequest(issue.id, reason.trim());
    setBusy(null);
  };

  return (
    <article className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden transition hover:border-emerald-500/40">
      <button onClick={() => onSelectOnMap(issue)} className="w-full text-left flex items-start space-x-3">
        {issue.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={issue.imageUrl} alt={issue.title} className="w-28 h-full min-h-[104px] object-cover flex-shrink-0" />
        ) : (
          <div className="w-28 h-[104px] bg-slate-100 dark:bg-slate-800 flex-shrink-0 flex items-center justify-center">
            <MapPin className="w-6 h-6 text-slate-300 dark:text-slate-600" />
          </div>
        )}
        <div className="min-w-0 flex-1 px-1 pt-2.5 pb-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold truncate">{issue.title}</h3>
            <StatusPill status={issue.status} />
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">{issue.description}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[10px] text-slate-500 dark:text-slate-400">
            <span className="flex items-center space-x-1 truncate max-w-[46%]">
              <MapPin className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{issue.formattedAddress}</span>
            </span>
            <span className="flex items-center space-x-1">
              <Clock className="w-3 h-3" />
              <span>SLA {issue.slaDeadlineAt ? new Date(issue.slaDeadlineAt).toLocaleString() : 'n/a'}</span>
            </span>
            <span className="flex items-center space-x-1">
              <MapPin className="w-3 h-3" />
              <span>{issue.jurisdictionCode || 'no ward'}</span>
            </span>
          </div>
        </div>
      </button>

      {/* Voice note transcript — the recording itself is never stored */}
      {issue.transcript && (
        <div className="mx-3 mb-2 px-3 py-2 rounded-2xl bg-sky-50/70 border border-sky-200/70 dark:bg-sky-500/5 dark:border-sky-500/20">
          <p className="text-[11px] text-sky-900 dark:text-sky-300 flex items-start space-x-1.5">
            <Mic className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span className="italic">“{issue.transcript}”</span>
          </p>
        </div>
      )}

      {/* Proof of work — required before RESOLVED */}
      <div className="px-3 pb-3 space-y-2">
        {!issue.proof && !proofOpen && (
          <button
            onClick={() => setProofOpen(true)}
            className="w-full py-2.5 rounded-xl border border-sky-500/30 text-sky-700 dark:text-sky-400 text-xs font-bold hover:bg-sky-500/10 transition flex items-center justify-center space-x-2"
          >
            <Camera className="w-4 h-4" />
            <span>Upload proof of work (after-photo)</span>
          </button>
        )}

        {proofOpen && !issue.proof && (
          <div className="p-3 rounded-2xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-2.5">
            <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => readFile(e.target.files?.[0])} />
            {proofPhoto ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={proofPhoto} alt="Proof preview" className="w-full h-36 object-cover rounded-xl" />
            ) : (
              <button
                onClick={() => fileRef.current?.click()}
                className="w-full py-8 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-xs font-semibold flex flex-col items-center space-y-1.5"
              >
                <Camera className="w-6 h-6" />
                <span>Capture / choose the after-photo</span>
              </button>
            )}
            <textarea
              value={proofNotes}
              onChange={(e) => setProofNotes(e.target.value)}
              rows={2}
              placeholder="Work done notes (optional)"
              className="w-full px-3 py-2.5 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 outline-none focus:border-emerald-500"
            />
            <div className="flex space-x-2">
              <button
                onClick={handleProofSubmit}
                disabled={!proofPhoto || busy === 'proof'}
                className="flex-1 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition disabled:opacity-50 flex items-center justify-center space-x-1.5"
              >
                {busy === 'proof' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                <span>Save proof</span>
              </button>
              <button
                onClick={() => {
                  setProofOpen(false);
                  setProofPhoto('');
                  setProofNotes('');
                }}
                className="px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 text-slate-500 text-xs font-bold"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {issue.proof && (
          <div className="p-3 rounded-2xl bg-emerald-50 border border-emerald-200 dark:bg-emerald-500/10 dark:border-emerald-500/30">
            <p className="text-[10px] font-bold text-emerald-700 dark:text-emerald-300 flex items-center space-x-1">
              <FileCheck2 className="w-3.5 h-3.5" />
              <span>Proof uploaded — {issue.proof.submittedAt ? new Date(issue.proof.submittedAt).toLocaleString() : 'recorded'}</span>
            </p>
            {issue.proof.photoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={issue.proof.photoUrl} alt="Proof of work" className="mt-2 w-full h-36 object-cover rounded-xl" />
            )}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {issue.status === 'assigned' && (
            <button
              onClick={handleStart}
              disabled={busy === 'start'}
              className="py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-bold transition disabled:opacity-50 flex items-center justify-center space-x-1.5"
            >
              {busy === 'start' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-4 h-4" />}
              <span>Start Work</span>
            </button>
          )}
          {issue.status === 'in_progress' && (
            <button
              onClick={handleResolve}
              disabled={!issue.proof || busy === 'resolve'}
              title={issue.proof ? 'Mark resolved' : 'Upload proof of work first (required)'}
              className="py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center space-x-1.5"
            >
              {busy === 'resolve' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              <span>Mark Resolved</span>
            </button>
          )}
          <button
            onClick={handleReassign}
            disabled={busy === 'reassign'}
            className="py-2.5 rounded-xl border border-amber-500/30 text-amber-700 dark:text-amber-400 text-xs font-bold hover:bg-amber-500/10 transition disabled:opacity-50 flex items-center justify-center space-x-1.5"
          >
            {busy === 'reassign' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowLeftRight className="w-4 h-4" />}
            <span>Request Reassignment</span>
          </button>
        </div>
      </div>
    </article>
  );
}