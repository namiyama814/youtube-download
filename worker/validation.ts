export function youtubeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048)
    throw new Error("YouTube の URL を入力してください。");
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.port)
    throw new Error("HTTPS の YouTube URL が必要です。");
  let id: string | null = null;
  if (u.hostname === "youtu.be") id = u.pathname.slice(1);
  else if (
    ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(u.hostname)
  ) {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else id = /^\/shorts\/([\w-]+)\/?$/.exec(u.pathname)?.[1] ?? null;
  }
  if (!id || !/^[\w-]{11}$/.test(id) || u.searchParams.has("list"))
    throw new Error(
      "単一の YouTube 動画または Shorts の URL を指定してください。",
    );
  return `https://www.youtube.com/watch?v=${id}`;
}
export function options(body: Record<string, unknown>) {
  const url = youtubeUrl(body.url);
  if (
    !["mp4", "mp3"].includes(String(body.format)) ||
    !["best", "1080", "720", "480"].includes(String(body.quality))
  )
    throw new Error("形式または画質が不正です。");
  return { url, format: String(body.format), quality: String(body.quality) };
}
