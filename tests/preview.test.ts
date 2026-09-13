import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readConfig, defaults, settingsSchema } from "../server/config.js";
import { OverlayPreview } from "../server/preview.js";
import { runCapture } from "../server/process.js";
import { Store } from "../server/db.js";
import { Engine } from "../server/engine.js";
import { createApp } from "../server/app.js";

const font =
  process.platform === "win32"
    ? "C:/Windows/Fonts/arial.ttf"
    : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const signal = () => new AbortController().signal;
test("preview uses real source frames, scales avatar and text independently, and isolates drafts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-preview-"));
  const c = readConfig({
    ADMIN_PASSWORD: randomBytes(24).toString("hex"),
    DATA_DIR: root,
    MEDIA_DIR: root,
    FONT_FILE: font,
  });
  const preview = new OverlayPreview(c);
  try {
    await mkdir(path.join(root, "avatars"));
    await mkdir(path.join(root, "overlay"));
    await writeFile(
      path.join(root, "overlay", "title.txt"),
      "Broadcast remains unchanged",
    );
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
      signal(),
    );
    const file = path.join(root, "source.mp4");
    await runCapture(
      "ffmpeg",
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=white:s=1280x720",
        "-t",
        "1",
        "-c:v",
        "libx264",
        file,
      ],
      signal(),
    );
    const source = { file, offset: 0.2, signal: signal() };
    async function measure(fontSize: number, avatarSize: number) {
      const settings = settingsSchema.parse({
        ...defaults,
        overlay: {
          ...defaults.overlay,
          title: "IdleCast",
          avatar: "avatar.png",
          fontSize,
          avatarSize,
        },
      });
      const png = await preview.render(settings, source, signal());
      assert.equal(png.readUInt32BE(16), 1280);
      assert.equal(png.readUInt32BE(20), 720);
      await writeFile(path.join(root, "frame.png"), png);
      const rgbFile = path.join(root, "frame.rgb");
      await runCapture(
        "ffmpeg",
        [
          "-y",
          "-i",
          path.join(root, "frame.png"),
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          rgbFile,
        ],
        signal(),
      );
      const data = await readFile(rgbFile);
      let minX = 1280,
        maxX = 0,
        minY = 720,
        maxY = 0,
        whiteText = 0;
      for (let y = 400; y < 692; y++)
        for (let x = 28; x < 600; x++) {
          const i = (y * 1280 + x) * 3,
            r = data[i],
            g = data[i + 1],
            b = data[i + 2];
          if (r > 230 && g < 30 && b < 30) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
          if (
            x >= 116 &&
            x < 280 &&
            y >= 625 &&
            y < 683 &&
            r > 240 &&
            g > 240 &&
            b > 240
          )
            whiteText++;
        }
      return { width: maxX - minX + 1, height: maxY - minY + 1, whiteText };
    }
    const small = await measure(24, 56),
      bigText = await measure(48, 56),
      bigAvatar = await measure(24, 112);
    assert.ok(
      Math.abs(small.width - 56) <= 2 && Math.abs(small.height - 56) <= 2,
    );
    assert.equal(bigText.width, small.width);
    assert.equal(bigText.height, small.height);
    assert.ok(
      bigText.whiteText > small.whiteText * 1.5,
      "larger text must produce more opaque text pixels",
    );
    assert.ok(
      Math.abs(bigAvatar.width - 112) <= 2 &&
        Math.abs(bigAvatar.height - 112) <= 2,
    );
    assert.equal(
      await readFile(path.join(root, "overlay", "title.txt"), "utf8"),
      "Broadcast remains unchanged",
    );
    const legacy = { ...defaults.overlay } as any;
    delete legacy.avatarSize;
    assert.equal(
      settingsSchema.parse({ ...defaults, overlay: legacy }).overlay.avatarSize,
      56,
    );
    assert.equal(
      settingsSchema.safeParse({
        ...defaults,
        overlay: { ...defaults.overlay, avatarSize: 10000 },
      }).success,
      false,
    );
  } finally {
    await preview.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("preview API requires authentication and Origin, renders drafts without saving, and saves sizes through settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-preview-api-"));
  const password = randomBytes(24).toString("hex");
  const c = readConfig({
    ADMIN_PASSWORD: password,
    DATA_DIR: root,
    FONT_FILE: font,
    EXPERIMENTAL_YOUTUBE: "true",
  });
  const db = new Store(":memory:"),
    engine = new Engine(db, c);
  const { app, closeStreams } = createApp(c, db, engine);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  try {
    const headers = {
      Origin: c.PUBLIC_ORIGIN,
      "Content-Type": "application/json",
    };
    assert.equal(
      (
        await fetch(base + "/api/overlay/preview", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      401,
    );
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ password }),
    });
    const authenticated = {
      ...headers,
      Cookie: login.headers.get("set-cookie")!.split(";")[0],
    };
    const draft = { ...defaults.overlay, fontSize: 48, avatarSize: 112 };
    const response = await fetch(base + "/api/overlay/preview", {
      method: "POST",
      headers: authenticated,
      body: JSON.stringify(draft),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type")!, /image\/png/);
    assert.equal(response.headers.get("x-preview-source"), "standby");
    assert.equal(db.settings().overlay.fontSize, 24);
    assert.equal(db.settings().overlay.avatarSize, 56);
    assert.equal(
      (
        await fetch(base + "/api/overlay/preview", {
          method: "POST",
          headers: { ...authenticated, Origin: "https://other.example" },
          body: JSON.stringify(draft),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/overlay/preview", {
          method: "POST",
          headers: authenticated,
          body: JSON.stringify({ ...draft, avatar: "../private.png" }),
        })
      ).status,
      400,
    );
    const saved = await fetch(base + "/api/overlay", {
      method: "PUT",
      headers: authenticated,
      body: JSON.stringify(draft),
    });
    assert.equal(saved.status, 200);
    assert.equal(db.settings().overlay.avatarSize, 112);
    assert.equal(db.settings().overlay.fontSize, 48);
  } finally {
    closeStreams();
    await engine.close();
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
