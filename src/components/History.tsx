import { useEffect, useRef, useState } from "react";
import { useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";
import type { Message } from "@cloudflare/realtimekit";
import {
  getMessages,
  saveMessages,
  type RoomMessage,
} from "../lib/provision";

function toTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? ""
    : d.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/**
 * Watches live UI Kit chat and mirrors text messages into D1.
 * The UI Kit owns sending/rendering; this only persists, idempotently.
 */
export function HistorySync({ roomId }: { roomId: string }) {
  const { meeting } = useRealtimeKitMeeting();
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!roomId) return;
    known.current = new Set(
      (meeting.chat.messages ?? []).map((m: Message) => m.id),
    );
    const handler = () => {
      const fresh = (meeting.chat.messages ?? []).filter(
        (m: Message) => m.type === "text" && !known.current!.has(m.id),
      );
      if (fresh.length === 0) return;
      for (const m of fresh) known.current!.add(m.id);
      saveMessages(
        roomId,
        fresh.map((m) => ({
          id: m.id,
          sender: m.displayName || "Guest",
          body: m.type === "text" ? m.message : "",
          sent_at:
            m.time instanceof Date
              ? m.time.toISOString()
              : new Date().toISOString(),
        })),
      ).catch(() => {
        // History is best-effort; live chat is unaffected.
      });
    };
    meeting.chat.on("chatUpdate", handler);
    return () => {
      meeting.chat.off("chatUpdate", handler);
    };
  }, [meeting, roomId]);

  return null;
}

/** Past messages for a room, loaded from D1. */
export function HistoryPanel({ roomId }: { roomId: string }) {
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setMessages(await getMessages(roomId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load history.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  return (
    <aside className="chat">
      <div className="directory-head">
        <h3>History (saved)</h3>
        <button className="ghost small" onClick={load} type="button">
          Refresh
        </button>
      </div>
      <div className="chat-log">
        {loading ? (
          <p className="muted">Loading history…</p>
        ) : error ? (
          <div className="error">{error}</div>
        ) : messages.length === 0 ? (
          <p className="muted">
            Nothing saved yet. Messages sent in chat are stored automatically.
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="chat-msg">
              <span className="chat-who">
                {m.sender} · {toTime(m.sent_at)}
              </span>
              <span className="chat-text">{m.body}</span>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
