import { NextRequest, NextResponse } from 'next/server';
import { SignJWT, jwtVerify } from 'jose';
import { AuthUser, UserRole } from './types';

export const SESSION_COOKIE = 'civres_session';

// Demo-grade secret. For a real deployment supply CIVRES_JWT_SECRET in env
// (already excluded from the repo via .gitignore). The fallback keeps local
// dev + the offline demo running with zero setup.
const SECRET = new TextEncoder().encode(
  process.env.CIVRES_JWT_SECRET || 'civicresolve-demo-secret-change-in-prod'
);

if (process.env.NODE_ENV === 'production' && !process.env.CIVRES_JWT_SECRET) {
  console.warn(
    '[auth] CIVRES_JWT_SECRET is unset — using the public demo secret. Sessions are forgeable; set CIVRES_JWT_SECRET (Cloud Run: civicresolve-jwt) before going live.'
  );
}

// The Secure flag is tied to how the app is actually served, not to NODE_ENV.
// Tying it to NODE_ENV alone made every non-TLS deployment unusable: the
// container runs in production mode over plain http://localhost, so the browser
// stored a Secure cookie and then refused to send it back, leaving nobody able
// to sign in. Set SESSION_COOKIE_SECURE=false for any HTTP-served pilot; the
// default stays Secure because production deployments sit behind TLS.
const cookieSecureDefault = process.env.NODE_ENV === 'production';
const cookieSecureRaw = process.env.SESSION_COOKIE_SECURE;
export const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: cookieSecureRaw === undefined ? cookieSecureDefault : cookieSecureRaw === 'true',
  path: '/',
  maxAge: 60 * 60 * 24 * 7, // 7 days
};

export async function signSession(user: AuthUser): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(SECRET);
}

export async function verifyToken(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET);
    if (!payload || typeof payload.userId !== 'string') return null;
    return {
      userId: payload.userId as string,
      role: payload.role as UserRole,
      name: (payload.name as string) || 'User',
      phone: payload.phone as string | undefined,
      email: payload.email as string | undefined,
      departmentId: payload.departmentId as string | undefined,
      jurisdictionCode: payload.jurisdictionCode as string | undefined,
    };
  } catch {
    return null;
  }
}

export async function getSession(req: NextRequest): Promise<AuthUser | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifyToken(token);
}

export function isRole(user: AuthUser | null, ...roles: UserRole[]): boolean {
  return !!user && roles.includes(user.role);
}

export function denied(message = 'Forbidden: you do not have access to this action.') {
  return NextResponse.json({ error: message }, { status: 403 });
}

export function unauthorized(message = 'Authentication required.') {
  return NextResponse.json({ error: message, code: 'AUTH_REQUIRED' }, { status: 401 });
}

// ---------------------------------------------------------------------------
// Simulated OTP (passwordless citizen sign-in). Real SMS/WhatsApp needs a
// provider key; the demo generates the OTP in-memory and returns it so the
// flow can be completed instantly.
//
// Routes are bundled separately by Next.js (dev + prod), so module-level state
// lives on globalThis — same pattern as the civic store — or OTPs would be
// invisible to the verify route.
// ---------------------------------------------------------------------------
const globalForOtp = globalThis as unknown as {
  __civresOtpStore?: Map<string, { otp: string; expiresAt: number }>;
};
const otpStore: Map<string, { otp: string; expiresAt: number }> =
  globalForOtp.__civresOtpStore || new Map();
if (process.env.NODE_ENV !== 'production') globalForOtp.__civresOtpStore = otpStore;

export function issueOtp(phone: string): string {
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(phone, { otp, expiresAt: Date.now() + 10 * 60 * 1000 });
  return otp;
}

// ---------------------------------------------------------------------------
// Brute-force protection. Without a real SMS provider a 6-digit OTP is guessable,
// so both the request and verify endpoints are throttled per phone and per IP.
// ---------------------------------------------------------------------------
const OTP_WINDOW_MS = 15 * 60 * 1000;

const globalForLimit = globalThis as unknown as {
  __civresOtpRate?: Map<string, { count: number; resetAt: number }>;
};
const otpRate: Map<string, { count: number; resetAt: number }> =
  globalForLimit.__civresOtpRate || new Map();
if (process.env.NODE_ENV !== 'production') globalForLimit.__civresOtpRate = otpRate;

export function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'local';
}

export function checkOtpRateLimit(
  identifier: string,
  limit: number
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();

  if (otpRate.size > 5000) {
    const stale: string[] = [];
    otpRate.forEach((value, key) => {
      if (now > value.resetAt) stale.push(key);
    });
    stale.forEach((key) => otpRate.delete(key));
  }

  const entry = otpRate.get(identifier);
  if (!entry || now > entry.resetAt) {
    otpRate.set(identifier, { count: 1, resetAt: now + OTP_WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (entry.count >= limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }
  entry.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

export function verifyOtp(phone: string, otp: string): boolean {
  const entry = otpStore.get(phone);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    otpStore.delete(phone);
    return false;
  }
  const ok = entry.otp === otp;
  if (ok) otpStore.delete(phone);
  return ok;
}

export function invalidateOtp(phone: string): void {
  otpStore.delete(phone);
}

// ---------------------------------------------------------------------------
// Demo accounts for Staff (department) and City Admin. Two departments seeded
// so cross-department isolation (403) can be demonstrated for real.
// ---------------------------------------------------------------------------
export type DemoAccount = { email: string; password: string; user: AuthUser };

export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    email: 'water@city.gov',
    password: 'demo1234',
    user: {
      userId: 'usr-dept-water',
      role: 'department',
      name: 'Water Field Staff',
      email: 'water@city.gov',
      departmentId: 'DEPT_WATER',
      jurisdictionCode: 'Ward-11',
    },
  },
  {
    email: 'roads@city.gov',
    password: 'demo1234',
    user: {
      userId: 'usr-dept-pwd',
      role: 'department',
      name: 'Roads Field Staff',
      email: 'roads@city.gov',
      departmentId: 'DEPT_PWD',
      jurisdictionCode: 'Ward-11',
    },
  },
  {
    email: 'admin@city.gov',
    password: 'admin1234',
    user: {
      userId: 'usr-admin-001',
      role: 'city_admin',
      name: 'City Admin',
      email: 'admin@city.gov',
      jurisdictionCode: 'CITY-VIZAG',
    },
  },
];

export const CITY_ADMIN_USER_ID = 'usr-admin-001';

export function demoAccountByEmail(email: string): DemoAccount | undefined {
  return DEMO_ACCOUNTS.find((a) => a.email.toLowerCase() === email.trim().toLowerCase());
}

export function createCitizenUser(phone: string, displayName?: string): AuthUser {
  return {
    userId: `usr-cit-${phone}`,
    role: 'citizen',
    name: displayName?.trim() || `Citizen +91 ${phone}`,
    phone,
  };
}