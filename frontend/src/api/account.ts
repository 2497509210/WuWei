import { request, type User, type MeResponse } from "./client";

export type DeviceGroup = {
  id: string;
  device_name: string;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string;
  current: boolean;
  legacy: boolean;
};
export type HouseholdMember = User & { created_at: string };
export type HouseholdInvite = {
  id: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
};

export function updateProfile(displayName: string): Promise<{ user: User }> {
  return request("/account/profile", { method: "PATCH", body: JSON.stringify({ display_name: displayName }) });
}
export function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  return request("/account/password", { method: "POST", body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) });
}
export function listDeviceGroups(signal?: AbortSignal): Promise<{ devices: DeviceGroup[] }> {
  return request("/account/devices", { signal });
}
export function revokeDeviceGroup(id: string): Promise<{ current_revoked: boolean }> {
  return request(`/account/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export function logoutAllDevices(): Promise<void> { return request("/account/logout-all", { method: "POST" }); }
export function listHouseholdMembers(signal?: AbortSignal): Promise<{ members: HouseholdMember[] }> {
  return request("/household/members", { signal });
}
export function removeHouseholdMember(id: string): Promise<void> {
  return request(`/household/members/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export function listHouseholdInvites(signal?: AbortSignal): Promise<{ invites: HouseholdInvite[] }> {
  return request("/household/invites", { signal });
}
export function createHouseholdInvite(): Promise<{ invite: HouseholdInvite; code: string }> {
  return request("/household/invites", { method: "POST" });
}
export function revokeHouseholdInvite(id: string): Promise<void> {
  return request(`/household/invites/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export function joinHousehold(input: {
  code: string;
  username: string;
  display_name: string;
  password: string;
  remember: boolean;
  device_name?: string;
}): Promise<MeResponse> {
  return request("/auth/join", { method: "POST", body: JSON.stringify(input) });
}

export function browserDeviceName(): string {
  if (/Android/i.test(navigator.userAgent)) return "Android 手机";
  if (/iPhone|iPad/i.test(navigator.userAgent)) return "iPhone / iPad";
  return "浏览器";
}
