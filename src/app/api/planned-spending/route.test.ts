import { describe, it, expect } from 'vitest';
import { GET } from './route';

// ---------------------------------------------------------------------------
// The planned-spending endpoint is intentionally unauthenticated (like
// demand-signals) and must always answer 200: the panel treats
// `available: false` as a first-class state so a missing dataset degrades the
// dashboard instead of erroring it.
// ---------------------------------------------------------------------------

describe('GET /api/planned-spending', () => {
  it('serves the cited dataset', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.available).toBe(true);
    expect(json.rowCount).toBe(34);
    expect(json.scheme).toBe('Jal Jeevan Mission (central share)');
    expect(json.source).toContain('Ministry of Jal Shakti');
    expect(json.sourceUrl).toContain('http');
    expect(Array.isArray(json.rows)).toBe(true);

    const ap = json.rows.find((row: { state: string }) => row.state === 'Andhra Pradesh');
    expect(ap.allocatedCrore).toBe(2520.97);
    expect(ap.grain).toBe('state');
    expect(ap.sourceUrl.length).toBeGreaterThan(0);
  });
});
