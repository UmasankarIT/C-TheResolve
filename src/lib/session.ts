'use client';

import { AuthUser } from './types';

export type AppTab = 'map' | 'feed' | 'my' | 'tasks' | 'admin';

export function tabsForRole(role: AuthUser['role'] | null): AppTab[] {
  switch (role) {
    case 'citizen':
      return ['map', 'feed', 'my'];
    case 'department':
      return ['map', 'feed', 'tasks'];
    case 'city_admin':
      return ['map', 'feed', 'admin'];
    default:
      return ['map', 'feed'];
  }
}

export function tabAllowedForRole(role: AuthUser['role'] | null, tab: AppTab): boolean {
  return tabsForRole(role).includes(tab);
}

export async function getMe(): Promise<AuthUser | null> {
  try {
    const res = await fetch('/api/auth/me', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.user as AuthUser) || null;
  } catch {
    return null;
  }
}

export async function requestOtp(phone: string): Promise<{ ok: boolean; demoOtp?: string; error?: string }> {
  try {
    const res = await fetch('/api/auth/otp/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || 'Failed to send OTP.' };
    return { ok: true, demoOtp: data.demoOtp };
  } catch {
    return { ok: false, error: 'Network error while requesting OTP.' };
  }
}

export async function verifyOtp(
  phone: string,
  otp: string,
  displayName?: string
): Promise<{ ok: boolean; user?: AuthUser; error?: string }> {
  try {
    const res = await fetch('/api/auth/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, otp, displayName }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || 'OTP verification failed.' };
    return { ok: true, user: data.user as AuthUser };
  } catch {
    return { ok: false, error: 'Network error during OTP verification.' };
  }
}

export async function loginDemo(
  email: string,
  password: string
): Promise<{ ok: boolean; user?: AuthUser; error?: string }> {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || 'Sign-in failed.' };
    return { ok: true, user: data.user as AuthUser };
  } catch {
    return { ok: false, error: 'Network error during sign-in.' };
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // ignore — session is cleared client side regardless
  }
}

export async function fetchUnreadNotifications(): Promise<number> {
  try {
    const res = await fetch('/api/notifications', { cache: 'no-store' });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.unread || 0;
  } catch {
    return 0;
  }
}