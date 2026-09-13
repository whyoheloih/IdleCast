import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Config, Settings } from "./config.js";
import { containedFile } from "./providers.js";

export function filterPath(value: string) {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "'\\''");
}

export function overlayLayout(s: Settings, publishedAt = "") {
  const { margin, fontSize, avatarSize } = s.overlay;
  const hasAvatar = !!s.overlay.avatar;
  const height = Math.max(76, fontSize + 20, hasAvatar ? avatarSize + 20 : 0);
  const textInset = hasAvatar ? avatarSize + 32 : 20;
  const cleanTitle = s.overlay.title.replace(/[\r\n\x00-\x1f]/g, " ");
  const date = formatUploadDate(publishedAt);
  const availableWidth = s.width - 2 * margin - textInset - 20;
  const availableHeight = hasAvatar ? avatarSize : Math.max(100, fontSize * 3);
  let size = fontSize;
  let lines: string[] = [];
  for (; size >= 1; size--) {
    const count = Math.max(1, Math.floor(availableWidth / size));
    lines = [];
    let remaining = [...cleanTitle];
    while (remaining.length) {
      let take = Math.min(count, remaining.length);
      if (take < remaining.length) {
        const space = remaining.slice(0, take).lastIndexOf(" ");
        if (space > count / 2) take = space + 1;
      }
      lines.push(remaining.splice(0, take).join("").trimEnd());
    }
    if (lines.length * size * 1.25 + (date ? Math.max(1, Math.round(size * .65)) * 1.5 : 0) <= availableHeight) break;
  }
  const title = lines.join("\n");
  return {
    title,
    date,
    fontSize: size,
    dateSize: Math.max(1, Math.round(size * .65)),
    textY: s.height - margin - height + (height - (hasAvatar ? avatarSize : availableHeight)) / 2,
    dateOffset: lines.length * size * 1.25,
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

export function formatUploadDate(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][date.getUTCMonth()];
  return `${month}.${String(date.getUTCDate()).padStart(2,"0")}.${String(date.getUTCFullYear()).slice(-2)}`;
}

// Preview requests use their own directory so drafts never change broadcast text files.
export async function overlay(
  c: Config,
  s: Settings,
  directory = path.join(c.DATA_DIR, "overlay"),
  publishedAt = "",
): Promise<{ inputs: string[]; filter: string }> {
  const base = `[0:v:0]scale=${s.width}:${s.height}:force_original_aspect_ratio=decrease,pad=${s.width}:${s.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${s.fps},format=yuv420p[base]`;
  if (!s.overlay.enabled)
    return { inputs: [], filter: base + ";[base]null[v]" };
  await mkdir(directory, { recursive: true });
  const layout = overlayLayout(s, publishedAt);
  const textFile = path.join(directory, "title.txt");
  await writeFile(textFile, layout.title);
  const dateFile = path.join(directory, "date.txt");
  await writeFile(dateFile, layout.date);
  const avatar = s.overlay.avatar
    ? await containedFile(path.join(c.MEDIA_DIR, "avatars"), s.overlay.avatar)
    : "";
  const style = `fontfile='${filterPath(c.FONT_FILE)}':expansion=none:fontcolor=white:bordercolor=black:borderw=${Math.max(1, Math.round(layout.fontSize / 12))}`;
  const draw = `drawtext=${style}:textfile='${filterPath(textFile)}':fontsize=${layout.fontSize}:line_spacing=${Math.ceil(layout.fontSize * .25)}:x=${layout.textX}:y=${layout.textY}` +
    (layout.date ? `,drawtext=${style}:textfile='${filterPath(dateFile)}':fontsize=${layout.dateSize}:x=${layout.textX}:y=${layout.textY + layout.dateOffset}` : "");
  const box = `[base]null[box]`;
  if (!avatar)
    return { inputs: [], filter: base + ";" + box + ";[box]" + draw + "[v]" };
  return {
    inputs: ["-loop", "1", "-i", avatar],
    filter:
      base +
      ";" +
      box +
      `;[2:v:0]scale=iw*sar:ih,setsar=1,scale=${s.overlay.avatarSize}:${s.overlay.avatarSize}:force_original_aspect_ratio=increase,crop=${s.overlay.avatarSize}:${s.overlay.avatarSize},format=rgba[avatar];[box][avatar]overlay=x=${layout.avatarX}:y=${layout.avatarY}:shortest=1[withAvatar];[withAvatar]` +
      draw +
      "[v]",
  };
}
