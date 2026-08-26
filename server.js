// server.js — boots the app: migrations first, refuse to start on failure.

require('dotenv').config();
const db = require('./db');
const { runMigrations } = require('./migrate');
const { createApp, checkStartupConfig } = require('./app');

const app = createApp();

module.exports = app;

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;

  // Railway routes traffic into the container from outside it, so binding to
  // localhost would leave the service unreachable however healthy it is.
  const host = '0.0.0.0';

  // Said once, at boot, where a deploy log will show it — and only in
  // production: locally these are expected to be missing, and auth.js already
  // warns on each login attempt. Names only, never values.
  if (process.env.NODE_ENV === 'production') {
    for (const warning of checkStartupConfig()) {
      console.warn(`startup: ${warning}`);
    }
  }

  runMigrations(db.pool)
    .then(() => {
      app.listen(port, host, () => {
        console.log(`mathemajics-receipts listening on ${host}:${port}`);
      });
    })
    .catch(() => {
      console.error('server: migrations failed — refusing to start');
      process.exit(1);
    });
}
