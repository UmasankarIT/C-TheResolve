import { describe, it, expect } from 'vitest';
import { formatAddress, emptyReverseGeocode, type ReverseGeocodeResult } from './geocoding';

/**
 * formatAddress replaced a generator that picked from two six-element lists
 * using `hash % length` for both, so the indices always matched and only six
 * fixed strings could ever be produced. These tests pin the properties that
 * matter: real parts are used, missing parts never invented, and the coordinate
 * always survives so two issues on one road stay distinguishable.
 */

function geo(overrides: Partial<ReverseGeocodeResult> = {}): ReverseGeocodeResult {
  return { ...emptyReverseGeocode(), ...overrides };
}

describe('formatAddress', () => {
  it('builds a label from the parts the geocoder actually returned', () => {
    const addr = formatAddress(
      geo({
        road: 'Muzaffar Ahmed Street',
        suburb: 'Ripon Street',
        town: 'Kolkata',
        district: 'Kolkata',
        state: 'West Bengal',
        pincode: '700016',
      }),
      22.5535,
      88.355
    );
    expect(addr).toContain('Muzaffar Ahmed Street');
    expect(addr).toContain('Kolkata');
    expect(addr).toContain('West Bengal');
    expect(addr).toContain('700016');
  });

  it('omits parts that were not resolved instead of inventing them', () => {
    // A point with no road mapped in OSM must not gain a plausible road.
    const addr = formatAddress(
      geo({ suburb: 'Patamata Lanka', town: 'Vijayawada', state: 'Andhra Pradesh' }),
      16.5062,
      80.648
    );
    expect(addr).not.toMatch(/Road|Road,|Street/);
    expect(addr).toContain('Patamata Lanka');
    expect(addr).toContain('Vijayawada');
  });

  it('does not repeat a value that appears in two fields', () => {
    // district === town is very common in Indian addresses; the label should
    // read "Kolkata" once, not "Kolkata, Kolkata".
    const addr = formatAddress(
      geo({ town: 'Kolkata', district: 'Kolkata', state: 'West Bengal' }),
      22.5535,
      88.355
    );
    const occurrences = addr.split('Kolkata').length - 1;
    expect(occurrences).toBe(1);
  });

  it('always ends with the coordinate so same-road issues stay distinct', () => {
    const base = geo({ road: 'MG Road', town: 'Pune', state: 'Maharashtra' });
    const a = formatAddress(base, 18.5204, 73.8567);
    const b = formatAddress(base, 18.5209, 73.8567);
    expect(a).not.toBe(b);
    expect(a).toContain('18.52040');
    expect(b).toContain('18.52090');
  });

  it('degrades to a coordinate label when nothing resolved', () => {
    const addr = formatAddress(null, 14.6819, 77.6006);
    expect(addr).toBe('Dropped pin (14.68190, 77.60060)');
  });

  it('degrades to a coordinate label for an all-null result', () => {
    // This is the geocoder-outage path: the report must still be filed.
    const addr = formatAddress(geo(), 14.6819, 77.6006);
    expect(addr).toBe('Dropped pin (14.68190, 77.60060)');
  });

  it('distinguishes locations that the old generator collapsed to one string', () => {
    // The removed implementation could emit only six fixed strings, so any two
    // coordinates landed on the same road unless they hashed to the same bucket.
    // Same road and town, different pins: labels must differ.
    const g = geo({ road: 'MG Road', town: 'Pune', state: 'Maharashtra', pincode: '411001' });
    const set = new Set(
      [
        [18.52, 73.85],
        [18.53, 73.86],
        [18.54, 73.87],
        [18.55, 73.88],
        [18.56, 73.89],
        [18.57, 73.9],
        [18.58, 73.91],
      ].map(([la, lo]) => formatAddress(g, la, lo))
    );
    expect(set.size).toBe(7);
  });
});

describe('emptyReverseGeocode', () => {
  it('returns nulls, not undefined, so "looked up and found nothing" is distinct', () => {
    // The report handler uses ?? against client-supplied details, which only
    // falls back correctly if these are null rather than undefined.
    const empty = emptyReverseGeocode();
    for (const v of Object.values(empty)) {
      expect(v).toBeNull();
    }
  });
});
