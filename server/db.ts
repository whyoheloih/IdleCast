import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { defaults, settingsSchema, type Settings } from "./config.js";
import type { PlaylistItem } from "./providers.js";
import { DIAGNOSTIC_REGISTRY, type DiagnosticRecord } from "./diagnostics.js";
export type MarathonSourceType = "youtube" | "local";
export type MarathonStatus = "draft" | "scheduled" | "active" | "ending" | "completed" | "ended_early" | "cancelled" | "failed";
export type Marathon = {
  id: string;
  name: string;
  sourceType: MarathonSourceType;
  sourceIdentity: string;
  status: MarathonStatus;
  schedulingMode: "manual" | "scheduled";
  scheduledStart: number | null;
  scheduledEnd: number | null;
  actualStart: number | null;
  actualEnd: number | null;
  normalQueueBoundary: string | null;
  currentPosition: number;
  completedEntries: number;
  failedEntries: number;
  totalEntries: number;
  totalRuntime: number;
  createdAt: number;
  manualEnding: boolean;
  schedulingMethod: "start" | "end" | null;
  requestedTime: number | null;
  committedQueue: Array<{ entryId: string; title: string; remainingSeconds: number }>;
  scheduleUpdatedAt: number | null;
  currentEntryId: string | null;
  currentEntryState: "preparing" | "playing" | "interrupted" | null;
  lastCompletedEntryId: string | null;
  sourceLabel: string;
  earlyEndRequestedAt: number | null;
};
export type MarathonEntry = {
  id: string;
  marathonId: string;
  position: number;
  sourceType: MarathonSourceType;
  localIdentity: string | null;
  localPath: string | null;
  youtubeVideoId: string | null;
  title: string;
  duration: number | null;
  metadata: Record<string, unknown>;
  playbackState: "pending" | "preparing" | "playing" | "interrupted" | "completed" | "failed" | "skipped";
  startedAt: number | null;
  completedAt: number | null;
  lastError: string | null;
};
export type PlaybackHistoryItem = {
  id: number;
  startedAt: number;
  endedAt: number | null;
  videoId: string;
  title: string;
  channel: string;
  duration: number | null;
  status: "playing" | "played" | "skipped" | "failed" | "stopped" | "interrupted";
  watchedSeconds: number;
  queueEntryId?: string | null;
};
export type StoredItem = PlaylistItem & {
  failures: number;
  retryAt: number;
  error: string | null;
  seriesKey: string;
  seriesIndex: number | null;
  liveStatus: "none" | "live" | "upcoming" | "past";
};
export class Store {
  db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.migrate();
    this.db.prepare("UPDATE playback_history SET status='interrupted',endedAt=? WHERE status='playing'").run(Date.now());
    this.recoverMarathonPlayback();
  }
  private migrate() {
    const version = (this.db.prepare("PRAGMA user_version").get() as any)
      .user_version;
    if (version > 9)
      throw new Error("Database is newer than this version of IdleCast");
    if (version === 0)
      this.db.exec(`
   BEGIN IMMEDIATE;
   CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE items(id TEXT PRIMARY KEY,videoId TEXT NOT NULL,position INTEGER NOT NULL,title TEXT NOT NULL,channel TEXT NOT NULL,thumbnail TEXT NOT NULL,available INTEGER NOT NULL,duration REAL,liveStatus TEXT NOT NULL DEFAULT 'none',failures INTEGER NOT NULL DEFAULT 0,retryAt INTEGER NOT NULL DEFAULT 0,error TEXT,seriesKey TEXT NOT NULL DEFAULT '',seriesIndex INTEGER);
   CREATE INDEX items_order ON items(position,id);
   CREATE TABLE logs(id INTEGER PRIMARY KEY AUTOINCREMENT,time INTEGER NOT NULL,level TEXT NOT NULL,message TEXT NOT NULL);
   CREATE TABLE sessions(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
   PRAGMA user_version=3;
   COMMIT;`);
    if (version === 1)
      this.db.exec(
        "BEGIN IMMEDIATE; ALTER TABLE items ADD COLUMN seriesKey TEXT NOT NULL DEFAULT ''; ALTER TABLE items ADD COLUMN seriesIndex INTEGER; PRAGMA user_version=2; COMMIT;",
      );
    if (version === 1 || version === 2)
      this.db.exec(
        "BEGIN IMMEDIATE; ALTER TABLE items ADD COLUMN liveStatus TEXT NOT NULL DEFAULT 'none'; PRAGMA user_version=3; COMMIT;",
      );
    if (version <= 3)
      this.db.exec(
        "BEGIN IMMEDIATE; ALTER TABLE items ADD COLUMN publishedAt TEXT NOT NULL DEFAULT ''; ALTER TABLE items ADD COLUMN regionRestricted INTEGER; ALTER TABLE items ADD COLUMN embeddable INTEGER; ALTER TABLE items ADD COLUMN isShort INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=4; COMMIT;",
      );
    if (version <= 4)
      this.db.exec(
        "BEGIN IMMEDIATE; CREATE TABLE playback_history(id INTEGER PRIMARY KEY AUTOINCREMENT,startedAt INTEGER NOT NULL,endedAt INTEGER,videoId TEXT NOT NULL,title TEXT NOT NULL,channel TEXT NOT NULL,duration REAL,status TEXT NOT NULL,watchedSeconds REAL NOT NULL DEFAULT 0); CREATE INDEX playback_history_time ON playback_history(startedAt DESC); PRAGMA user_version=5; COMMIT;",
      );
    if (version <= 5)
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE items ADD COLUMN sourceType TEXT NOT NULL DEFAULT 'youtube';
        ALTER TABLE items ADD COLUMN localIdentity TEXT;
        ALTER TABLE items ADD COLUMN localPath TEXT;
        ALTER TABLE items ADD COLUMN youtubeVideoId TEXT;
        ALTER TABLE items ADD COLUMN videoWidth INTEGER;
        ALTER TABLE items ADD COLUMN videoHeight INTEGER;
        ALTER TABLE items ADD COLUMN frameRate TEXT NOT NULL DEFAULT '';
        ALTER TABLE items ADD COLUMN videoCodec TEXT NOT NULL DEFAULT '';
        ALTER TABLE items ADD COLUMN audioCodec TEXT NOT NULL DEFAULT '';
        ALTER TABLE items ADD COLUMN hasAudio INTEGER;
        CREATE TABLE marathons(
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          sourceType TEXT NOT NULL,
          sourceIdentity TEXT NOT NULL,
          status TEXT NOT NULL,
          schedulingMode TEXT NOT NULL,
          scheduledStart INTEGER,
          scheduledEnd INTEGER,
          actualStart INTEGER,
          actualEnd INTEGER,
          normalQueueBoundary TEXT,
          currentPosition INTEGER NOT NULL DEFAULT 0,
          completedEntries INTEGER NOT NULL DEFAULT 0,
          failedEntries INTEGER NOT NULL DEFAULT 0,
          totalEntries INTEGER NOT NULL,
          totalRuntime REAL NOT NULL,
          createdAt INTEGER NOT NULL,
          manualEnding INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE marathon_entries(
          id TEXT PRIMARY KEY,
          marathonId TEXT NOT NULL REFERENCES marathons(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          sourceType TEXT NOT NULL,
          localIdentity TEXT,
          localPath TEXT,
          youtubeVideoId TEXT,
          title TEXT NOT NULL,
          duration REAL,
          metadata TEXT NOT NULL
        );
        CREATE UNIQUE INDEX marathon_entry_order ON marathon_entries(marathonId,position);
        PRAGMA user_version=6;
        COMMIT;`);
    if (version <= 6)
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE marathons ADD COLUMN schedulingMethod TEXT;
        ALTER TABLE marathons ADD COLUMN requestedTime INTEGER;
        ALTER TABLE marathons ADD COLUMN committedQueue TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE marathons ADD COLUMN scheduleUpdatedAt INTEGER;
        ALTER TABLE playback_history ADD COLUMN queueEntryId TEXT;
        CREATE INDEX playback_history_queue_entry ON playback_history(queueEntryId,startedAt);
        PRAGMA user_version=7;
        COMMIT;`);
    if (version <= 7)
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE marathons ADD COLUMN currentEntryId TEXT;
        ALTER TABLE marathons ADD COLUMN currentEntryState TEXT;
        ALTER TABLE marathons ADD COLUMN lastCompletedEntryId TEXT;
        ALTER TABLE marathon_entries ADD COLUMN playbackState TEXT NOT NULL DEFAULT 'pending';
        ALTER TABLE marathon_entries ADD COLUMN startedAt INTEGER;
        ALTER TABLE marathon_entries ADD COLUMN completedAt INTEGER;
        ALTER TABLE marathon_entries ADD COLUMN lastError TEXT;
        PRAGMA user_version=8;
        COMMIT;`);
    if (version <= 8)
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE marathons ADD COLUMN sourceLabel TEXT NOT NULL DEFAULT '';
        ALTER TABLE marathons ADD COLUMN earlyEndRequestedAt INTEGER;
        PRAGMA user_version=9;
        COMMIT;`);
  }
  get<T>(key: string, fallback: T): T {
    const r = this.db
      .prepare("SELECT value FROM kv WHERE key=?")
      .get(key) as any;
    return r ? JSON.parse(r.value) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  settings(): Settings {
    return settingsSchema.parse(this.get("settings", defaults));
  }
  list(offset = 0, limit = 100): StoredItem[] {
    return (
      this.db
        .prepare("SELECT * FROM items ORDER BY position,id LIMIT ? OFFSET ?")
        .all(limit, offset) as any[]
    ).map((i) => ({
      ...i,
      available: !!i.available,
      seriesKey: i.seriesKey ?? "",
      seriesIndex: i.seriesIndex ?? null,
      liveStatus: i.liveStatus ?? "none",
      publishedAt: i.publishedAt ?? "",
      regionRestricted: !!i.regionRestricted,
      embeddable: i.embeddable === null ? undefined : !!i.embeddable,
      isShort: !!i.isShort,
      failureCount: i.failures ?? 0,
      sourceType: i.sourceType === "local" ? "local" : "youtube",
      localIdentity: i.localIdentity ?? undefined,
      localPath: i.localPath ?? undefined,
      youtubeVideoId: i.youtubeVideoId ?? (i.sourceType === "local" ? "" : i.videoId),
      videoWidth: i.videoWidth ?? null,
      videoHeight: i.videoHeight ?? null,
      frameRate: i.frameRate ?? "",
      videoCodec: i.videoCodec ?? "",
      audioCodec: i.audioCodec ?? "",
      hasAudio: i.hasAudio === null ? undefined : !!i.hasAudio,
    }));
  }
  all(): StoredItem[] {
    return this.list(0, 100001);
  }
  count(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM items").get() as any).n;
  }
  replace(items: PlaylistItem[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("CREATE TEMP TABLE incoming(id TEXT PRIMARY KEY)");
      const put = this.db.prepare(
        "INSERT INTO items(id,videoId,position,title,channel,thumbnail,available,duration,publishedAt,regionRestricted,embeddable,isShort,liveStatus,seriesKey,seriesIndex,sourceType,localIdentity,localPath,youtubeVideoId,videoWidth,videoHeight,frameRate,videoCodec,audioCodec,hasAudio) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET videoId=excluded.videoId,position=excluded.position,title=excluded.title,channel=excluded.channel,thumbnail=excluded.thumbnail,available=excluded.available,duration=excluded.duration,publishedAt=excluded.publishedAt,regionRestricted=excluded.regionRestricted,embeddable=excluded.embeddable,isShort=excluded.isShort,liveStatus=excluded.liveStatus,seriesKey=excluded.seriesKey,seriesIndex=excluded.seriesIndex,sourceType=excluded.sourceType,localIdentity=excluded.localIdentity,localPath=excluded.localPath,youtubeVideoId=excluded.youtubeVideoId,videoWidth=excluded.videoWidth,videoHeight=excluded.videoHeight,frameRate=excluded.frameRate,videoCodec=excluded.videoCodec,audioCodec=excluded.audioCodec,hasAudio=excluded.hasAudio",
      );
      const mark = this.db.prepare("INSERT INTO incoming VALUES(?)");
      for (const i of items) {
        put.run(
          i.id,
          i.videoId,
          i.position,
          i.title,
          i.channel,
          i.thumbnail,
          Number(i.available),
          i.duration,
          i.publishedAt ?? "",
          i.regionRestricted === undefined ? null : Number(i.regionRestricted),
          i.embeddable === undefined ? null : Number(i.embeddable),
          Number(!!i.isShort),
          i.liveStatus ?? "none",
          i.seriesKey ?? "",
          i.seriesIndex ?? null,
          i.sourceType ?? "youtube",
          i.localIdentity ?? null,
          i.localPath ?? null,
          i.youtubeVideoId ?? (i.sourceType === "local" ? null : i.videoId),
          i.videoWidth ?? null,
          i.videoHeight ?? null,
          i.frameRate ?? "",
          i.videoCodec ?? "",
          i.audioCodec ?? "",
          i.hasAudio === undefined ? null : Number(i.hasAudio),
        );
        mark.run(i.id);
      }
      this.db.exec(
        "DELETE FROM items WHERE id NOT IN (SELECT id FROM incoming); DROP TABLE incoming;",
      );
      this.set("lastSync", Date.now());
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  move(id: string, to: number): boolean {
    const ids = (
      this.db.prepare("SELECT id FROM items ORDER BY position,id").all() as {
        id: string;
      }[]
    ).map((row) => row.id);
    const from = ids.indexOf(id);
    if (from < 0) return false;
    const target = Math.max(0, Math.min(to, ids.length - 1));
    if (from === target) return true;
    ids.splice(target, 0, ids.splice(from, 1)[0]);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare("UPDATE items SET position=? WHERE id=?");
      ids.forEach((itemId, position) => update.run(position, itemId));
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  order(ids: string[]) {
    const current = (
      this.db.prepare("SELECT id FROM items ORDER BY position,id").all() as {
        id: string;
      }[]
    ).map((row) => row.id);
    const requested = new Set(ids);
    if (
      ids.length !== current.length ||
      requested.size !== current.length ||
      current.some((id) => !requested.has(id))
    )
      throw new Error("Queue order must contain every item exactly once");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare("UPDATE items SET position=? WHERE id=?");
      ids.forEach((id, position) => update.run(position, id));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  fail(id: string, message: string) {
    this.db
      .prepare(
        "UPDATE items SET failures=failures+1,retryAt=?,error=? WHERE id=?",
      )
      .run(Date.now() + 300000, message, id);
  }
  success(id: string) {
    this.db
      .prepare("UPDATE items SET failures=0,retryAt=0,error=NULL WHERE id=?")
      .run(id);
  }
  log(level: string, message: string) {
    this.db
      .prepare("INSERT INTO logs(time,level,message) VALUES(?,?,?)")
      .run(Date.now(), level, message);
    this.db.exec(
      "DELETE FROM logs WHERE id < (SELECT COALESCE(MAX(id),0)-999 FROM logs)",
    );
  }
  startPlayback(item: PlaylistItem) {
    const result = this.db
      .prepare("INSERT INTO playback_history(startedAt,videoId,title,channel,duration,status,queueEntryId) VALUES(?,?,?,?,?,'playing',?)")
      .run(Date.now(), item.videoId, item.title, item.channel, item.duration, item.id);
    return Number(result.lastInsertRowid);
  }
  finishPlayback(id: number, status: PlaybackHistoryItem["status"], watchedSeconds: number) {
    this.db
      .prepare("UPDATE playback_history SET endedAt=?,status=?,watchedSeconds=? WHERE id=? AND status='playing'")
      .run(Date.now(), status, Math.max(0, watchedSeconds), id);
  }
  playbackHistory(limit = 200): PlaybackHistoryItem[] {
    return this.db
      .prepare("SELECT * FROM playback_history ORDER BY startedAt DESC,id DESC LIMIT ?")
      .all(limit) as unknown as PlaybackHistoryItem[];
  }
  createMarathon(
    name: string,
    sourceType: MarathonSourceType,
    sourceIdentity: string,
    items: PlaylistItem[],
    normalQueueBoundary: string | null = null,
    sourceLabel = "",
  ): Marathon {
    const marathon: Marathon = {
      id: randomUUID(), name, sourceType, sourceIdentity, status: "draft",
      schedulingMode: "manual", scheduledStart: null, scheduledEnd: null,
      actualStart: null, actualEnd: null, normalQueueBoundary,
      currentPosition: 0, completedEntries: 0, failedEntries: 0,
      totalEntries: items.length,
      totalRuntime: items.reduce((sum, item) => sum + (item.duration ?? 0), 0),
      createdAt: Date.now(), manualEnding: false,
      schedulingMethod: null, requestedTime: null, committedQueue: [], scheduleUpdatedAt: null,
      currentEntryId: null, currentEntryState: null, lastCompletedEntryId: null,
      sourceLabel, earlyEndRequestedAt: null,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO marathons(id,name,sourceType,sourceIdentity,status,schedulingMode,scheduledStart,scheduledEnd,actualStart,actualEnd,normalQueueBoundary,currentPosition,completedEntries,failedEntries,totalEntries,totalRuntime,createdAt,manualEnding,sourceLabel,earlyEndRequestedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        marathon.id, marathon.name, marathon.sourceType, marathon.sourceIdentity,
        marathon.status, marathon.schedulingMode, marathon.scheduledStart,
        marathon.scheduledEnd, marathon.actualStart, marathon.actualEnd,
        marathon.normalQueueBoundary, marathon.currentPosition,
        marathon.completedEntries, marathon.failedEntries, marathon.totalEntries,
        marathon.totalRuntime, marathon.createdAt, Number(marathon.manualEnding),
        marathon.sourceLabel, marathon.earlyEndRequestedAt,
      );
      const put = this.db.prepare("INSERT INTO marathon_entries(id,marathonId,position,sourceType,localIdentity,localPath,youtubeVideoId,title,duration,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)");
      items.forEach((item, position) => put.run(
        randomUUID(), marathon.id, position, item.sourceType ?? "youtube",
        item.localIdentity ?? null, item.localPath ?? null,
        item.youtubeVideoId ?? (item.sourceType === "local" ? null : item.videoId),
        item.title, item.duration,
        JSON.stringify({ channel: item.channel, thumbnail: item.thumbnail, publishedAt: item.publishedAt ?? "", seriesKey: item.seriesKey ?? "", seriesIndex: item.seriesIndex ?? null, videoWidth: item.videoWidth ?? null, videoHeight: item.videoHeight ?? null, frameRate: item.frameRate ?? "", videoCodec: item.videoCodec ?? "", audioCodec: item.audioCodec ?? "", hasAudio: item.hasAudio }),
      ));
      this.db.exec("COMMIT");
      return marathon;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  marathons(): Marathon[] {
    return (this.db.prepare("SELECT * FROM marathons ORDER BY createdAt DESC").all() as any[])
      .map((row) => ({ ...row, manualEnding: !!row.manualEnding, committedQueue: JSON.parse(row.committedQueue ?? "[]") }));
  }
  marathon(id: string): { marathon: Marathon; entries: MarathonEntry[] } | null {
    const row = this.db.prepare("SELECT * FROM marathons WHERE id=?").get(id) as any;
    if (!row) return null;
    const entries = (this.db.prepare("SELECT * FROM marathon_entries WHERE marathonId=? ORDER BY position").all(id) as any[])
      .map((entry) => ({ ...entry, metadata: JSON.parse(entry.metadata), playbackState: entry.playbackState ?? "pending", startedAt: entry.startedAt ?? null, completedAt: entry.completedAt ?? null, lastError: entry.lastError ?? null }));
    return { marathon: { ...row, manualEnding: !!row.manualEnding, committedQueue: JSON.parse(row.committedQueue ?? "[]") }, entries };
  }
  scheduleMarathon(id: string, method: "start" | "end", requestedTime: number, calculatedStart: number, calculatedEnd: number, commitments: Array<{ entryId: string; title: string; remainingSeconds: number }>) {
    const existing = this.db.prepare("SELECT id FROM marathons WHERE status IN ('scheduled','active','ending') AND id<>?").get(id) as any;
    if (existing) throw new Error("Another Marathon is already scheduled or active");
    const result = this.db.prepare("UPDATE marathons SET status='scheduled',schedulingMode='scheduled',schedulingMethod=?,requestedTime=?,scheduledStart=?,scheduledEnd=?,normalQueueBoundary=?,committedQueue=?,scheduleUpdatedAt=? WHERE id=? AND status IN ('draft','scheduled','cancelled')").run(
      method, requestedTime, calculatedStart, calculatedEnd, commitments.at(-1)?.entryId ?? null, JSON.stringify(commitments), Date.now(), id,
    );
    if (!result.changes) throw new Error("Only a draft or scheduled Marathon can be scheduled");
    return this.marathon(id)!;
  }
  cancelMarathonSchedule(id: string) {
    const result = this.db.prepare("UPDATE marathons SET status='draft',schedulingMode='manual',schedulingMethod=NULL,requestedTime=NULL,scheduledStart=NULL,scheduledEnd=NULL,normalQueueBoundary=NULL,committedQueue='[]',scheduleUpdatedAt=? WHERE id=? AND status='scheduled'").run(Date.now(), id);
    if (!result.changes) throw new Error("Only a scheduled Marathon can be cancelled");
    return this.marathon(id)!;
  }
  requestEndMarathon(id: string) {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT status FROM marathons WHERE id=?").get(id) as any;
      if (!existing) throw new Error("Marathon not found");
      if (existing.status === "ending") {
        this.db.exec("COMMIT");
        return { applied: false, duplicate: true, record: this.marathon(id)! };
      }
      if (existing.status !== "active") throw new Error("Only an active Marathon can be ended early");
      this.db.prepare("UPDATE marathons SET status='ending',manualEnding=1,earlyEndRequestedAt=? WHERE id=? AND status='active'").run(now, id);
      this.db.exec("COMMIT");
      return { applied: true, duplicate: false, record: this.marathon(id)! };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  marathonHistory(limit = 100) {
    return (this.db.prepare("SELECT * FROM marathons WHERE status IN ('completed','ended_early','failed','cancelled') ORDER BY COALESCE(actualEnd,createdAt) DESC LIMIT ?").all(limit) as any[])
      .map((row) => ({
        ...row,
        manualEnding: !!row.manualEnding,
        committedQueue: JSON.parse(row.committedQueue ?? "[]"),
        unplayedEntries: Math.max(0, row.totalEntries - row.completedEntries - row.failedEntries),
      }));
  }
  controllingMarathon() {
    const row = this.db.prepare("SELECT id FROM marathons WHERE status IN ('scheduled','active','ending') ORDER BY scheduleUpdatedAt DESC LIMIT 1").get() as any;
    return row ? this.marathon(row.id) : null;
  }
  completedQueueEntriesSince(timestamp: number) {
    return new Set((this.db.prepare("SELECT DISTINCT queueEntryId FROM playback_history WHERE endedAt>=? AND queueEntryId IS NOT NULL AND status IN ('played','skipped','failed')").all(timestamp) as any[]).map((row) => String(row.queueEntryId)));
  }
  recoverMarathonPlayback() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE marathon_entries SET playbackState='interrupted',lastError=COALESCE(lastError,'IdleCast restarted before this entry completed') WHERE playbackState IN ('preparing','playing') AND marathonId IN (SELECT id FROM marathons WHERE status IN ('scheduled','active','ending'))").run();
      this.db.prepare("UPDATE marathons SET currentEntryState='interrupted' WHERE status IN ('scheduled','active','ending') AND currentEntryState IN ('preparing','playing')").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  prepareMarathonEntry(marathonId: string, entryId: string, position: number, scheduleToken: number | null) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const marathon = this.db.prepare("SELECT status,currentPosition,scheduleUpdatedAt FROM marathons WHERE id=?").get(marathonId) as any;
      const entry = this.db.prepare("SELECT playbackState FROM marathon_entries WHERE id=? AND marathonId=? AND position=?").get(entryId, marathonId, position) as any;
      if (!marathon || !entry || !["scheduled", "active", "ending"].includes(marathon.status) || marathon.currentPosition !== position || marathon.scheduleUpdatedAt !== scheduleToken || entry.playbackState === "completed")
        throw new Error("Marathon entry ownership changed before preparation");
      this.db.prepare("UPDATE marathons SET currentEntryId=?,currentEntryState='preparing' WHERE id=?").run(entryId, marathonId);
      this.db.prepare("UPDATE marathon_entries SET playbackState='preparing',lastError=NULL WHERE id=? AND playbackState<>'completed'").run(entryId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  activateMarathonEntry(marathonId: string, entryId: string, position: number, scheduleToken: number | null) {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const marathon = this.db.prepare("SELECT status,currentPosition,currentEntryId,scheduleUpdatedAt FROM marathons WHERE id=?").get(marathonId) as any;
      const entry = this.db.prepare("SELECT playbackState FROM marathon_entries WHERE id=? AND marathonId=? AND position=?").get(entryId, marathonId, position) as any;
      if (!marathon || !entry || !["scheduled", "active", "ending"].includes(marathon.status) || marathon.currentPosition !== position || marathon.currentEntryId !== entryId || marathon.scheduleUpdatedAt !== scheduleToken || entry.playbackState === "completed") {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare("UPDATE marathon_entries SET playbackState='playing',startedAt=COALESCE(startedAt,?),lastError=NULL WHERE id=?").run(now, entryId);
      this.db.prepare("UPDATE marathons SET status=CASE WHEN status='ending' THEN 'ending' ELSE 'active' END,actualStart=COALESCE(actualStart,?),currentEntryState='playing' WHERE id=?").run(now, marathonId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  interruptMarathonEntry(marathonId: string, entryId: string, message: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const owner = this.db.prepare("SELECT status,currentEntryId FROM marathons WHERE id=?").get(marathonId) as any;
      if (!owner || !["scheduled", "active", "ending"].includes(owner.status) || owner.currentEntryId !== entryId) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db.prepare("UPDATE marathon_entries SET playbackState='interrupted',lastError=? WHERE id=? AND marathonId=? AND playbackState<>'completed'").run(message.slice(0, 1000), entryId, marathonId);
      this.db.prepare("UPDATE marathons SET currentEntryState='interrupted' WHERE id=? AND currentEntryId=?").run(marathonId, entryId);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  completeMarathonEntry(marathonId: string, entryId: string, position: number) {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const marathon = this.db.prepare("SELECT status,currentPosition,currentEntryId,totalEntries,completedEntries,failedEntries FROM marathons WHERE id=?").get(marathonId) as any;
      const entry = this.db.prepare("SELECT playbackState FROM marathon_entries WHERE id=? AND marathonId=? AND position=?").get(entryId, marathonId, position) as any;
      if (!marathon || !entry || !["active", "ending"].includes(marathon.status) || marathon.currentPosition !== position || marathon.currentEntryId !== entryId || entry.playbackState !== "playing") {
        this.db.exec("ROLLBACK");
        return { applied: false, finished: ["completed", "ended_early", "failed"].includes(marathon?.status), endedEarly: marathon?.status === "ended_early" };
      }
      const nextPosition = position + 1;
      const completedEntries = marathon.completedEntries + 1;
      const everyRequiredEntryCompleted = completedEntries === marathon.totalEntries && marathon.failedEntries === 0;
      const terminalStatus =
        marathon.status === "ending"
          ? everyRequiredEntryCompleted ? "completed" : "ended_early"
          : nextPosition >= marathon.totalEntries
            ? everyRequiredEntryCompleted ? "completed" : "failed"
            : "active";
      const finished = terminalStatus !== "active";
      this.db.prepare("UPDATE marathon_entries SET playbackState='completed',completedAt=?,lastError=NULL WHERE id=? AND playbackState='playing'").run(now, entryId);
      this.db.prepare("UPDATE marathons SET status=?,currentPosition=?,completedEntries=?,lastCompletedEntryId=?,currentEntryId=NULL,currentEntryState=NULL,actualEnd=? WHERE id=?").run(
        terminalStatus, nextPosition, completedEntries, entryId, finished ? now : null, marathonId,
      );
      this.db.exec("COMMIT");
      return { applied: true, finished, endedEarly: terminalStatus === "ended_early" };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  skipMarathonEntry(marathonId: string, entryId: string, position: number) {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const marathon = this.db.prepare("SELECT status,currentPosition,currentEntryId,totalEntries FROM marathons WHERE id=?").get(marathonId) as any;
      const entry = this.db.prepare("SELECT playbackState FROM marathon_entries WHERE id=? AND marathonId=? AND position=?").get(entryId, marathonId, position) as any;
      if (!marathon || !entry || marathon.status !== "active" || marathon.currentPosition !== position || marathon.currentEntryId !== entryId || entry.playbackState === "completed" || entry.playbackState === "skipped") {
        this.db.exec("ROLLBACK");
        return { applied: false, finished: marathon?.status === "completed" };
      }
      const nextPosition = position + 1;
      const finished = nextPosition >= marathon.totalEntries;
      this.db.prepare("UPDATE marathon_entries SET playbackState='skipped',completedAt=?,lastError='Skipped by user' WHERE id=?").run(now, entryId);
      this.db.prepare("UPDATE marathons SET status=?,currentPosition=?,failedEntries=failedEntries+1,currentEntryId=NULL,currentEntryState=NULL,actualEnd=? WHERE id=?").run(
        finished ? "failed" : "active", nextPosition, finished ? now : null, marathonId,
      );
      this.db.exec("COMMIT");
      return { applied: true, finished };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  failMarathonEntry(marathonId: string, entryId: string, position: number, message: string) {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const marathon = this.db.prepare("SELECT status,currentPosition,currentEntryId,totalEntries FROM marathons WHERE id=?").get(marathonId) as any;
      const entry = this.db.prepare("SELECT playbackState FROM marathon_entries WHERE id=? AND marathonId=? AND position=?").get(entryId, marathonId, position) as any;
      if (!marathon || !entry || !["active", "ending"].includes(marathon.status) || marathon.currentPosition !== position || (marathon.currentEntryId && marathon.currentEntryId !== entryId) || entry.playbackState === "completed" || entry.playbackState === "failed") {
        this.db.exec("ROLLBACK");
        return { applied: false, finished: ["completed", "ended_early", "failed"].includes(marathon?.status) };
      }
      const nextPosition = position + 1;
      const terminalStatus = marathon.status === "ending" ? "ended_early" : nextPosition >= marathon.totalEntries ? "failed" : "active";
      const finished = terminalStatus !== "active";
      this.db.prepare("UPDATE marathon_entries SET playbackState='failed',completedAt=?,lastError=? WHERE id=? AND playbackState<>'completed'").run(now, message.slice(0, 1000), entryId);
      this.db.prepare("UPDATE marathons SET status=?,currentPosition=?,failedEntries=failedEntries+1,currentEntryId=NULL,currentEntryState=NULL,actualEnd=? WHERE id=?").run(
        terminalStatus, nextPosition, finished ? now : null, marathonId,
      );
      this.db.exec("COMMIT");
      return { applied: true, finished, endedEarly: terminalStatus === "ended_early" };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  recordDiagnostic(record: DiagnosticRecord) {
    const records = this.get<DiagnosticRecord[]>("diagnostics", []);
    records.unshift(record);
    this.set("diagnostics", records.slice(0, 100));
    if (DIAGNOSTIC_REGISTRY[record.code].severity !== "info") {
      const retainedBeforeThis = records.slice(1).filter((entry) => DIAGNOSTIC_REGISTRY[entry.code].severity !== "info").length;
      const total = this.get<number | null>("diagnostics.totalErrorOccurrences", null);
      const unread = this.get<number | null>("diagnostics.unreadCount", null);
      this.set("diagnostics.totalErrorOccurrences", (total ?? retainedBeforeThis) + 1);
      this.set("diagnostics.unreadCount", (unread ?? retainedBeforeThis) + 1);
    }
  }
  diagnostics(limit = 50): DiagnosticRecord[] {
    return this.get<DiagnosticRecord[]>("diagnostics", []).slice(0, limit);
  }
  logs() {
    return this.db
      .prepare("SELECT * FROM logs ORDER BY id DESC LIMIT 200")
      .all();
  }
  close() {
    this.db.close();
  }
}
