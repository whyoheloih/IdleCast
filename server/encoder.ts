import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config, Settings } from "./config.js";
import type { PlaylistItem } from "./providers.js";
import { launch, completion, delay } from "./process.js";
import { filterPath, overlay } from "./overlay.js";

export function audioSampleRate(s: Settings): 44100 | 48000 {
  // YouTube stereo ingest and playback use 44.1 kHz. Avoid a long-running
  // 48 -> 44.1 kHz clock conversion when YouTube is the only destination.
  return s.youtube.enabled && !s.twitch.enabled ? 44100 : 48000;
}

export function loadingText(
  activity: { percent: number | null } | null,
): string {
  const percent = activity?.percent;
  if (percent === null || percent === undefined)
    return "Preparing next video...\n[░░░░░░░░░░░░░░░░░░░░]";
  const normalized = Math.max(0, Math.min(100, percent));
  const filled = Math.round(normalized / 5);
  const label =
    normalized >= 100
      ? "Finalizing next video..."
      : "Downloading next video...";
  return `${label}\n[${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${Math.round(normalized)}%`;
}

function loadingFile(c: Config) {
  return path.join(c.DATA_DIR, "overlay", "loading.txt");
}

function upNextTitleFile(c: Config) {
  return path.join(c.DATA_DIR, "overlay", "up-next.txt");
}

function upNextThumbnailFile(c: Config) {
  return path.join(c.DATA_DIR, "overlay", "up-next.jpg");
}

function wrapTitle(value: string, width = 34) {
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  for (const word of words) {
    const line = lines.at(-1);
    if (!line || line.length + word.length + 1 > width) lines.push(word);
    else lines[lines.length - 1] += " " + word;
  }
  return lines.slice(0, 4).join("\n");
}

export async function writeLoadingItem(c: Config, item: PlaylistItem) {
  const title = upNextTitleFile(c);
  const thumbnail = upNextThumbnailFile(c);
  await mkdir(path.dirname(title), { recursive: true });
  await writeFile(title, wrapTitle(item.title));
  try {
    const url = new URL(item.thumbnail);
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "i.ytimg.com" || url.hostname.endsWith(".ytimg.com"))
    )
      throw new Error("Unsupported thumbnail host");
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Thumbnail request failed");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 5 * 1024 * 1024)
      throw new Error("Thumbnail is too large");
    await writeFile(thumbnail, bytes);
  } catch {
    await rm(thumbnail, { force: true });
  }
}

export async function writeLoadingStatus(
  c: Config,
  activity: { percent: number | null } | null,
) {
  const file = loadingFile(c);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, loadingText(activity));
}

export function encodeArgs(
  s: Settings,
  basePort: number,
  offset: number,
): string[] {
  const destinations = (["youtube", "twitch"] as const).flatMap((name, n) =>
    s[name].enabled
      ? [
          "[f=mpegts:mpegts_flags=+initial_discontinuity:onfail=ignore]udp://127.0.0.1:" +
            (basePort + n) +
            "?pkt_size=1316&buffer_size=4194304",
        ]
      : [],
  );
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-b:v",
    s.bitrateKbps + "k",
    "-maxrate",
    s.bitrateKbps + "k",
    "-bufsize",
    s.bitrateKbps * 2 + "k",
    "-g",
    String(s.fps * 2),
    "-keyint_min",
    String(s.fps * 2),
    "-sc_threshold",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    String(audioSampleRate(s)),
    "-ac",
    "2",
    "-output_ts_offset",
    String(offset),
    "-f",
    "tee",
    destinations.join("|"),
  ];
}
export function standby(
  c: Config,
  s: Settings,
  epoch: number,
  signal: AbortSignal,
  onError: () => void,
) {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const task = (async () => {
    await delay(1000, combined);
    while (!combined.aborted) {
      try {
        const loading = loadingFile(c);
        await mkdir(path.dirname(loading), { recursive: true });
        await writeFile(loading, loadingText(null), { flag: "wx" }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          },
        );
        await writeFile(
          upNextTitleFile(c),
          "The next video is being prepared",
          { flag: "wx" },
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        const ov = await overlay(c, s);
        const cat = path.resolve("media", "loading-cat.gif");
        const thumbnail = upNextThumbnailFile(c);
        const title = upNextTitleFile(c);
        const hasThumbnail = existsSync(thumbnail);
        const overlayInputCount = ov.inputs.filter(
          (arg) => arg === "-i",
        ).length;
        const catIndex = 2 + overlayInputCount;
        const thumbnailIndex = catIndex + 1;
        const catSize = Math.round(s.height * 0.25);
        const thumbWidth = Math.round(s.width * 0.34);
        const thumbHeight = Math.round(s.height * 0.38);
        const statusSize = Math.max(22, Math.round(s.height / 34));
        const titleSize = Math.max(22, Math.round(s.height / 32));
        const border = Math.max(2, Math.round(statusSize / 12));
        const style =
          "fontfile='" +
          filterPath(c.FONT_FILE) +
          "':expansion=none:fontcolor=white:bordercolor=black:borderw=" +
          border;
        const thumbnailLayer = hasThumbnail
          ? ";[" +
            thumbnailIndex +
            ":v:0]scale=" +
            thumbWidth +
            ":" +
            thumbHeight +
            ":force_original_aspect_ratio=decrease,pad=" +
            thumbWidth +
            ":" +
            thumbHeight +
            ":(ow-iw)/2:(oh-ih)/2:color=0x171a1f[upNextThumb]" +
            ";[v][upNextThumb]overlay=x=w*0.07:y=h*0.22:shortest=0[leftLayer]"
          : ";[v]null[leftLayer]";
        const standbyFilter =
          ov.filter +
          thumbnailLayer +
          ";[" +
          catIndex +
          ":v:0]scale=" +
          catSize +
          ":" +
          catSize +
          ":force_original_aspect_ratio=decrease,format=rgba[loadingCat]" +
          ";[leftLayer][loadingCat]overlay=x=W*0.68-w/2:y=H*0.28-h/2:shortest=0:eof_action=repeat[catLayer]" +
          ";[catLayer]drawtext=" +
          style +
          ":text='UP NEXT':fontsize=" +
          Math.round(titleSize * 0.72) +
          ":x=w*0.07:y=h*0.13[labelLayer]" +
          ";[labelLayer]drawtext=" +
          style +
          ":textfile='" +
          filterPath(title) +
          "':fontsize=" +
          titleSize +
          ":line_spacing=" +
          Math.round(titleSize * 0.32) +
          ":x=w*0.07:y=h*0.63[titleLayer]" +
          ";[titleLayer]drawtext=" +
          style +
          ":textfile='" +
          filterPath(loading) +
          "':reload=1:fontsize=" +
          statusSize +
          ":line_spacing=" +
          Math.round(statusSize * 0.4) +
          ":x=w*0.68-tw/2:y=h*0.60[standby]";
        const child = launch(
          c.FFMPEG_PATH,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-re",
            "-f",
            "lavfi",
            "-i",
            `color=c=0x101216:s=${s.width}x${s.height}:r=${s.fps}`,
            "-f",
            "lavfi",
            "-i",
            `anullsrc=r=${audioSampleRate(s)}:cl=stereo`,
            ...ov.inputs,
            "-stream_loop",
            "-1",
            "-i",
            cat,
            ...(hasThumbnail ? ["-loop", "1", "-i", thumbnail] : []),
            "-filter_complex",
            standbyFilter,
            "-map",
            "[standby]",
            "-map",
            "1:a:0",
            ...encodeArgs(s, c.UDP_BASE_PORT, (Date.now() - epoch) / 1000),
          ],
          combined,
        );
        child.stdout?.resume();
        await completion(child);
        if (combined.aborted) break;
        onError();
      } catch {
        if (combined.aborted) break;
        onError();
      }
      await delay(5000, combined);
    }
  })().catch(() => {});
  return {
    stop: async () => {
      controller.abort();
      await task;
    },
  };
}
