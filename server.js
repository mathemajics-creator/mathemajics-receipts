// server.js — minimal server for Session 1: /health only.
// Runs migrations before listening; refuses to start on migration failure.

require('dotenv').config();
const express = require('express');
const db = require('./db');
const { runMigrations } = require('./migrate');

const app = express();

app.get('/health', async (req, res) => {
  try {
    await db.ping();
    res.status(200).json({ ok: true, uptime: process.uptime() });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'db_unreachable' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found' });
});

module.exports = app;

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  runMigrations(db.pool)
    .then(() => {
      app.listen(port, () => {
        console.log(`mathemajics-receipts listening on port ${port}`);
      });
    })
    .catch(() => {
      console.error('server: migrations failed — refusing to start');
      process.exit(1);
    });
}
