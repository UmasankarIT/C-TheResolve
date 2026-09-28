'use client';

import React, { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { Navbar } from '@/components/Navbar';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { IssueFeed } from '@/components/IssueFeed';
import { AdminPortal } from '@/components/AdminPortal';
import { ReportModal } from '@/components/ReportModal';
import { AuthModal } from '@/components/AuthModal';
import { CitizenReports } from '@/components/CitizenReports';
import { StaffTasks } from '@/components/StaffTasks';
import { Issue, Category, LocationFix, SubmissionResponse, IssueStatus, AuthUser } from '@/lib/types';
import { AppTab, getMe, logout, fetchUnreadNotifications, tabAllowedForRole } from '@/lib/session';
import { Loader2, MapPin } from 'lucide-react';

// Dynamic import of CivicMap with SSR disabled to guarantee Leaflet executes only on client
const CivicMap = dynamic(() => import('@/components/CivicMap').then((mod) => mod.CivicMap), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[calc(100dvh-4rem-4rem)] md:h-[calc(100vh-4rem)] flex items-center justify-center bg-slate-950 text-slate-400">
      <div className="flex flex-col items-center space-y-2">
        <Loader2 className="w-8 h-8 animate-spin text-emerald-400" />
        <span className="text-xs font-medium">Booting PostGIS Spatial Radar...</span>
      </div>
    </div>
  ),
});

export default function HomePage() {
  const [session, setSession] = useState<AuthUser | null>(null);
  const [myReports, setMyReports] = useState<Issue[]>([]);
  const [activeTab, setActiveTab] = useState<AppTab>('map');
  const [issues, setIssues] = useState<Issue[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [isReportModalOpen, setIsReportModalOpen] = useState<boolean>(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [locStatus, setLocStatus] = useState<'requesting' | 'granted' | 'denied' | 'unsupported'>('requesting');
  const [userLocation, setUserLocation] = useState<LocationFix | null>(null);
  const [notificationsUnread, setNotificationsUnread] = useState<number>(0);

  // Restore the session (JWT cookie) on mount and clamp the tab to the role
  useEffect(() => {
    getMe().then((u) => {
      if (u) {
        setSession(u);
        setActiveTab((prev) => (tabAllowedForRole(u.role, prev) ? prev : 'map'));
      }
    });
  }, []);

  // The public feed no longer carries reporter identity, so a citizen's own
  // reports come from a separate endpoint that scopes by the session rather than
  // the client filtering the whole feed. Re-fetched whenever the identity
  // changes so a fresh sign-in and a sign-out cannot show stale rows.
  useEffect(() => {
    if (!session || session.role !== 'citizen') {
      setMyReports([]);
      return;
    }
    let cancelled = false;
    fetch('/api/citizen/my-reports')
      .then((res) => (res.ok ? res.json() : { reports: [] }))
      .then((data) => {
        if (!cancelled) setMyReports(data.reports || []);
      })
      .catch((err) => console.error('Failed to load your reports:', err));
    return () => {
      cancelled = true;
    };
  }, [session?.userId]);

  // Refetch the unread badge whenever the identity changes
  const refreshNotifications = useCallback(async () => {
    const unread = await fetchUnreadNotifications();
    setNotificationsUnread(unread);
  }, []);

  useEffect(() => {
    if (session) refreshNotifications();
  }, [session, refreshNotifications]);

  // Ask for location permission on first open — the whole app centres around the citizen's place
  const requestLocation = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocStatus('unsupported');
      return;
    }
    setLocStatus('requesting');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyMeters: pos.coords.accuracy,
        });
        setLocStatus('granted');
      },
      () => setLocStatus('denied'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  }, []);

  useEffect(() => {
    requestLocation();
  }, [requestLocation]);

  // Fetch live issues and categories
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/issues');
      if (res.ok) {
        const data = await res.json();
        setIssues(data.issues || []);
        setCategories(data.categories || []);
      }
    } catch (err) {
      console.error('Failed to load issues:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // --- Auth handlers -------------------------------------------------------
  const handleAuthChange = (user: AuthUser) => {
    setSession(user);
    setIsAuthModalOpen(false);
    setActiveTab((prev) => (tabAllowedForRole(user.role, prev) ? prev : 'map'));
    refreshNotifications();
  };

  const handleLogout = async () => {
    await logout();
    setSession(null);
    setActiveTab('map');
    setNotificationsUnread(0);
  };

  // Report + upvote require a signed-in citizen
  const openReportOrAuth = () => {
    if (!session) {
      setIsAuthModalOpen(true);
      return;
    }
    setIsReportModalOpen(true);
  };

  // Upvote an issue — server enforces citizen-only + 1 per citizen per report
  const handleUpvote = async (issueId: string) => {
    if (!session) {
      setIsAuthModalOpen(true);
      return;
    }
    try {
      const res = await fetch(`/api/issues/${issueId}/upvote`, {
        method: 'POST',
      });
      if (res.ok) {
        const data = await res.json();
        setIssues((prev) =>
          prev.map((iss) =>
            iss.id === issueId
              ? { ...iss, communityUpvotes: data.communityUpvotes, priorityScore: data.priorityScore }
              : iss
          )
        );
      } else if (res.status === 401 || res.status === 403) {
        setIsAuthModalOpen(true);
      }
    } catch (err) {
      console.error('Upvote failed:', err);
    }
  };

  // Status transitions — role assertions + department isolation are server-side
  const handleStatusUpdate = async (
    issueId: string,
    params: {
      status: IssueStatus;
      assignedWorkerName?: string;
      assignedDepartment?: string;
      departmentId?: string;
      resolutionNotes?: string;
      resolutionProofUrl?: string;
    }
  ) => {
    try {
      const res = await fetch(`/api/issues/${issueId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });

      if (res.ok) {
        const data = await res.json();
        setIssues((prev) => prev.map((iss) => (iss.id === issueId ? data.issue : iss)));
        refreshNotifications();
      }
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  };

  // Proof of work (department staff, before RESOLVED)
  const handleSubmitProof = async (
    issueId: string,
    payload: { photoUrl: string; notes: string; latitude?: number; longitude?: number }
  ) => {
    const res = await fetch(`/api/department/reports/${issueId}/proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Proof upload failed.');
    }
    await fetchData();
    refreshNotifications();
  };

  // Reassignment request (department staff)
  const handleReassignRequest = async (issueId: string, reason: string) => {
    const res = await fetch(`/api/department/reports/${issueId}/reassign-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) throw new Error('Reassignment request failed.');
    await fetchData();
  };

  // Merge duplicates (city admin)
  const handleMerge = async (secondaryId: string, primaryId: string) => {
    const res = await fetch(`/api/admin/reports/${secondaryId}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primaryIssueId: primaryId }),
    });
    if (!res.ok) throw new Error('Merge failed.');
    await fetchData();
    refreshNotifications();
  };

  const handleReportSubmitted = (result: SubmissionResponse) => {
    fetchData();
    refreshNotifications();
    // Return to map view to show the newly added or updated pin
    setActiveTab('map');
  };

  const handleSelectOnMap = (issue: Issue) => {
    setSelectedIssueId(issue.id);
    setActiveTab('map');
  };

  const totalActive = issues.filter(
    (i) => i.status !== 'resolved' && i.status !== 'rejected' && i.status !== 'merged'
  ).length;
  const inProgress = issues.filter((i) => i.status === 'in_progress' || i.status === 'assigned').length;
  const resolved = issues.filter((i) => i.status === 'resolved').length;

  const filteredMapIssues = issues.filter((iss) => {
    if (selectedCategory !== 'all' && iss.categoryId !== selectedCategory && iss.category.code !== selectedCategory) {
      return false;
    }
    if (selectedStatus !== 'all' && iss.status !== selectedStatus) {
      return false;
    }
    return true;
  });

  return (
    <main className="min-h-screen flex flex-col bg-slate-50 text-slate-900 dark:bg-[#0a0e17] dark:text-slate-100 selection:bg-emerald-500 selection:text-white transition-colors">
      {/* Universal Top App Bar */}
      <Navbar
        user={session}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onOpenReportModal={openReportOrAuth}
        onAuthClick={() => setIsAuthModalOpen(true)}
        onLogout={handleLogout}
        unreadNotifications={notificationsUnread}
        onNotificationsRead={refreshNotifications}
        stats={{ totalActive, inProgress, resolved }}
      />

      {/* Location permission banner — fires once, on first open */}
      {(locStatus === 'denied' || locStatus === 'unsupported') && (
        <div className="px-4 py-2 text-xs flex items-center justify-between gap-3
                        bg-amber-50 border-b border-amber-200 text-amber-800
                        dark:bg-amber-500/10 dark:border-amber-500/20 dark:text-amber-300">
          <span className="flex items-center space-x-1.5">
            <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
            <span>
              {locStatus === 'unsupported'
                ? 'This browser does not support location services.'
                : 'Location access is needed so your reports map to your exact place — allow it and retry.'}
            </span>
          </span>
          {locStatus === 'denied' && (
            <button
              onClick={requestLocation}
              className="shrink-0 px-3 py-1.5 rounded-full bg-amber-600 hover:bg-amber-500 text-white font-bold transition active:scale-95"
            >
              Enable Location
            </button>
          )}
        </div>
      )}

      {/* Guest / citizen call-to-action strip */}
      {!session && (
        <div className="px-4 py-2 text-xs flex items-center justify-between gap-3
                        bg-emerald-50 border-b border-emerald-200 text-emerald-800
                        dark:bg-emerald-500/10 dark:border-emerald-500/20 dark:text-emerald-300">
          <span>
            You are browsing as a guest —{' '}
            <b>sign in</b> to report hazards, upvote, track your tickets and get status notifications.
          </span>
          <button
            onClick={() => setIsAuthModalOpen(true)}
            className="shrink-0 px-3 py-1.5 rounded-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold transition active:scale-95"
          >
            Sign in
          </button>
        </div>
      )}

      {/* Main Viewport Container */}
      <div className="flex-1 flex flex-col relative">
        {/* Map stays mounted permanently (hidden when another tab is active) so
            its camera position, zoom and markers persist across tab switches
            instead of rebuilding from scratch on every visit. */}
        <div className={activeTab === 'map' ? 'flex-1 flex flex-col' : 'hidden flex-1 flex-col'}>
          <CivicMap
            issues={filteredMapIssues}
            categories={categories}
            selectedCategory={selectedCategory}
            onSelectCategory={setSelectedCategory}
            selectedStatus={selectedStatus}
            onSelectStatus={setSelectedStatus}
            onUpvote={handleUpvote}
            selectedIssueId={selectedIssueId}
            initialLocation={userLocation}
            locationStatus={locStatus}
          />
        </div>

        {activeTab === 'feed' && (
          <IssueFeed
            issues={issues}
            categories={categories}
            onUpvote={handleUpvote}
            onSelectOnMap={handleSelectOnMap}
          />
        )}

        {activeTab === 'my' && session?.role === 'citizen' && (
          <CitizenReports user={session} issues={myReports} onSelectOnMap={handleSelectOnMap} />
        )}

        {activeTab === 'tasks' && session?.role === 'department' && (
          <StaffTasks
            user={session}
            issues={issues}
            onStatusUpdate={handleStatusUpdate}
            onSubmitProof={handleSubmitProof}
            onReassignRequest={handleReassignRequest}
            onSelectOnMap={handleSelectOnMap}
          />
        )}

        {activeTab === 'admin' && session?.role === 'city_admin' && (
          <AdminPortal
            user={session}
            issues={issues}
            categories={categories}
            onStatusUpdate={handleStatusUpdate}
            onMerge={handleMerge}
          />
        )}

        {loading && activeTab !== 'map' && (
          <div className="flex-1 flex items-center justify-center text-xs text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
          </div>
        )}
      </div>

      {/* Mobile-Native Bottom Navigation Bar */}
      <MobileBottomNav
        user={session}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onOpenReport={openReportOrAuth}
        activeIncidentsCount={totalActive}
      />

      {/* Reporting Modal / Bottom Sheet */}
      <ReportModal
        isOpen={isReportModalOpen}
        onClose={() => setIsReportModalOpen(false)}
        categories={categories}
        onReportSubmitted={handleReportSubmitted}
        initialLocation={userLocation}
      />

      {/* Sign-in Modal (role-aware) */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onAuthChange={handleAuthChange}
      />
    </main>
  );
}