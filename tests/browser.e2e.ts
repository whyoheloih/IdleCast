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
import { runCapture } from "../server/process.js";
const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-browser-"));
const password = randomBytes(24).toString("base64url");
const c = readConfig({
  ADMIN_PASSWORD: password,
  EXPERIMENTAL_YOUTUBE: "true",
  DATA_DIR: root,
  MEDIA_DIR: root,
  FONT_FILE:
    process.platform === "win32"
      ? "C:/Windows/Fonts/arial.ttf"
      : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
});
await mkdir(path.join(root, "avatars"));
await runCapture(
  "ffmpeg",
  [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=56x56",
    "-frames:v",
    "1",
    path.join(root, "avatars", "avatar.png"),
  ],
  new AbortController().signal,
);
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
  assert.equal(
    await page.getByRole("button", { name: "Reload update" }).count(),
    1,
  );
  await page.screenshot({
    path: path.join(screenshots, "desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Playlist", exact: true }).click();
  await page.getByText("Test playlist video 1", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Move Test playlist video 1 down" })
    .click();
  await page
    .getByText("Queue order saved. Syncing again will create a new source order.")
    .waitFor();
  assert.deepEqual(
    db.all().slice(0, 2).map((item) => item.title),
    ["Test playlist video 2", "Test playlist video 1"],
  );
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
  await page.getByLabel("Video bitrate (kbps)").fill("3500");
  await page.getByRole("button", { name: "Open overlay preview" }).click();
  const editor = page.getByRole("dialog", { name: "Overlay preview" });
  await editor
    .getByLabel("Avatar filename", { exact: true })
    .fill("avatar.png");
  await editor.getByRole("slider", { name: "Text size" }).fill("48");
  await editor
    .getByRole("slider", { name: "Profile picture size" })
    .fill("112");
  await editor.getByText("Preview ready", { exact: true }).waitFor();
  const previewImage = editor.getByAltText("Stream overlay preview");
  await previewImage.waitFor();
  assert.equal(
    await previewImage.evaluate((img: HTMLImageElement) => img.naturalWidth),
    1280,
  );
  assert.equal(
    db.settings().overlay.avatarSize,
    56,
    "preview must not save until confirmed",
  );
  await page.screenshot({
    path: path.join(screenshots, "overlay-editor.png"),
    fullPage: false,
  });
  await editor
    .getByRole("button", { name: "Save overlay", exact: true })
    .click();
  await page.getByText("Overlay settings saved.", { exact: true }).waitFor();
  assert.equal(db.settings().overlay.fontSize, 48);
  assert.equal(db.settings().overlay.avatarSize, 112);
  assert.equal(
    db.settings().bitrateKbps,
    2500,
    "overlay save must not persist unrelated drafts",
  );
  assert.equal(
    await page.getByLabel("Video bitrate (kbps)").inputValue(),
    "3500",
    "overlay save must preserve unrelated drafts in the form",
  );
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
  await page.getByRole("button", { name: "Open overlay preview" }).click();
  await editor.getByText("Preview ready", { exact: true }).waitFor();
  assert.equal(
    await editor
      .getByRole("slider", { name: "Profile picture size" })
      .inputValue(),
    "112",
  );
  await page.screenshot({
    path: path.join(screenshots, "overlay-editor-mobile.png"),
    fullPage: false,
  });
  assert.ok(
    await editor.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
    "mobile editor should not overflow horizontally",
  );
  await editor
    .getByRole("slider", { name: "Profile picture size" })
    .fill("150");
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    db.settings().overlay.avatarSize,
    112,
    "cancel must discard resizing",
  );
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "mobile settings should have no horizontal overflow",
  );
  await page.getByLabel("Queue source").selectOption("channel");
  await page
    .getByLabel("YouTube channel URL or @handle")
    .fill("https://www.youtube.com/@Example");
  await page
    .getByLabel("Exclude title words or phrases (one per line)")
    .fill("Trailer\nAnnouncement");
  await page.getByLabel("Shuffle", {exact:true}).check();
  await page.getByLabel("Resolution", { exact: true }).selectOption("1080");
  await page.getByLabel("Frame rate", { exact: true }).selectOption("60");
  await page
    .getByRole("button", { name: "Save settings", exact: true })
    .click();
  await page
    .getByText("Settings saved. Sync your playlist to refresh the queue.")
    .waitFor();
  assert.equal(db.settings().sourceMode, "channel");
  assert.equal(db.settings().shuffle, true);
  assert.deepEqual(db.settings().excludedWords, ["Trailer", "Announcement"]);
  assert.equal(db.settings().height, 1080);
  assert.equal(db.settings().fps, 60);
  assert.equal(
    await page
      .getByRole("button", { name: "Sync playlist", exact: true })
      .isDisabled(),
    false,
    "channel and combined sources must enable synchronization",
  );
  await page
    .getByLabel("YouTube API key", { exact: true })
    .fill("browser-secret-test");
  await page
    .getByRole("button", { name: "Save credentials", exact: true })
    .click();
  await page
    .getByText("Credentials saved and applied. No restart needed.")
    .waitFor();
  assert.equal(c.YOUTUBE_API_KEY, "browser-secret-test");
  assert.equal(
    await page.getByLabel("YouTube API key", { exact: true }).inputValue(),
    "",
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
