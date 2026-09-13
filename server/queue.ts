import { randomInt } from "node:crypto";
import type { PlaylistItem } from "./providers.js";
import type { Settings } from "./config.js";

export const LONG_VIDEO_SECONDS = 70 * 60;
export function isLongVideo(item: PlaylistItem) {
  return item.duration === null || item.duration > LONG_VIDEO_SECONDS;
}

export function prepareQueue(
  items: PlaylistItem[],
  settings: Settings,
  random = randomInt,
) {
  const words = settings.excludedWords.map((w) => w.toLocaleLowerCase());
  const result = items.filter(
    (i) => !words.some((w) => i.title.toLocaleLowerCase().includes(w)),
  );
  if (settings.shuffle)
    for (let i = result.length - 1; i > 0; i--) {
      const j = random(i + 1);
      [result[i], result[j]] = [result[j], result[i]];
    }
  if (settings.shuffle) {
    const long = result.filter(isLongVideo);
    const short = result.filter((item) => !isLongVideo(item));
    const spaced: PlaylistItem[] = [];
    while (long.length || short.length) {
      if (long.length) spaced.push(long.shift()!);
      if (short.length) spaced.push(short.shift()!);
    }
    result.splice(0, result.length, ...spaced);
  }
  return {
    items: result.map((item, position) => ({ ...item, position })),
    excluded: items.length - result.length,
  };
}
