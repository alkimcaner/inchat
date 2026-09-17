import { app, BrowserWindow, shell } from "electron";
import path from "node:path";

const isDev = !app.isPackaged;
const DEV_URL = process.env.ELECTRON_DEV_URL ?? "http://127.0.0.1:1420";

function createWindow(): BrowserWindow {
  // NB: bun bakes __dirname to the source dir at build time, so resolve
  // runtime paths from the app root instead (works dev and packaged).
  const root = app.getAppPath();
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    title: "InChat — Voice Rooms",
    autoHideMenuBar: true,
    backgroundColor: "#0e1116",
    webPreferences: {
      preload: path.join(root, "dist-electron/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(root, "dist/index.html"));
  }

  // Open external links in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

void app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
