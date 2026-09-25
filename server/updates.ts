export const updateCommand =
  "Set-Location 'E:\\IdleCast\\repo'; & 'C:\\Users\\ejbot\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\native\\git\\cmd\\git.exe' pull --ff-only; & 'C:\\Users\\ejbot\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\bin\\fallback\\pnpm.cmd' install --frozen-lockfile; & 'C:\\Users\\ejbot\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\bin\\fallback\\pnpm.cmd' build; & 'C:\\Users\\ejbot\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\bin\\fallback\\pnpm.cmd' start";

export const updateHistory = [
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
