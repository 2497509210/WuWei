import type { MeResponse } from "../api/client";

function storageKey(me: MeResponse, legacy = false): string {
  return `wuwei:${legacy ? "recent-location" : "recent-locations"}:${encodeURIComponent(me.household.id)}:${encodeURIComponent(me.user.id)}`;
}

// Persist IDs only. Every visible label and every selection is verified against current server data.
export function recentLocations(me: MeResponse): string[] {
  try {
    const stored = localStorage.getItem(storageKey(me));
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      return Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))].slice(0, 5) : [];
    }
    const legacy = localStorage.getItem(storageKey(me, true));
    if (!legacy || legacy.length > 200) return [];
    try {
      localStorage.setItem(storageKey(me), JSON.stringify([legacy]));
      localStorage.removeItem(storageKey(me, true));
    } catch { /* A readable legacy value remains usable when storage writes are denied. */ }
    return [legacy];
  } catch { return []; }
}

export function recentLocation(me: MeResponse): string {
  return recentLocations(me)[0] ?? "";
}
export function rememberLocation(me: MeResponse, compartmentId: string): void {
  if (!compartmentId || compartmentId.length > 200) return;
  try {
    localStorage.setItem(storageKey(me), JSON.stringify([compartmentId, ...recentLocations(me).filter(id => id !== compartmentId)].slice(0, 5)));
    localStorage.removeItem(storageKey(me, true));
  }
  catch { /* Storage can be unavailable; successful registration is still successful. */ }
}
export function forgetLocation(me: MeResponse, compartmentId: string): void {
  try {
    const retained = recentLocations(me).filter(id => id !== compartmentId);
    if (retained.length) localStorage.setItem(storageKey(me), JSON.stringify(retained));
    else localStorage.removeItem(storageKey(me));
    if (localStorage.getItem(storageKey(me, true)) === compartmentId) localStorage.removeItem(storageKey(me, true));
  } catch { /* Browsers may deny local storage. */ }
}
