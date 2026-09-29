import { NextRequest, NextResponse } from 'next/server';
import { civicStore } from '@/lib/store';
import { getSession, isRole, unauthorized, denied } from '@/lib/auth';
import { toDemandSignalJson } from '@/lib/demandSignals';
import { scoreDemandSignals } from '@/lib/priorityScore';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/demand-signals — the clustered complaints, as produced by
 * POST /api/admin/demand-signals/build. Each cluster carries the summary a
 * policymaker reads plus the provenance of how it was made, so a number on
 * screen can always be traced back to the complaints and the threshold that
 * produced it.
 *
 * Clusters are re-scored on every read (volume and population are min-max
 * scaled over the stored set) and returned highest priority first, so the
 * dashboard shows a current ranking even between builds.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getSession(req);
    if (!user) return unauthorized('Sign in to view demand signals.');
    if (!isRole(user, 'city_admin')) return denied('Only the city admin can view demand signals.');

    const signals = await civicStore.listDemandSignals();
    const scored = scoreDemandSignals(signals);

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      count: scored.length,
      complaints: scored.reduce((sum, s) => sum + s.volume, 0),
      clusters: scored.map(toDemandSignalJson),
    });
  } catch (error: unknown) {
    console.error('Error reading demand signals:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error reading demand signals.' },
      { status: 500 }
    );
  }
}
