import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readdir, stat } from "node:fs/promises";
import { runCapture } from "./process.js";
import type { Config } from "./config.js";
import type { Store, StoredItem } from "./db.js";

export type FallbackMedia = {
  id: string;
  path: string;
  title: string;
  duration: number;
  available: boolean;
  compatible: boolean;
  lastPlayedAt: number | null;
  playCount: number;
  size: number;
  modifiedAt: number;
  error: string | null;
};

export type RecoveryIncident = {
  id: string;
  intendedEntryId: string;
  intendedVideoId: string;
  intendedTitle: string;
  intendedItem: StoredItem;
  ownership: "normal" | "marathon" | "normal-handoff";
  marathonId: string | null;
  marathonEntryId: string | null;
  status: "recovering" | "paused" | "recovered" | "exhausted" | "cancelled";
  sourceType: "youtube" | "local";
  originalFailure: string;
  attempts: number;
  lastError: string;
  currentFallbackId: string | null;
  consecutiveFallbackCount: number;
  startedAt: number;
  lastAttemptAt: number | null;
  completedAt: number | null;
  preparedKey: string;
};

const supported = new Set([".mp4", ".mkv", ".webm", ".mov"]);
const cleanTitle = (file: string) => path.basename(file, path.extname(file)).replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();

export class EmergencyFallbackCatalog {
  readonly directory: string;
  private lastScan = 0;
  constructor(private store: Store, private config: Config) {
    this.directory = path.join(config.DATA_DIR, "emergency-fallback");
  }

  private saved() {
    return this.store.get<Record<string, FallbackMedia>>("emergencyFallbackCatalog", {});
  }

  async scan(force = false) {
    if (!force && Date.now() - this.lastScan < 60000)
      return this.snapshot();
    await mkdir(this.directory, { recursive: true });
    const prior = this.saved();
    const next: Record<string, FallbackMedia> = {};
    for (const name of await readdir(this.directory)) {
      const file = path.join(this.directory, name);
      const extension = path.extname(name).toLowerCase();
      if (!supported.has(extension)) continue;
      const identity = createHash("sha256").update(path.resolve(file).toLocaleLowerCase()).digest("hex").slice(0, 32);
      const before = prior[identity];
      try {
        const details = await stat(file);
        if (!details.isFile()) continue;
        if (before?.compatible && before.size === details.size && before.modifiedAt === details.mtimeMs) {
          next[identity] = { ...before, path: file, available: true };
          continue;
        }
        const info = JSON.parse(await runCapture(
          this.config.FFPROBE_PATH,
          ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file],
          AbortSignal.timeout(30000),
        ));
        const duration = Number(info.format?.duration);
        if (!info.streams?.some((stream: any) => stream.codec_type === "video") || !Number.isFinite(duration) || duration <= 0)
          throw new Error("FFprobe found no finite playable video stream");
        next[identity] = {
          id: identity,
          path: file,
          title: cleanTitle(file) || "Emergency fallback",
          duration,
          available: true,
          compatible: true,
          lastPlayedAt: before?.lastPlayedAt ?? null,
          playCount: before?.playCount ?? 0,
          size: details.size,
          modifiedAt: details.mtimeMs,
          error: null,
        };
      } catch (error) {
        const details = await stat(file).catch(() => null);
        next[identity] = {
          id: identity,
          path: file,
          title: cleanTitle(file) || "Invalid fallback media",
          duration: before?.duration ?? 0,
          available: !!details,
          compatible: false,
          lastPlayedAt: before?.lastPlayedAt ?? null,
          playCount: before?.playCount ?? 0,
          size: details?.size ?? 0,
          modifiedAt: details?.mtimeMs ?? 0,
          error: error instanceof Error ? error.message : "Fallback validation failed",
        };
      }
    }
    for (const [id, entry] of Object.entries(prior))
      if (!next[id]) next[id] = { ...entry, available: false, error: "File is currently missing" };
    this.store.set("emergencyFallbackCatalog", next);
    this.store.set("emergencyFallbackLastScan", Date.now());
    this.lastScan = Date.now();
    return this.snapshot();
  }

  snapshot() {
    const entries = Object.values(this.saved()).sort((a, b) =>
      Number(b.available && b.compatible) - Number(a.available && a.compatible) ||
      a.playCount - b.playCount ||
      (a.lastPlayedAt ?? 0) - (b.lastPlayedAt ?? 0) ||
      a.title.localeCompare(b.title),
    );
    return {
      directory: this.directory,
      available: entries.some((entry) => entry.available && entry.compatible),
      validCount: entries.filter((entry) => entry.available && entry.compatible).length,
      invalidCount: entries.filter((entry) => entry.available && !entry.compatible).length,
      lastScan: this.store.get("emergencyFallbackLastScan", 0),
      entries,
    };
  }

  async choose(lastId: string | null) {
    const catalog = await this.scan();
    const valid = catalog.entries.filter((entry) => entry.available && entry.compatible);
    if (!valid.length) return null;
    const alternatives = valid.length > 1 && lastId ? valid.filter((entry) => entry.id !== lastId) : valid;
    return alternatives.sort((a, b) =>
      a.playCount - b.playCount ||
      (a.lastPlayedAt ?? 0) - (b.lastPlayedAt ?? 0) ||
      Math.random() - 0.5,
    )[0] ?? null;
  }

  markPlayed(id: string) {
    const catalog = this.saved();
    const entry = catalog[id];
    if (!entry) return;
    catalog[id] = { ...entry, playCount: entry.playCount + 1, lastPlayedAt: Date.now(), available: true };
    this.store.set("emergencyFallbackCatalog", catalog);
  }

  markInvalid(id: string, message: string) {
    const catalog = this.saved();
    const entry = catalog[id];
    if (!entry) return;
    catalog[id] = { ...entry, compatible: false, error: message.slice(0, 1000) };
    this.store.set("emergencyFallbackCatalog", catalog);
  }

  fallbackItem(entry: FallbackMedia): StoredItem {
    return {
      id: "fallback:" + entry.id,
      videoId: "fallback:" + entry.id,
      position: -1,
      title: entry.title,
      channel: "Emergency Fallback",
      thumbnail: "",
      available: true,
      duration: entry.duration,
      publishedAt: "",
      liveStatus: "none",
      failures: 0,
      failureCount: 0,
      retryAt: 0,
      error: null,
      seriesKey: "",
      seriesIndex: null,
      sourceType: "local",
      localIdentity: entry.id,
      localPath: entry.path,
      youtubeVideoId: undefined,
      isShort: false,
    };
  }
}

export function createRecoveryIncident(
  item: StoredItem,
  ownership: RecoveryIncident["ownership"],
  failure: string,
  attempts: number,
  preparedKey: string,
  marathonId: string | null,
  marathonEntryId: string | null,
): RecoveryIncident {
  const now = Date.now();
  return {
    id: randomUUID(),
    intendedEntryId: item.id,
    intendedVideoId: item.videoId,
    intendedTitle: item.title,
    intendedItem: item,
    ownership,
    marathonId,
    marathonEntryId,
    status: "recovering",
    sourceType: item.sourceType === "local" ? "local" : "youtube",
    originalFailure: failure.slice(0, 1000),
    attempts,
    lastError: failure.slice(0, 1000),
    currentFallbackId: null,
    consecutiveFallbackCount: 0,
    startedAt: now,
    lastAttemptAt: null,
    completedAt: null,
    preparedKey,
  };
}
