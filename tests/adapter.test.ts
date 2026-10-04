import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readConfig } from "../server/config.js";
import {
  ExperimentalYouTubeSource,
  isRetryableDownloadFailure,
  type PlaylistItem,
} from "../server/providers.js";
import { withCancellation } from "../server/process.js";
test("deterministic downloader failures skip pointless retries", async () => {
  assert.equal(
    isRetryableDownloadFailure(
      "YouTube requires account verification for this request",
    ),
    false,
  );
  assert.equal(
    isRetryableDownloadFailure("YouTube rate limit reached; retry later"),
    false,
  );
  assert.equal(isRetryableDownloadFailure("Temporary network failure"), true);
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-auth-failure-"));
  const c = readConfig({
    ADMIN_PASSWORD: "test-password-long-enough",
    DATA_DIR: root,
    EXPERIMENTAL_YOUTUBE: "true",
  });
  let calls = 0;
  const source = new ExperimentalYouTubeSource(c, async () => {
    calls++;
    throw new Error("YouTube requires account verification for this request");
  });
  try {
    await assert.rejects(
      source.resolve(
        {
          id: "auth",
          videoId: "abcdefghijk",
          position: 0,
          title: "Auth test",
          channel: "",
          thumbnail: "",
          available: true,
          duration: 10,
        },
        new AbortController().signal,
      ),
      /account verification/,
    );
    assert.equal(calls, 1);
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("stale authenticated cookies fall back to public YouTube clients", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-cookie-fallback-"));
  const cookieFile = path.join(root, "youtube-cookies.txt");
  await writeFile(cookieFile, "# Netscape HTTP Cookie File\n");
  const c = readConfig({
    ADMIN_PASSWORD: "test-password-long-enough",
    DATA_DIR: root,
    EXPERIMENTAL_YOUTUBE: "true",
    YTDLP_COOKIES_FILE: cookieFile,
  });
  const calls: string[][] = [];
  const source = new ExperimentalYouTubeSource(c, async (
    _binary,
    args,
  ) => {
    calls.push(args);
    if (calls.length === 1)
      throw new Error("YouTube requires account verification for this request");
    const template = args[args.indexOf("-o") + 1];
    await writeFile(template.replace("%(ext)s", "mp4"), "fallback media");
    return "";
  });
  try {
    const file = await source.resolve(
      {
        id: "fallback",
        videoId: "abcdefghijk",
        position: 0,
        title: "Fallback test",
        channel: "",
        thumbnail: "",
        available: true,
        duration: 10,
      },
      new AbortController().signal,
    );
    assert.match(file, /abcdefghijk\.720p30\.mp4$/);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes("--cookies"));
    assert.equal(
      calls[0][calls[0].indexOf("--extractor-args") + 1],
      "youtube:player_client=default,web_embedded",
    );
    assert.equal(calls[1].includes("--cookies"), false);
    assert.equal(
      calls[1][calls[1].indexOf("--extractor-args") + 1],
      "youtube:player_client=android_vr,web_embedded",
    );
    await source.resolve(
      {
        id: "next",
        videoId: "lmnopqrstuv",
        position: 1,
        title: "Next fallback test",
        channel: "",
        thumbnail: "",
        available: true,
        duration: 10,
      },
      new AbortController().signal,
    );
    assert.equal(calls.length, 3);
    assert.equal(calls[2].includes("--cookies"), false);
    assert.equal(
      calls[2][calls[2].indexOf("--extractor-args") + 1],
      "youtube:player_client=android_vr,web_embedded",
    );
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("experimental adapter reports progress, retains five videos, deletes completed media and serializes downloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-adapter-"));
  const c = readConfig({
    ADMIN_PASSWORD: "test-password-long-enough",
    DATA_DIR: root,
    EXPERIMENTAL_YOUTUBE: "true",
    YTDLP_COOKIES_FILE: path.join(root, "youtube-cookies.txt"),
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
      assert.equal(
        args[args.indexOf("--cookies") + 1],
        path.join(root, "youtube-cookies.txt"),
      );
      assert.ok(args.includes("--js-runtimes"));
      assert.ok(args.at(-1)?.startsWith("https://www.youtube.com/watch?v="));
      assert.ok(args.includes("--progress-template"));
      assert.equal(
        args[args.indexOf("--concurrent-fragments") + 1],
        "4",
      );
      assert.equal(args[args.indexOf("--buffer-size") + 1], "1M");
      onOutput?.("idlecast:37.5%\n");
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
    e = item("HIJKLMNOPQR"),
    f = item("RSTUVWXYZ01"),
    g = item("234567890ab"),
    signal = new AbortController().signal;
  try {
    await assert.rejects(
      new ExperimentalYouTubeSource({
        ...c,
        EXPERIMENTAL_YOUTUBE: false,
      }).resolve(a, signal),
      /disabled/,
    );
    source.retain([a, b, d, e, f].map((value) => value.videoId));
    const [one, two] = await Promise.all([
      source.resolve(a, signal),
      source.resolve(a, signal),
      source.resolve(b, signal),
      source.resolve(d, signal),
      source.resolve(e, signal),
      source.resolve(f, signal),
    ]);
    assert.equal(one, two);
    assert.equal(calls, 5);
    assert.equal((await readdir(path.join(root, "cache"))).length, 5);
    await source.resolve(b, signal);
    assert.equal(calls, 5, "a cache hit must not redownload media");
    await source.remove(a.videoId);
    assert.equal((await readdir(path.join(root, "cache"))).length, 4);
    source.retain([b, d, e, f, g].map((value) => value.videoId));
    await source.resolve(g, signal);
    const names = await readdir(path.join(root, "cache"));
    assert.equal(names.length, 5);
    assert.ok(names.includes(b.videoId + ".720p30.mp4"));
    assert.ok(names.includes(g.videoId + ".720p30.mp4"));
    assert.ok(!names.includes(a.videoId + ".720p30.mp4"));
    assert.equal(maxActive, 1, "different video downloads must remain serialized");
    assert.ok(progress.includes(0) && progress.includes(37.5) && progress.includes(100));
    assert.ok(deleted.some((name) => name.startsWith(a.videoId + ".")));
    const abort = new AbortController();
    const pending = withCancellation(new Promise(() => {}), abort.signal);
    abort.abort();
    await assert.rejects(pending, /Cancelled/);
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("download accounting excludes retained files and reserves half the cache per video", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-download-accounting-"));
  const cache = path.join(root, "cache");
  await mkdir(cache, { recursive: true });
  await writeFile(path.join(cache, "lmnopqrstuv.720p30.mp4"), Buffer.alloc(1024 * 1024));
  const c = readConfig({
    ADMIN_PASSWORD: "test-password-long-enough",
    DATA_DIR: root,
    CACHE_MAX_MB: "100",
    EXPERIMENTAL_YOUTUBE: "true",
  });
  const bytes: number[] = [];
  let seenArgs: string[] = [];
  const source = new ExperimentalYouTubeSource(
    c,
    async (_binary, args, _signal, _timeout, check, onOutput) => {
      seenArgs = args;
      const template = args[args.indexOf("-o") + 1];
      await writeFile(template.replace("%(ext)s", "part"), "1234567890");
      await check?.();
      onOutput?.("idlecast:50%\n");
      await rm(template.replace("%(ext)s", "part"), { force: true });
      await writeFile(template.replace("%(ext)s", "mp4"), "finished media");
      return "";
    },
    { height: 720, fps: 30 },
    {
      onDownload: (activity) => {
        if (activity?.bytes !== undefined) bytes.push(activity.bytes);
      },
    },
  );
  source.retain(["lmnopqrstuv", "abcdefghijk"]);
  try {
    await source.resolve(
      {
        id: "accounting",
        videoId: "abcdefghijk",
        position: 0,
        title: "Accounting test",
        channel: "",
        thumbnail: "",
        available: true,
        duration: 10,
      },
      new AbortController().signal,
    );
    assert.equal(
      seenArgs[seenArgs.indexOf("--max-filesize") + 1],
      String(50 * 1024 * 1024),
    );
    assert.equal(
      seenArgs[seenArgs.indexOf("--extractor-args") + 1],
      "youtube:player_client=android_vr,web_embedded",
    );
    assert.ok(bytes.includes(10), "active download bytes should be reported");
    assert.ok(
      bytes.every((value) => value < 1024 * 1024),
      "retained cache files must not inflate active download progress",
    );
  } finally {
    await source.close();
    await rm(root, { recursive: true, force: true });
  }
});
