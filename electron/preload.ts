import { clipboard, contextBridge } from "electron";

// Minimal, auditable bridge: the renderer gets clipboard write + an
// environment flag. No Node.js leaks into the page (sandbox stays on).
contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true as boolean,
  copyText: async (text: string): Promise<boolean> => {
    try {
      clipboard.writeText(text);
      return true;
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    }
  },
});

declare global {
  interface Window {
    electronAPI?: {
      isElectron: boolean;
      copyText: (text: string) => Promise<boolean>;
    };
  }
}
