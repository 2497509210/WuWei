import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "../../frontend/src/store/useWorkspace";
import { ApiError, type Bootstrap, type Container, type RoomDetail, type RoomSummary } from "../../frontend/src/api/client";

const room = (id: string): RoomSummary => ({ id, floor_id: "f", name: id, width_cm: 460, depth_cm: 360, height_cm: 260, wall_color: null, sort: 0, container_count: 1, version: 1 });
const cabinet: Container = { id: "c", room_id: "a", name: "衣柜", preset: "wardrobe", x_cm: 100, z_cm: 80, y_cm: 0, rot_deg: 0, width_cm: 180, depth_cm: 58, height_cm: 220, color: null, config: { layers: 3, cols: 1 }, compartments: [], item_count: 0, version: 1 };
const detail = (id: string, containers: Container[] = []): RoomDetail => ({ room: room(id), containers });
const bootstrap: Bootstrap = { user: { id: "u", username: "owner", display_name: "家人", role: "owner" }, household: { id: "h", name: "我家" }, floors: [{ id: "f", name: "1层", level: 1, rooms: [room("a"), room("b")] }] };
type Pending = { path: string; init: RequestInit; respond: (body: unknown, status?: number) => void };
let requests: Pending[];
const flush = async () => { for (let i = 0; i < 18; i++) await Promise.resolve(); };
function take(path: string, method = "GET") {
  const index = requests.findIndex(request => request.path.endsWith(path) && (request.init.method ?? "GET") === method);
  if (index < 0) throw new Error(`No pending ${method} ${path}`);
  return requests.splice(index, 1)[0];
}
async function enter(id: string, containers: Container[] = []) {
  const reading = useWorkspace.getState().selectRoom(id);
  take(`/rooms/${id}`).respond(detail(id, containers));
  await reading;
}
beforeEach(() => {
  useWorkspace.getState().reset();
  useWorkspace.setState({ bootstrap });
  requests = [];
  vi.stubGlobal("fetch", (path: string, init: RequestInit = {}) => new Promise<Response>(resolve => requests.push({ path: String(path), init,
    respond: (body, status = 200) => resolve(new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })),
  })));
});
afterEach(() => { useWorkspace.getState().reset(); vi.unstubAllGlobals(); });

describe("room editing store", () => {
  it("updates room summary and navigation without losing containers", async () => {
    await enter("a", [cabinet]);
    const saving = useWorkspace.getState().saveRoom("a", { expected_version: 1, name: "书房", width_cm: 500 });
    await flush();
    const write = take("/rooms/a", "PATCH");
    expect(JSON.parse(String(write.init.body)).expected_version).toBe(1);
    const updated = { ...room("a"), name: "书房", width_cm: 500, version: 2 };
    write.respond({ room: updated });
    expect((await saving).ok).toBe(true);
    expect(useWorkspace.getState().room?.room).toEqual(updated);
    expect(useWorkspace.getState().room?.containers).toEqual([cabinet]);
    expect(useWorkspace.getState().bootstrap?.floors[0].rooms[0]).toEqual(updated);
  });

  it("keeps another room visible when an earlier room edit completes", async () => {
    await enter("a", [cabinet]);
    const saving = useWorkspace.getState().saveRoom("a", { expected_version: 1, name: "书房" });
    await flush(); const write = take("/rooms/a", "PATCH");
    await enter("b");
    write.respond({ room: { ...room("a"), name: "书房", version: 2 } }); await saving;
    expect(useWorkspace.getState().room?.room.id).toBe("b");
    expect(useWorkspace.getState().activeRoomId).toBe("b");
    expect(useWorkspace.getState().bootstrap?.floors[0].rooms[0].name).toBe("书房");
  });

  it("ignores an old room read arriving after a room edit", async () => {
    await enter("a");
    const refreshing = useWorkspace.getState().refreshRoom(); const old = take("/rooms/a");
    const saving = useWorkspace.getState().saveRoom("a", { expected_version: 1, name: "书房" });
    await flush(); take("/rooms/a", "PATCH").respond({ room: { ...room("a"), name: "书房", version: 2 } }); await saving;
    old.respond(detail("a")); await refreshing;
    expect(useWorkspace.getState().room?.room.name).toBe("书房");
  });

  it("waits for earlier container writes and blocks later ones until the room edit settles", async () => {
    await enter("a", [cabinet]);
    const moving = useWorkspace.getState().patchContainer("c", { x_cm: 180 });
    const editing = useWorkspace.getState().saveRoom("a", { expected_version: 1, width_cm: 500 });
    const resizing = useWorkspace.getState().patchContainer("c", { height_cm: 210 });
    await flush();
    expect(requests.map(request => request.path.split("api")[1])).toEqual(["/containers/c"]);
    take("/containers/c", "PATCH").respond({ container: { ...cabinet, x_cm: 180, version: 2 } });
    await moving; await flush();
    expect(requests).toHaveLength(1);
    take("/rooms/a", "PATCH").respond({ room: { ...room("a"), width_cm: 500, version: 2 } });
    await editing; await flush();
    const next = take("/containers/c", "PATCH");
    expect(JSON.parse(String(next.init.body)).expected_version).toBe(2);
    next.respond({ container: { ...cabinet, x_cm: 180, height_cm: 210, version: 3 } }); await resizing;
    expect(useWorkspace.getState().room?.room.width_cm).toBe(500);
    expect(useWorkspace.getState().room?.containers[0].x_cm).toBe(180);
  });

  it("requires explicit reload after a room version conflict before another edit", async () => {
    await enter("a");
    const editing = useWorkspace.getState().saveRoom("a", { expected_version: 1, name: "旧草稿" });
    await flush();
    take("/rooms/a", "PATCH").respond({ error: { code: "room_version_conflict", message: "房间已更新", current_room: { ...room("a"), name: "新名称", version: 2 } } }, 409);
    expect(await editing).toMatchObject({ ok: false, conflict: true });
    expect((await useWorkspace.getState().saveRoom("a", { expected_version: 1, name: "仍是旧草稿" })).ok).toBe(false);
    expect(requests).toHaveLength(0);
    const refresh = useWorkspace.getState().reloadRoom("a"); await flush();
    take("/rooms/a").respond({ room: { ...room("a"), name: "新名称", version: 2 }, containers: [] });
    expect((await refresh)?.version).toBe(2);
    const second = useWorkspace.getState().saveRoom("a", { expected_version: 2, name: "确认后的名称" }); await flush();
    take("/rooms/a", "PATCH").respond({ room: { ...room("a"), name: "确认后的名称", version: 3 } });
    expect((await second).ok).toBe(true);
  });

  it("reports a failed room save without changing the confirmed room and retries the same draft", async () => {
    await enter("a");
    const saving = useWorkspace.getState().saveRoom("a", { expected_version: 1, name: "书房" }); await flush();
    take("/rooms/a", "PATCH").respond({ error: { code: "offline", message: "保存失败" } }, 503);
    expect(await saving).toMatchObject({ ok: false, conflict: false });
    expect(useWorkspace.getState().room?.room.name).toBe("a");
    const retry = useWorkspace.getState().retryLastMutation(); await flush();
    const write = take("/rooms/a", "PATCH");
    expect(JSON.parse(String(write.init.body))).toEqual({ expected_version: 1, name: "书房" });
    write.respond({ room: { ...room("a"), name: "书房", version: 2 } });
    expect(await retry).toBe(true);
  });

  it("separates room conflict snapshots from item and container snapshots", () => {
    const error = new ApiError(409, "room_version_conflict", "已更新", room("a"));
    expect(error.currentRoom).toEqual(room("a"));
    expect(error.current).toBeUndefined();
    expect(error.currentContainer).toBeUndefined();
  });

  it("waits for a pending room edit when navigating back to that room", async () => {
    await enter("a");
    const saving = useWorkspace.getState().saveRoom("a", { expected_version: 1, name: "书房" });
    await flush(); const write = take("/rooms/a", "PATCH");
    await enter("b");
    const back = useWorkspace.getState().selectRoom("a"); await flush();
    expect(requests).toHaveLength(0);
    write.respond({ room: { ...room("a"), name: "书房", version: 2 } });
    await saving; await flush();
    take("/rooms/a").respond({ room: { ...room("a"), name: "书房", version: 2 }, containers: [] });
    await back;
    expect(useWorkspace.getState().room?.room.name).toBe("书房");
  });

  it("lets a room edit await an incoming container move before submitting bounds", async () => {
    await enter("a", [cabinet]);
    const moving = useWorkspace.getState().patchContainer("c", { room_id: "b" });
    await flush(); const move = take("/containers/c", "PATCH");
    // An already visible destination may still be edited while the write is in flight.
    useWorkspace.setState({ activeRoomId: "b", room: detail("b") });
    const editing = useWorkspace.getState().saveRoom("b", { expected_version: 1, width_cm: 600 });
    await flush(); expect(requests).toHaveLength(0);
    move.respond({ container: { ...cabinet, room_id: "b", version: 2 } });
    await moving; await flush();
    take("/rooms/b", "PATCH").respond({ room: { ...room("b"), width_cm: 600, version: 2 } });
    expect((await editing).ok).toBe(true);
  });
});
