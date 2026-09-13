import express from "express";
import {
  randomBytes,
  scryptSync,
  scrypt,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
import path from "node:path";
import { statfs } from "node:fs/promises";
import { z } from "zod";
import type { Config } from "./config.js";
import { settingsSchema } from "./config.js";
import { Store } from "./db.js";
import { Engine } from "./engine.js";
import { runCapture } from "./process.js";
import { OverlayPreview } from "./preview.js";
import { credentialStore } from "./credentials.js";
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function createApp(c: Config, store: Store, engine: Engine) {
  const app = express();
  const saveCredentials = credentialStore(c, store);
  const preview = new OverlayPreview(c);
  app.disable("x-powered-by");
  store.db.exec("DELETE FROM sessions"); // Password/environment changes invalidate existing sessions.
  const salt = randomBytes(16),
    passwordHash = scryptSync(c.ADMIN_PASSWORD, salt, 64);
  const attempts = new Map<string, { n: number; until: number }>();
  let activeLogins = 0;
  app.use((_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' https://i.ytimg.com data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use("/api", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin !== c.PUBLIC_ORIGIN
    ) {
      res.status(403).json({ error: "Request origin rejected" });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  const cookie = (req: express.Request) =>
    req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("idlecast="))
      ?.slice(9) ?? "";
  app.post("/api/login", async (req, res) => {
    const key = req.socket.remoteAddress ?? "local",
      now = Date.now();
    for (const [ip, a] of attempts) if (a.until <= now) attempts.delete(ip);
    const a = attempts.get(key) ?? { n: 0, until: now + 900000 };
    if (a.n >= 10 || activeLogins >= 4 || attempts.size > 1000) {
      res
        .set("Retry-After", "900")
        .status(429)
        .json({ error: "Too many sign-in attempts; try again in 15 minutes" });
      return;
    }
    a.n++;
    attempts.set(key, a);
    const input = z
      .object({ password: z.string().min(1).max(256) })
      .strict()
      .safeParse(req.body);
    if (!input.success) {
      res.status(400).json({ error: "Enter a valid password" });
      return;
    }
    activeLogins++;
    let valid = false;
    try {
      const hash = (await promisify(scrypt)(
        input.data.password,
        salt,
        64,
      )) as Buffer;
      valid = timingSafeEqual(hash, passwordHash);
    } finally {
      activeLogins--;
    }
    if (!valid) {
      res.status(401).json({ error: "Incorrect password" });
      return;
    }
    attempts.delete(key);
    store.db.prepare("DELETE FROM sessions WHERE expires<=?").run(now);
    const token = randomBytes(32).toString("hex");
    store.db
      .prepare("INSERT INTO sessions VALUES(?,?)")
      .run(digest(token), now + 86400000);
    res.cookie("idlecast", token, {
      httpOnly: true,
      sameSite: "strict",
      secure: c.COOKIE_SECURE,
      maxAge: 86400000,
      path: "/",
    });
    res.json({ ok: true });
  });
  app.use("/api", (req, res, next) => {
    const token = cookie(req);
    if (
      !/^[a-f0-9]{64}$/.test(token) ||
      !store.db
        .prepare("SELECT hash FROM sessions WHERE hash=? AND expires>?")
        .get(digest(token), Date.now())
    ) {
      res.status(401).json({ error: "Sign in required" });
      return;
    }
    next();
  });
  app.post("/api/logout", (req, res) => {
    store.db
      .prepare("DELETE FROM sessions WHERE hash=?")
      .run(digest(cookie(req)));
    res.clearCookie("idlecast", {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: c.COOKIE_SECURE,
    });
    res.json({ ok: true });
  });
  app.get("/api/state", (_req, res) => res.json(engine.snapshot()));
  app.put("/api/viewer", (req,res)=>{
    const parsed=z.object({youtubeWatchId:settingsSchema.shape.youtubeWatchId}).strict().safeParse(req.body);
    if(!parsed.success){res.status(400).json({error:"Enter a valid YouTube broadcast watch link or video ID"});return;}
    store.set("settings",{...store.settings(),youtubeWatchId:parsed.data.youtubeWatchId});
    res.json({youtubeWatchId:parsed.data.youtubeWatchId});
  });
  app.put("/api/credentials", (req, res) => {
    if (engine.state !== "stopped" || engine.syncing) {
      res.status(409).json({
        error: "Stop playback and wait for sync before saving credentials",
      });
      return;
    }
    const value = z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(/^[^\s\x00-\x1f]+$/)
      .nullable()
      .optional();
    const parsed = z
      .object({
        YOUTUBE_API_KEY: value,
        YOUTUBE_STREAM_KEY: value,
        TWITCH_STREAM_KEY: value,
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter valid keys without spaces" });
      return;
    }
    saveCredentials(parsed.data);
    engine.event("Credentials updated");
    res.json({ ok: true });
  });
  app.put("/api/overlay", (req, res) => {
    if (engine.state !== "stopped" || engine.syncing) {
      res.status(409).json({
        error: "Stop playback and wait for sync before saving the overlay",
      });
      return;
    }
    const parsed = settingsSchema.shape.overlay.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid overlay settings" });
      return;
    }
    const settings = { ...store.settings(), overlay: parsed.data };
    store.set("settings", settings);
    engine.event("Overlay settings updated");
    res.json({ settings });
  });
  app.post("/api/overlay/preview", async (req, res) => {
    const parsed = settingsSchema.shape.overlay.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid overlay settings" });
      return;
    }
    if (preview.busy) {
      res
        .set("Retry-After", "1")
        .status(429)
        .json({ error: "Preview is busy; retry shortly" });
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.on("close", cancel);
    try {
      const source = engine.previewSource();
      const frame = await preview.render(
        {
          ...store.settings(),
          overlay: {
            ...parsed.data,
            title: source
              ? (engine.current?.title ?? parsed.data.title)
              : parsed.data.title,
          },
        },
        source,
        controller.signal,
      );
      if (!controller.signal.aborted)
        res
          .set("X-Preview-Source", source ? "current-video" : "standby")
          .type("png")
          .send(frame);
    } catch {
      if (!controller.signal.aborted)
        res.status(503).json({
          error:
            "Preview unavailable. Check the avatar filename, font, and FFmpeg in Health, then retry.",
        });
    } finally {
      res.off("close", cancel);
    }
  });
  app.get("/api/settings", (_req, res) =>
    res.json({
      settings: store.settings(),
      configured: {
        youtubeApi: !!c.YOUTUBE_API_KEY,
        youtube: !!c.YOUTUBE_STREAM_KEY,
        twitch: !!c.TWITCH_STREAM_KEY,
        experimental: c.EXPERIMENTAL_YOUTUBE,
      },
    }),
  );
  app.put("/api/settings", (req, res) => {
    if (engine.state !== "stopped" || engine.syncing) {
      res.status(409).json({
        error: "Stop playback and wait for sync before saving settings",
      });
      return;
    }
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid settings",
        fields: parsed.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    if (
      parsed.data.mediaSource === "youtube-experimental" &&
      !c.EXPERIMENTAL_YOUTUBE
    ) {
      res.status(400).json({
        error:
          "Enable EXPERIMENTAL_YOUTUBE in the environment to use YouTube media",
      });
      return;
    }
    const previous = store.settings();
    if (
      parsed.data.playlistId !== previous.playlistId ||
      parsed.data.sourceMode !== previous.sourceMode ||
      parsed.data.channelUrl !== previous.channelUrl ||
      parsed.data.shuffle !== previous.shuffle ||
      JSON.stringify(parsed.data.excludedWords) !==
        JSON.stringify(previous.excludedWords)
    ) {
      store.replace([]);
      store.set("cursor", null);
      store.set("lastSync", 0);
      store.set("excludedCount", 0);
    }
    store.set("settings", parsed.data);
    engine.event("Settings updated");
    res.json({ ok: true });
  });
  app.get("/api/playlist", (req, res) => {
    const query = z
      .object({
        offset: z.coerce.number().int().min(0).max(100000).default(0),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .strict()
      .safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid pagination" });
      return;
    }
    res.json({
      items: store.list(query.data.offset, query.data.limit),
      total: store.count(),
    });
  });
  app.post("/api/sync", async (_req, res) => {
    await engine.sync();
    res.json({ ok: true });
  });
  app.post("/api/start", async (_req, res) => {
    await engine.start();
    res.json({ ok: true });
  });
  app.post("/api/stop", async (_req, res) => {
    await engine.stop();
    res.json({ ok: true });
  });
  app.post("/api/skip", (_req, res) => {
    engine.skip();
    res.json({ ok: true });
  });
  app.get("/api/logs", (_req, res) => res.json(store.logs()));
  let healthCache: { time: number; value: unknown } | null = null;
  app.get("/api/health", async (_req, res) => {
    if (healthCache && Date.now() - healthCache.time < 15000) {
      res.json(healthCache.value);
      return;
    }
    const controller = new AbortController();
    const checks = await Promise.all(
      ["FFMPEG_PATH", "FFPROBE_PATH", "YTDLP_PATH"].map(async (key) => {
        try {
          await runCapture(
            c[key as "FFMPEG_PATH"],
            [key === "YTDLP_PATH" ? "--version" : "-version"],
            controller.signal,
            5000,
          );
          return { name: key, ok: true };
        } catch {
          return { name: key, ok: false };
        }
      }),
    );
    const disk = await statfs(c.DATA_DIR);
    const value = {
      version: "1.0.0",
      uptime: Math.floor(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1048576),
      freeDiskMB: Math.round((disk.bavail * disk.bsize) / 1048576),
      database: store.db.prepare("PRAGMA quick_check").get(),
      checks,
      ...engine.snapshot(),
    };
    healthCache = { time: Date.now(), value };
    res.json(value);
  });
  const clients = new Set<express.Response>();
  app.get("/api/events", (req, res) => {
    if (clients.size >= 16) {
      res.status(429).end();
      return;
    }
    res.set({
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    clients.add(res);
    let lastWrite = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      if (Date.now() - lastWrite < 500) {
        if (!trailing)
          trailing = setTimeout(() => {
            trailing = undefined;
            send();
          }, 510);
        return;
      }
      lastWrite = Date.now();
      if (res.writableLength > 65536) {
        res.end();
        return;
      }
      res.write("data: " + JSON.stringify(engine.snapshot()) + "\n\n");
    };
    send();
    engine.on("change", send);
    const heartbeat = setInterval(() => {
      if (
        !store.db
          .prepare("SELECT hash FROM sessions WHERE hash=? AND expires>?")
          .get(digest(cookie(req)), Date.now())
      ) {
        res.end();
        return;
      }
      res.write(": keepalive\n\n");
      send();
    }, 15000);
    res.on("close", () => {
      clearInterval(heartbeat);
      clearTimeout(trailing);
      engine.off("change", send);
      clients.delete(res);
    });
  });
  app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));
  app.use(express.static(path.resolve("dist"), { index: false }));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.resolve("dist/index.html")),
  );
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const allowed =
        /^(Configure|Sync a|Enable at|Missing |Experimental adapter|Playback is|Playlist sync failed|Stop playback|Service is)/;
      res.status(err?.type === "entity.too.large" ? 413 : 400).json({
        error: allowed.test(err?.message)
          ? err.message
          : "Request failed; check settings and health diagnostics",
      });
    },
  );
  return {
    app,
    closeStreams: () => {
      for (const res of clients) res.end();
      void preview.close();
    },
  };
}
