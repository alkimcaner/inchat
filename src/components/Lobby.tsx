import { useEffect, useState } from "react";
import { Turnstile } from "@marsidev/react-turnstile";
import {
  createRoom,
  joinRoom,
  listRooms,
  voiceSupport,
  type RoomInfo,
  type RoomTicket,
} from "../lib/provision";

interface Props {
  onTicket: (ticket: RoomTicket, displayName: string, title: string) => void;
  busy: boolean;
  error: string | null;
}

const NAME_KEY = "inchat.displayName";

function randomGuest(): string {
  return `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
}

export default function Lobby({ onTicket, busy, error }: Props) {
  const [tab, setTab] = useState<"join" | "create">("join");
  const [name, setName] = useState(
    () => localStorage.getItem(NAME_KEY) ?? "",
  );
  const [roomId, setRoomId] = useState("");
  const [title, setTitle] = useState("");
  const [token, setToken] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  const displayName = name.trim() || randomGuest();
  const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as
    | string
    | undefined;
  const support = voiceSupport();

  async function refreshRooms() {
    setRoomsLoading(true);
    try {
      setRooms(await listRooms());
    } catch {
      setRooms([]);
    } finally {
      setRoomsLoading(false);
    }
  }

  useEffect(() => {
    refreshRooms();
  }, []);

  async function submit() {
    setLocalError(null);
    try {
      localStorage.setItem(NAME_KEY, name.trim());
      if (tab === "create") {
        if (turnstileSiteKey && !turnstileToken) {
          setLocalError("Please complete the human check first.");
          return;
        }
        const ticket = await createRoom(title.trim(), displayName, {
          isPublic,
          turnstileToken: turnstileToken ?? undefined,
        });
        onTicket(ticket, displayName, title.trim() || "Voice room");
      } else {
        if (!roomId.trim()) {
          setLocalError("Enter a room code to join.");
          return;
        }
        const ticket = await joinRoom(roomId, displayName);
        onTicket(ticket, displayName, "Voice room");
      }
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  function joinWithToken() {
    if (!token.trim()) {
      setLocalError("Paste a participant auth token first.");
      return;
    }
    // Advanced path: token embeds meeting + participant, no backend needed.
    onTicket(
      { meeting_id: "", auth_token: token.trim() },
      displayName,
      "Voice room",
    );
  }

  async function joinListed(room: RoomInfo) {
    setLocalError(null);
    setJoiningRoomId(room.id);
    try {
      localStorage.setItem(NAME_KEY, name.trim());
      const ticket = await joinRoom(room.id, displayName);
      onTicket(ticket, displayName, room.title);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setJoiningRoomId(null);
    }
  }

  const err = localError ?? error;

  return (
    <div className="card lobby">
      <h1>Talk, no sign-up.</h1>
      <p className="muted">
        Pick a display name, create a room or join one with its code. Everyone
        is anonymous.
      </p>
      {!support.ok && (
        <div className="error" role="note">
          {support.reason}
        </div>
      )}

      <label className="field">
        <span>Display name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={randomGuest()}
          maxLength={40}
          autoComplete="off"
        />
      </label>

      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "join"}
          className={tab === "join" ? "active" : ""}
          onClick={() => setTab("join")}
        >
          Join a room
        </button>
        <button
          role="tab"
          aria-selected={tab === "create"}
          className={tab === "create" ? "active" : ""}
          onClick={() => setTab("create")}
        >
          Create a room
        </button>
      </div>

      {tab === "join" ? (
        <label className="field">
          <span>Room code</span>
          <input
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="e.g. 68f…"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      ) : (
        <>
          <label className="field">
            <span>Room title</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Late-night radio"
              maxLength={80}
              autoComplete="off"
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            List in the public directory
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
        </>
      )}

      {err && (
        <div className="error" role="alert">
          {err}
        </div>
      )}

      <button className="primary" onClick={submit} disabled={busy}>
        {busy
          ? "Connecting…"
          : tab === "create"
            ? `Create & join as ${displayName}`
            : `Join as ${displayName}`}
      </button>

      <button className="link" onClick={() => setShowAdvanced((v) => !v)} type="button">
        {showAdvanced ? "Hide advanced" : "Have a token? Join directly"}
      </button>
      {showAdvanced && (
        <div className="advanced">
          <label className="field">
            <span>Participant auth token</span>
            <textarea
              value={token}
              onChange={(e) => setToken(e.target.value)}
              rows={3}
              spellCheck={false}
              placeholder="Paste the authToken from the API / dashboard"
            />
          </label>
          <button onClick={joinWithToken} disabled={busy} type="button">
            Join with token
          </button>
        </div>
      )}

      <div className="directory">
        <div className="directory-head">
          <h2>Public rooms</h2>
          <button className="ghost small" onClick={refreshRooms} type="button">
            Refresh
          </button>
        </div>
        {roomsLoading ? (
          <p className="muted">Loading rooms…</p>
        ) : rooms.length === 0 ? (
          <p className="muted">
            No rooms yet — create the first one above. (If this keeps showing,
            the Worker API may not be running.)
          </p>
        ) : (
          <ul className="room-list">
            {rooms.map((room) => (
              <li key={room.id}>
                <button
                  className="room-item"
                  onClick={() => joinListed(room)}
                  disabled={busy || joiningRoomId !== null}
                  type="button"
                >
                  <span
                    className={`dot ${room.live ? "live" : ""}`}
                    aria-hidden
                  />
                  <span className="room-item-title">{room.title}</span>
                  <span className="room-item-meta">
                    {room.live
                      ? `${room.people} in room`
                      : "empty — be the first in"}
                  </span>
                  <span className="room-item-join">
                    {joiningRoomId === room.id ? "Joining…" : "Join →"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
