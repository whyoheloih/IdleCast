import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Radio,
  LayoutDashboard,
  ListVideo,
  Settings2,
  ScrollText,
  HeartPulse,
  Play,
  Square,
  SkipForward,
  RefreshCw,
  LogOut,
  ArrowUpRight,
  Check,
  AlertTriangle,
  ChevronRight,
  Link,
  Volume2,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import type { Settings } from "../server/config";
import type { StoredItem } from "../server/db";
import { OverlayEditor } from "./OverlayEditor";
import { Credentials } from "./Credentials";
import { YouTubeViewer } from "./YouTubeViewer";
import "./style.css";
type Snapshot = {
  state: string;
  current: StoredItem | null;
  elapsed: number;
  outputs: Record<string, { status: string; retries: number }>;
  syncing: boolean;
  count: number;
  lastSync: number;
  desired: boolean;
  excluded: number;
};
async function api(url: string, method = "GET", body?: unknown) {
  const r = await fetch("/api/" + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: "Connection failed" }));
    throw Object.assign(
      new Error(
        e.error +
          (e.fields
            ? " · " +
              e.fields.map((f: any) => f.field + ": " + f.message).join(", ")
            : ""),
      ),
      { status: r.status },
    );
  }
  return r.json();
}
const time = (n: number) =>
  new Date(Math.max(0, n) * 1000).toISOString().slice(11, 19);
const hasQueueSource = (settings: Settings | null) =>
  !!settings &&
  (settings.sources.some((source) => source.value.trim()) ||
    (settings.sourceMode === "channel"
      ? !!settings.channelUrl.trim()
      : !!settings.playlistId.trim()));
const nav = [
  ["Overview", LayoutDashboard],
  ["Playlist", ListVideo],
  ["Settings", Settings2],
  ["Logs", ScrollText],
  ["Health", HeartPulse],
] as const;
function App() {
  const [auth, setAuth] = useState<boolean | null>(null),
    [password, setPassword] = useState(""),
    [page, setPage] = useState("Overview"),
    [state, setState] = useState<Snapshot | null>(null),
    [settings, setSettings] = useState<Settings | null>(null),
    [configured, setConfigured] = useState<any>({}),
    [items, setItems] = useState<StoredItem[]>([]),
    [logs, setLogs] = useState<any[]>([]),
    [health, setHealth] = useState<any>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(""),
    [connected, setConnected] = useState(false),
    [dirty, setDirty] = useState(false),
    [loadingItems, setLoadingItems] = useState(false),
    [overlayEditorOpen, setOverlayEditorOpen] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 78,
    overscan: 8,
  });
  const syncVersion = useRef(0);
  async function loadSettings() {
    const v = await api("settings");
    setSettings(v.settings);
    setConfigured(v.configured);
    setDirty(false);
  }
  async function loadItems() {
    const version = ++syncVersion.current;
    setLoadingItems(true);
    try {
      let all: StoredItem[] = [];
      let total = 0;
      do {
        const data = await api("playlist?offset=" + all.length + "&limit=500");
        total = data.total;
        all = all.concat(data.items);
        if (!data.items.length) break;
      } while (all.length < total);
      if (version === syncVersion.current) setItems(all);
    } catch (e: any) {
      setError(e.message);
    } finally {
      if (version === syncVersion.current) setLoadingItems(false);
    }
  }
  useEffect(() => {
    api("state")
      .then((v) => {
        setState(v);
        setAuth(true);
      })
      .catch((e) => {
        setError(e.status === 401 ? "" : e.message);
        setAuth(false);
      });
  }, []);
  useEffect(() => {
    if (!auth) return;
    void loadSettings().catch((e) => setError(e.message));
    void loadItems();
    const events = new EventSource("/api/events");
    events.onopen = () => setConnected(true);
    events.onmessage = (e) => {
      setState(JSON.parse(e.data));
      setConnected(true);
    };
    events.onerror = () => {
      setConnected(false);
      api("state").catch((e) => {
        if (e.status === 401) setAuth(false);
      });
    };
    return () => events.close();
  }, [auth]);
  useEffect(() => {
    if (auth) void loadItems();
  }, [state?.lastSync]);
  useEffect(() => {
    if (!auth) return;
    const update = () => {
      if (page === "Logs")
        api("logs")
          .then(setLogs)
          .catch((e) => setError(e.message));
      if (page === "Health")
        api("health")
          .then(setHealth)
          .catch((e) => setError(e.message));
    };
    update();
    const timer = setInterval(update, 15000);
    return () => clearInterval(timer);
  }, [page, auth]);
  async function action(name: string, fn: () => Promise<any>) {
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
      if (e.status === 401) setAuth(false);
    } finally {
      setBusy("");
    }
  }
  async function save() {
    await api("settings", "PUT", settings);
    await loadSettings();
    setNotice("Settings saved. Sync your playlist to refresh the queue.");
  }
  function change(patch: Partial<Settings>) {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    setDirty(true);
  }
  async function moveQueueItem(id: string, to: number) {
    await action("reorder", async () => {
      await api("playlist/order", "PUT", { id, to });
      await loadItems();
      setNotice("Queue order saved. Syncing again will create a new source order.");
    });
  }
  if (auth === null)
    return (
      <div className="login">
        <Radio className="spin" />
        <p>Connecting to IdleCast…</p>
      </div>
    );
  if (!auth)
    return (
      <div className="login">
        <div className="login-card">
          <div className="brand">
            <span className="brand-icon">
              <Radio />
            </span>
            IdleCast<span className="version">1.0</span>
          </div>
          <h1>
            Your playlist.
            <br />
            <em>Always live.</em>
          </h1>
          <p>Your private broadcast control room.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action("login", async () => {
                await api("login", "POST", { password });
                setPassword("");
                setAuth(true);
              });
            }}
          >
            <label>
              Admin password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                maxLength={256}
              />
            </label>
            <button className="primary" disabled={!!busy}>
              Enter control room <ChevronRight size={18} />
            </button>
          </form>
          {error && (
            <div role="alert" className="alert">
              {error}
            </div>
          )}
          <small>Single owner. Self hosted. Always yours.</small>
        </div>
      </div>
    );
  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span className="brand-icon">
            <Radio />
          </span>
          IdleCast
        </div>
        <div className="workspace-label">YOUR CONTROL ROOM</div>
        <nav>
          {nav.map(([name, Icon]) => (
            <button
              key={name}
              aria-label={name}
              className={page === name ? "active" : ""}
              onClick={() => setPage(name)}
            >
              <Icon size={19} />
              <span>{name}</span>
              {name === "Playlist" && <b>{state?.count ?? 0}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="owner">
            <span>IC</span>
            <div>
              My station<small>Owner workspace</small>
            </div>
            <i className={connected ? "dot" : "dot offline"} />
          </div>
          <button
            onClick={() =>
              void action("logout", async () => {
                await api("logout", "POST");
                setAuth(false);
              })
            }
          >
            <LogOut size={16} /> Sign out
          </button>
          <small>IdleCast v1.0.0</small>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <span className="eyebrow">WORKSPACE / {page.toUpperCase()}</span>
            <h1>
              {page === "Overview" ? "Your broadcast, at a glance." : page}
            </h1>
            <p>
              {page === "Overview"
                ? "One playlist. A station that keeps going."
                : page === "Playlist"
                  ? "Your YouTube order, automatically kept in sync."
                  : page === "Settings"
                    ? "Make this station your own."
                    : page === "Logs"
                      ? "A clear record of what happened."
                      : "The essentials behind your broadcast."}
            </p>
          </div>
          <span className={"connection " + (!connected ? "offline" : "")}>
            <i className="dot" />
            {connected ? "Connected" : "Reconnecting"}
          </span>
        </header>
        {error && (
          <div className="alert" role="alert">
            <AlertTriangle size={18} />
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            <Check size={18} />
            {notice}
          </div>
        )}
        {(!configured.youtubeApi || !hasQueueSource(settings)) && (
          <div className="setup-banner">
            <Link />
            <div>
              <b>Start with a YouTube playlist</b>
              <p>
                Add your playlist link in Settings. Configure your API key and
                stream destinations to go live.
              </p>
            </div>
            <button onClick={() => setPage("Settings")}>
              Open setup <ArrowUpRight size={16} />
            </button>
          </div>
        )}
        {page === "Overview" && (
          <>
            <div className="stats">
              <Metric
                label="BROADCAST"
                value={state?.state ?? "—"}
                sub={
                  state?.current
                    ? "Playback supervisor active"
                    : "Ready when you are"
                }
                accent
              />
              <Metric
                label="IN YOUR PLAYLIST"
                value={String(state?.count ?? 0)}
                sub="Videos in the synced queue"
              />
              <Metric
                label="DESTINATIONS"
                value={
                  String(
                    Object.values(state?.outputs ?? {}).filter(
                      (x) => x.status === "sending",
                    ).length,
                  ) +
                  " / " +
                  String(
                    Number(settings?.youtube.enabled ?? false) +
                      Number(settings?.twitch.enabled ?? false),
                  )
                }
                sub="Outputs reporting progress"
              />
              <Metric
                label="LAST SYNC"
                value={
                  state?.lastSync
                    ? new Date(state.lastSync).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "Not yet"
                }
                sub={
                  state?.syncing
                    ? "Updating playlist…"
                    : "Automatic sync every " +
                      (settings?.resyncMinutes ?? 15) +
                      " min"
                }
              />
            </div>
            {settings && <YouTubeViewer videoId={settings.youtubeWatchId} onSaved={id=>setSettings(s=>s?{...s,youtubeWatchId:id}:s)} />}
            <div className="overview-grid">
              <section className="panel playout">
                <div className="panel-heading">
                  <h2>
                    <Radio size={18} /> Now playing
                  </h2>
                  <button
                    type="button"
                    onClick={() => setOverlayEditorOpen(true)}
                  >
                    Preview / resize overlay
                  </button>
                  <span className="badge">
                    {state?.state === "playing" ? "PLAYING" : "STANDBY"}
                  </span>
                </div>
                <div className="stage">
                  <div className="stage-grid" />
                  <span className="stage-label">
                    PLAYOUT STATUS · NO VIDEO PREVIEW
                  </span>
                  <div className="stage-center">
                    <div className="broadcast-orbit">
                      <Radio size={44} />
                    </div>
                    <h2>
                      {state?.current?.title ??
                        "Your next broadcast starts here."}
                    </h2>
                    <p>
                      {state?.current?.channel ??
                        "Paste a playlist. Connect your channels. Press play."}
                    </p>
                  </div>
                  {settings?.overlay.enabled && (
                    <div className="overlay-preview">
                      <span>
                        <Radio size={22} />
                      </span>
                      <b>{state?.current?.title ?? settings.overlay.title}</b>
                    </div>
                  )}
                </div>
                <div className="timeline">
                  <span>{time(state?.elapsed ?? 0)}</span>
                  <progress
                    max={state?.current?.duration ?? 1}
                    value={state?.elapsed ?? 0}
                  />
                  <span>
                    {state?.current?.duration
                      ? time(state.current.duration)
                      : "—"}
                  </span>
                </div>
                <div className="controls">
                  <button
                    className="primary"
                    disabled={!!busy || state?.state !== "stopped" || dirty}
                    onClick={() =>
                      void action("start", () => api("start", "POST"))
                    }
                  >
                    <Play size={17} />
                    Start broadcast
                  </button>
                  <button
                    disabled={!!busy || state?.state === "stopped"}
                    onClick={() =>
                      void action("stop", () => api("stop", "POST"))
                    }
                  >
                    <Square size={16} />
                    Stop
                  </button>
                  <button
                    disabled={!!busy || state?.state === "stopped"}
                    onClick={() =>
                      void action("skip", () => api("skip", "POST"))
                    }
                  >
                    <SkipForward size={18} />
                    Skip
                  </button>
                </div>
              </section>
              <section className="panel destinations">
                <div className="panel-heading">
                  <h2>Destinations</h2>
                  <button
                    aria-label="Configure destinations"
                    onClick={() => setPage("Settings")}
                  >
                    <Settings2 size={17} />
                  </button>
                </div>
                {(["youtube", "twitch"] as const).map((name) => (
                  <div className="destination" key={name}>
                    <div className={"platform " + name}>
                      {name === "youtube" ? (
                        <Play size={21} fill="currentColor" />
                      ) : (
                        <Radio size={22} />
                      )}
                    </div>
                    <div>
                      <b>{name === "youtube" ? "YouTube Live" : "Twitch"}</b>
                      <small>
                        {settings?.[name].enabled
                          ? state?.state === "stopped"
                            ? "Ready · stopped"
                            : (state?.outputs[name]?.status ?? "Connecting")
                          : "Not enabled"}
                      </small>
                    </div>
                    <i
                      className={
                        state?.outputs[name]?.status === "sending"
                          ? "dot"
                          : "dot offline"
                      }
                    />
                  </div>
                ))}
                <div className="destination-note">
                  <Volume2 size={19} />
                  <p>
                    One shared encode. Independent connections.
                    <br />
                    Automatic retries when a destination drops.
                  </p>
                </div>
                <div className="source-note">
                  <span className="eyebrow">MEDIA SOURCE</span>
                  <h3>
                    {settings?.mediaSource === "local"
                      ? "Local media"
                      : "YouTube playlist"}
                  </h3>
                  <span className="tag">
                    {settings?.mediaSource === "local"
                      ? "Owner-supplied files"
                      : "Experimental adapter"}
                  </span>
                  <p>
                    YouTube access can change. Unavailable items are skipped and
                    retried later.
                  </p>
                </div>
              </section>
            </div>
            <section className="panel">
              <div className="panel-heading">
                <h2>Coming up in your playlist</h2>
                <button onClick={() => setPage("Playlist")}>
                  View playlist <ArrowUpRight size={16} />
                </button>
              </div>
              {items.length ? (
                items
                  .slice(
                    Math.max(
                      0,
                      items.findIndex((i) => i.id === state?.current?.id) + 1,
                    ),
                    Math.max(
                      0,
                      items.findIndex((i) => i.id === state?.current?.id) + 1,
                    ) + 3,
                  )
                  .map((item, i) => <Row item={item} key={item.id} index={i} />)
              ) : (
                <Empty
                  busy={loadingItems}
                  onSetup={() => setPage("Settings")}
                />
              )}
            </section>
          </>
        )}
        {page === "Playlist" && (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>
                  Broadcast queue{" "}
                  <span className="count">{state?.count ?? 0}</span>
                </h2>
                <p>Use the arrow buttons to set the order · loops continuously</p>
              </div>
              <button
                disabled={
                  !!busy || state?.syncing || dirty || !hasQueueSource(settings)
                }
                onClick={() =>
                  void action("sync", async () => {
                    await api("sync", "POST");
                    await loadItems();
                  })
                }
              >
                <RefreshCw size={16} className={state?.syncing ? "spin" : ""} />
                {state?.syncing
                  ? "Syncing…"
                  : settings?.shuffle
                    ? "Reshuffle"
                    : "Sync now"}
              </button>
            </div>
            {!items.length ? (
              <Empty busy={loadingItems} onSetup={() => setPage("Settings")} />
            ) : (
              <div className="virtual-list" ref={scroll}>
                <div
                  style={{
                    height: virtual.getTotalSize(),
                    position: "relative",
                  }}
                >
                  {virtual.getVirtualItems().map((v) => (
                    <div
                      key={items[v.index].id}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: v.size,
                        transform: "translateY(" + v.start + "px)",
                      }}
                    >
                      <Row
                        item={items[v.index]}
                        index={v.index}
                        active={items[v.index].id === state?.current?.id}
                        canMoveUp={v.index > 0}
                        canMoveDown={v.index < items.length - 1}
                        moveDisabled={
                          !!busy || state?.state !== "stopped" || state?.syncing
                        }
                        onMove={(to) =>
                          void moveQueueItem(items[v.index].id, to)
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}
        {page === "Settings" && settings && (
          <form
            className="settings-grid"
            onSubmit={(e) => {
              e.preventDefault();
              void action("save", save);
            }}
          >
            <section className="panel form-panel">
              <span className="eyebrow">01 / SOURCE</span>
              <h2>Your videos, on repeat.</h2>
              <label>Combined sources (one YouTube playlist or channel link per line)
                <textarea rows={5} value={settings.sources.map((source) => source.value).join("\n")}
                  onChange={(e) => change({sources: e.target.value.split("\n").map((value) => ({value, kind: (value.includes("list=") || /^[A-Za-z0-9_-]+$/.test(value) && !value.startsWith("UC") ? "playlist" : "channel") as "playlist" | "channel"}))})}
                  onBlur={() => change({sources: settings.sources.filter((source) => source.value.trim())})}
                  placeholder={"https://www.youtube.com/playlist?list=…\nhttps://www.youtube.com/@channel"} />
              </label>
              <p className="hint">When filled in, these sources replace the single source below. Duplicate videos are included once.</p>
              <label>
                Queue source
                <select
                  value={settings.sourceMode}
                  onChange={(e) =>
                    change({
                      sourceMode: e.target.value as Settings["sourceMode"],
                    })
                  }
                >
                  <option value="playlist">YouTube playlist</option>
                  <option value="channel">Entire YouTube channel</option>
                </select>
              </label>
              {settings.sourceMode === "channel" ? (
                <label>
                  YouTube channel URL or @handle
                  <input
                    value={settings.channelUrl}
                    onChange={(e) => change({ channelUrl: e.target.value })}
                    placeholder="https://www.youtube.com/@channel"
                  />
                </label>
              ) : (
                <label>
                  YouTube playlist link or ID
                  <input
                    value={settings.playlistId}
                    onChange={(e) => change({ playlistId: e.target.value })}
                    placeholder="https://www.youtube.com/playlist?list=…"
                  />
                </label>
              )}
              <label>
                Exclude title words or phrases (one per line)
                <textarea
                  rows={4}
                  value={settings.excludedWords.join("\n")}
                  onChange={(e) =>
                    change({ excludedWords: e.target.value.split("\n") })
                  }
                  onBlur={() =>
                    change({
                      excludedWords: settings.excludedWords
                        .map((w) => w.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder={"Trailer\nAnnouncement"}
                />
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settings.shuffle}
                  onChange={(e) => change({ shuffle: e.target.checked })}
                />
                Shuffle
              </label>
              <p className="hint">
                Exclusions ignore capitalization. Shuffle creates a new order on
                each sync, starts with a video of 15 minutes or less, and keeps
                videos over 1 hour 10 minutes from playing consecutively. Use the
                arrows on the Playlist page to adjust the shuffled order. Playback
                waits when no qualifying shorter video is available. Save and sync
                to apply queue changes. Last sync excluded{" "}
                {state?.excluded ?? 0} videos.
              </p>
              <label>
                Media source
                <select
                  value={settings.mediaSource}
                  onChange={(e) =>
                    change({
                      mediaSource: e.target.value as Settings["mediaSource"],
                    })
                  }
                >
                  <option value="youtube-experimental">
                    YouTube — experimental
                  </option>
                  <option value="local">Local files — optional</option>
                </select>
              </label>
              <p className="hint">
                The official API supplies titles and order. The experimental
                yt-dlp adapter downloads playable videos into a size-limited
                cache. Use media you are authorized to broadcast. Restricted or
                unavailable videos may fail.
              </p>
              <Status ok={configured.youtubeApi} label="YouTube Data API key" />
              <Status
                ok={configured.experimental}
                label="Experimental YouTube adapter"
              />
              <label>
                Resync interval (minutes)
                <input
                  type="number"
                  min={5}
                  max={1440}
                  value={settings.resyncMinutes}
                  onChange={(e) =>
                    change({ resyncMinutes: Number(e.target.value) })
                  }
                />
              </label>
            </section>
            <section className="panel form-panel">
              <span className="eyebrow">02 / OUTPUTS</span>
              <h2>Where you go live.</h2>
              {(["youtube", "twitch"] as const).map((name) => (
                <div className="output-form" key={name}>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={settings[name].enabled}
                      onChange={(e) =>
                        change({
                          [name]: {
                            ...settings[name],
                            enabled: e.target.checked,
                          },
                        })
                      }
                    />
                    {name === "youtube" ? "YouTube Live" : "Twitch"}
                  </label>
                  <label>
                    RTMPS ingest server
                    <input
                      value={settings[name].server}
                      onChange={(e) =>
                        change({
                          [name]: { ...settings[name], server: e.target.value },
                        })
                      }
                    />
                  </label>
                  <Status ok={configured[name]} label="Stream key" />
                </div>
              ))}
              <p className="hint">
                Save API and stream keys in the Credentials section. Create your
                broadcast in the destination’s creator dashboard first.
              </p>
            </section>
            <section className="panel form-panel">
              <span className="eyebrow">03 / ON-STREAM IDENTITY</span>
              <h2>A signature in the corner.</h2>
              <button
                type="button"
                className="primary"
                onClick={() => setOverlayEditorOpen(true)}
              >
                Open overlay preview
              </button>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settings.overlay.enabled}
                  onChange={(e) =>
                    change({
                      overlay: {
                        ...settings.overlay,
                        enabled: e.target.checked,
                      },
                    })
                  }
                />
                Show bottom-left overlay
              </label>
              <label>
                Standby / preview title
                <input
                  value={settings.overlay.title}
                  maxLength={100}
                  onChange={(e) =>
                    change({
                      overlay: { ...settings.overlay, title: e.target.value },
                    })
                  }
                />
              </label>
              <label>
                Avatar filename (optional)
                <input
                  value={settings.overlay.avatar}
                  placeholder="avatar.png"
                  onChange={(e) =>
                    change({
                      overlay: { ...settings.overlay, avatar: e.target.value },
                    })
                  }
                />
              </label>
              <p className="hint">
                During playback, the current video title appears in white with a
                black outline and no background box. Avatars use a proportional
                square crop. Place images in media/avatars.
              </p>
              <div className="two-fields">
                <label>
                  Text size
                  <input
                    type="number"
                    min={12}
                    max={96}
                    value={settings.overlay.fontSize}
                    onChange={(e) =>
                      change({
                        overlay: {
                          ...settings.overlay,
                          fontSize: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Margin
                  <input
                    type="number"
                    min={8}
                    max={100}
                    value={settings.overlay.margin}
                    onChange={(e) =>
                      change({
                        overlay: {
                          ...settings.overlay,
                          margin: Number(e.target.value),
                        },
                      })
                    }
                  />
                </label>
              </div>
              <p className="hint">
                Profile picture size: {settings.overlay.avatarSize} px. Open the
                preview to resize it independently.
              </p>
            </section>
            <section className="panel form-panel">
              <span className="eyebrow">04 / QUALITY</span>
              <h2>Built for the long run.</h2>
              <div className="quality">
                <b>
                  {settings.width} × {settings.height}
                </b>
                <span>H.264 video / AAC audio</span>
              </div>
              <label>
                Resolution
                <select
                  aria-label="Resolution"
                  value={settings.height}
                  onChange={(e) =>
                    change(
                      e.target.value === "1080"
                        ? { width: 1920, height: 1080 }
                        : { width: 1280, height: 720 },
                    )
                  }
                >
                  <option value={720}>1280 × 720 (720p)</option>
                  <option value={1080}>1920 × 1080 (1080p)</option>
                </select>
              </label>
              <label>
                Frame rate
                <select
                  aria-label="Frame rate"
                  value={settings.fps}
                  onChange={(e) =>
                    change({ fps: Number(e.target.value) as 24 | 30 | 60 })
                  }
                >
                  <option value={24}>24 fps</option>
                  <option value={30}>30 fps</option>
                  <option value={60}>60 fps</option>
                </select>
              </label>
              <label>
                Video bitrate (kbps)
                <input
                  type="number"
                  min={500}
                  max={6000}
                  step={100}
                  value={settings.bitrateKbps}
                  onChange={(e) =>
                    change({ bitrateKbps: Number(e.target.value) })
                  }
                />
              </label>
              <p className="hint">
                Higher resolution and 60 fps use more CPU. Save quality settings
                before opening the overlay preview. Lower-frame-rate sources
                repeat frames at 60 fps. Simultaneous destinations multiply
                outbound bandwidth, but share the video encode.
              </p>
              <p className="hint">
                Stop playback before saving. After adding a playlist, save and
                sync to build your queue.
              </p>
            </section>
            <Credentials
              onSaved={async () => {
                const result = await api("settings");
                setConfigured(result.configured);
              }}
            />
            <div className="save-bar">
              <span>{dirty ? "Unsaved changes" : "Settings are saved"}</span>
              <button
                type="submit"
                className="primary"
                disabled={!!busy || state?.state !== "stopped" || state.syncing}
              >
                {busy === "save" ? "Saving…" : "Save settings"}
              </button>
              <button
                type="button"
                disabled={!!busy || dirty || !hasQueueSource(settings)}
                onClick={() =>
                  void action("sync", async () => {
                    await api("sync", "POST");
                    setNotice("Playlist synced. Your queue is ready.");
                  })
                }
              >
                <RefreshCw size={16} />
                Sync playlist
              </button>
            </div>
          </form>
        )}
        {page === "Logs" && (
          <section className="panel">
            <div className="panel-heading">
              <h2>Recent events</h2>
              <span className="hint">Latest 200 · refreshes every 15s</span>
            </div>
            {logs.length ? (
              logs.map((log) => (
                <div className="log-row" key={log.id}>
                  <time>{new Date(log.time).toLocaleString()}</time>
                  <span className={"log-level " + log.level}>{log.level}</span>
                  <p>{log.message}</p>
                </div>
              ))
            ) : (
              <div className="empty">
                <ScrollText />
                <h3>A clean slate.</h3>
                <p>Sync or start playback to see activity here.</p>
              </div>
            )}
          </section>
        )}
        {page === "Health" &&
          (health ? (
            <>
              <div className="stats">
                <Metric
                  label="APP VERSION"
                  value={health.version}
                  sub="Single-owner instance"
                />
                <Metric
                  label="UPTIME"
                  value={time(health.uptime)}
                  sub="Since process started"
                />
                <Metric
                  label="MEMORY"
                  value={health.memoryMB + " MB"}
                  sub="Application resident memory"
                />
                <Metric
                  label="FREE DISK"
                  value={(health.freeDiskMB / 1024).toFixed(1) + " GB"}
                  sub="Data volume available space"
                />
              </div>
              <section className="panel form-panel">
                <h2>Service checks</h2>
                {health.checks.map((c: any) => (
                  <Status
                    key={c.name}
                    ok={c.ok}
                    label={c.name.replace("_PATH", "")}
                  />
                ))}
                <Status
                  ok={health.database?.quick_check === "ok"}
                  label="SQLite integrity"
                />
                <p className="hint">
                  Output progress means FFmpeg is sending. Confirm broadcast
                  visibility in YouTube Studio or Twitch. These checks do not
                  validate account access, stream keys, or viewer playback.
                </p>
              </section>
            </>
          ) : (
            <div className="empty">Checking services…</div>
          ))}
        {settings && (
          <OverlayEditor
            open={overlayEditorOpen}
            value={settings.overlay}
            canSave={state?.state === "stopped" && !state.syncing && !busy}
            onClose={() => setOverlayEditorOpen(false)}
            onSave={async (value) => {
              const saved = await api("overlay", "PUT", value);
              const next = { ...settings, overlay: saved.settings.overlay };
              setSettings(next);
              setDirty(JSON.stringify(next) !== JSON.stringify(saved.settings));
              setNotice("Overlay settings saved.");
            }}
          />
        )}
        <footer>
          <span>
            <Radio size={14} /> Your playlist. Always live.
          </span>
          <button
            className="footer-logout"
            onClick={() =>
              void action("logout", async () => {
                await api("logout", "POST");
                setAuth(false);
              })
            }
          >
            Sign out
          </button>
        </footer>
      </main>
    </div>
  );
}
function Metric({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div className="metric">
      <span className="eyebrow">{label}</span>
      <strong className={accent ? "accent" : ""}>{value}</strong>
      <small>{sub}</small>
    </div>
  );
}
function Status({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="status-check">
      {ok ? (
        <Check size={16} className="accent" />
      ) : (
        <AlertTriangle size={16} className="amber" />
      )}
      <span>{label}</span>
      <small>{ok ? "Configured / available" : "Needs setup"}</small>
    </div>
  );
}
function Row({
  item,
  index,
  active = false,
  canMoveUp = false,
  canMoveDown = false,
  moveDisabled = false,
  onMove,
}: {
  item: StoredItem;
  index: number;
  active?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  moveDisabled?: boolean;
  onMove?: (to: number) => void;
}) {
  return (
    <div className={"playlist-row " + (active ? "playing-row" : "")}>
      <span className="row-index">
        {active ? <Volume2 size={17} /> : String(index + 1).padStart(2, "0")}
      </span>
      {onMove && (
        <div className="row-actions">
          <button
            type="button"
            aria-label={`Move ${item.title} up`}
            disabled={moveDisabled || !canMoveUp}
            onClick={() => onMove(index - 1)}
          >
            <ChevronUp size={15} />
          </button>
          <button
            type="button"
            aria-label={`Move ${item.title} down`}
            disabled={moveDisabled || !canMoveDown}
            onClick={() => onMove(index + 1)}
          >
            <ChevronDown size={15} />
          </button>
        </div>
      )}
      <div className="thumb">
        {item.thumbnail?.startsWith("https://i.ytimg.com/") ? (
          <img src={item.thumbnail} alt="" loading="lazy" />
        ) : (
          <ListVideo size={22} />
        )}
      </div>
      <div className="row-title">
        <b>{item.title}</b>
        <small>{item.channel || "Unavailable channel"}</small>
      </div>
      <span
        className={!item.available || item.error ? "tag amber" : "row-duration"}
      >
        {!item.available
          ? "Unavailable"
          : item.error
            ? "Retry pending"
            : item.duration
              ? time(item.duration)
              : "—"}
      </span>
    </div>
  );
}
function Empty({ busy, onSetup }: { busy: boolean; onSetup: () => void }) {
  return (
    <div className="empty">
      <ListVideo size={32} />
      <h3>{busy ? "Loading your playlist…" : "A little quiet in here."}</h3>
      <p>Connect a YouTube playlist and sync your first queue.</p>
      <button onClick={onSetup}>
        Set up playlist <ArrowUpRight size={15} />
      </button>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
