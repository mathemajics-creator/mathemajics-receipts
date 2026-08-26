// server.js — boots the app: migrations first, refuse to start on failure.

require('dotenv').config();
const db = require('./db');
const { runMigrations } = require('./migrate');
const { createApp } = require('./app');

const app = createApp();

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
