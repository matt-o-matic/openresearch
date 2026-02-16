-- OpenResearch schema (v1)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys(key_prefix);

CREATE TABLE IF NOT EXISTS user_usage_monthly (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month DATE NOT NULL,
  search_calls INTEGER NOT NULL DEFAULT 0,
  fetches INTEGER NOT NULL DEFAULT 0,
  renders INTEGER NOT NULL DEFAULT 0,
  model_tokens_in INTEGER NOT NULL DEFAULT 0,
  model_tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12,4) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month)
);

CREATE TABLE IF NOT EXISTS runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'failed', 'completed', 'canceled')),
  phase TEXT,
  template TEXT NOT NULL DEFAULT 'research-memo',
  citation_policy TEXT NOT NULL DEFAULT 'balanced',
  budgets JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  adapter_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  quality_tier TEXT NOT NULL DEFAULT 'full',
  plan JSONB,
  state JSONB,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS runs_user_id_idx ON runs(user_id);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(status);

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'running', 'failed', 'completed', 'canceled')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  canceled_at TIMESTAMPTZ,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status_priority_idx ON jobs(status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS jobs_run_id_idx ON jobs(run_id);
CREATE INDEX IF NOT EXISTS jobs_user_id_idx ON jobs(user_id);

CREATE TABLE IF NOT EXISTS run_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  phase TEXT,
  event_type TEXT NOT NULL,
  message TEXT,
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS run_events_run_id_idx ON run_events(run_id, created_at);

CREATE TABLE IF NOT EXISTS sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  final_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fetched', 'rendered', 'extracted', 'failed', 'skipped')),
  http_status INTEGER,
  content_type TEXT,
  content_hash TEXT,
  fetched_at TIMESTAMPTZ,
  title TEXT,
  publisher TEXT,
  authors TEXT[],
  published_at TIMESTAMPTZ,
  raw_body_key TEXT,
  render_text_key TEXT,
  render_html_key TEXT,
  render_trace_key TEXT,
  extract_key TEXT,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sources_run_id_idx ON sources(run_id);

CREATE TABLE IF NOT EXISTS model_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  model_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  prompt_version TEXT,
  input_hash TEXT,
  output_hash TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd NUMERIC(12,4),
  request_key TEXT,
  response_key TEXT
);
CREATE INDEX IF NOT EXISTS model_calls_run_id_idx ON model_calls(run_id, created_at);

CREATE TABLE IF NOT EXISTS citations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL,
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  quote_start INTEGER,
  quote_end INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS citations_run_id_idx ON citations(run_id, claim_id);

