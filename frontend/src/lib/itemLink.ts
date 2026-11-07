/** Build a private item entry without carrying credentials or the current query. */
export function itemUrl({ origin, basePath, itemId }: {
  origin: string; basePath: string; itemId: string;
}): string | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(itemId)) return null;
  const base = basePath === "/" ? "" : basePath.replace(/\/$/, "");
  if (base && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(base)) return null;
  try {
    const entry = new URL(origin);
    if (!["http:", "https:"].includes(entry.protocol)) return null;
    return new URL(`${base}/items/${encodeURIComponent(itemId)}`, entry.origin).href;
  } catch {
    return null;
  }
}
