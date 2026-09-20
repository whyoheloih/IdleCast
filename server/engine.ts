import { EventEmitter } from "node:events";
import type { Config, Settings } from "./config.js";
import { Store, type StoredItem } from "./db.js";
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
  canFollowInShuffledQueue,
  needsLongDownloadLead,
  DOWNLOAD_LEAD_SECONDS,
  LONG_VIDEO_SECONDS,
} from "./queue.js";
import { playlistId as parsePlaylistId } from "./config.js";
import { overlay } from "./overlay.js";
import { audioSampleRate, encodeArgs, standby, writeLoadingStatus } from "./encoder.js";
export type OutputState = {
  status: "disabled" | "connecting" | "sending" | "retrying" | "stopped";
  retries: number;
};
export type EngineDependencies = {
  playlist?: PlaylistProvider;
  source?: MediaSourceProvider;
  outputs?: Partial<Record<"youtube" | "twitch", StreamOutputProvider>>;
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
      publishedAt: this.current ? this.store.get<Record<string,string>>("uploadDates", {})[this.current.videoId] : "",
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
    this.resyncTimer = setInterval(() => {
      const s = store.settings();
      if (
        (s.sources.length || (s.sourceMode === "channel" ? s.channelUrl : s.playlistId)) &&
        Date.now() - store.get("lastSync", 0) > s.resyncMinutes * 60000
      )
        void this.sync().catch(() => {});
    }, 60000);
  }
  event(message?: string, level = "info") {
    if (message) this.store.log(level, message);
    this.emit("change");
  }
  snapshot() {
    return {
      state: this.state,
      current: this.current ? {...this.current, publishedAt: this.store.get<Record<string,string>>("uploadDates", {})[this.current.videoId]} : null,
      elapsed: this.elapsed,
      outputs: this.outputs,
      syncing: this.syncing,
      count: this.store.count(),
      lastSync: this.store.get("lastSync", 0),
      desired: this.store.get("desired", false),
      excluded: this.store.get("excludedCount", 0),
      download: this.download,
    };
  }
  sync(): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error("Service is shutting down"));
    if (this.syncTask) return this.syncTask;
    const settings = this.store.settings();
    const id =
      settings.sourceMode === "channel"
        ? settings.channelUrl
        : settings.playlistId;
    if (!id && !settings.sources.length) return Promise.reject(new Error("Configure a playlist or channel first"));
    this.syncing = true;
    this.event();
    this.syncTask = (async () => {
      try {
        const provider =
          this.dependencies.playlist ??
          new YouTubePlaylistProvider(this.config.YOUTUBE_API_KEY);
        const sources = settings.sources.length ? settings.sources : [{kind: settings.sourceMode, value: id}];
        const unique = new Map<string, StoredItem>();
        for (const source of sources) {
          const playlistId = source.kind === "channel"
            ? await new YouTubePlaylistProvider(this.config.YOUTUBE_API_KEY).channelUploads(source.value, this.syncAbort.signal)
            : parsePlaylistId(source.value);
          for (const item of await provider.fetch(playlistId, this.syncAbort.signal))
            if (!unique.has(item.videoId)) unique.set(item.videoId, item as StoredItem);
        }
        const fetched = [...unique.values()];
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
        this.event(
          "Playlist synchronized: " +
            queue.items.length +
            " items; " +
            queue.excluded +
            " excluded",
        );
      } catch {
        this.event(
          "Playlist sync failed; previous snapshot preserved. Check API key, access and quota.",
          "error",
        );
        throw new Error(
          "Playlist sync failed; check API key, access and quota",
        );
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
      throw new Error("Sync a nonempty playlist before starting");
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
    for (const name of ["youtube", "twitch"] as const)
      this.outputs[name] = {
        status: s[name].enabled ? "connecting" : "disabled",
        retries: 0,
      };
    this.state = "starting";
    this.event("Playback requested");
    const workers = (["youtube", "twitch"] as const).map((name, n) =>
      s[name].enabled
        ? this.output(name, s, this.config.UDP_BASE_PORT + n, signal)
        : Promise.resolve(),
    );
    this.task = this.play(s, signal)
      .catch(() => {
        if (!signal.aborted) this.event("Playback supervisor failed", "error");
      })
      .finally(async () => {
        this.controller?.abort();
        await Promise.allSettled(workers);
        this.state = "stopped";
        this.current = null;
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
            /overrun|circular buffer|non-monoton|timestamp|drop/i.test(
              String(chunk),
            ) &&
            Date.now() - lastTransportWarning > 15000
          ) {
            lastTransportWarning = Date.now();
            this.event(
              name +
                " transport buffering warning; check network stability and encoder load",
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
                this.outputs[name].status = "sending";
                this.event();
              }
            }
          }
        });
        try {
          await completion(child);
        } finally {
          clearInterval(watchdog);
        }
        if (signal.aborted) break;
        if (Date.now() - started > 60000) attempt = 0;
      } catch {
        if (signal.aborted) break;
      }
      this.outputs[name] = { status: "retrying", retries: ++attempt };
      this.event(name + " output disconnected; retry scheduled", "warn");
      try {
        await delay(backoff(attempt - 1), signal);
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
        ? new LocalMediaSource(this.config.MEDIA_DIR)
        : new ExperimentalYouTubeSource(this.config, undefined, s, {
            onDownload: (download) => {
              this.download = download;
              void writeLoadingStatus(this.config, download).catch(() => {});
              this.event();
            },
            onDelete: (filename) =>
              this.event("Cache deleted: " + filename),
          }))
    );
  }
  private async play(s: Settings, signal: AbortSignal) {
    const source = this.source(s);
    const epoch = Date.now();
    try {
      while (!signal.aborted) {
        const items = this.store.all();
        const saved = this.store.get<{ id: string; offset: number } | null>(
          "cursor",
          null,
        );
        let index = Math.max(
          0,
          items.findIndex((i) => i.id === saved?.id),
        );
        let item: StoredItem | undefined;
        const shortStartsRemaining = s.shuffle
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
        for (let k = 0; k < items.length; k++) {
          const candidate = items[(index + k) % items.length];
          const resuming = candidate.id === saved?.id && saved.offset > 0;
          if (canPlay(candidate, resuming)) {
            item = candidate;
            index = (index + k) % items.length;
            break;
          }
        }
        if (!item) {
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
        const resume = item.id === saved?.id ? Math.max(0, saved.offset) : 0;
        this.current = item;
        this.elapsed = resume;
        this.state = "preparing";
        this.event();
        this.clip = new AbortController();
        const clipSignal = AbortSignal.any([signal, this.clip.signal]);
        this.skipRequested = false;
        const idle = standby(this.config, s, epoch, clipSignal, () =>
          this.event("Standby encoder failed; retry scheduled", "error"),
        );
        try {
          source.pin?.(item.videoId);
          this.event(
            "Preparing media: " +
              item.title +
              ". The complete video is downloaded before playback.",
          );
          const file = await source.resolve(item, clipSignal);
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
              clipSignal,
            ),
          );
          if (!info.streams?.some((x: any) => x.codec_type === "video"))
            throw new Error("No playable video stream");
          const duration = Number(info.format?.duration);
          if (!Number.isFinite(duration) || duration <= 0)
            throw new Error("Media must have a finite duration");
          const offset = resume < duration - 1 ? resume : 0;
          const hasAudio = info.streams.some(
            (x: any) => x.codec_type === "audio",
          );
          const audio = info.streams.find((x: any) => x.codec_type === "audio");
          const outputAudioRate = audioSampleRate(s);
          this.event(audio ? `Audio input: ${audio.codec_name}, ${audio.sample_rate} Hz, ${audio.channels} channels; output AAC ${outputAudioRate} Hz stereo` : `Video has no audio; using ${outputAudioRate} Hz stereo silence`);
          const ov = await overlay(this.config, {
            ...s,
            overlay: { ...s.overlay, title: item.title },
          }, undefined, this.store.get<Record<string,string>>("uploadDates", {})[item.videoId], {
            offset,
            total: duration,
          });
          clipSignal.throwIfAborted();
          await idle.stop();
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
          this.currentMedia = { file, duration };
          this.state = "playing";
          if (s.shuffle && shortStartsRemaining > 0) {
            const remaining = Math.max(0, shortStartsRemaining - 1);
            this.store.set("shuffleShortStartsRemaining", remaining);
            this.store.set("shuffleNeedsShortStart", remaining > 0);
          }
          this.store.set("lastVideoLong", isLongVideo(item));
          this.store.set("lastVideoDuration", item.duration);
          this.store.set("cursor", { id: item.id, offset });
          this.event();
          const nextItem = Array.from({length: items.length - 1}, (_, k) => items[(index + 1 + k) % items.length])
            .find((i) =>
              i.available &&
              i.retryAt <= Date.now() &&
              (!s.shuffle || canFollowInShuffledQueue(item!, i)),
            );
          if (
            nextItem &&
            nextItem.id !== item.id &&
            nextItem.available &&
            nextItem.retryAt <= Date.now()
          )
            void source.resolve(nextItem, signal).catch(() => {});
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
                  lastFrame = n;
                  lastProgress = Date.now();
                  this.elapsed = Math.min(duration, offset + n / s.fps);
                  if (Date.now() - lastCheckpoint > 5000) {
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
            if (Date.now() - lastProgress > 30000) this.clip?.abort();
          }, 5000);
          let code: number;
          try {
            code = await completion(child);
          } finally {
            clearInterval(watchdog);
          }
          signal.throwIfAborted();
          if (code !== 0 || clipSignal.aborted)
            throw new Error(mediaFailure(child));
          this.store.success(item.id);
          this.event("Finished: " + item.title);
        } catch (error) {
          if (signal.aborted) break;
          if (this.skipRequested) this.event("Skipped: " + item.title);
          else {
            this.store.fail(
              item.id,
              error instanceof Error
                ? error.message
                : "Media failed; retry in 5 minutes",
            );
            this.event(
              "Media failed: " +
                item.title +
                " — " +
                (error instanceof Error ? error.message : "Unknown failure"),
              "warn",
            );
          }
        } finally {
          this.currentMedia = null;
          this.clip?.abort();
          await idle.stop();
          this.clip = null;
        }
        // Re-read after resync; advance by identity so changes do not resurrect removed items.
        const fresh = this.store.all();
        const at = fresh.findIndex((i) => i.id === item!.id);
        const next = fresh[(at + 1) % Math.max(1, fresh.length)];
        this.store.set("cursor", next ? { id: next.id, offset: 0 } : null);
      }
    } finally {
      await source.close?.();
      this.download = null;
      this.event();
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.resyncTimer);
    this.syncAbort.abort();
    await this.stop(true);
    await this.syncTask?.catch(() => {});
  }
}
