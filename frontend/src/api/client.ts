import { captureSession, notifyUnauthorized } from "./sessionEvents";

export type User = {
  id: string;
  username: string;
  display_name: string;
  role: "owner" | "member";
};

export type Household = {
  id: string;
  name: string;
};

export type MeResponse = {
  user: User;
  household: Household;
};

export type SetupResponse = {
  user: User;
  household: Household;
};

export type RoomSummary = {
  id: string;
  version: number;
  floor_id: string;
  name: string;
  width_cm: number;
  depth_cm: number;
  height_cm: number;
  wall_color: string | null;
  sort: number;
  container_count: number;
};

export type Floor = {
  id: string;
  name: string;
  level: number;
  rooms: RoomSummary[];
};

export type Bootstrap = {
  user: User;
  household: Household;
  floors: Floor[];
};

export type Compartment = {
  id: string;
  container_id: string;
  name: string;
  custom_name?: string | null;
  default_name?: string;
  kind: "shelf" | "drawer" | "grid" | "box" | "surface";
  level_index: number;
  row: number;
  col: number;
  sort: number;
};

export type Container = {
  version: number;
  id: string;
  room_id: string;
  preset: string;
  name: string;
  x_cm: number;
  z_cm: number;
  y_cm: number;
  rot_deg: number;
  width_cm: number;
  depth_cm: number;
  height_cm: number;
  color: string | null;
  config: { layers?: number; cols?: number; doors?: number; [key: string]: unknown };
  compartments: Compartment[];
  item_count: number;
};

export type RoomDetail = {
  room: RoomSummary;
  containers: Container[];
};

export type ContainerWriteResponse = { container: Container; rooms?: RoomSummary[] };

export class ApiError extends Error {
  status: number;
  code: string;
  current?: Item;
  currentContainer?: Container;
  currentRoom?: RoomSummary;

  constructor(status: number, code: string, message: string, current?: Item | Container | RoomSummary) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    if (current && "compartments" in current) this.currentContainer = current;
    else if (current && "floor_id" in current) this.currentRoom = current;
    else this.current = current;
  }
}

export type ApiRequestInit = RequestInit & { timeoutMs?: number };

export async function request<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { timeoutMs, signal, ...options } = init;
  if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
  const write = !["GET", "HEAD", "OPTIONS"].includes((options.method ?? "GET").toUpperCase());
  const limit = timeoutMs ?? (write ? 30_000 : 15_000);
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const owner = captureSession();
  const controller = new AbortController();
  let rejectStopped: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  const cancel = () => { rejectStopped(new DOMException("请求已取消", "AbortError")); controller.abort(); };
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = limit > 0 ? globalThis.setTimeout(() => {
    rejectStopped(new ApiError(0, "request_timeout", write
      ? "请求超时，保存结果尚未确认，请先刷新核对后再尝试"
      : "读取超时，请检查连接后重试"));
    controller.abort();
  }, limit) : undefined;
  try {
    if (signal?.aborted) { cancel(); return await stopped; }
    return await Promise.race([(async () => {
      const response = await fetch(`${import.meta.env.BASE_URL}api${path}`, {
        ...options, headers, credentials: "include", signal: controller.signal,
      });
      if (controller.signal.aborted) throw new DOMException("请求已取消", "AbortError");
      // Notify from headers so a hung or malformed 401 body cannot keep expired
      // private UI open. Aborted and previous-generation responses are ignored.
      notifyUnauthorized(owner, path, response.status);
      if (response.status === 204) return undefined as T;
      const body = await response.json().catch(() => null);
      if (controller.signal.aborted) throw new DOMException("请求已取消", "AbortError");
      if (!response.ok) {
        const code = typeof body?.error?.code === "string" ? body.error.code : "request_failed";
        const message = typeof body?.error?.message === "string" ? body.error.message : `请求失败（${response.status}）`;
        throw new ApiError(response.status, code, message, body?.error?.current_room ?? body?.error?.current);
      }
      if (body === null || typeof body !== "object") {
        throw new ApiError(response.status, "invalid_response", write
          ? "服务器返回了无效响应，保存结果尚未确认，请先刷新核对后再尝试"
          : "服务器返回了无效响应，请稍后重试");
      }
      return body as T;
    })(), stopped]);
  } catch (error) {
    if (error instanceof ApiError || (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")) throw error;
    throw new ApiError(0, "network_error", write
      ? "网络异常，保存结果尚未确认，请先刷新核对后再尝试"
      : "网络连接失败，请检查连接后重试");
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export function getSetupStatus(): Promise<{ needed: boolean }> {
  return request("/setup/status");
}

export function setup(input: {
  token: string;
  household_name: string;
  username: string;
  password: string;
}): Promise<SetupResponse> {
  return request("/setup", { method: "POST", body: JSON.stringify(input) });
}

export function login(input: {
  username: string;
  password: string;
  remember: boolean;
  device_name?: string;
}): Promise<{ user: User }> {
  return request("/auth/login", { method: "POST", body: JSON.stringify(input) });
}

export function logout(): Promise<void> {
  return request("/auth/logout", { method: "POST" });
}

export function getMe(): Promise<MeResponse> {
  return request("/me");
}

export function getBootstrap(): Promise<Bootstrap> {
  return request("/bootstrap");
}

export function createRoom(input: {
  name: string;
  floor_id?: string;
  width_cm: number;
  depth_cm: number;
  height_cm: number;
}): Promise<{ room: RoomSummary }> {
  return request("/rooms", { method: "POST", body: JSON.stringify(input) });
}

export function getRoom(roomId: string): Promise<RoomDetail> {
  return request(`/rooms/${roomId}`);
}

export type RoomPatch = Partial<Pick<RoomSummary, "name" | "width_cm" | "depth_cm" | "height_cm" | "wall_color">> & { expected_version: number };

export function updateRoom(
  roomId: string,
  input: RoomPatch
): Promise<{ room: RoomSummary }> {
  return request(`/rooms/${roomId}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteRoom(roomId: string, expectedVersion: number): Promise<void> {
  return request(`/rooms/${encodeURIComponent(roomId)}?expected_version=${encodeURIComponent(String(expectedVersion))}`, { method: "DELETE" });
}

export function createContainer(input: {
  room_id: string;
  preset: string;
  name: string;
  x_cm: number;
  z_cm: number;
  y_cm?: number;
  rot_deg?: number;
  width_cm: number;
  depth_cm: number;
  height_cm: number;
  color?: string;
  config?: Record<string, unknown>;
}): Promise<ContainerWriteResponse> {
  return request("/containers", { method: "POST", body: JSON.stringify(input) });
}

export type ContainerPatch = Partial<{
  expected_version: number;
  room_id: string;
  name: string;
  x_cm: number;
  z_cm: number;
  y_cm: number;
  rot_deg: number;
  width_cm: number;
  depth_cm: number;
  height_cm: number;
  color: string;
  config: Record<string, unknown>;
}>;

export function updateContainer(
  containerId: string,
  input: ContainerPatch
): Promise<ContainerWriteResponse> {
  return request(`/containers/${containerId}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteContainer(containerId: string, expectedVersion: number): Promise<void> {
  return request(`/containers/${encodeURIComponent(containerId)}?expected_version=${encodeURIComponent(String(expectedVersion))}`, { method: "DELETE" });
}

export function renameCompartment(compartmentId: string, expectedContainerVersion: number, customName: string | null): Promise<ContainerWriteResponse> {
  return request(`/compartments/${compartmentId}`, {
    method: "PATCH", body: JSON.stringify({ expected_container_version: expectedContainerVersion, custom_name: customName }),
  });
}

export type Item = {
  id: string;
  name: string;
  aliases: string[];
  notes: string | null;
  quantity: number;
  compartment_id: string | null;
  room_id: string | null;
  container_id: string | null;
  location_path: string[];
  photo_url: string | null;
  thumbnail_url?: string | null;
  version: number;
  location_status: "confirmed" | "missing";
  last_confirmed_at: string | null;
  updated_at: string;
  archived_at: string | null;
  archive_reason: string | null;
};

export type ItemPatch = Partial<Pick<Item, "name" | "aliases" | "notes" | "quantity" | "compartment_id">> & { expected_version: number };

export type ItemListOptions = { page?: number; pageSize?: number; roomId?: string; locationStatus?: "confirmed" | "missing" };
export type ItemListResponse = { items: Item[]; total?: number; page?: number; page_size?: number; has_more?: boolean };
export function listItems(q = "", compartmentId = "", signal?: AbortSignal, status: "active" | "archived" = "active", options: ItemListOptions = {}): Promise<ItemListResponse> {
  const params = new URLSearchParams();
  params.set("status", status);
  if (q.trim()) params.set("q", q.trim());
  if (compartmentId) params.set("compartment_id", compartmentId);
  if (options.page !== undefined) params.set("page", String(options.page));
  if (options.pageSize !== undefined) params.set("page_size", String(options.pageSize));
  if (options.roomId) params.set("room_id", options.roomId);
  if (options.locationStatus) params.set("location_status", options.locationStatus);
  return request(`/items?${params}`, { signal });
}

export function getItem(id: string): Promise<{ item: Item }> { return request(`/items/${id}`); }
export function registerItems(compartmentId: string, names: string[], operationId: string): Promise<{ items: Item[] }> {
  return request("/items/batch", { method: "POST", body: JSON.stringify({ compartment_id: compartmentId, names, operation_id: operationId }) });
}
export function patchItem(id: string, patch: ItemPatch): Promise<{ item: Item }> {
  return request(`/items/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}
export function confirmItem(id: string, version: number, missing = false): Promise<{ item: Item }> {
  return request(`/items/${id}/${missing ? "missing" : "confirm"}`, { method: "POST", body: JSON.stringify({ expected_version: version }) });
}
export function uploadItemPhoto(id: string, version: number, image: File): Promise<{ item: Item }> {
  const body = new FormData(); body.set("image", image); body.set("expected_version", String(version));
  return request(`/items/${id}/photo`, { method: "POST", body, timeoutMs: 90_000 });
}

export type ItemEventType = "create" | "update" | "move" | "confirm" | "missing" | "photo" | "archive" | "restore" | "container_move" | "undo";
export type ItemEvent = {
  id: string;
  type: ItemEventType;
  created_at: string;
  actor_name: string | null;
  from_path: string[] | null;
  to_path: string[] | null;
  changes: Record<string, { before: unknown; after: unknown }>;
  item_version: number | null;
  can_undo: boolean;
  legacy: boolean;
};
export function archiveItem(id: string, version: number, reason: string): Promise<{ item: Item }> {
  return request(`/items/${id}/archive`, { method: "POST", body: JSON.stringify({ expected_version: version, reason }) });
}
export function restoreItem(id: string, version: number, compartmentId: string): Promise<{ item: Item }> {
  return request(`/items/${id}/restore`, { method: "POST", body: JSON.stringify({ expected_version: version, compartment_id: compartmentId }) });
}
export function getItemEvents(id: string, offset = 0, signal?: AbortSignal): Promise<{ events: ItemEvent[]; has_more: boolean }> {
  return request(`/items/${id}/events?limit=50&offset=${offset}`, { signal });
}
export function undoItemMove(id: string, eventId: string, version: number): Promise<{ item: Item }> {
  return request(`/items/${id}/events/${eventId}/undo`, { method: "POST", body: JSON.stringify({ expected_version: version }) });
}
