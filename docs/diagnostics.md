# Idlecast diagnostic codes

Idlecast diagnostic codes are a permanent debugging API shared by the application, its operator, and Codex. The authoritative registry is [`server/diagnostics.ts`](../server/diagnostics.ts). Each entry defines the stable code, name, subsystem, severity, exact observed meaning, detection condition, relevant source components, and developer investigation guidance.

## Stability rules

- Never renumber a code.
- Never reuse a code for a different condition.
- Never change an existing code to mean something different.
- Add a new code when Idlecast learns to detect a new failure mechanism.
- Deprecate obsolete entries in place rather than deleting or repurposing them.
- A code describes what Idlecast observed. It must not claim an unproven root cause.

## Prefixes

| Prefix | Subsystem |
| --- | --- |
| `IC-SYS` | Runtime, storage, required directories, and process ownership |
| `IC-API` | YouTube Data API |
| `IC-AUTH` | YouTube authentication and cookies |
| `IC-DL` | yt-dlp and media downloads |
| `IC-CACHE` | Rolling media cache |
| `IC-FFMPEG` | FFmpeg producers and filters |
| `IC-MEDIA` | FFprobe audio/video validation |
| `IC-PLAY` | Playback selection and supervision |
| `IC-TRANS` | Video transitions |
| `IC-OUTPUT` | Persistent RTMP output and recovery |
| `IC-DB` | SQLite database |
| `IC-PL` | Playlist synchronization and eligibility |

## Health page behavior

`server/health.ts` combines current process state, executable checks, SQLite integrity, disk/cache measurements, download and transition success telemetry, output state, and recent unresolved diagnostic records. The Health page reports `HEALTHY`, `DEGRADED`, or `CRITICAL` overall and lets the operator expand every subsystem to see the evidence behind its status.

Finding an executable proves only that it is **Available**. A recent successful operation is required before an operational subsystem is reported as **Healthy**. Recent failures remain visible until a relevant later success demonstrates recovery or the diagnostic age expires.

## When a user gives Codex a diagnostic code

1. Search the registry for the exact code.
2. Read its exact meaning and detection condition.
3. Inspect the listed relevant components.
4. Use the accompanying runtime information.
5. Fix the underlying cause.
6. Do **not** simply suppress or remove the diagnostic.
7. Do **not** change the code's established meaning.

The copied report identifies the Idlecast version and event time, contains the sanitized observed condition and runtime state, and repeats these instructions.

## Sensitive information

Runtime diagnostic data is sanitized when it is recorded and again before the Health API returns it. Keys whose names indicate passwords, secrets, tokens, cookies, API keys, stream keys, or authorization are removed. Common credential-like values embedded in strings are replaced with `[REDACTED]`. Diagnostic definitions and Health details must never include credential values.

When adding runtime context, use identifiers, counts, states, exit codes, timings, and paths needed to investigate the problem. Never attach raw request headers, cookie contents, API keys, stream keys, passwords, or authentication tokens.
