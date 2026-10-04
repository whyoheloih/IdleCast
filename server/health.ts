import { readFile, readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import type { Store } from "./db.js";
import type { Engine } from "./engine.js";
import { DIAGNOSTIC_REGISTRY, sanitizeDiagnosticRuntime, type DiagnosticCode, type DiagnosticRecord } from "./diagnostics.js";
import { runCapture } from "./process.js";
import { APP_VERSION } from "./version.js";

export type HealthStatus = "healthy" | "degraded" | "critical" | "available" | "inactive" | "unknown";
export type HealthItem = {
  id: string;
  label: string;
  status: HealthStatus;
  summary: string;
  details: Record<string, string | number | boolean | null>;
  diagnostic: { record: DiagnosticRecord; definition: (typeof DIAGNOSTIC_REGISTRY)[DiagnosticCode] } | null;
};

const safeTime = (value: any) => Number(value?.time) || 0;
const age = (timestamp: number) => timestamp ? Math.max(0, Date.now() - timestamp) : null;
const ageText = (timestamp: number) => {
  const ms = age(timestamp);
  if (ms === null) return "Never";
  if (ms < 60000) return "Less than a minute ago";
  if (ms < 3600000) return `${Math.floor(ms / 60000)} minutes ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)} hours ago`;
  return `${Math.floor(ms / 86400000)} days ago`;
};
const statusFor = (record: DiagnosticRecord | null): HealthStatus =>
  record ? (DIAGNOSTIC_REGISTRY[record.code].severity === "critical" ? "critical" : "degraded") : "healthy";

export async function buildHealth(c: Config, store: Store, engine: Engine) {
  const snapshot = engine.snapshot();
  const settings = store.settings();
  const records = store.diagnostics(100).map((record) => ({
    ...record,
    observed: String(sanitizeDiagnosticRuntime(record.observed)),
    runtime: sanitizeDiagnosticRuntime(record.runtime) as Record<string, unknown>,
  }));
  const latest = (codes: string[], recoveredAt = 0) =>
    records.find((record) => codes.some((code) => record.code.startsWith(code)) && record.timestamp > recoveredAt && Date.now() - record.timestamp < 86400000) ?? null;
  const issue = (record: DiagnosticRecord | null) => record ? { record, definition: DIAGNOSTIC_REGISTRY[record.code] } : null;
  const item = (id: string, label: string, status: HealthStatus, summary: string, details: HealthItem["details"], record: DiagnosticRecord | null = null): HealthItem =>
    ({ id, label, status, summary, details, diagnostic: issue(record) });
  const observed = (code: DiagnosticCode, message: string, runtime: Record<string, unknown> = {}): DiagnosticRecord =>
    ({ code, timestamp: Date.now(), observed: message, runtime });

  const lastDownloadSuccess = store.get<any>("health.lastDownloadSuccess", null);
  const lastDownloadFailure = store.get<any>("health.lastDownloadFailure", null);
  const lastTransitionSuccess = store.get<any>("health.lastTransitionSuccess", null);
  const lastPlaybackStart = store.get<any>("health.lastPlaybackStart", null);
  const lastOutputSuccess = store.get<Record<string, number>>("health.lastOutputSuccess", {});
  const consecutiveDownloadFailures = store.get<number>("health.consecutiveDownloadFailures", 0);
  const checks = await Promise.all([
    ["ffmpeg", c.FFMPEG_PATH, ["-version"]] as const,
    ["ffprobe", c.FFPROBE_PATH, ["-version"]] as const,
    ["yt-dlp", c.YTDLP_PATH, ["--version"]] as const,
  ].map(async ([name, binary, args]) => {
    try {
      const output = await runCapture(binary, [...args], new AbortController().signal, 5000);
      return { name, available: true, version: output.split(/\r?\n/)[0]?.slice(0, 160) ?? "Available" };
    } catch (error) {
      return { name, available: false, version: error instanceof Error ? error.message : "Could not start" };
    }
  }));
  const executable = (name: string) => checks.find((check) => check.name === name)!;

  let freeBytes = 0, totalBytes = 0, diskError = "";
  try {
    const disk = await statfs(c.DATA_DIR);
    freeBytes = disk.bavail * disk.bsize;
    totalBytes = disk.blocks * disk.bsize;
  } catch (error) {
    diskError = error instanceof Error ? error.message : "Storage inspection failed";
  }
  let cacheBytes = 0, cacheFiles = 0, cacheTemporaryBytes = 0, cacheError = "";
  try {
    const cache = path.join(c.DATA_DIR, "cache");
    for (const entry of await readdir(cache, { withFileTypes: true }))
      if (entry.isFile()) {
        cacheFiles++;
        const size = (await stat(path.join(cache, entry.name))).size;
        cacheBytes += size;
        if (/\.(?:part|ytdl|tmp|temp)$/i.test(entry.name)) cacheTemporaryBytes += size;
      }
  } catch (error: any) {
    if (error?.code !== "ENOENT") cacheError = error instanceof Error ? error.message : "Cache inspection failed";
  }
  let ownerStatus: HealthStatus = "healthy", ownerSummary = "This server owns the runtime lock.", ownerPid: number | null = null;
  try {
    ownerPid = Number((await readFile(path.join(c.DATA_DIR, "owner.pid"), "utf8")).trim());
    if (ownerPid !== process.pid) {
      let alive = false;
      try { process.kill(ownerPid, 0); alive = true; } catch {}
      ownerStatus = alive ? "critical" : "degraded";
      ownerSummary = alive ? "A different live process owns the runtime lock." : "The runtime lock contains a stale process ID.";
    }
  } catch {
    ownerStatus = "critical";
    ownerSummary = "The runtime ownership lock is missing or unreadable.";
  }

  let databaseResult = "unavailable", databaseStatus: HealthStatus = "critical";
  try {
    databaseResult = String((store.db.prepare("PRAGMA quick_check").get() as any)?.quick_check ?? "unknown");
    databaseStatus = databaseResult === "ok" ? "healthy" : "critical";
  } catch {}

  const apiRecord = latest(["IC-API-"], snapshot.lastSync);
  const authRecord = latest(["IC-AUTH-"], safeTime(lastDownloadSuccess));
  const downloadRecord = latest(["IC-DL-"], safeTime(lastDownloadSuccess));
  const cacheRecord = latest(["IC-CACHE-"], safeTime(lastDownloadSuccess));
  const ffmpegRecord = latest(["IC-FFMPEG-"], safeTime(lastPlaybackStart));
  const mediaRecord = latest(["IC-MEDIA-"], safeTime(lastPlaybackStart));
  const playbackRecord = latest(["IC-PLAY-"], safeTime(lastPlaybackStart));
  const transitionRecord = latest(["IC-TRANS-"], safeTime(lastTransitionSuccess));
  const outputRecord = latest(["IC-OUTPUT-"], Math.max(0, ...Object.values(lastOutputSuccess)));
  const youtubeOutputRecord = latest(["IC-OUTPUT-"], lastOutputSuccess.youtube ?? 0);
  const playlistRecord = latest(["IC-PL-"], snapshot.lastSync);

  const ffmpeg = executable("ffmpeg"), ffprobe = executable("ffprobe"), ytdlp = executable("yt-dlp");
  const youtubeEnabled = settings.youtube.enabled;
  const configuredSource = settings.sources.length > 0 || !!(settings.sourceMode === "channel" ? settings.channelUrl : settings.playlistId);
  const staleSync = configuredSource && snapshot.lastSync > 0 && Date.now() - snapshot.lastSync > settings.resyncMinutes * 120000;
  const diskStatus: HealthStatus = diskError || freeBytes < 1073741824 ? "critical" : freeBytes < 5 * 1073741824 ? "degraded" : "healthy";
  const cacheLimit = c.CACHE_MAX_MB * 1048576;
  const cacheStatus: HealthStatus = cacheError || cacheBytes > cacheLimit ? "critical" : cacheTemporaryBytes > cacheLimit / 4 ? "degraded" : cacheRecord ? statusFor(cacheRecord) : "healthy";
  const downloadStatus: HealthStatus = !ytdlp.available ? "critical" : consecutiveDownloadFailures >= 3 ? "critical" : downloadRecord ? statusFor(downloadRecord) : lastDownloadSuccess ? "healthy" : "available";
  const playlistStatus: HealthStatus = snapshot.count === 0 ? "critical" : staleSync ? "degraded" : playlistRecord ? statusFor(playlistRecord) : "healthy";
  const cookieAvailable = c.YTDLP_COOKIES_FILE ? await stat(c.YTDLP_COOKIES_FILE).then((entry) => entry.isFile()).catch(() => false) : null;
  const apiDiagnostic = !c.YOUTUBE_API_KEY ? observed("IC-API-001", "YouTube API key is not configured") : apiRecord;
  const downloadDiagnostic = !ytdlp.available ? observed("IC-DL-001", "yt-dlp executable could not start", { result: ytdlp.version }) : downloadRecord;
  const authDiagnostic = c.YTDLP_COOKIES_FILE && !cookieAvailable ? observed("IC-AUTH-001", "Configured YouTube cookie file is missing or unreadable") : authRecord;
  const cacheDiagnostic = cacheError ? observed("IC-CACHE-003", cacheError) : cacheBytes > cacheLimit ? observed("IC-CACHE-001", "Media cache limit exceeded", { cacheBytes, cacheLimit }) : cacheTemporaryBytes > cacheLimit / 4 ? observed("IC-CACHE-006", "Temporary media is consuming an excessive portion of the cache", { cacheTemporaryBytes, cacheLimit }) : cacheRecord;
  const diskDiagnostic = diskError ? observed("IC-SYS-002", diskError) : freeBytes < 1073741824 ? observed("IC-SYS-003", "Data volume has less than 1 GiB free", { freeBytes }) : freeBytes < 5 * 1073741824 ? observed("IC-SYS-004", "Data volume has less than 5 GiB free", { freeBytes }) : null;
  const ffmpegDiagnostic = !ffmpeg.available ? observed("IC-FFMPEG-001", "FFmpeg process could not start", { result: ffmpeg.version }) : ffmpegRecord;
  const ffprobeDiagnostic = !ffprobe.available ? observed("IC-SYS-001", "FFprobe executable could not start", { executable: "ffprobe", result: ffprobe.version }) : mediaRecord && mediaRecord.code !== "IC-MEDIA-004" ? mediaRecord : null;
  const playlistDiagnostic = snapshot.count === 0 ? observed(snapshot.excluded > 0 ? "IC-PL-003" : "IC-PL-001", snapshot.excluded > 0 ? "All synchronized playlist items are excluded by current filters" : "No synchronized playlist items are available", { excludedItems: snapshot.excluded }) : staleSync ? observed("IC-PL-004", "Playlist synchronization is older than twice its configured interval", { lastSync: snapshot.lastSync, resyncMinutes: settings.resyncMinutes }) : playlistRecord;

  const items: HealthItem[] = [
    item("server", "Idlecast server", "healthy", "The authenticated server is responding.", { version: APP_VERSION, uptimeSeconds: Math.floor(process.uptime()), memoryMB: Math.round(process.memoryUsage().rss / 1048576), pid: process.pid }),
    item("youtube-api", "YouTube API", !c.YOUTUBE_API_KEY ? "critical" : apiRecord ? statusFor(apiRecord) : snapshot.lastSync ? "healthy" : "available", !c.YOUTUBE_API_KEY ? "YouTube API key is not configured." : snapshot.lastSync ? `Last successful synchronization ${ageText(snapshot.lastSync)}.` : "Configured; no successful synchronization recorded yet.", { configured: !!c.YOUTUBE_API_KEY, lastSuccessfulSync: snapshot.lastSync || null, syncing: snapshot.syncing }, apiDiagnostic),
    item("yt-dlp", "yt-dlp", downloadStatus, downloadStatus === "healthy" ? `Recent download succeeded ${ageText(safeTime(lastDownloadSuccess))}.` : downloadStatus === "available" ? "Executable is available; no successful download is recorded yet." : `${consecutiveDownloadFailures} consecutive download failure(s).`, { executable: ytdlp.version, lastSuccessfulDownload: safeTime(lastDownloadSuccess) || null, lastFailure: safeTime(lastDownloadFailure) || null }, downloadDiagnostic),
    item("js-solver", "YouTube JS challenge solver", !ytdlp.available ? "critical" : latest(["IC-DL-002"], safeTime(lastDownloadSuccess)) ? "critical" : lastDownloadSuccess ? "healthy" : "available", lastDownloadSuccess ? "The current yt-dlp/Node path has completed a media operation." : "Node runtime and yt-dlp are available; no successful media operation is recorded yet.", { nodeRuntime: process.execPath, ytDlpAvailable: ytdlp.available }, latest(["IC-DL-002"], safeTime(lastDownloadSuccess))),
    item("youtube-auth", "YouTube authentication/cookies", authDiagnostic ? statusFor(authDiagnostic) : "healthy", c.YTDLP_COOKIES_FILE ? "Cookie file is configured and no unresolved rejection is recorded." : "Public-client mode is active; cookies are optional.", { mode: c.YTDLP_COOKIES_FILE ? "Cookies configured" : "Public clients", cookieFileAvailable: cookieAvailable }, authDiagnostic),
    item("downloads", "Downloads", downloadStatus, snapshot.download ? `${snapshot.download.title}: ${snapshot.download.percent === null ? "working" : Math.round(snapshot.download.percent) + "%"}.` : downloadStatus === "healthy" ? "The download pipeline has a recent success." : `${consecutiveDownloadFailures} consecutive failure(s).`, { activeVideo: snapshot.download?.title ?? null, progressPercent: snapshot.download?.percent ?? null, attempt: snapshot.download?.attempt ?? null, lastSuccess: safeTime(lastDownloadSuccess) || null, lastFailure: safeTime(lastDownloadFailure) || null }, downloadDiagnostic),
    item("buffering", "Buffering", snapshot.state === "buffering" && snapshot.bufferedCount === 0 && downloadRecord ? "critical" : snapshot.bufferedCount < snapshot.bufferTarget && snapshot.state !== "stopped" ? "degraded" : "healthy", snapshot.state === "stopped" ? "Playback is stopped; the rolling buffer is inactive." : `${snapshot.bufferedCount} of ${snapshot.bufferTarget} target videos are prepared.`, { state: snapshot.state, preparedVideos: snapshot.bufferedCount, targetVideos: snapshot.bufferTarget }, downloadDiagnostic),
    item("cache", "Media cache", cacheStatus, cacheError ? "The cache directory could not be inspected." : `${(cacheBytes / 1073741824).toFixed(2)} GB of ${(cacheLimit / 1073741824).toFixed(2)} GB used across ${cacheFiles} file(s).`, { usageBytes: cacheBytes, limitBytes: cacheLimit, cachedFiles: cacheFiles, temporaryBytes: cacheTemporaryBytes, activeDownload: !!snapshot.download }, cacheDiagnostic),
    item("disk", "Disk/storage", diskStatus, diskError ? "The data volume could not be inspected." : `${(freeBytes / 1073741824).toFixed(1)} GB free.`, { freeBytes, totalBytes, dataDirectory: c.DATA_DIR }, diskDiagnostic),
    item("ffmpeg", "FFmpeg", !ffmpeg.available ? "critical" : ffmpegRecord ? statusFor(ffmpegRecord) : lastPlaybackStart ? "healthy" : "available", !ffmpeg.available ? "FFmpeg could not be started." : lastPlaybackStart ? `Recent playback began ${ageText(safeTime(lastPlaybackStart))}.` : "Executable is available; no recent playback proves operation yet.", { executable: ffmpeg.version, lastPlaybackStart: safeTime(lastPlaybackStart) || null }, ffmpegDiagnostic),
    item("ffprobe", "FFprobe", !ffprobe.available ? "critical" : mediaRecord && mediaRecord.code !== "IC-MEDIA-004" ? statusFor(mediaRecord) : lastPlaybackStart ? "healthy" : "available", !ffprobe.available ? "FFprobe could not be started." : lastPlaybackStart ? "Recent prepared media passed inspection." : "Executable is available; no recent prepared media proves operation yet.", { executable: ffprobe.version, lastValidatedPlayback: safeTime(lastPlaybackStart) || null }, ffprobeDiagnostic),
    item("playback", "Playback", snapshot.desired && snapshot.state === "stopped" ? "critical" : playbackRecord ? statusFor(playbackRecord) : snapshot.state === "playing" ? "healthy" : "inactive", snapshot.state === "playing" ? `Playing ${snapshot.current?.title ?? "current media"}.` : snapshot.desired ? "Playback is desired but the engine is stopped." : "Playback is stopped by the owner.", { state: snapshot.state, desired: snapshot.desired, currentVideo: snapshot.current?.title ?? null, elapsedSeconds: snapshot.elapsed }, playbackRecord),
    item("audio-video", "Audio/video", mediaRecord ? statusFor(mediaRecord) : lastPlaybackStart ? "healthy" : "unknown", lastPlaybackStart ? (lastPlaybackStart.hasAudio ? `Audio ${lastPlaybackStart.audioSampleRate ?? "unknown"} Hz, ${lastPlaybackStart.audioChannels ?? "unknown"} channel(s) detected at last start.` : "The last started video had no audio; silence was generated.") : "No recent playback inspection is recorded.", { hasAudio: lastPlaybackStart?.hasAudio ?? null, sampleRate: lastPlaybackStart?.audioSampleRate ?? null, channels: lastPlaybackStart?.audioChannels ?? null }, mediaRecord),
    item("transitions", "Video transitions", transitionRecord ? statusFor(transitionRecord) : lastTransitionSuccess ? "healthy" : "unknown", lastTransitionSuccess ? `Last transition activated after ${lastTransitionSuccess.preparationMs} ms, ${ageText(lastTransitionSuccess.time)}.` : "No completed transition is recorded since this telemetry was added.", { lastSuccess: safeTime(lastTransitionSuccess) || null, preparationMs: lastTransitionSuccess?.preparationMs ?? null }, transitionRecord),
    item("stream-output", "Stream output", !Object.values(snapshot.outputs).some((o) => o.status !== "disabled") ? "inactive" : Object.values(snapshot.outputs).some((o) => o.status === "retrying") ? "critical" : Object.values(snapshot.outputs).filter((o) => o.status !== "disabled").every((o) => o.status === "sending") ? "healthy" : "degraded", Object.entries(snapshot.outputs).map(([name, output]) => `${name}: ${output.status}`).join("; "), Object.fromEntries(Object.entries(snapshot.outputs).map(([name, output]) => [name, `${output.status} (${output.retries} retries)`])), outputRecord),
    item("youtube-rtmp", "YouTube RTMP", !youtubeEnabled ? "inactive" : snapshot.outputs.youtube?.status === "sending" ? "healthy" : snapshot.outputs.youtube?.status === "retrying" ? "critical" : "degraded", !youtubeEnabled ? "YouTube output is disabled." : `YouTube output is ${snapshot.outputs.youtube?.status ?? "unknown"}.`, { enabled: youtubeEnabled, status: snapshot.outputs.youtube?.status ?? null, retries: snapshot.outputs.youtube?.retries ?? 0 }, youtubeEnabled ? youtubeOutputRecord : null),
    item("database", "Database", databaseStatus, databaseStatus === "healthy" ? "SQLite quick_check returned ok." : "SQLite integrity could not be confirmed.", { quickCheck: databaseResult }, databaseStatus === "critical" ? { code: "IC-DB-001", timestamp: Date.now(), observed: `SQLite quick_check returned ${databaseResult}`, runtime: { quickCheck: databaseResult } } : null),
    item("playlist", "Playlist", playlistStatus, snapshot.count ? `${snapshot.count} eligible item(s); ${snapshot.excluded} excluded.` : "No eligible playlist items are stored.", { eligibleItems: snapshot.count, excludedItems: snapshot.excluded, lastSync: snapshot.lastSync || null, detectedSeries: snapshot.filterStats.detectedSeries }, playlistDiagnostic),
    item("ownership", "Process ownership", ownerStatus, ownerSummary, { currentPid: process.pid, ownerPid }, ownerStatus === "critical" ? { code: "IC-SYS-006", timestamp: Date.now(), observed: ownerSummary, runtime: { currentPid: process.pid, ownerPid } } : ownerStatus === "degraded" ? { code: "IC-SYS-005", timestamp: Date.now(), observed: ownerSummary, runtime: { currentPid: process.pid, ownerPid } } : null),
  ];

  const overall = items.some((entry) => entry.status === "critical") ? "CRITICAL" : items.some((entry) => entry.status === "degraded" || entry.status === "unknown") ? "DEGRADED" : "HEALTHY";
  return { overall, version: APP_VERSION, generatedAt: Date.now(), uptime: Math.floor(process.uptime()), memoryMB: Math.round(process.memoryUsage().rss / 1048576), freeDiskMB: Math.round(freeBytes / 1048576), items, diagnostics: records.slice(0, 25) };
}
