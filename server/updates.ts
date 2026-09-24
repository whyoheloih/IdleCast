export const updateCommand =
  "Set-Location 'E:\\IdleCast\\repo'; git pull --ff-only; pnpm install --frozen-lockfile; pnpm build; pnpm start";

export const updateHistory = [
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
