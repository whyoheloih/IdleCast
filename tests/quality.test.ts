import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaults, readConfig, settingsSchema } from "../server/config.js";
import { overlay } from "../server/overlay.js";
import { encodeArgs } from "../server/encoder.js";
import { runCapture } from "../server/process.js";
import { OverlayPreview } from "../server/preview.js";
import { ExperimentalYouTubeSource } from "../server/providers.js";

test("1080p60 validates, encodes at 60 fps, previews at 1080p and refetches higher-quality media", async () => {
  const s = settingsSchema.parse({
    ...defaults,
    width: 1920,
    height: 1080,
    fps: 60,
  });
  assert.equal(settingsSchema.safeParse({ ...s, height: 720 }).success, false);
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-quality-"));
  const c = readConfig({
    ADMIN_PASSWORD: "quality-test-password",
    DATA_DIR: root,
    EXPERIMENTAL_YOUTUBE: "true",
    FONT_FILE:
      process.platform === "win32"
        ? "C:/Windows/Fonts/arial.ttf"
        : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  });
  const signal = new AbortController().signal;
  const preview = new OverlayPreview(c);
  try {
    const png = await preview.render(s, null, signal);
    assert.equal(png.readUInt32BE(16), 1920);
    assert.equal(png.readUInt32BE(20), 1080);
    const ov = await overlay(c, s);
    const args = encodeArgs(s, 19000, 0);
    const file = path.join(root, "encoded.mp4");
    await runCapture(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=320x180:r=30",
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
        "1:a",
        ...args.slice(0, -3),
        "-t",
        "1",
        file,
      ],
      signal,
    );
    const info = JSON.parse(
      await runCapture(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height,r_frame_rate,nb_frames",
          "-of",
          "json",
          file,
        ],
        signal,
      ),
    ).streams[0];
    assert.equal(info.width, 1920);
    assert.equal(info.height, 1080);
    assert.equal(info.r_frame_rate, "60/1");
    assert.equal(info.nb_frames, "60");
    const item = {
      id: "one",
      videoId: "abcdefghijk",
      position: 0,
      title: "test",
      channel: "",
      thumbnail: "",
      available: true,
      duration: 1,
    };
    let count = 0;
    const run: typeof runCapture = async (_bin, args) => {
      count++;
      const format = args[args.indexOf("-f") + 1];
      assert.ok(format.includes(count === 1 ? "height<=720" : "height<=1080"));
      assert.ok(
        args.includes(count === 1 ? "res:720,fps:30" : "res:1080,fps:60"),
      );
      await writeFile(
        args[args.indexOf("-o") + 1].replace("%(ext)s", "mp4"),
        "fixture",
      );
      return "";
    };
    const low = new ExperimentalYouTubeSource(c, run);
    const high = new ExperimentalYouTubeSource(c, run, s);
    const lowFile = await low.resolve(item, signal);
    const highFile = await high.resolve(item, signal);
    assert.notEqual(lowFile, highFile);
    assert.equal(count, 2);
    await high.resolve(item, signal);
    assert.equal(count, 2);
    await low.close();
    await high.close();
  } finally {
    await preview.close();
    await rm(root, { recursive: true, force: true });
  }
});
