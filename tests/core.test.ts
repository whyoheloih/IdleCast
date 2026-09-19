import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readConfig,
  defaults,
  settingsSchema,
  playlistId,
} from "../server/config.js";
import { Store } from "../server/db.js";
import {
  YouTubePlaylistProvider,
  LocalMediaSource,
  parseDuration,
  type PlaylistItem,
} from "../server/providers.js";
import { backoff, runCapture } from "../server/process.js";
export const item = (id = "one", position = 0): PlaylistItem => ({
  id,
  videoId: "abcdefghijk",
  position,
  title: "Example",
  channel: "Channel",
  thumbnail: "",
  available: true,
  duration: 5,
});
test("strict config rejects weak passwords, malformed flags, insecure remote origins and invalid destinations", () => {
  assert.throws(() => readConfig({ ADMIN_PASSWORD: "short" }));
  assert.throws(() =>
    readConfig({ ADMIN_PASSWORD: "x".repeat(20), EXPERIMENTAL_YOUTUBE: "yes" }),
  );
  assert.throws(() =>
    readConfig({
      ADMIN_PASSWORD: "x".repeat(20),
      PUBLIC_ORIGIN: "http://example.com",
    }),
  );
  assert.equal(
    settingsSchema.parse(defaults).mediaSource,
    "youtube-experimental",
  );
  for (const server of [
    "rtmps://evil.example/app",
    "rtmps://ingest.global-contribute.live-video.net/app/SECRET",
    "rtmps://ingest.global-contribute.live-video.net:8080/app",
    "rtmp://ingest.global-contribute.live-video.net/app",
  ])
    assert.equal(
      settingsSchema.safeParse({
        ...defaults,
        twitch: { enabled: true, server },
      }).success,
      false,
    );
  assert.equal(
    settingsSchema.safeParse({ ...defaults, extra: "x" }).success,
    false,
  );
  assert.equal(
    settingsSchema.safeParse({ ...defaults, fps: 100 }).success,
    false,
  );
  assert.equal(
    playlistId("https://www.youtube.com/playlist?list=PL_example"),
    "PL_example",
  );
  assert.equal(
    settingsSchema.parse({
      ...defaults,
      playlistId: "https://www.youtube.com/watch?v=123&list=PL_abc",
    }).playlistId,
    "PL_abc",
  );
  assert.throws(() => playlistId("https://evil.example/?list=PL_abc"));
});
test("official API follows all pages, preserves duplicate videos and marks missing videos unavailable", async () => {
  const seen: URL[] = [];
  const request = async (input: any, init: any) => {
    const u = new URL(input);
    seen.push(u);
    assert.equal(init.headers["X-Goog-Api-Key"], "test-key");
    assert.equal(u.searchParams.has("key"), false);
    if (u.pathname.endsWith("/videos"))
      return Response.json({
        items: [
          {
            id: "abcdefghijk",
            status: { privacyStatus: "public" },
            snippet: { liveBroadcastContent: "none" },
            contentDetails: { duration: "PT1M5S" },
          },
        ],
      });
    const last = u.searchParams.has("pageToken");
    return Response.json({
      items: [
        {
          id: last ? "two" : "one",
          snippet: { position: last ? 1 : 0, title: "Test" },
          contentDetails: { videoId: "abcdefghijk" },
        },
        ...(last
          ? [
              {
                id: "three",
                snippet: { position: 2, title: "Private video" },
                contentDetails: { videoId: "missing" },
              },
            ]
          : []),
      ],
      ...(last ? {} : { nextPageToken: "next" }),
    });
  };
  const result = await new YouTubePlaylistProvider(
    "test-key",
    request as typeof fetch,
  ).fetch("PL_test", new AbortController().signal);
  assert.equal(seen.length, 3);
  assert.equal(seen[1].searchParams.get("pageToken"), "next");
  assert.equal(seen[0].searchParams.get("maxResults"), "50");
  assert.deepEqual(
    result.map((i) => i.id),
    ["one", "two", "three"],
  );
  assert.equal(result[0].duration, 65);
  assert.equal(result[2].available, false);
});
test("API errors and repeated pagination tokens reject instead of publishing partial data", async () => {
  const request = async () =>
    Response.json({ items: [], nextPageToken: "same" });
  await assert.rejects(
    new YouTubePlaylistProvider("key", request as typeof fetch).fetch(
      "PL",
      new AbortController().signal,
    ),
    /Repeated/,
  );
  await assert.rejects(
    new YouTubePlaylistProvider(
      "key",
      async () => new Response("", { status: 403 }),
    ).fetch("PL", new AbortController().signal),
    /403/,
  );
  assert.equal(parseDuration("P1DT2H3M4S"), 93784);
  assert.equal(parseDuration("nonsense"), null);
});
test("SQLite migration, atomic replacement, failure preservation, cursor and restart persistence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-db-"));
  const file = path.join(root, "test.db");
  let db = new Store(file);
  try {
    db.replace([item("one"), item("two", 1)]);
    assert.equal(db.move("two", 0), true);
    assert.deepEqual(db.all().map((row) => row.id), ["two", "one"]);
    assert.equal(db.move("missing", 0), false);
    db.fail("one", "Unavailable");
    db.set("cursor", { id: "two", offset: 7 });
    db.set("desired", true);
    assert.throws(() => db.replace([item("duplicate"), item("duplicate")]));
    assert.equal(db.count(), 2);
    db.replace([item("one", 3)]);
    assert.equal(db.all()[0].failures, 1);
    assert.equal(db.count(), 1);
    db.close();
    db = new Store(file);
    assert.deepEqual(db.get("cursor", null), { id: "two", offset: 7 });
    assert.equal(db.get("desired", false), true);
    for (let i = 0; i < 1010; i++) db.log("info", "Event");
    assert.equal(
      (db.db.prepare("SELECT count(*) AS n FROM logs").get() as any).n,
      1000,
    );
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("local source enforces identifier containment and missing-media errors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-source-"));
  try {
    await writeFile(path.join(root, "abcdefghijk.mp4"), "fixture");
    const p = new LocalMediaSource(root);
    assert.equal(
      await p.resolve(item(), new AbortController().signal),
      path.join(root, "abcdefghijk.mp4"),
    );
    await assert.rejects(
      p.resolve(
        { ...item(), videoId: "../outside" },
        new AbortController().signal,
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("media child cancellation and capped reconnect backoff", async () => {
  assert.equal(backoff(0), 1000);
  assert.equal(backoff(99), 30000);
  const controller = new AbortController();
  const promise = runCapture(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    controller.signal,
    20000,
  );
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(promise);
  await assert.rejects(
    runCapture("idlecast-no-such-binary", [], new AbortController().signal),
    /could not start/,
  );
});
