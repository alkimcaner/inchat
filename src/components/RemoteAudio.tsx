import { useEffect, useRef } from "react";
import type { RTKParticipant } from "@cloudflare/realtimekit-react";

/**
 * Invisible audio sink for one remote participant. The Core SDK exposes
 * raw tracks (no autoplay handling), so we attach them to <audio> elements
 * ourselves and re-attach on audioUpdate (mute/unmute, track swaps).
 * Never rendered for self (echo).
 */
export default function RemoteAudio({
  participant,
  deafened,
}: {
  participant: RTKParticipant;
  deafened: boolean;
}) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const attach = () => {
      const el = ref.current;
      if (!el) return;
      const track = participant.audioTrack;
      el.srcObject = track ? new MediaStream([track]) : null;
      el.muted = deafened;
      if (track) el.play().catch(() => {});
    };
    attach();
    participant.on("audioUpdate", attach);
    return () => {
      participant.off("audioUpdate", attach);
      if (ref.current) ref.current.srcObject = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participant]);

  useEffect(() => {
    if (ref.current) ref.current.muted = deafened;
  }, [deafened]);

  return <audio ref={ref} autoPlay playsInline aria-hidden />;
}
