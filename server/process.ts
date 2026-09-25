import { spawn, type ChildProcess } from "node:child_process";
const diagnostics = new WeakMap<ChildProcess, string>();
export function mediaFailure(child: ChildProcess): string {
  const text = diagnostics.get(child) ?? "";
  if (/ffmpeg-location.*does not exist|ffmpeg is not installed/i.test(text))
    return "FFmpeg location is invalid; audio and video could not be merged";
  if (/sign in|confirm.*bot|cookies|login required/i.test(text))
    return "YouTube requires account verification for this request";
  if (/403|forbidden/i.test(text))
    return "YouTube media request denied (HTTP 403)";
  if (/429|too many requests/i.test(text))
    return "YouTube rate limit reached; retry later";
  if (/max.filesize|larger than|file.*too large/i.test(text))
    return "Video exceeds the configured per-video cache limit";
  if (/No space left|disk full/i.test(text)) return "Media disk is full";
  if (/font|drawtext/i.test(text))
    return "Overlay font or text filter could not load";
  if (/No such file|Invalid argument|Error opening/i.test(text))
    return "Media file, executable path, or encoder input is invalid";
  if (/Requested format.*not available/i.test(text))
    return "YouTube has no matching playable format";
  return "Media tool failed; check executable paths, source access, and selected quality";
}
export function launch(
  binary: string,
  args: string[],
  signal: AbortSignal,
): ChildProcess {
  signal.throwIfAborted();
  const child = spawn(binary, args, {
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Retain a bounded diagnostic privately; only fixed classifications reach logs.
  child.stderr?.on("data", (b) =>
    diagnostics.set(
      child,
      ((diagnostics.get(child) ?? "") + String(b)).slice(-8192),
    ),
  );
  const abort = () => terminate(child);
  signal.addEventListener("abort", abort, { once: true });
  child.once("close", () => signal.removeEventListener("abort", abort));
  return child;
}
export function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {}
  };
  kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) kill("SIGKILL");
  }, 3000);
  timer.unref();
  child.once("close", () => clearTimeout(timer));
}
export function completion(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", () =>
      reject(new Error("Required media executable could not start")),
    );
    child.once("close", (code) => resolve(code ?? -1));
  });
}
export async function runCapture(
  binary: string,
  args: string[],
  signal: AbortSignal,
  timeout = 30000,
  check?: () => Promise<void>,
  onOutput?: (chunk: string) => void,
): Promise<string> {
  const bounded = new AbortController();
  const combined = AbortSignal.any([signal, bounded.signal]);
  const child = launch(binary, args, combined);
  let output = "";
  let checking = false;
  let failureReason = "Media operation timed out";
  child.stderr?.on("data", (chunk) => onOutput?.(String(chunk)));
  child.stdout?.on("data", (chunk) => {
    const text = String(chunk);
    onOutput?.(text);
    if (output.length < 1048576) output += text;
    else bounded.abort();
  });
  const timer = setTimeout(() => bounded.abort(), timeout);
  const monitor = check
    ? setInterval(() => {
        if (checking) return;
        checking = true;
        check()
          .catch((error) => {
            failureReason =
              error instanceof Error
                ? error.message
                : "Media cache limit exceeded or cache storage is unavailable";
            bounded.abort();
          })
          .finally(() => {
            checking = false;
          });
      }, 500)
    : undefined;
  try {
    const code = await completion(child);
    if (bounded.signal.aborted && !signal.aborted)
      throw new Error(failureReason);
    combined.throwIfAborted();
    if (code !== 0) throw new Error(mediaFailure(child));
    return output;
  } finally {
    clearTimeout(timer);
    clearInterval(monitor);
  }
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export function backoff(attempt: number) {
  return Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
}

export function withCancellation<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Cancelled"));
    if (signal.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", abort);
        reject(e);
      },
    );
  });
}
