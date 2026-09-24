import { randomInt } from "node:crypto";
import type { PlaylistItem } from "./providers.js";
import type { Settings } from "./config.js";

export const LONG_VIDEO_SECONDS = 70 * 60;
export const SHUFFLE_START_MAX_SECONDS = 15 * 60;
export const DOWNLOAD_LEAD_SECONDS = 2 * 60 * 60;
export const VERY_LONG_VIDEO_SECONDS = 3 * 60 * 60;

export function sameSeries(a: PlaylistItem | undefined, b: PlaylistItem) {
  return !!a?.seriesKey && a.seriesKey === b.seriesKey;
}

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
  if (sameSeries(previous, candidate)) return true;
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
  for (let index = 1; index < playable.length; index++) {
    const previous = playable[index - 1];
    const candidate = playable[index];
    if (sameSeries(previous, candidate)) continue;
    if (needsLongDownloadLead(candidate) && !canLeadLongDownload(previous))
      return "Videos over 3 hours must immediately follow a video of 2 hours or longer";
  }
  const longCount = playable.filter(isLongVideo).length;
  const canSeparateEveryLongVideo = longCount <= playable.length - longCount;
  if (
    canSeparateEveryLongVideo &&
    playable.some((item, index) => {
      const next = playable[(index + 1) % playable.length];
      return (
        !sameSeries(item, next) &&
        isLongVideo(item) &&
        isLongVideo(next) &&
        !(needsLongDownloadLead(next) && canLeadLongDownload(item))
      );
    })
  )
    return "Videos over 1 hour 10 minutes cannot be consecutive";
  return null;
}

type SeriesMatch = { key: string; index: number };

export function detectSeries(
  title: string,
  mode: Settings["filters"]["seriesMode"],
): SeriesMatch | null {
  if (mode === "off") return null;
  const patterns = [
    /\[(\d{1,4})\]/,
    /\((\d{1,4})\)/,
    /\b(?:episode|ep|part|pt)\.?\s*[-:#]?\s*(\d{1,4})\b/i,
    /#(\d{1,4})\b/,
  ];
  if (mode === "smart") patterns.push(/(?:^|[-:| ])(\d{1,3})\s*$/);
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (!match || match.index === undefined) continue;
    const index = Number(match[1]);
    if (!Number.isInteger(index)) continue;
    const key = (
      title.slice(0, match.index) +
      " " +
      title.slice(match.index + match[0].length)
    )
      .toLocaleLowerCase()
      .replace(/\b(?:episode|ep|part|pt)\.?\b/gi, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (key.length >= 3) return { key, index };
  }
  return null;
}

export function estimatedDownloadGb(item: PlaylistItem, settings: Settings) {
  if (item.duration === null) return null;
  const videoMbps =
    settings.height === 1080
      ? settings.fps === 60
        ? 12
        : 8
      : settings.fps === 60
        ? 7.5
        : 5;
  return (item.duration * (videoMbps + 0.16)) / 8 / 1000;
}

function durationBucket(seconds: number | null) {
  if (seconds === null) return "";
  if (seconds < 300) return "under5";
  if (seconds < 600) return "5to10";
  if (seconds < 1500) return "10to25";
  if (seconds < 2400) return "25to40";
  if (seconds < 3600) return "40to60";
  if (seconds < 7200) return "1to2h";
  if (seconds < 18000) return "2to5h";
  return "5hplus";
}

function filterReasons(item: PlaylistItem, settings: Settings) {
  const reasons: string[] = [];
  const filters = settings.filters;
  const title = item.title.toLocaleLowerCase();
  if (
    settings.excludedWords.some((word) =>
      title.includes(word.toLocaleLowerCase()),
    )
  )
    reasons.push("title words");
  if (filters.years.length) {
    const year = Number(item.publishedAt?.slice(0, 4));
    if (!filters.years.includes(year)) reasons.push("upload year");
  }
  if (
    filters.durations.length &&
    !filters.durations.includes(
      durationBucket(item.duration) as (typeof filters.durations)[number],
    )
  )
    reasons.push("duration");
  if (!filters.includeShorts && item.isShort)
    reasons.push("YouTube Shorts");
  if (filters.excludeRegionRestricted && item.regionRestricted)
    reasons.push("regional restriction");
  if (filters.excludeNotEmbeddable && item.embeddable === false)
    reasons.push("not embeddable");
  const size = estimatedDownloadGb(item, settings);
  if (
    filters.maxEstimatedSizeGb > 0 &&
    (size === null || size > filters.maxEstimatedSizeGb)
  )
    reasons.push("estimated size");
  if (
    filters.maxFailures > 0 &&
    (item.failureCount ?? 0) >= filters.maxFailures
  )
    reasons.push("failure history");
  return reasons;
}

function seriesBlocks(items: PlaylistItem[], limit: number) {
  const blocks: PlaylistItem[][] = [];
  const deferred: PlaylistItem[][] = [];
  const bySeries = new Map<string, PlaylistItem[]>();
  for (const item of items)
    if (item.seriesKey) {
      const group = bySeries.get(item.seriesKey) ?? [];
      group.push(item);
      bySeries.set(item.seriesKey, group);
    }
  const emitted = new Set<string>();
  for (const item of items) {
    if (!item.seriesKey) {
      blocks.push([item]);
      continue;
    }
    if (emitted.has(item.seriesKey)) continue;
    emitted.add(item.seriesKey);
    const group = (bySeries.get(item.seriesKey) ?? [item]).sort(
      (a, b) => (a.seriesIndex ?? 0) - (b.seriesIndex ?? 0),
    );
    const chunks = Array.from(
      { length: Math.ceil(group.length / limit) },
      (_, index) => group.slice(index * limit, (index + 1) * limit),
    );
    blocks.push(chunks[0]);
    deferred.push(...chunks.slice(1));
  }
  return [...blocks, ...deferred];
}

function weightedBlockIndex(
  blocks: PlaylistItem[][],
  candidates: number[],
  random: (max: number) => number,
) {
  const minCount = Math.min(
    ...candidates.map((index) => blocks[index][0].playCount ?? 0),
  );
  const weights = candidates.map((index) => {
    const item = blocks[index][0];
    const relative = Math.max(0, (item.playCount ?? 0) - minCount);
    return 1 / (1 + relative * .7 + (item.selectionPenalty ?? 0) * .45);
  });
  let cursor = (random(1_000_000) / 1_000_000) *
    weights.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < candidates.length; index++) {
    cursor -= weights[index];
    if (cursor <= 0) return candidates[index];
  }
  return candidates.at(-1) ?? 0;
}

export function prepareQueue(
  items: PlaylistItem[],
  settings: Settings,
  random = randomInt,
) {
  const detected = items.map((item) => {
    const series = detectSeries(item.title, settings.filters.seriesMode);
    return {
      ...item,
      seriesKey: series?.key ?? "",
      seriesIndex: series?.index ?? null,
    };
  });
  const groups = new Map<string, Set<number>>();
  for (const item of detected)
    if (item.seriesKey) {
      const indexes = groups.get(item.seriesKey) ?? new Set<number>();
      if (item.seriesIndex !== null) indexes.add(item.seriesIndex);
      groups.set(item.seriesKey, indexes);
    }
  for (const item of detected)
    if (item.seriesKey && (groups.get(item.seriesKey)?.size ?? 0) < 2) {
      item.seriesKey = "";
      item.seriesIndex = null;
    }

  const individualReasons = new Map(
    detected.map((item) => [item.id, filterReasons(item, settings)]),
  );
  const includedSeries = new Set(
    detected
      .filter(
        (item) =>
          item.seriesKey &&
          (individualReasons.get(item.id)?.length ?? 0) === 0,
      )
      .map((item) => item.seriesKey),
  );
  const reasons: Record<string, number> = {};
  const result = detected.filter((item) => {
    const itemReasons = individualReasons.get(item.id) ?? [];
    const safetyBlocked = itemReasons.some(
      (reason) =>
        reason === "regional restriction" ||
        reason === "not embeddable" ||
        reason === "YouTube Shorts",
    );
    const included =
      itemReasons.length === 0 ||
      (!safetyBlocked &&
        !!item.seriesKey &&
        includedSeries.has(item.seriesKey));
    if (!included)
      for (const reason of itemReasons)
        reasons[reason] = (reasons[reason] ?? 0) + 1;
    return included;
  });

  let blocks = seriesBlocks(result, settings.filters.seriesLimit);
  if (settings.shuffle) {
    const ordered: PlaylistItem[][] = [];
    while (blocks.length) {
      const previous = ordered.at(-1)?.at(-1);
      let candidates = blocks.map((_, index) => index);
      if (ordered.flat().length < 2) {
        const opening = candidates.filter((index) =>
          canStartShuffledQueue(blocks[index][0]),
        );
        if (opening.length) candidates = opening;
      } else if (previous) {
        if (previous.seriesKey) {
          const afterSeries = candidates.filter(
            (index) => blocks[index][0].seriesKey !== previous.seriesKey,
          );
          if (afterSeries.length) candidates = afterSeries;
        }
        const valid = candidates.filter((index) =>
          canFollowInShuffledQueue(previous, blocks[index][0]),
        );
        if (valid.length) candidates = valid;
        const opposite = candidates.filter(
          (index) =>
            isLongVideo(blocks[index][0]) !== isLongVideo(previous),
        );
        if (opposite.length) candidates = opposite;
      }
      const minimum = Math.min(
        ...candidates.map((index) => blocks[index][0].playCount ?? 0),
      );
      const next = weightedBlockIndex(blocks, candidates, random);
      const selected = blocks[next][0];
      for (const block of blocks)
        block[0].selectionPenalty = Math.max(
          0,
          (block[0].selectionPenalty ?? 0) * .85,
        );
      if ((selected.playCount ?? 0) > minimum)
        selected.selectionPenalty = (selected.selectionPenalty ?? 0) + 1;
      ordered.push(blocks.splice(next, 1)[0]);
    }
    blocks = ordered;
  }

  const flattened = blocks.flat();
  return {
    items: flattened.map((item, position) => ({ ...item, position })),
    excluded: items.length - flattened.length,
    reasons,
    detectedSeries: new Set(
      flattened.filter((item) => item.seriesKey).map((item) => item.seriesKey),
    ).size,
    penalties: Object.fromEntries(
      flattened.map((item) => [item.videoId, item.selectionPenalty ?? 0]),
    ),
  };
}
