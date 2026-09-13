import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  mkdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readConfig, defaults } from "../server/config.js";
import { Store } from "../server/db.js";
import { Engine } from "../server/engine.js";
import { runCapture, delay } from "../server/process.js";
import { overlay } from "../server/overlay.js";
import {
  LocalMediaSource,
  type PlaylistItem,
  type StreamOutputProvider,
} from "../server/providers.js";
const font =
  process.platform === "win32"
    ? "C:/Windows/Fonts/arial.ttf"
    : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const signal = () => new AbortController().signal;
test("FFmpeg overlay has no background box and has outlined text with an opaque square avatar", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-overlay-"));
  try {
    await mkdir(path.join(root, "avatars"));
    const avatar = path.join(root, "avatars", "avatar.png");
    await runCapture(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=112x56,drawbox=x=42:y=14:w=28:h=28:color=red:t=fill",
        "-frames:v",
        "1",
        avatar,
      ],
      signal(),
    );
    const c = readConfig({
      ADMIN_PASSWORD: "test-password-long-enough",
      DATA_DIR: root,
      MEDIA_DIR: root,
      FONT_FILE: font,
    });
    const settings = {
      ...defaults,
      overlay: {
        ...defaults.overlay,
        avatar: "avatar.png",
        title: "Test %{unsafe}: title",
      },
    };
    const result = await overlay(c, settings),
      output = path.join(root, "frame.rgb");
    await runCapture(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=white:s=1280x720",
        "-f",
        "lavfi",
        "-i",
        "anullsrc",
        ...result.inputs,
        "-filter_complex",
        result.filter,
        "-map",
        "[v]",
        "-frames:v",
        "1",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        output,
      ],
      signal(),
    );
    const pixels = await readFile(output);
    const rgb = (x: number, y: number) => [
      ...pixels.subarray((y * 1280 + x) * 3, (y * 1280 + x) * 3 + 3),
    ];
    const bg = rgb(30, 620);
    assert.ok(
      bg.every((v) => v > 245),
      "background must remain unchanged: " + bg,
    );
    const red = rgb(60, 650);
    assert.ok(
      red[0] > 235 && red[1] < 20 && red[2] < 20,
      "avatar stays opaque: " + red,
    );
    assert.ok(
      rgb(10, 10).every((v) => v > 245),
      "outside overlay remains unchanged",
    );
    let white = 0,
      black = 0;
    for (let y = 630; y < 680; y++)
      for (let x = 120; x < 400; x++) {
        if (rgb(x, y).every((v) => v > 240)) white++;
        if (rgb(x, y).every((v) => v < 30)) black++;
      }
    assert.ok(white > 30, "text remains fully opaque");
    assert.ok(black > 30, "text has a visible black outline");
    const redPoints = [];
    for (let y = 620; y < 692; y++)
      for (let x = 28; x < 110; x++)
        if (rgb(x, y)[0] > 230 && rgb(x, y)[1] < 25) redPoints.push([x, y]);
    const xs = redPoints.map((p) => p[0]),
      ys = redPoints.map((p) => p[1]);
    assert.ok(
      Math.abs(
        Math.max(...xs) - Math.min(...xs) - (Math.max(...ys) - Math.min(...ys)),
      ) <= 2,
      "a square inside a wide avatar must stay square",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("real FFmpeg loop skips unavailable files, survives one failed output, and preserves stop/restart intent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-engine-"));
  const db = new Store(path.join(root, "db.sqlite"));
  const c = readConfig({
    ADMIN_PASSWORD: "test-password-long-enough",
    DATA_DIR: root,
    MEDIA_DIR: root,
    FONT_FILE: font,
    UDP_BASE_PORT: String(21000 + Math.floor(Math.random() * 10000)),
  });
  const file = path.join(root, "abcdefghijk.mp4");
  const received = path.join(root, "received.flv");
  const settings = {
    ...defaults,
    mediaSource: "local" as const,
    bitrateKbps: 500,
    youtube: { ...defaults.youtube, enabled: true },
    twitch: { ...defaults.twitch, enabled: true },
  };
  db.set("settings", settings);
  const make = (
    id: string,
    videoId: string,
    position: number,
  ): PlaylistItem => ({
    id,
    videoId,
    position,
    title: id,
    channel: "Test",
    thumbnail: "",
    available: true,
    duration: 3,
  });
  db.replace([
    make("missing", "missing", 0),
    make("first", "abcdefghijk", 1),
    make("second", "abcdefghijk", 2),
  ]);
  const good: StreamOutputProvider = {
    name: "youtube",
    args: (_s, p) => [
      "-y",
      "-loglevel",
      "error",
      "-fflags",
      "+genpts+discardcorrupt",
      "-analyzeduration",
      "1000000",
      "-i",
      "udp://127.0.0.1:" + p + "?fifo_size=65536&overrun_nonfatal=1",
      "-c",
      "copy",
      "-f",
      "flv",
      "-flush_packets",
      "1",
      received,
    ],
  };
  const bad: StreamOutputProvider = {
    name: "twitch",
    args: () => ["-i", path.join(root, "does-not-exist")],
  };
  let delayed = false;
  const local = new LocalMediaSource(root);
  const engine = new Engine(db, c, {
    outputs: { youtube: good, twitch: bad },
    source: {
      resolve: async (i, s) => {
        if (i.id === "first" && !delayed) {
          delayed = true;
          await delay(2200, s);
        }
        return local.resolve(i, s);
      },
    },
  });
  try {
    await runCapture(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000",
        "-t",
        "3",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-c:a",
        "aac",
        file,
      ],
      signal(),
    );
    await engine.start();
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      if (
        (db.logs() as any[]).filter((l) => l.message.startsWith("Finished:"))
          .length >= 3
      )
        break;
      await delay(200, signal());
    }
    const logs = db.logs() as any[];
    assert.ok(
      logs.some((l) => l.message.startsWith("Media failed: missing")),
      "missing media should be skipped",
    );
    assert.ok(
      logs.filter((l) => l.message.startsWith("Finished:")).length >= 3,
      JSON.stringify(logs),
    );
    assert.ok(
      engine.outputs.twitch.retries > 0,
      "failed output should reconnect independently",
    );
    await engine.stop(true);
    assert.match(
      await readFile(path.join(root, "overlay", "title.txt"), "utf8"),
      /^(first|second)$/,
    );
    assert.equal(db.get("desired", false), true);
    assert.equal(engine.state, "stopped");
    assert.ok((await stat(received)).size > 10000);
    const info = JSON.parse(
      await runCapture(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "packet=pts_time,dts_time",
          "-of",
          "json",
          "-flush_packets",
          "1",
          received,
        ],
        signal(),
      ),
    );
    const timestamps = info.packets
      .map((p: any) => Number(p.dts_time))
      .filter(Number.isFinite);
    assert.ok(
      timestamps.at(-1) - timestamps[0] > 5,
      "packets span multiple playlist transitions: " +
        JSON.stringify(timestamps),
    );
    assert.ok(
      timestamps.every(
        (v: number, i: number) => i === 0 || v >= timestamps[i - 1],
      ),
      "output timestamps are monotonic",
    );
    await engine.stop();
    assert.equal(db.get("desired", true), false);
    db.replace([
      { ...make("unavailable", "abcdefghijk", 0), available: false },
    ]);
    await engine.start();
    await delay(5000, signal());
    assert.equal(engine.state, "waiting");
    await engine.stop();
    assert.ok(
      (await stat(received)).size > 1000,
      "standby generates output when every item is unavailable: " +
        JSON.stringify({ size: (await stat(received)).size, logs: db.logs() }),
    );
  } finally {
    await engine.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
