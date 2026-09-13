# Verification record

## September 13 update

Fixed yt-dlp's invalid `--ffmpeg-location ffmpeg` argument by resolving installed executables to absolute paths. The original failing command downloaded separate video/audio files and returned no merged playable file. Node's executable path is now supplied explicitly for JavaScript challenges. Longer videos have a six-hour download allowance, within the existing cache limit.

Live public-media verification discovered 662 channel uploads. A public 2:58 video (`62YgJewro1M`) downloaded with 1280×720 video and audio, encoded locally at 720p30, and rendered a preview. A complete public 2:33:19 video (`C73ApAXxr7c`, approximately 2.37 GB) downloaded and merged in about 342 seconds; a five-second sample encoded at 1080p60 and the source preview rendered successfully. This is a full-download test plus sampled encoding, not a full-duration live broadcast. No unlisted videos were used in the new verification plan.

New automated checks cover channel handles/uploads, exclusions, duplicate-preserving shuffle, encrypted credentials, authenticated/Origin-protected writes, immediate application, persistence/fallback, outlined text, proportional square avatar cropping, and title updates between videos. Browser checks cover the new settings and credentials controls in addition to the existing desktop/mobile and overlay interactions.

The sections below describe the original release verification and its historical limitations.

IdleCast 1.0.0 was implemented from an empty repository. The detailed originating conversation was not available in readable task history; the supplied implementation brief and the explicit correction to use YouTube playlist links as the media source were the implementation baseline.

## Local verification

- TypeScript strict checking and Vite production build.
- Twelve unit/API/FFmpeg tests covering configuration, playlist-link parsing, full pagination, duplicate videos, unavailable entries, transactional rollback, persistence across database reopen, hashed-session authentication, Origin enforcement, secret exclusion, adapter opt-in/cache behavior, cancellation, reconnect backoff, independent text/avatar scaling, and isolated authenticated preview rendering.
- Real FFmpeg synthetic-media tests verify actual overlay pixels (the original release used a 65% background; the update verifies no background, outlined text, and proportional avatar cropping), multiple loop transitions with monotonic packet timestamps, a missing item, a deliberately failing second output, slow-media standby, all-unavailable standby, and stop/restart intent.
- Browser verification signs in using a temporary random password, saves a YouTube playlist URL, renders/scrolls a virtualized 1,000-item fixture queue, checks desktop and 390px mobile layouts, and checks for browser runtime errors. It also resizes text and a real fixture avatar in the preview window, verifies save/cancel and persisted sizes, and confirms unrelated draft settings are preserved.
- Desktop/mobile screenshots are test fixtures, not evidence of a live account broadcast.

## External verification boundaries

No real YouTube API key, destination stream key, or user playlist was supplied. The official metadata service is tested with deterministic mocked responses; the experimental downloader is tested with an injected tool runner. Actual YouTube extraction and YouTube/Twitch account ingest remain deployment acceptance tests.

Docker is not installed in the local Windows environment. The repository's Linux CI runs the build, tests, browser checks, Docker image build, and container startup/restart smoke checks. Check the repository's Actions results for the outcome.

A long-duration VPS soak, actual upstream disruptions, regional network behavior, and account-specific live visibility have not been demonstrated by local tests. Complete the deployment acceptance checklist in operations.md before treating the station as unattended production infrastructure.
