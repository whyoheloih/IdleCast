export const updateCommand =
  "Set-Location 'E:\\IdleCast\\repo'; & 'C:\\Users\\ejbot\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\git\\cmd\\git.exe' pull --ff-only; & 'C:\\Users\\ejbot\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\bin\\fallback\\pnpm.cmd' install --frozen-lockfile; & 'C:\\Users\\ejbot\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\bin\\fallback\\pnpm.cmd' build; & 'C:\\Users\\ejbot\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\bin\\fallback\\pnpm.cmd' start";

export const updateHistory = [
  {
    version: "1.4.1",
    date: "Oct 3, 2026",
    title: "Smarter YouTube download recovery",
    items: [
      "Global YouTube account-verification failures now pause and retry the same position instead of cycling through the entire playlist",
      "Deterministic authentication, rate-limit, disk, and configuration failures skip pointless three-attempt retries",
      "The rolling buffer stops scanning hundreds of videos when the downloader itself needs attention and resumes automatically after recovery",
      "Transport logging now reports real discontinuity signals with a five-minute duplicate-warning limit",
    ],
  },
  {
    version: "1.4.1",
    date: "Oct 3, 2026",
    title: "Playback history and dashboard themes",
    items: [
      "Playback History records videos only after playback actually begins and keeps the result across restarts",
      "A small footer toggle switches manually between the dark blue theme and a baby blue light theme",
      "Series detection choices now use clearer names and explain exactly what the selected option recognizes",
      "Playlist ordering now uses the highlighted drag-and-drop destination without redundant arrow controls",
    ],
  },
  {
    version: "1.4.1",
    date: "Oct 3, 2026",
    title: "Core reliability audit",
    items: [
      "Failed prepared videos are evicted from the rolling cache so one corrupt or incompatible file cannot poison a buffer slot",
      "Corrupt or empty process-owner files are recovered automatically instead of blocking IdleCast startup",
      "Mobile navigation stays within the viewport and scrolls inside its header when all control-room pages are present",
      "Core API, database, sync, filters, shuffle, FFmpeg audio/video, transition recovery, desktop packaging, and browser workflows were reverified",
    ],
  },  {
    version: "1.4.1",
    date: "Oct 1, 2026",
    title: "Animated countdown rotation",
    items: [
      "Seventeen supplied animations can appear at random in a small looping window beneath the final-ten-second countdown",
      "The animation uses the same visual-only FFmpeg overlay as the countdown and cannot request a video transition",
      "The last three animations are excluded from normal selection, with an 8% rare-repeat chance marked by a gold countdown outline",
      "Animation history persists across playback and desktop restarts, while decoding is deferred until the final ten seconds",
    ],
  },
  {
    version: "1.4.0",
    date: "Oct 1, 2026",
    title: "Safer transitions and range filters",
    items: [
      "Preloaded video changes no longer create a throwaway standby encoder, reducing FFmpeg and UDP churn at every transition",
      "Transition ownership now protects newer playback from stale watchdog cleanup and logs preparation, activation, and producer failures",
      "Include Past Livestreams replaces direct live playback; current and upcoming broadcasts always remain excluded",
      "Upload year and video length filters now use shared dual-handle ranges in both Playlist and Settings",
      "Downloaded Videos now keeps its full layout when empty, including sidebar guidance and Back to Playlist navigation",
    ],
  },
  {
    version: "1.3.1",
    date: "Sep 25, 2026",
    title: "Update check on every launch",
    items: [
      "The installed desktop app checks GitHub Releases immediately whenever IdleCast launches",
      "Available releases continue downloading automatically in the background",
      "Six-hour background checks and the manual tray update check remain available",
    ],
  },
  {
    version: "1.3.0",
    date: "Sep 25, 2026",
    title: "Reliable downloads, live sources, and managed queue",
    items: [
      "Stalled downloads are detected by real byte/progress movement, retried three times, cleaned up, and skipped without freezing startup",
      "Downloaded Videos page shows current and prepared media, progress, retry/failure state, file size, total storage, and real queue ordering",
      "Final bracketed episode numbers and DAY ONE-style titles now form correctly ordered, limited series continuations",
      "Optional currently-live YouTube playback uses a direct reconnecting stream path without consuming finite download slots",
      "Upcoming livestreams stay excluded and Play Livestreams remains off by default",
    ],
  },
  {
    version: "1.2.3",
    date: "Sep 25, 2026",
    title: "E-drive update storage",
    items: [
      "Desktop update downloads and temporary installer files use E-drive storage when available",
      "Desktop logs, cache, and new-install runtime data avoid the low-space C drive",
      "Existing E-drive settings and media continue to be reused",
    ],
  },
  {
    version: "1.2.2",
    date: "Sep 25, 2026",
    title: "IdleCast application icon",
    items: [
      "New blue-and-white lowercase i mark with an infinity symbol",
      "Icon embedded in the Windows executable and installer",
      "Matching window, taskbar, Start menu, desktop shortcut, and tray icon",
    ],
  },
  {
    version: "1.2.1",
    date: "Sep 25, 2026",
    title: "Automatic desktop updates",
    items: [
      "Installed desktop apps check GitHub Releases automatically every six hours",
      "New versions download in the background with progress shown in the tray",
      "A restart prompt appears when an update is ready to install",
      "Manual update checks are available from the IdleCast tray menu",
      "Portable builds link to the newest installer because they cannot safely replace themselves",
    ],
  },
  {
    version: "1.2.0",
    date: "Sep 25, 2026",
    title: "Windows desktop application",
    items: [
      "Installable and portable Windows applications alongside localhost access",
      "One shared backend prevents duplicate encoders and stream processes",
      "Desktop window minimizes to the tray while broadcasting continues",
      "Existing E-drive settings, credentials, cookies, cache, and media are reused",
      "FFmpeg, FFprobe, and yt-dlp are bundled into desktop releases",
    ],
  },
  {
    version: "1.1.5",
    date: "Sep 24, 2026",
    title: "Clear playlist drag and drop",
    items: [
      "Playlist rows now show the exact before-or-after insertion point",
      "A translucent ghost label previews the video being moved",
      "Drop targets highlight while preserving arrow controls and confirmations",
    ],
  },
  {
    version: "1.1.4",
    date: "Sep 24, 2026",
    title: "Reliability and code audit",
    items: [
      "Service restarts preserve and automatically resume broadcast intent",
      "Standby preparation no longer overwrites the active title and date",
      "Three-hour videos retain their required two-hour download lead",
      "Shutdown now awaits preview and HTTP resource cleanup",
      "Repeated standby failures are logged at a bounded rate",
    ],
  },
  {
    version: "1.1.3",
    date: "Sep 24, 2026",
    title: "Fast livestream transition recovery",
    items: [
      "Healthy RTMP sessions now reset old failure streaks before reconnecting",
      "Transition socket failures retry after one second instead of thirty",
      "Windows socket error 10053 and transport warnings now have clear diagnostics",
    ],
  },
  {
    version: "1.1.2",
    date: "Sep 24, 2026",
    title: "Text encoding cleanup",
    items: [
      "Removed corrupted text sequences from Overview and Settings",
      "Restored multiplication signs, bullets, dashes, apostrophes, and ellipses",
    ],
  },
  {
    version: "1.1.1",
    date: "Sep 24, 2026",
    title: "Windows update command compatibility",
    items: [
      "Update command now uses the installed Git and pnpm executables directly",
      "Works from a normal Windows PowerShell window without PATH setup",
    ],
  },
  {
    version: "1.1.0",
    date: "Sep 24, 2026",
    title: "Unattended transition reliability and queue controls",
    items: [
      "Automatic playback and RTMP recovery with capped retry delays",
      "Five-video prepared buffer with download and FFprobe validation",
      "Bad videos are skipped without taking down the livestream",
      "Immediate standby output during unexpected transition delays",
      "Final ten-second Next video countdown and larger timecode",
      "Title and upload-date overlay sanity repair after activation",
      "Series Continuing limit, Shorts control, and advanced filters",
      "Persistent play counts and weighted Auto Shuffle",
      "Drag-and-drop queue ordering with download-change confirmation",
      "In-app Updates page with a copyable E-drive update command",
    ],
  },
  {
    version: "1.0.1",
    date: "Sep 20, 2026",
    title: "Faster five-video startup buffer",
    items: [
      "Downloads five videos before starting the livestream",
      "Deletes played media and refills the buffer continuously",
      "Download progress and Up Next details on the standby screen",
      "Faster fragment downloads without lowering video quality",
    ],
  },
] as const;
