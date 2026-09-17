import { useEffect, useRef, useState } from "react";
import { useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";
import type { Message } from "@cloudflare/realtimekit";

/** Live room chat over the Core SDK. History persistence stays in History.tsx. */
export default function LiveChat() {
  const { meeting } = useRealtimeKitMeeting();
  const [messages, setMessages] = useState<Message[]>(() => [
    ...(meeting.chat.messages ?? []),
  ]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = () => setMessages([...meeting.chat.messages]);
    meeting.chat.on("chatUpdate", handler);
    return () => {
      meeting.chat.off("chatUpdate", handler);
    };
  }, [meeting]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await meeting.chat.sendTextMessage(text);
      setDraft("");
      setMessages([...meeting.chat.messages]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send message.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="chatpane">
      <div className="chat-log">
        {messages.length === 0 && (
          <p className="muted">No messages yet. Say hi.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className="chat-msg">
            <span className="chat-who">{m.displayName || "Guest"}</span>
            <span className="chat-text">
              {m.type === "text" ? m.message : `[${m.type} message]`}
            </span>
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
