'use client';

import React, { useState } from 'react';
import { AuthUser } from '@/lib/types';
import { requestOtp, verifyOtp, loginDemo, signInWithFirebase } from '@/lib/session';
import { X, Smartphone, ShieldCheck, Building2, Loader2, CheckCircle2, Mail } from 'lucide-react';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAuthChange: (user: AuthUser) => void;
}

const DEMO_STAFF = [
  {
    label: 'Water Field Staff',
    sub: 'Water Supply & Sanitation (DEPT_WATER)',
    email: 'water@city.gov',
    password: 'demo1234',
    accent: 'text-sky-600 dark:text-sky-400',
  },
  {
    label: 'Roads Field Staff',
    sub: 'Public Works & Roads (DEPT_PWD)',
    email: 'roads@city.gov',
    password: 'demo1234',
    accent: 'text-amber-600 dark:text-amber-400',
  },
  {
    label: 'City Admin',
    sub: 'Super-admin console (city-wide)',
    email: 'admin@city.gov',
    password: 'admin1234',
    accent: 'text-rose-600 dark:text-rose-400',
  },
];

export const AuthModal: React.FC<AuthModalProps> = ({ isOpen, onClose, onAuthChange }) => {
  const [tab, setTab] = useState<'citizen' | 'staff'>('citizen');
  const [phone, setPhone] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [otp, setOtp] = useState('');
  const [demoOtp, setDemoOtp] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const reset = () => {
    setPhone('');
    setDisplayName('');
    setOtp('');
    setDemoOtp(null);
    setEmail('');
    setPassword('');
    setError(null);
    setBusy(false);
  };

  const handleSendOtp = async () => {
    const digits = phone.replace(/\D/g, '').slice(-10);
    if (digits.length !== 10) {
      setError('Enter a valid 10-digit mobile number.');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await requestOtp(digits);
    setBusy(false);
    if (!r.ok) {
      setError(r.error || 'Failed to send OTP.');
      return;
    }
    setDemoOtp(r.demoOtp || null);
  };

  const handleVerifyOtp = async () => {
    if (otp.trim().length !== 6) {
      setError('Enter the 6-digit OTP.');
      return;
    }
    setBusy(true);
    setError(null);
    const r = await verifyOtp(phone.replace(/\D/g, '').slice(-10), otp.trim(), displayName || undefined);
    setBusy(false);
    if (!r.ok || !r.user) {
      setError(r.error || 'OTP verification failed.');
      return;
    }
    reset();
    onAuthChange(r.user);
  };

  const handleDemoLogin = async (email: string, password: string) => {
    setBusy(true);
    setError(null);
    // Firebase Auth first (the identity provider), then the local password
    // path as fallback — so the demo keeps working even when Firebase is
    // unconfigured or its Email/Password provider is disabled.
    let r = await signInWithFirebase(email, password);
    if (!r.ok) r = await loginDemo(email, password);
    setBusy(false);
    if (!r.ok || !r.user) {
      setError(r.error || 'Sign-in failed.');
      return;
    }
    reset();
    onAuthChange(r.user);
  };

  const handleEmailLogin = async () => {
    if (!email.includes('@') || password.length < 4) {
      setError('Enter a valid email and password (4+ characters).');
      return;
    }
    setBusy(true);
    setError(null);
    // Implicit sign-up: a brand-new email/password pair creates the account.
    const r = await signInWithFirebase(email, password, displayName);
    setBusy(false);
    if (!r.ok || !r.user) {
      setError(r.error || 'Sign-in failed.');
      return;
    }
    reset();
    onAuthChange(r.user);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-md">
      <div className="relative w-full max-w-md rounded-3xl shadow-2xl overflow-hidden transition-colors
                      bg-white border border-slate-200 text-slate-900
                      dark:bg-slate-900 dark:border-slate-800 dark:text-slate-100">
        {/* Handle */}
        <div className="sm:hidden pt-3.5 pb-1 flex justify-center">
          <div className="w-12 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full" />
        </div>

        <button
          onClick={() => {
            reset();
            onClose();
          }}
          aria-label="Close sign in"
          className="absolute right-4 top-4 p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-slate-900 dark:hover:text-white transition"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="p-6 sm:p-7">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white flex items-center justify-center shadow-md shadow-emerald-500/20">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-lg leading-tight">One account per persona</h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Real access control — citizens, departments & the city admin get different rights.
              </p>
            </div>
          </div>

          {/* Persona tabs */}
          <div className="mt-5 grid grid-cols-2 p-1 rounded-2xl bg-slate-100 dark:bg-slate-800/80 text-xs font-bold">
            <button
              onClick={() => setTab('citizen')}
              className={`py-2.5 rounded-xl transition ${
                tab === 'citizen'
                  ? 'bg-white text-emerald-700 shadow-sm dark:bg-emerald-600 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              }`}
            >
              <Smartphone className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />
              Citizen (OTP)
            </button>
            <button
              onClick={() => setTab('staff')}
              className={`py-2.5 rounded-xl transition ${
                tab === 'staff'
                  ? 'bg-white text-emerald-700 shadow-sm dark:bg-emerald-600 dark:text-white'
                  : 'text-slate-500 hover:text-slate-800 dark:text-slate-400'
              }`}
            >
              <Building2 className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />
              Staff / Admin
            </button>
          </div>

          {error && (
            <div className="mt-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 dark:bg-rose-500/10 dark:border-rose-500/30 dark:text-rose-300 text-xs">
              {error}
            </div>
          )}

          {tab === 'citizen' ? (
            <div className="mt-5 space-y-4">
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
                  Mobile number
                </label>
                <div className="flex items-center rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3.5 focus-within:border-emerald-500 transition">
                  <span className="text-xs font-bold text-slate-400 mr-2">+91</span>
                  <input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, ''))}
                    inputMode="numeric"
                    maxLength={10}
                    placeholder="98765 43210"
                    className="w-full py-3 text-sm bg-transparent outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
                  Name (optional)
                </label>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="How should we address you?"
                  className="w-full py-3 px-3.5 text-sm rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none focus:border-emerald-500 transition"
                />
              </div>

              {!demoOtp ? (
                <button
                  onClick={handleSendOtp}
                  disabled={busy}
                  className="w-full py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold shadow-lg shadow-emerald-600/25 transition active:scale-95 disabled:opacity-50 flex items-center justify-center space-x-2"
                >
                  {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Smartphone className="w-4 h-4" />}
                  <span>Send OTP</span>
                </button>
              ) : (
                <div className="space-y-3 animate-in slide-in-from-bottom-2 duration-300">
                  <div className="p-3 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 dark:bg-emerald-500/10 dark:border-emerald-500/30 dark:text-emerald-300 text-xs flex items-start space-x-2">
                    <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>
                      OTP sent to <b>+91 {phone}</b>. Demo mode has no SMS provider — use{' '}
                      <span className="font-mono font-bold text-sm"> {demoOtp} </span>
                    </span>
                  </div>
                  <input
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/[^\d]/g, ''))}
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="6-digit OTP"
                    className="w-full py-3 px-3.5 text-center text-lg tracking-[0.5em] font-mono rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none focus:border-emerald-500 transition"
                  />
                  <button
                    onClick={handleVerifyOtp}
                    disabled={busy}
                    className="w-full py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold shadow-lg shadow-emerald-600/25 transition active:scale-95 disabled:opacity-50 flex items-center justify-center space-x-2"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                    <span>Verify & Sign in</span>
                  </button>
                </div>
              )}

              {/* Email sign-in through Firebase Auth — implicit sign-up for a
                  brand-new address, and a second way in when SMS isn't handy. */}
              <div className="pt-1">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-slate-400 font-bold">
                  <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                  <span>or continue with email</span>
                  <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                </div>
                <div className="mt-3 space-y-2.5">
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    className="w-full py-3 px-3.5 text-sm rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none focus:border-emerald-500 transition"
                  />
                  <input
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type="password"
                    autoComplete={email ? 'current-password' : 'new-password'}
                    placeholder="Password (new addresses are registered automatically)"
                    className="w-full py-3 px-3.5 text-sm rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 outline-none focus:border-emerald-500 transition"
                  />
                  <button
                    onClick={handleEmailLogin}
                    disabled={busy}
                    className="w-full py-3 rounded-2xl bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 text-sm font-bold transition active:scale-95 disabled:opacity-50 flex items-center justify-center space-x-2"
                  >
                    {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
                    <span>Sign in / register</span>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-5 space-y-2.5">
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                One-tap demo accounts. <b>Water</b> and <b>Roads</b> are separate departments — try signing into each
                to see cross-department 403 isolation.
              </p>
              {DEMO_STAFF.map((acct) => (
                <button
                  key={acct.email}
                  onClick={() => handleDemoLogin(acct.email, acct.password)}
                  disabled={busy}
                  className="w-full flex items-center justify-between p-3.5 rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 hover:bg-slate-100 dark:bg-slate-950 dark:hover:bg-slate-800/70 transition text-left"
                >
                  <div className="min-w-0">
                    <span className={`block text-xs font-bold ${acct.accent}`}>{acct.label}</span>
                    <span className="block text-[11px] text-slate-500 dark:text-slate-400 truncate">{acct.sub}</span>
                  </div>
                  <span className="shrink-0 ml-3 text-[11px] font-bold px-2.5 py-1.5 rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                    Sign in →
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};