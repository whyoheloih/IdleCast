# IdleCast

**Your playlist. Always live.**

A self-hosted, single-owner livestream control room. Paste a **YouTube playlist link or channel URL**, sync the queue, and broadcast continuously to YouTube Live, Twitch, or both.

IdleCast uses the **official YouTube Data API for metadata and ordering only**. Video/audio is fetched separately by an **experimental yt-dlp MediaSourceProvider**. You do not need to supply local video files for the primary workflow. Local files are an optional adapter for media you already have.

## What v1.0.0 includes

- Complete YouTube playlist pagination, duplicate entries, original ordering, scheduled/manual resync, and atomic snapshots.
- SQLite migrations, durable playback intent and cursor, five-second progress checkpoints, restart recovery, per-item failure cooldowns, and continuous looping.
- A two-video rolling media cache, serialized next-item prefetch, visible download progress, cache-deletion logs, and a branded standby stream while downloads are slow or items are unavailable.
- Selectable 720p or 1080p H.264/AAC output at 24, 30, or 60 fps, shared by independent RTMPS output workers.
- Current video title and upload date in the bottom-left plus elapsed/total time in the bottom-right: **white text with a black outline and no background rectangle**. The title/date block is centered beside a proportional square avatar crop.
- Combined playlist/channel queues, title exclusions, reshuffling, and manual queue ordering. Shuffled queues start with two videos of 15 minutes or less, keep ordinary videos over 70 minutes from playing consecutively, and place videos over 3 hours directly after a video of at least 2 hours for download lead time.
- In-app API/stream-key fields with encrypted storage and immediate application while playback is stopped; environment credentials remain a fallback.
- Responsive dark React/TypeScript/Tailwind dashboard with setup/settings, virtualized playlist, live SSE updates, event logs, and health checks.
- Single-admin authentication, hashed sessions, origin checks, login throttling, strict configuration validation, and masked credentials.
- Docker deployment, bounded container logs, unit/API tests, real FFmpeg integration tests, and browser tests.

## Quick start with Docker

Requirements: Linux host with Docker Engine and Compose, a YouTube Data API v3 key, and at least one destination stream key. Allow outbound HTTPS and RTMPS. Use a public/unlisted playlist containing videos you are authorized to rebroadcast.

```sh
git clone https://github.com/whyoheloih/idlecast.git
cd idlecast
cp .env.example .env
mkdir -p media/avatars
```

Edit `.env`:

1. Set `ADMIN_PASSWORD` to a unique password of at least 16 characters.
2. Set `YOUTUBE_API_KEY`.
3. Set `YOUTUBE_STREAM_KEY`, `TWITCH_STREAM_KEY`, or both.
4. Leave `EXPERIMENTAL_YOUTUBE=true` for playlist-supplied media.

```sh
chmod 600 .env
docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000), sign in, and:

1. Open **Settings**, paste your YouTube playlist link, and leave **YouTube — experimental** selected.
2. Enable your destinations and verify the ingest addresses.
3. Save settings, then **Sync playlist**.
4. In the destination's creator dashboard, prepare the live broadcast. IdleCast does not create/schedule YouTube broadcasts or change their visibility.
5. Return to Overview and select **Start broadcast**. Confirm viewer playback in YouTube Studio/Twitch.

The first download can take time. A standby slate begins after a short delay while media is prepared. Short transitions between clips are possible; IdleCast is not frame-perfect broadcast automation.

## Access on a VPS

Compose exposes the dashboard only on host loopback. For private access:

```sh
ssh -L 3000:127.0.0.1:3000 user@your-vps
```

Then visit localhost:3000. For remote HTTPS access, place a TLS reverse proxy in front, set `PUBLIC_ORIGIN=https://your-hostname` and `COOKIE_SECURE=true`, then recreate the container. The origin must exactly match the browser's origin, with no trailing slash. Do not publish UDP ports or expose an unauthenticated reverse-proxy route.

The data volume is owned by container user UID 1000. A new named volume is initialized by Docker. If you use a bind mount instead, make it writable by UID 1000 before starting.

## Configuration

### Desktop setup and queue controls

On Windows, run `Start-IdleCast.ps1`. Use `Start-IdleCast.ps1 -Restart` to stop playback and reload environment changes; simply opening the app does not restart an existing server. The installed E: drive launchers are `E:\IdleCast\Start IdleCast.cmd` and `E:\IdleCast\Restart IdleCast.cmd`.

In Settings, choose Playlist or Entire YouTube channel. Channel input accepts `https://www.youtube.com/@handle`, `/channel/UC…`, legacy `/user/name`, a channel ID, or an @handle. Legacy `/c/` vanity URLs should be replaced with the channel's @handle URL. Exclusion phrases match anywhere in a title, ignoring capitalization. Enter one phrase per line. Shuffle randomizes the filtered queue on manual or scheduled sync. The first two playable items are 15 minutes or shorter. Ordinary videos over 70 minutes are separated whenever the queue contains enough shorter videos. A video over 3 hours is allowed directly after a video of at least 2 hours so the rolling cache can download it during the preceding video. Playback waits when the next required scheduling condition cannot be satisfied. Use the Playlist page arrows to adjust the generated order while playback is stopped; the resulting order repeats until the next sync or reshuffle. Changing source, exclusions, or shuffle clears the old queue and requires a fresh sync.

Use the Credentials section to save YouTube API, YouTube stream, and Twitch stream keys. Stop playback and wait for sync first. Blank fields preserve current values; “Use .env credentials instead” removes saved overrides. Saved keys use AES-256-GCM encryption in SQLite, with a separate host key in `data/credentials.key`. Back up the database and that key together. The owning OS user can access both; this does not protect against a compromised host. Keys are never returned by the API or written into logs. In-app changes take effect without a server restart.

The overlay uses the actual video title during playback; the editable title is a standby/preview fallback. Save output quality before previewing it. Source resolution/frame rate cannot be increased beyond the original detail or motion. The preview remains periodic snapshots, not a full-motion player.

Downloads use resolved FFmpeg paths and the running Node executable for YouTube JavaScript challenges. The full video must download and merge before playback. Long downloads have a six-hour maximum; the cache monitor still enforces the overall budget. With `CACHE_MAX_MB=65536`, the per-video limit is 32 GiB. Safe diagnostic categories now distinguish merge/path, access, format, and cache problems without exposing raw third-party output.

Credentials come from encrypted in-app storage or the environment fallback and are never returned by the admin API or included in logs. The dashboard only reports whether a key is configured. Restart/recreate after changing environment values; in-app credential saves apply immediately. Sessions expire after 24 hours and are invalidated on service startup.

| Environment variable                        | Purpose / default                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `ADMIN_PASSWORD`                            | Required, 16–256 characters                                               |
| `YOUTUBE_API_KEY`                           | Official API metadata access                                              |
| `YOUTUBE_STREAM_KEY`, `TWITCH_STREAM_KEY`   | Independent destination credentials                                       |
| `EXPERIMENTAL_YOUTUBE`                      | Explicit adapter enablement; example file sets true                       |
| `PUBLIC_ORIGIN`                             | `http://localhost:3000`                                                   |
| `COOKIE_SECURE`                             | false for loopback, true with remote HTTPS                                |
| `DATA_DIR`                                  | `./data`; Compose uses `/app/data`                                        |
| `MEDIA_DIR`                                 | `./media`; optional local media and avatar images                         |
| `CACHE_MAX_MB`                              | 4096; each completed item limited to half the cache                       |
| `UDP_BASE_PORT`                             | 19000; two loopback-only receiver ports                                   |
| `FFMPEG_PATH`, `FFPROBE_PATH`, `YTDLP_PATH` | Executable locations                                                      |
| `FONT_FILE`                                 | DejaVu Sans in Docker; adjust for native installations                    |
| `HOST`, `PORT`                              | Native bind defaults to 127.0.0.1:3000; Compose fixes container port 3000 |

Dashboard settings are stored in SQLite. Defaults are 720p, 30 fps, 2500 kbps video, 128 kbps audio, and 15-minute playlist resync. Both destinations begin disabled. Stop playback before saving settings; sync is also serialized with settings updates.

For an avatar, put `avatar.png` (or JPEG) in `media/avatars` and enter the filename in Settings. Open **Overlay preview** from Settings, or **Preview / resize overlay** from Overview. Adjust the **Text size** (12–96 px) and **Profile picture size** (24–240 px) sliders independently; edge spacing is also adjustable. Choose **Save overlay** to persist just the overlay, or **Cancel** to discard the preview edits. Other unsaved settings remain intact.

The preview uses the same FFmpeg overlay renderer as the broadcast. During playback it shows snapshots of the current video refreshed roughly every two seconds; while stopped/preparing it shows a standby canvas. It has no audio and is not a full-motion destination/player monitor. Previewing is available during playback, but saving requires stopped playback and no active sync. Draft renders never modify broadcast text files. The overlay stays bottom-left with outlined white text and no background rectangle. Long titles remain complete and automatically scale or wrap to fit beside the avatar.

## Operational limits

- YouTube media extraction is **experimental** and can break when YouTube changes. API metadata access does not provide download permission or downloadable media.
- API-key access supports accessible public/unlisted playlists. Private playlists require OAuth, which is not implemented. Restricted, private, deleted, live, geographic, age-gated, DRM-protected, or otherwise inaccessible media may be skipped. Cookie files authenticate media extraction only; they do not add private-playlist metadata access or bypass access controls.
- yt-dlp uses its installed JavaScript support with Node and downloads/merges video and audio. Docker pins a verified release; update the `YTDLP_VERSION` build argument when an upstream fix is needed. No extraction success is guaranteed.
- If YouTube requests account verification, export a dedicated Netscape-format cookie file outside Git and set `YTDLP_COOKIES_FILE` to its absolute path. IdleCast passes it to yt-dlp without logging its contents.
- The cache retains the playing item and next download. Temporary fragments/merge files count toward the cache budget; the monitor can stop a download early. Leave disk headroom: polling is not a filesystem quota.
- Missing/failed items retry after five minutes. If none are eligible, the standby stream continues and eligibility is rechecked.
- Brief timestamp/decoder transitions and network outages remain possible. Standby is not an uptime guarantee. Output “sending” means FFmpeg reports progress; it does not prove viewers can watch.
- One process and one data volume per installation. Horizontal replicas are unsupported.
- A host administrator or the owning OS user can inspect environment/process memory and FFmpeg arguments. Treat the host as trusted. IdleCast avoids putting those secrets in browser responses and diagnostics.
- Public YouTube downloads and local encoding were verified with short and multi-hour videos. Viewer playback through a live YouTube/Twitch destination and long-duration VPS soak testing remain unverified.

## Lightweight VPS guidance

Start with a Linux VPS with 2 vCPU, 2 GB RAM, and enough disk for the cache; benchmark your actual media and CPU allocation. At default bitrate, each destination uses roughly 28–30 GB/day outbound, plus protocol overhead. Two destinations approximately double outbound traffic. Source downloads add inbound traffic. Check the provider's transfer allowance.

The default encoder uses x264 veryfast without animation-heavy dashboard effects. Logs retain the latest 1,000 events; the UI requests the latest 200. Playlist API pages are bounded at 500 items; the UI renders only visible rows. Metadata snapshots are held in memory during sync (100,000-item safety cap).

## Native development and verification

Use Node 24+, pnpm 11.19.0, FFmpeg/FFprobe with libx264, drawtext and AAC, and yt-dlp 2026.8.19 or a compatible newer release. Install yt-dlp's default extras and ensure Node is on PATH.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
# Fill the required environment values.
pnpm build
pnpm start
```

For hot reload, run `pnpm dev` and `pnpm exec vite` in separate terminals, with `PUBLIC_ORIGIN=http://localhost:5173`. Open port 5173. The Vite proxy forwards API requests to port 3000.

```sh
pnpm check
pnpm test
pnpm exec playwright install chromium
pnpm test:browser
```

FFmpeg tests create synthetic local fixtures only; they never send to YouTube or Twitch. Browser tests use temporary random credentials and isolated data. On Windows, the tests use Arial; production defaults use DejaVu Sans. Docker compilation is checked in GitHub Actions.

See [architecture](docs/architecture.md), [operations](docs/operations.md), and [verification](docs/verification.md).
