import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { Store } from "./db.js";

export const credentialKeys = [
  "YOUTUBE_API_KEY",
  "YOUTUBE_STREAM_KEY",
  "TWITCH_STREAM_KEY",
] as const;
export type Credentials = Partial<
  Record<(typeof credentialKeys)[number], string>
>;
// The encryption key remains on this trusted host, outside the database.
export function credentialStore(c: Config, store: Store) {
  const keyFile = path.join(c.DATA_DIR, "credentials.key");
  const fallback = Object.fromEntries(
    credentialKeys.map((k) => [k, c[k]]),
  ) as Credentials;
  const key = () => readFileSync(keyFile);
  let saved: Credentials = {};
  const encoded = store.get<string | null>("credentialsEncrypted", null);
  if (encoded) {
    const data = Buffer.from(encoded, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(),
      data.subarray(0, 12),
    );
    decipher.setAuthTag(data.subarray(12, 28));
    saved = JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString(),
    );
  }
  const apply = () => {
    for (const k of credentialKeys) c[k] = saved[k] ?? fallback[k] ?? "";
  };
  apply();
  return (
    changes: Partial<Record<(typeof credentialKeys)[number], string | null>>,
  ) => {
    const next = { ...saved };
    for (const k of credentialKeys) {
      if (changes[k] === null) delete next[k];
      else if (changes[k] !== undefined) next[k] = changes[k]!;
    }
    mkdirSync(c.DATA_DIR, { recursive: true, mode: 0o700 });
    if (!existsSync(keyFile))
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key(), iv);
    const payload = Buffer.concat([
      cipher.update(JSON.stringify(next)),
      cipher.final(),
    ]);
    store.set(
      "credentialsEncrypted",
      Buffer.concat([iv, cipher.getAuthTag(), payload]).toString("base64"),
    );
    saved = next;
    apply();
  };
}
