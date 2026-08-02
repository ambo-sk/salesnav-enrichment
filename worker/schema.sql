-- SalesNav enrichment proxy — D1 schema.
-- Apply with:  npm run db:init        (remote)
--              npm run db:init:local  (local dev)
-- Safe to re-run: every statement is IF NOT EXISTS.

-- ─── Users ───
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,          -- short slug, e.g. "amrit"
  name        TEXT NOT NULL,
  email       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── API tokens ───
-- Only the SHA-256 hex digest of the token is stored. A leaked database row
-- cannot be replayed as a token; the plaintext exists solely in the operator's
-- hands at mint time and in the extension's local storage.
CREATE TABLE IF NOT EXISTS tokens (
  token_hash   TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  label        TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);

-- ─── Daily quota ───
-- One row per user per day, incremented on every proxied call. This is the
-- cost guard rail: the API keys live in the worker, so a token holder spends
-- real money through the proxy.
CREATE TABLE IF NOT EXISTS daily_usage (
  user_id       TEXT NOT NULL,
  day           TEXT NOT NULL,           -- date('now'), UTC
  harvest_calls INTEGER NOT NULL DEFAULT 0,
  llm_calls     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- ─── Runs ───
-- One row per enrichment run, opened and closed by the extension. Answers
-- "who ran what, when, and what did it cost".
CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  label          TEXT,
  status         TEXT NOT NULL,          -- running|complete|errored|stopped
  contact_count  INTEGER NOT NULL DEFAULT 0,
  scored_count   INTEGER NOT NULL DEFAULT 0,
  harvest_calls  INTEGER NOT NULL DEFAULT 0,
  llm_calls      INTEGER NOT NULL DEFAULT 0,
  llm_tokens_in  INTEGER NOT NULL DEFAULT 0,
  llm_tokens_out INTEGER NOT NULL DEFAULT 0,
  icp            TEXT,                   -- what this run was scored against
  error          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_user_created ON runs(user_id, created_at DESC);
