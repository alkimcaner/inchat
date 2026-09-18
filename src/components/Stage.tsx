import { useEffect, useMemo, useRef, useState } from "react";
import {
  useRealtimeKitMeeting,
  useRealtimeKitSelector,
} from "@cloudflare/realtimekit-react";
import type { Session } from "../App";
import { copyText } from "../lib/provision";
import { clearRoster, publishRoster } from "../lib/roster";
import RemoteAudio from "./RemoteAudio";
import MergedChat, { HistorySync } from "./MergedChat";

interface Props {
  session: Session;
  onLeave: () => void;
}

/** In-call stage: channel header, voice grid, controls, live/saved chat. */
export default function Stage({ session, onLeave }: Props) {
  const { meeting } = useRealtimeKitMeeting();
  const roomId = session.ticket.meeting_id;

  const [joinState, setJoinState] = useState<"joining" | "joined" | "failed">("joining");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [deafened, setDeafened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const leavingRef = useRef(false);

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
  // UI state comes from roomJoined (event + poll), never from the join()
  // promise, which can stay pending after media is already flowing.
  const joinGuard = useRef<{ inst: unknown; started: boolean }>({
    inst: null,
    started: false,
  });
  useEffect(() => {
    let cancelled = false;
    const markJoined = () => {
      if (cancelled) return;
      setJoinState("joined");
      setJoinError(null);
    };
    const failJoin = (e: unknown) => {
      if (cancelled) return;
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
  }, [joined, selfId, rosterTick]);

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

  // leave() unconditionally emits roomLeft on completion — even when
  // already left. So leaving is single-flight and never blocks the UI:
  // otherwise roomLeft -> leave -> roomLeft ... loops forever.
  function leave() {
    if (leavingRef.current) return;
    leavingRef.current = true;
    meeting.leave().catch(() => {});
    onLeave();
  }

  async function copyCode() {
    if (!roomId) return;
    setCopied(await copyText(roomId));
    setTimeout(() => setCopied(false), 1500);
  }

  // Publish the roster for the sidebar (which lives outside the
  // meeting provider). Clear on unmount so stale members don't linger.
  const me = selfName || session.displayName;
  useEffect(() => {
    publishRoster([
      {
        id: selfId || "self",
        name: `${me} (you)`,
        speaking: speakerId === selfId,
        muted: !selfAudio,
        isSelf: true,
      },
      ...participants.map((p) => ({
        id: p.id,
        name: p.name || "Guest",
        speaking: speakerId === p.id,
        muted: !p.audioEnabled,
        isSelf: false,
      })),
    ]);
    return () => clearRoster();
  }, [participants, selfId, me, speakerId, selfAudio, meeting]);

  const count = participants.length + 1;

  return (
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
      </div>

      {joinError && <div className="error">{joinError}</div>}

      <div className="stage-body">
        <div className="chatmid">
          <MergedChat roomId={roomId} />
        </div>
      </div>

      <div className="controls">
        <button
          className={`ctl ${selfAudio && !deafened ? "on" : "off"}`}
          onClick={toggleMic}
          disabled={busy || joinState !== "joined"}
          title={selfAudio ? "Mute" : "Unmute"}
          type="button"
        >
          {selfAudio ? "🎙" : "🔇"} {selfAudio ? "Mute" : "Unmute"}
        </button>
        <button
          className={`ctl ${deafened ? "off" : "on"}`}
          onClick={() => setDeafened((d) => !d)}
          title={deafened ? "Undeafen" : "Deafen (mute all incoming audio)"}
          type="button"
        >
          {deafened ? "🔈 Undeafen" : "🎧 Deafen"}
        </button>
        <button className="ctl hang" onClick={leave} title="Disconnect" type="button">
          📞 Disconnect
        </button>
      </div>

      {/* Hidden sinks that actually play remote voices */}
      {participants.map((p) => (
        <RemoteAudio key={p.id} participant={p} deafened={deafened} />
      ))}
      {roomId && <HistorySync roomId={roomId} />}
    </main>
  );
}
