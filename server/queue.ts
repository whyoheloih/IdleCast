import { randomInt } from "node:crypto";
import type { PlaylistItem } from "./providers.js";
import type { Settings } from "./config.js";

export const LONG_VIDEO_SECONDS = 70 * 60;
export const SHUFFLE_START_MAX_SECONDS = 15 * 60;
export const DOWNLOAD_LEAD_SECONDS = 2 * 60 * 60;
export const VERY_LONG_VIDEO_SECONDS = 3 * 60 * 60;

export function isLongVideo(item: PlaylistItem) {
  return item.duration === null || item.duration > LONG_VIDEO_SECONDS;
}

export function needsLongDownloadLead(item: PlaylistItem) {
  return (
    item.available &&
    item.duration !== null &&
    item.duration > VERY_LONG_VIDEO_SECONDS
  );
}

export function canLeadLongDownload(item: PlaylistItem) {
  return (
    item.available &&
    item.duration !== null &&
    item.duration >= DOWNLOAD_LEAD_SECONDS
  );
}

export function canStartShuffledQueue(item: PlaylistItem) {
  return (
    item.available &&
    item.duration !== null &&
    item.duration <= SHUFFLE_START_MAX_SECONDS
  );
}

export function canFollowInShuffledQueue(
  previous: PlaylistItem,
  candidate: PlaylistItem,
) {
  if (needsLongDownloadLead(candidate))
    return canLeadLongDownload(previous);
  return !(isLongVideo(previous) && isLongVideo(candidate));
}

export function shuffleOrderError(items: PlaylistItem[]) {
  const playable = items.filter((item) => item.available);
  if (!playable.length) return null;
  const shortOpeningCount = Math.min(2, playable.length);

  if (
    playable
      .slice(0, shortOpeningCount)
      .some((item) => !canStartShuffledQueue(item))
  )
    return "The first two playable shuffled videos must be 15 minutes or shorter";
  if (needsLongDownloadLead(playable[0]))
    return "Videos over 3 hours must immediately follow a video of 2 hours or longer";
  for (let index = 1; index < playable.length; index++) {
    const previous = playable[index - 1];
    const candidate = playable[index];
    if (
      needsLongDownloadLead(candidate) &&
      !canLeadLongDownload(previous)
    )
      return "Videos over 3 hours must immediately follow a video of 2 hours or longer";
  }
  const longCount = playable.filter(isLongVideo).length;
  const canSeparateEveryLongVideo = longCount <= playable.length - longCount;
  if (
    canSeparateEveryLongVideo &&
    playable.some((item, index) => {
      const next = playable[(index + 1) % playable.length];
      return (
        isLongVideo(item) &&
        isLongVideo(next) &&
        !(
          needsLongDownloadLead(next) &&
          canLeadLongDownload(item)
        )
      );
    })
  )
    return "Videos over 1 hour 10 minutes cannot be consecutive";
  return null;
}

export function prepareQueue(
  items: PlaylistItem[],
  settings: Settings,
  random = randomInt,
) {
  const words = settings.excludedWords.map((word) =>
    word.toLocaleLowerCase(),
  );
  const result = items.filter(
    (item) =>
      !words.some((word) =>
        item.title.toLocaleLowerCase().includes(word),
      ),
  );
  if (settings.shuffle)
    for (let index = result.length - 1; index > 0; index--) {
      const other = random(index + 1);
      [result[index], result[other]] = [result[other], result[index]];
    }
  if (settings.shuffle) {
    const pool = result.filter((item) => item.available);
    const unavailable = result.filter((item) => !item.available);
    const ordered: PlaylistItem[] = [];
    for (let opening = 0; opening < 2; opening++) {
      const starter = pool.findIndex(canStartShuffledQueue);
      if (starter < 0) break;
      ordered.push(pool.splice(starter, 1)[0]);
    }
    while (pool.length) {
      const previous = ordered.at(-1);
      let next = previous
        ? -1
        : pool.findIndex((item) => !needsLongDownloadLead(item));
      if (previous && canLeadLongDownload(previous))
        next = pool.findIndex(needsLongDownloadLead);
      if (next < 0)
        next = pool.findIndex(
          (candidate) =>
            !previous ||
            canFollowInShuffledQueue(previous, candidate),
        );
      if (next < 0) next = 0;
      ordered.push(pool.splice(next, 1)[0]);
    }
    result.splice(0, result.length, ...ordered, ...unavailable);
  }
  return {
    items: result.map((item, position) => ({ ...item, position })),
    excluded: items.length - result.length,
  };
}
