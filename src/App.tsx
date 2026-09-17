import { useCallback, useState } from "react";
import {
  RealtimeKitProvider,
  useRealtimeKitClient,
} from "@cloudflare/realtimekit-react";
import type RTKClient from "@cloudflare/realtimekit";
import Lobby from "./components/Lobby";
import MeetingView from "./components/MeetingView";
import type { RoomTicket } from "./lib/provision";
import { voiceSupport } from "./lib/provision";

export interface Session {
  ticket: RoomTicket;
  displayName: string;
  title: string;
}

export default function App() {
  const [meeting, initMeeting] = useRealtimeKitClient();
  const [session, setSession] = useState<Session | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const handleTicket = useCallback(
    async (ticket: RoomTicket, displayName: string, title: string) => {
      const support = voiceSupport();
      if (!support.ok) {
        setJoinError(support.reason);
        return;
      }
      setStarting(true);
      setJoinError(null);
      try {
        const m = (await initMeeting({
          authToken: ticket.auth_token,
          defaults: { audio: true, video: false },
        })) as RTKClient | undefined;
        if (!m) throw new Error("Failed to initialise the voice engine.");
        setSession({ ticket, displayName, title });
      } catch (e) {
        setJoinError(
          e instanceof Error ? e.message : "Failed to initialise the call.",
        );
      } finally {
        setStarting(false);
      }
    },
    [initMeeting],
  );

  const handleLeave = useCallback(async () => {
    try {
      await meeting?.leave();
    } catch {
      // ignore — we're leaving anyway
    }
    setSession(null);
  }, [meeting]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" aria-hidden />
          InChat
        </div>
        <div className="topbar-sub">anonymous voice rooms</div>
      </header>

      <main className="main">
        {session && meeting ? (
          <RealtimeKitProvider value={meeting} fallback={<p>Loading…</p>}>
            <MeetingView session={session} onLeave={handleLeave} />
          </RealtimeKitProvider>
        ) : (
          <Lobby
            onTicket={handleTicket}
            busy={starting}
            error={joinError}
          />
        )}
      </main>

      <footer className="foot">
        <span>Tauri + React + Cloudflare RealtimeKit · voice only · no accounts</span>
      </footer>
    </div>
  );
}
