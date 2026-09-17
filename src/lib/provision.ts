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
): Promise<RoomTicket> {
  const res = await fetch(`${apiBase()}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, name }),
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

/** Public room directory, stored in Cloudflare KV by the Worker. */
export async function listRooms(): Promise<RoomInfo[]> {
  const res = await fetch(`${apiBase()}/api/rooms`);
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { rooms: RoomInfo[] };
  return data.rooms ?? [];
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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
