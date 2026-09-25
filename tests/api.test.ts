import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readConfig, defaults } from "../server/config.js";
import { Store } from "../server/db.js";
import { Engine } from "../server/engine.js";
import { createApp } from "../server/app.js";
test("admin authentication, write-origin checks, secret exclusion, validation, and logout", async () => {
  const password = randomBytes(24).toString("hex");
  const c = readConfig({
    ADMIN_PASSWORD: password,
    EXPERIMENTAL_YOUTUBE: "true",
    YOUTUBE_API_KEY: "api-secret-sentinel",
    YOUTUBE_STREAM_KEY: "stream-secret-sentinel",
  });
  const store = new Store(":memory:");
  const engine = new Engine(store, c);
  const { app, closeStreams } = createApp(c, store, engine);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  try {
    assert.equal((await fetch(base + "/api/state")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        })
      ).status,
      403,
    );
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: c.PUBLIC_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    assert.equal(login.status, 200);
    const set = login.headers.get("set-cookie")!;
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/i);
    const cookie = set.split(";")[0];
    const headers = {
      Cookie: cookie,
      Origin: c.PUBLIC_ORIGIN,
      "Content-Type": "application/json",
    };
    const response = await fetch(base + "/api/settings", { headers });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes("secret-sentinel"), false);
    assert.equal(text.includes(password), false);
    assert.equal(
      (
        await fetch(base + "/api/settings", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            ...defaults,
            playlistId: "https://www.youtube.com/playlist?list=PL_abc",
          }),
        })
      ).status,
      200,
    );
    assert.equal(store.settings().playlistId, "PL_abc");
    assert.equal(
      (
        await fetch(base + "/api/settings", {
          method: "PUT",
          headers,
          body: JSON.stringify({ ...defaults, bitrateKbps: 99999 }),
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(base + "/api/playlist?limit=999999", { headers })).status,
      400,
    );
    store.set("settings", { ...store.settings(), shuffle: true });
    store.replace([
      { id: "one", videoId: "abcdefghijk", position: 0, title: "One", channel: "", thumbnail: "", available: true, duration: 1 },
      { id: "two", videoId: "lmnopqrstuv", position: 1, title: "Two", channel: "", thumbnail: "", available: true, duration: 1 },
      { id: "long", videoId: "zzzzzzzzzzz", position: 2, title: "Long", channel: "", thumbnail: "", available: true, duration: 5000 },
    ]);
    assert.equal(
      (
        await fetch(base + "/api/playlist/order", {
          method: "PUT",
          headers,
          body: JSON.stringify({ id: "two", to: 0 }),
        })
      ).status,
      200,
    );
    assert.deepEqual(store.all().map((row) => row.id), ["two", "one", "long"]);
    assert.equal(
      (
        await fetch(base + "/api/playlist/order", {
          method: "PUT",
          headers,
          body: JSON.stringify({ id: "long", to: 0 }),
        })
      ).status,
      400,
    );
    assert.deepEqual(store.all().map((row) => row.id), ["two", "one", "long"]);

    store.set("settings", { ...store.settings(), shuffle: false });
    store.replace(
      Array.from({ length: 6 }, (_, index) => ({
        id: "drag-" + index,
        videoId: ("dragvideo" + index).padEnd(11, "0").slice(0, 11),
        position: index,
        title: "Drag " + index,
        channel: "",
        thumbnail: "",
        available: true,
        duration: 60,
      })),
    );
    engine.state = "playing";
    engine.current = store.all()[0];
    (engine as any).bufferedIds = new Set(
      store.all().slice(0, 5).map((item) => item.videoId),
    );
    const needsConfirmation = await fetch(base + "/api/playlist/order", {
      method: "PUT",
      headers,
      body: JSON.stringify({ id: "drag-5", to: 1 }),
    });
    assert.equal(needsConfirmation.status, 409);
    assert.equal((await needsConfirmation.json()).requiresConfirmation, true);
    assert.equal(
      (
        await fetch(base + "/api/playlist/order", {
          method: "PUT",
          headers,
          body: JSON.stringify({
            id: "drag-5",
            to: 1,
            confirmBufferChange: true,
          }),
        })
      ).status,
      200,
    );
    assert.equal(store.all()[1].id, "drag-5");
    engine.state = "stopped";

    store.set("desired", true);
    assert.equal(
      (
        await fetch(base + "/api/stop", {
          method: "POST",
          headers,
          body: JSON.stringify({ preserveDesired: true }),
        })
      ).status,
      200,
    );
    assert.equal(store.get("desired", false), true);
    assert.equal(
      (
        await fetch(base + "/api/stop", {
          method: "POST",
          headers,
        })
      ).status,
      200,
    );
    assert.equal(store.get("desired", true), false);

    assert.equal(
      (await fetch(base + "/api/start", { method: "POST", headers })).status,
      400,
    );
    assert.equal(
      (await fetch(base + "/api/logout", { method: "POST", headers })).status,
      200,
    );
    assert.equal((await fetch(base + "/api/state", { headers })).status, 401);
  } finally {
    await closeStreams();
    await engine.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});
