# IdleCast

**Your playlist. Always live.**

A self-hosted, single-owner livestream control room. Paste a **YouTube playlist link**, sync its order, and broadcast continuously to YouTube Live, Twitch, or both.

IdleCast uses the **official YouTube Data API for metadata and ordering only**. Video/audio is fetched separately by an **experimental yt-dlp MediaSourceProvider**. You do not need to supply local video files for the primary workflow. Local files are an optional adapter for media you already have.

## What v1.0.0 includes

- Complete YouTube playlist pagination, duplicate entries, original ordering, scheduled/manual resync, and atomic snapshots.
- SQLite migrations, durable playback intent and cursor, five-second progress checkpoints, restart recovery, per-item failure cooldowns, and continuous looping.
- A bounded media cache, next-item prefetch, and a branded standby stream while downloads are slow or all items are temporarily unavailable.
- One 720p H.264/AAC encode shared by independent RTMPS output workers, capped reconnect backoff, and progress watchdogs.
- Configurable bottom-left channel title/avatar overlay: **65% background opacity; fully opaque image and text**.
- Responsive dark React/TypeScript/Tailwind dashboard with setup/settings, virtualized playlist, live SSE updates, event logs, and health checks.
- Single-admin authentication, hashed sessions, origin checks, login throttling, strict configuration validation, and environment-only credentials.
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

Credentials stay in the environment and are never returned by the admin API or included in logs. The dashboard only reports whether a key is configured. Restart/recreate after changing environment values. Sessions expire after 24 hours and are invalidated on service startup.

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

The preview uses the same FFmpeg overlay renderer as the broadcast. During playback it shows snapshots of the current video refreshed roughly every two seconds; while stopped/preparing it shows a standby canvas. It has no audio and is not a full-motion destination/player monitor. Previewing is available during playback, but saving requires stopped playback and no active sync. Draft renders never modify broadcast text files. The overlay stays bottom-left, with 65% background opacity and fully opaque text/picture. Long titles are clipped conservatively to fit the frame.

## Operational limits

- YouTube media extraction is **experimental** and can break when YouTube changes. API metadata access does not provide download permission or downloadable media.
- API-key access supports accessible public/unlisted playlists. Private playlists require OAuth, which is not implemented. Restricted, private, deleted, live, geographic, age-gated, DRM-protected, or otherwise inaccessible media may be skipped. Cookie import and access-control bypass are not implemented.
- yt-dlp uses its installed JavaScript support with Node and downloads/merges video and audio. Docker pins a verified release; update the `YTDLP_VERSION` build argument when an upstream fix is needed. No extraction success is guaranteed.
- The cache retains the playing item and next download. Temporary fragments/merge files count toward the cache budget; the monitor can stop a download early. Leave disk headroom: polling is not a filesystem quota.
- Missing/failed items retry after five minutes. If none are eligible, the standby stream continues and eligibility is rechecked.
- Brief timestamp/decoder transitions and network outages remain possible. Standby is not an uptime guarantee. Output “sending” means FFmpeg reports progress; it does not prove viewers can watch.
- One process and one data volume per installation. Horizontal replicas are unsupported.
- A host administrator or the owning OS user can inspect environment/process memory and FFmpeg arguments. Treat the host as trusted. IdleCast avoids putting those secrets in browser responses and diagnostics.
- No live account credentials were used during local verification. Real YouTube extraction, account ingest, and long-duration VPS soak testing require your environment.

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
