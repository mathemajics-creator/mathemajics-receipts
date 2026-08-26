-- 003_sessions.sql — admin login sessions. Only the SHA-256 hash of the opaque
-- bearer token is stored; the raw token exists only in the admin's client.

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
