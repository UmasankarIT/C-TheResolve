import { NextRequest, NextResponse } from 'next/server';
import { civicStore } from '@/lib/store';
import { scoreDemandSignals } from '@/lib/priorityScore';

export const dynamic = 'force-dynamic';

/**
 * GET /api/demand-signals/map — location + score + issue type only, shaped for
 * map plotting. Each cluster is geolocated at the centroid of its member
 * complaints' source reports (the nearest thing to ground truth the pipeline
 * keeps; complaints themselves carry district labels, not coordinates).
 *
 * A cluster whose complaints have no resolvable source report comes back with
 * null coordinates so the client can still show it in the ranked list while
 * omitting its marker, rather than inventing a pin.
 */
export async function GET(req: NextRequest) {
  try {
    const signals = await civicStore.listDemandSignals();
    const scored = scoreDemandSignals(signals);

    // complaint -> its source report's coordinates, for the visual placement of
    // the cluster. Both reads are full-table scans over a few hundred rows, so
    // the join is done here rather than adding another store method for it.
    const [complaints, issues] = await Promise.all([
      civicStore.listComplaints({ withEmbeddings: false }),
      civicStore.getIssues(),
    ]);
    const issueCoords = new Map(
      issues
        .filter((i) => Number.isFinite(i.latitude) && Number.isFinite(i.longitude))
        .map((i) => [i.id, { latitude: i.latitude, longitude: i.longitude }])
    );

    const markers = scored.map((signal) => {
      let sumLat = 0;
      let sumLon = 0;
      let placed = 0;
      for (const complaintId of signal.memberComplaintIds) {
        const complaint = complaints.find((c) => c.id === complaintId);
        const coords = complaint?.sourceIssueId ? issueCoords.get(complaint.sourceIssueId) : undefined;
        if (!coords) continue;
        sumLat += coords.latitude;
        sumLon += coords.longitude;
        placed += 1;
      }
      const hasCoords = placed > 0;
      return {
        cluster_id: signal.clusterId,
        issue_type: signal.issueType,
        location: signal.location,
        location_state: signal.locationState ?? null,
        location_district: signal.locationDistrict ?? null,
        volume: signal.volume,
        priority_score: signal.priorityScore ?? null,
        latitude: hasCoords ? sumLat / placed : null,
        longitude: hasCoords ? sumLon / placed : null,
      };
    });

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      count: markers.length,
      plotted: markers.filter((m) => m.latitude !== null).length,
      markers,
    });
  } catch (error: unknown) {
    console.error('Error reading demand signal map data:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error reading demand signal map data.' },
      { status: 500 }
    );
  }
}