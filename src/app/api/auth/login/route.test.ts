import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/auth/login with two ways in:
 *  - { email, password } — the original local demo path, unchanged behavior;
 *  - { firebaseIdToken } — Firebase Auth proves identity (rules file:
 *    "Firebase — auth, rapid prototyping"), the server still mints the app's
 *    own session cookie, and roles come from the server-side whitelist via
 *    userFromFirebase — never from anything the client sent.
 * Both paths kick the memoized Firebase provisioning pass so a fresh
 * environment self-heals on its first sign-in attempt.
 */

const h = vi.hoisted(() => ({
  signSession: vi.fn(),
  addAuditLog: vi.fn(),
  verifyFirebaseIdToken: vi.fn(),
  userFromFirebase: vi.fn(),
  ensureFirebaseDemoAccounts: vi.fn(),
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, signSession: h.signSession };
});
vi.mock('@/lib/store', () => ({ civicStore: { addAuditLog: h.addAuditLog } }));
vi.mock('@/lib/firebaseAuth', () => ({
  verifyFirebaseIdToken: h.verifyFirebaseIdToken,
  userFromFirebase: h.userFromFirebase,
  ensureFirebaseDemoAccounts: h.ensureFirebaseDemoAccounts,
  firebaseAuthConfigured: vi.fn(() => true),
}));

import { POST } from './route';

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as never
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.signSession.mockResolvedValue('signed-session-token');
  h.ensureFirebaseDemoAccounts.mockResolvedValue(undefined);
});

describe('POST /api/auth/login — local demo path', () => {
  it('signs a demo account in and sets the session cookie', async () => {
    const res = await post({ email: 'admin@city.gov', password: 'admin1234' });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.user).toMatchObject({ userId: 'usr-admin-001', role: 'city_admin' });

    const cookie = res.headers.get('set-cookie');
    expect(cookie).toContain('civres_session=signed-session-token');
    expect(h.addAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'usr-admin-001', action: 'auth.login' })
    );
    expect(h.ensureFirebaseDemoAccounts).toHaveBeenCalled();
  });

  it('rejects a wrong password with 401 and issues no session', async () => {
    const res = await post({ email: 'admin@city.gov', password: 'nope' });
    expect(res.status).toBe(401);
    expect(h.signSession).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects an unknown email with 401', async () => {
    const res = await post({ email: 'intruder@city.gov', password: 'admin1234' });
    expect(res.status).toBe(401);
    expect(h.signSession).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/login — Firebase ID-token path', () => {
  it('exchanges a verified Firebase token for the app session cookie', async () => {
    const identity = { uid: 'fb-uid-9', email: 'admin@city.gov', name: 'City Admin' };
    h.verifyFirebaseIdToken.mockResolvedValue(identity);
    h.userFromFirebase.mockReturnValue({
      userId: 'usr-admin-001',
      role: 'city_admin',
      name: 'City Admin',
      email: 'admin@city.gov',
    });

    const res = await post({ firebaseIdToken: 'id-token', name: 'City Admin' });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.user).toMatchObject({ role: 'city_admin' });
    expect(res.headers.get('set-cookie')).toContain('civres_session=');

    expect(h.ensureFirebaseDemoAccounts).toHaveBeenCalled();
    expect(h.verifyFirebaseIdToken).toHaveBeenCalledWith('id-token');
    // Role assignment happens server-side, driven only by the verified
    // identity plus the caller's cosmetic name — never by a client role claim.
    expect(h.userFromFirebase).toHaveBeenCalledWith(identity, 'City Admin');
    expect(h.signSession).toHaveBeenCalled();
  });

  it('rejects an unverifiable token with 401 and never builds a user', async () => {
    h.verifyFirebaseIdToken.mockResolvedValue(null);

    const res = await post({ firebaseIdToken: 'forged-token' });
    expect(res.status).toBe(401);
    expect(h.userFromFirebase).not.toHaveBeenCalled();
    expect(h.signSession).not.toHaveBeenCalled();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('mints a citizen session for a verified but non-whitelisted identity', async () => {
    const identity = { uid: 'fb-uid-7', email: 'random@x.com' };
    h.verifyFirebaseIdToken.mockResolvedValue(identity);
    h.userFromFirebase.mockReturnValue({
      userId: 'usr-fb-fb-uid-7',
      role: 'citizen',
      name: 'random',
      email: 'random@x.com',
    });

    const res = await post({ firebaseIdToken: 'good-token' });
    expect(res.status).toBe(200);
    expect((await res.json()).user.role).toBe('citizen');
  });
});
