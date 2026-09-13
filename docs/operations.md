# Operations

## Credentials and playlist setup

Enable YouTube Data API v3 in Google Cloud and create an API key restricted to that API (and your VPS egress IP where practical). Quota or access failures preserve the last successful playlist snapshot. Playlist sync does not obtain downloadable media.

Get stream keys from YouTube Studio/Twitch creator settings. Prepare the account's live broadcast separately. Configure each enabled destination independently in IdleCast. Do not paste a stream key into the ingest-server field: only the base endpoint is accepted.

Media fetching uses the experimental yt-dlp adapter. The default example opts in with EXPERIMENTAL_YOUTUBE=true. Use authorized media; unsupported access restrictions are not bypassed.

## Diagnostics

The Health screen reports executable availability, database integrity, disk space, memory, uptime, and worker state. Logs record structured events without raw tool output.

| Symptom                        | Action                                                                                                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cannot sign in                 | Check ADMIN_PASSWORD, exact PUBLIC_ORIGIN, cookie security and the hostname used in the browser. After repeated failures, wait 15 minutes.                        |
| Sync fails                     | Verify API enabled/key restrictions/quota and that the playlist is accessible without OAuth.                                                                      |
| Videos keep skipping           | Check yt-dlp version, Node availability, disk/cache limits and media accessibility. Try an authorized short public video; live/restricted videos are unsupported. |
| Output retrying                | Verify account streaming readiness, stream key, RTMPS endpoint, outbound firewall and DNS.                                                                        |
| Standby persists               | Inspect item failures and credential/tool checks. Items retry after five minutes; private/deleted entries need a later successful resync.                         |
| Overlay fails                  | Check FONT_FILE and media/avatars filename, file readability and FFmpeg drawtext support.                                                                         |
| Database permission error      | The container UID 1000 needs write permission on its data volume.                                                                                                 |
| Owner PID guard blocks startup | Confirm no other IdleCast process uses that data directory before removing a stale owner.pid. Never run two replicas.                                             |

Changing dashboard settings requires stopped playback. Environment changes require container recreation. Explicit Stop remains stopped after reboot; service shutdown/restart preserves a running station's desired state.

## Backup and restore

Stop the service first. Copy the entire persistent data directory/volume, including SQLite WAL/SHM files if present, to a protected backup. You can omit cache/ to save space. Store .env separately with restrictive permissions; it contains credentials. Start the service after the copy. Do not copy a live SQLite file alone.

Restore into an empty data volume while stopped, correct its UID 1000 ownership, inspect/remove a stale owner.pid only after confirming no running owner, and start the same or a compatible newer application version. Schema versions newer than the application are refused. Back up before upgrading.

## Updates

Pull reviewed changes, back up data, then run:

```sh
docker compose up -d --build
```

The Dockerfile pins yt-dlp 2026.8.19. An upstream fix can be selected explicitly:

```sh
docker compose build --build-arg YTDLP_VERSION=YOUR_VERIFIED_VERSION
docker compose up -d
```

Reverify an authorized playlist and both outputs after upgrading. A HEALTHCHECK failure reports process reachability; Docker's restart policy restarts exited containers, not merely unhealthy containers.

## Optional local-media provider

Select Local files in Settings and put VIDEO_ID.mp4 (or .mkv/.webm/.mov) in media/. Metadata and order still come from the YouTube playlist. This alternative is useful for media already owned locally and is not required for the primary playlist-link workflow.

## Deployment acceptance checklist

- Verify your playlist sync and first successful YouTube media download.
- Confirm intended live visibility and sound in each destination's viewer.
- Disconnect one output and confirm the other continues.
- Restart the container during playback and confirm seek/resume.
- Test an unavailable item and an all-unavailable queue.
- Confirm disk headroom, CPU use, output bandwidth, and a 24-hour or longer soak on your VPS.
- Check external monitoring and protected backups.

## Reference documentation

- [YouTube playlist pagination](https://developers.google.com/youtube/v3/guides/implementation/pagination)
- [YouTube Data API reference](https://developers.google.com/youtube/v3/docs)
- [FFmpeg formats, tee and UDP output](https://ffmpeg.org/ffmpeg-formats.html)
- [Twitch broadcasting](https://dev.twitch.tv/docs/video-broadcast/)
- [yt-dlp installation and supported runtimes](https://github.com/yt-dlp/yt-dlp/wiki/Installation)
