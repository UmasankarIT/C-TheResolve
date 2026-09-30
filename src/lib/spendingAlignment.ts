// ---------------------------------------------------------------------------
// Pure alignment maths for the demand-vs-planned-spending panel.
//
// Kept free of fs/http imports so the same function can run behind the API
// route, in tests, and directly in the client component. Shares are computed
// only over the comparison set — states that both have recorded development
// demand and a published plan row — because a share of a universe that mixes
// known allocations with unpublished ones would fabricate precision. A state
// with demand but no published plan row is reported as `no_plan_data`, not as
// zero spending.
// ---------------------------------------------------------------------------

export interface DemandByState {
  state: string | null | undefined;
  volume: number;
}

export interface SpendingByState {
  state: string;
  allocatedCrore: number;
  expenditureCrore: number;
}

export type AlignmentStatus = 'no_plan_data' | 'demand_higher' | 'plan_higher' | 'balanced';

export interface AlignmentRow {
  state: string;
  demandVolume: number;
  /** Share of total development-request demand, 0-1; null when there is no demand at all. */
  demandShare: number | null;
  allocatedCrore: number | null;
  expenditureCrore: number | null;
  /** Share of published allocation across the comparison set, 0-1; null without plan rows. */
  spendShare: number | null;
  /** demandShare - spendShare in percentage points; null unless both shares are known. */
  gapPoints: number | null;
  status: AlignmentStatus;
}

/** Gap (in percentage points) beyond which a state counts as off-balance. */
const BALANCE_DEADBAND_POINTS = 2;

export function computeSpendingAlignment(
  demand: DemandByState[],
  spending: SpendingByState[]
): AlignmentRow[] {
  const demandVolumeByState = new Map<string, number>();
  for (const { state, volume } of demand) {
    const key = (state ?? '').trim() || 'Unspecified state';
    demandVolumeByState.set(key, (demandVolumeByState.get(key) ?? 0) + Math.max(0, volume));
  }

  const spendingByState = new Map<string, SpendingByState>();
  for (const row of spending) {
    spendingByState.set(row.state, row);
  }

  const comparisonStates = Array.from(demandVolumeByState.keys()).filter((state) => spendingByState.has(state));

  const comparisonDemand = comparisonStates.reduce((sum, state) => sum + (demandVolumeByState.get(state) ?? 0), 0);
  const comparisonAllocation = comparisonStates.reduce(
    (sum, state) => sum + (spendingByState.get(state)?.allocatedCrore ?? 0),
    0
  );

  const states = Array.from(demandVolumeByState.keys()).sort((a, b) => {
    const diff = (demandVolumeByState.get(b) ?? 0) - (demandVolumeByState.get(a) ?? 0);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  return states.map((state) => {
    const demandVolume = demandVolumeByState.get(state) ?? 0;
    const plan = spendingByState.get(state);
    const planKnown = plan !== undefined;

    const inComparisonSet = comparisonStates.includes(state);
    const demandShare = inComparisonSet && comparisonDemand > 0 ? demandVolume / comparisonDemand : null;
    const spendShare =
      inComparisonSet && planKnown && comparisonAllocation > 0 ? plan.allocatedCrore / comparisonAllocation : null;

    let gapPoints: number | null = null;
    if (demandShare !== null && spendShare !== null) {
      gapPoints = (demandShare - spendShare) * 100;
    }

    let status: AlignmentStatus;
    if (!planKnown) {
      status = 'no_plan_data';
    } else if (gapPoints === null) {
      status = 'balanced';
    } else if (gapPoints > BALANCE_DEADBAND_POINTS) {
      status = 'demand_higher';
    } else if (gapPoints < -BALANCE_DEADBAND_POINTS) {
      status = 'plan_higher';
    } else {
      status = 'balanced';
    }

    return {
      state,
      demandVolume,
      demandShare,
      allocatedCrore: planKnown ? plan.allocatedCrore : null,
      expenditureCrore: planKnown ? plan.expenditureCrore : null,
      spendShare,
      gapPoints,
      status,
    };
  });
}
