// Explicit manual integration check; never part of the ordinary test suite.
import { readConfig } from "../server/config.js";
import {
  ExperimentalYouTubeSource,
  YouTubePlaylistProvider,
} from "../server/providers.js";
import { runCapture } from "../server/process.js";
import { defaults } from "../server/config.js";
import { OverlayPreview } from "../server/preview.js";
import { overlay } from "../server/overlay.js";
import { encodeArgs } from "../server/encoder.js";
import { mkdir, writeFile } from "node:fs/promises";
process.loadEnvFile("E:/IdleCast/repo/.env");
const c = readConfig(process.env);
c.YTDLP_PATH = "E:/IdleCast/repo/data/tools/yt-dlp.exe";
c.DATA_DIR = "E:/IdleCast/verification";
c.MEDIA_DIR = "E:/IdleCast/repo/media";
await mkdir(c.DATA_DIR, { recursive: true });
const signal = new AbortController().signal;
async function api(resource: string, params: Record<string, string>) {
  const url = new URL("https://www.googleapis.com/youtube/v3/" + resource);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, {
    headers: { "X-Goog-Api-Key": c.YOUTUBE_API_KEY },
  });
  if (!r.ok) throw Error("API " + r.status);
  return r.json();
}
const shortInfo = (
  await api("videos", {
    part: "snippet,status,contentDetails",
    id: "7VFcNIbsIJ4",
  })
).items[0];
if (shortInfo.status.privacyStatus !== "public")
  throw Error("Short test must be public");
const p = new YouTubePlaylistProvider(c.YOUTUBE_API_KEY);
const uploads = await p.channelUploads(shortInfo.snippet.channelId, signal);
const all = await p.fetch(uploads, signal);
console.log("Channel discovery:", all.length, "uploads");
const candidates = all
  .filter((i) => i.available && (i.duration ?? 0) > 7200)
  .sort((a, b) => a.duration! - b.duration!);
let long;
for (const candidate of candidates.slice(0, 20)) {
  const v = (await api("videos", { part: "status", id: candidate.videoId }))
    .items[0];
  if (v?.status.privacyStatus === "public") {
    long = candidate;
    break;
  }
}
if (!long) throw Error("No public multi-hour test video found");
let short = all.find((i) => i.videoId === "7VFcNIbsIJ4")!;
if (process.argv.includes("--short-only")) {
  for (const candidate of all.filter(
    (i) => i.available && (i.duration ?? 0) > 30 && (i.duration ?? 0) < 300,
  )) {
    const v = (await api("videos", { part: "status", id: candidate.videoId }))
      .items[0];
    if (v?.status.privacyStatus === "public") {
      short = candidate;
      break;
    }
  }
  if (short.duration! >= 300)
    throw Error("No public video under five minutes found");
  c.DATA_DIR = "E:/IdleCast/verification-short";
  await mkdir(c.DATA_DIR, { recursive: true });
}
const results = [];
for (const [item, height, fps] of [
  [short, 720, 30],
  [long, 1080, 60],
] as const) {
  if (process.argv.includes("--short-only") && height !== 720) continue;
  if (process.argv.includes("--long-only") && height !== 1080) continue;
  const s = {
    ...defaults,
    width: height === 1080 ? (1920 as const) : (1280 as const),
    height,
    fps,
    overlay: { ...defaults.overlay, title: item.title },
  };
  console.log(
    "Downloading public test:",
    item.title,
    "duration",
    item.duration,
    "quality",
    height,
    fps,
  );
  const source = new ExperimentalYouTubeSource(c, undefined, s);
  const start = Date.now();
  const file = await source.resolve(item, signal);
  const media = JSON.parse(
    await runCapture(
      c.FFPROBE_PATH,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,width,height:format=duration",
        "-of",
        "json",
        file,
      ],
      signal,
    ),
  );
  if (
    !media.streams.some((x: any) => x.codec_type === "video") ||
    !media.streams.some((x: any) => x.codec_type === "audio")
  )
    throw Error("Missing merged streams");
  const preview = new OverlayPreview(c);
  const ov = await overlay(c, s);
  const encoded = c.DATA_DIR + "/" + height + "-encoded.mp4";
  const args = encodeArgs(s, 19000, 0);
  await runCapture(
    c.FFMPEG_PATH,
    [
      "-y",
      "-ss",
      "30",
      "-i",
      file,
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
      "0:a",
      ...args.slice(0, -3),
      "-t",
      "5",
      encoded,
    ],
    signal,
    60000,
  );
  const encodedInfo = JSON.parse(
    await runCapture(
      c.FFPROBE_PATH,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,r_frame_rate",
        "-of",
        "json",
        encoded,
      ],
      signal,
    ),
  );
  if (
    encodedInfo.streams[0].height !== height ||
    encodedInfo.streams[0].r_frame_rate !== fps + "/1"
  )
    throw Error("Encoded output mismatch");
  const png = await preview.render(
    s,
    { file, offset: Math.min(30, item.duration! - 1), signal },
    signal,
  );
  await writeFile(c.DATA_DIR + "/" + height + "-preview.png", png);
  await preview.close();
  await source.close();
  results.push({
    title: item.title,
    videoId: item.videoId,
    public: true,
    height,
    fps,
    seconds: (Date.now() - start) / 1000,
    media,
    encodedInfo,
    previewBytes: png.length,
  });
  await writeFile(
    c.DATA_DIR + "/results.json",
    JSON.stringify(results, null, 2),
  );
  console.log("PASS:", JSON.stringify(results.at(-1)));
}
