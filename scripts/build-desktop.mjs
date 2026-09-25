import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const preferred = "E:/IdleCast/releases";
const output = process.env.IDLECAST_RELEASE_DIR
  ? path.resolve(process.env.IDLECAST_RELEASE_DIR)
  : existsSync("E:/IdleCast")
    ? preferred
    : path.resolve("release");
mkdirSync(output, { recursive: true });
console.log(`Writing Windows applications to ${output}`);
const cli = path.resolve("node_modules", "electron-builder", "out", "cli", "cli.js");
const result = spawnSync(
  process.execPath,
  [cli, "--win", "--x64", `--config.directories.output=${output}`],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
