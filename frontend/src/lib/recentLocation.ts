import type { MeResponse } from "../api/client";

function storageKey(me: MeResponse): string {
  return `wuwei:recent-location:${encodeURIComponent(me.household.id)}:${encodeURIComponent(me.user.id)}`;
}

// Persist only the ID. The picker must resolve ownership and current labels on every opening.
export function recentLocation(me: MeResponse): string {
  try { return localStorage.getItem(storageKey(me)) ?? ""; }
  catch { return ""; }
}
export function rememberLocation(me: MeResponse, compartmentId: string): void {
  try { localStorage.setItem(storageKey(me), compartmentId); }
  catch { /* Storage can be unavailable; successful registration is still successful. */ }
}
export function forgetLocation(me: MeResponse, compartmentId: string): void {
  try {
    if (localStorage.getItem(storageKey(me)) === compartmentId) localStorage.removeItem(storageKey(me));
  } catch { /* Browsers may deny local storage. */ }
}
