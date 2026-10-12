import { stat } from "node:fs/promises";
import type { Marathon, MarathonEntry, Store } from "./db.js";
import type { Engine } from "./engine.js";

export const MARATHON_TIME_ZONE = "America/Denver";
export const MARATHON_SAFETY_MARGIN_SECONDS = 5 * 60;
export type ScheduleMethod = "start" | "end";
export type QueueCommitment = { entryId: string; title: string; remainingSeconds: number };
export type ScheduleConstraints = {
  now: number;
  timeZone: typeof MARATHON_TIME_ZONE;
  runtimeSeconds: number;
  earliestStart: number | null;
  earliestEnd: number | null;
  earliestStartLocal: string | null;
  earliestEndLocal: string | null;
  commitments: QueueCommitment[];
  boundaryEntryId: string | null;
  validationErrors: string[];
  sourceAvailable: boolean;
};
export type SchedulePreview = ScheduleConstraints & {
  method: ScheduleMethod;
  selectedLocalTime: string;
  requestedTime: number | null;
  calculatedStart: number | null;
  calculatedEnd: number | null;
  calculatedStartLocal: string | null;
  calculatedEndLocal: string | null;
  zoneAbbreviation: string | null;
  estimatedDelaySeconds: number;
  valid: boolean;
};

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: MARATHON_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23",
});
function partsAt(timestamp: number) {
  return Object.fromEntries(formatter.formatToParts(new Date(timestamp)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}
export function denverLocalToUtc(value: string): number {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error("Use a Mountain Time date and time in YYYY-MM-DDTHH:mm format");
  const wanted = { year: +match[1], month: +match[2], day: +match[3], hour: +match[4], minute: +match[5], second: +(match[6] ?? 0) };
  const nominal = Date.UTC(wanted.year, wanted.month - 1, wanted.day, wanted.hour, wanted.minute, wanted.second);
  const matches: number[] = [];
  for (let offsetHours = -8; offsetHours <= -5; offsetHours++) {
    const candidate = nominal - offsetHours * 3600000;
    const actual = partsAt(candidate);
    if (Object.entries(wanted).every(([key, number]) => actual[key] === number)) matches.push(candidate);
  }
  if (!matches.length) throw new Error("That Mountain Time does not exist because of the daylight-saving transition");
  if (matches.length > 1) throw new Error("That Mountain Time is ambiguous because of the daylight-saving transition; choose a different time");
  return matches[0];
}
export function denverZoneAbbreviation(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", { timeZone: MARATHON_TIME_ZONE, timeZoneName: "short" }).formatToParts(new Date(timestamp)).find((part) => part.type === "timeZoneName")?.value ?? null;
}
export function utcToDenverLocal(timestamp: number) {
  const p = partsAt(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}
function exactRuntime(entries: MarathonEntry[]) {
  if (!entries.length || entries.some((entry) => !Number.isFinite(entry.duration) || Number(entry.duration) <= 0)) return null;
  return entries.reduce((sum, entry) => sum + Number(entry.duration), 0);
}
export async function sourceAvailability(marathon: Marathon, entries: MarathonEntry[]) {
  if (marathon.sourceType !== "local") return { available: true, missing: [] as string[] };
  const missing: string[] = [];
  for (const entry of entries) {
    if (!entry.localPath || !(await stat(entry.localPath).then((item) => item.isFile()).catch(() => false))) missing.push(entry.title);
  }
  return { available: missing.length === 0, missing };
}
export async function scheduleConstraints(store: Store, engine: Engine, marathonId: string): Promise<ScheduleConstraints> {
  const record = store.marathon(marathonId);
  if (!record) throw new Error("Marathon not found");
  const runtime = exactRuntime(record.entries);
  const handoff = engine.marathonHandoffConstraints();
  const source = await sourceAvailability(record.marathon, record.entries);
  const errors: string[] = [];
  if (runtime === null) errors.push("Marathon snapshot is incomplete because one or more entries has no exact duration");
  if (!handoff.safe) errors.push(handoff.reason ?? "The normal playback boundary cannot be calculated safely");
  if (!source.available) errors.push(`Marathon source is unavailable: ${source.missing.slice(0, 3).join(", ")}${source.missing.length > 3 ? ` and ${source.missing.length - 3} more` : ""}`);
  const earliestStart = runtime !== null && handoff.safe ? handoff.earliestStart : null;
  return {
    now: Date.now(), timeZone: MARATHON_TIME_ZONE, runtimeSeconds: runtime ?? record.marathon.totalRuntime,
    earliestStart, earliestEnd: earliestStart === null || runtime === null ? null : earliestStart + runtime * 1000,
    commitments: handoff.commitments, boundaryEntryId: handoff.commitments.at(-1)?.entryId ?? null,
    validationErrors: errors, sourceAvailable: source.available,
    earliestStartLocal: earliestStart === null ? null : utcToDenverLocal(earliestStart),
    earliestEndLocal: earliestStart === null || runtime === null ? null : utcToDenverLocal(earliestStart + runtime * 1000),
  };
}
export async function previewSchedule(store: Store, engine: Engine, marathonId: string, method: ScheduleMethod, localDateTime: string): Promise<SchedulePreview> {
  const constraints = await scheduleConstraints(store, engine, marathonId);
  const errors = [...constraints.validationErrors];
  let requestedTime: number | null = null;
  try { requestedTime = denverLocalToUtc(localDateTime); } catch (error) { errors.push(error instanceof Error ? error.message : "Invalid Mountain Time"); }
  let calculatedStart: number | null = null, calculatedEnd: number | null = null;
  if (requestedTime !== null) {
    if (method === "start") { calculatedStart = requestedTime; calculatedEnd = requestedTime + constraints.runtimeSeconds * 1000; }
    else { calculatedEnd = requestedTime; calculatedStart = requestedTime - constraints.runtimeSeconds * 1000; }
    if (constraints.earliestStart !== null && calculatedStart < constraints.earliestStart)
      errors.push(method === "start" ? `Requested start is too early; earliest allowed start is ${utcToDenverLocal(constraints.earliestStart)} Mountain Time` : `Requested end is too early; earliest allowed end is ${utcToDenverLocal(constraints.earliestEnd!)} Mountain Time`);
  }
  return { ...constraints, method, selectedLocalTime: localDateTime, requestedTime, calculatedStart, calculatedEnd, calculatedStartLocal: calculatedStart === null ? null : utcToDenverLocal(calculatedStart), calculatedEndLocal: calculatedEnd === null ? null : utcToDenverLocal(calculatedEnd), zoneAbbreviation: requestedTime === null ? null : denverZoneAbbreviation(requestedTime), estimatedDelaySeconds: calculatedStart === null || constraints.earliestStart === null ? 0 : Math.max(0, Math.ceil((constraints.earliestStart - calculatedStart) / 1000)), valid: errors.length === 0, validationErrors: errors };
}

export async function currentSchedule(store: Store, engine: Engine) {
  const record = store.controllingMarathon();
  if (!record) return null;
  const marathon = record.marathon;
  const completed = store.completedQueueEntriesSince(marathon.scheduleUpdatedAt ?? marathon.createdAt);
  const commitments = marathon.committedQueue.map((entry) => ({ ...entry, completed: completed.has(entry.entryId) }));
  const remainingCommitments = commitments.filter((entry) => !entry.completed);
  const queueIds = new Set(store.all().map((item) => item.id));
  const unreconciled = marathon.status === "scheduled" ? remainingCommitments.filter((entry) => entry.entryId !== engine.current?.id && !queueIds.has(entry.entryId)) : [];
  const now = Date.now();
  const requestedStart = marathon.scheduledStart;
  const scheduleReached = requestedStart !== null && now >= requestedStart;
  const hasCommittedNormal = !["stopped", "buffering", "starting", "waiting"].includes(engine.state) && !!engine.current;
  const activeOutsideBoundary = marathon.status === "scheduled" && hasCommittedNormal && !commitments.some((entry) => entry.entryId === engine.current?.id);
  const handoffSatisfied = remainingCommitments.length === 0 && unreconciled.length === 0 && !activeOutsideBoundary;
  const source = await sourceAvailability(marathon, record.entries);
  const validationErrors: string[] = [];
  if (exactRuntime(record.entries) === null) validationErrors.push("Marathon snapshot is incomplete because one or more entries has no exact duration");
  if (!source.available) validationErrors.push("Marathon source is currently unavailable");
  if (unreconciled.length) validationErrors.push("Marathon queue boundary reconciliation failed for: " + unreconciled.map((entry) => entry.title).join(", "));
  return {
    marathon,
    entries: record.entries,
    timeZone: MARATHON_TIME_ZONE,
    selectedLocalTime: marathon.requestedTime ? utcToDenverLocal(marathon.requestedTime) : null,
    calculatedStartLocal: marathon.scheduledStart ? utcToDenverLocal(marathon.scheduledStart) : null,
    calculatedEndLocal: marathon.scheduledEnd ? utcToDenverLocal(marathon.scheduledEnd) : null,
    zoneAbbreviation: marathon.requestedTime ? denverZoneAbbreviation(marathon.requestedTime) : null,
    commitments,
    remainingCommitments,
    activeOutsideBoundary,
    scheduleReached,
    handoffSatisfied,
    canActivate: marathon.status === "scheduled" && scheduleReached && handoffSatisfied && source.available,
    estimatedDelaySeconds: marathon.status === "scheduled" && scheduleReached && !handoffSatisfied ? Math.max(0, Math.ceil((now - requestedStart!) / 1000)) : 0,
    diagnosticCode: unreconciled.length ? "IC-MAR-007" : !source.available ? "IC-MAR-002" : exactRuntime(record.entries) === null ? "IC-MAR-003" : marathon.status === "scheduled" && scheduleReached && !handoffSatisfied ? "IC-MAR-004" : null,
    validationErrors,
    sourceAvailable: source.available,
  };
}