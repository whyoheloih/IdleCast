import { createHash } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { PlaylistItem, PlaylistProvider } from "./providers.js";
import { runCapture } from "./process.js";

export type KnownYouTubeMetadata = Record<string, {
  title: string;
  channel: string;
  thumbnail: string;
  publishedAt: string;
  duration: number | null;
}>;
export type LocalScanIssue = {
  file: string;
  message: string;
};
const supported = new Set([".mp4", ".mkv", ".webm", ".mov"]);
const normalizedIdentityPath = (value: string) =>
  (process.platform === "win32" ? path.normalize(value).toLocaleLowerCase() : path.normalize(value));
export const localFileIdentity = (value: string) =>
  createHash("sha256").update(normalizedIdentityPath(value)).digest("hex").slice(0, 32);
export const localFolderIdentity = (value: string) =>
  createHash("sha256").update(normalizedIdentityPath(path.resolve(value))).digest("hex").slice(0, 32);
export function youtubeIdFromFilename(value: string) {
  const base = path.basename(value, path.extname(value));
  return base.match(/\[([A-Za-z0-9_-]{11})\]\s*$/)?.[1] ?? "";
}
export function localTitle(value: string) {
  const base = path.basename(value, path.extname(value))
    .replace(/\s*\[[A-Za-z0-9_-]{11}\]\s*$/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return base || "Untitled local video";
}
function frameRate(stream: any) {
  const value = String(stream.avg_frame_rate || stream.r_frame_rate || "");
  return value === "0/0" ? "" : value;
}
async function mediaFiles(root: string, signal: AbortSignal, issues: LocalScanIssue[]) {
  const found: string[] = [];
  const visit = async (directory: string) => {
    signal.throwIfAborted();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === root) throw error;
      issues.push({ file: directory, message: `Local catalog scan failed for a nested directory: ${error instanceof Error ? error.message : "unknown error"}` });
      return;
    }
    for (const entry of entries) {
      signal.throwIfAborted();
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && supported.has(path.extname(entry.name).toLocaleLowerCase())) found.push(absolute);
    }
  };
  await visit(root);
  return found;
}

export class LocalFolderPlaylistProvider implements PlaylistProvider {
  issues: LocalScanIssue[] = [];
  catalogOrder: string[] = [];
  constructor(
    private root: string,
    private ffprobePath: string,
    private previousOrder: string[] = [],
    private youtubeMetadata: KnownYouTubeMetadata = {},
  ) {}
  async fetch(_source: string, signal: AbortSignal): Promise<PlaylistItem[]> {
    if (!this.root.trim()) throw new Error("Local media folder is not configured");
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(path.resolve(this.root));
      if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("Path is not a directory");
    } catch (error) {
      throw new Error(`Local media folder unavailable or external drive disconnected: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    const files = await mediaFiles(canonicalRoot, signal, this.issues);
    const byIdentity = new Map(files.map((file) => [localFileIdentity(file), file]));
    const retainedOrder = this.previousOrder.filter((identity) => byIdentity.has(identity));
    const newIdentities = [...byIdentity.keys()]
      .filter((identity) => !this.previousOrder.includes(identity))
      .sort((a, b) => path.relative(canonicalRoot, byIdentity.get(a)!).localeCompare(path.relative(canonicalRoot, byIdentity.get(b)!)));
    this.catalogOrder = [...this.previousOrder, ...newIdentities];
    const activeOrder = [...retainedOrder, ...newIdentities];
    const items: PlaylistItem[] = [];
    for (const [position, identity] of activeOrder.entries()) {
      signal.throwIfAborted();
      const file = byIdentity.get(identity)!;
      try {
        const raw = await runCapture(this.ffprobePath, [
          "-v", "error",
          "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate:format=duration",
          "-of", "json",
          file,
        ], signal, 30000);
        const info = JSON.parse(raw);
        const video = info.streams?.find((stream: any) => stream.codec_type === "video");
        if (!video) throw new Error("No playable video stream");
        const duration = Number(info.format?.duration);
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("Media must have a finite duration");
        const audio = info.streams?.find((stream: any) => stream.codec_type === "audio");
        const youtubeVideoId = youtubeIdFromFilename(file);
        const known = youtubeVideoId ? this.youtubeMetadata[youtubeVideoId] : undefined;
        items.push({
          id: `local-entry:${identity}`,
          videoId: `local:${identity}`,
          position,
          title: known?.title || localTitle(file),
          channel: known?.channel || "",
          thumbnail: known?.thumbnail || "",
          available: true,
          duration,
          publishedAt: known?.publishedAt || "",
          liveStatus: "none",
          isShort: false,
          sourceType: "local",
          localIdentity: identity,
          localPath: file,
          youtubeVideoId,
          videoWidth: Number(video.width) || null,
          videoHeight: Number(video.height) || null,
          frameRate: frameRate(video),
          videoCodec: String(video.codec_name || ""),
          audioCodec: String(audio?.codec_name || ""),
          hasAudio: !!audio,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "FFprobe validation failed";
        const unsupported = /No playable video stream|finite duration/i.test(detail);
        this.issues.push({
          file,
          message: `${unsupported ? "Unsupported local media" : "Local FFprobe validation failed"}: ${path.relative(canonicalRoot, file)} — ${detail}`,
        });
      }
    }
    return items;
  }
}
