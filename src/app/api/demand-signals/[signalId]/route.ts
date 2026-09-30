import { NextRequest, NextResponse } from 'next/server';
import { civicStore } from '@/lib/store';
import { toDemandSignalJson } from '@/lib/demandSignals';
import { scoreDemandSignalsByIntent } from '@/lib/priorityScore';

export const dynamic = 'force-dynamic';

/**
 * GET /api/demand-signals/{signal_id} — one cluster in full, including the
 * individual complaints that fed into it. Public read of an aggregation, like
 * the list this drills down from.
 *
 * The cluster is scored over the whole stored set (the same call the list
 * makes) rather than on its own, so the score and explanation displayed beside
 * the drill-down are byte-identical to the ranked list. Member complaints are
 * resolved against the persisted complaint corpus and shown with both the
 * original-language text and the faithful translation so a policymaker can
 * read what residents actually said.
 */
export async function GET(req: NextRequest, { params }: { params: { signalId: string } }) {
  try {
    const signalId = params.signalId;
    const signals = await civicStore.listDemandSignals();
    if (signals.length === 0) {
      return NextResponse.json({ error: 'No demand signals have been built yet.' }, { status: 404 });
    }

    // Scored per intent over the whole stored set, so this drill-down's score
    // is byte-identical to the ranked list's, however that list was filtered.
    const scored = scoreDemandSignalsByIntent(signals);
    const signal = scored.find((s) => s.clusterId === signalId);
    if (!signal) {
      return NextResponse.json({ error: `No demand signal named "${signalId}".` }, { status: 404 });
    }

    const corpus = await civicStore.listComplaints({ withEmbeddings: false });
    const byId = new Map(corpus.map((c) => [c.id, c]));
    const memberComplaints = signal.memberComplaintIds
      .map((id) => byId.get(id))
      .filter((c) => c !== undefined)
      .map((c) => ({
        complaint_id: c.id,
        source_issue_id: c.sourceIssueId ?? null,
        issue_type: c.issueType,
        location: c.location,
        location_state: c.locationState ?? null,
        location_district: c.locationDistrict ?? null,
        urgency_score: c.urgencyScore,
        urgency_reason: c.urgencyReason ?? null,
        original_language: c.originalLanguage,
        original_text: c.originalText,
        translated_text: c.translatedText,
      }));

    return NextResponse.json({
      ...toDemandSignalJson(signal),
      member_complaints: memberComplaints,
    });
  } catch (error: unknown) {
    console.error('Error reading demand signal detail:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error reading demand signal detail.' },
      { status: 500 }
    );
  }
}