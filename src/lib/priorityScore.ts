import { DemandSignal, PriorityBreakdown, PriorityWeights } from './types';

// ---------------------------------------------------------------------------
// Step 5 — transparent demand-signal priority scoring.
//
// Policy, not a model. Every demand signal gets a priority score in [0, 1]
// from a four-term weighted formula whose weights are fixed constants:
//
//   priority = (0.35 * normalized_volume)
//            + (0.25 * normalized_avg_urgency)
//            + (0.25 * infrastructure_gap_score)
//            + (0.15 * normalized_population_affected)
//
// Normalisation rules (what makes each term comparable and explainable):
//
//   * volume and population_affected are min-max scaled across the current
//     cluster set, and scaled again on every scoring call — a cluster has "high
//     volume" relative to the signals the policymaker is looking at right now,
//     not relative to some fixed historical maximum.
//   * avg_urgency is the 1-5 scale the pipeline already produces, mapped to
//     0-1 with (x - 1) / 4 (5 reports at 1-map to 0 rather than 0.2, because a
//     never-urgent report is genuinely the floor of the scale).
//   * infrastructure_gap is a percentage (0-100) from the Census HL-11 tables,
//     mapped to 0-1 by dividing by 100. It is already a 0-1 term in effect.
//
// Missing data is handled by dropping the term and renormalising the remaining
// weights so they still sum to 1. This keeps scores comparable across clusters
// (a [0, 1] score stays [0, 1] whether or not a district has data) and, unlike
// substituting a hard zero, never punishes an area for the open data being
// absent. What was dropped, and the renormalised weights that took its place,
// are recorded on `priorityBreakdown` so a judge can re-derive the number.
// ---------------------------------------------------------------------------

export type PriorityBand = 'low' | 'medium' | 'high';

export const PRIORITY_WEIGHTS = {
  volume: 0.35,
  avgUrgency: 0.25,
  infrastructureGap: 0.25,
  populationAffected: 0.15,
} as const;

/** Score is "high" at >= 0.7, "medium" at >= 0.4, else "low". */
export const PRIORITY_BAND_CUTOFFS = { high: 0.7, medium: 0.4 } as const;

/** A normalised term is "high / medium / low" at these cutoffs. */
export const COMPONENT_BAND_CUTOFFS = { high: 2 / 3, medium: 1 / 3 } as const;

export interface ScoredDemandSignal extends DemandSignal {
  priorityScore: number;
  priorityExplanation: string;
  priorityBreakdown: PriorityBreakdown;
  dataUnavailable: boolean;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Nudged, not truncated, so a score that sums to 0.67175 is 0.672. */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Min and max over the finite values in the range. Returns null when there is
 * nothing to scale — the caller treats that as "no data", never as 0.
 */
export function minMax(values: number[]): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let seen = 0;
  for (const value of values) {
    if (!isNumber(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
    seen++;
  }
  return seen === 0 ? null : { min, max };
}

/**
 * Min-max normalisation to [0, 1]. When every observed value is identical the
 * range has no spread, so each one is simultaneously the minimum and the
 * maximum; 1 keeps the term meaningful instead of zeroing every cluster out.
 */
export function minMaxNormalize(value: number, range: { min: number; max: number }): number {
  if (!isNumber(value)) return 0;
  if (range.max === range.min) return 1;
  return clamp((value - range.min) / (range.max - range.min), 0, 1);
}

/** Urgency (1-5) to [0, 1] via (x - 1) / 4. */
export function normalizeAvgUrgency(avgUrgency: number): number {
  if (!isNumber(avgUrgency)) return 0;
  return clamp((avgUrgency - 1) / 4, 0, 1);
}

/** Infrastructure gap percentage (0-100) to [0, 1]; null stays null. */
export function infrastructureGapScore(gapPercent: number | null): number | null {
  if (gapPercent === null || !isNumber(gapPercent)) return null;
  return clamp(gapPercent / 100, 0, 1);
}

export function priorityBand(score: number): PriorityBand {
  if (score >= PRIORITY_BAND_CUTOFFS.high) return 'high';
  if (score >= PRIORITY_BAND_CUTOFFS.medium) return 'medium';
  return 'low';
}

export function componentBand(normalized: number): PriorityBand {
  if (normalized >= COMPONENT_BAND_CUTOFFS.high) return 'high';
  if (normalized >= COMPONENT_BAND_CUTOFFS.medium) return 'medium';
  return 'low';
}

export interface PriorityComponents {
  normalizedVolume: number;
  normalizedAvgUrgency: number;
  infrastructureGapScore: number | null;
  normalizedPopulationAffected: number | null;
}

export interface CompositeScore {
  score: number;
  weights: PriorityWeights;
}

/**
 * Combines the available terms into one [0, 1] score. Each term's weight is
 * renormalized by the sum of the weights of the terms that are actually
 * present, so the score stays on [0, 1] and never silently substitutes a zero
 * for absent data.
 */
export function combinePriorityComponents(components: PriorityComponents): CompositeScore {
  const present: { key: keyof PriorityWeights; rawWeight: number; value: number }[] = [];
  if (Number.isFinite(components.normalizedVolume)) {
    present.push({ key: 'volume', rawWeight: PRIORITY_WEIGHTS.volume, value: components.normalizedVolume });
  }
  if (Number.isFinite(components.normalizedAvgUrgency)) {
    present.push({ key: 'avgUrgency', rawWeight: PRIORITY_WEIGHTS.avgUrgency, value: components.normalizedAvgUrgency });
  }
  if (components.infrastructureGapScore !== null && Number.isFinite(components.infrastructureGapScore)) {
    present.push({ key: 'infrastructureGap', rawWeight: PRIORITY_WEIGHTS.infrastructureGap, value: components.infrastructureGapScore });
  }
  if (components.normalizedPopulationAffected !== null && Number.isFinite(components.normalizedPopulationAffected)) {
    present.push({ key: 'populationAffected', rawWeight: PRIORITY_WEIGHTS.populationAffected, value: components.normalizedPopulationAffected });
  }

  const weightSum = present.reduce((sum, term) => sum + term.rawWeight, 0);
  const weights: PriorityWeights = { volume: 0, avgUrgency: 0, infrastructureGap: 0, populationAffected: 0 };

  let score = 0;
  for (const term of present) {
    const effective = weightSum > 0 ? term.rawWeight / weightSum : 0;
    weights[term.key] = round3(effective);
    score += effective * term.value;
  }

  return { score: round3(score), weights };
}

/** Rounds residents to a readable count: "~12,000 residents" / "~4.29 million residents". */
export function formatAffected(population: number): string {
  if (!isNumber(population)) return '~0 residents';
  if (population >= 1_000_000) {
    return `~${(population / 1_000_000).toFixed(2)} million residents`;
  }
  const grouped = String(Math.round(population)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `~${grouped} residents`;
}

export interface ExplanationParams {
  volume: number;
  normalizedVolume: number;
  avgUrgency: number;
  infrastructureGapScore: number | null;
  populationAffected: number | null;
  score: number;
  dataUnavailable: boolean;
}

/**
 * The human-readable why behind a score, built from the actual numbers on the
 * row — never from a template. The band labels come from the same normalised
 * values the formula used, so "high volume" means "at the top of the current
 * cluster set", which is exactly what the number says.
 */
export function buildPriorityExplanation(params: ExplanationParams): string {
  const parts: string[] = [
    `${params.volume} ${params.volume === 1 ? 'report' : 'reports'} (${componentBand(params.normalizedVolume)} volume)`,
    `average urgency ${params.avgUrgency.toFixed(1)}/5`,
  ];
  if (params.infrastructureGapScore !== null) {
    parts.push(
      `infrastructure gap score ${params.infrastructureGapScore.toFixed(2)} for this area ` +
        `(${(params.infrastructureGapScore * 100).toFixed(1)}% of households have no latrine within premises)`
    );
  }
  if (params.populationAffected !== null) {
    parts.push(`affecting ${formatAffected(params.populationAffected)}`);
  }

  const band = priorityBand(params.score);
  // The score is shown to the same three decimals that `priority_score` is
  // stored with in the JSON, so the number in the sentence is byte-identical
  // to the number on the row and the band can never contradict what is shown.
  let explanation =
    `${band[0].toUpperCase()}${band.slice(1)} priority (score ${params.score.toFixed(3)}): ${parts.join(', ')}.`;

  if (params.dataUnavailable) {
    explanation +=
      ' Population and infrastructure gap data were not available for this area, so the score uses only reporting volume and urgency.';
  } else if (params.infrastructureGapScore === null) {
    explanation +=
      ' Infrastructure gap data were not available for this area, so the remaining components were reweighted.';
  }
  return explanation;
}

/**
 * Scores every signal in the set and returns them sorted by priority,
 * descending. All cluster-relative terms (volume, population) are min-max
 * scaled over the set passed in, so a rebuild with the same corpus is
 * deterministic and a different corpus renormalizes automatically.
 */
export function scoreDemandSignals(signals: DemandSignal[]): ScoredDemandSignal[] {
  const volumeRange = minMax(signals.map((s) => s.volume));
  const populationRange = minMax(
    signals.map((s) => s.populationAffected ?? null).filter((v): v is number => v !== null)
  );

  const scored = signals.map((signal) => {
    const hasPopulation = signal.populationAffected !== null && signal.populationAffected !== undefined;
    const hasGap = signal.existingInfrastructureGap !== null && signal.existingInfrastructureGap !== undefined;

    const normalizedVolume = volumeRange ? minMaxNormalize(signal.volume, volumeRange) : 0;
    const normalizedAvgUrgency = normalizeAvgUrgency(signal.avgUrgency);
    const gapScore = infrastructureGapScore(hasGap ? (signal.existingInfrastructureGap as number) : null);
    const normalizedPopulation =
      hasPopulation && populationRange ? minMaxNormalize(signal.populationAffected as number, populationRange) : null;

    // "No reference data at all" — neither population nor gap. A district with
    // population but no gap (Tirupati/NTR) is not data-unavailable; it just
    // scores without one term.
    const dataUnavailable = !hasPopulation && !hasGap;

    const { score, weights } = combinePriorityComponents({
      normalizedVolume,
      normalizedAvgUrgency,
      infrastructureGapScore: gapScore,
      normalizedPopulationAffected: normalizedPopulation,
    });

    return {
      ...signal,
      priorityScore: score,
      priorityExplanation: buildPriorityExplanation({
        volume: signal.volume,
        normalizedVolume,
        avgUrgency: signal.avgUrgency,
        infrastructureGapScore: gapScore,
        populationAffected: hasPopulation ? (signal.populationAffected as number) : null,
        score,
        dataUnavailable,
      }),
      priorityBreakdown: {
        normalizedVolume: round3(normalizedVolume),
        normalizedAvgUrgency: round3(normalizedAvgUrgency),
        infrastructureGapScore: gapScore === null ? null : round3(gapScore),
        normalizedPopulationAffected: normalizedPopulation === null ? null : round3(normalizedPopulation),
        weights,
      } satisfies PriorityBreakdown,
      dataUnavailable,
    };
  });

  // Ties break on volume then cluster id so the order is a function of the
  // corpus alone and a rebuild cannot reshuffle an equal-scoring pair.
  return scored.sort(
    (a, b) =>
      b.priorityScore - a.priorityScore ||
      b.volume - a.volume ||
      a.clusterId.localeCompare(b.clusterId)
  );
}