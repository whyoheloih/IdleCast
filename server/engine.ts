import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Config, Settings } from "./config.js";
import { Store, type MarathonEntry, type StoredItem } from "./db.js";
import {
  YouTubePlaylistProvider,
  LocalMediaSource,
  ExperimentalYouTubeSource,
  RtmpOutput,
  type PlaylistProvider,
  type MediaSourceProvider,
  type StreamOutputProvider,
  type DownloadActivity,
} from "./providers.js";
import {
  launch,
  completion,
  runCapture,
  delay,
  backoff,
  mediaFailure,
} from "./process.js";
import {
  prepareQueue,
  isLongVideo,
  canStartShuffledQueue,
  needsLongDownloadLead,
  DOWNLOAD_LEAD_SECONDS,
  LONG_VIDEO_SECONDS,
} from "./queue.js";
import { playlistId as parsePlaylistId } from "./config.js";
import { diagnosticForMessage, sanitizeDiagnosticRuntime } from "./diagnostics.js";
import { LocalFolderPlaylistProvider, type KnownYouTubeMetadata } from "./local-media.js";
import { overlay, overlayLayout } from "./overlay.js";
import {
  audioSampleRate,
  encodeArgs,
  standby,
  writeLoadingItem,
  writeLoadingStatus,
} from "./encoder.js";
export function countsTowardFailureHistory(message: string) {
  return !/account verification|rate limit|media disk is full|required media executable|executable path|download stalled|media operation timed out|cache storage is unavailable|local media folder unavailable|external drive disconnected|local media file missing/i.test(
    message,
  );
}

export function pausesDownloadQueue(message: string) {
  return /account verification|rate limit|media disk is full|required media executable|executable path|cache storage is unavailable|local media folder unavailable|external drive disconnected|local media file missing/i.test(
    message,
  );
}

export type OutputState = {
  status:
    | "disabled"
    | "buffering"
    | "connecting"
    | "sending"
    | "retrying"
    | "stopped";
  retries: number;
};
export type EngineDependencies = {
  playlist?: PlaylistProvider;
  source?: MediaSourceProvider;
  outputs?: Partial<Record<"youtube" | "twitch", StreamOutputProvider>>;
};
type PreparationOwner = "normal" | "marathon" | "normal-handoff";
type PreparedMedia = {
  file: string;
  info: any;
  size: number;
  owner?: PreparationOwner;
  logicalId?: string;
  videoId?: string;
};
type NormalHandoffPlan = {
  marathonId: string;
  entryIds: string[];
  createdAt: number;
};
export class Engine extends EventEmitter {
  state = "stopped";
  current: StoredItem | null = null;
  elapsed = 0;
  syncing = false;
  outputs: Record<string, OutputState> = {
    youtube: { status: "disabled", retries: 0 },
    twitch: { status: "disabled", retries: 0 },
  };
  private controller: AbortController | null = null;
  private clip: AbortController | null = null;
  private task: Promise<void> | null = null;
  private syncTask: Promise<void> | null = null;
  private syncAbort = new AbortController();
  private resyncTimer: ReturnType<typeof setInterval>;
  private skipRequested = false;
  private closed = false;
  private currentMedia: { file: string; duration: number } | null = null;
  private download: DownloadActivity | null = null;
  private bufferedIds = new Set<string>();
  private preparedMedia = new Map<string, PreparedMedia>();
  private downloadStates = new Map<string, DownloadActivity>();
  private cachedSizes = new Map<string, number>();
  private refillTask: Promise<void> | null = null;
  private ownedRefillPending = false;
  private readonly bufferLimit = 5;
  private readonly startupBufferTarget = 3;
  private bufferedCount = 0;
  private bufferTarget = 3;
  private activeSource: MediaSourceProvider | null = null;
  private queueRefreshPending = false;
  private activationGeneration = 0;
  private transitionGeneration = 0;
  private metadataTimer: ReturnType<typeof setTimeout> | null = null;
  private marathonHandoffPending = false;
  private marathonHandoffReported = false;
  previewSource() {
    if (this.state !== "playing" || !this.currentMedia || !this.clip)
      return null;
    return {
      file: this.currentMedia.file,
      offset: Math.max(
        0,
        Math.min(this.elapsed, this.currentMedia.duration - 0.1),
      ),
      signal: this.clip.signal,
      title: this.current?.title,
      publishedAt: this.current
        ? this.store.get<Record<string, string>>("uploadDates", {})[
            this.current.videoId
          ]
        : "",
      duration: this.currentMedia.duration,
    };
  }
  playlist: PlaylistProvider;
  constructor(
    public store: Store,
    public config: Config,
    private dependencies: EngineDependencies = {},
  ) {
    super();
    this.playlist =
      dependencies.playlist ??
      new YouTubePlaylistProvider(config.YOUTUBE_API_KEY);
    try {
      const cache = path.join(config.DATA_DIR, "cache");
      for (const name of readdirSync(cache)) {
        const match = name.match(/^([A-Za-z0-9_-]{11})\.\d+p\d+\.(?:mp4|mkv|webm)$/);
        if (match)
          this.cachedSizes.set(
            match[1],
            (this.cachedSizes.get(match[1]) ?? 0) + statSync(path.join(cache, name)).size,
          );
      }
    } catch {}
    this.resyncTimer = setInterval(() => {
      const s = store.settings();
      if (
        (s.mediaSource === "local" ? !!s.localDirectory :
          (s.sources.length || (s.sourceMode === "channel" ? s.channelUrl : s.playlistId))) &&
        Date.now() - store.get("lastSync", 0) > s.resyncMinutes * 60000
      )
        void this.sync().catch(() => {});
    }, 60000);
  }
  event(message?: string, level = "info", runtime: Record<string, unknown> = {}) {
    if (message) {
      this.store.log(level, message);
      const code = diagnosticForMessage(message);
      if (code)
        this.store.recordDiagnostic({
          code,
          timestamp: Date.now(),
          observed: String(sanitizeDiagnosticRuntime(message)).slice(0, 1000),
          runtime: sanitizeDiagnosticRuntime({
            state: this.state,
            videoId: this.current?.videoId,
            videoTitle: this.current?.title,
            downloadAttempt: this.download?.attempt,
            outputStates: this.outputs,
            ...runtime,
          }) as Record<string, unknown>,
        });
    }
    this.emit("change");
  }
  private downloadQueue() {
    const items = this.store.all();
    const currentId = this.current?.videoId;
    const active = this.download;
    const visible = items.filter((item) =>
      item.videoId === currentId ||
      this.bufferedIds.has(item.videoId) ||
      this.downloadStates.has(item.videoId) ||
      this.cachedSizes.has(item.videoId),
    );
    const entries = visible.map((item) => {
      const prepared = this.preparedMedia.get(item.videoId);
      const activity = this.downloadStates.get(item.videoId);
      return {
        id: item.id,
        videoId: item.videoId,
        position: item.position,
        title: item.title,
        thumbnail: item.thumbnail,
        seriesKey: item.seriesKey,
        seriesIndex: item.seriesIndex,
        current: item.videoId === currentId,
        status: activity?.status ?? (prepared || this.cachedSizes.has(item.videoId) ? "downloaded" : "queued"),
        percent: activity?.percent ?? (prepared || this.cachedSizes.has(item.videoId) ? 100 : 0),
        attempt: activity?.attempt ?? 0,
        bytes: prepared?.size ?? activity?.bytes ?? this.cachedSizes.get(item.videoId) ?? 0,
        error: activity?.error ?? item.error,
      };
    }).sort((a, b) => Number(b.current) - Number(a.current) || a.position - b.position);
    return {
      entries,
      totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      active,
    };
  }
  snapshot() {
    return {
      state: this.state,
      current: this.current
        ? {
            ...this.current,
            publishedAt: this.store.get<Record<string, string>>(
              "uploadDates",
              {},
            )[this.current.videoId],
          }
        : null,
      elapsed: this.elapsed,
      outputs: this.outputs,
      syncing: this.syncing,
      count: this.store.count(),
      lastSync: this.store.get("lastSync", 0),
      desired: this.store.get("desired", false),
      excluded: this.store.get("excludedCount", 0),
      download: this.download,
      filterStats: this.store.get("filterStats", {
        reasons: {},
        detectedSeries: 0,
      }),
      bufferedCount: this.bufferedCount,
      bufferTarget: this.bufferTarget,
      downloadQueue: this.downloadQueue(),
      marathonSchedule: this.store.controllingMarathon()?.marathon ?? null,
    };
  }
  marathonHandoffConstraints() {
    const now = Date.now();
    const commitments: Array<{ entryId: string; title: string; remainingSeconds: number }> = [];
    if (this.state === "preparing")
      return { safe: false, earliestStart: null, commitments, reason: "A normal-video transition is already being prepared; retry scheduling after it becomes active" };
    const activeNormal = ["playing", "recovering"].includes(this.state) && this.current;
    if (activeNormal) {
      const duration = Number(this.currentMedia?.duration ?? activeNormal.duration);
      if (!Number.isFinite(duration) || duration <= 0)
        return { safe: false, earliestStart: null, commitments, reason: "The current video's remaining duration is unknown; scheduling cannot safely interrupt it" };
      commitments.push({
        entryId: activeNormal.id,
        title: activeNormal.title,
        remainingSeconds: Math.max(0, duration - Math.max(0, this.elapsed)),
      });
    }
    const committedSeconds = commitments.reduce((sum, entry) => sum + entry.remainingSeconds, 0);
    return {
      safe: true,
      earliestStart: now + (committedSeconds + 5 * 60) * 1000,
      commitments,
      reason: null,
    };
  }
  sync(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Service is shutting down"));
    if (this.syncTask) return this.syncTask;
    const settings = this.store.settings();
    const localMode = settings.mediaSource === "local";
    const id = settings.sourceMode === "channel" ? settings.channelUrl : settings.playlistId;
    if (localMode ? !settings.localDirectory.trim() : (!id && !settings.sources.length))
      return Promise.reject(new Error(localMode ? "Choose a local media folder first" : "Configure a playlist or channel first"));
    this.syncing = true;
    this.event();
    this.syncTask = (async () => {
      try {
        let fetched: StoredItem[];
        if (localMode) {
          const provider = new LocalFolderPlaylistProvider(
            settings.localDirectory,
            this.config.FFPROBE_PATH,
            this.store.get<string[]>("localCatalogOrder", []),
            this.store.get<KnownYouTubeMetadata>("youtubeMetadata", {}),
          );
          fetched = await provider.fetch(settings.localDirectory, this.syncAbort.signal) as StoredItem[];
          this.store.set("localCatalogOrder", provider.catalogOrder);
          for (const issue of provider.issues)
            this.event(issue.message, "warn", { localPath: issue.file });
        } else {
          const provider = this.dependencies.playlist ?? new YouTubePlaylistProvider(this.config.YOUTUBE_API_KEY);
          const sources = settings.sources.length ? settings.sources : [{ kind: settings.sourceMode, value: id }];
          const unique = new Map<string, StoredItem>();
          for (const source of sources) {
            const playlistId = source.kind === "channel"
              ? await new YouTubePlaylistProvider(this.config.YOUTUBE_API_KEY).channelUploads(source.value, this.syncAbort.signal)
              : parsePlaylistId(source.value);
            for (const item of await provider.fetch(playlistId, this.syncAbort.signal))
              if (!unique.has(item.videoId)) unique.set(item.videoId, { ...item, sourceType: "youtube", youtubeVideoId: item.videoId } as StoredItem);
          }
          fetched = [...unique.values()];
          const known = this.store.get<KnownYouTubeMetadata>("youtubeMetadata", {});
          for (const item of fetched) known[item.videoId] = { title: item.title, channel: item.channel, thumbnail: item.thumbnail, publishedAt: item.publishedAt ?? "", duration: item.duration };
          this.store.set("youtubeMetadata", known);
        }
        const failureHistory = this.store.get<Record<string, number>>("failureHistory", {});
        const existingFailures = new Map(this.store.all().map((item) => [item.videoId, item.failures] as const));
        const playCounts = this.store.get<Record<string, number>>("playCounts", {});
        const selectionPenalties = this.store.get<Record<string, number>>("selectionPenalties", {});
        for (const item of fetched) {
          item.failureCount = failureHistory[item.videoId] ?? existingFailures.get(item.videoId) ?? 0;
          item.playCount = playCounts[item.videoId] ?? 0;
          item.selectionPenalty = selectionPenalties[item.videoId] ?? 0;
        }
        const queue = prepareQueue(fetched, settings);
        this.store.replace(queue.items);
        if (settings.shuffle) {
          this.store.set("cursor", null);
          this.store.set("shuffleNeedsShortStart", true);
          this.store.set("shuffleShortStartsRemaining", 2);
          this.store.set("lastVideoDuration", null);
        }
        this.store.set("uploadDates", Object.fromEntries(fetched.map((item) => [item.videoId, item.publishedAt ?? ""])));
        this.store.set("excludedCount", queue.excluded);
        this.store.set("selectionPenalties", queue.penalties);
        this.store.set("filterStats", { reasons: queue.reasons, detectedSeries: queue.detectedSeries });
        this.event(`${localMode ? "Local folder scanned" : "Playlist synchronized"}: ${queue.items.length} items; ${queue.excluded} excluded; ${queue.detectedSeries} series detected`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Unknown synchronization error";
        this.event(`${localMode ? "Local catalog scan" : "Playlist sync"} failed; previous snapshot preserved — ${detail}`, "error");
        throw new Error(`${localMode ? "Local catalog scan" : "Playlist sync"} failed — ${detail}`);
      } finally {
        this.syncing = false;
        this.syncTask = null;
        this.event();
      }
    })();
    return this.syncTask;
  }
  async start() {
    if (this.closed) throw new Error("Service is shutting down");
    if (this.task) return;
    const s = this.store.settings();
    if (!this.store.count())
      throw new Error(s.mediaSource === "local" ? "Scan a nonempty local media folder before starting" : "Sync a nonempty playlist before starting");
    if (!s.youtube.enabled && !s.twitch.enabled)
      throw new Error("Enable at least one destination");
    for (const name of ["youtube", "twitch"] as const)
      if (
        s[name].enabled &&
        !this.dependencies.outputs?.[name] &&
        !this.config[
          name === "youtube" ? "YOUTUBE_STREAM_KEY" : "TWITCH_STREAM_KEY"
        ]
      )
        throw new Error("Missing " + name + " stream key");
    if (
      s.mediaSource === "youtube-experimental" &&
      !this.config.EXPERIMENTAL_YOUTUBE
    )
      throw new Error(
        "Experimental adapter must be explicitly enabled in the environment",
      );
    this.store.set("desired", true);
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const source = this.source(s);
    this.activeSource = source;
    let workers: Promise<void>[] = [];
    this.bufferedIds.clear();
    this.preparedMedia.clear();
    this.bufferedCount = 0;
    const controllingMarathon = this.store.controllingMarathon()?.marathon;
    const completedCommitments = controllingMarathon
      ? this.store.completedQueueEntriesSince(controllingMarathon.scheduleUpdatedAt ?? controllingMarathon.createdAt)
      : new Set<string>();
    const marathonOwnsStartup = Boolean(controllingMarathon?.status === "active" || (
      controllingMarathon?.status === "scheduled" &&
      controllingMarathon.scheduledStart !== null &&
      Date.now() >= controllingMarathon.scheduledStart &&
      controllingMarathon.committedQueue.every((entry) => completedCommitments.has(entry.entryId))
    ));
    const handoffOwnsStartup = !!this.normalHandoffPlan();
    const initial = this.bufferCandidates(this.store.all());
    this.bufferTarget = marathonOwnsStartup || handoffOwnsStartup ? 0 : Math.min(this.startupBufferTarget, initial.length);
    for (const item of initial.slice(0, this.bufferTarget))
      if (!this.cachedSizes.has(item.videoId))
        this.downloadStates.set(item.videoId, {
          videoId: item.videoId, title: item.title, thumbnail: item.thumbnail,
          percent: 0, status: "queued", attempt: 0,
        });
    for (const name of ["youtube", "twitch"] as const)
      this.outputs[name] = {
        status: s[name].enabled ? "buffering" : "disabled",
        retries: 0,
      };
    this.state = "buffering";
    this.event(marathonOwnsStartup ? "Playback requested; restoring Marathon through the existing transition pipeline" : handoffOwnsStartup ? "Playback requested; restoring the prepared normal handoff queue" : "Playback requested; preparing startup buffer");
    this.task = (async () => {
      while (!signal.aborted && this.bufferedIds.size < this.bufferTarget) {
        await this.fillBuffer(
          source,
          this.store.all(),
          signal,
          this.bufferTarget,
        );
        // Permanently failed/retry-delayed items cannot hold startup at 3/3
        // forever. Start once every currently eligible finite item is ready.
        const eligibleNow = this.bufferCandidates(this.store.all()).length;
        this.bufferTarget = Math.min(
          this.bufferTarget,
          Math.max(this.bufferedIds.size, eligibleNow),
        );
        if (this.bufferedIds.size < this.bufferTarget) {
          this.event(
            "Startup buffer " +
              this.bufferedIds.size +
              "/" +
              this.bufferTarget +
              "; retrying unavailable downloads",
            "warn",
          );
          await delay(5000, signal);
        }
      }
      signal.throwIfAborted();
      this.state = "starting";
      for (const name of ["youtube", "twitch"] as const)
        this.outputs[name] = {
          status: s[name].enabled ? "connecting" : "disabled",
          retries: 0,
        };
      this.event(
        "Startup buffer ready: " +
          this.bufferedIds.size +
          "/" +
          this.bufferTarget +
          " videos",
      );
      this.bufferTarget = Math.min(
        this.bufferLimit,
        this.bufferCandidates(this.store.all()).length,
      );
      workers = (["youtube", "twitch"] as const).map((name, n) =>
        s[name].enabled
          ? this.output(name, s, this.config.UDP_BASE_PORT + n, signal)
          : Promise.resolve(),
      );
      const epoch = Date.now();
      let supervisorFailures = 0;
      while (!signal.aborted) {
        try {
          await this.play(s, signal, source, epoch);
          if (!signal.aborted)
            throw new Error("Playback loop ended unexpectedly");
        } catch (error) {
          if (signal.aborted) break;
          supervisorFailures += 1;
          this.clip?.abort();
          this.clip = null;
          this.currentMedia = null;
          this.state = "recovering";
          const wait = backoff(supervisorFailures - 1);
          this.event(
            `Playback supervisor recovered an unexpected failure while ${this.current?.title ?? "no video"} was active: ${error instanceof Error ? error.message : "unknown error"}. Retrying in ${Math.ceil(wait / 1000)} seconds`,
            "error",
          );
          const idle = standby(this.config, s, epoch, signal, () =>
            this.event("Recovery standby encoder failed; retrying", "error"),
          );
          try {
            await delay(wait, signal);
          } finally {
            await idle.stop();
          }
        }
      }
    })()
      .catch((error) => {
        if (!signal.aborted)
          this.event(
            "Playback startup failed: " +
              (error instanceof Error ? error.message : "unknown error"),
            "error",
          );
      })
      .finally(async () => {
        this.controller?.abort();
        await source.close?.();
        this.activeSource = null;
        await Promise.allSettled(workers);
        this.state = "stopped";
        this.current = null;
        this.download = null;
        this.bufferedIds.clear();
        this.preparedMedia.clear();
        this.bufferedCount = 0;
        this.task = null;
        this.controller = null;
        this.event();
      });
  }
  async stop(preserveDesired = false) {
    if (!preserveDesired) this.store.set("desired", false);
    this.controller?.abort();
    await this.task;
    this.state = "stopped";
    this.event("Playback stopped");
  }
  skip() {
    if (!this.task) throw new Error("Playback is stopped");
    this.skipRequested = true;
    this.clip?.abort();
  }
  private async output(
    name: "youtube" | "twitch",
    s: Settings,
    port: number,
    signal: AbortSignal,
  ) {
    const provider =
      this.dependencies.outputs?.[name] ??
      new RtmpOutput(
        name,
        this.config[
          name === "youtube" ? "YOUTUBE_STREAM_KEY" : "TWITCH_STREAM_KEY"
        ],
      );
    let attempt = 0;
    while (!signal.aborted) {
      this.outputs[name] = {
        status: attempt ? "retrying" : "connecting",
        retries: attempt,
      };
      this.event();
      try {
        const worker = new AbortController();
        const child = launch(
          this.config.FFMPEG_PATH,
          ["-progress", "pipe:1", ...provider.args(s, port)],
          AbortSignal.any([signal, worker.signal]),
        );
        const started = Date.now();
        let lastProgress = started,
          lastFrame = -1,
          buffer = "",
          lastTransportWarning = 0;
        child.stderr?.on("data", (chunk) => {
          if (
            /overrun|circular buffer|non-monoton|discontinu|drop/i.test(
              String(chunk),
            ) &&
            Date.now() - lastTransportWarning > 300000
          ) {
            lastTransportWarning = Date.now();
            const diagnostic = String(chunk);
            const reason = /non-monoton|discontinu/i.test(diagnostic)
              ? "timestamp discontinuity"
              : /overrun|circular buffer/i.test(diagnostic)
                ? "UDP buffer overrun"
                : /drop/i.test(diagnostic)
                  ? "dropped packet/frame"
                  : "transport interruption";
            this.event(
              `${name} transport warning: ${reason}; output recovery is monitoring the connection`,
              "warn",
            );
          }
        });
        const watchdog = setInterval(() => {
          if (Date.now() - lastProgress > 30000) worker.abort();
        }, 5000);
        child.stdout?.on("data", (buf) => {
          buffer += String(buf);
          let at;
          while ((at = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, at).trim();
            buffer = buffer.slice(at + 1);
            if (line.startsWith("frame=")) {
              const frame = Number(line.slice(6));
              if (frame > 0 && frame > lastFrame) {
                lastFrame = frame;
                lastProgress = Date.now();
                const recovered = this.outputs[name].status !== "sending";
                this.outputs[name].status = "sending";
                if (recovered) {
                  const successes = this.store.get<Record<string, number>>("health.lastOutputSuccess", {});
                  successes[name] = Date.now();
                  this.store.set("health.lastOutputSuccess", successes);
                }
                if (recovered && attempt > 0)
                  this.event(`${name} output recovered and is sending again`);
                else this.event();
              }
            }
          }
        });
        let code: number;
        try {
          code = await completion(child);
        } finally {
          clearInterval(watchdog);
        }
        if (signal.aborted) break;
        // A worker that stayed healthy for a minute is not part of the prior
        // failure streak. Reset before handling its eventual disconnect so a
        // normal transition/socket reset reconnects after one second instead
        // of inheriting an old maximum backoff forever.
        if (Date.now() - started > 60000) attempt = 0;
        if (code !== 0) {
          const signedCode =
            process.platform === "win32" && code > 0x7fffffff
              ? code - 0x100000000
              : code;
          throw new Error(
            `${name} FFmpeg exited with code ${signedCode}: ${
              signedCode === -10053
                ? "RTMP socket was aborted during the source transition"
                : mediaFailure(child)
            }`,
          );
        }
      } catch (error) {
        if (signal.aborted) break;
        this.event(
          `${name} output process failed: ${error instanceof Error ? error.message : "unknown error"}`,
          "error",
        );
      }
      this.outputs[name] = { status: "retrying", retries: ++attempt };
      const wait = backoff(attempt - 1);
      this.event(
        `${name} output disconnected; automatic recovery attempt ${attempt} in ${Math.ceil(wait / 1000)} seconds`,
        "warn",
      );
      try {
        await delay(wait, signal);
      } catch {
        break;
      }
    }
    this.outputs[name].status = "stopped";
  }
  private source(s: Settings): MediaSourceProvider {
    return (
      this.dependencies.source ??
      (s.mediaSource === "local"
        ? new LocalMediaSource(s.localDirectory)
        : new ExperimentalYouTubeSource(this.config, undefined, s, {
            onDownload: (download) => {
              this.download = download;
              if (download) {
                this.downloadStates.set(download.videoId, download);
                if (download.status === "downloaded") {
                  this.store.set("health.lastDownloadSuccess", { time: Date.now(), videoId: download.videoId, title: download.title });
                  this.store.set("health.consecutiveDownloadFailures", 0);
                } else if (download.status === "failed") {
                  this.store.set("health.lastDownloadFailure", { time: Date.now(), videoId: download.videoId, title: download.title, error: download.error, attempt: download.attempt });
                  this.store.set("health.consecutiveDownloadFailures", this.store.get("health.consecutiveDownloadFailures", 0) + 1);
                }
              }
              void writeLoadingStatus(
                this.config,
                download,
              ).catch(() => {});
              if (download?.status === "retrying")
                this.event(
                  "Retrying download (attempt " + download.attempt + "/3): " + download.title,
                  "warn",
                );
              else if (download?.status === "failed")
                this.event("Download failed after " + download.attempt + (download.attempt === 1 ? " attempt: " : " attempts: ") + download.title + " — " + (download.error ?? "unknown error"), "warn");
              else this.event();
            },
            onDelete: (filename) => {
              const id = filename.split(".")[0];
              this.downloadStates.delete(id);
              this.cachedSizes.delete(id);
              this.event("Cache deleted: " + filename);
            },
          }))
    );
  }
  private bufferCandidates(items: StoredItem[], startIndex?: number) {
    if (!items.length) return [];
    const saved = this.store.get<{ id: string; offset: number } | null>(
      "cursor",
      null,
    );
    const start =
      startIndex ??
      Math.max(
        0,
        items.findIndex((item) => item.id === saved?.id),
      );
    const seen = new Set<string>();
    return Array.from(
      { length: items.length },
      (_, offset) => items[(start + offset) % items.length],
    ).filter((item) => {
      if (
        !item.available ||
        item.retryAt > Date.now() ||
        seen.has(item.videoId)
      )
        return false;
      seen.add(item.videoId);
      return true;
    });
  }

  private async probeMedia(file: string, signal: AbortSignal) {
    const info = JSON.parse(
      await runCapture(
        this.config.FFPROBE_PATH,
        [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,codec_name,sample_rate,channels:format=duration",
          "-of",
          "json",
          file,
        ],
        signal,
      ),
    );
    if (!info.streams?.some((stream: any) => stream.codec_type === "video"))
      throw new Error("No playable video stream");
    const duration = Number(info.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("Media must have a finite duration");
    return info;
  }

  private async fillBuffer(
    source: MediaSourceProvider,
    items: StoredItem[],
    signal: AbortSignal,
    target = this.bufferLimit,
    startIndex?: number,
  ) {
    const candidates = this.bufferCandidates(items, startIndex);
    const wanted = Math.min(target, candidates.length);
    for (const item of candidates.slice(0, wanted))
      if (!this.bufferedIds.has(item.videoId) && !this.cachedSizes.has(item.videoId) && !this.downloadStates.has(item.videoId))
        this.downloadStates.set(item.videoId, {
          videoId: item.videoId, title: item.title, thumbnail: item.thumbnail,
          percent: 0, status: "queued", attempt: 0,
        });
    source.retain?.([
      ...this.bufferedIds,
      ...candidates.slice(0, wanted).map((item) => item.videoId),
    ]);
    for (const item of candidates) {
      if (this.bufferedIds.size >= wanted) break;
      if (this.bufferedIds.has(item.videoId)) continue;
      signal.throwIfAborted();
      this.current = this.state === "buffering" ? item : this.current;
      await writeLoadingItem(this.config, item).catch(() => {});
      this.event(
        "Buffering " +
          (this.bufferedIds.size + 1) +
          "/" +
          wanted +
          ": " +
          item.title,
      );
      try {
        const file = await source.resolve(item, signal);
        let info;
        try {
          info = await this.probeMedia(file, signal);
        } catch (error) {
          // Never reopen the same corrupt or truncated cache entry forever.
          await source.remove?.(item.videoId).catch((cleanupError) =>
            this.event(`Cache cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : "unknown error"}`, "warn", { videoId: item.videoId }),
          );
          throw error;
        }
        const size = (await stat(file)).size;
        this.preparedMedia.set(item.videoId, { file, info, size, owner: "normal", logicalId: item.id, videoId: item.videoId });
        this.cachedSizes.set(item.videoId, size);
        this.downloadStates.set(item.videoId, {
          videoId: item.videoId,
          title: item.title,
          thumbnail: item.thumbnail,
          percent: 100,
          status: "downloaded",
          attempt: this.downloadStates.get(item.videoId)?.attempt ?? 1,
          bytes: size,
        });
        this.bufferedIds.add(item.videoId);
        this.bufferedCount = this.bufferedIds.size;
        this.download = null;
        this.event();
      } catch (error) {
        if (signal.aborted) throw error;
        const message =
          error instanceof Error ? error.message : "Media download failed";
        this.recordFailure(item, message);
        this.event(
          "Media failed while buffering: " +
            item.title +
            " \u2014 " +
            message,
          "warn",
        );
        if (pausesDownloadQueue(message)) {
          this.event(
            "Buffer refill paused because the downloader needs attention; IdleCast will retry without cycling through every video",
            "warn",
          );
          break;
        }
      }
    }
    source.retain?.([...this.bufferedIds]);
  }

  private finishRefill(source: MediaSourceProvider, signal: AbortSignal) {
    this.refillTask = null;
    if (!this.ownedRefillPending || signal.aborted) return;
    this.ownedRefillPending = false;
    this.scheduleOwnedRefill(source, signal);
  }

  private scheduleRefill(
    source: MediaSourceProvider,
    items: StoredItem[],
    signal: AbortSignal,
    startIndex: number,
  ) {
    if (this.refillTask) return;
    this.refillTask = this.fillBuffer(
      source,
      items,
      signal,
      this.bufferLimit,
      startIndex,
    )
      .catch(() => {})
      .finally(() => this.finishRefill(source, signal));
  }

  private normalHandoffPlan() {
    const plan = this.store.get<NormalHandoffPlan | null>("marathonNormalHandoff", null);
    return plan && Array.isArray(plan.entryIds) && plan.entryIds.length ? plan : null;
  }

  private ensureNormalHandoffPlan(marathonId: string, items: StoredItem[]) {
    const existing = this.normalHandoffPlan();
    if (existing?.marathonId === marathonId) return existing;
    const entryIds = this.bufferCandidates(items).slice(0, this.bufferLimit).map((item) => item.id);
    const plan: NormalHandoffPlan = { marathonId, entryIds, createdAt: Date.now() };
    this.store.set("marathonNormalHandoff", plan);
    if (!entryIds.length)
      this.event("Normal handoff preload delayed: no eligible normal videos are available", "warn", { marathonId });
    else
      this.event(`Normal handoff queue locked for ${entryIds.length} video${entryIds.length === 1 ? "" : "s"}`, "info", { marathonId });
    return entryIds.length ? plan : null;
  }

  private normalHandoffChoice(items: StoredItem[]) {
    const plan = this.normalHandoffPlan();
    if (!plan) return null;
    const item = items.find((candidate) => candidate.id === plan.entryIds[0]);
    return item
      ? { item, index: items.indexOf(item), blocked: null, waitMs: 0, blockedLevel: "info" as const, handoff: true }
      : { item: null, index: 0, blocked: "Normal handoff waiting for its intended media entry to become available", waitMs: 60000, blockedLevel: "warn" as const, handoff: true };
  }

  private advanceNormalHandoff(entryId: string) {
    const plan = this.normalHandoffPlan();
    if (!plan || plan.entryIds[0] !== entryId) return false;
    const entryIds = plan.entryIds.slice(1);
    this.store.set("marathonNormalHandoff", entryIds.length ? { ...plan, entryIds } : null);
    return true;
  }

  private retainedVideoIds(extra: string[] = []) {
    return [...new Set([
      ...this.bufferedIds,
      ...[...this.preparedMedia.values()].map((prepared) => prepared.videoId).filter((id): id is string => !!id),
      ...extra,
    ])];
  }

  private async prepareOwnedMedia(
    source: MediaSourceProvider,
    item: StoredItem,
    key: string,
    owner: PreparationOwner,
    signal: AbortSignal,
    stillWanted: () => boolean,
  ) {
    const existing = this.preparedMedia.get(key);
    if (existing) {
      try {
        await stat(existing.file);
        existing.owner = owner;
        return existing;
      } catch {
        this.preparedMedia.delete(key);
        this.event(`Prepared media unavailable; re-preparing ${item.title}`, "warn", { entryId: key, videoId: item.videoId });
      }
    }
    const shared = [...this.preparedMedia.values()].find((prepared) => prepared.videoId === item.videoId);
    if (shared) {
      try {
        await stat(shared.file);
        const prepared = { ...shared, owner, logicalId: key, videoId: item.videoId };
        const wanted = stillWanted();
        if (wanted) this.preparedMedia.set(key, prepared);
        return wanted ? prepared : null;
      } catch {
        this.event(`Prepared media unavailable; re-preparing ${item.title}`, "warn", { entryId: key, videoId: item.videoId });
      }
    }
    const file = await source.resolve(item, signal);
    const info = await this.probeMedia(file, signal);
    const size = (await stat(file)).size;
    if (!stillWanted()) {
      this.event("Stale Marathon refill result ignored", "warn", { entryId: key, videoId: item.videoId });
      return null;
    }
    const prepared: PreparedMedia = { file, info, size, owner, logicalId: key, videoId: item.videoId };
    this.preparedMedia.set(key, prepared);
    this.cachedSizes.set(item.videoId, size);
    if (owner !== "marathon") {
      this.bufferedIds.add(item.videoId);
      this.bufferedCount = this.bufferedIds.size;
    }
    this.downloadStates.set(item.videoId, {
      videoId: item.videoId,
      title: item.title,
      thumbnail: item.thumbnail,
      percent: 100,
      status: "downloaded",
      attempt: this.downloadStates.get(item.videoId)?.attempt ?? 1,
      bytes: size,
    });
    this.download = null;
    this.event();
    return prepared;
  }

  private async fillOwnedBuffers(source: MediaSourceProvider, signal: AbortSignal) {
    const items = this.store.all();
    const record = this.store.controllingMarathon();
    let marathonVideoIds: string[] = [];
    if (record?.marathon.status === "active") {
      const { marathon, entries } = record;
      const stalePlan = this.normalHandoffPlan();
      if (stalePlan && stalePlan.marathonId !== marathon.id)
        this.store.set("marathonNormalHandoff", null);
      const window = entries
        .filter((entry) => entry.position >= marathon.currentPosition)
        .slice(0, 2);
      const wantedKeys = new Set(window.map((entry) => `marathon:${entry.id}`));
      marathonVideoIds = window.map((entry) => this.marathonItem(entry).videoId);
      for (const [key, prepared] of [...this.preparedMedia])
        if (prepared.owner === "marathon" && !wantedKeys.has(key) && prepared.file !== this.currentMedia?.file)
          this.preparedMedia.delete(key);
      source.retain?.(this.retainedVideoIds(marathonVideoIds));
      for (const entry of window) {
        signal.throwIfAborted();
        const key = `marathon:${entry.id}`;
        if (this.preparedMedia.has(key)) continue;
        const item = this.marathonItem(entry);
        try {
          await this.prepareOwnedMedia(source, item, key, "marathon", signal, () => {
            const current = this.store.controllingMarathon();
            return current?.marathon.id === marathon.id &&
              current.marathon.status === "active" &&
              entry.position >= current.marathon.currentPosition &&
              entry.position < current.marathon.currentPosition + 2;
          });
        } catch (error) {
          if (signal.aborted) throw error;
          this.event(`Marathon buffer stalled while preparing ${entry.title} — ${error instanceof Error ? error.message : "unknown error"}`, "warn", { marathonId: marathon.id, entryId: entry.id });
          break;
        }
      }
      if (marathon.totalEntries - marathon.currentPosition <= 2)
        this.ensureNormalHandoffPlan(marathon.id, items);
    }

    const plan = this.normalHandoffPlan();
    const handoffItems = plan
      ? plan.entryIds.map((id) => items.find((item) => item.id === id)).filter((item): item is StoredItem => !!item)
      : [];
    source.retain?.(this.retainedVideoIds([...marathonVideoIds, ...handoffItems.map((item) => item.videoId)]));
    for (const item of handoffItems) {
      signal.throwIfAborted();
      if (this.preparedMedia.has(item.videoId)) {
        const prepared = this.preparedMedia.get(item.videoId)!;
        prepared.owner = "normal-handoff";
        prepared.logicalId = item.id;
        prepared.videoId = item.videoId;
        continue;
      }
      try {
        await this.prepareOwnedMedia(source, item, item.videoId, "normal-handoff", signal, () => {
          const current = this.normalHandoffPlan();
          return !!current && current.marathonId === plan!.marathonId && current.entryIds.includes(item.id);
        });
      } catch (error) {
        if (signal.aborted) throw error;
        this.event(`Normal handoff preload delayed: ${item.title} — ${error instanceof Error ? error.message : "unknown error"}`, "warn", { marathonId: plan!.marathonId, entryId: item.id });
        break;
      }
    }
    source.retain?.(this.retainedVideoIds([...marathonVideoIds, ...handoffItems.map((item) => item.videoId)]));
    if (plan && record?.marathon.status !== "active") {
      const startIndex = Math.max(0, items.findIndex((item) => item.id === plan.entryIds[0]));
      await this.fillBuffer(source, items, signal, this.bufferLimit, startIndex);
    }
  }

  private scheduleOwnedRefill(source: MediaSourceProvider, signal: AbortSignal) {
    if (this.refillTask) {
      this.ownedRefillPending = true;
      return;
    }
    this.refillTask = this.fillOwnedBuffers(source, signal)
      .catch(() => {})
      .finally(() => this.finishRefill(source, signal));
  }

  private marathonItem(entry: MarathonEntry): StoredItem {
    const metadata = entry.metadata ?? {};
    const youtubeId = entry.youtubeVideoId ?? "";
    const localIdentity = entry.localIdentity ?? "";
    return {
      id: `marathon:${entry.id}`,
      videoId: entry.sourceType === "local" ? `local:${localIdentity}` : youtubeId,
      position: entry.position,
      title: entry.title,
      channel: String(metadata.channel ?? ""),
      thumbnail: String(metadata.thumbnail ?? ""),
      available: true,
      duration: entry.duration,
      publishedAt: String(metadata.publishedAt ?? ""),
      liveStatus: "none",
      failures: 0,
      failureCount: 0,
      retryAt: 0,
      error: null,
      seriesKey: String(metadata.seriesKey ?? ""),
      seriesIndex: typeof metadata.seriesIndex === "number" ? metadata.seriesIndex : null,
      sourceType: entry.sourceType,
      localIdentity: entry.localIdentity ?? undefined,
      localPath: entry.localPath ?? undefined,
      youtubeVideoId: entry.youtubeVideoId ?? undefined,
      videoWidth: typeof metadata.videoWidth === "number" ? metadata.videoWidth : null,
      videoHeight: typeof metadata.videoHeight === "number" ? metadata.videoHeight : null,
      frameRate: String(metadata.frameRate ?? ""),
      videoCodec: String(metadata.videoCodec ?? ""),
      audioCodec: String(metadata.audioCodec ?? ""),
      hasAudio: typeof metadata.hasAudio === "boolean" ? metadata.hasAudio : undefined,
      isShort: false,
    };
  }

  private marathonChoice(items: StoredItem[]) {
    const record = this.store.controllingMarathon();
    if (!record) return null;
    const { marathon, entries } = record;
    if (marathon.status === "scheduled") {
      const completed = this.store.completedQueueEntriesSince(marathon.scheduleUpdatedAt ?? marathon.createdAt);
      const remaining = marathon.committedQueue.filter((entry) => !completed.has(entry.entryId));
      if (remaining.length) {
        const committed = items.find((item) => item.id === remaining[0].entryId);
        return committed
          ? { item: committed, index: items.indexOf(committed), marathon: null, blocked: null, waitMs: 0, blockedLevel: "info" as const }
          : { item: null, index: 0, marathon: null, blocked: `Marathon queue boundary reconciliation failed: committed entry ${remaining[0].title} is unavailable`, waitMs: 60000, blockedLevel: "error" as const };
      }
      if (marathon.scheduledStart === null)
        return { item: null, index: 0, marathon: null, blocked: "Scheduled Marathon has no calculated start time", waitMs: 60000, blockedLevel: "error" as const };
      if (Date.now() < marathon.scheduledStart)
        return { item: null, index: 0, marathon: null, blocked: "Normal queue boundary complete; standby is holding output until the scheduled Marathon start", waitMs: Math.max(1000, Math.min(60000, marathon.scheduledStart - Date.now())), blockedLevel: "info" as const };
    }
    if (!["scheduled", "active"].includes(marathon.status)) return null;
    const entry = entries.find((candidate) => candidate.position === marathon.currentPosition);
    if (!entry)
      return { item: null, index: 0, marathon: null, blocked: "Marathon snapshot is incomplete at the current position", waitMs: 60000, blockedLevel: "error" as const };
    if (!Number.isFinite(entry.duration) || Number(entry.duration) <= 0)
      return { item: null, index: 0, marathon: null, blocked: `Marathon snapshot entry has no exact duration: ${entry.title}`, waitMs: 60000, blockedLevel: "error" as const };
    return {
      item: this.marathonItem(entry),
      index: 0,
      marathon: { id: marathon.id, name: marathon.name, sourceType: marathon.sourceType, scheduleToken: marathon.scheduleUpdatedAt, entry },
      blocked: null,
      waitMs: 0,
      blockedLevel: "info" as const,
    };
  }
  private async play(
    s: Settings,
    signal: AbortSignal,
    source: MediaSourceProvider,
    epoch: number,
  ) {
    while (!signal.aborted) {
      const items = this.store.all();
      const saved = this.store.get<{ id: string; offset: number } | null>(
        "cursor",
        null,
      );
      const intended = this.marathonChoice(items);
      const handoffChoice = intended ? null : this.normalHandoffChoice(items);
      const selection = intended ?? handoffChoice;
      const marathon = intended?.marathon ?? null;
      const handoff = !!handoffChoice?.handoff;
      let index = selection?.index ?? Math.max(
        0,
        items.findIndex((i) => i.id === saved?.id),
      );
      let item: StoredItem | undefined = selection?.item ?? undefined;
      if (selection?.blocked) {
        this.state = "waiting";
        this.current = null;
        this.event(selection.blocked, selection.blockedLevel);
        const idle = standby(this.config, s, epoch, signal, () =>
          this.event(handoff ? "Normal handoff standby encoder failed; retry scheduled" : "Marathon standby encoder failed; retry scheduled", "error"),
        );
        try { await delay(selection.waitMs, signal); } finally { await idle.stop(); }
        continue;
      }
      const shortStartsRemaining = !marathon && s.shuffle
        ? this.store.get(
            "shuffleShortStartsRemaining",
            this.store.get("shuffleNeedsShortStart", true) ? 2 : 0,
          )
        : 0;
      const lastVideoDuration = this.store.get<number | null>(
        "lastVideoDuration",
        null,
      );
      const followsShuffleRules = (candidate: StoredItem, resuming = false) => {
        if (!s.shuffle || resuming) return true;
        if (
          candidate.seriesKey &&
          candidate.seriesKey ===
            this.store.get("lastVideoSeries", "")
        )
          return true;
        if (needsLongDownloadLead(candidate))
          return (
            lastVideoDuration !== null &&
            lastVideoDuration >= DOWNLOAD_LEAD_SECONDS
          );
        return !(
          lastVideoDuration !== null &&
          lastVideoDuration > LONG_VIDEO_SECONDS &&
          isLongVideo(candidate)
        );
      };
      const canPlay = (candidate: StoredItem, resuming = false) =>
        candidate.available &&
        candidate.retryAt <= Date.now() &&
        !(
          shortStartsRemaining > 0 &&
          !resuming &&
          !canStartShuffledQueue(candidate)
        ) &&
        followsShuffleRules(candidate, resuming);
      if (!item) for (let k = 0; k < items.length; k++) {
        const candidate = items[(index + k) % items.length];
        const resuming = candidate.id === saved?.id && saved.offset > 0;
        if (canPlay(candidate, resuming)) {
          item = candidate;
          index = (index + k) % items.length;
          break;
        }
      }
      if (!item) {
        if (this.marathonHandoffPending && !this.marathonHandoffReported) {
          this.marathonHandoffReported = true;
          this.event("Marathon-to-normal handoff failed: no eligible normal video is currently available; standby remains active", "error");
        }
        this.state = "waiting";
        this.current = null;
        this.event(
          shortStartsRemaining > 0
            ? "Waiting for the next shuffled opening video of 15 minutes or less"
            : lastVideoDuration !== null &&
                lastVideoDuration > LONG_VIDEO_SECONDS
              ? "Waiting for an available shorter video or a 3-hour video with enough download lead time"
              : "Waiting for an available video that satisfies shuffle download lead time",
        );
        const idle = standby(this.config, s, epoch, signal, () =>
          this.event("Standby encoder failed; retry scheduled", "error"),
        );
        try {
          do {
            await delay(5000, signal);
          } while (!this.store.all().some((candidate) => canPlay(candidate)));
        } finally {
          await idle.stop();
        }
        continue;
      }
      const resume = !marathon && item.id === saved?.id ? Math.max(0, saved.offset) : 0;
      const previousVideoId = this.current?.videoId ?? "none";
      const transition = ++this.transitionGeneration;
      const transitionStartedAt = Date.now();
      this.current = item;
      this.elapsed = resume;
      this.state = "preparing";
      this.event(`Transition ${transition} requested: ${previousVideoId} -> ${item.videoId}`);
      const clipController = new AbortController();
      this.clip = clipController;
      const clipSignal = AbortSignal.any([signal, clipController.signal]);
      this.skipRequested = false;
      let idle: ReturnType<typeof standby> | null = null;
      let consumed = false;
      let historyId: number | null = null;
      let historyFinished = false;
      let playbackOffset = resume;
      let sourceReady = false;
      let marathonActivated = false;
      let marathonOwnershipStale = false;
      const finishHistory = (
        status: "played" | "skipped" | "failed" | "stopped" | "interrupted",
      ) => {
        if (historyId === null || historyFinished) return;
        this.store.finishPlayback(
          historyId,
          status,
          Math.max(0, this.elapsed - playbackOffset),
        );
        historyFinished = true;
      };
      try {
        if (marathon) {
          const selectedSourceType = s.mediaSource === "local" ? "local" : "youtube";
          if (marathon.sourceType !== selectedSourceType)
            throw new Error(`Marathon source mode ${marathon.sourceType} does not match the selected ${selectedSourceType} mode`);
          if (marathon.entry.playbackState === "interrupted" && /restarted/i.test(marathon.entry.lastError ?? ""))
            this.event(`Marathon recovery resumed at unfinished entry ${marathon.entry.position + 1}: ${item.title}`, "info", { marathonId: marathon.id, entryId: marathon.entry.id });
          try {
            this.store.prepareMarathonEntry(marathon.id, marathon.entry.id, marathon.entry.position, marathon.scheduleToken);
          } catch (error) {
            this.event(`Marathon progress persistence failed during preparation — ${error instanceof Error ? error.message : "unknown database error"}`, "error", { marathonId: marathon.id, entryId: marathon.entry.id });
            throw error;
          }
          this.event(`Marathon entry ${marathon.entry.position + 1} preparing: ${item.title}`);
        }
        source.retain?.(this.retainedVideoIds([item.videoId]));
        this.event("Preparing media: " + item.title + (item.sourceType === "local" ? ". Validating the original local file before playback." : ". The complete video is downloaded before playback."));
        const preparedKey = marathon ? item.id : item.videoId;
        let prepared = this.preparedMedia.get(preparedKey);
        if (prepared) {
          try {
            await stat(prepared.file);
          } catch {
            this.preparedMedia.delete(preparedKey);
            prepared = undefined;
            this.event(`Prepared media unavailable; re-preparing ${item.title}`, "warn", { entryId: preparedKey, videoId: item.videoId });
          }
        }
        if (!prepared) {
          this.event(`Transition ${transition}: source is not preloaded; standby fallback started`, "warn");
          idle = standby(this.config, s, epoch, clipSignal, (reason) =>
            this.event(
              `Transition ${transition}: standby encoder failed${reason ? ` — ${reason}` : ""}; retry scheduled`,
              "error",
            ),
          );
          // Keep the outgoing stream alive immediately. A slow thumbnail
          // request must never delay standby output during recovery.
          await writeLoadingItem(this.config, item).catch(() => {});
        }
        const file = prepared?.file ?? (await source.resolve(item, clipSignal));
        const info = prepared?.info ?? (await this.probeMedia(file, clipSignal));
        if (!prepared && (marathon || handoff)) {
          const size = (await stat(file)).size;
          const key = marathon ? item.id : item.videoId;
          this.preparedMedia.set(key, {
            file,
            info,
            size,
            owner: marathon ? "marathon" : "normal-handoff",
            logicalId: item.id,
            videoId: item.videoId,
          });
          this.cachedSizes.set(item.videoId, size);
          if (handoff) {
            this.bufferedIds.add(item.videoId);
            this.bufferedCount = this.bufferedIds.size;
          }
        }
        sourceReady = true;
        const preparationMs = Date.now() - transitionStartedAt;

        if (preparationMs > 30000)
          this.event(`Transition ${transition}: source preparation took ${preparationMs}ms`, "warn", { preparationMs });
        this.event(`Transition ${transition}: source prepared (${prepared ? "preloaded" : "resolved"})`);
        const duration = Number(info.format.duration);
        const offset = resume < duration - 1 ? resume : 0;
        playbackOffset = offset;
        const hasAudio = info.streams.some((x: any) => x.codec_type === "audio");
        const audio = info.streams.find((x: any) => x.codec_type === "audio");
        const outputAudioRate = audioSampleRate(s);
        this.event(
          audio
            ? `Audio input: ${audio.codec_name}, ${audio.sample_rate} Hz, ${audio.channels} channels; output AAC ${outputAudioRate} Hz stereo`
            : `Video has no audio; using ${outputAudioRate} Hz stereo silence`,
        );
        const publishedAt = marathon ? item.publishedAt ?? "" : this.store.get<Record<string, string>>("uploadDates", {})[item.videoId];
        const ov = await overlay(
          this.config,
          {
            ...s,
            overlay: { ...s.overlay, title: item.title },
          },
          undefined,
          publishedAt,
          { offset, total: duration },
          marathon
            ? {
                name: marathon.name,
                completed: this.store.marathon(marathon.id)?.marathon.completedEntries ?? 0,
                total: this.store.marathon(marathon.id)?.marathon.totalEntries ?? 0,
              }
            : undefined,
        );
        clipSignal.throwIfAborted();
        if (idle) {
          await idle.stop();
          idle = null;
        }
        clipSignal.throwIfAborted();
        const args = [
          "-hide_banner",
          "-loglevel",
          "error",
          "-progress",
          "pipe:1",
          "-stats_period",
          "1",
          "-re",
          "-ss",
          String(offset),
          "-i",
          file,
          "-f",
          "lavfi",
          "-i",
          `anullsrc=r=${outputAudioRate}:cl=stereo`,
          ...ov.inputs,
          "-filter_complex",
          ov.filter,
          "-map",
          "[v]",
          "-map",
          hasAudio ? "0:a:0" : "1:a:0",
          "-t",
          String(duration - offset),
          ...encodeArgs(
            s,
            this.config.UDP_BASE_PORT,
            (Date.now() - epoch) / 1000,
          ),
        ];
        const child = launch(this.config.FFMPEG_PATH, args, clipSignal);
        child.once("error", (error) =>
          this.event(`Transition ${transition}: FFmpeg error — ${error.message}`, "error"),
        );
        child.once("close", (exitCode, exitSignal) =>
          this.event(`Transition ${transition}: FFmpeg closed (code ${exitCode ?? "none"}, signal ${exitSignal ?? "none"})`),
        );

        this.event(`Transition ${transition} activated ${item.videoId} (FFmpeg PID ${child.pid ?? "unknown"})`);
        this.currentMedia = { file, duration };
        this.state = "playing";
        if (s.shuffle && shortStartsRemaining > 0) {
          const remaining = Math.max(0, shortStartsRemaining - 1);
          this.store.set("shuffleShortStartsRemaining", remaining);
          this.store.set("shuffleNeedsShortStart", remaining > 0);
        }
        if (!marathon) {
          this.store.set("lastVideoLong", isLongVideo(item));
          this.store.set("lastVideoDuration", item.duration);
          this.store.set("lastVideoSeries", item.seriesKey ?? "");
          this.store.set("cursor", { id: item.id, offset });
          if (handoff) this.scheduleOwnedRefill(source, signal);
          else this.scheduleRefill(source, items, signal, index);
        }
        this.event();
        let lastProgress = Date.now(),
          lastCheckpoint = 0,
          lastFrame = -1,
          buffer = "";
        child.stdout?.on("data", (chunk) => {
          buffer += String(chunk);
          let pos;
          while ((pos = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, pos).trim();
            buffer = buffer.slice(pos + 1);
            if (line.startsWith("frame=")) {
              const n = Number(line.slice(6));
              if (Number.isFinite(n) && n > lastFrame) {
                if (lastFrame < 0) {
                  if (!marathon && this.marathonHandoffPending) {
                    this.marathonHandoffPending = false;
                    this.marathonHandoffReported = false;
                    this.event("Normal playback resumed after Marathon completion");
                  }
                  if (marathon && !marathonActivated) {
                    try {
                      marathonActivated = this.store.activateMarathonEntry(marathon.id, marathon.entry.id, marathon.entry.position, marathon.scheduleToken);
                    } catch (error) {
                      this.event(`Marathon progress persistence failed during activation — ${error instanceof Error ? error.message : "unknown database error"}`, "error", { marathonId: marathon.id, entryId: marathon.entry.id });
                      clipController.abort();
                      return;
                    }
                    if (!marathonActivated) {
                      marathonOwnershipStale = true;
                      this.event("Duplicate or stale Marathon activation suppressed", "warn", { marathonId: marathon.id, entryId: marathon.entry.id });
                      clipController.abort();
                      return;
                    }
                    this.event(`Marathon started/resumed at entry ${marathon.entry.position + 1}: ${item!.title}`, "info", { marathonId: marathon.id, entryId: marathon.entry.id });
                    this.scheduleOwnedRefill(source, signal);
                  }
                  const activatedAt = Date.now();
                  this.store.set("health.lastTransitionSuccess", { time: activatedAt, videoId: item!.videoId, title: item!.title, preparationMs });
                  this.store.set("health.lastPlaybackStart", { time: activatedAt, videoId: item!.videoId, title: item!.title, hasAudio, audioSampleRate: audio?.sample_rate ?? null, audioChannels: audio?.channels ?? null });
                  historyId = this.store.startPlayback(item!);
                  const generation = ++this.activationGeneration;
                  const counts = this.store.get<Record<string, number>>(
                    "playCounts",
                    {},
                  );
                  counts[item!.videoId] = (counts[item!.videoId] ?? 0) + 1;
                  this.store.set("playCounts", counts);
                  if (this.metadataTimer) clearTimeout(this.metadataTimer);
                  this.metadataTimer = setTimeout(() => {
                    if (
                      this.activationGeneration !== generation ||
                      this.current?.videoId !== item!.videoId ||
                      this.state !== "playing"
                    ) return;
                    const activePublishedAt = marathon ? item!.publishedAt ?? "" : this.store.get<Record<string, string>>("uploadDates", {})[item!.videoId];
                    const activeSettings = {
                      ...s,
                      overlay: { ...s.overlay, title: item!.title },
                    };
                    const expected = overlayLayout(activeSettings, activePublishedAt);
                    const directory = path.join(this.config.DATA_DIR, "overlay");
                    void Promise.all([
                      readFile(path.join(directory, "title.txt"), "utf8").catch(() => ""),
                      readFile(path.join(directory, "date.txt"), "utf8").catch(() => ""),
                    ]).then(([title, date]) => {
                      if (
                        this.activationGeneration !== generation ||
                        this.current?.videoId !== item!.videoId ||
                        (title === expected.title && date === expected.date)
                      ) return;
                      return overlay(
                        this.config,
                        activeSettings,
                        undefined,
                        activePublishedAt,
                        { offset: this.elapsed, total: duration },
                        marathon
                          ? {
                              name: marathon.name,
                              completed: this.store.marathon(marathon.id)?.marathon.completedEntries ?? 0,
                              total: this.store.marathon(marathon.id)?.marathon.totalEntries ?? 0,
                            }
                          : undefined,
                      ).then(() =>
                        this.event("Restored stale title/date overlay", "warn"),
                      );
                    }).catch(() =>
                      this.event("Metadata sanity check could not refresh overlay", "warn"),
                    );
                  }, 5000);
                }
                lastFrame = n;
                lastProgress = Date.now();
                this.elapsed = Math.min(duration, offset + n / s.fps);
                if (!marathon && Date.now() - lastCheckpoint > 5000) {
                  lastCheckpoint = Date.now();
                  this.store.set("cursor", {
                    id: item!.id,
                    offset: this.elapsed,
                  });
                }
                this.event();
              }
            }
          }
        });
        const watchdog = setInterval(() => {
          if (
            Date.now() - lastProgress > 30000 &&
            this.transitionGeneration === transition &&
            this.clip === clipController
          ) {
            this.event(`Transition ${transition}: active producer stalled; recovery requested`, "error");
            clipController.abort();
          }
        }, 5000);
        let code: number;
        try {
          code = await completion(child);
        } finally {
          clearInterval(watchdog);
        }
        signal.throwIfAborted();
        if (code !== 0 || clipSignal.aborted) {
          const reason = mediaFailure(child);
          this.event(`Transition ${transition}: producer exited with code ${code} — ${reason}`, "error");
          throw new Error(reason);
        }
        finishHistory("played");
        if (marathon) {
          let completed;
          try {
            completed = this.store.completeMarathonEntry(marathon.id, marathon.entry.id, marathon.entry.position);
          } catch (error) {
            this.event(`Marathon progress persistence failed during completion — ${error instanceof Error ? error.message : "unknown database error"}`, "error", { marathonId: marathon.id, entryId: marathon.entry.id });
            throw error;
          }
          consumed = completed.applied;
          if (!completed.applied)
            this.event("Duplicate or stale Marathon completion suppressed", "warn", { marathonId: marathon.id, entryId: marathon.entry.id });
          else if (completed.finished) {
            this.marathonHandoffPending = true;
            this.marathonHandoffReported = false;
            this.event(`Marathon completed: ${marathon.name}`, "info", { marathonId: marathon.id });
          }
          else
            this.event(`Marathon entry completed: ${item.title}`, "info", { marathonId: marathon.id, entryId: marathon.entry.id });
        } else {
          this.store.success(item.id);
          consumed = true;
          this.event("Finished: " + item.title);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Media failed; retry in 5 minutes";
        if (signal.aborted) {
          if (marathon) {
            try { this.store.interruptMarathonEntry(marathon.id, marathon.entry.id, "Playback stopped before completion"); }
            catch (error) { this.event(`Marathon progress persistence failed while stopping — ${error instanceof Error ? error.message : "unknown database error"}`, "error", { marathonId: marathon.id, entryId: marathon.entry.id }); }
          }
          break;
        }
        if (this.skipRequested) {
          finishHistory("skipped");
          if (marathon) {
            let skipped;
            try {
              skipped = this.store.skipMarathonEntry(marathon.id, marathon.entry.id, marathon.entry.position);
            } catch (error) {
              this.event(`Marathon progress persistence failed during skip — ${error instanceof Error ? error.message : "unknown database error"}`, "error", { marathonId: marathon.id, entryId: marathon.entry.id });
              throw error;
            }
            consumed = skipped.applied;
            if (!skipped.applied)
              this.event("Duplicate or stale Marathon skip suppressed", "warn", { marathonId: marathon.id, entryId: marathon.entry.id });
            else {
              this.event(`Marathon entry skipped: ${item.title}`, "warn", { marathonId: marathon.id, entryId: marathon.entry.id });
              if (skipped.finished) {
                this.marathonHandoffPending = true;
                this.marathonHandoffReported = false;
              }
            }
          } else {
            consumed = true;
            this.event("Skipped: " + item.title);
          }
        } else if (marathon) {
          if (marathonOwnershipStale || /ownership changed before preparation/i.test(message)) {
            this.event("Duplicate or stale Marathon activation suppressed", "warn", { marathonId: marathon.id, entryId: marathon.entry.id });
            consumed = false;
            this.state = "selecting";
            continue;
          }
          finishHistory("failed");
          consumed = false;
          try {
            this.store.interruptMarathonEntry(marathon.id, marathon.entry.id, message);
          } catch (error) {
            this.event(`Marathon progress persistence failed while preserving the interrupted entry — ${error instanceof Error ? error.message : "unknown database error"}`, "error", { marathonId: marathon.id, entryId: marathon.entry.id });
          }
          const marathonFailure = /local media file missing|external drive disconnected|source mode .* does not match/i.test(message)
            ? "Marathon entry unavailable"
            : marathonActivated ? "Marathon playback interrupted" : "Marathon entry preparation failed";
          this.event(`${marathonFailure}; position preserved: ${item.title} — ${message}`, "error", { marathonId: marathon.id, entryId: marathon.entry.id });
          await delay(60000, signal).catch(() => {});
        } else if (handoff) {
          finishHistory("failed");
          consumed = false;
          this.recordFailure(item, message);
          this.event(`Normal handoff waiting for media: ${item.title} — ${message}`, "warn", { entryId: item.id });
          await delay(60000, signal).catch(() => {});
        } else {
          if (this.marathonHandoffPending && !this.marathonHandoffReported) {
            this.marathonHandoffReported = true;
            this.event(`Marathon-to-normal handoff failed: ${message}`, "error");
          }
          const pauseQueue = !sourceReady && pausesDownloadQueue(message);
          finishHistory("failed");
          consumed = !pauseQueue;
          this.recordFailure(item, message);
          this.event("Media failed: " + item.title + " — " + message, "warn");
          if (pauseQueue) {
            this.event(
              item.sourceType === "local" ? "Playback is holding this position for 60 seconds while the local folder or drive is unavailable" : "Playback is holding this position for 60 seconds so a global downloader problem does not cycle through every video",
              "warn",
            );
            await delay(60000, signal).catch(() => {});
          }
        }
      } finally {
        finishHistory(signal.aborted ? "stopped" : "interrupted");
        if (this.metadataTimer) clearTimeout(this.metadataTimer);
        this.metadataTimer = null;
        this.activationGeneration += 1;
        if (this.transitionGeneration === transition) this.currentMedia = null;
        clipController.abort();
        if (idle) await idle.stop();
        if (this.clip === clipController) this.clip = null;
        this.event(`Transition ${transition}: source cleanup complete`);
      }
      this.state = "selecting";
      if (consumed && !marathon) {
        if (handoff) this.advanceNormalHandoff(item.id);
        this.bufferedIds.delete(item.videoId);
        this.preparedMedia.delete(item.videoId);
        this.downloadStates.delete(item.videoId);
        this.cachedSizes.delete(item.videoId);
        this.bufferedCount = this.bufferedIds.size;
        await source.remove?.(item.videoId).catch(() => {});
        this.event();
        const fresh = this.store.all();
        const at = fresh.findIndex((i) => i.id === item!.id);
        const next = fresh[(at + 1) % Math.max(1, fresh.length)];
        this.store.set("cursor", next ? { id: next.id, offset: 0 } : null);
      } else if (consumed && marathon) {
        this.preparedMedia.delete(item.id);
        this.event();
      }
    }
    this.download = null;
    this.event();
  }
  private recordFailure(item: StoredItem, message: string) {
    if (!countsTowardFailureHistory(message)) return;
    this.store.fail(item.id, message);
    const history = this.store.get<Record<string, number>>(
      "failureHistory",
      {},
    );
    history[item.videoId] = (history[item.videoId] ?? 0) + 1;
    this.store.set("failureHistory", history);
  }

  queueChangePlan(items: StoredItem[]) {
    if (this.state === "stopped") return { changesBuffer: false, removed: [], added: [] };
    const at = Math.max(
      0,
      items.findIndex((item) => item.id === this.current?.id),
    );
    const wanted = this.bufferCandidates(items, at)
      .slice(0, this.bufferLimit)
      .map((item) => item.videoId);
    const wantedSet = new Set(wanted);
    return {
      changesBuffer:
        [...this.bufferedIds].some((id) => !wantedSet.has(id)) ||
        wanted.some((id) => !this.bufferedIds.has(id)),
      removed: [...this.bufferedIds].filter(
        (id) => !wantedSet.has(id) && id !== this.current?.videoId,
      ),
      added: wanted.filter((id) => !this.bufferedIds.has(id)),
    };
  }

  queueChanged() {
    const marathon = this.store.controllingMarathon()?.marathon;
    if (marathon?.status === "active" || this.current?.id.startsWith("marathon:") || this.normalHandoffPlan()) {
      this.event("Normal queue update saved; buffer changes are deferred until Marathon playback ends");
      return;
    }
    if (!this.activeSource || this.queueRefreshPending) return;
    this.queueRefreshPending = true;
    const refresh = async () => {
      await this.refillTask?.catch(() => {});
      if (!this.activeSource || !this.controller || this.controller.signal.aborted)
        return;
      const items = this.store.all();
      const at = Math.max(
        0,
        items.findIndex((item) => item.id === this.current?.id),
      );
      const wanted = this.bufferCandidates(items, at).slice(0, this.bufferLimit);
      const wantedIds = new Set(wanted.map((item) => item.videoId));
      this.activeSource.retain?.([...wantedIds]);
      for (const id of [...this.bufferedIds])
        if (id !== this.current?.videoId && !wantedIds.has(id)) {
          await this.activeSource.remove?.(id).catch(() => {});
          this.bufferedIds.delete(id);
          this.preparedMedia.delete(id);
        }
      this.bufferedCount = this.bufferedIds.size;
      this.event("Active download queue updated");
      this.scheduleRefill(
        this.activeSource,
        items,
        this.controller.signal,
        at,
      );
    };
    void refresh().finally(() => {
      this.queueRefreshPending = false;
    });
  }

  async close() {
    this.closed = true;
    clearInterval(this.resyncTimer);
    this.syncAbort.abort();
    await this.stop(true);
    await this.syncTask?.catch(() => {});
  }
}
