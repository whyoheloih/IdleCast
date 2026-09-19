import { randomInt } from "node:crypto";
import type { PlaylistItem } from "./providers.js";
import type { Settings } from "./config.js";

export const LONG_VIDEO_SECONDS = 70 * 60;
export const SHUFFLE_START_MAX_SECONDS = 15 * 60;
export function isLongVideo(item: PlaylistItem) {
  return item.duration === null || item.duration > LONG_VIDEO_SECONDS;
}

export function canStartShuffledQueue(item: PlaylistItem) {
  return (
    item.available &&
    item.duration !== null &&
    item.duration <= SHUFFLE_START_MAX_SECONDS
  );
}

export function shuffleOrderError(items: PlaylistItem[]) {
  const playable = items.filter((item) => item.available);
  if (!playable.length) return null;
  if (
    playable.some(canStartShuffledQueue) &&
    !canStartShuffledQueue(playable[0])
  )
    return "The first playable shuffled video must be 15 minutes or shorter";
  const longCount = playable.filter(isLongVideo).length;
  const canSeparateEveryLongVideo = longCount <= playable.length - longCount;
  if (
    canSeparateEveryLongVideo &&
    playable.some(
      (item, index) =>
        isLongVideo(item) &&
        isLongVideo(playable[(index + 1) % playable.length]),
    )
  )
    return "Videos over 1 hour 10 minutes cannot be consecutive";
  return null;
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
    const starter = short.findIndex(canStartShuffledQueue);
    if (starter >= 0) spaced.push(short.splice(starter, 1)[0]);
    while (long.length || short.length) {
      if (long.length && (spaced.length === 0 || !isLongVideo(spaced.at(-1)!)))
        spaced.push(long.shift()!);
      if (short.length) spaced.push(short.shift()!);
      else if (long.length) spaced.push(long.shift()!);
    }
    result.splice(0, result.length, ...spaced);
  }
  return {
    items: result.map((item, position) => ({ ...item, position })),
    excluded: items.length - result.length,
  };
}
