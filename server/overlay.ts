import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Config, Settings } from "./config.js";
import { containedFile } from "./providers.js";
export function filterPath(value: string) {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
}
export async function overlay(
  c: Config,
  s: Settings,
): Promise<{ inputs: string[]; filter: string }> {
  const base = `[0:v:0]scale=${s.width}:${s.height}:force_original_aspect_ratio=decrease,pad=${s.width}:${s.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${s.fps},format=yuv420p[base]`;
  if (!s.overlay.enabled)
    return { inputs: [], filter: base + ";[base]null[v]" };
  const root = path.join(c.DATA_DIR, "overlay");
  await mkdir(root, { recursive: true });
  // textfile + expansion=none prevents metadata being interpreted as FFmpeg expressions.
  const textFile = path.join(root, "title.txt");
  await writeFile(
    textFile,
    s.overlay.title
      .replace(/[\r\n\x00-\x1f]/g, " ")
      .slice(
        0,
        Math.floor((s.width - 2 * s.overlay.margin - 110) / s.overlay.fontSize),
      ),
  );
  const { margin: m, fontSize } = s.overlay;
  let avatar = "";
  if (s.overlay.avatar)
    avatar = await containedFile(
      path.join(c.MEDIA_DIR, "avatars"),
      s.overlay.avatar,
    );
  const boxWidth = Math.min(
    s.width - 2 * m,
    Math.max(
      250,
      Math.ceil(s.overlay.title.length * fontSize * 0.62) + (avatar ? 104 : 40),
    ),
  );
  const draw = `drawtext=fontfile='${filterPath(c.FONT_FILE)}':textfile='${filterPath(textFile)}':expansion=none:fontcolor=white:fontsize=${fontSize}:x=${m + (avatar ? 88 : 20)}:y=h-${m + 38}-th/2`;
  const box = `[base]drawbox=x=${m}:y=ih-${m + 76}:w=${boxWidth}:h=76:color=black@0.65:t=fill[box]`;
  if (!avatar)
    return { inputs: [], filter: base + ";" + box + ";[box]" + draw + "[v]" };
  return {
    inputs: ["-loop", "1", "-i", avatar],
    filter:
      base +
      ";" +
      box +
      ";[2:v:0]scale=56:56,format=rgb24[avatar];[box][avatar]overlay=x=" +
      (m + 10) +
      ":y=H-" +
      (m + 66) +
      ":shortest=1[withAvatar];[withAvatar]" +
      draw +
      "[v]",
  };
}
