// migrate.js — the ONLY source of schema truth.
// Applies migrations/*.sql in filename order, each in its own transaction,
// recording each in schema_migrations within that same transaction.
// Fails closed: on any error the current migration is rolled back and the
// process exits non-zero (when run from the CLI).

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function runMigrations(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const appliedNow = [];
  const client = await pool.connect();
  try {
    for (const filename of files) {
      if (applied.has(filename)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
        appliedNow.push(filename);
        console.log(`migrate: applied ${filename}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`migrate: FAILED on ${filename} — rolled back. ${err.message}`);
        throw err;
      }
    }
  } finally {
    client.release();
  }

  if (appliedNow.length === 0) {
    console.log('migrate: nothing to apply — schema is up to date');
  }
  return appliedNow;
}

module.exports = { runMigrations };

if (require.main === module) {
  require('dotenv').config();
  const { pool } = require('./db');
  runMigrations(pool)
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch(() => {
      pool.end().finally(() => process.exit(1));
    });
}
