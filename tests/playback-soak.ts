import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaults, readConfig } from "../server/config.js";
import { Store } from "../server/db.js";
import { Engine } from "../server/engine.js";
import { delay, runCapture } from "../server/process.js";
import type { PlaylistItem, StreamOutputProvider } from "../server/providers.js";

const durationSeconds = Math.max(60, Number(process.env.IDLECAST_SOAK_SECONDS ?? 12 * 60 * 60));
const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-playback-soak-"));
const fallbackDirectory = path.join(root, "fallback");
const sourceFile = path.join(root, "source.mp4");
const database = new Store(path.join(root, "soak.sqlite"));
const signal = new AbortController().signal;
let outputStarts = 0;

const output: StreamOutputProvider = {
  name: "youtube",
  args: (_settings, port) => {
    outputStarts += 1;
    if (outputStarts === 1)
      return ["-hide_banner", "-loglevel", "error", "-i", path.join(root, "forced-output-failure.mp4")];
    return [
      "-hide_banner", "-loglevel", "error",
      "-fflags", "+genpts+discardcorrupt",
      "-i", "udp://127.0.0.1:" + port + "?fifo_size=65536&overrun_nonfatal=1",
      "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-f", "null", "-",
    ];
  },
};

try {
  await mkdir(fallbackDirectory, { recursive: true });
  await runCapture("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", sourceFile,
  ], signal);
  await copyFile(sourceFile, path.join(fallbackDirectory, "soak-fallback.mp4"));

  const config = readConfig({
    ADMIN_PASSWORD: "idlecast-soak-password",
    DATA_DIR: root,
    MEDIA_DIR: root,
    NORMAL_CACHE_DIR: path.join(root, "normal-cache"),
    MARATHON_CACHE_DIR: path.join(root, "marathon-cache"),
    FALLBACK_MEDIA_DIR: fallbackDirectory,
    LOCAL_MEDIA_DIR: root,
    UDP_BASE_PORT: String(23000 + Math.floor(Math.random() * 15000)),
  });
  const settings = {
    ...defaults,
    mediaSource: "local" as const,
    localDirectory: root,
    width: 1280 as const,
    height: 720 as const,
    fps: 30 as const,
    bitrateKbps: 1200,
    youtube: { ...defaults.youtube, enabled: true },
  };
  database.set("settings", settings);
  const items: PlaylistItem[] = Array.from({ length: 8 }, (_, index) => ({
    id: "soak-entry-" + index,
    videoId: "soakvideo" + String(index).padStart(2, "0"),
    position: index,
    title: "Soak video " + (index + 1),
    channel: "IdleCast soak",
    thumbnail: "",
    available: true,
    duration: 4,
    sourceType: "local" as const,
    localIdentity: "soak-local-" + index,
    localPath: sourceFile,
  }));
  database.replace(items);

  const resolutions = new Map<string, number>();
  const engine = new Engine(database, config, {
    outputs: { youtube: output },
    source: {
      resolve: async (item, abortSignal) => {
        abortSignal.throwIfAborted();
        const attempt = (resolutions.get(item.id) ?? 0) + 1;
        resolutions.set(item.id, attempt);
        if (item.id === "soak-entry-3" && attempt === 1)
          throw new Error("temporary network timeout injected by playback soak");
        return sourceFile;
      },
    },
  });

  const startedAt = Date.now();
  let lastReport = 0;
  console.log("IdleCast playback soak started for " + durationSeconds + " seconds.");
  console.log("The run uses eight looping clips, one injected source timeout, and one forced output-process failure.");
  try {
    await engine.rescanEmergencyFallbacks();
    await engine.start();
    while ((Date.now() - startedAt) / 1000 < durationSeconds) {
      await delay(1000, signal);
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      if (elapsed - lastReport >= 60) {
        lastReport = elapsed;
        const finished = (database.logs() as Array<{ message: string }>).filter((entry) => entry.message.startsWith("Finished:")).length;
        const memory = process.memoryUsage();
        console.log("soak " + elapsed + "s / " + durationSeconds + "s; finished=" + finished + "; rssMB=" + Math.round(memory.rss / 1048576));
      }
    }
  } finally {
    await engine.stop(true);
    await engine.close();
  }

  const logs = database.logs() as Array<{ level: string; message: string }>;
  const finished = logs.filter((entry) => entry.message.startsWith("Finished:")).length;
  const transitions = logs.filter((entry) => /Transition \d+ activated/.test(entry.message)).length;
  const recoveredOutput = logs.some((entry) => /output disconnected; automatic recovery attempt/i.test(entry.message));
  if (finished < 3 || transitions < 3)
    throw new Error("Playback soak did not complete enough real transitions: finished=" + finished + ", transitions=" + transitions);
  if (!recoveredOutput)
    throw new Error("Playback soak did not observe output supervisor recovery");
  console.log(JSON.stringify({ durationSeconds, finished, transitions, outputStarts, sourceResolutions: Object.fromEntries(resolutions) }, null, 2));
  console.log("IdleCast playback soak passed.");
} finally {
  database.close();
  await rm(root, { recursive: true, force: true });
}