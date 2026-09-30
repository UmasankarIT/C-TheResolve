import { initializeApp, getApps, getApp, type App, cert } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { DEMO_ACCOUNTS, demoAccountByEmail, DemoAccount } from './auth';
import type { AuthUser } from './types';

// ---------------------------------------------------------------------------
// Firebase Auth as an identity provider (rules file: "Firebase — auth,
// real-time DB, rapid prototyping"). Firebase proves WHO the caller is; the app
// still issues its own civres_session cookie, so every existing RBAC guard,
// role claim and audit trail keeps working exactly as before.
//
// Roles are assigned HERE, server-side, from the DEMO_ACCOUNTS whitelist.
// A client-supplied name/email can only ever land a session in the citizen
// role — it can never mint an admin or department session.
// ---------------------------------------------------------------------------

/** What a verified Firebase identity gives us to build a session from. */
export interface FirebaseIdentity {
  uid: string;
  email: string;
  /** Best-effort display name; cosmetic only (citizen sessions). */
  name?: string;
}

function envConfigured(): boolean {
  return Boolean(
    process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY &&
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
  );
}

export function firebaseAuthConfigured(): boolean {
  return envConfigured();
}

/**
 * The service-account key arrives from .env files (literal "\n" inside the
 * quoted value) or from --set-env-vars (newlines flattened). Both forms must
 * end up as real newlines before crypto will accept the key.
 */
function normalizePrivateKey(raw: string): string {
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

let adminApp: App | null = null;
let adminAuth: Auth | null = null;

function getAdminAuth(): Auth | null {
  if (adminAuth) return adminAuth;
  if (!envConfigured()) return null;
  try {
    adminApp =
      getApps().length > 0
        ? getApp()
        : initializeApp({
            credential: cert({
              projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
              clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
              privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY as string),
            }),
            // Must ALSO be top-level: the credential's projectId scopes the
            // token, but identity lookups (getUser by email) are issued
            // against app.options.projectId — without it they resolve against
            // the wrong project and report "user-not-found" for real accounts.
            projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
          });
    adminAuth = getAuth(adminApp);
    return adminAuth;
  } catch (err) {
    console.error('[firebase-auth] Admin SDK init failed:', err);
    return null;
  }
}

/**
 * Verifies a Firebase ID token. Returns null (never throws) when Firebase is
 * unconfigured, the token is invalid or verification fails, so callers can
 * treat "null" as "not a Firebase sign-in" and fall back to the local path.
 */
export async function verifyFirebaseIdToken(token: string): Promise<FirebaseIdentity | null> {
  const auth = getAdminAuth();
  if (!auth || !token) return null;
  try {
    const decoded = await auth.verifyIdToken(token);
    if (!decoded.email) return null;
    return {
      uid: decoded.uid,
      email: decoded.email.toLowerCase(),
      name: decoded.name || undefined,
    };
  } catch (err) {
    console.warn('[firebase-auth] ID token rejected:', (err as Error).message);
    return null;
  }
}

/**
 * Maps a verified identity onto the app's user model. Role assignment is a
 * pure function of the server-side whitelist — the requested name is cosmetic
 * and only ever applies to citizen sessions.
 */
export function userFromFirebase(identity: FirebaseIdentity, requestedName?: string): AuthUser {
  const email = identity.email.trim().toLowerCase();
  const account: DemoAccount | undefined = demoAccountByEmail(email);
  if (account) return account.user;

  const emailName = email.split('@')[0];
  const name = (requestedName || identity.name || emailName).trim() || emailName;
  return {
    userId: `usr-fb-${identity.uid}`,
    role: 'citizen',
    name,
    email,
  };
}

// ---------------------------------------------------------------------------
// Demo-account provisioning. The one-tap staff buttons sign in THROUGH
// Firebase, so the accounts have to exist there first. Runs once per process
// (memoized): either from instrumentation at boot or lazily on the first
// login, whichever comes first. Never throws — a disabled Email/Password
// provider or missing credentials just logs how to fix it, and the local
// password path keeps working regardless.
// ---------------------------------------------------------------------------

let provisionPromise: Promise<void> | null = null;

async function provisionOnce(): Promise<void> {
  if (!envConfigured()) return;
  const auth = getAdminAuth();
  if (!auth) return;

  for (const account of DEMO_ACCOUNTS) {
    try {
      await auth.getUser(account.email);
      // Already exists — leave any password the operator set alone.
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'auth/user-not-found') {
        if (code === 'auth/operation-not-allowed') {
          console.warn(
            '[firebase-auth] Email/Password provider is disabled. Enable it: ' +
              'Firebase console -> Authentication -> Sign-in method -> Email/Password.'
          );
        } else {
          console.warn(`[firebase-auth] Cannot provision ${account.email}:`, (err as Error).message);
        }
        continue;
      }
      try {
        await auth.createUser({
          email: account.email,
          password: account.password,
          displayName: account.user.name,
          emailVerified: true,
        });
        console.log(`[firebase-auth] Provisioned demo account ${account.email} in Firebase.`);
      } catch (createErr) {
        const createCode = (createErr as { code?: string }).code;
        if (createCode === 'auth/email-already-exists') {
          // Someone (a parallel login or another instance) provisioned it
          // between getUser and createUser — the goal state, carry on.
          continue;
        }
        console.warn(`[firebase-auth] Failed to create ${account.email}:`, (createErr as Error).message);
      }
    }
  }
}

/** Memoized so boot + every login share a single provisioning pass. */
export function ensureFirebaseDemoAccounts(): Promise<void> {
  if (!provisionPromise) {
    provisionPromise = provisionOnce().catch((err) => {
      console.warn('[firebase-auth] provisioning pass failed:', (err as Error).message);
    });
  }
  return provisionPromise;
}
