import { useEffect, useMemo, useRef, useState } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import {
  useRealtimeKitMeeting,
  useRealtimeKitSelector,
} from "@cloudflare/realtimekit-react";
import type { Session } from "../App";
import {
  copyText,
  createRoom,
  joinRoom,
  listRooms,
  type RoomInfo,
  type RoomTicket,
} from "../lib/provision";
import RemoteAudio from "./RemoteAudio";
import LiveChat from "./LiveChat";
import { HistoryPanel, HistorySync } from "./History";

interface Props {
  session: Session;
  onLeave: () => void;
  onSwitch: (ticket: RoomTicket, title: string) => void;
}

function initialOf(name: string): string {
  const t = name.trim();
  return t ? t[0]!.toUpperCase() : "?";
}

/**
 * Discord-style voice room on the Core SDK: room sidebar, voice grid with
 * speaking rings, user bar with mic/deafen/disconnect, live + saved chat.
 */
export default function RoomView({ session, onLeave, onSwitch }: Props) {
  const { meeting } = useRealtimeKitMeeting();
  const roomId = session.ticket.meeting_id;

  const [joinState, setJoinState] = useState<"joining" | "joined" | "failed">("joining");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [deafened, setDeafened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showChat, setShowChat] = useState(true);
  const [chatTab, setChatTab] = useState<"live" | "saved">("live");
  const [copied, setCopied] = useState(false);
  const leavingRef = useRef(false);

  // Sidebar state
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [code, setCode] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newPublic, setNewPublic] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sideError, setSideError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

  // Reactive meeting slices. NOTE: `joined` is a mutable Map — returning
  // it from a selector alone never re-renders (same reference), so we bump
  // a version on participant-map events and derive the array from that.
  const joined = useRealtimeKitSelector((m) => m.participants.joined);
  const [rosterTick, setRosterTick] = useState(0);
  const selfAudio = useRealtimeKitSelector((m) => m.self.audioEnabled);
  const selfName = useRealtimeKitSelector((m) => m.self.name);
  const selfId = useRealtimeKitSelector((m) => m.self.id);
  const [speakerId, setSpeakerId] = useState<string | null>(null);
  const speakerTimer = useRef<number | null>(null);

  // Join once per meeting instance. A plain "run once" effect fires twice
  // under React StrictMode (mount -> cleanup -> remount) while the first
  // join() is still in flight — the SDK rejects that with ERR0002
  // "Unsupported concurrent calls on method: meeting.join".
  const joinGuard = useRef<{ inst: unknown; started: boolean }>({
    inst: null,
    started: false,
  });
  useEffect(() => {
    // Subscriptions are (re-)established on every mount — including the
    // StrictMode remount. Only the join() KICK-OFF is guarded: a second
    // concurrent join() is rejected by the SDK (ERR0002) while the first
    // is still in flight.
    let cancelled = false;
    const markJoined = () => {
      if (cancelled) return;
      setJoinState("joined");
      setJoinError(null);
    };
    const failJoin = (e: unknown) => {
      if (cancelled) return;
      // join() can reject even while media is flowing; only fail if the
      // room genuinely isn't joined after a grace period.
      setTimeout(() => {
        if (cancelled) return;
        if (meeting.self.roomJoined) markJoined();
        else {
          setJoinState("failed");
          setJoinError(
            e instanceof Error ? e.message : "Could not join the room.",
          );
        }
      }, 3000);
    };
    const onJoined = () => markJoined();
    meeting.self.on("roomJoined", onJoined);
    const poll = window.setInterval(() => {
      if (meeting.self.roomJoined) markJoined();
    }, 2000);
    if (meeting.self.roomJoined) {
      markJoined();
    } else if (
      joinGuard.current.inst !== meeting ||
      !joinGuard.current.started
    ) {
      joinGuard.current = { inst: meeting, started: true };
      // Fire and forget: the join() promise can stay pending after media is
      // already flowing. UI state comes from roomJoined, not the promise.
      meeting.join().then(markJoined, failJoin);
      // NOTE: no disableVideo() — on Voice presets there is no video track
      // and the call can hang forever.
      (async () => {
        try {
          if (!meeting.self.audioEnabled) await meeting.self.enableAudio();
        } catch (e) {
          if (cancelled) return;
          setJoinError(
            e instanceof Error
              ? `Joined, but the microphone is blocked: ${e.message}`
              : "Joined, but the microphone is blocked.",
          );
        }
      })();
    }
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      meeting.self.off("roomJoined", onJoined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting]);

  // Leave/kick surfaced by the meeting: just drop the session, never
  // call leave() here (leaving already happened).
  useEffect(() => {
    const handler = () => onLeave();
    meeting.self.on("roomLeft", handler);
    return () => {
      meeting.self.off("roomLeft", handler);
    };
  }, [meeting, onLeave]);

  // Speaking indicator from live audio levels.
  useEffect(() => {
    const handler = ({ peerId }: { peerId: string }) => {
      setSpeakerId(peerId);
      if (speakerTimer.current) window.clearTimeout(speakerTimer.current);
      speakerTimer.current = window.setTimeout(() => setSpeakerId(null), 1500);
    };
    meeting.participants.on("activeSpeaker", handler);
    return () => {
      meeting.participants.off("activeSpeaker", handler);
      if (speakerTimer.current) window.clearTimeout(speakerTimer.current);
    };
  }, [meeting]);

  // Roster refresh: the joined map mutates in place, so listen explicitly.
  // Remote mute/unmute only fires participant-level audioUpdate (not map
  // events), so resubscribe per participant whenever the roster changes.
  useEffect(() => {
    const bump = () => setRosterTick((t) => t + 1);
    meeting.participants.joined.on("participantsUpdate", bump);
    meeting.participants.joined.on("participantJoined", bump);
    meeting.participants.joined.on("participantLeft", bump);
    return () => {
      meeting.participants.joined.off("participantsUpdate", bump);
      meeting.participants.joined.off("participantJoined", bump);
      meeting.participants.joined.off("participantLeft", bump);
    };
  }, [meeting]);

  useEffect(() => {
    const bump = () => setRosterTick((t) => t + 1);
    const list = (() => {
      try {
        return Array.from(joined.values());
      } catch {
        return [];
      }
    })();
    for (const p of list) p.on("audioUpdate", bump);
    return () => {
      for (const p of list) p.off("audioUpdate", bump);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting, rosterTick]);

  const participants = useMemo(() => {
    void rosterTick; // recompute when roster events fire (map mutates in place)
    try {
      return Array.from(joined.values()).filter((p) => p.id !== selfId);
    } catch {
      return [];
    }
  }, [joined, selfId, rosterTick, meeting]);

  async function toggleMic() {
    setBusy(true);
    try {
      if (meeting.self.audioEnabled) await meeting.self.disableAudio();
      else await meeting.self.enableAudio();
      setJoinError(null);
    } catch (e) {
      setJoinError(e instanceof Error ? `Microphone error: ${e.message}` : "Microphone error.");
    } finally {
      setBusy(false);
    }
  }

  function leave() {
    if (leavingRef.current) return;
    leavingRef.current = true;
    meeting.leave().catch(() => {});
    onLeave();
  }

  async function refreshRooms() {
    try {
      setRooms(await listRooms());
    } catch {
      setRooms([]);
    }
  }

  useEffect(() => {
    refreshRooms();
  }, []);

  async function switchTo(ticket: RoomTicket, title: string) {
    setSideError(null);
    onSwitch(ticket, title);
  }

  async function joinByCode() {
    if (!code.trim()) return;
    setSideError(null);
    setBusy(true);
    try {
      const ticket = await joinRoom(code.trim(), session.displayName);
      setCode("");
      await switchTo(ticket, "Voice room");
    } catch (e) {
      setSideError(e instanceof Error ? e.message : "Could not join.");
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    setSideError(null);
    if (turnstileSiteKey && !turnstileToken) {
      setSideError("Please complete the human check first.");
      return;
    }
    setCreating(true);
    try {
      const ticket = await createRoom(newTitle.trim(), session.displayName, {
        isPublic: newPublic,
        turnstileToken: turnstileToken ?? undefined,
      });
      const title = newTitle.trim() || "Voice room";
      setNewTitle("");
      setTurnstileToken(null);
      await refreshRooms();
      await switchTo(ticket, title);
    } catch (e) {
      setSideError(e instanceof Error ? e.message : "Could not create room.");
    } finally {
      setCreating(false);
    }
  }

  async function copyCode() {
    if (!roomId) return;
    setCopied(await copyText(roomId));
    setTimeout(() => setCopied(false), 1500);
  }

  const me = selfName || session.displayName;
  const count = participants.length + 1;

  return (
    <div className="discord">
      {/* Sidebar */}
      <aside className="side">
        <div className="side-head">InChat</div>

        <div className="side-section">Voice rooms</div>
        <ul className="side-rooms">
          {rooms.map((r) => (
            <li key={r.id}>
              <button
                className={`side-room ${r.id === roomId ? "active" : ""}`}
                onClick={async () => {
                  if (r.id === roomId) return;
                  setSideError(null);
                  setBusy(true);
                  try {
                    const ticket = await joinRoom(r.id, session.displayName);
                    await switchTo(ticket, r.title);
                  } catch (e) {
                    setSideError(e instanceof Error ? e.message : "Could not join.");
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={busy}
                type="button"
              >
                <span className="hash">#</span>
                <span className="side-room-name">{r.title}</span>
                {r.live && <span className="live-dot" title={`${r.people} in room`} />}
              </button>
            </li>
          ))}
          {rooms.length === 0 && (
            <li className="muted side-empty">No public rooms yet.</li>
          )}
        </ul>
        <button className="ghost small" onClick={refreshRooms} type="button">
          Refresh list
        </button>

        <div className="side-section">Join by code</div>
        <div className="side-row">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Room code…"
            spellCheck={false}
            autoComplete="off"
          />
          <button onClick={joinByCode} disabled={busy || !code.trim()} type="button">
            Go
          </button>
        </div>

        <div className="side-section">Create room</div>
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Room title…"
          maxLength={80}
          autoComplete="off"
        />
        <label className="check">
          <input
            type="checkbox"
            checked={newPublic}
            onChange={(e) => setNewPublic(e.target.checked)}
          />
          List publicly
        </label>
        {turnstileSiteKey && (
          <div className="turnstile">
            <Turnstile
              siteKey={turnstileSiteKey}
              onSuccess={setTurnstileToken}
              onExpire={() => setTurnstileToken(null)}
              onError={() => setTurnstileToken(null)}
            />
          </div>
        )}
        <button className="primary" onClick={create} disabled={creating} type="button">
          {creating ? "Creating…" : "Create & join"}
        </button>
        {sideError && <div className="error">{sideError}</div>}

        <div className="side-user">
          <div className="avatar sm">{initialOf(me)}</div>
          <div className="side-user-name">{me}</div>
          <div className="side-user-btns">
            <button
              className={`iconbtn ${selfAudio && !deafened ? "on" : "off"}`}
              onClick={toggleMic}
              disabled={busy || joinState !== "joined"}
              title={selfAudio ? "Mute" : "Unmute"}
              type="button"
            >
              {selfAudio ? "🎙" : "🔇"}
            </button>
            <button
              className={`iconbtn ${deafened ? "off" : "on"}`}
              onClick={() => setDeafened((d) => !d)}
              title={deafened ? "Undeafen" : "Deafen (mute all incoming audio)"}
              type="button"
            >
              {deafened ? "🔈" : "🎧"}
            </button>
            <button className="iconbtn danger" onClick={leave} title="Disconnect" type="button">
              📞
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="stage">
        <div className="stage-top">
          <span className="hash">#</span>
          <strong>{session.title || "Voice room"}</strong>
          {roomId && (
            <button className="chip" onClick={copyCode} title="Copy room code">
              {copied ? "Copied!" : `${roomId.slice(0, 8)}…`}
            </button>
          )}
          <span className="muted">
            {joinState === "joined"
              ? `${count} connected`
              : joinState === "joining"
                ? "Connecting…"
                : "Not connected"}
          </span>
          <span className="spacer" />
          <div className="tabs mini">
            <button
              className={showChat && chatTab === "live" ? "active" : ""}
              onClick={() => { setShowChat(true); setChatTab("live"); }}
              type="button"
            >
              Chat
            </button>
            <button
              className={showChat && chatTab === "saved" ? "active" : ""}
              onClick={() => { setShowChat(true); setChatTab("saved"); }}
              disabled={!roomId}
              type="button"
            >
              Saved
            </button>
            <button
              className={!showChat ? "active" : ""}
              onClick={() => setShowChat(false)}
              type="button"
            >
              Hide
            </button>
          </div>
        </div>

        {joinError && <div className="error">{joinError}</div>}

        <div className={`stage-body ${showChat ? "with-chat" : ""}`}>
          <div className="vgrid">
            {/* Self tile */}
            <div className={`tile ${selfAudio && !deafened ? "" : "muted"}`}>
              <div className="avatar lg">{initialOf(me)}</div>
              <div className="tile-name">{me} (you)</div>
              <div className="tile-state">{selfAudio ? (deafened ? "Deafened" : "Talking") : "Muted"}</div>
            </div>
            {participants.map((p) => {
              const speaking = speakerId === p.id;
              return (
                <div key={p.id} className={`tile ${p.audioEnabled ? "" : "muted"} ${speaking ? "speaking" : ""}`}>
                  <div className="avatar lg">{initialOf(p.name)}</div>
                  <div className="tile-name">{p.name || "Guest"}</div>
                  <div className="tile-state">
                    {speaking ? "Speaking…" : p.audioEnabled ? "Listening" : "Muted"}
                  </div>
                  {!p.audioEnabled && <div className="tile-mic">🔇</div>}
                </div>
              );
            })}
            {joinState === "joined" && participants.length === 0 && (
              <p className="muted">Nobody else here yet — share the code to invite people.</p>
            )}
          </div>

          {showChat && (
            <div className="chatcol">
              {chatTab === "live" || !roomId ? (
                <LiveChat />
              ) : (
                <HistoryPanel roomId={roomId} />
              )}
            </div>
          )}
        </div>

        {/* Hidden sinks that actually play remote voices */}
        {participants.map((p) => (
          <RemoteAudio key={p.id} participant={p} deafened={deafened} />
        ))}
        {roomId && <HistorySync roomId={roomId} />}
      </main>
    </div>
  );
}
