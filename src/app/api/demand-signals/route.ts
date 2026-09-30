import { NextRequest, NextResponse } from 'next/server';
import { civicStore } from '@/lib/store';
import { filterByIntent, parseIntentParam, toDemandSignalJson } from '@/lib/demandSignals';
import { scoreDemandSignalsByIntent } from '@/lib/priorityScore';

export const dynamic = 'force-dynamic';

/**
 * GET /api/demand-signals — public ranked view of the clustered complaints.
 * The pipeline output is an aggregation of citizen reports, not citizen
 * identity, so it is safe to serve without a session; the drill-down detail
 * endpoint resolves the same rows' member complaints so policymakers can trace
 * a recommendation back to the original reports.
 *
 * `?intent=complaint|development_request|all` (default `all`) filters the
 * clusters; scores are computed per intent so a filtered view scores
 * identically to the same rows inside the unfiltered one.
 *
 * Rows are re-scored on every read (volume and population are min-max scaled
 * over the stored set) and returned highest priority first, so the dashboard
 * always shows a current ranking, even between builds.
 */
export async function GET(req: NextRequest) {
  try {
    const intent = parseIntentParam(new URL(req.url).searchParams.get('intent'));
    const signals = filterByIntent(await civicStore.listDemandSignals(), intent);
    const scored = scoreDemandSignalsByIntent(signals);

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