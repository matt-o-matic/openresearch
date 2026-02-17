-- Run checkpoints (v2)

CREATE TABLE IF NOT EXISTS run_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('iteration', 'finalize')),
  checkpoint_version INTEGER NOT NULL,
  iteration_completed INTEGER NOT NULL DEFAULT 0,
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT run_checkpoints_payload_hash_check
    CHECK (payload_hash = encode(digest(payload::text, 'sha256'), 'hex'))
);

CREATE INDEX IF NOT EXISTS run_checkpoints_run_id_created_at_idx
  ON run_checkpoints(run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS run_checkpoints_run_id_iteration_completed_idx
  ON run_checkpoints(run_id, iteration_completed DESC);

