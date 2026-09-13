import { realpath, stat, readdir, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Config, Settings } from "./config.js";
import { runCapture, withCancellation } from "./process.js";

export type PlaylistItem = {
  id: string;
  videoId: string;
  position: number;
  title: string;
  channel: string;
  thumbnail: string;
  available: boolean;
  duration: number | null;
};
export interface PlaylistProvider {
  fetch(playlistId: string, signal: AbortSignal): Promise<PlaylistItem[]>;
}
export interface MediaSourceProvider {
  resolve(item: PlaylistItem, signal: AbortSignal): Promise<string>;
  pin?(id: string): void;
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
          part: "contentDetails,status,snippet",
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
      item.available =
        !!v &&
        v.status?.privacyStatus !== "private" &&
        v.snippet?.liveBroadcastContent !== "live";
      item.duration = v ? parseDuration(v.contentDetails?.duration) : null;
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
  private pinned = "";
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private c: Config,
    private run: typeof runCapture = runCapture,
  ) {}
  pin(id: string) {
    this.pinned = id;
  }
  resolve(item: PlaylistItem, signal: AbortSignal): Promise<string> {
    signal = AbortSignal.any([signal, this.lifetime.signal]);
    const existing = this.pending.get(item.videoId);
    if (existing) return withCancellation(existing, signal);
    const task = this.queue
      .then(() => {
        signal.throwIfAborted();
        return this.download(item, signal);
      })
      .finally(() => this.pending.delete(item.videoId));
    this.queue = task.catch(() => {});
    this.pending.set(item.videoId, task);
    return withCancellation(task, signal);
  }
  async close() {
    this.lifetime.abort();
    await this.queue;
  }
  private async download(item: PlaylistItem, signal: AbortSignal) {
    if (!this.c.EXPERIMENTAL_YOUTUBE)
      throw new Error("Experimental YouTube source is disabled");
    if (!/^[A-Za-z0-9_-]{11}$/.test(item.videoId))
      throw new Error("Invalid YouTube video identifier");
    const root = path.join(this.c.DATA_DIR, "cache");
    await mkdir(root, { recursive: true });
    const limit = this.c.CACHE_MAX_MB * 1024 * 1024;
    for (const ext of ["mp4", "mkv", "webm"])
      try {
        return await containedFile(root, item.videoId + "." + ext);
      } catch {}
    // Keep only the playing file and next download. Each file may consume at most half the cache.
    for (const name of await readdir(root))
      if (
        !name.startsWith(this.pinned + ".") &&
        !name.startsWith(item.videoId + ".")
      )
        await rm(path.join(root, name), { force: true });
    try {
      await this.run(
        this.c.YTDLP_PATH,
        [
          "--ignore-config",
          "--no-playlist",
          "--no-progress",
          "--no-warnings",
          "--no-cache-dir",
          "--js-runtimes",
          "node",
          "--max-filesize",
          String(Math.floor(limit / 2)),
          "--socket-timeout",
          "20",
          "--retries",
          "2",
          "--fragment-retries",
          "2",
          "--ffmpeg-location",
          this.c.FFMPEG_PATH,
          "--merge-output-format",
          "mp4",
          "-f",
          "bv*[height<=720]+ba/b[height<=720]",
          "-o",
          path.join(root, item.videoId + ".%(ext)s"),
          "--",
          "https://www.youtube.com/watch?v=" + item.videoId,
        ],
        signal,
        600000,
        async () => {
          let size = 0;
          for (const name of await readdir(root)) {
            try {
              size += (await stat(path.join(root, name))).size;
            } catch (e: any) {
              if (e.code !== "ENOENT") throw e;
            }
          }
          if (size > limit) throw new Error("Media cache limit exceeded");
        },
      );
    } catch (e) {
      for (const name of await readdir(root))
        if (name.startsWith(item.videoId + "."))
          await rm(path.join(root, name), { force: true });
      throw e;
    }
    for (const ext of ["mp4", "mkv", "webm"])
      try {
        const file = await containedFile(root, item.videoId + "." + ext);
        if ((await stat(file)).size > limit / 2) {
          await rm(file);
          throw new Error("Media exceeds per-item cache limit");
        }
        return file;
      } catch {}
    throw new Error("Experimental adapter did not return a playable file");
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
      "error",
      "-fflags",
      "+genpts+discardcorrupt",
      "-i",
      "udp://127.0.0.1:" + port + "?fifo_size=65536&overrun_nonfatal=1",
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
