# Verification record

IdleCast 1.0.0 was implemented from an empty repository. The detailed originating conversation was not available in readable task history; the supplied implementation brief and the explicit correction to use YouTube playlist links as the media source were the implementation baseline.

## Local verification

- TypeScript strict checking and Vite production build.
- Ten unit/API/FFmpeg tests covering configuration, playlist-link parsing, full pagination, duplicate videos, unavailable entries, transactional rollback, persistence across database reopen, hashed-session authentication, Origin enforcement, secret exclusion, adapter opt-in/cache behavior, cancellation, and reconnect backoff.
- Real FFmpeg synthetic-media tests verify actual overlay pixels (65% background opacity and opaque avatar/text), multiple loop transitions with monotonic packet timestamps, a missing item, a deliberately failing second output, slow-media standby, all-unavailable standby, and stop/restart intent.
- Browser verification signs in using a temporary random password, saves a YouTube playlist URL, renders/scrolls a virtualized 1,000-item fixture queue, checks desktop and 390px mobile layouts, and checks for browser runtime errors.
- Desktop/mobile screenshots are test fixtures, not evidence of a live account broadcast.

## External verification boundaries

No real YouTube API key, destination stream key, or user playlist was supplied. The official metadata service is tested with deterministic mocked responses; the experimental downloader is tested with an injected tool runner. Actual YouTube extraction and YouTube/Twitch account ingest remain deployment acceptance tests.

Docker is not installed in the local Windows environment. The repository's Linux CI runs the build, tests, browser checks, Docker image build, and container startup/restart smoke checks. Check the repository's Actions results for the outcome.

A long-duration VPS soak, actual upstream disruptions, regional network behavior, and account-specific live visibility have not been demonstrated by local tests. Complete the deployment acceptance checklist in operations.md before treating the station as unattended production infrastructure.
