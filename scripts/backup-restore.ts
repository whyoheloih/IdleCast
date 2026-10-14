import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readConfig } from "../server/config.js";
import { Store } from "../server/db.js";
import { APP_VERSION } from "../server/version.js";

try { process.loadEnvFile(process.env.IDLECAST_ENV_FILE || undefined); } catch {}
const config = readConfig(process.env);
const command = process.argv[2];
const suppliedPath = process.argv.find((argument, index) => index > 2 && argument !== "--confirm");
const confirmed = process.argv.includes("--confirm");
const ownerFile = path.join(config.DATA_DIR, "owner.pid");

async function requireStopped() {
  try {
    const pid = Number((await readFile(ownerFile, "utf8")).trim());
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        throw new Error("IdleCast is running. Stop the application before backup or restore.");
      } catch (error: any) {
        if (error?.message?.startsWith("IdleCast is running")) throw error;
        if (error?.code !== "ESRCH") throw error;
      }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

await requireStopped();
await mkdir(config.DATA_DIR, { recursive: true });
const store = new Store(path.join(config.DATA_DIR, "idlecast.db"));
try {
  if (command === "export") {
    const backup = store.exportBackup(APP_VERSION);
    const directory = path.join(config.DATA_DIR, "backups");
    await mkdir(directory, { recursive: true });
    const destination = path.resolve(suppliedPath || path.join(directory, "IdleCast-backup-" + new Date(backup.createdAt).toISOString().replace(/[:.]/g, "-") + ".json"));
    await writeFile(destination, JSON.stringify(backup, null, 2), { encoding: "utf8", mode: 0o600 });
    console.log("IdleCast backup created: " + destination);
    console.log("Credentials, stream keys, API keys, passwords, and login sessions were excluded.");
  } else if (command === "restore") {
    if (!suppliedPath) throw new Error("Provide a backup file: pnpm restore -- C:\\path\\IdleCast-backup.json --confirm");
    if (!confirmed) throw new Error("Restore replaces stored settings and history. Run again with --confirm after reviewing the backup path.");
    const backupPath = path.resolve(suppliedPath);
    const value = JSON.parse(await readFile(backupPath, "utf8"));
    const safety = store.exportBackup(APP_VERSION);
    const directory = path.join(config.DATA_DIR, "backups");
    await mkdir(directory, { recursive: true });
    const safetyPath = path.join(directory, "before-restore-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
    await writeFile(safetyPath, JSON.stringify(safety, null, 2), { encoding: "utf8", mode: 0o600 });
    store.restoreBackup(value);
    console.log("IdleCast backup restored from: " + backupPath);
    console.log("Pre-restore safety backup: " + safetyPath);
  } else {
    throw new Error("Use pnpm backup, or pnpm restore -- C:\\path\\IdleCast-backup.json --confirm");
  }
} finally {
  store.close();
}