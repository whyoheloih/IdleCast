export type DiagnosticSeverity = "info" | "warning" | "critical";
export type DiagnosticDefinition = {
  code: string;
  name: string;
  subsystem: string;
  severity: DiagnosticSeverity;
  meaning: string;
  detection: string;
  components: string[];
  investigate: string[];
};

const d = (
  code: string,
  name: string,
  subsystem: string,
  severity: DiagnosticSeverity,
  meaning: string,
  detection: string,
  components: string[],
  investigate: string[],
): DiagnosticDefinition => ({ code, name, subsystem, severity, meaning, detection, components, investigate });

// Permanent diagnostic API. Never renumber or reuse a code. Deprecate old
// entries in place and allocate a new code when detection semantics change.
export const DIAGNOSTIC_REGISTRY = {
  "IC-SYS-001": d("IC-SYS-001", "REQUIRED_EXECUTABLE_UNAVAILABLE", "System", "critical", "A required executable could not be located or launched.", "Process spawn reports that the configured executable could not start.", ["server/process.ts", "server/config.ts"], ["Configured executable path", "packaged tools", "file permissions"]),
  "IC-SYS-002": d("IC-SYS-002", "DATA_DIRECTORY_UNAVAILABLE", "System", "critical", "Idlecast cannot access its required data directory.", "A data-directory create, read, or write operation fails.", ["server/index.ts", "server/health.ts"], ["DATA_DIR path", "directory permissions", "drive availability"]),
  "IC-SYS-003": d("IC-SYS-003", "DISK_FULL", "System", "critical", "The data volume has no usable space for media operations.", "A media tool reports no space left or the data volume reports critically low free bytes.", ["server/process.ts", "server/health.ts"], ["Free disk space", "cache usage", "temporary media"]),
  "IC-SYS-004": d("IC-SYS-004", "DISK_SPACE_LOW", "System", "warning", "The data volume is approaching an unsafe free-space level.", "Health inspection finds less than 5 GiB free but at least 1 GiB available.", ["server/health.ts"], ["Free disk space", "cache budget", "other files on the volume"]),
  "IC-SYS-005": d("IC-SYS-005", "PROCESS_OWNER_LOCK_STALE", "System", "warning", "The owner lock names a process that is no longer running.", "data/owner.pid exists but its PID does not identify a live process.", ["server/index.ts", "server/health.ts"], ["owner.pid", "unclean prior shutdown"]),
  "IC-SYS-006": d("IC-SYS-006", "PROCESS_OWNER_MISMATCH", "System", "critical", "The owner lock does not belong to the current Idlecast server.", "data/owner.pid contains a live PID different from the current server PID.", ["server/index.ts", "server/health.ts"], ["duplicate Idlecast processes", "owner.pid", "desktop/server startup"]),

  "IC-API-001": d("IC-API-001", "YOUTUBE_API_KEY_MISSING", "YouTube API", "critical", "Playlist synchronization cannot use the YouTube API because no API key is configured.", "A sync is requested while YOUTUBE_API_KEY is empty.", ["server/providers.ts", "server/health.ts"], ["in-app credentials", "YOUTUBE_API_KEY"]),
  "IC-API-002": d("IC-API-002", "YOUTUBE_API_REQUEST_REJECTED", "YouTube API", "critical", "YouTube rejected a Data API request.", "The YouTube Data API returns a non-success HTTP status other than a specifically detected quota status.", ["server/providers.ts"], ["HTTP status", "API key restrictions", "requested resource"]),
  "IC-API-003": d("IC-API-003", "YOUTUBE_API_FORBIDDEN_OR_RATE_LIMITED", "YouTube API", "critical", "YouTube denied or rate-limited a Data API request.", "The YouTube Data API returns HTTP 403 or 429 during synchronization.", ["server/providers.ts", "server/engine.ts"], ["Google Cloud quota", "request rate", "API key project"]),
  "IC-API-004": d("IC-API-004", "YOUTUBE_API_RESPONSE_MALFORMED", "YouTube API", "critical", "YouTube returned a response missing fields required to safely publish a playlist snapshot.", "Playlist, video, or pagination response validation fails.", ["server/providers.ts"], ["response structure", "pagination token", "partial API responses"]),
  "IC-API-005": d("IC-API-005", "YOUTUBE_API_TIMEOUT", "YouTube API", "warning", "A YouTube API request exceeded its 30-second deadline.", "The request aborts through the configured API timeout signal.", ["server/providers.ts"], ["network path", "YouTube API availability", "DNS"]),

  "IC-AUTH-001": d("IC-AUTH-001", "COOKIE_FILE_UNAVAILABLE", "YouTube authentication", "warning", "A configured YouTube cookie file is missing or unreadable.", "Health inspection finds a configured YTDLP_COOKIES_FILE that is not a readable file.", ["server/config.ts", "server/health.ts"], ["cookie export path", "file permissions"]),
  "IC-AUTH-002": d("IC-AUTH-002", "YOUTUBE_COOKIES_REJECTED", "YouTube authentication", "critical", "YouTube rejected the exported authentication cookies.", "yt-dlp output reports cookie, sign-in, login, or bot-verification rejection while cookies are in use.", ["server/providers.ts", "server/process.ts"], ["cookie age", "cookie export", "yt-dlp client selection"]),
  "IC-AUTH-003": d("IC-AUTH-003", "YOUTUBE_LOGIN_REQUIRED", "YouTube authentication", "critical", "The requested video requires authenticated YouTube access.", "yt-dlp reports that sign-in or login is required when public clients are in use.", ["server/providers.ts", "server/process.ts"], ["video access restrictions", "cookie availability"]),

  "IC-DL-001": d("IC-DL-001", "YTDLP_PROCESS_START_FAILED", "Downloads", "critical", "The yt-dlp process could not start.", "Spawning the configured YTDLP_PATH fails.", ["server/providers.ts", "server/process.ts"], ["YTDLP_PATH", "packaged yt-dlp.exe", "execute permissions"]),
  "IC-DL-002": d("IC-DL-002", "YOUTUBE_JS_CHALLENGE_FAILURE", "Downloads", "critical", "yt-dlp could not solve YouTube's JavaScript/signature challenge.", "Specific yt-dlp output mentions JavaScript challenge, signature extraction, nsig, or missing JS runtime support.", ["server/providers.ts", "server/process.ts"], ["yt-dlp version", "Node JS runtime path", "YouTube extractor clients"]),
  "IC-DL-003": d("IC-DL-003", "REQUESTED_FORMAT_UNAVAILABLE", "Downloads", "warning", "YouTube has no playable format matching the configured selection.", "yt-dlp reports that the requested format is unavailable.", ["server/providers.ts", "server/process.ts"], ["format selector", "requested resolution and FPS", "video availability"]),
  "IC-DL-004": d("IC-DL-004", "DOWNLOAD_PROGRESS_STALLED", "Downloads", "critical", "The active download stopped producing meaningful byte or percentage progress.", "The cache monitor sees no byte or percentage increase for 600000 ms.", ["server/providers.ts", "server/process.ts"], ["network throughput", "fragment server", "yt-dlp process state", "cache write activity"]),
  "IC-DL-005": d("IC-DL-005", "DOWNLOAD_OPERATION_TIMEOUT", "Downloads", "critical", "Idlecast's outer watchdog terminated a download operation.", "The 12-hour bounded media operation timeout expires before yt-dlp completes.", ["server/providers.ts", "server/process.ts"], ["video size", "network speed", "child-process progress"]),
  "IC-DL-006": d("IC-DL-006", "AUDIO_DOWNLOAD_FAILED", "Downloads", "critical", "yt-dlp reported a failure while obtaining the selected audio stream.", "yt-dlp output specifically identifies the audio format or audio fragment as failed.", ["server/providers.ts", "server/process.ts"], ["selected audio format", "audio fragments", "YouTube client"]),
  "IC-DL-007": d("IC-DL-007", "MEDIA_MERGE_FAILED", "Downloads", "critical", "Downloaded media streams could not be merged into the expected playable file.", "yt-dlp/FFmpeg output reports merge, mux, or post-processing failure.", ["server/providers.ts", "server/process.ts"], ["FFmpeg path", "temporary video/audio files", "container compatibility"]),
  "IC-DL-008": d("IC-DL-008", "YTDLP_NONZERO_EXIT", "Downloads", "critical", "yt-dlp exited unsuccessfully without a more specific recognized cause.", "yt-dlp returns a non-zero exit code and no narrower registry matcher applies.", ["server/providers.ts", "server/process.ts"], ["sanitized yt-dlp diagnostics", "invocation arguments", "source access"]),
  "IC-DL-009": d("IC-DL-009", "EXPECTED_MEDIA_OUTPUT_MISSING", "Downloads", "critical", "yt-dlp reported completion but the expected merged media file is absent.", "No matching MP4, MKV, or WebM output exists after the yt-dlp operation completes.", ["server/providers.ts"], ["output template", "merge result", "cache cleanup race"]),
  "IC-DL-010": d("IC-DL-010", "YOUTUBE_MEDIA_HTTP_403", "Downloads", "critical", "YouTube denied a media request with HTTP 403.", "yt-dlp or FFmpeg media output contains an HTTP 403/Forbidden response.", ["server/providers.ts", "server/process.ts"], ["media URL/client", "cookies", "IP access"]),
  "IC-DL-011": d("IC-DL-011", "YOUTUBE_MEDIA_HTTP_429", "Downloads", "critical", "YouTube rate-limited media requests with HTTP 429.", "yt-dlp output contains HTTP 429 or Too Many Requests.", ["server/providers.ts", "server/process.ts"], ["request rate", "YouTube cooldown", "IP rate limits"]),
  "IC-DL-012": d("IC-DL-012", "FRAGMENT_RETRIES_EXHAUSTED", "Downloads", "critical", "yt-dlp exhausted retries for one or more media fragments.", "yt-dlp reports exhausted fragment retries or an unrecoverable fragment download failure.", ["server/providers.ts", "server/process.ts"], ["fragment host", "network reliability", "fragment retry settings"]),
  "IC-DL-013": d("IC-DL-013", "DOWNLOAD_RETRIES_EXHAUSTED", "Downloads", "critical", "All bounded Idlecast download attempts failed for the current video.", "ExperimentalYouTubeSource finishes its final allowed attempt without a usable file.", ["server/providers.ts", "server/engine.ts"], ["preceding specific diagnostic", "attempt count", "video ID"]),

  "IC-CACHE-001": d("IC-CACHE-001", "CACHE_CAPACITY_EXCEEDED", "Media cache", "critical", "The rolling media cache exceeded its configured total capacity.", "Cache monitoring reports total bytes greater than CACHE_MAX_MB.", ["server/providers.ts", "server/health.ts"], ["cache contents", "retained videos", "CACHE_MAX_MB"]),
  "IC-CACHE-002": d("IC-CACHE-002", "MEDIA_EXCEEDS_PER_VIDEO_LIMIT", "Media cache", "warning", "One video exceeded the per-video cache budget.", "Active media bytes exceed half of the configured total cache budget or yt-dlp reports max-filesize.", ["server/providers.ts"], ["video size", "quality setting", "cache budget"]),
  "IC-CACHE-003": d("IC-CACHE-003", "CACHE_DIRECTORY_UNAVAILABLE", "Media cache", "critical", "Idlecast cannot create, enumerate, or write the media cache directory.", "A cache filesystem operation fails for a reason other than a vanished temporary file.", ["server/providers.ts", "server/health.ts"], ["cache path", "drive state", "permissions"]),
  "IC-CACHE-004": d("IC-CACHE-004", "CACHE_CLEANUP_FAILED", "Media cache", "warning", "Idlecast could not remove an obsolete or failed cache file.", "A requested cache removal rejects.", ["server/providers.ts", "server/engine.ts"], ["locked file", "active FFmpeg handles", "permissions"]),
  "IC-CACHE-005": d("IC-CACHE-005", "CACHED_MEDIA_VALIDATION_FAILED", "Media cache", "critical", "A downloaded or cached file failed FFprobe validation.", "Prepared media has no valid video stream or finite positive duration.", ["server/engine.ts"], ["cached file integrity", "incomplete download", "FFprobe output"]),
  "IC-CACHE-006": d("IC-CACHE-006", "TEMPORARY_MEDIA_EXCESSIVE", "Media cache", "warning", "Incomplete temporary media occupies an excessive portion of the cache budget.", "Health inspection finds .part/.ytdl/.tmp files using more than 25 percent of CACHE_MAX_MB.", ["server/providers.ts", "server/health.ts"], ["interrupted downloads", "temporary fragments", "cache cleanup"]),

  "IC-FFMPEG-001": d("IC-FFMPEG-001", "FFMPEG_PROCESS_START_FAILED", "FFmpeg", "critical", "FFmpeg could not start.", "Spawning FFMPEG_PATH fails.", ["server/process.ts", "server/engine.ts", "server/encoder.ts"], ["FFMPEG_PATH", "packaged binary", "permissions"]),
  "IC-FFMPEG-002": d("IC-FFMPEG-002", "FFMPEG_INPUT_UNAVAILABLE", "FFmpeg", "critical", "FFmpeg could not open a required media input.", "FFmpeg reports missing input, error opening input, or invalid media path.", ["server/process.ts", "server/engine.ts"], ["input path", "cache cleanup timing", "file lock"]),
  "IC-FFMPEG-003": d("IC-FFMPEG-003", "FFMPEG_ARGUMENT_OR_FORMAT_INVALID", "FFmpeg", "critical", "FFmpeg rejected an argument or media format.", "FFmpeg reports Invalid argument without a narrower input or overlay match.", ["server/process.ts", "server/encoder.ts", "server/overlay.ts"], ["generated arguments", "filter graph", "container format"]),
  "IC-FFMPEG-004": d("IC-FFMPEG-004", "OVERLAY_FILTER_FAILED", "FFmpeg", "critical", "FFmpeg could not load or execute the overlay font/text filter.", "FFmpeg reports drawtext, font, or overlay filter initialization failure.", ["server/overlay.ts", "server/process.ts"], ["FONT_FILE", "overlay text files", "filter graph"]),
  "IC-FFMPEG-005": d("IC-FFMPEG-005", "PRODUCER_UNEXPECTED_EXIT", "FFmpeg", "critical", "The active video producer exited before a normal media completion.", "The producer returns non-zero while its transition is still authoritative and playback was not stopped or skipped.", ["server/engine.ts"], ["FFmpeg exit code", "active input", "transition generation"]),
  "IC-FFMPEG-006": d("IC-FFMPEG-006", "PRODUCER_PROGRESS_STALLED", "FFmpeg", "critical", "The active FFmpeg producer stopped advancing frames.", "No increasing frame progress is received for 30 seconds.", ["server/engine.ts"], ["FFmpeg process", "input readability", "CPU pressure", "UDP output"]),
  "IC-FFMPEG-007": d("IC-FFMPEG-007", "STANDBY_PRODUCER_FAILED", "FFmpeg", "critical", "The standby producer failed while Idlecast needed continuity output.", "The standby FFmpeg process exits or fails to launch before cancellation.", ["server/encoder.ts", "server/engine.ts"], ["standby inputs", "loading assets", "FFmpeg path"]),

  "IC-MEDIA-001": d("IC-MEDIA-001", "MEDIA_UNREADABLE", "Audio/video", "critical", "FFprobe could not read the prepared media file.", "The FFprobe inspection process fails for a prepared file.", ["server/engine.ts", "server/process.ts"], ["file integrity", "container", "FFprobe diagnostics"]),
  "IC-MEDIA-002": d("IC-MEDIA-002", "VIDEO_STREAM_MISSING", "Audio/video", "critical", "Prepared media contains no playable video stream.", "FFprobe returns no stream with codec_type=video.", ["server/engine.ts"], ["download format", "merge output", "media file"]),
  "IC-MEDIA-003": d("IC-MEDIA-003", "MEDIA_DURATION_INVALID", "Audio/video", "critical", "Prepared media has no finite positive duration.", "FFprobe format duration is missing, non-finite, or not greater than zero.", ["server/engine.ts"], ["container metadata", "truncated file", "live source used as finite media"]),
  "IC-MEDIA-004": d("IC-MEDIA-004", "AUDIO_STREAM_MISSING", "Audio/video", "warning", "Prepared media has no audio stream; Idlecast is generating silence.", "FFprobe finds video but no codec_type=audio stream.", ["server/engine.ts"], ["source audio availability", "selected format", "merge result"]),

  "IC-PLAY-001": d("IC-PLAY-001", "MEDIA_SOURCE_UNAVAILABLE", "Playback", "critical", "The selected media source file is missing or unavailable.", "Local or downloaded source resolution cannot return a readable contained file.", ["server/providers.ts", "server/engine.ts"], ["video ID", "media/cache path", "availability"]),
  "IC-PLAY-002": d("IC-PLAY-002", "PLAYBACK_STOPPED_ADVANCING", "Playback", "critical", "Active playback stopped advancing frames.", "The active producer watchdog observes no new frame for 30 seconds.", ["server/engine.ts"], ["producer progress", "input file", "CPU and output pressure"]),
  "IC-PLAY-003": d("IC-PLAY-003", "MEDIA_ENDED_UNEXPECTEDLY", "Playback", "critical", "Playback ended through a failed producer rather than normal completion.", "The authoritative producer exits non-zero or is aborted without a user stop/skip.", ["server/engine.ts"], ["producer exit", "transition logs", "source duration"]),
  "IC-PLAY-004": d("IC-PLAY-004", "NO_ELIGIBLE_MEDIA", "Playback", "warning", "No playlist item currently satisfies availability and shuffle constraints.", "The playback selector scans the complete queue without finding a playable candidate.", ["server/engine.ts", "server/queue.ts"], ["filters", "retry cooldowns", "shuffle lead-time rules"]),
  "IC-PLAY-005": d("IC-PLAY-005", "PLAYBACK_SUPERVISOR_RECOVERY", "Playback", "critical", "The outer playback supervisor caught an unexpected playback-loop failure.", "Engine.play rejects while playback is desired and the service controller remains active.", ["server/engine.ts"], ["preceding diagnostic", "current video", "recovery backoff"]),

  "IC-TRANS-001": d("IC-TRANS-001", "NEXT_MEDIA_NOT_PRELOADED", "Video transitions", "warning", "The selected next video was not prepared when its transition began.", "The authoritative transition cannot find the selected video in preparedMedia.", ["server/engine.ts"], ["rolling buffer", "download completion", "queue changes"]),
  "IC-TRANS-002": d("IC-TRANS-002", "TRANSITION_STANDBY_FAILED", "Video transitions", "critical", "Continuity standby failed during an unprepared transition.", "The transition's standby callback reports a process failure.", ["server/engine.ts", "server/encoder.ts"], ["standby producer", "loading files", "FFmpeg"]),
  "IC-TRANS-003": d("IC-TRANS-003", "REPLACEMENT_PRODUCER_START_FAILED", "Video transitions", "critical", "The replacement video's FFmpeg producer could not start.", "The producer emits a child-process start error before frame activation.", ["server/engine.ts", "server/process.ts"], ["FFmpeg path", "replacement arguments", "prepared file"]),
  "IC-TRANS-004": d("IC-TRANS-004", "TRANSITION_OUTPUT_STALLED", "Video transitions", "critical", "The newly activated producer stopped advancing after transition.", "The active producer watchdog fires for the current transition generation.", ["server/engine.ts"], ["transition generation", "producer progress", "UDP receiver"]),
  "IC-TRANS-005": d("IC-TRANS-005", "TRANSITION_PREPARATION_SLOW", "Video transitions", "warning", "Preparing the replacement source took longer than the healthy transition window.", "More than 30 seconds elapse between transition request and source preparation.", ["server/engine.ts"], ["preload state", "download/probe duration", "standby continuity"]),

  "IC-OUTPUT-001": d("IC-OUTPUT-001", "RTMP_CONNECTION_REJECTED", "Stream output", "critical", "The destination rejected the RTMP/RTMPS connection.", "Output FFmpeg reports authentication, authorization, handshake, or connection rejection.", ["server/engine.ts", "server/providers.ts"], ["ingest URL", "stream key configuration", "destination status"]),
  "IC-OUTPUT-002": d("IC-OUTPUT-002", "RTMP_CONNECTION_LOST", "Stream output", "critical", "An established streaming connection was lost.", "The output process reports broken pipe, reset, aborted socket, or network disconnect after sending began.", ["server/engine.ts"], ["network path", "destination ingest", "transition timing"]),
  "IC-OUTPUT-003": d("IC-OUTPUT-003", "OUTPUT_PROCESS_UNEXPECTED_EXIT", "Stream output", "critical", "The persistent destination output process exited unexpectedly.", "Output FFmpeg returns non-zero while its destination remains enabled.", ["server/engine.ts"], ["exit code", "RTMP diagnostics", "UDP input"]),
  "IC-OUTPUT-004": d("IC-OUTPUT-004", "OUTPUT_PROGRESS_STALLED", "Stream output", "critical", "The output process stopped reporting advancing frames.", "No increasing output frame progress is received for 30 seconds.", ["server/engine.ts"], ["output FFmpeg", "UDP producer", "network blocking"]),
  "IC-OUTPUT-005": d("IC-OUTPUT-005", "OUTPUT_RECONNECT_SCHEDULED", "Stream output", "warning", "Idlecast scheduled an automatic destination reconnect.", "An enabled output ends and enters bounded exponential backoff.", ["server/engine.ts"], ["preceding output diagnostic", "retry count", "backoff"]),
  "IC-OUTPUT-006": d("IC-OUTPUT-006", "OUTPUT_RECONNECT_REPEATED", "Stream output", "critical", "The destination has failed to reconnect repeatedly.", "An output reaches three or more consecutive recovery attempts without a healthy minute.", ["server/engine.ts"], ["RTMP availability", "stream key", "network", "retry history"]),

  "IC-DB-001": d("IC-DB-001", "DATABASE_INTEGRITY_CHECK_FAILED", "Database", "critical", "SQLite quick_check did not return ok.", "PRAGMA quick_check returns a non-ok result.", ["server/db.ts", "server/health.ts"], ["database file", "filesystem health", "SQLite result"]),
  "IC-DB-002": d("IC-DB-002", "DATABASE_UNAVAILABLE", "Database", "critical", "The Idlecast database cannot be opened or queried.", "Opening the database or the Health query fails.", ["server/db.ts", "server/index.ts", "server/health.ts"], ["database path", "file permissions", "drive health"]),
  "IC-DB-003": d("IC-DB-003", "DATABASE_OPERATION_FAILED", "Database", "critical", "A runtime SQLite operation failed.", "A database read, write, or transaction throws after startup.", ["server/db.ts", "server/app.ts", "server/engine.ts"], ["operation context", "SQLite error", "concurrent access"]),

  "IC-PL-001": d("IC-PL-001", "PLAYLIST_EMPTY", "Playlist", "critical", "No synchronized playlist items are available for playback.", "The stored playlist count is zero.", ["server/engine.ts", "server/health.ts"], ["configured sources", "last synchronization", "filters"]),
  "IC-PL-002": d("IC-PL-002", "PLAYLIST_SYNC_FAILED", "Playlist", "critical", "Playlist synchronization failed and the previous snapshot was preserved.", "Engine.sync catches a provider/channel/API failure.", ["server/engine.ts", "server/providers.ts"], ["preceding API diagnostic", "source identifiers", "quota"]),
  "IC-PL-003": d("IC-PL-003", "PLAYLIST_HAS_NO_ELIGIBLE_ITEMS", "Playlist", "critical", "The synchronized playlist contains no item eligible under current filters.", "Synchronization completes with zero queued items while source data contained excluded items.", ["server/queue.ts", "server/engine.ts", "server/health.ts"], ["filter statistics", "Shorts setting", "duration/year bounds"]),
  "IC-PL-004": d("IC-PL-004", "PLAYLIST_SYNC_STALE", "Playlist", "warning", "The playlist has not synchronized within twice its configured interval.", "lastSync is older than two resync intervals while a source is configured.", ["server/engine.ts", "server/health.ts"], ["resync timer", "API access", "last sync time"]),
} as const satisfies Record<string, DiagnosticDefinition>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_REGISTRY;
export type DiagnosticRecord = {
  code: DiagnosticCode;
  timestamp: number;
  observed: string;
  runtime: Record<string, unknown>;
};

const secretKey = /password|secret|token|cookie|api.?key|stream.?key|authorization/i;
export function sanitizeDiagnosticRuntime(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 50).map(sanitizeDiagnosticRuntime);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !secretKey.test(key))
        .slice(0, 50)
        .map(([key, entry]) => [key, sanitizeDiagnosticRuntime(entry)]),
    );
  if (typeof value === "string")
    return value
      .replace(/(Bearer|token|key|password|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
      .slice(0, 1000);
  return value;
}

const matchers: Array<[DiagnosticCode, RegExp]> = [
  ["IC-TRANS-002", /transition .*standby encoder failed/i],
  ["IC-TRANS-003", /transition .*ffmpeg error/i],
  ["IC-TRANS-004", /transition .*active producer stalled/i],
  ["IC-TRANS-005", /source preparation took \d+ms/i],
  ["IC-TRANS-001", /source is not preloaded/i],
  ["IC-OUTPUT-001", /rtmp connection rejected|authentication failed|authorization failed|handshake failed/i],
  ["IC-OUTPUT-002", /socket was aborted|broken pipe|connection (?:lost|reset)/i],
  ["IC-OUTPUT-004", /output.*(?:stalled|watchdog)/i],
  ["IC-OUTPUT-006", /automatic recovery attempt (?:[3-9]|\d{2,})/i],
  ["IC-OUTPUT-005", /output disconnected; automatic recovery/i],
  ["IC-OUTPUT-003", /output process failed|ffmpeg exited with code/i],
  ["IC-API-001", /youtube api key is not configured/i],
  ["IC-API-003", /youtube api request failed \(http (?:403|429)\)/i],
  ["IC-API-002", /youtube api request failed \(http \d+\)/i],
  ["IC-API-004", /malformed .*response|repeated youtube pagination token|playlist exceeds .*safety/i],
  ["IC-API-005", /youtube api.*(?:timeout|timed out)|operation was aborted/i],
  ["IC-DL-001", /yt-dlp executable could not start/i],
  ["IC-DL-002", /javascript challenge|signature extraction|nsig|js runtime/i],
  ["IC-DL-006", /audio (?:download|fragment|format).*fail/i],
  ["IC-DL-007", /merge|mux|postprocess/i],
  ["IC-DL-010", /http 403|forbidden/i],
  ["IC-DL-011", /http 429|too many requests|rate limit/i],
  ["IC-DL-012", /fragment.*(?:retry|fail)|retry.*fragment/i],
  ["IC-DL-003", /requested format.*not available|no matching playable format/i],
  ["IC-DL-004", /download stalled|no meaningful progress/i],
  ["IC-DL-005", /media operation timed out/i],
  ["IC-DL-009", /download produced no merged media/i],
  ["IC-DL-008", /yt-dlp unexpectedly exited non-zero/i],
  ["IC-DL-013", /download failed after/i],
  ["IC-AUTH-002", /cookies rejected|account verification/i],
  ["IC-AUTH-003", /sign in|login required/i],
  ["IC-CACHE-001", /media cache limit exceeded/i],
  ["IC-CACHE-002", /per-video cache limit|max.filesize|file.*too large/i],
  ["IC-CACHE-003", /cache (?:directory|storage).*unavailable/i],
  ["IC-CACHE-004", /cache cleanup failed/i],
  ["IC-CACHE-006", /temporary media.*excessive/i],
  ["IC-SYS-003", /no space left|disk full/i],
  ["IC-FFMPEG-004", /overlay font|drawtext|text filter/i],
  ["IC-MEDIA-002", /no playable video stream/i],
  ["IC-MEDIA-003", /finite duration/i],
  ["IC-MEDIA-004", /has no audio|using .* silence/i],
  ["IC-FFMPEG-006", /active producer stalled/i],
  ["IC-FFMPEG-005", /producer exited with code/i],
  ["IC-FFMPEG-007", /standby encoder failed/i],
  ["IC-PLAY-001", /local media file is unavailable|media source.*unavailable/i],
  ["IC-PLAY-004", /waiting for an available|no eligible/i],
  ["IC-PLAY-005", /playback supervisor recovered/i],
  ["IC-PL-002", /playlist sync failed/i],
  ["IC-SYS-001", /required media executable could not start|executable path/i],
  ["IC-FFMPEG-002", /ffmpeg input unavailable|error opening|no such file/i],
  ["IC-FFMPEG-003", /ffmpeg rejected an argument or media format/i],
];
export function diagnosticForMessage(message: string): DiagnosticCode | null {
  return matchers.find(([, pattern]) => pattern.test(message))?.[0] ?? null;
}

export function definition(code: DiagnosticCode) {
  return DIAGNOSTIC_REGISTRY[code];
}
