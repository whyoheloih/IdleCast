import type { Config, Settings } from "./config.js";
import { launch, completion, delay } from "./process.js";
import { overlay } from "./overlay.js";
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
            "?pkt_size=1316",
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
    "48000",
    "-ac",
    "2",
    "-af",
    "aresample=48000:async=0,asetpts=N/SR/TB",
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
        const ov = await overlay(c, s);
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
            "anullsrc=r=48000:cl=stereo",
            ...ov.inputs,
            "-filter_complex",
            ov.filter,
            "-map",
            "[v]",
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
