import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

const output = path.resolve("desktop-resources", "tools");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

async function file(value) {
  if (!value) return null;
  try {
    return (await stat(value)).isFile() ? path.resolve(value) : null;
  } catch {
    return null;
  }
}

function works(candidate, probeArgs) {
  const result = spawnSync(candidate, probeArgs, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  return result.status === 0;
}

async function locate(name, candidates, probeArgs) {
  const checked = new Set();
  const usable = async (candidate) => {
    const found = await file(candidate);
    if (!found || checked.has(found.toLowerCase())) return null;
    checked.add(found.toLowerCase());
    return works(found, probeArgs) ? found : null;
  };
  for (const candidate of candidates) {
    const found = await usable(candidate);
    if (found) return found;
  }
  const result = spawnSync("where.exe", [name], { encoding: "utf8" });
  if (result.status === 0)
    for (const candidate of result.stdout.split(/\r?\n/)) {
      const found = await usable(candidate.trim());
      if (found) return found;
    }
  throw new Error(
    `Could not find a working ${name}. Install it or set its path before building the desktop app.`,
  );
}

const tools = {
  "ffmpeg.exe": await locate("ffmpeg.exe", [
    process.env.FFMPEG_PATH,
    "C:/Program Files/ffmpeg/ffmpeg.exe",
    "C:/Program Files/ffmpeg/bin/ffmpeg.exe",
  ], ["-version"]),
  "ffprobe.exe": await locate("ffprobe.exe", [
    process.env.FFPROBE_PATH,
    "C:/Program Files/ffmpeg/ffprobe.exe",
    "C:/Program Files/ffmpeg/bin/ffprobe.exe",
  ], ["-version"]),
  "yt-dlp.exe": await locate("yt-dlp.exe", [
    process.env.YTDLP_PATH,
    process.env.ChocolateyInstall && path.join(process.env.ChocolateyInstall, "lib", "yt-dlp", "tools", "x64", "yt-dlp.exe"),
    "C:/ProgramData/chocolatey/lib/yt-dlp/tools/x64/yt-dlp.exe",
    "E:/IdleCast/repo/data/tools/yt-dlp.exe",
    path.resolve("data", "tools", "yt-dlp.exe"),
  ], ["--version"]),
};
for (const [name, source] of Object.entries(tools)) {
  await copyFile(source, path.join(output, name));
  console.log(`Bundled ${name} from ${source}`);
}
