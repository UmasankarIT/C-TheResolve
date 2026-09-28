import { NextRequest, NextResponse } from 'next/server';
import {
  verifyOtp,
  invalidateOtp,
  createCitizenUser,
  signSession,
  checkOtpRateLimit,
  clientIp,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTS,
} from '@/lib/auth';
import { civicStore } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    let phone = String(body.phone || '').replace(/\D/g, '');
    if (phone.length > 10 && phone.startsWith('91')) phone = phone.slice(-10);
    if (phone.length !== 10) {
      return NextResponse.json({ error: 'Enter a valid 10-digit Indian mobile number.' }, { status: 400 });
    }

    const ip = clientIp(req);
    for (const limit of [{ key: `otp-try:${ip}`, max: 60 }, { key: `otp-try:${phone}`, max: 10 }]) {
      const gate = checkOtpRateLimit(limit.key, limit.max);
      if (!gate.allowed) {
        return NextResponse.json(
          { error: `Too many verification attempts. Try again in ${Math.ceil(gate.retryAfterSeconds / 60)} minute(s).` },
          { status: 429, headers: { 'Retry-After': String(gate.retryAfterSeconds) } }
        );
      }
    }

    const otp = String(body.otp || '').trim();
    if (!verifyOtp(phone, otp)) {
      // Repeated wrong guesses kill the live code so a leaked OTP cannot be
      // brute-forced; the citizen simply requests a new one.
      const failures = checkOtpRateLimit(`otp-fail:${phone}`, 3);
      if (!failures.allowed) invalidateOtp(phone);
      return NextResponse.json({ error: 'Invalid or expired OTP.' }, { status: 401 });
    }

    const user = createCitizenUser(phone, body.displayName);
    const token = await signSession(user);
    await civicStore.addAuditLog({
      id: `log-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      actorId: user.userId,
      actorName: user.name,
      role: 'citizen',
      action: 'auth.login.otp',
      detail: `Citizen signed in via mobile OTP (+91 ${phone}).`,
      createdAt: new Date().toISOString(),
    });

    const res = NextResponse.json({ ok: true, user });
    res.cookies.set(SESSION_COOKIE, token, SESSION_COOKIE_OPTS);
    return res;
  } catch (error: unknown) {
    console.error('Error verifying OTP:', error);
    return NextResponse.json({ error: 'Failed to verify OTP.' }, { status: 500 });
  }
}