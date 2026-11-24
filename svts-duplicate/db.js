const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_CONNECTION_STRING;
if (!connectionString) {
  console.warn('DATABASE_URL is not set. PostgreSQL connection may fail until it is configured.');
}

const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSLMODE === 'disable' || process.env.NODE_ENV !== 'production' ? false : { rejectUnauthorized: false }
});

function convertPlaceholders(sql) {
  // Convert SQLite-style ? placeholders to PostgreSQL $1, $2, ... (best-effort; avoids changing ?? not expected here)
  let i = 0;
  return String(sql).replace(/\?/g, () => `$${++i}`);
}

function normalizeArgs(sql, params) {
  if (Array.isArray(params)) return [convertPlaceholders(sql), params];
  if (params === undefined) return [convertPlaceholders(sql), []];
  return [convertPlaceholders(sql), [params]];
}

async function query(text, params = []) {
  const [sql, values] = normalizeArgs(text, params);
  return pool.query(sql, values);
}

async function all(text, params = []) {
  const res = await query(text, params);
  return res.rows;
}

async function get(text, params = []) {
  const res = await query(text, params);
  return res.rows[0] || undefined;
}

async function run(text, params = []) {
  const res = await query(text, params);
  const first = res.rows[0] || {};
  const insertedId = first.id ?? first.ID ?? null;
  return {
    rowCount: res.rowCount || 0,
    rows: res.rows,
    lastInsertRowid: insertedId != null ? Number(insertedId) : undefined
  };
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const scoped = {
      async query(text, params = []) {
        const [sql, values] = normalizeArgs(text, params);
        return client.query(sql, values);
      },
      async all(text, params = []) { return (await this.query(text, params)).rows; },
      async get(text, params = []) { return (await this.query(text, params)).rows[0]; },
      async run(text, params = []) {
        const res = await this.query(text, params);
        const first = res.rows[0] || {};
        const insertedId = first.id ?? first.ID ?? null;
        return { rowCount: res.rowCount || 0, rows: res.rows, lastInsertRowid: insertedId != null ? Number(insertedId) : undefined };
      }
    };
    const result = await fn(scoped);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

let initPromise;
async function init() {
  if (!initPromise) {
    initPromise = (async () => {
      const schemaPath = path.join(__dirname, 'database', 'schema.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await pool.query(schema);
    })();
  }
  return initPromise;
}

module.exports = {
  pool,
  query: async (text, params) => { await init(); return query(text, params); },
  all: async (text, params) => { await init(); return all(text, params); },
  get: async (text, params) => { await init(); return get(text, params); },
  run: async (text, params) => { await init(); return run(text, params); },
  tx: async (fn) => { await init(); return tx(fn); },
  init,
  convertPlaceholders
};
