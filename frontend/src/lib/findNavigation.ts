import type { MeResponse } from "../api/client";

export type FindView = { query: string; status: "active" | "missing" | "archived"; roomId: string; filter: string; page: number };
export type FindNavigation = { view: FindView; entry: string; onChange: (view: FindView, replace?: boolean, immediate?: boolean) => void };
const storageKey = "wuwei.find-navigation.v1";
type NavigationMemory = { owner: string; last: string; positions: Array<{ path: string; y: number }> };
export const findOwner = (me: MeResponse) => `${me.household.id}:${me.user.id}`;
const identifier = (value: string | null) => value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : "";

export function readFindView(search: string, compartment = ""): FindView {
  const params = new URLSearchParams(search);
  const status = params.get("status") === "missing" ? "missing" : params.get("status") === "archived" ? "archived" : "active";
  const rawPage = params.get("page") ?? "1";
  const page = /^\d+$/.test(rawPage) ? Number(rawPage) : 1;
  const query = params.get("q") ?? "";
  return { query: query.length <= 2000 ? query : "", status,
    roomId: status === "archived" ? "" : identifier(params.get("room")),
    filter: identifier(params.has("compartment") ? params.get("compartment") : compartment),
    page: Number.isSafeInteger(page) && page >= 1 && page <= 1_000_000 ? page : 1 };
}

export function findSearch(view: FindView, pendingSearch = ""): string {
  const params = new URLSearchParams();
  if (view.query) params.set("q", view.query);
  if (view.status !== "active") params.set("status", view.status);
  if (view.roomId && view.status !== "archived") params.set("room", view.roomId);
  if (view.filter) params.set("compartment", view.filter);
  if (view.page > 1) params.set("page", String(view.page));
  const pending = new URLSearchParams(pendingSearch);
  if (pending.get("capture") === "1") params.set("capture", "1");
  else if (pending.get("register") === "1") params.set("register", "1");
  return params.size ? `?${params}` : "";
}

function readMemory(): NavigationMemory | null {
  try {
    const data: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (!data || typeof data !== "object") return null;
    const value = data as Partial<NavigationMemory>;
    if (typeof value.owner !== "string" || typeof value.last !== "string" || !Array.isArray(value.positions)) return null;
    return { owner: value.owner, last: value.last, positions: value.positions.filter(entry => entry && typeof entry.path === "string" && Number.isFinite(entry.y) && entry.y >= 0).slice(-24) };
  } catch { return null; }
}
function writeMemory(value: NavigationMemory) { try { sessionStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* URL navigation remains usable when storage is unavailable. */ } }
export function clearFindNavigation() { try { sessionStorage.removeItem(storageKey); } catch { /* Private browsing may disallow storage. */ } }

/** Return true when a remembered view belongs to another signed-in identity. */
export function activateFindNavigation(me: MeResponse): boolean {
  const memory = readMemory(), owner = findOwner(me);
  if (memory?.owner === owner) return false;
  writeMemory({ owner, last: "/find", positions: [] });
  return Boolean(memory);
}
export function lastFindPath(me: MeResponse): string {
  const memory = readMemory();
  if (memory?.owner !== findOwner(me) || !/^\/find(?:\?[^#]*)?$/.test(memory.last)) return "/find";
  return "/find" + findSearch(readFindView(memory.last.slice(5)));
}
export function rememberFindPath(me: MeResponse, path: string, y?: number) {
  const owner = findOwner(me), stored = readMemory();
  // A late unmount from a revoked account must not restore its navigation cache.
  if (stored?.owner !== owner) return;
  const positions = stored.positions.filter(entry => entry.path !== path);
  const old = stored.positions.find(entry => entry.path === path);
  if (y !== undefined && Number.isFinite(y)) positions.push({ path, y: Math.max(0, y) });
  else if (old) positions.push(old);
  writeMemory({ owner, last: path, positions: positions.slice(-24) });
}
export function findScroll(me: MeResponse, path: string): number {
  const memory = readMemory();
  return memory?.owner === findOwner(me) ? memory.positions.find(entry => entry.path === path)?.y ?? 0 : 0;
}
