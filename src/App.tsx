import { useCallback, useState } from "react";
import {
  RealtimeKitProvider,
  useRealtimeKitClient,
} from "@cloudflare/realtimekit-react";
import type RTKClient from "@cloudflare/realtimekit";
import Lobby from "./components/Lobby";
import RoomView from "./components/RoomView";
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

  // Just drops the session. Leaving itself happens exactly once in
  // RoomView (disconnect button) or inside the meeting (kick, surfaced via
  // roomLeft) — never here, or leave() re-emits roomLeft and the cycle
  // repeats forever.
  const handleLeave = useCallback(() => {
    setSession(null);
  }, []);

  // Hop to another room on the same client. The old leave is awaited
  // with a timeout (teardown can stall) — and never re-triggered by
  // handlers, or the leave -> roomLeft -> leave loop comes back.
  const handleSwitch = useCallback(
    async (ticket: RoomTicket, title: string) => {
      const name = session?.displayName ?? "Guest";
      try {
        await Promise.race([
          meeting?.leave(),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      } catch {
        // leaving anyway
      }
      setStarting(true);
      setJoinError(null);
      try {
        const m = (await initMeeting({
          authToken: ticket.auth_token,
          defaults: { audio: true, video: false },
        })) as RTKClient | undefined;
        if (!m) throw new Error("Failed to initialise the voice engine.");
        setSession({ ticket, displayName: name, title });
      } catch (e) {
        setJoinError(
          e instanceof Error ? e.message : "Failed to initialise the call.",
        );
        setSession(null);
      } finally {
        setStarting(false);
      }
    },
    [initMeeting, meeting, session?.displayName],
  );

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
            <RoomView session={session} onLeave={handleLeave} onSwitch={handleSwitch} />
          </RealtimeKitProvider>
        ) : (
          <Lobby
            onTicket={handleTicket}
            busy={starting}
            error={joinError}
          />
        )}
      </main>
    </div>
  );
}
