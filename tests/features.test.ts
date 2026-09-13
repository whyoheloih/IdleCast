import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaults, readConfig, settingsSchema } from "../server/config.js";
import { prepareQueue } from "../server/queue.js";
import { YouTubePlaylistProvider } from "../server/providers.js";
import { Store } from "../server/db.js";
import { Engine } from "../server/engine.js";
import { createApp } from "../server/app.js";
import { credentialStore } from "../server/credentials.js";

test("combined sources deduplicate video identities and retain upload dates", async () => {
  const db = new Store(":memory:");
  db.set("settings", {...defaults,sources:[{kind:"playlist",value:"PL_one"},{kind:"playlist",value:"PL_two"}]});
  const engine = new Engine(db,readConfig({ADMIN_PASSWORD:"test-password-long-enough"}),{playlist:{async fetch(id) {
    return ["shared",id].map((videoId,position)=>({id:id+videoId,videoId,position,title:videoId,channel:"channel",thumbnail:"",available:true,duration:60,publishedAt:"2026-09-13T00:00:00Z"}));
  }}});
  try {
    await engine.sync();
    assert.equal(db.count(),3);
    assert.equal(db.get<Record<string,string>>("uploadDates",{}).shared,"2026-09-13T00:00:00Z");
  } finally {await engine.close();db.close();}
});

test("channel handle resolves uploads and title filtering/shuffle preserves duplicates", async () => {
  const provider = new YouTubePlaylistProvider("test", async (input: any) => {
    const url = new URL(input);
    assert.equal(url.pathname, "/youtube/v3/channels");
    assert.equal(url.searchParams.get("forHandle"), "@Example");
    return new Response(
      JSON.stringify({
        items: [
          { contentDetails: { relatedPlaylists: { uploads: "UU_example" } } },
        ],
      }),
    );
  });
  assert.equal(
    await provider.channelUploads(
      "https://www.youtube.com/@Example/videos",
      new AbortController().signal,
    ),
    "UU_example",
  );
  await assert.rejects(
    provider.channelUploads(
      "https://evil.example/@Example",
      new AbortController().signal,
    ),
  );
  const items = ["Gameplay", "TRAILER today", "Gameplay", "Announcement"].map(
    (title, i) => ({
      id: String(i),
      videoId: "abcdefghijk",
      position: i,
      title,
      channel: "x",
      thumbnail: "",
      available: true,
      duration: 1,
    }),
  );
  const settings = settingsSchema.parse({
    ...defaults,
    excludedWords: ["trailer", "announcement", ""],
    shuffle: true,
  });
  const q = prepareQueue(items, settings, () => 0);
  assert.equal(q.excluded, 2);
  assert.deepEqual(
    q.items.map((i) => i.id),
    ["2", "0"],
  );
  assert.deepEqual(
    q.items.map((i) => i.position),
    [0, 1],
  );
  assert.equal(items[0].position, 0);
});

test("credentials API authenticates, encrypts, applies immediately, persists and restores env fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-credentials-"));
  const c = readConfig({
    ADMIN_PASSWORD: "test-password-long-enough",
    DATA_DIR: root,
    YOUTUBE_API_KEY: "env-fallback",
  });
  const db = new Store(path.join(root, "test.db"));
  const engine = new Engine(db, c);
  const { app, closeStreams } = createApp(c, db, engine);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  try {
    const headers = {
      "Content-Type": "application/json",
      Origin: c.PUBLIC_ORIGIN,
    };
    assert.equal(
      (
        await fetch(base + "/api/credentials", {
          method: "PUT",
          headers,
          body: "{}",
        })
      ).status,
      401,
    );
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ password: c.ADMIN_PASSWORD }),
    });
    const auth = {
      ...headers,
      Cookie: login.headers.get("set-cookie")!.split(";")[0],
    };
    const save = (body: any, h = auth) =>
      fetch(base + "/api/credentials", {
        method: "PUT",
        headers: h,
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await save(
          { YOUTUBE_API_KEY: "new-secret-key" },
          { ...auth, Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await save({
          YOUTUBE_API_KEY: "new-secret-key",
          YOUTUBE_STREAM_KEY: "stream-secret-key",
        })
      ).status,
      200,
    );
    assert.equal(c.YOUTUBE_API_KEY, "new-secret-key");
    assert.equal(c.YOUTUBE_STREAM_KEY, "stream-secret-key");
    assert.ok(!db.get("credentialsEncrypted", "").includes("secret-key"));
    assert.ok(
      !(
        await (await fetch(base + "/api/settings", { headers: auth })).text()
      ).includes("secret-key"),
    );
    assert.ok(!JSON.stringify(db.logs()).includes("secret-key"));
    const restarted = readConfig({
      ADMIN_PASSWORD: c.ADMIN_PASSWORD,
      DATA_DIR: root,
      YOUTUBE_API_KEY: "env-fallback",
    });
    credentialStore(restarted, db);
    assert.equal(restarted.YOUTUBE_API_KEY, "new-secret-key");
    engine.state = "playing";
    assert.equal((await save({ YOUTUBE_API_KEY: "blocked" })).status, 409);
    engine.state = "stopped";
    assert.equal((await save({ YOUTUBE_API_KEY: null })).status, 200);
    assert.equal(c.YOUTUBE_API_KEY, "env-fallback");
    assert.equal(
      (await readFile(path.join(root, "credentials.key"))).length,
      32,
    );
  } finally {
    closeStreams();
    await engine.close();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
