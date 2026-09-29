import { NextRequest, NextResponse } from 'next/server';
import { civicStore } from '@/lib/store';
import { getSession, isRole, unauthorized, denied } from '@/lib/auth';
import { logAction } from '@/lib/events';
import { isOpenIssue } from '@/lib/demand';
import {
  buildDemandSignals,
  complaintsFromIssues,
  enrichComplaints,
  geminiPipelineAi,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_BUCKET_GRANULARITY,
  toDemandSignalJson,
  type BucketGranularity,
} from '@/lib/demandSignals';
import { withDistrictStatistics } from '@/lib/districtReference';
import { scoreDemandSignals } from '@/lib/priorityScore';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

interface BuildRequest {
  similarityThreshold?: number;
  /** Skip the Gemini field-extraction pass and reuse the stored complaints. */
  skipExtraction?: boolean;
  /** Cluster and return without writing to the database. */
  dryRun?: boolean;
  /** Administrative level stage 1 buckets on. Defaults to district. */
  bucketGranularity?: BucketGranularity;
}

/**
 * POST /api/admin/demand-signals/build — runs the four-stage clustering
 * pipeline and writes the resulting demand signals.
 *
 * The app has no job runner (Cloud Run scales to zero), so the build is
 * triggered by calling this endpoint. It is deliberately a separate endpoint
 * from the read: a build makes Gemini calls proportional to the number of open
 * issues and must never happen on a dashboard load.
 *
 * Body (all optional):
 *   similarityThreshold  cosine cutoff for stage 3, clamped to [0, 1]
 *   skipExtraction       reuse the stored complaints instead of re-normalising
 *   dryRun               compute and return without persisting
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getSession(req);
    if (!user) return unauthorized('Sign in to rebuild demand signals.');
    if (!isRole(user, 'city_admin')) return denied('Only the city admin can rebuild demand signals.');

    const body = (await req.json().catch(() => ({}))) as BuildRequest;

    // An unparseable threshold would otherwise silently become NaN and make
    // every pair maximally distant, collapsing the corpus into singletons.
    const requested = Number(body.similarityThreshold);
    const threshold = Number.isFinite(requested)
      ? Math.min(1, Math.max(0, requested))
      : DEFAULT_SIMILARITY_THRESHOLD;

    const granularity: BucketGranularity = ['state', 'district', 'ward'].includes(
      String(body.bucketGranularity)
    )
      ? (body.bucketGranularity as BucketGranularity)
      : DEFAULT_BUCKET_GRANULARITY;

    const allIssues = await civicStore.getIssues();
    // Resolved and merged grievances are history; a demand signal describes
    // pressure the city still has to answer.
    const openIssues = allIssues.filter(isOpenIssue);

    if (openIssues.length === 0) {
      return NextResponse.json(
        { error: 'No open issues to cluster. Demand signals are built from open grievances only.' },
        { status: 400 }
      );
    }

    const progress: string[] = [];
    const note = (message: string) => {
      progress.push(message);
      console.log(`[demand-signals] ${message}`);
    };

    // 1. Rebuild the complaint corpus from the issues table. The upsert keeps
    //    any embedding already stored for an unchanged complaint, which is
    //    what makes a second build free.
    note(`normalising ${openIssues.length} open issues into complaints`);
    const baseline = complaintsFromIssues(openIssues);
    await civicStore.upsertComplaints(baseline);
    let complaints = await civicStore.listComplaints({ withEmbeddings: true });

    // listComplaints() returns every complaint ever stored, which includes
    // ones derived from issues that have since been resolved or merged. A
    // demand signal describes pressure the city still has to answer, so those
    // must be excluded or the build keeps resurrecting solved problems. Scoped
    // by the open issues just upserted, not by recency.
    const openIssueIds = new Set(openIssues.map((i) => i.id));
    const current = complaints.filter((c) => c.sourceIssueId && openIssueIds.has(c.sourceIssueId));
    if (current.length < complaints.length) {
      note(
        `excluded ${complaints.length - current.length} complaint(s) from issues that are no longer open`
      );
      complaints = current;
    }

    // 2. Gemini field extraction: issue type, urgency, language, English text.
    if (!body.skipExtraction) {
      note(`extracting structured fields for ${complaints.length} complaints via Gemini`);
      complaints = await enrichComplaints(complaints, openIssues);
      await civicStore.upsertComplaints(complaints);
    }

    // 3-4. Bucket, embed, cluster, verify, summarise.
    const { signals, stats } = await buildDemandSignals(complaints, geminiPipelineAi, {
      similarityThreshold: threshold,
      bucketGranularity: granularity,
      saveEmbedding: async (id, vector, model) => {
        await civicStore.setComplaintEmbedding(id, vector, model);
      },
      onProgress: note,
    });

    // Step 4 — data fusion. Every signal picks up its district's population
    // and infrastructure gap from the reference table (null where no data
    // exists, never a guessed number). Applied here, after clustering, so a
    // dry run returns the same fused fields as a persisted build.
    note('joining district population and infrastructure reference data');
    const fused = withDistrictStatistics(signals);

    // Step 5 — priority ranking. Scored over the full cluster set (volume and
    // population are min-max scaled across these clusters and no others), then
    // emitted highest score first, each with the human-readable explanation of
    // its own numbers. Scores are recomputed per response, never stored, so a
    // stale build cannot show a ranking that no longer matches the clusters.
    note('ranking clusters by priority score');
    const scored = scoreDemandSignals(fused);

    if (!body.dryRun) {
      await civicStore.replaceDemandSignals(fused);
      await logAction(
        user,
        'demand-signals.build',
        `Clustered ${stats.complaintCount} complaints into ${stats.clusterCount} demand signals ` +
          `(threshold ${stats.similarityThreshold}, ${stats.mergedClusterCount} merged).`,
        undefined
      );
    }

    return NextResponse.json({
      generated_at: new Date().toISOString(),
      dry_run: body.dryRun === true,
      stats,
      clusters: scored.map(toDemandSignalJson),
      progress,
    });
  } catch (error: unknown) {
    console.error('Error building demand signals:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error building demand signals.' },
      { status: 500 }
    );
  }
}
