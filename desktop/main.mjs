import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  dialog,
  nativeImage,
  shell,
} from "electron";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORIGIN = "http://localhost:3000";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
let mainWindow;
let tray;
let quitting = false;
let backendStartedByDesktop = false;
let dashboardPassword = "";
const shellLog = path.join(app.getPath("userData"), "desktop-shell.log");
function logShell(message, error) {
  const detail =
    error instanceof Error
      ? ": " + (error.stack ?? error.message)
      : error
        ? ": " + String(error)
        : "";
  try {
    writeFileSync(
      shellLog,
      new Date().toISOString() + " " + message + detail + "\n",
      { flag: "a" },
    );
  } catch {}
}
process.on("uncaughtException", (error) => logShell("Uncaught exception", error));
process.on("unhandledRejection", (error) => logShell("Unhandled rejection", error));
logShell("Desktop shell launched");

function packagedResource(...parts) {
  return path.join(process.resourcesPath, ...parts);
}

function findLegacyRuntime() {
  const requested = process.env.IDLECAST_HOME;
  if (requested && existsSync(path.join(requested, ".env"))) return requested;
  const eDriveRuntime = "E:\\IdleCast\\repo";
  if (process.platform === "win32" && existsSync(path.join(eDriveRuntime, ".env")))
    return eDriveRuntime;
  if (!app.isPackaged && existsSync(path.join(PROJECT_ROOT, ".env")))
    return PROJECT_ROOT;
  return null;
}

function ensureDesktopRuntime() {
  const runtime = path.join(app.getPath("userData"), "runtime");
  const data = path.join(runtime, "data");
  const media = path.join(runtime, "media");
  const envFile = path.join(runtime, ".env");
  mkdirSync(data, { recursive: true });
  mkdirSync(path.join(media, "avatars"), { recursive: true });
  if (!existsSync(envFile)) {
    dashboardPassword = randomBytes(18).toString("base64url");
    writeFileSync(
      envFile,
      [
        `ADMIN_PASSWORD=${dashboardPassword}`,
        "EXPERIMENTAL_YOUTUBE=true",
        `PUBLIC_ORIGIN=${ORIGIN}`,
        "COOKIE_SECURE=false",
        "HOST=127.0.0.1",
        "PORT=3000",
        "DATA_DIR=./data",
        "MEDIA_DIR=./media",
        "CACHE_MAX_MB=4096",
        "UDP_BASE_PORT=19000",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }
  return { runtime, envFile };
}

function desktopRuntime() {
  const legacy = findLegacyRuntime();
  if (legacy) return { runtime: legacy, envFile: path.join(legacy, ".env") };
  return ensureDesktopRuntime();
}

async function ping() {
  try {
    const response = await fetch(`${ORIGIN}/api/ping`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;
    const value = await response.json();
    return value?.application === "IdleCast";
  } catch {
    return false;
  }
}

async function portIsOccupied() {
  try {
    await fetch(ORIGIN, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

function backendEnvironment(runtime, envFile) {
  const resourceRoot = app.isPackaged
    ? packagedResource("idlecast")
    : PROJECT_ROOT;
  const tools = app.isPackaged
    ? packagedResource("tools")
    : path.join(runtime, "data", "tools");
  const ffmpeg = app.isPackaged
    ? path.join(tools, "ffmpeg.exe")
    : process.env.FFMPEG_PATH;
  const ffprobe = app.isPackaged
    ? path.join(tools, "ffprobe.exe")
    : process.env.FFPROBE_PATH;
  const ytdlp = app.isPackaged
    ? path.join(tools, "yt-dlp.exe")
    : process.env.YTDLP_PATH;
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    IDLECAST_ENV_FILE: envFile,
    IDLECAST_APP_ROOT: resourceRoot,
    ...(ffmpeg && existsSync(ffmpeg) ? { FFMPEG_PATH: ffmpeg } : {}),
    ...(ffprobe && existsSync(ffprobe) ? { FFPROBE_PATH: ffprobe } : {}),
    ...(ytdlp && existsSync(ytdlp) ? { YTDLP_PATH: ytdlp } : {}),
    ...(process.platform === "win32"
      ? { FONT_FILE: "C:/Windows/Fonts/arial.ttf" }
      : {}),
  };
}

async function startBackend() {
  if (await ping()) return;
  if (await portIsOccupied())
    throw new Error("Port 3000 is being used by another application.");
  const { runtime, envFile } = desktopRuntime();
  const logs = path.join(runtime, "data");
  mkdirSync(logs, { recursive: true });
  const output = openSync(path.join(logs, "desktop-server.log"), "a");
  const errors = openSync(path.join(logs, "desktop-server-error.log"), "a");
  const entry = app.isPackaged
    ? packagedResource("server", "index.mjs")
    : path.join(PROJECT_ROOT, "server", "index.ts");
  const args = app.isPackaged ? [entry] : ["--import", "tsx", entry];
  const child = spawn(process.execPath, args, {
    cwd: runtime,
    detached: true,
    env: backendEnvironment(runtime, envFile),
    stdio: ["ignore", output, errors],
    windowsHide: true,
  });
  child.unref();
  closeSync(output);
  closeSync(errors);
  backendStartedByDesktop = true;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await ping()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const detail = existsSync(path.join(logs, "desktop-server-error.log"))
    ? readFileSync(path.join(logs, "desktop-server-error.log"), "utf8").slice(-1500)
    : "No server error log was created.";
  throw new Error(`IdleCast did not start.\n\n${detail}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: "IdleCast",
    width: 1480,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#101216",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(ORIGIN)) {
      event.preventDefault();
      if (url.startsWith("https://")) void shell.openExternal(url);
    }
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  void mainWindow.loadURL(ORIGIN);
}

function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function refreshTrayMenu() {
  if (!tray) return;
  const launchAtLogin = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open IdleCast", click: showWindow },
      { label: "Open localhost dashboard", click: () => void shell.openExternal(ORIGIN) },
      { type: "separator" },
      {
        label: "Launch with Windows",
        type: "checkbox",
        checked: launchAtLogin,
        enabled: app.isPackaged,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath });
          refreshTrayMenu();
        },
      },
      ...(dashboardPassword
        ? [
            {
              label: "Copy dashboard password",
              click: () => clipboard.writeText(dashboardPassword),
            },
          ]
        : []),
      { type: "separator" },
      {
        label: backendStartedByDesktop
          ? "Quit desktop (stream keeps running)"
          : "Quit desktop",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray() {
  const cat = app.isPackaged
    ? packagedResource("idlecast", "media", "loading-cat.gif")
    : path.join(PROJECT_ROOT, "media", "loading-cat.gif");
  let icon = nativeImage.createFromPath(cat);
  if (!icon.isEmpty()) icon = icon.resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip("IdleCast");
  tray.on("double-click", showWindow);
  refreshTrayMenu();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
logShell("Single-instance lock: " + hasSingleInstanceLock);
if (!hasSingleInstanceLock) app.quit();
else {
  app.on("second-instance", showWindow);
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("window-all-closed", () => {});
  void app.whenReady().then(async () => {
    logShell("Electron is ready");
    try {
      await startBackend();
      logShell("Backend is ready");
      createWindow();
      logShell("Desktop window created");
      createTray();
      logShell("Tray created");
      if (dashboardPassword) {
        clipboard.writeText(dashboardPassword);
        await dialog.showMessageBox({
          type: "info",
          title: "IdleCast is ready",
          message: "Your new dashboard password was copied to the clipboard.",
          detail:
            "Paste it into the sign-in screen. You can copy it again from the tray menu.",
        });
      }
    } catch (error) {
      logShell("Desktop startup failed", error);
      await dialog.showMessageBox({
        type: "error",
        title: "IdleCast could not start",
        message: error instanceof Error ? error.message : String(error),
      });
      quitting = true;
      app.quit();
    }
  });
}
