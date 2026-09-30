import { NextResponse } from 'next/server';
import { plannedSpendingDataset } from '@/lib/plannedSpending';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/planned-spending — cited public investment plan figures for the
// demand-vs-spending panel. Always 200: an unavailable dataset is a
// `available: false` payload with a reason, never a 500, because the panel is
// optional enrichment of the dashboard.
// ---------------------------------------------------------------------------
export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(plannedSpendingDataset());
  } catch (error) {
    return NextResponse.json(
      {
        available: false,
        reason: `planned spending unavailable: ${(error as Error).message}`,
        rowCount: 0,
        scheme: null,
        financialYear: null,
        source: null,
        sourceUrl: null,
        rows: [],
      },
      { status: 200 }
    );
  }
}
