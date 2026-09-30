import { describe, it, expect } from 'vitest';
import { userFromFirebase } from './firebaseAuth';

/**
 * Firebase is an identity provider only: a verified token says WHO the caller
 * is, but the role always comes from the server-side DEMO_ACCOUNTS whitelist.
 * A caller-supplied/Firebase-stored name is cosmetic and can only ever shape a
 * citizen session — it must never influence role or user id.
 */

describe('userFromFirebase — identity to app-user mapping', () => {
  it('maps a whitelisted admin email to the exact server-side account (role included)', () => {
    const user = userFromFirebase({ uid: 'fb-uid-1', email: 'admin@city.gov' });
    expect(user.role).toBe('city_admin');
    expect(user.userId).toBe('usr-admin-001');
    expect(user.email).toBe('admin@city.gov');
    expect(user.name).toBe('City Admin');
  });

  it('keeps department identities scoped to their own department', () => {
    expect(userFromFirebase({ uid: 'u2', email: 'water@city.gov' })).toMatchObject({
      role: 'department',
      departmentId: 'DEPT_WATER',
    });
    expect(userFromFirebase({ uid: 'u3', email: 'roads@city.gov' })).toMatchObject({
      role: 'department',
      departmentId: 'DEPT_PWD',
    });
  });

  it('forces an unknown email into the citizen role with a stable uid-derived id', () => {
    const a = userFromFirebase({ uid: 'abc123', email: 'New.Citizen@Example.com' });
    const b = userFromFirebase({ uid: 'abc123', email: 'new.citizen@example.com' });
    expect(a.role).toBe('citizen');
    expect(a.userId).toBe('usr-fb-abc123');
    expect(a.email).toBe('new.citizen@example.com');
    // Same Firebase uid always lands on the same app user, regardless of the
    // email's case or which session created it first.
    expect(b.userId).toBe(a.userId);
  });

  it('ignores any caller-supplied name for whitelisted staff (canonical account wins)', () => {
    const admin = userFromFirebase(
      { uid: 'x', email: 'admin@city.gov', name: 'Totally An Admin' },
      'Also Not An Admin'
    );
    expect(admin.role).toBe('city_admin');
    expect(admin.name).toBe('City Admin'); // the account as the server defines it
    expect(admin.userId).toBe('usr-admin-001');
  });

  it('falls back from requested name to Firebase display name to the email handle', () => {
    expect(
      userFromFirebase({ uid: 'u', email: 'a.b@x.com', name: 'From Firebase' }, 'Requested').name
    ).toBe('Requested');
    expect(userFromFirebase({ uid: 'u', email: 'a.b@x.com', name: 'From Firebase' }).name).toBe(
      'From Firebase'
    );
    expect(userFromFirebase({ uid: 'u', email: 'a.b@x.com' }).name).toBe('a.b');
  });

  it('never yields an undefined email or name', () => {
    const user = userFromFirebase({ uid: 'u9', email: 'solo@x.com' });
    expect(user.email).toBeTruthy();
    expect(user.name).toBeTruthy();
  });
});
