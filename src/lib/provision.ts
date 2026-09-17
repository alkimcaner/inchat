export interface RoomTicket {
  meeting_id: string;
  auth_token: string;
}

export interface RoomInfo {
  id: string;
  title: string;
  createdAt: string;
  live: boolean;
  people: number;
}

/**
 * Base URL of the InChat Cloudflare Worker API.
 * Production: set VITE_API_URL to the deployed worker URL.
 * Dev: relative "/api", proxied to `wrangler dev` (see vite.config.ts).
 */
function apiBase(): string {
  const url = import.meta.env.VITE_API_URL as string | undefined;
  return (url ?? "").replace(/\/$/, "");
}

async function parseError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    if (typeof data?.error === "string") return data.error;
    return JSON.stringify(data);
  } catch {
    return `Request failed (${res.status})`;
  }
}

/** Create a room. Anonymous — just a display name, no login. */
export async function createRoom(
  title: string,
  name: string,
  opts?: { isPublic?: boolean; turnstileToken?: string },
): Promise<RoomTicket> {
  const res = await fetch(`${apiBase()}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      name,
      isPublic: opts?.isPublic === true,
      turnstileToken: opts?.turnstileToken ?? "",
    }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as RoomTicket;
}

/** Join a room. Anonymous — just a display name, no login. */
export async function joinRoom(
  meetingId: string,
  name: string,
): Promise<RoomTicket> {
  const res = await fetch(
    `${apiBase()}/api/rooms/${encodeURIComponent(meetingId.trim())}/join`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as RoomTicket;
}

/** Public room directory, stored in Cloudflare D1 by the Worker. */
export async function listRooms(): Promise<RoomInfo[]> {
  const res = await fetch(`${apiBase()}/api/rooms`);
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { rooms: RoomInfo[] };
  return data.rooms ?? [];
}

export interface RoomMessage {
  id: string;
  sender: string;
  body: string;
  sent_at: string;
}

/** Chat history for a room, persisted in D1. */
export async function getMessages(
  roomId: string,
  limit = 100,
): Promise<RoomMessage[]> {
  const res = await fetch(
    `${apiBase()}/api/rooms/${encodeURIComponent(roomId)}/messages?limit=${limit}`,
  );
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { messages: RoomMessage[] };
  return data.messages ?? [];
}

/** Persist chat messages to D1. Insert is idempotent per message id. */
export async function saveMessages(
  roomId: string,
  messages: RoomMessage[],
): Promise<void> {
  if (messages.length === 0) return;
  const res = await fetch(
    `${apiBase()}/api/rooms/${encodeURIComponent(roomId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    },
  );
  if (!res.ok) throw new Error(await parseError(res));
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Voice requires WebRTC. Some WebViews (notably Linux WebKitGTK without a
 * WebRTC build) expose a microphone but no RTCPeerConnection — the
 * RealtimeKit SDK then fails with `[ERR0010] Browser not supported`.
 * Detect that up front so we can explain it instead.
 */
export function voiceSupport(): { ok: boolean; reason: string } {
  if (typeof RTCPeerConnection === "undefined") {
    return {
      ok: false,
      reason:
        "This window has no WebRTC support (RTCPeerConnection is missing), " +
        "so voice can't start here. Open the web client in Chrome, Edge, " +
        "or Firefox instead — no install needed, same rooms.",
    };
  }
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    return {
      ok: false,
      reason:
        "No microphone access in this window. Open the web client in " +
        "Chrome, Edge, or Firefox and allow the microphone.",
    };
  }
  return { ok: true, reason: "" };
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (isTauri()) {
      const { writeText } = await import(
        "@tauri-apps/plugin-clipboard-manager"
      );
      await writeText(text);
      return true;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
