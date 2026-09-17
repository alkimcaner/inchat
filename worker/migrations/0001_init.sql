-- InChat schema: rooms directory, persisted chat history, webhook dedupe,
-- and a meta table for small cached values (webhook signing key).
-- Apply with: bunx wrangler d1 migrations apply inchat [--local|--remote]

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Voice room',
  created_at TEXT NOT NULL,
  live INTEGER NOT NULL DEFAULT 0,
  people INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender TEXT NOT NULL DEFAULT 'Guest',
  body TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_id, sent_at);

CREATE TABLE IF NOT EXISTS processed_webhooks (
  uuid TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
