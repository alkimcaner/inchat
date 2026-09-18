import { useSyncExternalStore } from "react";

export interface RosterUser {
  id: string;
  name: string;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  isSelf: boolean;
}

let roster: RosterUser[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

/** Published by Stage (inside the meeting provider); read by Sidebar. */
export function publishRoster(users: RosterUser[]) {
  roster = users;
  notify();
}

export function clearRoster() {
  roster = [];
  notify();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function snapshot(): RosterUser[] {
  return roster;
}

/** Sidebar hook: live voice roster without needing the meeting context. */
export function useRoster(): RosterUser[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
