import { beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PostgresStore } from './postgresStore';
import type { Complaint } from './types';

// Integration tests against a real server. They are skipped unless
// DATABASE_URL is set, so `npm test` still passes with no Postgres running.
// Setting DATABASE_URL to something unreachable is a failure, not a skip, so a
// broken CI connection cannot quietly look green.
//
// These exist because of a bug no unit test could have caught: the complaint
// embedding was serialised as the Postgres array literal "{1,2,3}" and cast to
// ::vector, which pgvector rejects with 'Vector contents must start with "["'.
// Every stub-based test passed while the real write path failed on first use.
const url = process.env.DATABASE_URL;
const id = 'it-vector-roundtrip';

const complaint: Complaint = {
  id,
  issueType: 'pothole',
  location: 'ward-1',
  locationGranularity: 'ward',
  urgencyScore: 2,
  originalLanguage: 'English',
  originalText: 'pothole on the road',
  translatedText: 'pothole on the road',
  extractionEngine: 'heuristic',
};

describe.skipIf(!url)('PostgresStore complaint embeddings (live pgvector)', () => {
  beforeAll(async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
  });

  async function reset() {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query('DELETE FROM complaints WHERE id = $1', [id]);
    await client.end();
  }

  it('stores a vector in pgvector text format and reads it back', async () => {
    await reset();
    const store = new PostgresStore();
    await store.upsertComplaints([complaint]);

    // pgvector's input format is "[1,2,3]". The near-identical array form
    // "{1,2,3}" is what the previous implementation sent.
    const vector = [0.125, -0.25, 0.5, 0.75, -1];
    await store.setComplaintEmbedding(id, vector, 'test-model');

    const [stored] = await store.listComplaints();
    expect(stored.id).toBe(id);
    expect(stored.embedding).toEqual(vector);
    expect(stored.embeddingModel).toBe('test-model');
    expect(stored.embeddingDimensions).toBe(vector.length);

    await reset();
  });

  it('records the dimension from the vector, not the caller', async () => {
    await reset();
    const store = new PostgresStore();
    await store.upsertComplaints([complaint]);
    await store.setComplaintEmbedding(id, [1, 2, 3, 4, 5, 6, 7, 8], 'test-model');

    const [stored] = await store.listComplaints();
    expect(stored.embeddingDimensions).toBe(8);

    await reset();
  });

  it('preserves a stored embedding across an upsert that does not change the text', async () => {
    await reset();
    const store = new PostgresStore();
    await store.upsertComplaints([complaint]);
    await store.setComplaintEmbedding(id, [0.1, 0.2, 0.3], 'test-model');

    // Re-running extraction with identical text must not orphan the vector:
    // rebuilding demand signals would otherwise re-bill the embedding call.
    await store.upsertComplaints([{ ...complaint, urgencyScore: 3 }]);

    const [stored] = await store.listComplaints();
    expect(stored.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(stored.urgencyScore).toBe(3);

    await reset();
  });
});

describe.skipIf(!url)('PostgresStore Step 4 data fusion (live)', () => {
  const signalId = 'it-ds-fusion';
  const sourceText = 'Census of India 2011, Series A-1; Census of India 2011, HL-11';

  async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  it('applies migration 0006 and seeds the reference table from the CSV', async () => {
    // A store boot runs every pending migration and the seed, so touching the
    // read path is enough to drive it.
    const store = new PostgresStore();
    await store.listDemandSignals();

    await withClient(async (c) => {
      const cols = await c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'demand_signals'
            AND column_name IN ('population_affected', 'existing_infrastructure_gap', 'data_fusion_source')`
      );
      expect(cols.rows.map((r: { column_name: string }) => r.column_name).sort()).toEqual(
        ['data_fusion_source', 'existing_infrastructure_gap', 'population_affected']
      );

      const east = await c.query(
        `SELECT population, infrastructure_gap FROM location_statistics
          WHERE state = 'Andhra Pradesh' AND district = 'East Godavari'`
      );
      expect(Number(east.rows[0].population)).toBe(5154296);
      expect(Number(east.rows[0].infrastructure_gap)).toBe(43.1);

      const count = await c.query('SELECT COUNT(*)::int AS n FROM location_statistics');
      expect(count.rows[0].n).toBe(24);
    });
  });

  it('reads the fused columns back through listDemandSignals', async () => {
    // Written via SQL with a throwaway cluster id so the live build's real
    // rows are never replaced (replaceDemandSignals is a full wipe by design).
    await withClient(async (c) => {
      await c.query('DELETE FROM demand_signals WHERE cluster_id = $1', [signalId]);
      await c.query(
        `INSERT INTO demand_signals
           (cluster_id, issue_type, location, location_state, location_district,
            volume, avg_urgency, member_complaint_ids, population_affected,
            existing_infrastructure_gap, data_fusion_source)
         VALUES ($1, 'pothole', 'Visakhapatnam, Andhra Pradesh', 'Andhra Pradesh', 'Visakhapatnam',
                 1, 3, '{it-c}', 4290589, 48.7, $2)`,
        [signalId, sourceText]
      );
    });

    try {
      const store = new PostgresStore();
      const [row] = (await store.listDemandSignals()).filter((s) => s.clusterId === signalId);
      expect(row).toBeDefined();
      expect(row.populationAffected).toBe(4290589);
      expect(row.existingInfrastructureGap).toBe(48.7);
      expect(row.dataFusionSource).toBe(sourceText);
    } finally {
      await withClient(async (c) => {
        await c.query('DELETE FROM demand_signals WHERE cluster_id = $1', [signalId]);
      });
    }
  });
});
