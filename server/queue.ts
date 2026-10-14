import { randomInt } from "node:crypto";
import type { PlaylistItem } from "./providers.js";
import type { Settings } from "./config.js";

export const LONG_VIDEO_SECONDS = 70 * 60;
export const SHUFFLE_START_MAX_SECONDS = 15 * 60;
export const STARTUP_DOWNLOAD_COUNT = 5;
export const STARTUP_DOWNLOAD_MAX_SECONDS = 30 * 60;
export const DOWNLOAD_LEAD_SECONDS = 2 * 60 * 60;
export const VERY_LONG_VIDEO_SECONDS = 3 * 60 * 60;
export const SERIES_BLOCK_GAP = 5;

export function canStartSeriesBlock(
  candidate: Pick<PlaylistItem, "seriesKey">,
  activeSeriesKey: string,
  ordinaryVideosSinceSeries: number,
) {
  if (!candidate.seriesKey) return true;
  const continuingCurrentBlock =
    candidate.seriesKey === activeSeriesKey && ordinaryVideosSinceSeries === 0;
  return continuingCurrentBlock || ordinaryVideosSinceSeries >= SERIES_BLOCK_GAP;
}

export function seriesStateAfterActivation(
  item: Pick<PlaylistItem, "seriesKey" | "duration">,
  activeSeriesKey: string,
  ordinaryVideosSinceSeries: number,
  activeSeriesDuration: number,
) {
  if (item.seriesKey) {
    const continuing =
      item.seriesKey === activeSeriesKey && ordinaryVideosSinceSeries === 0;
    const duration = Math.max(0, item.duration ?? 0);
    return {
      activeSeriesKey: item.seriesKey,
      ordinaryVideosSinceSeries: 0,
      activeSeriesDuration: continuing
        ? activeSeriesDuration + duration
        : duration,
    };
  }
  if (!activeSeriesKey)
    return {
      activeSeriesKey: "",
      ordinaryVideosSinceSeries: SERIES_BLOCK_GAP,
      activeSeriesDuration: 0,
    };
  const ordinary = Math.min(
    SERIES_BLOCK_GAP,
    ordinaryVideosSinceSeries + 1,
  );
  return {
    activeSeriesKey: ordinary >= SERIES_BLOCK_GAP ? "" : activeSeriesKey,
    ordinaryVideosSinceSeries: ordinary,
    activeSeriesDuration: ordinary >= SERIES_BLOCK_GAP ? 0 : activeSeriesDuration,
  };
}

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

export function canStartBufferedQueue(item: PlaylistItem) {
  return (
    item.available &&
    item.duration !== null &&
    item.duration <= STARTUP_DOWNLOAD_MAX_SECONDS
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
  const bufferedOpeningCount = Math.min(STARTUP_DOWNLOAD_COUNT, playable.length);
  if (
    playable
      .slice(0, bufferedOpeningCount)
      .some((item) => !canStartBufferedQueue(item))
  )
    return "The first five playable shuffled videos must be 30 minutes or shorter";
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

type SeriesMatch = { key: string; index: number; explicit?: boolean };

const numberWords: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
function wordsToNumber(value: string): number | null {
  if (/^\d{1,4}$/.test(value.trim())) return Number(value.trim());
  let total = 0, current = 0, found = false;
  for (const word of value.toLocaleLowerCase().split(/[\s-]+/)) {
    if (word === "and") continue;
    if (word in numberWords) { current += numberWords[word]; found = true; continue; }
    if (word === "hundred") { current = Math.max(1, current) * 100; found = true; continue; }
    if (word === "thousand") { total += Math.max(1, current) * 1000; current = 0; found = true; continue; }
    return null;
  }
  const result = total + current;
  return found && result >= 0 && result <= 9999 ? result : null;
}
function seriesKey(value: string) {
  return value.toLocaleLowerCase().replace(/\b(?:episode|ep|part|pt)\.?\b/gi, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}
export function detectSeries(
  title: string,
  mode: Settings["filters"]["seriesMode"],
): SeriesMatch | null {
  if (mode === "off") return null;

  // This is IdleCast's authoritative explicit series format:
  // "video title | series name [episode number]". The varying video title
  // never participates in the key, so every matching suffix groups together.
  const explicit = title.match(
    /\|\s*([^|]+?)\s*\[\s*(?:(?:episode|ep\.?)\s*)?#?\s*(\d{1,4})\s*\]\s*$/i,
  );
  if (explicit) {
    const key = seriesKey(explicit[1]);
    if (key.length >= 3)
      return { key, index: Number(explicit[2]), explicit: true };
  }

  // Preserve the older bracket-only form for existing libraries.
  const bracket = title.match(/\[(\d{1,4})\]\s*$/);
  if (bracket && bracket.index !== undefined) {
    const key = seriesKey(title.slice(0, bracket.index));
    if (key.length >= 3) return { key, index: Number(bracket[1]) };
  }

  const day = title.match(/\bday\s+([a-z][a-z\s-]*|\d{1,4})\s*$/i);
  if (day && day.index !== undefined) {
    const index = wordsToNumber(day[1]);
    const key = seriesKey(title.slice(0, day.index));
    if (index !== null && key.length >= 3) return { key, index };
  }

  const patterns = [
    /\((\d{1,4})\)\s*$/,
    /\b(?:episode|ep|part|pt)\.?\s*[-:#]?\s*(\d{1,4})\b/i,
    /#(\d{1,4})\b/,
  ];
  if (mode === "smart") patterns.push(/(?:^|[-:| ])(\d{1,3})\s*$/);
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (!match || match.index === undefined) continue;
    const index = Number(match[1]);
    if (!Number.isInteger(index)) continue;
    const key = seriesKey(title.slice(0, match.index) + " " + title.slice(match.index + match[0].length));
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

function filterReasons(item: PlaylistItem, settings: Settings) {
  const reasons: string[] = [];
  const filters = settings.filters;
  const local = item.sourceType === "local";
  const title = item.title.toLocaleLowerCase();
  if (
    settings.excludedWords.some((word) =>
      title.includes(word.toLocaleLowerCase()),
    )
  )
    reasons.push("title words");
  const year = Number(item.publishedAt?.slice(0, 4));
  const maximumYear = filters.yearMax ?? new Date().getFullYear();
  if (!local && (!Number.isInteger(year) || year < filters.yearMin || year > maximumYear))
    reasons.push("upload year");
  if (!local && item.liveStatus === "live") reasons.push("current livestream");
  if (!local && item.liveStatus === "upcoming") reasons.push("upcoming livestream");
  if (!local && item.liveStatus === "past" && !filters.includePastLivestreams)
    reasons.push("past livestream");
  if (
    item.duration === null ||
    item.duration < filters.durationMinSeconds ||
    (filters.durationMaxSeconds !== null && item.duration > filters.durationMaxSeconds)
  )
    reasons.push("duration");
  if (!local && !filters.includeShorts && item.isShort)
    reasons.push("YouTube Shorts");
  if (!local && filters.excludeRegionRestricted && item.regionRestricted)
    reasons.push("regional restriction");
  if (!local && filters.excludeNotEmbeddable && item.embeddable === false)
    reasons.push("not embeddable");
  const size = estimatedDownloadGb(item, settings);
  if (
    !local &&
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
  const bySeries = new Map<string, PlaylistItem[]>();
  for (const item of items)
    if (item.seriesKey) {
      const group = bySeries.get(item.seriesKey) ?? [];
      group.push(item);
      bySeries.set(item.seriesKey, group);
    }

  const emitted = new Set<string>();
  for (const trigger of items) {
    if (emitted.has(trigger.id)) continue;
    if (!trigger.seriesKey) {
      emitted.add(trigger.id);
      blocks.push([trigger]);
      continue;
    }
    const continuation = (bySeries.get(trigger.seriesKey) ?? [trigger])
      .filter((item) => !emitted.has(item.id))
      .sort(
        (a, b) =>
          (a.seriesIndex ?? Number.MAX_SAFE_INTEGER) -
            (b.seriesIndex ?? Number.MAX_SAFE_INTEGER) ||
          a.position - b.position,
      )
      .slice(0, limit);
    const block = continuation.length ? continuation : [trigger];
    for (const item of block) emitted.add(item.id);
    blocks.push(block);
  }
  return blocks;
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
    const series = ["live", "upcoming"].includes(item.liveStatus ?? "none")
      ? null
      : detectSeries(item.title, settings.filters.seriesMode);
    return {
      ...item,
      seriesKey: series?.key ?? "",
      seriesIndex: series?.index ?? null,
      _seriesExplicit: series?.explicit ?? false,
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
    if (
      item.seriesKey &&
      !item._seriesExplicit &&
      (groups.get(item.seriesKey)?.size ?? 0) < 2
    ) {
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
        reason === "YouTube Shorts" ||
        reason === "current livestream" ||
        reason === "past livestream" ||
        reason === "upcoming livestream",
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
    let seriesBlockQueued = false;
    let ordinaryBlocksSinceSeries = SERIES_BLOCK_GAP;
    while (blocks.length) {
      const previousBlock = ordered.at(-1);
      const previousItem = previousBlock?.at(-1);
      const previous = previousItem && previousBlock?.[0].seriesKey
        ? {
            ...previousItem,
            duration: previousBlock.reduce(
              (total, entry) => total + Math.max(0, entry.duration ?? 0),
              0,
            ),
          }
        : previousItem;
      let candidates = blocks.map((_, index) => index);
      const queuedCount = ordered.reduce((count, block) => count + block.length, 0);
      if (queuedCount < STARTUP_DOWNLOAD_COUNT) {
        const remaining = STARTUP_DOWNLOAD_COUNT - queuedCount;
        const opening = candidates.filter((index) =>
          blocks[index].slice(0, remaining).every(canStartBufferedQueue),
        );
        if (opening.length) candidates = opening;
      }
      if (queuedCount < 2) {
        const remaining = 2 - queuedCount;
        const opening = candidates.filter((index) =>
          blocks[index].slice(0, remaining).every(canStartShuffledQueue),
        );
        if (opening.length) candidates = opening;
      }
      if (seriesBlockQueued && ordinaryBlocksSinceSeries < SERIES_BLOCK_GAP) {
        const ordinary = candidates.filter(
          (index) => !blocks[index][0].seriesKey,
        );
        if (ordinary.length) candidates = ordinary;
      }
      if (queuedCount >= 2 && previous) {
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
        // A 3+ hour item needs the full preceding 2+ hour slot for its
        // download. Consume that prepared pairing before category alternation
        // can spend the lead slot on another candidate.
        const requiresLead = canLeadLongDownload(previous)
          ? candidates.filter((index) =>
              needsLongDownloadLead(blocks[index][0]),
            )
          : [];
        if (requiresLead.length) candidates = requiresLead;
        else {
          const opposite = candidates.filter(
            (index) =>
              isLongVideo(blocks[index][0]) !== isLongVideo(previous),
          );
          if (opposite.length) candidates = opposite;
        }
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
      const selectedBlock = blocks.splice(next, 1)[0];
      ordered.push(selectedBlock);
      if (selectedBlock[0].seriesKey) {
        seriesBlockQueued = true;
        ordinaryBlocksSinceSeries = 0;
      } else if (seriesBlockQueued) {
        ordinaryBlocksSinceSeries = Math.min(
          SERIES_BLOCK_GAP,
          ordinaryBlocksSinceSeries + 1,
        );
      }
    }
    blocks = ordered;
  }

  const flattened = blocks.flat();
  return {
    items: flattened.map((entry, position) => {
      const { _seriesExplicit: _ignored, ...item } = entry as PlaylistItem & {
        _seriesExplicit?: boolean;
      };
      return { ...item, position };
    }),
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
