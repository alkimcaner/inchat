/**
 * InChat API on Cloudflare Workers + D1.
 *
 * Everything server-side lives here: room provisioning (create meeting +
 * mint participant tokens), a D1-backed public room directory kept live by
 * RealtimeKit webhooks, and persisted chat history. Everyone joins
 * anonymously — just a display name.
 *
 * Routes:
 *   POST /api/rooms                      create room + join as `name`
 *   GET  /api/rooms                      list rooms
 *   POST /api/rooms/:id/join             join room as `name`
 *   GET  /api/rooms/:id/messages         room chat history (D1)
 *   POST /api/rooms/:id/messages         persist chat messages (D1)
 *   POST /api/webhooks/realtimekit       signed RealtimeKit events
 *
 * Cron (daily): prunes messages past MESSAGE_RETENTION_DAYS and old
 * processed-webhook UUIDs.
 *
 * Secrets (wrangler secret put ...):
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_APP_ID
 * Vars (wrangler.toml):
 *   CLOUDFLARE_PRESET_NAME, REALTIMEKIT_WEBHOOK_PUBLIC_KEY_URL,
 *   MESSAGE_RETENTION_DAYS
 * Bindings:
 *   D1 database `DB`
 */

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const PUBKEY_META_KEY = "rtk-pubkey";
const PUBKEY_MAX_AGE_MS = 24 * 3600 * 1000;
const SEEN_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_MESSAGE_BODY = 2000;
const MAX_BATCH = 50;
const MAX_HISTORY = 200;

interface Env {
  DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_APP_ID: string;
  CLOUDFLARE_PRESET_NAME?: string;
  REALTIMEKIT_WEBHOOK_PUBLIC_KEY_URL?: string;
  MESSAGE_RETENTION_DAYS?: string;
}

interface RoomRecord {
  id: string;
  title: string;
  createdAt: string;
  live: boolean;
  people: number;
}

interface StoredMessage {
  id: string;
  sender: string;
  body: string;
  sent_at: string;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: cors });

const nowIso = () => new Date().toISOString();

function cfError(body: any): string {
  const errs = body?.errors;
  if (Array.isArray(errs) && errs.length > 0) return JSON.stringify(errs);
  return "Cloudflare API request failed";
}

function extractToken(result: any): string | null {
  for (const k of ["token", "authToken", "auth_token"]) {
    if (typeof result?.[k] === "string" && result[k]) return result[k];
  }
  return null;
}

// --- Rooms ------------------------------------------------------------------

function rowToRoom(row: any): RoomRecord {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    live: row.live === 1,
    people: row.people,
  };
}

async function getRoom(env: Env, id: string): Promise<RoomRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM rooms WHERE id = ?")
    .bind(id)
    .first();
  return row ? rowToRoom(row) : null;
}

async function upsertRoom(env: Env, room: RoomRecord): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO rooms (id, title, created_at, live, people, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       live = excluded.live,
       people = excluded.people,
       updated_at = excluded.updated_at`,
  )
    .bind(
      room.id,
      room.title,
      room.createdAt,
      room.live ? 1 : 0,
      room.people,
      nowIso(),
    )
    .run();
}

async function ensureRoom(
  env: Env,
  id: string,
  title = "Voice room",
): Promise<RoomRecord> {
  const existing = await getRoom(env, id);
  if (existing) return existing;
  const room: RoomRecord = {
    id,
    title,
    createdAt: nowIso(),
    live: false,
    people: 0,
  };
  await upsertRoom(env, room);
  return room;
}

// --- RealtimeKit REST ---------------------------------------------------------

async function cfCreateMeeting(env: Env, title: string): Promise<string> {
  const res = await fetch(
    `${API_BASE}/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.CLOUDFLARE_APP_ID}/meetings`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      },
      body: JSON.stringify({ title: title.trim() || "Voice room" }),
    },
  );
  const body = await res.json<any>();
  if (!res.ok || !body?.success) throw new Error(cfError(body));
  if (!body.result?.id) throw new Error("create meeting: missing id");
  return body.result.id;
}

async function cfAddParticipant(
  env: Env,
  meetingId: string,
  name: string,
): Promise<string> {
  const res = await fetch(
    `${API_BASE}/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.CLOUDFLARE_APP_ID}/meetings/${meetingId}/participants`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      },
      body: JSON.stringify({
        name: name.trim() || "Guest",
        preset_name: env.CLOUDFLARE_PRESET_NAME || "group_call_participant",
      }),
    },
  );
  const body = await res.json<any>();
  if (!res.ok || !body?.success) throw new Error(cfError(body));
  const token = extractToken(body.result);
  if (!token) throw new Error("add participant: no token in response");
  return token;
}

async function handleCreateRoom(req: Request, env: Env): Promise<Response> {
  const { title = "", name = "Guest" } = await req.json<any>();
  const meetingId = await cfCreateMeeting(env, title);
  const authToken = await cfAddParticipant(env, meetingId, name);
  await upsertRoom(env, {
    id: meetingId,
    title: (title as string).trim() || "Voice room",
    createdAt: nowIso(),
    live: false,
    people: 0,
  });
  return json({ meeting_id: meetingId, auth_token: authToken });
}

async function handleListRooms(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM rooms ORDER BY live DESC, created_at DESC LIMIT 200",
  ).all();
  return json({ rooms: (results ?? []).map(rowToRoom) });
}

async function handleJoinRoom(
  req: Request,
  env: Env,
  meetingId: string,
): Promise<Response> {
  const { name = "Guest" } = await req.json<any>();
  const authToken = await cfAddParticipant(env, meetingId, name);
  // Track rooms created outside this directory (e.g. dashboard) too.
  await ensureRoom(env, meetingId);
  return json({ meeting_id: meetingId, auth_token: authToken });
}

// --- Message history (D1) -----------------------------------------------------

async function handleListMessages(
  req: Request,
  env: Env,
  roomId: string,
): Promise<Response> {
  const url = new URL(req.url);
  const limit = Math.min(
    Number(url.searchParams.get("limit")) || 100,
    MAX_HISTORY,
  );
  const before = url.searchParams.get("before");
  const rows = before
    ? await env.DB.prepare(
        `SELECT id, sender, body, sent_at FROM messages
         WHERE room_id = ? AND sent_at < ?
         ORDER BY sent_at DESC LIMIT ?`,
      )
        .bind(roomId, before, limit)
        .all<StoredMessage>()
    : await env.DB.prepare(
        `SELECT id, sender, body, sent_at FROM messages
         WHERE room_id = ? ORDER BY sent_at DESC LIMIT ?`,
      )
        .bind(roomId, limit)
        .all<StoredMessage>();
  return json({ messages: (rows.results ?? []).reverse() });
}

async function handleSaveMessages(
  req: Request,
  env: Env,
  roomId: string,
): Promise<Response> {
  const { messages } = await req.json<{
    messages: { id: string; sender: string; body: string; sent_at: string }[];
  }>();
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ saved: 0 });
  }
  await ensureRoom(env, roomId);
  const stmts = messages.slice(0, MAX_BATCH).map((m) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO messages (id, room_id, sender, body, sent_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      String(m.id).slice(0, 128),
      roomId,
      String(m.sender || "Guest").slice(0, 80),
      String(m.body || "").slice(0, MAX_MESSAGE_BODY),
      m.sent_at || nowIso(),
    ),
  );
  await env.DB.batch(stmts);
  return json({ saved: stmts.length });
}

// --- Webhooks ---------------------------------------------------------------

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getPublicKey(env: Env): Promise<CryptoKey> {
  const cached = await env.DB.prepare(
    "SELECT value, updated_at FROM meta WHERE key = ?",
  )
    .bind(PUBKEY_META_KEY)
    .first<{ value: string; updated_at: string }>();
  let pem: string | null = null;
  if (
    cached &&
    Date.now() - Date.parse(cached.updated_at) < PUBKEY_MAX_AGE_MS
  ) {
    pem = cached.value;
  } else {
    const url =
      env.REALTIMEKIT_WEBHOOK_PUBLIC_KEY_URL ||
      "https://api.realtime.cloudflare.com/.well-known/webhooks.json";
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("could not fetch webhook public key");
    const data = await resp.json<any>();
    pem = data?.data?.publicKey;
    if (!pem) throw new Error("webhook public key missing in response");
    await env.DB.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
      .bind(PUBKEY_META_KEY, pem, nowIso())
      .run();
  }
  const clean = pem
    .replace(/\\n/g, "")
    .replace(/-----BEGIN PUBLIC KEY-----/, "")
    .replace(/-----END PUBLIC KEY-----/, "")
    .replace(/\s+/g, "");
  return crypto.subtle.importKey(
    "spki",
    b64ToBytes(clean).buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  const signature = req.headers.get("rtk-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });

  // Verify against the RAW body — never reserialize before verifying.
  const raw = await req.arrayBuffer();
  let verified = false;
  try {
    const key = await getPublicKey(env);
    verified = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64ToBytes(signature).buffer as ArrayBuffer,
      raw,
    );
  } catch {
    verified = false;
  }
  if (!verified) return new Response("Invalid signature", { status: 401 });

  const event = JSON.parse(new TextDecoder().decode(raw)) as {
    event: string;
    meeting?: { id: string };
  };

  // Deduplicate retried deliveries.
  const uuid = req.headers.get("rtk-uuid");
  if (uuid) {
    const seen = await env.DB.prepare(
      "SELECT uuid FROM processed_webhooks WHERE uuid = ?",
    )
      .bind(uuid)
      .first();
    if (seen) return new Response(null, { status: 200 });
    await env.DB.prepare(
      "INSERT INTO processed_webhooks (uuid, processed_at) VALUES (?, ?)",
    )
      .bind(uuid, nowIso())
      .run();
  }

  const meetingId = event.meeting?.id;
  if (meetingId) {
    const room = await ensureRoom(env, meetingId);
    switch (event.event) {
      case "meeting.started":
      case "meeting.participantJoined":
        room.live = true;
        if (event.event === "meeting.participantJoined") room.people += 1;
        break;
      case "meeting.participantLeft":
        room.people = Math.max(0, room.people - 1);
        if (room.people === 0) room.live = false;
        break;
      case "meeting.ended":
        room.live = false;
        room.people = 0;
        break;
      default:
        break;
    }
    await upsertRoom(env, room);
  }

  return new Response(null, { status: 200 });
}

// --- Cron: retention pruning --------------------------------------------------

async function prune(env: Env): Promise<void> {
  const retentionDays = Number(env.MESSAGE_RETENTION_DAYS) || 30;
  const msgCutoff = new Date(
    Date.now() - retentionDays * 24 * 3600 * 1000,
  ).toISOString();
  const seenCutoff = new Date(Date.now() - SEEN_TTL_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE sent_at < ?").bind(msgCutoff),
    env.DB.prepare(
      "DELETE FROM processed_webhooks WHERE processed_at < ?",
    ).bind(seenCutoff),
  ]);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      if (req.method === "POST" && url.pathname === "/api/rooms") {
        return await handleCreateRoom(req, env);
      }
      if (req.method === "GET" && url.pathname === "/api/rooms") {
        return await handleListRooms(env);
      }
      const joinMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
      if (req.method === "POST" && joinMatch) {
        return await handleJoinRoom(req, env, decodeURIComponent(joinMatch[1]!));
      }
      const msgMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/messages$/);
      if (msgMatch) {
        const roomId = decodeURIComponent(msgMatch[1]!);
        if (req.method === "GET") return await handleListMessages(req, env, roomId);
        if (req.method === "POST")
          return await handleSaveMessages(req, env, roomId);
      }
      if (
        req.method === "POST" &&
        url.pathname === "/api/webhooks/realtimekit"
      ) {
        return await handleWebhook(req, env);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "request failed" },
        500,
      );
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(prune(env));
  },
} satisfies ExportedHandler<Env>;
