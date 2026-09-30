import { NextRequest, NextResponse } from 'next/server';
import { demoAccountByEmail, signSession, SESSION_COOKIE, SESSION_COOKIE_OPTS } from '@/lib/auth';
import { ensureFirebaseDemoAccounts, userFromFirebase, verifyFirebaseIdToken } from '@/lib/firebaseAuth';
import { civicStore } from '@/lib/store';
import type { AuthUser } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function issueSession(user: AuthUser): Promise<NextResponse> {
  const token = await signSession(user);
  await civicStore.addAuditLog({
    id: `log-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    actorId: user.userId,
    actorName: user.name,
    role: user.role,
    action: 'auth.login',
    detail: `${user.name} signed in (${user.role}).`,
    createdAt: new Date().toISOString(),
  });

  const res = NextResponse.json({ ok: true, user });
  res.cookies.set(SESSION_COOKIE, token, SESSION_COOKIE_OPTS);
  return res;
}

/**
 * POST /api/auth/login — two ways in, one session cookie out:
 *
 *   { firebaseIdToken }  a Firebase ID token. Firebase proves the identity
 *                        (Firebase Auth = the rules file's "auth, rapid
 *                        prototyping" item); the app still issues its own
 *                        session so every RBAC guard downstream is unchanged.
 *                        Roles come from the server-side whitelist only.
 *   { email, password }  the original local demo-account path, kept intact as
 *                        a fallback so the demo works even when Firebase is
 *                        unconfigured or its provider is disabled.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const idToken = typeof body.firebaseIdToken === 'string' ? body.firebaseIdToken.trim() : '';

    // Idempotent, memoized: makes sure the demo accounts exist in Firebase
    // (created at boot by instrumentation when available), so a brand-new
    // environment self-heals on the first sign-in attempt of either kind.
    await ensureFirebaseDemoAccounts();

    if (idToken) {
      const identity = await verifyFirebaseIdToken(idToken);
      if (!identity) {
        return NextResponse.json(
          { error: 'Firebase session could not be verified. Please sign in again.' },
          { status: 401 }
        );
      }
      const user = userFromFirebase(identity, typeof body.name === 'string' ? body.name : undefined);
      return issueSession(user);
    }

    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    const account = demoAccountByEmail(email);
    if (!account || account.password !== password) {
      return NextResponse.json({ error: 'Invalid credentials.' }, { status: 401 });
    }

    return issueSession(account.user);
  } catch (error: unknown) {
    console.error('Error signing in:', error);
    return NextResponse.json({ error: 'Failed to sign in.' }, { status: 500 });
  }
}
