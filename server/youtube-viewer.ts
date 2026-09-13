export function youtubeWatchId(value: string): string {
  const input = value.trim();
  if (!input) return "";
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error();
    const parts = url.pathname.split("/").filter(Boolean);
    let id: string | null = null;
    if (url.hostname === "youtu.be" && parts.length === 1) id = parts[0];
    if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
      if (url.pathname === "/watch") id = url.searchParams.get("v");
      else if (["live", "embed"].includes(parts[0]) && parts.length === 2) id = parts[1];
    }
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id;
  } catch {}
  throw new Error("Enter the broadcast's YouTube watch link, live link, or 11-character video ID");
}
