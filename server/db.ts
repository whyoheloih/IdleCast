import { DatabaseSync } from "node:sqlite";
import { defaults, settingsSchema, type Settings } from "./config.js";
import type { PlaylistItem } from "./providers.js";
export type StoredItem = PlaylistItem & {
  failures: number;
  retryAt: number;
  error: string | null;
};
export class Store {
  db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.migrate();
  }
  private migrate() {
    const version = (this.db.prepare("PRAGMA user_version").get() as any)
      .user_version;
    if (version > 1)
      throw new Error("Database is newer than this version of IdleCast");
    if (version === 0)
      this.db.exec(`
   BEGIN IMMEDIATE;
   CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
   CREATE TABLE items(id TEXT PRIMARY KEY,videoId TEXT NOT NULL,position INTEGER NOT NULL,title TEXT NOT NULL,channel TEXT NOT NULL,thumbnail TEXT NOT NULL,available INTEGER NOT NULL,duration REAL,failures INTEGER NOT NULL DEFAULT 0,retryAt INTEGER NOT NULL DEFAULT 0,error TEXT);
   CREATE INDEX items_order ON items(position,id);
   CREATE TABLE logs(id INTEGER PRIMARY KEY AUTOINCREMENT,time INTEGER NOT NULL,level TEXT NOT NULL,message TEXT NOT NULL);
   CREATE TABLE sessions(hash TEXT PRIMARY KEY,expires INTEGER NOT NULL);
   PRAGMA user_version=1;
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
    ).map((i) => ({ ...i, available: !!i.available }));
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
        "INSERT INTO items(id,videoId,position,title,channel,thumbnail,available,duration) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET videoId=excluded.videoId,position=excluded.position,title=excluded.title,channel=excluded.channel,thumbnail=excluded.thumbnail,available=excluded.available,duration=excluded.duration",
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
  logs() {
    return this.db
      .prepare("SELECT * FROM logs ORDER BY id DESC LIMIT 200")
      .all();
  }
  close() {
    this.db.close();
  }
}
