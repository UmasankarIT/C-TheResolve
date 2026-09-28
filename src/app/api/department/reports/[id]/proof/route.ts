import { NextRequest, NextResponse } from 'next/server';
import { civicStore } from '@/lib/store';
import { getSession, isRole, unauthorized, denied } from '@/lib/auth';
import { logAction, notifyUser } from '@/lib/events';
import { ProofOfWork } from '@/lib/types';
import { storeImageDataUrl } from '@/lib/objectStore';
import { CITY_ADMIN_USER_ID } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * POST /api/department/reports/:id/proof
 * Proof of work (after-photo, GPS, timestamp, notes) — mandatory before a
 * field worker can mark a ticket RESOLVED. Department-scoped.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const user = await getSession(req);
    if (!user) return unauthorized('Sign in to submit proof of work.');
    if (!isRole(user, 'department')) return denied('Only field staff submit proof of work.');

    const issue = await civicStore.getIssueById(params.id);
    if (!issue) return NextResponse.json({ error: 'Issue not found.' }, { status: 404 });

    if (issue.departmentId && issue.departmentId !== user.departmentId) {
      return denied('Forbidden: this ticket belongs to another department.');
    }
    if (issue.status !== 'assigned' && issue.status !== 'in_progress') {
      return NextResponse.json(
        { error: 'Proof can only be submitted for assigned or in-progress tickets.' },
        { status: 409 }
      );
    }

    const body = await req.json();
    const rawPhotoUrl = String(body.photoUrl || '');
    const notes = String(body.notes || '');
    if (!rawPhotoUrl) {
      return NextResponse.json({ error: 'An after-photo is required as proof of work.' }, { status: 400 });
    }

    // Proof photos are unresized originals (StaffTasks.tsx reads the file
    // straight through FileReader), so these are the largest blobs in the
    // system — often several MB of base64. Move them to object storage.
    const photoUrl = await storeImageDataUrl(rawPhotoUrl, 'proof');

    const proof: ProofOfWork = {
      id: `proof-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      issueId: issue.id,
      departmentId: user.departmentId || issue.departmentId || '',
      submittedBy: user.name,
      photoUrl,
      latitude: Number(body.latitude) || issue.latitude,
      longitude: Number(body.longitude) || issue.longitude,
      notes,
      submittedAt: new Date().toISOString(),
    };

    await civicStore.addProofOfWork(proof);

    await logAction(user, 'proof.upload', `Proof of work uploaded for ${issue.id}.`, issue.id);
    if (issue.citizenUserId) {
      await notifyUser(issue.citizenUserId, 'Proof of work uploaded', 'Field staff uploaded the after-photo for your report — resolution is being finalised.', issue.id);
    }
    await notifyUser(CITY_ADMIN_USER_ID, 'Proof of work pending review', `${proof.submittedBy} uploaded proof for ${issue.id}.`, issue.id);

    return NextResponse.json({
      proof,
      message: 'Proof of work recorded. You can now mark the ticket as RESOLVED.',
    });
  } catch (error: unknown) {
    console.error('Error submitting proof:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error.' },
      { status: 500 }
    );
  }
}