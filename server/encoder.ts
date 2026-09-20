import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config, Settings } from "./config.js";
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
  const label = normalized >= 100 ? "Finalizing next video..." : "Downloading next video...";
  return `${label}\n[${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${Math.round(normalized)}%`;
}

function loadingFile(c: Config) {
  return path.join(c.DATA_DIR, "overlay", "loading.txt");
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
        const ov = await overlay(c, s);
        const cat = path.resolve("media", "loading-cat.gif");
        const catIndex = ov.inputs.length ? 3 : 2;
        const catSize = Math.round(s.height * 0.24);
        const statusSize = Math.max(24, Math.round(s.height / 30));
        const statusStyle = `fontfile='${filterPath(c.FONT_FILE)}':expansion=none:fontcolor=white:bordercolor=black:borderw=${Math.max(2, Math.round(statusSize / 12))}`;
        const standbyFilter =
          ov.filter +
          `;[${catIndex}:v:0]scale=${catSize}:${catSize}:force_original_aspect_ratio=decrease,format=rgba[loadingCat]` +
          `;[v][loadingCat]overlay=x=(W-w)/2:y=(H-h)/2-${Math.round(s.height * 0.08)}:shortest=0:eof_action=repeat[catLayer]` +
          `;[catLayer]drawtext=${statusStyle}:textfile='${filterPath(loading)}':reload=1:fontsize=${statusSize}:line_spacing=${Math.round(statusSize * 0.4)}:x=(w-tw)/2:y=h*0.68[standby]`;
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
