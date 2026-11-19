import express from 'express';
import pg from 'pg';
import { createClient } from 'redis';
import fs from 'node:fs';

// Secret ko file se parho (Docker secret), warna plain env var (sirf local dev ke liye)
function readSecret(name) {
  const file = process.env[`${name}_FILE`];
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return process.env[name];
}

const PORT = Number(process.env.PORT || 3000);

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  database: process.env.DB_NAME,
  password: readSecret('DB_PASSWORD'),
});

const redis = createClient({ url: process.env.REDIS_URL || 'redis://cache:6379' });
redis.on('error', (e) => console.error('Redis error:', e.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function init() {
  for (let i = 1; i <= 10; i++) {
    try {
      await pool.query(
        'CREATE TABLE IF NOT EXISTS visits (id SERIAL PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT now())'
      );
      await redis.connect();
      return;
    } catch (e) {
      console.log(`Dependencies ready nahi (try ${i}/10): ${e.message}`);
      await sleep(2000);
    }
  }
  throw new Error('Database/Redis tak pohanch nahi saka');
}

const app = express();

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/visits', async (_req, res) => {
  try {
    await pool.query('INSERT INTO visits DEFAULT VALUES');
    const { rows } = await pool.query('SELECT count(*)::int AS total FROM visits');
    const cacheHits = await redis.incr('api:hits');
    res.json({ db_total_visits: rows[0].total, redis_api_hits: cacheHits });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal error' });
  }
});

await init();
const server = app.listen(PORT, '0.0.0.0', () => console.log(`API listening on :${PORT}`));

// Graceful shutdown (docker stop ke liye)
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server.close();
    await pool.end();
    await redis.quit();
    process.exit(0);
  });
}
