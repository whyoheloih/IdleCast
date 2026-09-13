import { spawn, type ChildProcess } from "node:child_process";
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
  child.stderr?.resume(); // Never expose third-party output: it may contain credentials.
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
): Promise<string> {
  const bounded = new AbortController();
  const combined = AbortSignal.any([signal, bounded.signal]);
  const child = launch(binary, args, combined);
  let output = "";
  let checking = false;
  child.stdout?.on("data", (chunk) => {
    if (output.length < 1048576) output += String(chunk);
    else bounded.abort();
  });
  const timer = setTimeout(() => bounded.abort(), timeout);
  const monitor = check
    ? setInterval(() => {
        if (checking) return;
        checking = true;
        check()
          .catch(() => bounded.abort())
          .finally(() => {
            checking = false;
          });
      }, 500)
    : undefined;
  try {
    const code = await completion(child);
    combined.throwIfAborted();
    if (code !== 0) throw new Error("Media tool failed");
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
