'use client';

import React, { useEffect, useRef, useState } from 'react';
import { AuthUser } from '@/lib/types';
import { AppTab, tabsForRole } from '@/lib/session';
import { ThemeToggle } from './ThemeToggle';
import { NotificationsBell } from './NotificationsBell';
import {
  ShieldCheck,
  Map as MapIcon,
  List,
  ClipboardList,
  UserRound,
  Building2,
  Plus,
  LogOut,
  KeyRound,
  ChevronDown,
  Mail,
  Phone,
  MapPin,
} from 'lucide-react';

interface NavbarProps {
  user: AuthUser | null;
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  onOpenReportModal: () => void;
  onAuthClick: () => void;
  onLogout: () => void;
  unreadNotifications: number;
  onNotificationsRead?: () => void;
  stats: {
    totalActive: number;
    inProgress: number;
    resolved: number;
  };
}

const TAB_META: Record<AppTab, { label: string; icon: React.ReactNode }> = {
  map: { label: 'Map View', icon: <MapIcon className="w-4 h-4" /> },
  feed: { label: 'Incident Stream', icon: <List className="w-4 h-4" /> },
  my: { label: 'My Reports', icon: <UserRound className="w-4 h-4" /> },
  tasks: { label: 'My Tasks', icon: <ClipboardList className="w-4 h-4" /> },
  admin: { label: 'Command Console', icon: <Building2 className="w-4 h-4" /> },
};

const ROLE_LABEL: Record<AuthUser['role'], string> = {
  citizen: 'Citizen',
  department: 'Department Staff',
  city_admin: 'City Admin',
};

export const Navbar: React.FC<NavbarProps> = ({
  user,
  activeTab,
  onTabChange,
  onOpenReportModal,
  onAuthClick,
  onLogout,
  unreadNotifications,
  onNotificationsRead,
  stats,
}) => {
  const navTabs = tabsForRole(user?.role ?? null);

  // Account details + sign-out live in a dropdown that only opens on click.
  const [accountMenuOpen, setAccountMenuOpen] = useState<boolean>(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAccountMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [accountMenuOpen]);

  return (
    <header className="sticky top-0 z-40 w-full border-b backdrop-blur-2xl transition-colors
                       bg-white/85 border-slate-200/80 
                       dark:bg-slate-950/85 dark:border-slate-800/80">
      <div className="flex items-center justify-between h-16 sm:h-20 px-6">

          {/* Left: Brand & Metadata */}
          <div className="flex items-center flex-1 justify-start min-w-0 space-x-3.5">
            <div className="relative flex items-center justify-center w-10 h-10 sm:w-11 sm:h-11 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white shadow-md shadow-emerald-500/20">
              <ShieldCheck className="w-5 h-5 sm:w-6 sm:h-6 stroke-[2.2]" />
              <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-bold text-lg sm:text-xl tracking-tight text-slate-900 dark:text-white">
                  C - TheResolve
                </span>
                <span className="hidden sm:inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  RBAC · 3-Tier
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 hidden sm:block">
                Community Infrastructure & Dynamic Deduplication
              </p>
            </div>
          </div>

          {/* Middle: View Switchers */}
          <nav className="hidden md:flex items-center flex-shrink-0 p-1.5 rounded-2xl border transition-colors
                          bg-slate-100/90 border-slate-200/80 
                          dark:bg-slate-900/80 dark:border-slate-800">
            {navTabs.map((tab) => {
              const meta = TAB_META[tab];
              const isActive = activeTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => onTabChange(tab)}
                  className={`flex items-center space-x-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
                    isActive
                      ? 'bg-white dark:bg-emerald-600 text-emerald-700 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {meta.icon}
                  <span>{meta.label}</span>
                  {tab === 'admin' && stats.totalActive > 0 && (
                    <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-500/20 text-amber-700 dark:text-amber-300 font-mono font-bold">
                      {stats.totalActive}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Right: Primary Actions & Auth */}
          <div className="flex items-center flex-1 justify-end min-w-0 space-x-2.5">
            {/* Notification panel — opens the real list, never the sign-in modal */}
            {user && (
              <NotificationsBell unread={unreadNotifications} onMarkRead={onNotificationsRead} />
            )}

            {/* Theme Toggle */}
            <ThemeToggle />

            {/* Report CTA */}
            <button
              onClick={onOpenReportModal}
              className="hidden sm:flex items-center space-x-2 px-4 py-2.5 rounded-xl text-xs font-bold transition active:scale-95 bg-emerald-600 text-white hover:bg-emerald-500 shadow-md shadow-emerald-600/25"
            >
              <Plus className="w-4 h-4" />
              <span>Report Hazard</span>
            </button>

            {/* Account chip — role-aware. Clicking opens a details + sign-out menu */}
            {user ? (
              <div ref={accountMenuRef} className="relative">
                <button
                  onClick={() => setAccountMenuOpen((o) => !o)}
                  aria-haspopup="menu"
                  aria-expanded={accountMenuOpen}
                  className="flex items-center space-x-2 pl-2.5 pr-2 py-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 hover:border-emerald-500/40 transition max-w-[160px]"
                >
                  <span className="w-6 h-6 flex-shrink-0 rounded-full bg-gradient-to-tr from-emerald-600 to-teal-500 text-white text-[10px] font-bold flex items-center justify-center">
                    {user.name.trim().charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 text-left">
                    <span className="block text-[11px] font-bold text-slate-800 dark:text-slate-100 truncate">
                      {user.name}
                    </span>
                    <span className="block text-[9px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400 font-semibold">
                      {ROLE_LABEL[user.role]}
                    </span>
                  </span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 flex-shrink-0 text-slate-400 transition-transform ${
                      accountMenuOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                {accountMenuOpen && (
                  <div className="absolute right-0 top-full mt-2 w-64 z-50 rounded-2xl border shadow-2xl backdrop-blur-xl overflow-hidden
                                  bg-white/95 border-slate-200 text-slate-800
                                  dark:bg-slate-900/95 dark:border-slate-800 dark:text-slate-100">
                    <div className="p-4 space-y-3">
                      <div className="flex items-center space-x-3">
                        <span className="w-10 h-10 flex-shrink-0 rounded-full bg-gradient-to-tr from-emerald-600 to-teal-500 text-white text-sm font-bold flex items-center justify-center">
                          {user.name.trim().charAt(0).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm font-bold truncate">{user.name}</p>
                          <p className="text-[10px] uppercase tracking-wide text-emerald-600 dark:text-emerald-400 font-semibold">
                            {ROLE_LABEL[user.role]}
                          </p>
                        </div>
                      </div>

                      <div className="space-y-1.5 text-xs">
                        {user.email && (
                          <p className="flex items-center space-x-2 text-slate-500 dark:text-slate-400 truncate">
                            <Mail className="w-3.5 h-3.5 flex-shrink-0" />
                            <span className="truncate">{user.email}</span>
                          </p>
                        )}
                        {user.phone && (
                          <p className="flex items-center space-x-2 text-slate-500 dark:text-slate-400">
                            <Phone className="w-3.5 h-3.5 flex-shrink-0" />
                            <span>+91 {user.phone}</span>
                          </p>
                        )}
                        <p className="flex items-center space-x-2 text-slate-500 dark:text-slate-400">
                          <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                          <span>{user.jurisdictionCode || 'All areas'}</span>
                        </p>
                      </div>
                    </div>

                    <div className="border-t border-slate-100 dark:border-slate-800 p-2">
                      <button
                        onClick={onLogout}
                        className="w-full flex items-center justify-center space-x-2 px-3 py-2 rounded-xl text-xs font-bold transition active:scale-95 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:bg-rose-500/10 dark:text-rose-400 dark:hover:bg-rose-500/20"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        <span>Sign out</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={onAuthClick}
                className="flex items-center space-x-2 px-3.5 py-2.5 rounded-xl text-xs font-bold transition active:scale-95 border border-emerald-500/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10"
              >
                <KeyRound className="w-4 h-4" />
                <span>Sign in</span>
              </button>
            )}
          </div>
        </div>
    </header>
  );
};