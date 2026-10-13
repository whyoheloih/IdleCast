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
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { z } from "zod";
import { shuffleOrderError } from "./queue.js";
import type { Config } from "./config.js";
import { settingsSchema } from "./config.js";
import { Store } from "./db.js";
import { Engine } from "./engine.js";
import { buildHealth } from "./health.js";
import { OverlayPreview } from "./preview.js";
import { credentialStore } from "./credentials.js";
import { APP_VERSION } from "./version.js";
import { currentSchedule, previewSchedule, scheduleConstraints, type ScheduleMethod } from "./marathon-schedule.js";
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function createApp(c: Config, store: Store, engine: Engine) {
  const app = express();
  queueMicrotask(() => { void currentSchedule(store, engine).then((schedule) => {
    if (schedule?.validationErrors.some((error) => error.includes("boundary reconciliation"))) engine.event("Marathon queue boundary reconciliation failed during restart recovery", "error", { marathonId: schedule.marathon.id });
    else if (schedule?.marathon.status === "scheduled" && schedule.scheduleReached && !schedule.canActivate) engine.event("Recovered Marathon schedule is overdue; waiting for the fixed safe handoff boundary or source availability", "warn", { marathonId: schedule.marathon.id, scheduledStart: schedule.marathon.scheduledStart });
  }).catch(() => {}); });
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
  app.get("/api/ping", (_req, res) =>
    res.json({ application: "IdleCast", version: APP_VERSION }),
  );
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
    if (req.path === "/ping") {
      next();
      return;
    }
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
  app.get("/api/emergency-fallback", (_req, res) => res.json(engine.emergencyFallback.snapshot()));
  app.post("/api/emergency-fallback/rescan", async (_req, res, next) => {
    try { res.json(await engine.rescanEmergencyFallbacks()); }
    catch (error) { next(error); }
  });
  app.post("/api/emergency-fallback/open", async (_req, res, next) => {
    try {
      const directory = engine.emergencyFallback.directory;
      await mkdir(directory, { recursive: true });
      const explorer = spawn("explorer.exe", [directory], { detached: true, stdio: "ignore", windowsHide: true });
      explorer.unref();
      res.json({ ok: true, directory });
    } catch (error) { next(error); }
  });

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
      parsed.data.mediaSource !== previous.mediaSource ||
      parsed.data.localDirectory !== previous.localDirectory ||
      parsed.data.playlistId !== previous.playlistId ||
      parsed.data.sourceMode !== previous.sourceMode ||
      parsed.data.channelUrl !== previous.channelUrl ||
      parsed.data.shuffle !== previous.shuffle ||
      JSON.stringify(parsed.data.sources) !== JSON.stringify(previous.sources) ||
      JSON.stringify(parsed.data.filters) !== JSON.stringify(previous.filters) ||
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
  app.put("/api/playlist/order", (req, res) => {
    if (engine.syncing) {
      res.status(409).json({ error: "Wait for sync before reordering" });
      return;
    }
    const parsed = z
      .object({
        id: z.string().min(1).max(500),
        to: z.number().int().min(0).max(100000),
        confirmBufferChange: z.boolean().default(false),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid queue move" });
      return;
    }
    const preview = store.all();
    const from = preview.findIndex((item) => item.id === parsed.data.id);
    if (from < 0) {
      res.status(404).json({ error: "Queue item not found" });
      return;
    }
    const moving = preview[from];
    const controlling = store.controllingMarathon();
    const lockedByMarathon = controlling?.entries.some((entry) =>
      entry.sourceType === "local"
        ? !!moving.localIdentity && entry.localIdentity === moving.localIdentity
        : !!entry.youtubeVideoId && entry.youtubeVideoId === moving.videoId,
    );
    if (lockedByMarathon) {
      res.status(409).json({
        error: "This video belongs to the scheduled or active Marathon snapshot and cannot be reordered until the Marathon is cancelled or completed.",
      });
      return;
    }
    const block = moving.seriesKey
      ? preview.filter((item) => item.seriesKey === moving.seriesKey)
      : [moving];
    const lockedSeriesMember = block.find((item) => controlling?.entries.some((entry) =>
      entry.sourceType === "local"
        ? !!item.localIdentity && entry.localIdentity === item.localIdentity
        : !!entry.youtubeVideoId && entry.youtubeVideoId === item.videoId,
    ));
    if (lockedSeriesMember && lockedSeriesMember.id !== moving.id) {
      res.status(409).json({ error: "This series contains a scheduled or active Marathon video and cannot be reordered until the Marathon is cancelled or completed." });
      return;
    }
    const blockIds = new Set(block.map((item) => item.id));
    const remaining = preview.filter((item) => !blockIds.has(item.id));
    const target = Math.max(0, Math.min(parsed.data.to, remaining.length));
    remaining.splice(target, 0, ...block);
    const orderError = store.settings().shuffle
      ? shuffleOrderError(remaining)
      : null;
    if (orderError) {
      res.status(400).json({ error: orderError });
      return;
    }
    const plan = engine.queueChangePlan(remaining);
    if (
      engine.state !== "stopped" &&
      plan.changesBuffer &&
      !parsed.data.confirmBufferChange
    ) {
      res.status(409).json({
        error:
          "Changing this order will replace active buffered downloads. " +
          plan.removed.length +
          " cached video(s) may be deleted and " +
          plan.added.length +
          " replacement video(s) will download. The stream may show the loading screen if replacements are not ready. Continue?",
        requiresConfirmation: true,
        removed: plan.removed,
        added: plan.added,
      });
      return;
    }
    store.order(remaining.map((item) => item.id));
    if (store.settings().mediaSource === "local") {
      const currentOrder = remaining.map((item) => item.localIdentity).filter((value): value is string => !!value);
      const previousOrder = store.get<string[]>("localCatalogOrder", []);
      store.set("localCatalogOrder", [...currentOrder, ...previousOrder.filter((identity) => !currentOrder.includes(identity))]);
    }
    if (engine.state !== "stopped") engine.queueChanged();
    engine.event(
      block.length > 1
        ? "Series queue order updated"
        : "Queue order updated",
    );
    res.json({ ok: true, moved: block.length });
  });
  const scheduleInput = z.object({
    method: z.enum(["start", "end"]),
    localDateTime: z.string().min(16).max(19),
  }).strict();
  app.get("/api/marathon-schedule", async (_req, res) => {
    res.json(await currentSchedule(store, engine));
  });
  app.get("/api/marathons/:id/schedule/constraints", async (req, res) => {
    try { res.json(await scheduleConstraints(store, engine, req.params.id)); }
    catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : "Marathon not found" }); }
  });
  app.post("/api/marathons/:id/schedule/preview", async (req, res) => {
    const parsed = scheduleInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose Start Time or End Time and enter a Mountain Time date" });
    try { res.json(await previewSchedule(store, engine, req.params.id, parsed.data.method as ScheduleMethod, parsed.data.localDateTime)); }
    catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : "Marathon not found" }); }
  });
  app.put("/api/marathons/:id/schedule", async (req, res) => {
    const parsed = scheduleInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose Start Time or End Time and enter a Mountain Time date" });
    try {
      const preview = await previewSchedule(store, engine, req.params.id, parsed.data.method as ScheduleMethod, parsed.data.localDateTime);
      if (!preview.valid || preview.requestedTime === null || preview.calculatedStart === null || preview.calculatedEnd === null) {
        const message = preview.validationErrors.join("; ") || "Invalid Marathon schedule";
        const diagnosticMessage = message.includes("too early") ? `Marathon schedule requested too early — ${message}` : /snapshot is incomplete|source is unavailable/i.test(message) ? message : `Invalid or conflicting Marathon schedule — ${message}`;
        engine.event(diagnosticMessage, "warn", { marathonId: req.params.id });
        return res.status(400).json({ error: message, preview });
      }
      const scheduled = store.scheduleMarathon(req.params.id, parsed.data.method, preview.requestedTime, preview.calculatedStart, preview.calculatedEnd, preview.commitments);
      engine.event(`Marathon scheduled: ${scheduled.marathon.name}`, "info", { marathonId: req.params.id, method: parsed.data.method, scheduledStart: preview.calculatedStart, scheduledEnd: preview.calculatedEnd, queueBoundary: preview.boundaryEntryId });
      res.json({ schedule: scheduled, preview });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Marathon scheduling failed";
      engine.event(`Invalid or conflicting Marathon schedule — ${message}`, "warn", { marathonId: req.params.id });
      res.status(message.includes("Another Marathon") ? 409 : 400).json({ error: message });
    }
  });
  app.delete("/api/marathons/:id/schedule", (req, res) => {
    try {
      const marathon = store.cancelMarathonSchedule(req.params.id);
      engine.event(`Marathon schedule cancelled: ${marathon.marathon.name}`, "info", { marathonId: req.params.id });
      res.json(marathon);
    } catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : "Schedule cancellation failed" }); }
  });
  app.get("/api/marathon-history", (req, res) => {
    try {
      const requested = Number(req.query.limit ?? 100);
      res.json(store.marathonHistory(Number.isFinite(requested) ? Math.max(1, Math.min(200, requested)) : 100));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not read Marathon History";
      engine.event(`Marathon History persistence failure while listing records — ${message}`, "error");
      res.status(500).json({ error: "Could not read Marathon History" });
    }
  });
  app.get("/api/marathon-history/:id", (req, res) => {
    try {
      const record = store.marathon(req.params.id);
      if (!record || !["completed", "ended_early", "failed", "cancelled"].includes(record.marathon.status))
        return res.status(404).json({ error: "Marathon history record not found" });
      res.json({
        ...record,
        unplayedEntries: Math.max(0, record.marathon.totalEntries - record.marathon.completedEntries - record.marathon.failedEntries),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not read Marathon History";
      engine.event(`Marathon History persistence failure while reading details — ${message}`, "error", { marathonId: req.params.id });
      res.status(500).json({ error: "Could not read Marathon History" });
    }
  });
  app.post("/api/marathons/:id/end", async (req, res) => {
    try {
      const record = await engine.endMarathon(req.params.id);
      res.json(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not end Marathon";
      if (/sqlite|database/i.test(message))
        engine.event(`Marathon History persistence failure while requesting End Marathon — ${message}`, "error", { marathonId: req.params.id });
      res.status(/not found/i.test(message) ? 404 : 409).json({ error: message });
    }
  });
  app.get("/api/marathons", (_req, res) => res.json(store.marathons()));
  app.get("/api/marathons/:id", (req, res) => {
    const marathon = store.marathon(req.params.id);
    if (!marathon) return res.status(404).json({ error: "Marathon not found" });
    res.json(marathon);
  });
  app.post("/api/marathons", (req, res) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(100) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter a Marathon name" });
    const settings = store.settings();
    const items = store.all();
    if (!items.length) return res.status(400).json({ error: "Sync media before creating a Marathon snapshot" });
    const sourceIdentity = settings.mediaSource === "local"
      ? createHash("sha256").update(path.resolve(settings.localDirectory).toLocaleLowerCase()).digest("hex").slice(0, 32)
      : createHash("sha256").update(JSON.stringify(settings.sources.length ? settings.sources : [{ kind: settings.sourceMode, value: settings.sourceMode === "channel" ? settings.channelUrl : settings.playlistId }])).digest("hex").slice(0, 32);
    const boundary = store.get<{ id: string } | null>("cursor", null)?.id ?? null;
    const sourceLabel = settings.mediaSource === "local"
      ? settings.localDirectory || "Local media collection"
      : settings.sources.map((source) => source.value).filter(Boolean).join(" + ") ||
        (settings.sourceMode === "channel" ? settings.channelUrl : settings.playlistId) ||
        "YouTube collection";
    res.status(201).json(store.createMarathon(parsed.data.name, settings.mediaSource === "local" ? "local" : "youtube", sourceIdentity, items, boundary, sourceLabel));
  });
  app.post("/api/sync", async (_req, res) => {
    await engine.sync();
    res.json({ ok: true });
  });
  app.post("/api/start", async (_req, res) => {
    await engine.start();
    res.json({ ok: true });
  });
  app.post("/api/stop", async (req, res) => {
    const body = z
      .object({ preserveDesired: z.boolean().optional() })
      .parse(req.body ?? {});
    await engine.stop(body.preserveDesired ?? false);
    res.json({ ok: true });
  });
  app.post("/api/skip", (_req, res) => {
    engine.skip();
    res.json({ ok: true });
  });
  app.get("/api/logs", (_req, res) => res.json(store.logs()));
  app.get("/api/history", (req, res) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).strict().safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid history limit" });
      return;
    }
    res.json(store.playbackHistory(parsed.data.limit));
  });
  let healthCache: { time: number; value: unknown } | null = null;
  app.get("/api/health", async (_req, res) => {
    if (healthCache && Date.now() - healthCache.time < 15000) {
      res.json(healthCache.value);
      return;
    }
    const value = await buildHealth(c, store, engine);
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
  const applicationRoot = path.resolve(process.env.IDLECAST_APP_ROOT ?? ".");
  app.use(
    express.static(path.join(applicationRoot, "dist"), { index: false }),
  );
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(applicationRoot, "dist", "index.html")),
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
    closeStreams: async () => {
      for (const res of clients) res.end();
      await preview.close();
    },
  };
}
