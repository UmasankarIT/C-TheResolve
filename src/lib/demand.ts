import { Issue, Department } from './types';
import type { DistrictIndicators } from './publicData';

/**
 * State an issue belongs to. Prefers the indexed `state` column, falling back to
 * the locationDetails JSONB for issues written before the column existed.
 * Returns undefined rather than a placeholder so callers keep control of their
 * own "Unknown" labelling.
 */
function stateOf(issue: Issue | undefined): string | undefined {
  if (!issue) return undefined;
  return issue.state || issue.locationDetails?.state || undefined;
}

// ---------------------------------------------------------------------------
// Demand Intelligence — fuses citizen grievance data with contextual data to
// surface demand hotspots and recommend priority public projects.
// Store-agnostic: operates purely on Issue[] so it works identically over the
// MemoryStore and PostgresStore backends.
// ---------------------------------------------------------------------------

export interface Hotspot {
  id: string;
  centroidLat: number;
  centroidLng: number;
  issueCount: number;
  totalUpvotes: number;
  avgPriority: number;
  avgSeverity: number;
  topCategories: { id: string; name: string; count: number }[];
  leadingIssueId: string;
  leadingIssueTitle: string;
  areaName: string;
  state: string;
  district: string;
  demandScore: number; // 0-100
  radiusMeters: number;
}

export interface CategoryDemand {
  id: string;
  name: string;
  openCount: number;
  totalUpvotes: number;
  avgSeverity: number;
}

export interface StateDemand {
  state: string;
  districts: string[];
  openCount: number;
  totalUpvotes: number;
  avgSeverity: number;
  hotspotCount: number;
  topCategories: { id: string; name: string; count: number }[];
  riskLabel: string;
  pressureScore: number; // 0-100, relative national ranking
}

export interface NationalSummary {
  totalOpen: number;
  totalUpvotes: number;
  totalHotspots: number;
  statesCovered: number;
  districtsCovered: number;
  leadingState: string;
  leadingStateScore: number;
  leadingCategory: string;
  urgentStates: number;
  investmentFocus: string;
}

export interface DistrictDemand {
  district: string;
  state: string;
  openCount: number;
  totalUpvotes: number;
  avgSeverity: number;
  hotspotCount: number;
  topCategories: { id: string; name: string; count: number }[];
  pressureScore: number; // 0-100, relative ranking within the coverage area
}

export function buildDistrictDemand(issues: Issue[], hotspots: Hotspot[]): DistrictDemand[] {
  if (issues.length === 0) return [];

  const byDistrict = new Map<string, { state: string; issues: Issue[] }>();
  for (const issue of issues) {
    const district = issue.locationDetails?.district;
    if (!district) continue;
    const key = `${stateOf(issue) || 'Unknown'}|${district}`;
    const bucket = byDistrict.get(key);
    if (bucket) bucket.issues.push(issue);
    else byDistrict.set(key, { state: stateOf(issue) || 'Unknown', issues: [issue] });
  }

  const hotspotsByDistrict = new Map<string, number>();
  for (const hs of hotspots) {
    const key = `${hs.state}|${hs.district}`;
    hotspotsByDistrict.set(key, (hotspotsByDistrict.get(key) || 0) + 1);
  }

  const entries = Array.from(byDistrict.entries());
  const maxOpen = Math.max(...entries.map(([, v]) => v.issues.length), 1);
  const maxHotspots = Math.max(...Array.from(hotspotsByDistrict.values()), 1);

  return entries
    .map(([key, { state, issues: districtIssues }]) => {
      const catCounts = new Map<string, { id: string; name: string; count: number }>();
      let severity = 0;
      let upvotes = 0;
      for (const issue of districtIssues) {
        const entry = catCounts.get(issue.categoryId) || { id: issue.categoryId, name: issue.category.name, count: 0 };
        entry.count += 1;
        catCounts.set(issue.categoryId, entry);
        severity += issue.mlSeverityScore || 3;
        upvotes += issue.communityUpvotes;
      }

      const avgSeverity = severity / districtIssues.length;
      const pressureScore = Math.min(
        100,
        Math.round(
          55 * (districtIssues.length / maxOpen) + 30 * (avgSeverity / 5) + 15 * ((hotspotsByDistrict.get(key) || 0) / maxHotspots)
        )
      );

      return {
        district: key.split('|')[1],
        state,
        openCount: districtIssues.length,
        totalUpvotes: upvotes,
        avgSeverity: Number(avgSeverity.toFixed(2)),
        hotspotCount: hotspotsByDistrict.get(key) || 0,
        topCategories: Array.from(catCounts.values()).sort((a, b) => b.count - a.count).slice(0, 2),
        pressureScore,
      };
    })
    .sort((a, b) => b.pressureScore - a.pressureScore || b.openCount - a.openCount);
}

export interface ProjectRecommendation {
  rank: number;
  title: string;
  hotspotId: string;
  categoryId: string;
  category: string;
  departmentId: string;
  department: string;
  demandScore: number;
  rationale: string;
  estimatedImpact: string;
  indicativeInvestment: string;
  priority: 'high' | 'medium' | 'low';
}

/**
 * Response envelope of GET /api/admin/hotspots. Declared here rather than in the
 * consuming component so the admin console and the route that builds this payload
 * cannot drift apart.
 */
export interface HotspotsData {
  generatedAt: string;
  mode: 'gemini' | 'heuristic';
  dataSources: string[];
  counts: {
    totalOpen: number;
    totalResolved: number;
    totalUpvotes: number;
    hotspotCount: number;
    stateCount: number;
    districtCount: number;
  };
  hotspots: Hotspot[];
  recommendations: ProjectRecommendation[];
  categoryDemand: CategoryDemand[];
  stateDemand: StateDemand[];
  districtDemand: DistrictDemand[];
  national: NationalSummary;
  /**
   * Always present, empty when data.gov.in is unconfigured. The admin console
   * does not read it yet, but it is part of the response and belongs in the
   * envelope so the two stay honest about each other.
   */
  publicData: { indicators: DistrictIndicators[]; source: string | null };
}

// Static contextual datasets (lightweight substitute for live government
// feeds during the demo). In production these would be pulled from
// data.gov.in / ISRO-Bhuvan / FAO / WHO and cached in BigQuery or Firestore.
export const CONTEXTUAL_RISK: Record<string, { label: string; monsoonRisk: string; healthRisk: string }> = {
  'Andhra Pradesh': {
    label: 'Coastal urban centre, cyclonic exposure',
    monsoonRisk: 'Monsoon corridor — waterlogging compounds drainage failures',
    healthRisk: 'Stagnant water correlates with vector-borne disease clusters (WHO/NCVBDC)',
  },
  'Telangana': {
    label: 'High-population growth urban district',
    monsoonRisk: 'Flash-flood prone micro-drainage basins',
    healthRisk: 'Dense settlements amplify sanitation-linked outbreak risk',
  },
  'Karnataka': {
    label: 'IT-industrial hub, rapid peri-urban sprawl',
    monsoonRisk: 'Heavy southwest-monsoon skew',
    healthRisk: 'Lake-adjacent wards face leptospirosis exposure',
  },
  'Maharashtra': {
    label: 'Metropolitan-industrial corridor, high footfall density',
    monsoonRisk: 'Urban flood-prone low-lying wards experience intense rainfall',
    healthRisk: 'Density and drainage overload amplify vector-borne disease risk',
  },
  'Delhi': {
    label: 'National capital, extreme population density',
    monsoonRisk: 'Monsoon drainage overload and Yamuna floodplain exposure',
    healthRisk: 'Air quality and water-borne complaint co-occurrence is documented',
  },
  'Tamil Nadu': {
    label: 'Coastal metro with cyclone and surge exposure',
    monsoonRisk: 'Cyclonic storms raise surge and street-flood risk',
    healthRisk: 'Water scarcity coexists with intermittent drainage contamination',
  },
  'West Bengal': {
    label: 'High-density eastern metropolis, low-lying terrain',
    monsoonRisk: 'Monsoon waterlogging in low-lying wards is chronic',
    healthRisk: 'Drainage stagnation drives cholera and vector-borne alerts',
  },
  'Rajasthan': {
    label: 'Arid state, water-scarcity driven civic demand',
    monsoonRisk: 'Highly seasonal rainfall concentrates stress in monsoon months',
    healthRisk: 'Groundwater stress shapes water-supply grievance patterns',
  },
  'Uttar Pradesh': {
    label: 'Most populous state, fast-growing peri-urban belts',
    monsoonRisk: 'Flat terrain with poor micro-drainage during monsoon',
    healthRisk: 'Sanitation access gaps correlate with complaint density',
  },
  'Kerala': {
    label: 'High-rainfall coastal state, waterlogging endemic',
    monsoonRisk: 'Very heavy monsoon rainfall; persistent urban waterlogging',
    healthRisk: 'Mosquito and larval-disease risk rises with stagnant water',
  },
  'Assam': {
    label: 'Brahmaputra valley, flood-prone and climate-stressed',
    monsoonRisk: 'Annual Brahmaputra flooding displaces assets and blocks roads',
    healthRisk: 'Flood-related water contamination raises outbreak risk',
  },
  'Odisha': {
    label: 'Cyclone-bay coastal state, post-cyclone reconstruction',
    monsoonRisk: 'Cyclone and storm-surge exposure along the coastal belt',
    healthRisk: 'Saline and contaminated water post-storm drives health complaints',
  },
  'Gujarat': {
    label: 'Industrial and port economy, arid urban centres',
    monsoonRisk: 'Short intense monsoon bursts stress urban drains',
    healthRisk: 'Industrial and construction dust coexists with waste-burning complaints',
  },
};

export const DEFAULT_RISK = {
  label: 'Indian urban ward',
  monsoonRisk: 'Monsoon season amplifies infrastructure stress',
  healthRisk: 'Civic failure correlates with report density (data.gov.in ward indicators)',
};

const OPEN_STATUSES = new Set(['reported', 'in_review', 'verified', 'assigned', 'in_progress']);

export function isOpenIssue(issue: Issue): boolean {
  return OPEN_STATUSES.has(issue.status);
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function areaLabel(issue: Issue): string {
  if (issue.wardId) return issue.wardId;
  if (issue.locationDetails?.district) return issue.locationDetails.district;
  if (issue.locationDetails?.mandal) return issue.locationDetails.mandal;
  const state = stateOf(issue);
  if (state) return state;
  return 'Ward';
}

// DBSCAN-lite: greedy radius clustering by great-circle distance.
export function clusterIssues(issues: Issue[], epsMeters = 800): Issue[][] {
  const remaining = [...issues];
  const clusters: Issue[][] = [];
  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    const cluster: Issue[] = [seed];
    for (let i = remaining.length - 1; i >= 0; i--) {
      const cand = remaining[i];
      if (haversineMeters(seed.latitude, seed.longitude, cand.latitude, cand.longitude) <= epsMeters) {
        cluster.push(cand);
        remaining.splice(i, 1);
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

export function buildHotspots(issues: Issue[]): Hotspot[] {
  if (issues.length === 0) return [];

  const clusters = clusterIssues(issues);
  return clusters
    .map((cluster, idx) => {
      const count = cluster.length;
      const totalUpvotes = cluster.reduce((acc, i) => acc + i.communityUpvotes, 0);
      const avgSeverity =
        cluster.reduce((acc, i) => acc + (i.mlSeverityScore || 3), 0) / count;
      const avgPriority = cluster.reduce((acc, i) => acc + (i.priorityScore || 2), 0) / count;

      const cenLat = cluster.reduce((acc, i) => acc + i.latitude, 0) / count;
      const cenLng = cluster.reduce((acc, i) => acc + i.longitude, 0) / count;

      const catCounts = new Map<string, { id: string; name: string; count: number }>();
      for (const i of cluster) {
        const entry = catCounts.get(i.categoryId) || { id: i.categoryId, name: i.category.name, count: 0 };
        entry.count += 1;
        catCounts.set(i.categoryId, entry);
      }
      const topCategories = Array.from(catCounts.values()).sort((a, b) => b.count - a.count).slice(0, 3);

      const leading = [...cluster].sort((a, b) => b.priorityScore - a.priorityScore)[0];

      const demandScore = Math.min(
        100,
        Math.round(count * 12 + totalUpvotes * 5 + (avgPriority - 1) * 18)
      );

      // Farthest cluster member sets the radius.
      const radiusMeters = Math.max(
        100,
        Math.round(Math.max(...cluster.map((c) => haversineMeters(cenLat, cenLng, c.latitude, c.longitude))))
      );

      return {
        id: `hs-${idx + 1}`,
        centroidLat: Number(cenLat.toFixed(6)),
        centroidLng: Number(cenLng.toFixed(6)),
        issueCount: count,
        totalUpvotes,
        avgPriority: Number(avgPriority.toFixed(2)),
        avgSeverity: Number(avgSeverity.toFixed(2)),
        topCategories,
        leadingIssueId: leading.id,
        leadingIssueTitle: leading.title,
        areaName: areaLabel(leading),
        state: stateOf(leading) || 'Unknown',
        district: leading.locationDetails?.district || 'Unknown',
        demandScore,
        radiusMeters,
      };
    })
    .sort((a, b) => b.demandScore - a.demandScore);
}

export function buildCategoryDemand(issues: Issue[]): CategoryDemand[] {
  const map = new Map<string, CategoryDemand>();
  for (const issue of issues) {
    const entry = map.get(issue.categoryId) || {
      id: issue.categoryId,
      name: issue.category.name,
      openCount: 0,
      totalUpvotes: 0,
      avgSeverity: 0,
    };
    entry.openCount += 1;
    entry.totalUpvotes += issue.communityUpvotes;
    entry.avgSeverity += issue.mlSeverityScore || 3;
    map.set(issue.categoryId, entry);
  }
  return Array.from(map.values())
    .map((c) => ({ ...c, avgSeverity: Number((c.avgSeverity / Math.max(1, c.openCount)).toFixed(2)) }))
    .sort((a, b) => b.openCount - a.openCount);
}

export function buildStateDemand(issues: Issue[], hotspots: Hotspot[]): StateDemand[] {
  if (issues.length === 0) return [];

  const byState = new Map<string, Issue[]>();
  for (const issue of issues) {
    const state = stateOf(issue) || 'Unknown';
    const bucket = byState.get(state);
    if (bucket) bucket.push(issue);
    else byState.set(state, [issue]);
  }

  const hotspotsByState = new Map<string, number>();
  for (const hs of hotspots) {
    hotspotsByState.set(hs.state, (hotspotsByState.get(hs.state) || 0) + 1);
  }

  const maxOpen = Math.max(...Array.from(byState.values()).map((v) => v.length), 1);
  const maxHotspots = Math.max(...Array.from(hotspotsByState.values()), 1);

  return Array.from(byState.entries())
    .map(([state, stateIssues]) => {
      const catCounts = new Map<string, { id: string; name: string; count: number }>();
      const districts = new Set<string>();
      let severity = 0;
      let upvotes = 0;
      for (const issue of stateIssues) {
        const entry = catCounts.get(issue.categoryId) || { id: issue.categoryId, name: issue.category.name, count: 0 };
        entry.count += 1;
        catCounts.set(issue.categoryId, entry);
        severity += issue.mlSeverityScore || 3;
        upvotes += issue.communityUpvotes;
        const district = issue.locationDetails?.district;
        if (district) districts.add(district);
      }

      const avgSeverity = severity / stateIssues.length;
      const hotspotCount = hotspotsByState.get(state) || 0;
      const risk = CONTEXTUAL_RISK[state] || DEFAULT_RISK;

      const pressureScore = Math.min(
        100,
        Math.round(
          55 * (stateIssues.length / maxOpen) +
            30 * (avgSeverity / 5) +
            15 * (hotspotCount / maxHotspots)
        )
      );

      return {
        state,
        districts: Array.from(districts).sort(),
        openCount: stateIssues.length,
        totalUpvotes: upvotes,
        avgSeverity: Number(avgSeverity.toFixed(2)),
        hotspotCount,
        topCategories: Array.from(catCounts.values()).sort((a, b) => b.count - a.count).slice(0, 3),
        riskLabel: risk.label,
        pressureScore,
      };
    })
    .sort((a, b) => b.pressureScore - a.pressureScore || b.openCount - a.openCount);
}

export function buildNationalSummary(
  issues: Issue[],
  hotspots: Hotspot[],
  stateDemand: StateDemand[],
  categoryDemand: CategoryDemand[]
): NationalSummary {
  const districts = new Set<string>();
  for (const issue of issues) {
    const district = issue.locationDetails?.district;
    if (district) districts.add(district);
  }

  const leadingState = stateDemand[0];
  const leadingCategory = categoryDemand[0];
  const totalUpvotes = issues.reduce((acc, i) => acc + i.communityUpvotes, 0);
  const urgentStates = stateDemand.filter((s) => s.pressureScore >= 60).length;

  return {
    totalOpen: issues.length,
    totalUpvotes,
    totalHotspots: hotspots.length,
    statesCovered: stateDemand.filter((s) => s.state !== 'Unknown').length,
    districtsCovered: districts.size,
    leadingState: leadingState?.state || '—',
    leadingStateScore: leadingState?.pressureScore || 0,
    leadingCategory: leadingCategory?.name || '—',
    urgentStates,
    investmentFocus: leadingCategory
      ? `${leadingCategory.name} (${leadingCategory.openCount} open work orders, avg severity ${leadingCategory.avgSeverity})`
      : 'Awaiting citizen reports',
  };
}

const PROJECT_TEMPLATES: Record<string, (area: string) => string> = {
  pothole: (a) => `Relay and resurface arterial & collector roads in ${a}`,
  broken_drainage: (a) => `Reconstruct storm-drainage network in ${a}`,
  sewage: (a) => `Sewer de-silting and overflow containment in ${a}`,
  garbage: (a) => `Daily mechanical sweeping + segregation bins in ${a}`,
  street_light: (a) => `LED street-lighting retrofit in ${a}`,
  water_pipeline: (a) => `Water pipeline replacement & metering in ${a}`,
};

export function buildRecommendations(
  hotspots: Hotspot[],
  departments: Department[],
  issues: Issue[]
): ProjectRecommendation[] {
  const deptByCode = new Map(
    departments.filter((d) => !d.disabled).map((d) => [d.code, d])
  );
  return hotspots.slice(0, 8).map((hs, i) => {
    const top = hs.topCategories[0];
    const fundamental = issues.find((i) => i.id === hs.leadingIssueId);
    const stateName = (fundamental ? stateOf(fundamental) : undefined);
    const risk = (stateName && CONTEXTUAL_RISK[stateName]) || DEFAULT_RISK;
    const buildTitle = PROJECT_TEMPLATES[top.id.replace('cat-', '')] || ((a) => `Integrated civic asset repair programme in ${a}`);

    const priority = hs.demandScore >= 70 ? 'high' : hs.demandScore >= 40 ? 'medium' : 'low';

    const title = buildTitle(hs.areaName);

    const deptCode = fundamental?.category.responsibleDepartment || 'DEPT_PWD';
    const dept = deptByCode.get(deptCode) || deptByCode.get('DEPT_PWD');
    const departmentId = dept?.id || 'DEPT_PWD';
    const department = dept?.name || 'Public Works';

    return {
      rank: i + 1,
      title,
      hotspotId: hs.id,
      categoryId: top?.id || '',
      category: top?.name || 'Civic infrastructure',
      departmentId,
      department,
      demandScore: hs.demandScore,
      rationale: `${hs.issueCount} open grievance${hs.issueCount > 1 ? 's' : ''} across ${hs.topCategories.length} categor${hs.topCategories.length > 1 ? 'ies' : 'y'} cluster around ${hs.areaName} (${hs.totalUpvotes} community endorsements). ${risk.monsoonRisk}.`,
      estimatedImpact: `${risk.label}; ${risk.healthRisk}. Resolving ${hs.issueCount} work orders protects a dense catchment.`,
      indicativeInvestment: hs.demandScore >= 60 ? '₹40–80 lakh' : hs.demandScore >= 30 ? '₹15–40 lakh' : '₹5–15 lakh',
      priority,
    };
  });
}

export function buildPromptContext(
  issues: Issue[],
  hotspots: Hotspot[],
  categoryDemand: CategoryDemand[],
  stateDemand: StateDemand[] = [],
  districtDemand: DistrictDemand[] = []
): string {
  const stateCounts = new Map<string, number>();
  for (const i of issues) {
    const s = stateOf(i) || 'Unknown';
    stateCounts.set(s, (stateCounts.get(s) || 0) + 1);
  }

  return `
You are the Demand Intelligence advisor for CivicResolve, an Indian civic infrastructure platform that aggregates citizen grievances. Based ONLY on the data below, recommend 3-6 high-priority public projects for municipal policymakers with concise technical and community rationale.

DATA
Total open work orders: ${issues.length}
By state: ${Array.from(stateCounts.entries()).map(([s, c]) => `${s} (${c})`).join(', ')}
Category demand (name, open, upvotes, avg severity):
${categoryDemand.map((c) => `- ${c.name}: ${c.openCount} open, ${c.totalUpvotes} upvotes, severity ${c.avgSeverity}`).join('\n')}
Demand hotspots (id, area, issue count, upvotes, avg priority 1-5, top category, demand score 0-100):
${hotspots.map((h) => `- ${h.id} ${h.areaName}: ${h.issueCount} issues, ${h.totalUpvotes} upvotes, priority ${h.avgPriority}, top=${h.topCategories[0]?.name || 'n/a'}, score=${h.demandScore}`).join('\n')}
${stateDemand.length > 0 ? `State-level civic pressure (state, open, districts, hotspots, pressure score 0-100, leading risk):
${stateDemand.map((s) => `- ${s.state}: ${s.openCount} open across ${s.districts.length} district(s), ${s.hotspotCount} hotspots, pressure ${s.pressureScore}, risk=${s.riskLabel}`).join('\n')}
` : ''}${districtDemand.length > 0 ? `District-level civic pressure (district, state, open, hotspots, pressure 0-100, top category):
${districtDemand.slice(0, 15).map((d) => `- ${d.district} (${d.state}): ${d.openCount} open, ${d.hotspotCount} hotspots, pressure ${d.pressureScore}, top=${d.topCategories[0]?.name || 'n/a'}`).join('\n')}
` : ''}

Respond with a JSON object of shape:
{ "recommendations": [ { "rank": 1, "title": string, "hotspot_id": string, "category": string, "department": string, "rationale": string, "estimated_impact": string, "indicative_investment": string } ] }
Only structural, actionable municipal projects. Rank by urgency and community impact.
`;
}
