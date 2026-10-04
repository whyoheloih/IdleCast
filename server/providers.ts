import { realpath, stat, readdir, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Config, Settings } from "./config.js";
import { runCapture, withCancellation, delay } from "./process.js";

export type PlaylistItem = {
  id: string;
  videoId: string;
  position: number;
  title: string;
  channel: string;
  thumbnail: string;
  available: boolean;
  duration: number | null;
  publishedAt?: string;
  regionRestricted?: boolean;
  embeddable?: boolean;
  failureCount?: number;
  seriesKey?: string;
  seriesIndex?: number | null;
  isShort?: boolean;
  playCount?: number;
  selectionPenalty?: number;
  liveStatus?: "none" | "live" | "upcoming" | "past";
};
export interface PlaylistProvider {
  fetch(playlistId: string, signal: AbortSignal): Promise<PlaylistItem[]>;
}
export type DownloadActivity = {
  videoId: string;
  title: string;
  thumbnail: string;
  percent: number | null;
  status: "queued" | "downloading" | "retrying" | "downloaded" | "failed";
  attempt: number;
  bytes?: number;
  error?: string;
};
export type MediaSourceHooks = {
  onDownload?: (activity: DownloadActivity | null) => void;
  onDelete?: (filename: string) => void;
};
export function isRetryableDownloadFailure(message: string) {
  return !/account verification|rate limit|media disk is full|required media executable|executable path|cache limit exceeded|exceeds the configured per-video cache limit|cache storage is unavailable/i.test(
    message,
  );
}
export interface MediaSourceProvider {
  resolve(item: PlaylistItem, signal: AbortSignal): Promise<string>;
  retain?(ids: string[]): void;
  remove?(id: string): Promise<void>;
  close?(): Promise<void>;
}
export interface StreamOutputProvider {
  name: "youtube" | "twitch";
  args(settings: Settings, port: number): string[];
}
export class YouTubePlaylistProvider implements PlaylistProvider {
  constructor(
    private key: string,
    private request: typeof fetch = fetch,
  ) {}
  async channelUploads(value: string, signal: AbortSignal): Promise<string> {
    let identifier = value.trim(),
      kind = "forHandle";
    if (identifier.startsWith("https://")) {
      const url = new URL(identifier);
      if (
        !["youtube.com", "www.youtube.com", "m.youtube.com"].includes(
          url.hostname,
        )
      )
        throw new Error("Use a YouTube channel URL");
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "channel") {
        kind = "id";
        identifier = parts[1] ?? "";
      } else if (parts[0] === "user") {
        kind = "forUsername";
        identifier = parts[1] ?? "";
      } else if (parts[0]?.startsWith("@"))
        identifier = decodeURIComponent(parts[0]);
      else throw new Error("Use a channel @handle or /channel/ URL");
    } else if (/^UC[A-Za-z0-9_-]{22}$/.test(identifier)) kind = "id";
    if (!identifier || identifier.includes("/") || identifier.length > 100)
      throw new Error("Invalid channel identifier");
    const data = await this.get(
      "channels",
      { part: "contentDetails", [kind]: identifier },
      signal,
    );
    const uploads = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) throw new Error("Channel not found or uploads unavailable");
    return uploads;
  }
  private async get(
    resource: string,
    params: Record<string, string>,
    signal: AbortSignal,
  ): Promise<any> {
    if (!this.key) throw new Error("YouTube API key is not configured");
    const url = new URL("https://www.googleapis.com/youtube/v3/" + resource);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const response = await this.request(url, {
      headers: { "X-Goog-Api-Key": this.key },
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    if (!response.ok)
      throw new Error(
        "YouTube API request failed (HTTP " + response.status + ")",
      );
    return response.json();
  }
  async fetch(
    playlistId: string,
    signal: AbortSignal,
  ): Promise<PlaylistItem[]> {
    const items: PlaylistItem[] = [];
    let token = "";
    const seen = new Set<string>();
    do {
      const data = await this.get(
        "playlistItems",
        {
          part: "snippet,contentDetails",
          playlistId,
          maxResults: "50",
          ...(token ? { pageToken: token } : {}),
        },
        signal,
      );
      if (!Array.isArray(data.items))
        throw new Error("Malformed playlist response");
      for (const row of data.items) {
        const s = row.snippet;
        if (!row.id || !s || !Number.isInteger(s.position))
          throw new Error("Malformed playlist item");
        items.push({
          id: row.id,
          videoId: row.contentDetails?.videoId ?? "",
          position: s.position,
          title: String(s.title ?? "Unavailable video").slice(0, 500),
          channel: String(s.videoOwnerChannelTitle ?? "").slice(0, 200),
          thumbnail: s.thumbnails?.medium?.url ?? "",
          available: true,
          duration: null,
        });
      }
      token = data.nextPageToken ?? "";
      if (token && seen.has(token))
        throw new Error("Repeated YouTube pagination token");
      seen.add(token);
      if (items.length > 100000)
        throw new Error("Playlist exceeds 100000 item safety limit");
    } while (token);
    // videos.list distinguishes deleted/private entries and supplies duration; duplicates remain distinct.
    const ids = [...new Set(items.map((i) => i.videoId).filter(Boolean))];
    const videos = new Map<string, any>();
    for (let n = 0; n < ids.length; n += 50) {
      const data = await this.get(
        "videos",
        {
          part: "contentDetails,status,snippet,liveStreamingDetails",
          id: ids.slice(n, n + 50).join(","),
        },
        signal,
      );
      if (!Array.isArray(data.items))
        throw new Error("Malformed video response");
      for (const v of data.items) videos.set(v.id, v);
    }
    for (const item of items) {
      const v = videos.get(item.videoId);
      const broadcast = v?.snippet?.liveBroadcastContent;
      item.liveStatus =
        broadcast === "live"
          ? "live"
          : broadcast === "upcoming"
            ? "upcoming"
            : v?.liveStreamingDetails?.actualEndTime
              ? "past"
              : "none";
      item.available =
        !!v &&
        v.status?.privacyStatus !== "private" &&
        item.liveStatus !== "live" &&
        item.liveStatus !== "upcoming";
      item.duration = v ? parseDuration(v.contentDetails?.duration) : null;
      item.publishedAt = v?.snippet?.publishedAt ?? "";
      const shortMetadata = [
        v?.snippet?.title,
        v?.snippet?.description,
        ...(Array.isArray(v?.snippet?.tags) ? v.snippet.tags : []),
      ].join(" ");
      // The Data API has no Shorts boolean. A Shorts marker plus the Shorts
      // duration limit is the strongest signal available in this sync data.
      item.isShort =
        item.duration !== null &&
        item.duration <= 180 &&
        /(^|\s)#shorts?\b/i.test(shortMetadata);
      const restriction = v?.contentDetails?.regionRestriction;
      item.regionRestricted =
        !!restriction &&
        ((Array.isArray(restriction.allowed) && restriction.allowed.length >= 0) ||
          (Array.isArray(restriction.blocked) && restriction.blocked.length > 0));
      item.embeddable = v?.status?.embeddable !== false;
    }
    return items.sort((a, b) => a.position - b.position);
  }
}
export function parseDuration(value: string | undefined): number | null {
  const m = value?.match(
    /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/,
  );
  return m
    ? Number(m[1] ?? 0) * 86400 +
        Number(m[2] ?? 0) * 3600 +
        Number(m[3] ?? 0) * 60 +
        Number(m[4] ?? 0)
    : null;
}
export async function containedFile(
  root: string,
  name: string,
): Promise<string> {
  const base = await realpath(root),
    file = await realpath(path.resolve(base, name));
  const rel = path.relative(base, file);
  if (
    rel.startsWith("..") ||
    path.isAbsolute(rel) ||
    !(await stat(file)).isFile()
  )
    throw new Error("Media path is outside the permitted directory");
  return file;
}
export class LocalMediaSource implements MediaSourceProvider {
  constructor(private root: string) {}
  async resolve(item: PlaylistItem, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(item.videoId))
      throw new Error("Invalid video identifier");
    for (const ext of ["mp4", "mkv", "webm", "mov"])
      try {
        return await containedFile(this.root, item.videoId + "." + ext);
      } catch {}
    throw new Error("Local media file is unavailable");
  }
}
export class ExperimentalYouTubeSource implements MediaSourceProvider {
  private lifetime = new AbortController();
  private pending = new Map<string, Promise<string>>();
  private retained = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private cookiesRejected = false;
  constructor(
    private c: Config,
    private run: typeof runCapture = runCapture,
    private quality: Pick<Settings, "height" | "fps"> = { height: 720, fps: 30 },
    private hooks: MediaSourceHooks = {},
  ) {}
  retain(ids: string[]) { this.retained = new Set(ids.map((id) => this.cacheName(id))); }
  async remove(id: string) {
    const root = path.join(this.c.DATA_DIR, "cache");
    await mkdir(root, { recursive: true });
    await this.cleanup(root, id);
  }
  async resolve(item: PlaylistItem, signal: AbortSignal): Promise<string> {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    signal.throwIfAborted();
    const root = path.join(this.c.DATA_DIR, "cache");
    await mkdir(root, { recursive: true });
    const cached = await this.cachedFile(root, item.videoId);
    if (cached) return cached;
    const existing = this.pending.get(item.videoId);
    if (existing) return withCancellation(existing, signal);
    this.hooks.onDownload?.(this.activity(item, "queued", 0, 0));
    const task = this.queue.then(() => this.download(item, signal)).finally(() => this.pending.delete(item.videoId));
    this.queue = task.catch(() => {});
    this.pending.set(item.videoId, task);
    return withCancellation(task, signal);
  }
  async close() { this.lifetime.abort(); await this.queue; }
  private activity(item: PlaylistItem, status: DownloadActivity["status"], percent: number | null, attempt: number, extra: Partial<DownloadActivity> = {}): DownloadActivity {
    return { videoId: item.videoId, title: item.title, thumbnail: item.thumbnail, percent, status, attempt, ...extra };
  }
  private cacheName(id: string) { return id + "." + this.quality.height + "p" + this.quality.fps; }
  private async cachedFile(root: string, id: string) {
    for (const ext of ["mp4", "mkv", "webm"]) try { return await containedFile(root, this.cacheName(id) + "." + ext); } catch {}
    return "";
  }
  private async removeCached(root: string, name: string) {
    await rm(path.join(root, name), { force: true });
    this.hooks.onDelete?.(name);
  }
  private async cleanup(root: string, id: string) {
    const base = this.cacheName(id) + ".";
    for (const name of await readdir(root)) if (name.startsWith(base)) await this.removeCached(root, name);
  }
  private async download(item: PlaylistItem, signal: AbortSignal) {
    if (!this.c.EXPERIMENTAL_YOUTUBE) throw new Error("Experimental YouTube source is disabled");
    if (!/^[A-Za-z0-9_-]{11}$/.test(item.videoId)) throw new Error("Invalid YouTube video identifier");
    const root = path.join(this.c.DATA_DIR, "cache");
    await mkdir(root, { recursive: true });
    const cacheLimit = this.c.CACHE_MAX_MB * 1024 * 1024;
    // Leave room for the rolling buffer instead of allowing one unusually
    // large video to consume the entire configured cache.
    const perVideoLimit = Math.floor(cacheLimit / 2);
    const requested = this.cacheName(item.videoId);
    for (const name of await readdir(root))
      if (![...this.retained].some((base) => name.startsWith(base + ".")) && !name.startsWith(requested + "."))
        await this.removeCached(root, name);
    const cached = await this.cachedFile(root, item.videoId);
    if (cached) return cached;
    let lastError: unknown;
    let finalAttempt = 0;
    let usePublicClients = !this.c.YTDLP_COOKIES_FILE || this.cookiesRejected;
    let retryImmediately = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      finalAttempt = attempt;
      signal.throwIfAborted();
      if (attempt > 1) {
        this.hooks.onDownload?.(this.activity(item, "retrying", 0, attempt));
        if (!retryImmediately)
          await delay(Math.min(15000, 3000 * attempt), signal);
        retryImmediately = false;
      }
      await this.cleanup(root, item.videoId);
      try {
        const file = await this.downloadAttempt(
          root,
          item,
          cacheLimit,
          perVideoLimit,
          attempt,
          signal,
          usePublicClients,
        );
        this.hooks.onDownload?.(this.activity(item, "downloaded", 100, attempt, { bytes: (await stat(file)).size }));
        return file;
      } catch (error) {
        lastError = error;
        await this.cleanup(root, item.videoId);
        if (signal.aborted) throw error;
        const message =
          error instanceof Error ? error.message : "Media download failed";
        if (
          this.c.YTDLP_COOKIES_FILE &&
          !usePublicClients &&
          /account verification|sign in|cookies|login required/i.test(message)
        ) {
          // A stale authenticated session should not poison the whole queue.
          // Subsequent attempts use public clients and retain ordinary bounded
          // retries for temporary network failures.
          this.cookiesRejected = true;
          usePublicClients = true;
          retryImmediately = true;
          continue;
        }
        if (!isRetryableDownloadFailure(message)) break;
      }
    }
    const message = lastError instanceof Error ? lastError.message : "Media download failed";
    this.hooks.onDownload?.(
      this.activity(item, "failed", null, finalAttempt || 1, {
        error: message,
      }),
    );
    throw new Error(message);
  }
  private async downloadAttempt(
    root: string,
    item: PlaylistItem,
    cacheLimit: number,
    perVideoLimit: number,
    attempt: number,
    signal: AbortSignal,
    usePublicClients = false,
  ) {
    let lastProgress = Date.now();
    let lastBytes = 0;
    let lastPercent = -1;
    this.hooks.onDownload?.(this.activity(item, "downloading", 0, attempt));
    await this.run(
      this.c.YTDLP_PATH,
      [
       "--ignore-config",
       ...(
         this.c.YTDLP_COOKIES_FILE && !usePublicClients
           ? [
               "--cookies",
               this.c.YTDLP_COOKIES_FILE,
               "--extractor-args",
               "youtube:player_client=default,web_embedded",
             ]
           : usePublicClients
             ? [
                 "--extractor-args",
                 "youtube:player_client=android_vr,web_embedded",
               ]
             : []
       ),
       "--no-playlist", "--newline", "--progress", "--no-color",
       "--progress-template", "download:idlecast:%(progress._percent_str)s", "--no-cache-dir",
       "--concurrent-fragments", "4", "--buffer-size", "1M", "--no-resize-buffer",
       "--js-runtimes", "node:" + process.execPath, "--max-filesize", String(perVideoLimit),
       "--socket-timeout", "20", "--retries", "2", "--fragment-retries", "2",
       "--ffmpeg-location", this.c.FFMPEG_PATH, "--merge-output-format", "mp4",
       "-f", "bv*[height<=" + this.quality.height + "]+ba/b[height<=" + this.quality.height + "]",
       "-S", "res:" + this.quality.height + ",fps:" + this.quality.fps,
       "-o", path.join(root, this.cacheName(item.videoId) + ".%(ext)s"), "--",
       "https://www.youtube.com/watch?v=" + item.videoId],
      signal, 43200000,
      async () => {
        let total = 0;
        let requestedBytes = 0;
        const requested = this.cacheName(item.videoId) + ".";
        for (const name of await readdir(root)) {
          try {
            const size = (await stat(path.join(root, name))).size;
            total += size;
            if (name.startsWith(requested)) requestedBytes += size;
          } catch (error: any) {
            if (error.code !== "ENOENT") throw error;
          }
        }
        if (total > cacheLimit) throw new Error("Media cache limit exceeded");
        if (requestedBytes > perVideoLimit)
          throw new Error("Video exceeds the configured per-video cache limit");
        if (requestedBytes > lastBytes) {
          lastBytes = requestedBytes;
          lastProgress = Date.now();
          this.hooks.onDownload?.(this.activity(item, "downloading", null, attempt, { bytes: requestedBytes }));
        }
        if (Date.now() - lastProgress > 120000) throw new Error("Download stalled with no meaningful progress for 2 minutes");
      },
      (chunk) => {
        for (const match of chunk.matchAll(/idlecast:\s*([0-9.]+)%/g)) {
          const percent = Number(match[1]);
          if (Number.isFinite(percent) && percent > lastPercent) {
            lastPercent = percent;
            lastProgress = Date.now();
            this.hooks.onDownload?.(this.activity(item, "downloading", Math.max(0, Math.min(100, percent)), attempt, { bytes: lastBytes }));
          }
        }
      },
    );
    const file = await this.cachedFile(root, item.videoId);
    if (!file) throw new Error("Download produced no merged media; check FFmpeg location and cache limit");
    if ((await stat(file)).size > perVideoLimit) {
      await this.removeCached(root, path.basename(file));
      throw new Error("Video exceeds the configured per-video cache limit");
    }
    return file;
  }
}
export class RtmpOutput implements StreamOutputProvider {
  constructor(
    public name: "youtube" | "twitch",
    private key: string,
  ) {}
  args(s: Settings, port: number) {
    if (!this.key)
      throw new Error("Stream key is not configured for " + this.name);
    const target = s[this.name].server.replace(/\/$/, "") + "/" + this.key;
    return [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-fflags",
      "+genpts+discardcorrupt",
      "-thread_queue_size",
      "8192",
      "-i",
      "udp://127.0.0.1:" +
        port +
        "?buffer_size=4194304&fifo_size=262144&overrun_nonfatal=1",
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-c",
      "copy",
      "-f",
      "flv",
      "-flvflags",
      "no_duration_filesize",
      "-rw_timeout",
      "15000000",
      target,
    ];
  }
}
