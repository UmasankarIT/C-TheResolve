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

function friendlyFirebaseError(err: unknown): string {
  const code = (err as { code?: string }).code;
  switch (code) {
    case 'auth/operation-not-allowed':
      return 'Email/Password sign-in is disabled in the Firebase console (Authentication → Sign-in method → Email/Password).';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-mismatch':
      return 'Wrong email or password.';
    case 'auth/too-many-requests':
      return 'Too many attempts — try again in a minute.';
    case 'auth/network-request-failed':
      return 'Network error reaching Firebase.';
    default:
      return (err as Error)?.message || 'Firebase sign-in failed.';
  }
}

/**
 * Sign in THROUGH Firebase Auth, then exchange the Firebase ID token for the
 * app's own session cookie. Implicit sign-up: an unknown email/password pair
 * creates the account (rapid prototyping), any other failure surfaces as an
 * error the caller can fall back from (the local password path keeps working
 * when Firebase is unconfigured or its provider is disabled).
 */
export async function signInWithFirebase(
  email: string,
  password: string,
  displayName?: string
): Promise<{ ok: boolean; user?: AuthUser; error?: string }> {
  try {
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    if (!apiKey || !projectId) {
      return { ok: false, error: 'Firebase is not configured.' };
    }

    // Code-split: the Firebase SDK loads only when someone actually signs in.
    const { initializeApp, getApps, getApp } = await import('firebase/app');
    const {
      getAuth,
      signInWithEmailAndPassword,
      createUserWithEmailAndPassword,
      updateProfile,
    } = await import('firebase/auth');

    const app =
      getApps().length > 0
        ? getApp()
        : initializeApp({
            apiKey,
            authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || `${projectId}.firebaseapp.com`,
            projectId,
          });
    const fbAuth = getAuth(app);

    let credential;
    try {
      credential = await signInWithEmailAndPassword(fbAuth, email.trim(), password);
    } catch (err) {
      const code = (err as { code?: string }).code;
      // Since enumeration protection, wrong-password and unknown-email both come
      // back as invalid-credential — so probe by attempting sign-up: it succeeds
      // only for a truly new account (or weak password), and for an existing
      // email/email-already-exists we rethrow the original sign-in error, which
      // is the accurate "wrong password" message.
      if (code !== 'auth/user-not-found' && code !== 'auth/invalid-credential') throw err;
      try {
        credential = await createUserWithEmailAndPassword(fbAuth, email.trim(), password);
        if (displayName?.trim()) {
          await updateProfile(credential.user, { displayName: displayName.trim() });
        }
      } catch {
        throw err;
      }
    }

    const idToken = await credential.user.getIdToken();
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firebaseIdToken: idToken, name: displayName }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error || 'Sign-in failed.' };
    return { ok: true, user: data.user as AuthUser };
  } catch (err) {
    return { ok: false, error: friendlyFirebaseError(err) };
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