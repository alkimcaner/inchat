import { useEffect, useMemo, useRef, useState } from "react";
import { useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";
import type { Message } from "@cloudflare/realtimekit";
import {
  getMessages,
  saveMessages,
  type RoomMessage,
} from "../lib/provision";

interface Props {
  roomId: string;
}

interface Row {
  id: string;
  sender: string;
  body: string;
  at: number;
  saved: boolean;
}

function toTime(ms: number): string {
  const d = new Date(ms);
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
 * Watches live chat and mirrors text messages into D1.
 * Insert is idempotent per message id.
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

/** Single merged scrollback: D1 history + live messages, deduped by id. */
export default function MergedChat({ roomId }: Props) {
  const { meeting } = useRealtimeKitMeeting();
  const [history, setHistory] = useState<RoomMessage[]>([]);
  const [live, setLive] = useState<Message[]>(() => [
    ...(meeting.chat.messages ?? []),
  ]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    getMessages(roomId)
      .then((msgs) => {
        if (!cancelled) setHistory(msgs);
      })
      .catch(() => {});
    const handler = () => setLive([...meeting.chat.messages]);
    meeting.chat.on("chatUpdate", handler);
    return () => {
      cancelled = true;
      meeting.chat.off("chatUpdate", handler);
    };
  }, [meeting, roomId]);

  const rows: Row[] = useMemo(() => {
    const seen = new Set(history.map((m) => m.id));
    const out: Row[] = history.map((m) => ({
      id: m.id,
      sender: m.sender,
      body: m.body,
      at: Date.parse(m.sent_at) || 0,
      saved: true,
    }));
    for (const m of live) {
      if (m.type !== "text" || seen.has(m.id)) continue;
      out.push({
        id: m.id,
        sender: m.displayName || "Guest",
        body: m.message,
        at: m.time instanceof Date ? m.time.getTime() : Date.now(),
        saved: false,
      });
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }, [history, live]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [rows.length]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await meeting.chat.sendTextMessage(text);
      setDraft("");
      setLive([...meeting.chat.messages]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send message.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chatpane">
      <div className="chat-log">
        {rows.length === 0 && (
          <p className="muted">No messages yet. Say hi.</p>
        )}
        {rows.map((m) => (
          <div key={m.id} className="chat-msg">
            <span className="chat-who">
              {m.sender} · {toTime(m.at)}
            </span>
            <span className="chat-text">{m.body}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {error && <div className="error">{error}</div>}
      <div className="chat-input">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
          placeholder="Message the room…"
          maxLength={500}
        />
        <button onClick={send} disabled={sending || !draft.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
