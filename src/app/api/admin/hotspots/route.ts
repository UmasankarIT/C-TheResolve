import { NextRequest, NextResponse } from 'next/server';
import { civicStore } from '@/lib/store';
import { getSession, isRole, unauthorized, denied } from '@/lib/auth';
import {
  buildHotspots,
  buildCategoryDemand,
  buildStateDemand,
  buildDistrictDemand,
  buildNationalSummary,
  buildRecommendations,
  buildPromptContext,
  isOpenIssue,
  type HotspotsData,
} from '@/lib/demand';
import { generateDemandRecommendations } from '@/lib/gemini';
import { getDistrictIndicators } from '@/lib/publicData';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/hotspots — Demand Intelligence for policymakers.
 * Clusters live citizen grievances into demand hotspots, fuses them with
 * contextual risk data, and produces ranked project recommendations. Gemini
 * runs when GEMINI_API_KEY is configured; otherwise a deterministic ranking
 * over the same inputs is returned (mode field distinguishes the two).
 */
export async function GET(req: NextRequest) {
  const user = await getSession(req);
  if (!user) return unauthorized('Sign in to view demand intelligence.');
  if (!isRole(user, 'city_admin')) return denied('Only the city admin can view demand intelligence.');

  const [departments, issues] = await Promise.all([
    civicStore.getDepartments(),
    civicStore.getIssues(),
  ]);

  const openIssues = issues.filter(isOpenIssue);
  const hotspots = buildHotspots(openIssues);
  const categoryDemand = buildCategoryDemand(openIssues);
  const stateDemand = buildStateDemand(openIssues, hotspots);
  const districtDemand = buildDistrictDemand(openIssues, hotspots);
  const national = buildNationalSummary(openIssues, hotspots, stateDemand, categoryDemand);

  let recommendations = buildRecommendations(hotspots, departments, issues);
  let mode: 'gemini' | 'heuristic' = 'heuristic';

  if (openIssues.length > 0) {
    const promptContext = buildPromptContext(openIssues, hotspots, categoryDemand, stateDemand, districtDemand);
    const ai = await generateDemandRecommendations(promptContext);
    if (ai && ai.length > 0) {
      mode = 'gemini';
      recommendations = ai.map((r) => {
        const hs = hotspots.find((h) => h.id === r.hotspotId);
        const top = hs?.topCategories[0];
        const fundamental = openIssues.find((i) => i.id === hs?.leadingIssueId);
        return {
          rank: r.rank,
          title: r.title,
          hotspotId: hs?.id || r.hotspotId,
          categoryId: top?.id || '',
          category: r.category,
          departmentId: fundamental?.category.responsibleDepartment || 'DEPT_PWD',
          department: r.department,
          demandScore: hs?.demandScore ?? 0,
          rationale: r.rationale,
          estimatedImpact: r.estimatedImpact,
          indicativeInvestment: r.indicativeInvestment,
          priority: (hs?.demandScore ?? 0) >= 70 ? 'high' : (hs?.demandScore ?? 0) >= 40 ? 'medium' : 'low',
        };
      });
    }
  }

  const totalUpvotes = openIssues.reduce((acc, i) => acc + i.communityUpvotes, 0);

  // Real government demographics, when a portal key + resource are configured.
  // Unavailable or unreachable simply means the fusion falls back to the
  // curated baseline — the endpoint never fails because of an external feed.
  const publicData = await getDistrictIndicators(districtDemand.map((d) => d.district));

  // Annotated so the response the console consumes and the response actually
  // built here cannot drift: adding a field to one without the other is a
  // compile error rather than an undefined at runtime.
  const body: HotspotsData = {
    generatedAt: new Date().toISOString(),
    mode,
    dataSources: [
      'citizen_reports',
      'static_contextual_risk',
      'state_rollup',
      'district_rollup',
      ...(publicData.indicators.length > 0 ? ['data.gov.in'] : []),
      ...(mode === 'gemini' ? ['gemini_ai'] : []),
    ],
    counts: {
      totalOpen: openIssues.length,
      totalResolved: issues.length - openIssues.length,
      totalUpvotes,
      hotspotCount: hotspots.length,
      stateCount: national.statesCovered,
      districtCount: national.districtsCovered,
    },
    hotspots,
    recommendations,
    categoryDemand,
    stateDemand,
    districtDemand,
    publicData,
    national,
  };
  return NextResponse.json(body);
}

