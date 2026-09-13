import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Config, Settings } from "./config.js";
import { containedFile } from "./providers.js";

export function filterPath(value: string) {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
}

export function overlayLayout(s: Settings) {
  const { margin, fontSize, avatarSize } = s.overlay;
  const hasAvatar = !!s.overlay.avatar;
  const height = Math.max(76, fontSize + 20, hasAvatar ? avatarSize + 20 : 0);
  const textInset = hasAvatar ? avatarSize + 32 : 20;
  const maxCharacters = Math.max(
    1,
    Math.floor((s.width - 2 * margin - textInset - 20) / fontSize),
  );
  const cleanTitle = [...s.overlay.title.replace(/[\r\n\x00-\x1f]/g, " ")];
  const title =
    cleanTitle.length > maxCharacters
      ? cleanTitle.slice(0, Math.max(0, maxCharacters - 1)).join("") + "…"
      : cleanTitle.join("");
  return {
    title,
    x: margin,
    y: s.height - margin - height,
    height,
    width: Math.min(
      s.width - 2 * margin,
      Math.max(250, textInset + [...title].length * fontSize + 20),
    ),
    textX: margin + textInset,
    centerY: s.height - margin - height / 2,
    avatarX: margin + 10,
    avatarY: s.height - margin - height + (height - avatarSize) / 2,
  };
}

// Preview requests use their own directory so drafts never change broadcast text files.
export async function overlay(
  c: Config,
  s: Settings,
  directory = path.join(c.DATA_DIR, "overlay"),
): Promise<{ inputs: string[]; filter: string }> {
  const base = `[0:v:0]scale=${s.width}:${s.height}:force_original_aspect_ratio=decrease,pad=${s.width}:${s.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${s.fps},format=yuv420p[base]`;
  if (!s.overlay.enabled)
    return { inputs: [], filter: base + ";[base]null[v]" };
  await mkdir(directory, { recursive: true });
  const layout = overlayLayout(s);
  const textFile = path.join(directory, "title.txt");
  await writeFile(textFile, layout.title);
  const avatar = s.overlay.avatar
    ? await containedFile(path.join(c.MEDIA_DIR, "avatars"), s.overlay.avatar)
    : "";
  const draw = `drawtext=fontfile='${filterPath(c.FONT_FILE)}':textfile='${filterPath(textFile)}':expansion=none:fontcolor=white:fontsize=${s.overlay.fontSize}:x=${layout.textX}:y=${layout.centerY}-th/2`;
  const box = `[base]drawbox=x=${layout.x}:y=${layout.y}:w=${layout.width}:h=${layout.height}:color=black@0.65:t=fill[box]`;
  if (!avatar)
    return { inputs: [], filter: base + ";" + box + ";[box]" + draw + "[v]" };
  return {
    inputs: ["-loop", "1", "-i", avatar],
    filter:
      base +
      ";" +
      box +
      `;[2:v:0]scale=${s.overlay.avatarSize}:${s.overlay.avatarSize},format=rgb24[avatar];[box][avatar]overlay=x=${layout.avatarX}:y=${layout.avatarY}:shortest=1[withAvatar];[withAvatar]` +
      draw +
      "[v]",
  };
}
