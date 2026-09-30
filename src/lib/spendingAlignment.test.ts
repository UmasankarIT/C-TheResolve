import { describe, it, expect } from 'vitest';
import { computeSpendingAlignment } from './spendingAlignment';

// ---------------------------------------------------------------------------
// Demand-vs-spending alignment maths. The invariants that matter here:
// shares are only comparable inside the set of states that have both demand
// and a published plan row; a state without a plan row reports `no_plan_data`
// and never a fabricated zero; and gap is demand share minus plan share in
// percentage points with a ±2pp deadband before a state is called off-balance.
// ---------------------------------------------------------------------------

const AP = { state: 'Andhra Pradesh', allocatedCrore: 2520.97, expenditureCrore: 973.52 };
const KA = { state: 'Karnataka', allocatedCrore: 3804.41, expenditureCrore: 10842.68 };
const TS = { state: 'Telangana', allocatedCrore: 0, expenditureCrore: 0 };
const MH = { state: 'Maharashtra', allocatedCrore: 5352.93, expenditureCrore: 5385.71 };

describe('computeSpendingAlignment', () => {
  it('computes shares over the comparison set only', () => {
    const rows = computeSpendingAlignment(
      [
        { state: 'Andhra Pradesh', volume: 50 },
        { state: 'Karnataka', volume: 30 },
        { state: 'Delhi', volume: 20 },
      ],
      [AP, KA, MH]
    );

    const byState = new Map(rows.map((r) => [r.state, r]));

    // Delhi has demand but no plan row: excluded from both denominators.
    const delhi = byState.get('Delhi')!;
    expect(delhi.status).toBe('no_plan_data');
    expect(delhi.allocatedCrore).toBeNull();
    expect(delhi.spendShare).toBeNull();
    expect(delhi.gapPoints).toBeNull();
    expect(delhi.demandShare).toBeNull();

    // Comparison demand = 50 + 30 = 80; comparison allocation = AP + KA.
    const comparisonAllocation = AP.allocatedCrore + KA.allocatedCrore;
    const ap = byState.get('Andhra Pradesh')!;
    expect(ap.demandShare).toBeCloseTo(50 / 80, 10);
    expect(ap.spendShare).toBeCloseTo(AP.allocatedCrore / comparisonAllocation, 10);
    expect(ap.gapPoints).toBeCloseTo((50 / 80 - AP.allocatedCrore / comparisonAllocation) * 100, 6);

    const ka = byState.get('Karnataka')!;
    expect(ka.demandShare).toBeCloseTo(30 / 80, 10);

    // Maharashtra has a plan row but no demand, so it never enters the table.
    expect(byState.has('Maharashtra')).toBe(false);
  });

  it('flags a zero allocation with real demand as demand_higher', () => {
    const rows = computeSpendingAlignment(
      [
        { state: 'Telangana', volume: 40 },
        { state: 'Andhra Pradesh', volume: 60 },
      ],
      [AP, TS]
    );
    const ts = rows.find((r) => r.state === 'Telangana')!;
    expect(ts.allocatedCrore).toBe(0);
    expect(ts.spendShare).toBe(0);
    expect(ts.gapPoints).toBeCloseTo(40, 6); // all of the comparison demand, none of the allocation
    expect(ts.status).toBe('demand_higher');
  });

  it('calls a gap inside the ±2pp deadband balanced', () => {
    // AP: demand share 50%, plan share exactly 50%.
    const rows = computeSpendingAlignment(
      [
        { state: 'Andhra Pradesh', volume: 50 },
        { state: 'Karnataka', volume: 50 },
      ],
      [
        { state: 'Andhra Pradesh', allocatedCrore: 50, expenditureCrore: 40 },
        { state: 'Karnataka', allocatedCrore: 50, expenditureCrore: 45 },
      ]
    );
    const ap = rows.find((r) => r.state === 'Andhra Pradesh')!;
    expect(ap.gapPoints).toBeCloseTo(0, 10);
    expect(ap.status).toBe('balanced');
  });

  it('marks plan share higher when allocation outweighs demand share', () => {
    const rows = computeSpendingAlignment(
      [
        { state: 'Andhra Pradesh', volume: 95 },
        { state: 'Karnataka', volume: 5 },
      ],
      [AP, KA]
    );
    const ka = rows.find((r) => r.state === 'Karnataka')!;
    expect(ka.gapPoints!).toBeLessThan(-2);
    expect(ka.status).toBe('plan_higher');
  });

  it('returns no rows when there is no demand', () => {
    expect(computeSpendingAlignment([], [AP, KA])).toEqual([]);
  });

  it('degrades to null shares instead of dividing by zero', () => {
    const rows = computeSpendingAlignment(
      [
        { state: 'Andhra Pradesh', volume: 10 },
        { state: 'Karnataka', volume: 10 },
      ],
      [
        { state: 'Andhra Pradesh', allocatedCrore: 0, expenditureCrore: 0 },
        { state: 'Karnataka', allocatedCrore: 0, expenditureCrore: 0 },
      ]
    );
    for (const row of rows) {
      expect(row.spendShare).toBeNull();
      expect(row.gapPoints).toBeNull();
    }
  });

  it('aggregates multiple clusters of the same state and sorts by demand', () => {
    const rows = computeSpendingAlignment(
      [
        { state: 'Andhra Pradesh', volume: 3 },
        { state: 'Karnataka', volume: 10 },
        { state: 'Andhra Pradesh', volume: 7 },
        { state: null, volume: 4 },
      ],
      [AP, KA]
    );
    expect(rows.map((r) => r.state)).toEqual(['Andhra Pradesh', 'Karnataka', 'Unspecified state']);
    expect(rows[0].demandVolume).toBe(10);
    expect(rows[1].demandVolume).toBe(10);
    expect(rows[2].demandVolume).toBe(4);
    expect(rows[2].status).toBe('no_plan_data');
  });
});
