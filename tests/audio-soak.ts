import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaults } from "../server/config.js";
import { encodeArgs } from "../server/encoder.js";

const duration = Number(process.env.IDLECAST_SOAK_SECONDS ?? 305);
const port = Number(process.env.IDLECAST_SOAK_PORT ?? 19387);
const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-audio-soak-"));
const output = path.join(root, "transport.mkv");
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
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
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-65536);
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
function analyzePcm(data: Buffer) {
  let crossings = 0,
    peakStep = 0,
    sumSquares = 0;
  let previous = data.readFloatLE(0);
  for (let at = 4; at < data.length; at += 4) {
    const sample = data.readFloatLE(at);
    if (previous <= 0 && sample > 0) crossings++;
    peakStep = Math.max(peakStep, Math.abs(sample - previous));
    sumSquares += sample * sample;
    previous = sample;
  }
  const seconds = data.length / 4 / 48000;
  return {
    frequency: crossings / seconds,
    peakStep,
    rms: Math.sqrt(sumSquares / Math.max(1, data.length / 4 - 1)),
  };
}

try {
  console.log(
    `${duration}-second encoder -> MPEG-TS/UDP -> output-worker soak`,
  );
  const receiver = start([
    "-y",
    "-hide_banner",
    "-loglevel",
    "warning",
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
    output,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const producer = start([
    "-hide_banner",
    "-loglevel",
    "warning",
    "-progress",
    "pipe:1",
    "-stats_period",
    "1",
    "-re",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=1920x1080:rate=60:duration=${duration}`,
    "-re",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=1000:sample_rate=48000:duration=${duration}`,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-t",
    String(duration),
    ...encodeArgs(settings, port, 0),
  ]);
  let progress = "",
    lastReported = -1;
  producer.child.stdout.on("data", (chunk) => {
    progress += String(chunk);
    let newline;
    while ((newline = progress.indexOf("\n")) >= 0) {
      const line = progress.slice(0, newline).trim();
      progress = progress.slice(newline + 1);
      if (line.startsWith("out_time_ms=")) {
        const seconds = Math.floor(Number(line.slice(12)) / 1_000_000);
        const bucket = Math.floor(seconds / 30);
        if (bucket > lastReported) {
          lastReported = bucket;
          console.log(`soak progress: ${seconds}s / ${duration}s`);
        }
      }
    }
  });
  const producerCode = await complete(producer.child);
  assert.equal(producerCode, 0, producer.stderr());
  receiver.child.stdin?.end("q\n");
  const receiverCode = await complete(receiver.child);
  assert.ok(
    receiverCode === 0 ||
      /Input\/output error|Immediate exit requested/i.test(receiver.stderr()),
    receiver.stderr(),
  );
  const warnings = producer.stderr() + "\n" + receiver.stderr();
  assert.doesNotMatch(
    warnings,
    /overrun|circular buffer|non-monoton|timestamp discontinu|corrupt|queue.*blocking/i,
    warnings,
  );

  const packetData = JSON.parse(
    (
      await capture(ffprobe, [
        "-v",
        "error",
        "-show_packets",
        "-show_entries",
        "packet=codec_type,pts_time,dts_time,duration_time",
        "-of",
        "json",
        output,
      ])
    ).toString(),
  );
  const byType = (type: string) =>
    packetData.packets.filter((packet: any) => packet.codec_type === type);
  const audio = byType("audio"),
    video = byType("video");
  assert.ok(audio.length > duration * 40 && video.length > duration * 30);
  let largestAudioGap = 0;
  for (let index = 1; index < audio.length; index++) {
    const previous =
      Number(audio[index - 1].pts_time) +
      Number(audio[index - 1].duration_time);
    const gap = Number(audio[index].pts_time) - previous;
    largestAudioGap = Math.max(largestAudioGap, gap);
    assert.ok(gap > -0.001, `audio PTS moved backward at packet ${index}`);
  }
  assert.ok(
    largestAudioGap < 0.005,
    `audio packet discontinuity: ${largestAudioGap}s`,
  );
  const end = (packets: any[]) => {
    const packet = packets.at(-1);
    return Number(packet.pts_time) + Number(packet.duration_time);
  };
  const avEndDelta = Math.abs(end(audio) - end(video));
  assert.ok(avEndDelta < 0.05, `A/V end delta was ${avEndDelta}s`);

  const windows =
      duration >= 150
        ? [20, 125, 135, duration - 10]
        : [1, Math.max(1, duration - 6)],
    results = [];
  for (const start of windows) {
    const pcm = await capture(ffmpeg, [
      "-v",
      "error",
      "-ss",
      String(start),
      "-i",
      output,
      "-map",
      "0:a:0",
      "-t",
      "5",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-f",
      "f32le",
      "pipe:1",
    ]);
    const result = analyzePcm(pcm);
    assert.ok(
      Math.abs(result.frequency - 1000) < 2,
      `pitch changed at ${start}s: ${result.frequency}Hz`,
    );
    assert.ok(
      result.peakStep < 0.04,
      `audio impulse detected at ${start}s: ${result.peakStep}`,
    );
    results.push({ start, ...result });
  }
  const rmsValues = results.map((result) => result.rms);
  assert.ok(
    Math.max(...rmsValues) - Math.min(...rmsValues) < 0.002,
    "audio level changed across the soak",
  );
  console.log(
    JSON.stringify(
      { duration, largestAudioGap, avEndDelta, windows: results },
      null,
      2,
    ),
  );
  console.log("Audio transport soak passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
