import { useCallback, useState } from "react";
import {
  RealtimeKitProvider,
  useRealtimeKitClient,
} from "@cloudflare/realtimekit-react";
import type RTKClient from "@cloudflare/realtimekit";
import Sidebar from "./components/Sidebar";
import Stage from "./components/Stage";
import type { RoomTicket } from "./lib/provision";
import { voiceSupport } from "./lib/provision";

export interface Session {
  ticket: RoomTicket;
  displayName: string;
  title: string;
}

const NAME_KEY = "inchat.displayName";

function randomGuest(): string {
  return `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
}

export default function App() {
  const [meeting, initMeeting] = useRealtimeKitClient();
  const [session, setSession] = useState<Session | null>(null);
  const [displayName, setDisplayName] = useState(
    () => localStorage.getItem(NAME_KEY) || randomGuest(),
  );
  const [joinError, setJoinError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  function handleDisplayName(name: string) {
    setDisplayName(name);
    localStorage.setItem(NAME_KEY, name);
  }

  const joinTicket = useCallback(
    async (ticket: RoomTicket, title: string, name: string) => {
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
        setSession({ ticket, displayName: name, title });
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

  // Just drops the session. Leaving itself happens exactly once in Stage
  // (disconnect button) or inside the meeting (kick, surfaced via
  // roomLeft) — never here, or leave() re-emits roomLeft and the cycle
  // repeats forever.
  const handleLeave = useCallback(() => {
    setSession(null);
  }, []);

  // Hop to another room on the same client. The old leave gets a timeout
  // (teardown can stall) — and is never re-triggered by handlers, or the
  // leave -> roomLeft -> leave loop comes back.
  const handleSwitch = useCallback(
    async (ticket: RoomTicket, title: string) => {
      try {
        await Promise.race([
          meeting?.leave(),
          new Promise((r) => setTimeout(r, 5000)),
        ]);
      } catch {
        // leaving anyway
      }
      await joinTicket(ticket, title, displayName);
    },
    [initMeeting, joinTicket, meeting, displayName],
  );

  // Sidebar joins: hop when a call is active (leave first), plain join
  // when the stage is empty.
  const handleJoin = useCallback(
    (ticket: RoomTicket, title: string) => {
      void (session
        ? handleSwitch(ticket, title)
        : joinTicket(ticket, title, displayName));
    },
    [session, handleSwitch, joinTicket, displayName],
  );

  return (
    <div className="app">
      <div className="discord">
        <Sidebar
          displayName={displayName}
          onDisplayName={handleDisplayName}
          activeRoomId={session?.ticket.meeting_id ?? ""}
          onJoin={handleJoin}
          busy={starting}
        />
        {session && meeting ? (
          <RealtimeKitProvider value={meeting} fallback={<p>Loading…</p>}>
            <Stage session={session} onLeave={handleLeave} />
          </RealtimeKitProvider>
        ) : (
          <main className="stage">
            <div className="empty">
              <div className="empty-icon">🔊</div>
              <h2>No room selected</h2>
              <p className="muted">
                Pick a public room, enter a code, or create your own — no
                account needed.
              </p>
              {starting && <p className="muted">Connecting…</p>}
              {joinError && (
                <div className="error" role="alert">
                  {joinError}
                </div>
              )}
            </div>
          </main>
        )}
      </div>
    </div>
  );
}
