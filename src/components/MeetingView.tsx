import { useEffect, useState } from "react";
import { RtkMeeting } from "@cloudflare/realtimekit-react-ui";
import { useRealtimeKitMeeting } from "@cloudflare/realtimekit-react";
import type { Session } from "../App";
import { copyText } from "../lib/provision";

interface Props {
  session: Session;
  onLeave: () => void;
}

/**
 * Voice room rendered entirely with the RealtimeKit UI Kit.
 * With a `Voice` meeting-type preset the UI Kit shows its voice-only
 * layout automatically — no custom media UI needed.
 */
export default function MeetingView({ session, onLeave }: Props) {
  const { meeting } = useRealtimeKitMeeting();
  const [copied, setCopied] = useState(false);

  // Return to the lobby if the local user leaves / is kicked via the UI Kit.
  useEffect(() => {
    const handler = () => onLeave();
    meeting.self.on("roomLeft", handler);
    return () => {
      meeting.self.off("roomLeft", handler);
    };
  }, [meeting, onLeave]);

  async function leave() {
    try {
      await meeting.leave();
    } finally {
      onLeave();
    }
  }

  async function copyCode() {
    if (!session.ticket.meeting_id) return;
    const ok = await copyText(session.ticket.meeting_id);
    setCopied(ok);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="meeting-view">
      <div className="meeting-bar">
        <div className="meeting-bar-title">
          <strong>{session.title || "Voice room"}</strong>
          {session.ticket.meeting_id && (
            <button
              className="chip"
              onClick={copyCode}
              title="Copy room code to invite others"
            >
              {copied ? "Copied!" : `Code: ${session.ticket.meeting_id}`}
            </button>
          )}
        </div>
        <button className="danger" onClick={leave}>
          Leave
        </button>
      </div>
      <div className="meeting-slot">
        <RtkMeeting
          meeting={meeting}
          mode="fill"
          showSetupScreen={true}
          leaveOnUnmount={false}
        />
      </div>
    </div>
  );
}
