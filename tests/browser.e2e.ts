import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readConfig, defaults } from "../server/config.js";
import { Store } from "../server/db.js";
import { Engine } from "../server/engine.js";
import { createApp } from "../server/app.js";
const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-browser-"));
const password = randomBytes(24).toString("base64url");
const c = readConfig({
  ADMIN_PASSWORD: password,
  EXPERIMENTAL_YOUTUBE: "true",
  DATA_DIR: root,
});
const db = new Store(":memory:");
db.set("settings", { ...defaults, playlistId: "PL_fixture" });
db.replace(
  Array.from({ length: 1000 }, (_, i) => ({
    id: "item-" + i,
    videoId: "abcdefghijk",
    position: i,
    title: "Test playlist video " + (i + 1),
    channel: "Test channel",
    thumbnail: "",
    available: true,
    duration: 120,
  })),
);
const engine = new Engine(db, c);
const { app, closeStreams } = createApp(c, db, engine);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((r) => server.once("listening", r));
const url = "http://127.0.0.1:" + (server.address() as any).port;
c.PUBLIC_ORIGIN = url;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const screenshots =
  process.env.SCREENSHOT_DIR ?? path.join(root, "screenshots");
await mkdir(screenshots, { recursive: true });
try {
  await page.goto(url);
  await page.getByLabel("Admin password").fill(password);
  await page.getByRole("button", { name: "Enter control room" }).click();
  await page
    .getByRole("heading", { name: "Your broadcast, at a glance." })
    .waitFor();
  await page.getByText("Test playlist video 1", { exact: true }).waitFor();
  await page.screenshot({
    path: path.join(screenshots, "desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Playlist", exact: true }).click();
  await page.getByText("Test playlist video 1", { exact: true }).waitFor();
  assert.ok(
    (await page.locator(".playlist-row").count()) < 40,
    "playlist should virtualize 1000 rows",
  );
  await page
    .locator(".virtual-list")
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.getByText("Test playlist video 1000", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("YouTube playlist link or ID")
    .fill("https://www.youtube.com/playlist?list=PL_fixture");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await page
    .getByText("Settings saved. Sync your playlist to refresh the queue.")
    .waitFor();
  assert.equal(db.settings().playlistId, "PL_fixture");
  assert.equal(db.settings().mediaSource, "youtube-experimental");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.join(screenshots, "mobile.png"),
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "mobile should have no horizontal overflow",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "mobile settings should have no horizontal overflow",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser verification passed: login, playlist-link save, 1000-row virtualization, desktop and mobile layout, no runtime errors.",
  );
} finally {
  await browser.close();
  closeStreams();
  await engine.close();
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  await rm(root, { recursive: true, force: true });
}
