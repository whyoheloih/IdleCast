import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  mkdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readConfig, defaults } from "../server/config.js";
import { Store } from "../server/db.js";
import {
  Engine,
  countsTowardFailureHistory,
  pausesDownloadQueue,
  preserveSyncedShuffleOrder,
  reconcileQueueCursor,
  recoveryCircuitKind,
} from "../server/engine.js";
import { runCapture, delay } from "../server/process.js";
import {
  fallbackIndicatorColor,
  overlay,
  formatTimeline,
} from "../server/overlay.js";
import { diagnosticForMessage } from "../server/diagnostics.js";
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
test("systemic download outages do not poison per-video failure history", () => {
  assert.equal(countsTowardFailureHistory("YouTube requires account verification for this request"), false);
  assert.equal(countsTowardFailureHistory("YouTube rate limit reached; retry later"), false);
  assert.equal(countsTowardFailureHistory("Media file cannot be decoded"), true);
  assert.equal(
    pausesDownloadQueue("YouTube requires account verification for this request"),
    true,
  );
  assert.equal(pausesDownloadQueue("Media file cannot be decoded"), false);
});

test("recovery circuit classification targets shared failures but not individual bad videos", () => {
  assert.equal(recoveryCircuitKind("YouTube requires account verification"), "authentication");
  assert.equal(recoveryCircuitKind("HTTP 429 rate limit"), "rate-limit");
  assert.equal(recoveryCircuitKind("cache storage is unavailable"), "storage");
  assert.equal(recoveryCircuitKind("external drive disconnected"), "local-drive");
  assert.equal(recoveryCircuitKind("temporary network timeout"), "network");
  assert.equal(recoveryCircuitKind("JavaScript challenge failed"), "extractor");
  assert.equal(recoveryCircuitKind("required media executable could not start"), "runtime");
  assert.equal(recoveryCircuitKind("this one video is corrupt"), null);
});

test("playlist synchronization preserves established shuffle order and inserts new series episodes together", () => {
  const item = (
    id: string,
    position: number,
    seriesKey = "",
    seriesIndex: number | null = null,
  ) => ({
    id,
    videoId: id.padEnd(11, "0").slice(0, 11),
    position,
    title: id,
    channel: "Test",
    thumbnail: "",
    available: true,
    duration: 300,
    retryAt: 0,
    seriesKey,
    seriesIndex,
  });
  const previous = [
    item("episode-one", 0, "series", 1),
    item("episode-two", 1, "series", 2),
    item("ordinary", 2),
  ];
  const refreshed = [
    item("new-ordinary", 0),
    item("episode-three", 1, "series", 3),
    item("ordinary", 2),
    item("episode-two", 3, "series", 2),
    item("episode-one", 4, "series", 1),
  ];
  const result = preserveSyncedShuffleOrder(
    previous as any,
    refreshed as any,
  );
  assert.deepEqual(
    result.map((entry) => entry.id),
    [
      "episode-one",
      "episode-two",
      "episode-three",
      "ordinary",
      "new-ordinary",
    ],
  );
  assert.deepEqual(
    result.map((entry) => entry.position),
    [0, 1, 2, 3, 4],
  );
});
test("playlist synchronization preserves or safely reconciles the normal cursor", () => {
  const item = (id: string, position: number) => ({
    id,
    videoId: id.padEnd(11, "0").slice(0, 11),
    position,
    title: id,
    channel: "Test",
    thumbnail: "",
    available: true,
    duration: 300,
    retryAt: 0,
  });
  const previous = [item("one", 0), item("two", 1), item("three", 2)];
  const reordered = [item("three", 0), item("two", 1), item("one", 2)];
  assert.deepEqual(
    reconcileQueueCursor(previous as any, reordered as any, {
      id: "two",
      offset: 42,
    }),
    { id: "two", offset: 42 },
  );
  assert.deepEqual(
    reconcileQueueCursor(previous as any, [reordered[0], reordered[2]] as any, {
      id: "two",
      offset: 42,
    }),
    { id: "three", offset: 0 },
  );
});

test("Marathon normal handoff begins at an entry allowed by active series state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-handoff-rules-"));
  const db = new Store(path.join(root, "db.sqlite"));
  const make = (
    id: string,
    position: number,
    seriesKey = "",
    seriesIndex: number | null = null,
  ) => ({
    id,
    videoId: id.padEnd(11, "0").slice(0, 11),
    position,
    title: id,
    channel: "Test",
    thumbnail: "",
    available: true,
    duration: 300,
    retryAt: 0,
    seriesKey,
    seriesIndex,
  });
  const items = [
    make("blocked-series", 0, "another-series", 4),
    make("ordinary-one", 1),
    make("ordinary-two", 2),
    make("ordinary-three", 3),
    make("ordinary-four", 4),
    make("ordinary-five", 5),
  ];
  db.replace(items);
  db.set("settings", {
    ...defaults,
    shuffle: true,
    filters: {
      ...defaults.filters,
      seriesMode: "strict",
      seriesLimit: 3,
    },
  });
  db.set("cursor", { id: "blocked-series", offset: 0 });
  db.set("activeSeriesBlockKey", "current-series");
  db.set("ordinaryVideosSinceSeries", 0);
  const engine = new Engine(
    db,
    readConfig({
      ADMIN_PASSWORD: "test-password-long-enough",
      DATA_DIR: root,
      MEDIA_DIR: root,
      FONT_FILE: font,
    }),
  );
  try {
    const plan = (engine as any).ensureNormalHandoffPlan(
      "marathon-rules",
      db.all(),
    );
    assert.equal(plan.entryIds[0], "ordinary-one");
    assert.equal(plan.entryIds.includes("blocked-series"), false);
  } finally {
    await engine.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("startup revalidates a persisted recovered incident before it owns playback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-recovery-startup-"));
  const db = new Store(path.join(root, "db.sqlite"));
  const item = {
    id: "recovered-entry",
    videoId: "recover00001",
    position: 0,
    title: "Recovered intended video",
    channel: "Test",
    thumbnail: "",
    available: true,
    duration: 60,
    failures: 0,
    retryAt: 0,
    error: null,
    seriesKey: "",
    seriesIndex: null,
    liveStatus: "none",
    publishedAt: "2026-01-01T00:00:00Z",
    sourceType: "youtube",
  };
  db.set("activeRecoveryIncident", {
    id: "incident-1",
    intendedEntryId: item.id,
    intendedVideoId: item.videoId,
    intendedTitle: item.title,
    intendedItem: item,
    ownership: "normal",
    marathonId: null,
    marathonEntryId: null,
    status: "recovered",
    sourceType: "youtube",
    originalFailure: "download failed",
    attempts: 3,
    lastError: "",
    currentFallbackId: null,
    consecutiveFallbackCount: 0,
    startedAt: Date.now() - 60_000,
    lastAttemptAt: Date.now() - 30_000,
    completedAt: Date.now() - 10_000,
    preparedKey: item.videoId,
  });
  const engine = new Engine(
    db,
    readConfig({
      ADMIN_PASSWORD: "test-password-long-enough",
      DATA_DIR: root,
      MEDIA_DIR: root,
      FONT_FILE: font,
    }),
  );
  try {
    assert.equal((engine as any).restoreRecoveryForStartup(), true);
    const restored = db.get<any>("activeRecoveryIncident", null);
    assert.equal(restored.status, "recovering");
    assert.equal(restored.completedAt, null);
    assert.equal(restored.attempts, 3);
    assert.equal(restored.intendedEntryId, item.id);
    assert.match(restored.lastError, /revalidated after application restart/);
  } finally {
    await engine.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
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
    assert.equal(formatTimeline(65), "01:05");
    assert.equal(formatTimeline(8 * 60 * 60), "480:00");
    const result = await overlay(c, settings, undefined, "", {
        offset: 65,
        total: 130,
      }),
      output = path.join(root, "frame.rgb");
    assert.match(result.filter, /text=.*fontsize=21:x=w-tw-/);
    assert.ok(!result.inputs.some((value) => value.endsWith(".gif")));
    assert.doesNotMatch(result.filter, /countdownAnimation/);
    assert.match(result.filter, /Next video in/);
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
    let timelineOutline = 0;
    for (let y = 660; y < 710; y++)
      for (let x = 1050; x < 1260; x++)
        if (rgb(x, y).every((v) => v < 30)) timelineOutline++;
    assert.ok(timelineOutline > 20, "bottom-right timecode has a black outline");
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
test("Emergency Fallback hides bottom-left metadata and shows its streak indicator", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-fallback-overlay-"));
  try {
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
        avatar: "missing-avatar.png",
        title: "Fallback filename must stay hidden.mkv",
      },
    };
    const result = await overlay(
      c,
      settings,
      undefined,
      "2026-10-15T00:00:00Z",
      { offset: 10, total: 60 },
      { name: "Test Marathon", completed: 2, total: 8 },
      2,
    );

    assert.deepEqual(result.inputs, []);
    assert.match(result.filter, /drawbox=.*color=0xE5B93F/);
    assert.doesNotMatch(result.filter, /title\.txt|date\.txt|marathon\.txt/);
    assert.match(result.filter, /marathon-progress\.txt/);
    assert.match(result.filter, /Next video in/);
    assert.equal(
      await readFile(path.join(root, "overlay", "title.txt"), "utf8"),
      "",
    );
    assert.equal(
      await readFile(path.join(root, "overlay", "date.txt"), "utf8"),
      "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Emergency Fallback indicator colors reflect consecutive playback", () => {
  assert.equal(fallbackIndicatorColor(1), "0x43A047");
  assert.equal(fallbackIndicatorColor(2), "0xE5B93F");
  assert.equal(fallbackIndicatorColor(3), "0xF28C28");
  assert.equal(fallbackIndicatorColor(4), "0xE53935");
  assert.equal(fallbackIndicatorColor(5), "0x8B1E1E");
  assert.equal(fallbackIndicatorColor(6), "0x7E57C2");
  assert.equal(fallbackIndicatorColor(12), "0x7E57C2");
});

test("Emergency Fallback status text is not misclassified as a media merge failure", () => {
  assert.notEqual(
    diagnosticForMessage("Emergency fallback completed; recovery was checked and remains paused"),
    "IC-DL-007",
  );
  assert.equal(
    diagnosticForMessage("Downloaded media merge failed"),
    "IC-DL-007",
  );
});

test("buffer reservations prevent transition retain updates from deleting later queued media", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-buffer-retain-"));
  const file = path.join(root, "prepared.mp4");
  const db = new Store(path.join(root, "db.sqlite"));
  const retained = new Set<string>();
  try {
    await writeFile(file, "fixture");
    const c = readConfig({
      ADMIN_PASSWORD: "test-password-long-enough",
      DATA_DIR: root,
      MEDIA_DIR: root,
      FONT_FILE: font,
    });
    let engine: Engine;
    const source = {
      retain(ids: string[]) {
        retained.clear();
        for (const id of ids) retained.add(id);
      },
      async resolve(item: PlaylistItem) {
        if (item.id === "first")
          source.retain((engine as any).retainedVideoIds([item.videoId]));
        assert.ok(
          retained.has(item.videoId),
          `${item.id} must remain protected while the rolling refill is active`,
        );
        return file;
      },
    };
    engine = new Engine(db, c, { source });
    (engine as any).probeMedia = async () => ({
      streams: [{ codec_type: "video" }],
      format: { duration: 60 },
    });
    const items = ["first", "second"].map((id, position) => ({
      id,
      videoId: id === "first" ? "first000001" : "second00001",
      position,
      title: id,
      channel: "Test",
      thumbnail: "",
      available: true,
      duration: 60,
      retryAt: 0,
    }));
    await (engine as any).fillBuffer(source, items, signal(), 2, 0);
    assert.equal((engine as any).preparedMedia.has("first000001"), true);
    assert.equal((engine as any).preparedMedia.has("second00001"), true);
    assert.equal((engine as any).bufferReservations.size, 0);
    await engine.close();
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("failed prepared media is evicted instead of poisoning the buffer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "idlecast-failed-transition-"));
  const file = path.join(root, "source.mp4");
  const db = new Store(path.join(root, "db.sqlite"));
  const removed: string[] = [];
  let releaseRemoval = () => {};
  const removalBlocked = new Promise<void>((resolve) => { releaseRemoval = resolve; });
  try {
    await runCapture(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "color=s=320x180:r=30", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", file],
      signal(),
    );
    const c = readConfig({
      ADMIN_PASSWORD: "test-password-long-enough",
      DATA_DIR: root,
      MEDIA_DIR: root,
      FONT_FILE: font,
      FFMPEG_PATH: path.join(root, "missing-ffmpeg.exe"),
    });
    db.set("settings", { ...defaults, mediaSource: "local", youtube: { ...defaults.youtube, enabled: true } });
    db.replace([{
      id: "broken", videoId: "abcdefghijk", position: 0, title: "Broken activation",
      channel: "Test", thumbnail: "", available: true, duration: 1,
    }]);
    const engine = new Engine(db, c, {
      source: {
        resolve: async () => file,
        remove: async (id) => { removed.push(id); await removalBlocked; },
      },
      outputs: { youtube: { name: "youtube", args: () => [] } },
    });
    try {
      await engine.start();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !removed.length)
        await delay(100, signal());
      assert.deepEqual(removed, ["abcdefghijk"]);
      assert.equal((engine as any).bufferedIds.has("abcdefghijk"), false);
      assert.equal((engine as any).preparedMedia.has("abcdefghijk"), false);
    } finally {
      releaseRemoval();
      await engine.stop(true);
      await engine.close();
    }
  } finally {
    db.close();
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
    {
      ...make("missing", "missing00000", 0),
      sourceType: "local",
      localPath: path.join(root, "missing00000.mp4"),
      localIdentity: "missing-local-fixture",
      available: false,
    },
    make("first", "video000001", 1),
    make("second", "video000002", 2),
    make("third", "video000003", 3),
    make("fourth", "video000004", 4),
    make("fifth", "video000005", 5),
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
        if (i.id === "missing") return local.resolve(i, s);
        return file;
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
      logs.some((l) => l.message === "Startup buffer ready: 3/3 videos"),
      JSON.stringify(logs),
    );
    assert.equal(
      logs.some((l) => l.message.includes("-> missing00000")),
      false,
      "an unavailable local entry must not become the intended playback owner",
    );
    const finished = logs
      .filter((l) => l.message.startsWith("Finished:"))
      .sort((a, b) => a.id - b.id)
      .map((l) => l.message.slice("Finished: ".length));
    assert.ok(finished.length >= 3, JSON.stringify(logs));
    assert.deepEqual(
      finished.slice(0, 3),
      ["first", "second", "third"],
      "normal queue entries must finish once each in authoritative order",
    );
    assert.ok(
      engine.outputs.twitch.retries > 0,
      "failed output should reconnect independently",
    );
    await engine.stop(true);
    assert.match(
      await readFile(path.join(root, "overlay", "title.txt"), "utf8"),
      /^(first|second|third|fourth|fifth)$/,
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
    assert.equal(engine.state, "buffering");
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
