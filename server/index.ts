import { mkdir, chmod, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { readConfig } from "./config.js";
import { Store } from "./db.js";
import { Engine } from "./engine.js";
import { createApp } from "./app.js";
try {
  process.loadEnvFile();
} catch {}
const config = readConfig(process.env);
await mkdir(config.DATA_DIR, { recursive: true, mode: 0o700 });
await chmod(config.DATA_DIR, 0o700).catch(() => {});
const lockPath = path.join(config.DATA_DIR, "owner.pid");
async function acquire() {
  try {
    return await open(lockPath, "wx", 0o600);
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(await readFile(lockPath, "utf8"));
    let alive = pid !== process.pid;
    try {
      if (alive) process.kill(pid, 0);
    } catch (e: any) {
      if (e.code === "ESRCH") alive = false;
    }
    if (alive)
      throw new Error(
        "Another IdleCast owner may be running; inspect data/owner.pid",
      );
    await unlink(lockPath);
    return open(lockPath, "wx", 0o600);
  }
}
const lock = await acquire();
await lock.writeFile(String(process.pid));
const store = new Store(path.join(config.DATA_DIR, "idlecast.db"));
const engine = new Engine(store, config);
const { app, closeStreams } = createApp(config, store, engine);
const server = app.listen(config.PORT, config.HOST, () =>
  console.log("IdleCast 1.1.3 is ready"),
);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  closeStreams();
  server.close();
  await engine.close();
  store.close();
  await lock.close();
  await unlink(lockPath);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
server.on("error", () => {
  console.error("HTTP listener failed");
  void shutdown();
});
if (store.get("desired", false))
  void engine
    .start()
    .catch(() =>
      engine.event(
        "Automatic resume needs configuration; review settings",
        "error",
      ),
    );
