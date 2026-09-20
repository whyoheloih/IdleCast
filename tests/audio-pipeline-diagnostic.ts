import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaults, readConfig } from "../server/config.js";
import { Store } from "../server/db.js";
import { credentialStore } from "../server/credentials.js";
import { encodeArgs } from "../server/encoder.js";

const source = process.env.IDLECAST_DIAGNOSTIC_SOURCE;
if (!source) throw new Error("Set IDLECAST_DIAGNOSTIC_SOURCE");
const duration = Number(process.env.IDLECAST_DIAGNOSTIC_SECONDS ?? 310);
const port = Number(process.env.IDLECAST_DIAGNOSTIC_PORT ?? 19417);
const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-pipeline-"));
const postEncode = path.join(root, "post-encode.ts");
const postHandoff = path.join(root, "post-handoff.flv");
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
const liveEnv = process.env.IDLECAST_DIAGNOSTIC_ENV;
let liveTarget = "";
let liveKey = "";
if (liveEnv) {
  process.loadEnvFile(liveEnv);
  const previousDirectory = process.cwd();
  process.chdir(path.dirname(liveEnv));
  try {
    const config = readConfig(process.env);
    const store = new Store(path.join(config.DATA_DIR, "idlecast.db"));
    try {
      credentialStore(config, store);
      liveKey = config.YOUTUBE_STREAM_KEY;
      assert.ok(liveKey, "YouTube stream key is not configured");
      liveTarget = defaults.youtube.server.replace(/\/$/, "") + "/" + liveKey;
    } finally {
      store.close();
    }
  } finally {
    process.chdir(previousDirectory);
  }
}
const settings = {
  ...defaults,
  width: 1920 as const,
  height: 1080 as const,
  fps: 60 as const,
  bitrateKbps: 6000,
  youtube: { ...defaults.youtube, enabled: true },
};

function start(args: string[]) {
  const child = spawn(ffmpeg, args, {
    cwd: root,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-1048576);
  });
  return { child, stderr: () => stderr };
}
function complete(child: ChildProcess) {
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
}
async function capture(binary: string, args: string[]) {
  const child = spawn(binary, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const code = await complete(child);
  if (code !== 0)
    throw new Error(Buffer.concat(stderr).toString() || binary + " failed");
  return Buffer.concat(stdout);
}
async function probe(file: string) {
  return JSON.parse(
    (
      await capture(ffprobe, [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file,
      ])
    ).toString(),
  );
}
async function packets(file: string, selector: string) {
  const data = JSON.parse(
    (
      await capture(ffprobe, [
        "-v",
        "error",
        "-select_streams",
        selector,
        "-show_packets",
        "-show_entries",
        "packet=pts_time,dts_time,duration_time",
        "-of",
        "json",
        file,
      ])
    ).toString(),
  ).packets;
  let largestGap = Number.NEGATIVE_INFINITY,
    backwards = 0;
  for (let index = 1; index < data.length; index++) {
    const previous =
      Number(data[index - 1].pts_time) + Number(data[index - 1].duration_time);
    const gap = Number(data[index].pts_time) - previous;
    largestGap = Math.max(largestGap, gap);
    if (gap < -0.001) backwards++;
  }
  const last = data.at(-1);
  return {
    count: data.length,
    largestGap,
    backwards,
    end: Number(last.pts_time) + Number(last.duration_time),
  };
}
async function extractAdts(file: string, output: string) {
  await capture(ffmpeg, [
    "-v",
    "error",
    "-i",
    file,
    "-map",
    "0:a:0",
    "-c",
    "copy",
    "-f",
    "adts",
    "-y",
    output,
  ]);
  return readFile(output);
}
function inspectAdts(data: Buffer) {
  const rates = new Set<number>();
  let frames = 0,
    at = 0;
  while (at + 7 <= data.length) {
    assert.equal(data[at], 0xff, `lost ADTS sync at byte ${at}`);
    assert.equal(
      data[at + 1] & 0xf6,
      0xf0,
      `invalid ADTS header at byte ${at}`,
    );
    rates.add((data[at + 2] >> 2) & 0x0f);
    const length =
      ((data[at + 3] & 0x03) << 11) | (data[at + 4] << 3) | (data[at + 5] >> 5);
    assert.ok(
      length >= 7 && at + length <= data.length,
      `invalid ADTS length at byte ${at}`,
    );
    at += length;
    frames++;
  }
  assert.equal(at, data.length, "trailing bytes after ADTS frames");
  return { frames, sampleRateIndexes: [...rates] };
}
function sha256(data: Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
const started = Date.now();
try {
  console.log(
    JSON.stringify({
      source,
      duration,
      port,
      root,
      liveRtmp: Boolean(liveTarget),
    }),
  );
  const sourceInfo = await probe(source);
  const sourceAudio = sourceInfo.streams.find(
    (stream: any) => stream.codec_type === "audio",
  );
  console.log(
    "source",
    JSON.stringify({
      codec: sourceAudio.codec_name,
      sampleRate: sourceAudio.sample_rate,
      sampleFormat: sourceAudio.sample_fmt,
      channels: sourceAudio.channels,
      layout: sourceAudio.channel_layout,
      timeBase: sourceAudio.time_base,
      duration: sourceInfo.format.duration,
    }),
  );
  assert.equal(sourceAudio.sample_rate, "48000");
  assert.equal(sourceAudio.channels, 2);

  const receiverOutput = liveTarget
    ? [
        "-f",
        "tee",
        `[f=flv:flvflags=no_duration_filesize:onfail=abort]post-handoff.flv|[f=flv:flvflags=no_duration_filesize:onfail=abort]${liveTarget}`,
      ]
    : ["-f", "flv", "-flvflags", "no_duration_filesize", postHandoff];
  const receiver = start([
    "-y",
    "-hide_banner",
    "-loglevel",
    "warning",
    "-progress",
    "pipe:1",
    "-stats_period",
    "1",
    "-fflags",
    "+genpts+discardcorrupt",
    "-thread_queue_size",
    "8192",
    "-i",
    `udp://127.0.0.1:${port}?buffer_size=4194304&fifo_size=262144&overrun_nonfatal=1&timeout=2000000`,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c",
    "copy",
    "-tag:v",
    "7",
    "-tag:a",
    "10",
    ...receiverOutput,
  ]);
  const receiverDone = complete(receiver.child);
  await new Promise((resolve) => setTimeout(resolve, 750));

  const encode = encodeArgs(settings, port, 0);
  encode[encode.length - 1] =
    "[f=mpegts:mpegts_flags=+initial_discontinuity:onfail=abort]post-encode.ts|" +
    encode.at(-1);
  const producer = start([
    "-hide_banner",
    "-loglevel",
    "warning",
    "-progress",
    "pipe:1",
    "-stats_period",
    "1",
    "-re",
    "-i",
    source,
    "-filter_complex",
    "[0:v:0]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=60,format=yuv420p[v]",
    "-map",
    "[v]",
    "-map",
    "0:a:0",
    "-t",
    String(duration),
    ...encode,
  ]);

  const producerDone = complete(producer.child);
  let progress = "",
    lastBucket = -1,
    latestSpeed = "";
  let receiverProgress = "",
    receiverSpeed = "",
    receiverSeconds = 0;
  receiver.child.stdout.on("data", (chunk) => {
    receiverProgress += String(chunk);
    let newline;
    while ((newline = receiverProgress.indexOf("\n")) >= 0) {
      const line = receiverProgress.slice(0, newline).trim();
      receiverProgress = receiverProgress.slice(newline + 1);
      if (line.startsWith("speed=")) receiverSpeed = line.slice(6);
      if (line.startsWith("out_time_ms="))
        receiverSeconds = Math.floor(Number(line.slice(12)) / 1_000_000);
    }
  });
  producer.child.stdout.on("data", (chunk) => {
    progress += String(chunk);
    let newline;
    while ((newline = progress.indexOf("\n")) >= 0) {
      const line = progress.slice(0, newline).trim();
      progress = progress.slice(newline + 1);
      if (line.startsWith("speed=")) latestSpeed = line.slice(6);
      if (line.startsWith("out_time_ms=")) {
        const seconds = Math.floor(Number(line.slice(12)) / 1_000_000);
        const bucket = Math.floor(seconds / 30);
        if (bucket > lastBucket) {
          lastBucket = bucket;
          const memory = process.memoryUsage();
          console.log(
            "runtime",
            JSON.stringify({
              wallSeconds: Math.round((Date.now() - started) / 1000),
              mediaSeconds: seconds,
              speed: latestSpeed,
              nodeRssMb: Math.round(memory.rss / 1048576),
              nodeHeapMb: Math.round(memory.heapUsed / 1048576),
              eventLoopP99Ms: Number(loop.percentile(99) / 1e6).toFixed(2),
              producerPid: producer.child.pid,
              receiverPid: receiver.child.pid,
              receiverMediaSeconds: receiverSeconds,
              receiverSpeed,
            }),
          );
          loop.reset();
        }
      }
    }
  });

  const producerCode = await producerDone;
  assert.equal(producerCode, 0, producer.stderr());
  receiver.child.stdin?.end("q\n");
  const receiverCode = await receiverDone;
  assert.ok(
    receiverCode === 0 ||
      /Input\/output error|Immediate exit requested/i.test(receiver.stderr()),
    receiver.stderr(),
  );
  const rawWarnings = producer.stderr() + "\n" + receiver.stderr();
  const warnings = liveKey
    ? rawWarnings.replaceAll(liveKey, "[redacted]")
    : rawWarnings;
  assert.doesNotMatch(
    warnings,
    /overrun|circular buffer|non-monoton|timestamp discontinu|corrupt|queue.*blocking|error while decoding/i,
    warnings,
  );

  const stages = [];
  for (const [name, file] of [
    ["pre-ffmpeg", source],
    ["post-encode", postEncode],
    ["post-handoff", postHandoff],
  ] as const) {
    const info = await probe(file);
    const audio = info.streams.find(
      (stream: any) => stream.codec_type === "audio",
    );
    const audioPackets = await packets(file, "a:0");
    const videoPackets = await packets(file, "v:0");
    stages.push({
      name,
      codec: audio.codec_name,
      sampleRate: audio.sample_rate,
      sampleFormat: audio.sample_fmt,
      channels: audio.channels,
      layout: audio.channel_layout,
      timeBase: audio.time_base,
      audioPackets,
      avEndDelta: Math.abs(audioPackets.end - videoPackets.end),
    });
  }
  for (const stage of stages) {
    assert.equal(stage.sampleRate, "48000");
    assert.equal(stage.channels, 2);
    assert.equal(stage.audioPackets.backwards, 0);
    assert.ok(
      stage.audioPackets.largestGap < 0.005,
      `${stage.name} audio gap ${stage.audioPackets.largestGap}`,
    );
    assert.ok(
      stage.avEndDelta < 0.08,
      `${stage.name} A/V end delta ${stage.avEndDelta}`,
    );
  }

  const encodedAdts = await extractAdts(
    postEncode,
    path.join(root, "post-encode.aac"),
  );
  const handoffAdts = await extractAdts(
    postHandoff,
    path.join(root, "post-handoff.aac"),
  );
  const encodedHeaders = inspectAdts(encodedAdts);
  const handoffHeaders = inspectAdts(handoffAdts);
  assert.deepEqual(
    encodedHeaders.sampleRateIndexes,
    [3],
    "post-encode AAC changed away from 48 kHz",
  );
  assert.deepEqual(
    handoffHeaders.sampleRateIndexes,
    [3],
    "post-handoff AAC changed away from 48 kHz",
  );
  assert.equal(encodedHeaders.frames, handoffHeaders.frames);
  assert.equal(
    sha256(encodedAdts),
    sha256(handoffAdts),
    "UDP/remux changed AAC packets",
  );

  for (const at of [30, 120, 128, 132, 136, 150, 295]) {
    if (at + 5 >= duration) continue;
    for (const file of [source, postEncode, postHandoff]) {
      const pcm = await capture(ffmpeg, [
        "-v",
        "error",
        "-ss",
        String(at),
        "-i",
        file,
        "-map",
        "0:a:0",
        "-t",
        "5",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-f",
        "s16le",
        "pipe:1",
      ]);
      assert.ok(
        pcm.length >= 5 * 48000 * 2 * 2,
        `short decode at ${at}s for ${file}`,
      );
    }
  }
  console.log(
    JSON.stringify(
      {
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
        stages,
        encodedHeaders,
        handoffHeaders,
        aacSha256: sha256(encodedAdts),
        warnings: warnings.trim(),
      },
      null,
      2,
    ),
  );
  console.log("Three-stage audio diagnostic passed");
} finally {
  loop.disable();
  await rm(root, { recursive: true, force: true });
}
