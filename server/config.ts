import { z } from "zod";
import path from "node:path";

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
export const settingsSchema = z
  .object({
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
    width: z.literal(1280).default(1280),
    height: z.literal(720).default(720),
    fps: z.union([z.literal(24), z.literal(30)]).default(30),
    bitrateKbps: z.number().int().min(500).max(6000).default(2500),
    youtube: destination("youtube"),
    twitch: destination("twitch"),
    overlay: z
      .object({
        enabled: z.boolean().default(true),
        title: z.string().max(100).default("IdleCast"),
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
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export const defaults: Settings = settingsSchema.parse({
  youtube: {},
  twitch: { server: "rtmps://ingest.global-contribute.live-video.net:443/app" },
});
