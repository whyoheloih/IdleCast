import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Config, Settings } from "./config.js";
import { overlay } from "./overlay.js";
import { launch, completion } from "./process.js";

export type PreviewSource = {
  file: string;
  offset: number;
  signal: AbortSignal;
  title?: string;
  publishedAt?: string;
  duration?: number;
};

// A single bounded render per instance prevents a preview from exhausting a small VPS.
export class OverlayPreview {
  private active: Promise<Buffer> | null = null;
  private lifetime = new AbortController();
  constructor(private config: Config) {}
  get busy() {
    return this.active !== null;
  }
  render(
    settings: Settings,
    source: PreviewSource | null,
    signal: AbortSignal,
  ) {
    if (this.active) throw new Error("Preview is busy");
    const combined = AbortSignal.any([
      signal,
      this.lifetime.signal,
      ...(source ? [source.signal] : []),
    ]);
    this.active = this.frame(settings, source, combined).finally(() => {
      this.active = null;
    });
    return this.active;
  }
  async close() {
    this.lifetime.abort();
    await this.active?.catch(() => {});
  }
  private async frame(
    settings: Settings,
    source: PreviewSource | null,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const root = path.join(this.config.DATA_DIR, "preview");
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(path.join(root, "frame-"));
    try {
      const ov = await overlay(
        this.config,
        source?.title
          ? { ...settings, overlay: { ...settings.overlay, title: source.title } }
          : settings,
        directory,
        source?.publishedAt,
        source?.duration
          ? { offset: source.offset, total: source.duration }
          : undefined,
      );
      const timeout = new AbortController();
      const combined = AbortSignal.any([signal, timeout.signal]);
      const child = launch(
        this.config.FFMPEG_PATH,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-threads",
          "1",
          ...(source
            ? ["-ss", String(source.offset), "-i", source.file]
            : [
                "-f",
                "lavfi",
                "-i",
                `color=c=0x101216:s=${settings.width}x${settings.height}:r=${settings.fps}`,
              ]),
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=48000:cl=stereo",
          ...ov.inputs,
          "-filter_complex_threads",
          "1",
          "-filter_complex",
          ov.filter,
          "-map",
          "[v]",
          "-frames:v",
          "1",
          "-an",
          "-c:v",
          "png",
          "-threads",
          "1",
          "-f",
          "image2pipe",
          "pipe:1",
        ],
        combined,
      );
      const chunks: Buffer[] = [];
      let bytes = 0;
      child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) timeout.abort();
        else chunks.push(chunk);
      });
      const timer = setTimeout(() => timeout.abort(), 8000);
      try {
        const code = await completion(child);
        combined.throwIfAborted();
        const data = Buffer.concat(chunks);
        if (
          code !== 0 ||
          data.length < 8 ||
          data.readUInt32BE(0) !== 0x89504e47
        )
          throw new Error("Preview could not be rendered");
        return data;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
