-- Unlisted rooms + D1-backed rate limiting.
-- Apply with: bunx wrangler d1 migrations apply inchat [--local|--remote]

ALTER TABLE rooms ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_rooms_public ON rooms(is_public, live, created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
