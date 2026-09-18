import { useSyncExternalStore } from "react";

export interface VoiceControls {
  inCall: boolean;
  micOn: boolean;
  deafened: boolean;
  canMic: boolean;
  toggleMic: () => void;
  toggleDeafen: () => void;
  disconnect: () => void;
}

const noop = () => {};

const idle: VoiceControls = {
  inCall: false,
  micOn: false,
  deafened: false,
  canMic: false,
  toggleMic: noop,
  toggleDeafen: noop,
  disconnect: noop,
};

let current: VoiceControls = idle;
const listeners = new Set<() => void>();

/** Published by Stage (inside the meeting provider); read by Sidebar. */
export function publishVoiceControls(v: VoiceControls) {
  current = v;
  for (const l of listeners) l();
}

export function clearVoiceControls() {
  current = idle;
  for (const l of listeners) l();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function snapshot(): VoiceControls {
  return current;
}

/** Sidebar hook: call controls without needing the meeting context. */
export function useVoiceControls(): VoiceControls {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
