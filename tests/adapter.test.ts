import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readConfig } from "../server/config.js";
import {
  ExperimentalYouTubeSource,
  type PlaylistItem,
} from "../server/providers.js";
import { withCancellation } from "../server/process.js";
test("experimental adapter is opt-in, uses YouTube media URLs, deduplicates downloads and protects the playing file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-adapter-"));
  const c = readConfig({
    ADMIN_PASSWORD: "test-password-long-enough",
    DATA_DIR: root,
    EXPERIMENTAL_YOUTUBE: "true",
  });
  let calls = 0;
  let active = 0,
    maxActive = 0;
  const progress: number[] = [];
  const deleted: string[] = [];
  const source = new ExperimentalYouTubeSource(
    c,
    async (_binary, args, signal, _timeout, _check, onOutput) => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      signal.throwIfAborted();
      assert.ok(args.includes("--ignore-config"));
      assert.ok(args.includes("--js-runtimes"));
      assert.ok(args.at(-1)?.startsWith("https://www.youtube.com/watch?v="));
      assert.ok(args.includes("--progress-template"));
      onOutput?.("download: 37.5%\n");
      const template = args[args.indexOf("-o") + 1];
      await writeFile(template.replace("%(ext)s", "mp4"), "test media bytes");
      active--;
      return "";
    },
    { height: 720, fps: 30 },
    {
      onDownload: (activity) => {
        if (activity?.percent !== null && activity?.percent !== undefined)
          progress.push(activity.percent);
      },
      onDelete: (filename) => deleted.push(filename),
    },
  );
  const item = (videoId: string): PlaylistItem => ({
    id: videoId,
    videoId,
    position: 0,
    title: "Test",
    channel: "",
    thumbnail: "",
    available: true,
    duration: 5,
  });
  const a = item("abcdefghijk"),
    b = item("lmnopqrstuv"),
    d = item("wxyzABCDEFG"),
    signal = new AbortController().signal;
  try {
    await assert.rejects(
      new ExperimentalYouTubeSource({
        ...c,
        EXPERIMENTAL_YOUTUBE: false,
      }).resolve(a, signal),
      /disabled/,
    );
    source.pin(a.videoId);
    const [one, two] = await Promise.all([
      source.resolve(a, signal),
      source.resolve(a, signal),
    ]);
    assert.equal(one, two);
    assert.equal(calls, 1);
    await source.resolve(b, signal);
    assert.equal(calls, 2);
    assert.equal((await readdir(path.join(root, "cache"))).length, 2);
    source.pin(b.videoId);
    await source.resolve(b, signal);
    assert.deepEqual(await readdir(path.join(root,"cache")), [b.videoId + ".720p30.mp4"]);
    assert.equal(calls,2,"cache cleanup must not redownload a hit");
    await source.resolve(d, signal);
    const names = await readdir(path.join(root, "cache"));
    assert.ok(names.includes(b.videoId + ".720p30.mp4"));
    assert.ok(names.includes(d.videoId + ".720p30.mp4"));
    assert.ok(!names.includes(a.videoId + ".720p30.mp4"));
    assert.equal(maxActive, 1, "different video downloads must remain serialized");
    assert.ok(progress.includes(0) && progress.includes(37.5) && progress.includes(100));
    assert.ok(deleted.some((name) => name.startsWith(a.videoId + ".")));
    const abort = new AbortController();
    const pending = withCancellation(new Promise(() => {}), abort.signal);
    abort.abort();
    await assert.rejects(pending, /Cancelled/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
