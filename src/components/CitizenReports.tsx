'use client';

import React from 'react';
import { Issue, AuthUser } from '@/lib/types';
import { TERMINAL_STATUSES } from '@/lib/workflow';
import { StatusPill } from './StatusPill';
import { MapPin, Clock, Mic, FileCheck2, TrendingUp, Inbox } from 'lucide-react';

interface CitizenReportsProps {
  user: AuthUser;
  // Scoped server-side by /api/citizen/my-reports from the session's own userId.
  // The public feed deliberately omits reporter identity, so this list is the
  // only source that carries it and must not be derived by filtering that feed.
  issues: Issue[];
  onSelectOnMap: (issue: Issue) => void;
}

export const CitizenReports: React.FC<CitizenReportsProps> = ({ user, issues, onSelectOnMap }) => {
  // Defensive only: the endpoint already filters by userId. Kept so a caller that
  // ever passes the wrong list cannot render another citizen's reports.
  const mine = issues.filter((i) => i.citizenUserId === user.userId);
  const active = mine.filter((i) => !TERMINAL_STATUSES.includes(i.status)).length;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-8 py-6 pb-28 md:pb-12 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold tracking-tight">My Reports</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {active} open · {mine.length} total — status updates land in your notifications.
          </p>
        </div>
        <StatusPill status="reported" />
      </div>

      {mine.length === 0 && (
        <div className="rounded-3xl border border-dashed border-slate-300 dark:border-slate-700 p-10 text-center">
          <Inbox className="w-10 h-10 mx-auto text-slate-300 dark:text-slate-600" />
          <p className="mt-3 text-sm font-semibold">No reports yet</p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Tap <b>Report Hazard</b> &mdash; snap a photo, pin the exact spot, and we&apos;ll route it to the right department.
          </p>
        </div>
      )}

      {mine.map((issue) => (
        <article
          key={issue.id}
          className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden transition hover:border-emerald-500/40"
        >
          <button
            onClick={() => onSelectOnMap(issue)}
            className="w-full text-left flex items-start space-x-3"
          >
            {issue.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={issue.imageUrl}
                alt={issue.title}
                className="w-24 h-24 sm:w-28 sm:h-28 object-cover flex-shrink-0"
              />
            ) : (
              <div className="w-24 h-24 sm:w-28 sm:h-28 bg-slate-100 dark:bg-slate-800 flex-shrink-0 flex items-center justify-center">
                <MapPin className="w-6 h-6 text-slate-300 dark:text-slate-600" />
              </div>
            )}
            <div className="min-w-0 flex-1 px-1 pt-2.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold truncate">{issue.title}</h3>
                <StatusPill status={issue.status} />
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2">
                {issue.description}
              </p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[10px] text-slate-500 dark:text-slate-400">
                <span className="flex items-center space-x-1 truncate max-w-[46%]">
                  <MapPin className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{issue.formattedAddress}</span>
                </span>
                <span className="flex items-center space-x-1">
                  <Clock className="w-3 h-3" />
                  <span>SLA {issue.slaDeadlineAt ? new Date(issue.slaDeadlineAt).toLocaleDateString() : 'on assignment'}</span>
                </span>
                <span className="flex items-center space-x-1">
                  <TrendingUp className="w-3 h-3" />
                  <span>P{Math.round(issue.priorityScore)}</span>
                </span>
              </div>
            </div>
          </button>

          {/* Voice note transcript — the recording itself is never stored */}
          {issue.transcript && (
            <div className="mx-3 mb-2 px-3 py-2 rounded-2xl bg-emerald-50/70 border border-emerald-200/70 dark:bg-emerald-500/5 dark:border-emerald-500/20">
              <p className="text-[11px] text-emerald-900 dark:text-emerald-300 flex items-start space-x-1.5">
                <Mic className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span className="italic">“{issue.transcript}”</span>
              </p>
            </div>
          )}

          {issue.status === 'resolved' && issue.proof && (
            <div className="mx-3 mb-3 px-3 py-2 rounded-2xl bg-emerald-50 border border-emerald-200 dark:bg-emerald-500/10 dark:border-emerald-500/30">
              <p className="text-[10px] font-bold text-emerald-700 dark:text-emerald-300 flex items-center space-x-1">
                <FileCheck2 className="w-3.5 h-3.5" />
                <span>Proof of work — resolved by {issue.proof.submittedBy}</span>
              </p>
              {issue.proof.photoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={issue.proof.photoUrl}
                  alt="After photo"
                  className="mt-2 w-full h-32 object-cover rounded-xl"
                />
              )}
              {issue.proof.notes && (
                <p className="text-[11px] text-slate-600 dark:text-slate-300 mt-1.5">{issue.proof.notes}</p>
              )}
            </div>
          )}
        </article>
      ))}
    </div>
  );
};