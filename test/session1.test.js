// Session 1 self-tests — run against REAL Postgres (never mocked).
// Uses a scratch database `receipts_test` on the same server as DATABASE_URL,
// dropped and recreated per test group, so dev/real data is never touched.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
require('dotenv').config();

const { Client, Pool } = require('pg');
const { execFileSync } = require('child_process');
const path = require('path');

const { fileURLToPath } = require('url');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DB = 'receipts_test';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL missing — copy .env.example to .env first');
}

const adminUrl = (() => {
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = '/postgres';
  return u.toString();
})();

const testUrl = (() => {
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = '/' + TEST_DB;
  return u.toString();
})();

// Point every module (db.js, server.js) at the scratch DB before requiring them.
process.env.DATABASE_URL = testUrl;

const db = require('../db');
const { runMigrations } = require('../migrate');
const app = require('../server');

let pool; // fresh pool per reset, max 20 for the concurrency test

async function resetDatabase() {
  if (pool) await pool.end().catch(() => {});
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  pool = new Pool({ connectionString: testUrl, max: 20 });
  await runMigrations(pool);
}

function sampleReceipt(overrides = {}) {
  return {
    issue_date: '2026-08-25',
    student_name: 'Test Student',
    parent_name: 'Test Parent',
    parent_email: 'parent@example.com',
    teacher_name: 'Test Teacher',
    amount: 150.0,
    currency: 'AUD',
    payment_method: 'bank_transfer',
    payment_reference: 'TXN-123',
    fee_description: 'August tuition fees',
    gst_treatment: null,
    ...overrides,
  };
}

async function insertOne(overrides = {}) {
  const client = await pool.connect();
  try {
    return await db.allocateReceiptNumberAndInsert(client, sampleReceipt(overrides));
  } finally {
    client.release();
  }
}

afterAll(async () => {
  if (pool) await pool.end().catch(() => {});
});

describe('sequence integrity', () => {
  beforeAll(resetDatabase);

  it('1. three inserts get RCPT-000001/2/3 in order', async () => {
    const a = await insertOne();
    const b = await insertOne();
    const c = await insertOne();
    expect([a.invoice_number, b.invoice_number, c.invoice_number]).toEqual([
      'RCPT-000001',
      'RCPT-000002',
      'RCPT-000003',
    ]);
  });
});

describe('sequence integrity — concurrency', () => {
  beforeAll(resetDatabase);

  it('2. 20 parallel inserts: all succeed, unique, no gaps, counter = 20', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => insertOne({ student_name: `Student ${i}` }))
    );
    const numbers = results.map((r) => r.invoice_number).sort();
    const expected = Array.from(
      { length: 20 },
      (_, i) => 'RCPT-' + String(i + 1).padStart(6, '0')
    );
    expect(numbers).toEqual(expected); // 20 unique consecutive numbers, no gaps
    const { rows } = await pool.query('SELECT last_number FROM receipt_counter WHERE id = 1');
    expect(rows[0].last_number).toBe(20);
  });

  it('3. a failed insert burns no number — next success is consecutive', async () => {
    await expect(insertOne({ amount: -5 })).rejects.toThrow();
    const next = await insertOne();
    expect(next.invoice_number).toBe('RCPT-000021'); // 20 + 1, no gap
    const { rows } = await pool.query('SELECT last_number FROM receipt_counter WHERE id = 1');
    expect(rows[0].last_number).toBe(21);
  });
});

describe('immutability — blocked direction', () => {
  let receipt;

  beforeAll(async () => {
    await resetDatabase();
    receipt = await insertOne();
  });

  it('4. UPDATE amount → rejected', async () => {
    await expect(
      pool.query('UPDATE receipts SET amount = $1 WHERE id = $2', [999, receipt.id])
    ).rejects.toThrow(/immutable/);
  });

  it('5. UPDATE parent_email → rejected', async () => {
    await expect(
      pool.query('UPDATE receipts SET parent_email = $1 WHERE id = $2', [
        'attacker@example.com',
        receipt.id,
      ])
    ).rejects.toThrow(/immutable/);
  });

  it('6. UPDATE invoice_number → rejected', async () => {
    await expect(
      pool.query('UPDATE receipts SET invoice_number = $1 WHERE id = $2', [
        'RCPT-999999',
        receipt.id,
      ])
    ).rejects.toThrow(/immutable/);
  });

  it('7. DELETE a receipt → rejected', async () => {
    await expect(
      pool.query('DELETE FROM receipts WHERE id = $1', [receipt.id])
    ).rejects.toThrow(/immutable/);
  });

  it('8. void with empty reason → rejected', async () => {
    await expect(
      pool.query(
        `UPDATE receipts SET status = 'voided', void_reason = $1, voided_at = now() WHERE id = $2`,
        ['   ', receipt.id]
      )
    ).rejects.toThrow();
    await expect(
      pool.query(
        `UPDATE receipts SET status = 'voided', void_reason = NULL, voided_at = now() WHERE id = $1`,
        [receipt.id]
      )
    ).rejects.toThrow();
  });

  it('11. single UPDATE that voids AND changes amount → rejected', async () => {
    await expect(
      pool.query(
        `UPDATE receipts
           SET status = 'voided', void_reason = $1, voided_at = now(), amount = $2
         WHERE id = $3`,
        ['fat finger', 999, receipt.id]
      )
    ).rejects.toThrow(/immutable/);
  });

  it('9. voiding an already-voided receipt → rejected', async () => {
    const victim = await insertOne({ student_name: 'To Be Voided' });
    await pool.query(
      `UPDATE receipts SET status = 'voided', void_reason = $1, voided_at = now() WHERE id = $2`,
      ['entered twice by mistake', victim.id]
    );
    await expect(
      pool.query(
        `UPDATE receipts SET status = 'voided', void_reason = $1, voided_at = now() WHERE id = $2`,
        ['voiding again', victim.id]
      )
    ).rejects.toThrow(/immutable/);
  });

  it('10. overwriting a non-null pdf_bytes → rejected', async () => {
    const victim = await insertOne({ student_name: 'Pdf Holder' });
    await pool.query('UPDATE receipts SET pdf_bytes = $1 WHERE id = $2', [
      Buffer.from('original pdf'),
      victim.id,
    ]);
    await expect(
      pool.query('UPDATE receipts SET pdf_bytes = $1 WHERE id = $2', [
        Buffer.from('tampered pdf'),
        victim.id,
      ])
    ).rejects.toThrow(/immutable/);
  });

  it('12. counter decrease and schema_migrations delete → rejected', async () => {
    await expect(
      pool.query('UPDATE receipt_counter SET last_number = $1 WHERE id = 1', [0])
    ).rejects.toThrow(/only increase/);
    await expect(pool.query('DELETE FROM schema_migrations')).rejects.toThrow(/append-only/);
    await expect(
      pool.query('UPDATE schema_migrations SET applied_at = now()')
    ).rejects.toThrow(/append-only/);
  });
});

describe('immutability — legitimate direction', () => {
  let receipt;

  beforeAll(async () => {
    await resetDatabase();
    receipt = await insertOne();
  });

  it('13. proper void succeeds; financial fields untouched', async () => {
    await pool.query(
      `UPDATE receipts SET status = 'voided', void_reason = $1, voided_at = now() WHERE id = $2`,
      ['duplicate entry', receipt.id]
    );
    const { rows } = await pool.query('SELECT * FROM receipts WHERE id = $1', [receipt.id]);
    const row = rows[0];
    expect(row.status).toBe('voided');
    expect(row.void_reason).toBe('duplicate entry');
    expect(row.voided_at).not.toBeNull();
    expect(row.invoice_number).toBe(receipt.invoice_number);
    expect(row.amount).toBe(receipt.amount);
    expect(row.currency).toBe(receipt.currency);
    expect(row.student_name).toBe(receipt.student_name);
    expect(row.parent_email).toBe(receipt.parent_email);
  });

  it('14. one-time pdf_bytes attach on NULL succeeds', async () => {
    const target = await insertOne({ student_name: 'Pdf Target' });
    await pool.query('UPDATE receipts SET pdf_bytes = $1 WHERE id = $2', [
      Buffer.from('the pdf'),
      target.id,
    ]);
    const { rows } = await pool.query('SELECT pdf_bytes FROM receipts WHERE id = $1', [target.id]);
    expect(rows[0].pdf_bytes.toString()).toBe('the pdf');
  });

  it('15. one-time email_sent_at set on NULL succeeds', async () => {
    const target = await insertOne({ student_name: 'Email Target' });
    await pool.query('UPDATE receipts SET email_sent_at = now() WHERE id = $1', [target.id]);
    const { rows } = await pool.query('SELECT email_sent_at FROM receipts WHERE id = $1', [
      target.id,
    ]);
    expect(rows[0].email_sent_at).not.toBeNull();
  });
});

describe('infrastructure', () => {
  it('16. migration runner is idempotent: second run applies nothing, exits 0', async () => {
    const before = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
    const applied = await runMigrations(pool);
    expect(applied).toEqual([]);
    const after = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
    expect(after.rows[0].n).toBe(before.rows[0].n);

    // Also via the real CLI: exit code 0 (execFileSync throws on non-zero).
    const out = execFileSync(process.execPath, ['migrate.js'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: testUrl },
      encoding: 'utf8',
    });
    expect(out).toMatch(/nothing to apply/);
  });

  it('17. GET /health → 200 when DB reachable, 503 after pool is closed', async () => {
    const server = app.listen(0);
    const port = server.address().port;
    try {
      const okRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(okRes.status).toBe(200);
      const okBody = await okRes.json();
      expect(okBody.ok).toBe(true);
      expect(typeof okBody.uptime).toBe('number');

      // 404 catch-all shape while we're here
      const missing = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(missing.status).toBe(404);

      // Simulate unreachable DB by closing the app's pool — must be the LAST check.
      await db.pool.end();
      const downRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(downRes.status).toBe(503);
      const downBody = await downRes.json();
      expect(downBody).toEqual({ ok: false, error: 'db_unreachable' });
    } finally {
      server.close();
    }
  });
});
