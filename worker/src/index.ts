/**
 * InChat API on Cloudflare Workers.
 *
 * Everything server-side lives here: room provisioning (create meeting +
 * mint participant tokens) and a KV-backed public room directory kept live
 * by RealtimeKit webhooks. Everyone joins anonymously — just a display name.
 *
 * Routes:
 *   POST /api/rooms                      create room + join as `name`
 *   GET  /api/rooms                      list rooms (from KV)
 *   POST /api/rooms/:id/join             join room as `name`
 *   POST /api/webhooks/realtimekit       signed RealtimeKit events
 *
 * Secrets (wrangler secret put ...):
 *   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_APP_ID
 * Vars (wrangler.toml):
 *   CLOUDFLARE_PRESET_NAME, REALTIMEKIT_WEBHOOK_PUBLIC_KEY_URL
 * Bindings:
 *   KV namespace `ROOMS`
 */

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const PUBKEY_CACHE_KEY = "cache:rtk-pubkey";
const PUBKEY_TTL_SECONDS = 24 * 3600;
const SEEN_TTL_SECONDS = 7 * 24 * 3600;
const ROOM_TTL_SECONDS = 30 * 24 * 3600;

interface Env {
  ROOMS: KVNamespace;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_APP_ID: string;
  CLOUDFLARE_PRESET_NAME?: string;
  REALTIMEKIT_WEBHOOK_PUBLIC_KEY_URL?: string;
}

interface RoomRecord {
  id: string;
  title: string;
  createdAt: string;
  live: boolean;
  people: number;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: cors });

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

function roomKey(id: string): string {
  return `room:${id}`;
}

async function getRoom(env: Env, id: string): Promise<RoomRecord | null> {
  return env.ROOMS.get<RoomRecord>(roomKey(id), "json");
}

async function putRoom(env: Env, room: RoomRecord): Promise<void> {
  await env.ROOMS.put(roomKey(room.id), JSON.stringify(room), {
    expirationTtl: ROOM_TTL_SECONDS,
  });
}

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
  await putRoom(env, {
    id: meetingId,
    title: title.trim() || "Voice room",
    createdAt: new Date().toISOString(),
    live: false,
    people: 0,
  });
  return json({ meeting_id: meetingId, auth_token: authToken });
}

async function handleListRooms(env: Env): Promise<Response> {
  const rooms: RoomRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ROOMS.list({ prefix: "room:", cursor });
    for (const key of page.keys) {
      const room = await env.ROOMS.get<RoomRecord>(key.name, "json");
      if (room) rooms.push(room);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  rooms.sort((a, b) =>
    Number(b.live) - Number(a.live) || b.createdAt.localeCompare(a.createdAt),
  );
  return json({ rooms });
}

async function handleJoinRoom(
  req: Request,
  env: Env,
  meetingId: string,
): Promise<Response> {
  const { name = "Guest" } = await req.json<any>();
  const authToken = await cfAddParticipant(env, meetingId, name);
  const room = await getRoom(env, meetingId);
  if (!room) {
    // Room created outside this directory (e.g. dashboard) — track it now.
    await putRoom(env, {
      id: meetingId,
      title: "Voice room",
      createdAt: new Date().toISOString(),
      live: false,
      people: 0,
    });
  }
  return json({ meeting_id: meetingId, auth_token: authToken });
}

// --- Webhooks ---------------------------------------------------------------

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getPublicKey(env: Env): Promise<CryptoKey> {
  const cached = await env.ROOMS.get(PUBKEY_CACHE_KEY);
  let pem: string | null = cached;
  if (!pem) {
    const url =
      env.REALTIMEKIT_WEBHOOK_PUBLIC_KEY_URL ||
      "https://api.realtime.cloudflare.com/.well-known/webhooks.json";
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("could not fetch webhook public key");
    const data = await resp.json<any>();
    pem = data?.data?.publicKey;
    if (!pem) throw new Error("webhook public key missing in response");
    await env.ROOMS.put(PUBKEY_CACHE_KEY, pem, {
      expirationTtl: PUBKEY_TTL_SECONDS,
    });
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
    const seenKey = `seen:${uuid}`;
    if (await env.ROOMS.get(seenKey)) return new Response(null, { status: 200 });
    await env.ROOMS.put(seenKey, "1", { expirationTtl: SEEN_TTL_SECONDS });
  }

  const meetingId = event.meeting?.id;
  if (meetingId) {
    const room = (await getRoom(env, meetingId)) ?? {
      id: meetingId,
      title: "Voice room",
      createdAt: new Date().toISOString(),
      live: false,
      people: 0,
    };
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
    await putRoom(env, room);
  }

  return new Response(null, { status: 200 });
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
      const m = url.pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
      if (req.method === "POST" && m) {
        return await handleJoinRoom(req, env, decodeURIComponent(m[1]!));
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
} satisfies ExportedHandler<Env>;
