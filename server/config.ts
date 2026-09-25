import { z } from "zod";
import path from "node:path";
import { existsSync } from "node:fs";
import { youtubeWatchId } from "./youtube-viewer.js";

export function executablePath(value: string): string {
  if (path.isAbsolute(value) || /[\\/]/.test(value)) return path.resolve(value);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of process.platform === "win32" ? ["", ".exe"] : [""]) {
      const candidate = path.resolve(dir.replace(/^"|"$/g, ""), value + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return value;
}

const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");
const secret = z.string().min(16).max(256);
export function playlistId(value: string): string {
  if (!value) return "";
  if (/^[A-Za-z0-9_-]{1,100}$/.test(value)) return value;
  try {
    const u = new URL(value);
    if (
      u.protocol === "https:" &&
      [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
      ].includes(u.hostname)
    ) {
      const id = u.searchParams.get("list");
      if (id && /^[A-Za-z0-9_-]{1,100}$/.test(id)) return id;
    }
  } catch {}
  throw new Error("Enter a YouTube playlist link or ID");
}
export const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_ORIGIN: z.url().default("http://localhost:3000"),
  ADMIN_PASSWORD: secret,
  DATA_DIR: z.string().default("./data"),
  MEDIA_DIR: z.string().default("./media"),
  YOUTUBE_API_KEY: z.string().default(""),
  YOUTUBE_STREAM_KEY: z.string().default(""),
  TWITCH_STREAM_KEY: z.string().default(""),
  EXPERIMENTAL_YOUTUBE: bool,
  COOKIE_SECURE: bool,
  FFMPEG_PATH: z.string().default("ffmpeg"),
  FFPROBE_PATH: z.string().default("ffprobe"),
  YTDLP_PATH: z.string().default("yt-dlp"),
  YTDLP_COOKIES_FILE: z.string().default(""),
  FONT_FILE: z
    .string()
    .default("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
  UDP_BASE_PORT: z.coerce.number().int().min(1024).max(65533).default(19000),
  CACHE_MAX_MB: z.coerce.number().int().min(100).max(100000).default(4096),
});
export type Config = z.infer<typeof envSchema>;
export function readConfig(env: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      "Invalid environment fields: " +
        result.error.issues.map((i) => i.path.join(".")).join(", "),
    );
  const c = result.data;
  const origin = new URL(c.PUBLIC_ORIGIN);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== c.PUBLIC_ORIGIN
  )
    throw new Error(
      "PUBLIC_ORIGIN must be an HTTP(S) origin without a trailing slash",
    );
  if (c.COOKIE_SECURE && origin.protocol !== "https:")
    throw new Error("Secure cookies require HTTPS PUBLIC_ORIGIN");
  if (
    !c.COOKIE_SECURE &&
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
  )
    throw new Error("Remote access requires HTTPS and COOKIE_SECURE=true");
  c.DATA_DIR = path.resolve(c.DATA_DIR);
  c.MEDIA_DIR = path.resolve(c.MEDIA_DIR);
  c.FFMPEG_PATH = executablePath(c.FFMPEG_PATH);
  c.FFPROBE_PATH = executablePath(c.FFPROBE_PATH);
  c.YTDLP_PATH = executablePath(c.YTDLP_PATH);
  if (c.YTDLP_COOKIES_FILE)
    c.YTDLP_COOKIES_FILE = path.resolve(c.YTDLP_COOKIES_FILE);
  return c;
}
const destination = (platform: "youtube" | "twitch") =>
  z
    .object({
      enabled: z.boolean().default(false),
      server: z
        .url()
        .refine((v) => {
          try {
            const u = new URL(v);
            return (
              u.protocol === "rtmps:" &&
              !u.username &&
              !u.password &&
              !u.search &&
              !u.hash &&
              (!u.port || u.port === "443") &&
              u.pathname.replace(/\/$/, "") ===
                (platform === "youtube" ? "/live2" : "/app") &&
              (platform === "youtube"
                ? u.hostname === "a.rtmps.youtube.com"
                : /^(?:[a-z0-9-]+\.)*(?:contribute|global-contribute)\.live-video\.net$/.test(
                    u.hostname,
                  ))
            );
          } catch {
            return false;
          }
        }, "Use an official RTMPS ingest endpoint")
        .default(
          platform === "youtube"
            ? "rtmps://a.rtmps.youtube.com:443/live2"
            : "rtmps://ingest.global-contribute.live-video.net:443/app",
        ),
    })
    .strict();
export const durationFilterValues = [
  "under5",
  "5to10",
  "10to25",
  "25to40",
  "40to60",
  "1to2h",
  "2to5h",
  "5hplus",
] as const;

const filterSettings = z
  .object({
    years: z.array(z.number().int().min(2005).max(2100)).max(100).default([]),
    durations: z.array(z.enum(durationFilterValues)).max(durationFilterValues.length).default([]),
    excludeRegionRestricted: z.boolean().default(false),
    excludeNotEmbeddable: z.boolean().default(false),
    maxEstimatedSizeGb: z.number().min(0).max(1000).default(0),
    maxFailures: z.number().int().min(0).max(100).default(0),
    seriesMode: z.enum(["off", "strict", "smart"]).default("off"),
    seriesLimit: z.number().int().min(2).max(50).default(10),
    includeShorts: z.boolean().default(false),
    playLivestreams: z.boolean().default(false),
  })
  .strict()
  .default({
    years: [],
    durations: [],
    excludeRegionRestricted: false,
    excludeNotEmbeddable: false,
    maxEstimatedSizeGb: 0,
    maxFailures: 0,
    seriesMode: "off",
    seriesLimit: 10,
    includeShorts: false,
    playLivestreams: false,
  });

export const settingsSchema = z
  .object({
    sourceMode: z.enum(["playlist", "channel"]).default("playlist"),
    sources: z.array(z.object({ kind: z.enum(["playlist", "channel"]), value: z.string().trim().min(1).max(2048) }).strict()).max(100).default([]),
    youtubeWatchId: z.string().max(2048).transform((value,ctx)=>{
      try {return youtubeWatchId(value);} catch(error) {ctx.addIssue({code:"custom",message:(error as Error).message});return z.NEVER;}
    }).default(""),
    channelUrl: z.string().max(2048).default(""),
    excludedWords: z
      .array(z.string().trim().max(100))
      .max(100)
      .transform((words) => words.filter(Boolean))
      .default([]),
    shuffle: z.boolean().default(false),
    filters: filterSettings,
    playlistId: z
      .string()
      .max(2048)
      .transform((v, ctx) => {
        try {
          return playlistId(v.trim());
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "Enter a YouTube playlist link or ID",
          });
          return z.NEVER;
        }
      })
      .default(""),
    mediaSource: z
      .enum(["local", "youtube-experimental"])
      .default("youtube-experimental"),
    resyncMinutes: z.number().int().min(5).max(1440).default(15),
    width: z.union([z.literal(1280), z.literal(1920)]).default(1280),
    height: z.union([z.literal(720), z.literal(1080)]).default(720),
    fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).default(30),
    bitrateKbps: z.number().int().min(500).max(6000).default(2500),
    youtube: destination("youtube"),
    twitch: destination("twitch"),
    overlay: z
      .object({
        enabled: z.boolean().default(true),
        title: z.string().max(500).default("IdleCast"),
        avatar: z
          .string()
          .regex(/^(?:[A-Za-z0-9_-]+\.(?:png|jpg|jpeg))?$/)
          .default(""),
        fontSize: z.number().int().min(12).max(96).default(24),
        avatarSize: z.number().int().min(24).max(240).default(56),
        margin: z.number().int().min(8).max(100).default(28),
      })
      .strict()
      .default({
        enabled: true,
        title: "IdleCast",
        avatar: "",
        fontSize: 24,
        avatarSize: 56,
        margin: 28,
      }),
  })
  .strict()
  .refine(
    (s) =>
      (s.width === 1280 && s.height === 720) ||
      (s.width === 1920 && s.height === 1080),
    { message: "Choose 1280 × 720 or 1920 × 1080", path: ["height"] },
  );
export type Settings = z.infer<typeof settingsSchema>;
export type FilterSettings = Settings["filters"];
export const defaults: Settings = settingsSchema.parse({
  youtube: {},
  twitch: { server: "rtmps://ingest.global-contribute.live-video.net:443/app" },
});
