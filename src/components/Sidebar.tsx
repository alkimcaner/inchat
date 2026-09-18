import { useEffect, useState } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import {
  createRoom,
  deleteRoom,
  joinRoom,
  listRooms,
  type RoomInfo,
  type RoomTicket,
} from "../lib/provision";
import { useRoster } from "../lib/roster";
import { useVoiceControls } from "../lib/voice-controls";
import { HeadphonesIcon, MicIcon, PhoneDownIcon } from "./icons";

interface Props {
  displayName: string;
  onDisplayName: (name: string) => void;
  activeRoomId: string;
  activeTitle: string;
  onJoin: (ticket: RoomTicket, title: string) => void;
  busy: boolean;
}

function initialOf(name: string): string {
  const t = name.trim();
  return t ? t[0]!.toUpperCase() : "?";
}

/** Mic / deafen / disconnect, bottom-left. Wired via the controls store. */
function UserBarButtons() {
  const vc = useVoiceControls();
  if (!vc.inCall) return null;
  return (
    <div className="side-user-btns">
      <button
        className="iconbtn"
        onClick={vc.toggleMic}
        disabled={!vc.canMic}
        title={vc.micOn ? "Mute" : "Unmute"}
        type="button"
      >
        <MicIcon off={!vc.micOn} />
      </button>
      <button
        className="iconbtn"
        onClick={vc.toggleDeafen}
        title={vc.deafened ? "Undeafen" : "Deafen (mute all incoming audio)"}
        type="button"
      >
        <HeadphonesIcon off={vc.deafened} />
      </button>
      <button
        className="iconbtn danger"
        onClick={vc.disconnect}
        title="Disconnect"
        type="button"
      >
        <PhoneDownIcon />
      </button>
    </div>
  );
}

/** Always-visible sidebar: brand, room directory, join/create, user card. */
export default function Sidebar({
  displayName,
  onDisplayName,
  activeRoomId,
  activeTitle,
  onJoin,
  busy,
}: Props) {
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [code, setCode] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newPublic, setNewPublic] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState(displayName);
  const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as
    | string
    | undefined;
  const roster = useRoster();
  const vc = useVoiceControls();
  // The active room may be unlisted (absent from the directory) — still
  // show it on top with its members.
  const visibleRooms: RoomInfo[] =
    activeRoomId && !rooms.some((r) => r.id === activeRoomId)
      ? [
          {
            id: activeRoomId,
            title: activeTitle || "Voice room",
            createdAt: "",
            live: true,
            people: roster.length,
          },
          ...rooms,
        ]
      : rooms;

  useEffect(() => {
    setNameDraft(displayName);
  }, [displayName]);

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

  async function joinById(id: string, title: string) {
    if (!id || id === activeRoomId) return;
    setError(null);
    setJoining(true);
    try {
      onJoin(await joinRoom(id, displayName), title);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not join.");
    } finally {
      setJoining(false);
    }
  }

  async function removeRoom(room: RoomInfo) {
    if (
      !window.confirm(
        `Delete "${room.title}"? This removes it from the directory and wipes its saved chat history.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      if (room.id === activeRoomId && vc.inCall) vc.disconnect();
      await deleteRoom(room.id);
      await refreshRooms();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete room.");
    }
  }

  async function joinByCode() {
    if (!code.trim()) return;
    const id = code.trim();
    setCode("");
    await joinById(id, "Voice room");
  }

  async function create() {
    setError(null);
    if (turnstileSiteKey && !turnstileToken) {
      setError("Please complete the human check first.");
      return;
    }
    setCreating(true);
    try {
      const ticket = await createRoom(newTitle.trim(), displayName, {
        isPublic: newPublic,
        turnstileToken: turnstileToken ?? undefined,
      });
      const title = newTitle.trim() || "Voice room";
      setNewTitle("");
      setTurnstileToken(null);
      await refreshRooms();
      onJoin(ticket, title);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create room.");
    } finally {
      setCreating(false);
    }
  }

  const disabled = busy || joining || creating;

  return (
    <aside className="side">
      <div className="side-head">InChat</div>

      <div className="side-section">Voice rooms</div>
      <ul className="side-rooms">
        {visibleRooms.map((r) => (
          <li key={r.id}>
            <div className="side-room-wrap">
              <button
                className={`side-room ${r.id === activeRoomId ? "active" : ""}`}
                onClick={() => joinById(r.id, r.title)}
                disabled={disabled}
                type="button"
                title={r.id}
              >
                <span className="hash">#</span>
                <span className="side-room-name">{r.title}</span>
                {r.live && (
                  <span className="live-dot" title={`${r.people} in room`} />
                )}
              </button>
              <button
                className="room-del"
                onClick={() => removeRoom(r)}
                disabled={disabled}
                title={`Delete "${r.title}"`}
                type="button"
              >
                ×
              </button>
            </div>
            {r.id === activeRoomId && roster.length > 0 && (
              <ul className="members">
                {roster.map((u) => (
                  <li
                    key={u.id}
                    className={`member ${u.speaking ? "speaking" : ""} ${u.muted ? "muted" : ""}`}
                    title={u.deafened ? "Deafened" : u.speaking ? "Speaking" : u.muted ? "Muted" : u.name}
                  >
                    <span className="avatar xs">{initialOf(u.name)}</span>
                    <span className="member-name">{u.name}</span>
                    <span className="member-mic">
                      {u.speaking && <span className="live-dot xs" />}
                      {u.deafened && <HeadphonesIcon off size={13} />}
                      {u.muted && <MicIcon off size={13} />}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
        {visibleRooms.length === 0 && (
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
          onKeyDown={(e) => {
            if (e.key === "Enter") joinByCode();
          }}
          placeholder="Room code…"
          spellCheck={false}
          autoComplete="off"
        />
        <button onClick={joinByCode} disabled={disabled || !code.trim()} type="button">
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
      <button className="primary" onClick={create} disabled={disabled} type="button">
        {creating ? "Creating…" : "Create & join"}
      </button>
      {error && <div className="error">{error}</div>}

      <div className="side-user">
        <div className="avatar sm">{initialOf(displayName)}</div>
        <input
          className="side-user-edit"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => onDisplayName(nameDraft.trim() || displayName)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          maxLength={40}
          spellCheck={false}
          autoComplete="off"
          title="Display name (applies to your next join)"
        />
        <UserBarButtons />
      </div>
    </aside>
  );
}
