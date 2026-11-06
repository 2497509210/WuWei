import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "../../frontend/src/store/useWorkspace";
import type { Bootstrap, Container, RoomDetail } from "../../frontend/src/api/client";

// The network is the only fake: these tests exercise the real API client and store.
type Pending = { path: string; init: RequestInit; respond: (body: unknown, status?: number) => void };
let requests: Pending[];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function container(roomId = "a", id = "cabinet"): Container {
  return { id, room_id: roomId, preset: "wardrobe", name: "衣柜", x_cm: 100, z_cm: 80,
    y_cm: 0, rot_deg: 0, width_cm: 180, depth_cm: 58, height_cm: 220, color: null,
    config: { layers: 3, cols: 1 }, compartments: [], item_count: 0, version: 1 };
}
function detail(id: string, containers: Container[] = []): RoomDetail {
  return { room: { id, floor_id: "floor", name: id, width_cm: 460, depth_cm: 360,
    height_cm: 260, wall_color: null, sort: 0, container_count: containers.length }, containers };
}
const bootstrap: Bootstrap = { user: { id: "user", username: "owner", display_name: "Owner", role: "owner" },
  household: { id: "home", name: "我家" }, floors: [{ id: "floor", name: "1 层", level: 1,
    rooms: [detail("a").room, detail("b").room] }] };
function take(path: string, method = "GET") {
  const index = requests.findIndex((r) => new URL(r.path, "http://localhost").pathname.endsWith(path) && (r.init.method ?? "GET") === method);
  if (index < 0) throw new Error(`No pending ${method} ${path}`);
  return requests.splice(index, 1)[0];
}
async function enter(id: string, containers: Container[] = []) {
  const loading = useWorkspace.getState().selectRoom(id);
  take(`/rooms/${id}`).respond(detail(id, containers));
  await loading;
}
beforeEach(() => {
  useWorkspace.getState().reset?.();
  useWorkspace.setState({ bootstrap, activeRoomId: null, room: null, selectedContainerId: null,
    editMode: false, loading: false, error: "" });
  requests = [];
  vi.stubGlobal("fetch", (path: string, init: RequestInit = {}) => new Promise<Response>((resolve) => {
    requests.push({ path: String(path), init, respond: (body, status = 200) => resolve(new Response(
      status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) });
  }));
});
afterEach(() => { useWorkspace.getState().reset?.(); vi.unstubAllGlobals(); });

describe("compartment naming writes", () => {
  const shelf = { id:"shelf",container_id:"cabinet",name:"顶层",custom_name:null,default_name:"顶层",kind:"shelf",level_index:0,row:0,col:0,sort:0 };
  // Naming and sizing touch one container version and must execute in the same server order.
  it("orders names after dimensions and carries the resulting version into the next layout write", async () => {
    await enter("a",[{...container(),compartments:[shelf]}]);
    const size = useWorkspace.getState().patchContainer("cabinet",{width_cm:190});
    const renaming = useWorkspace.getState().renameCompartment("cabinet","shelf","证件抽屉");
    await flush();
    expect(requests.some(r=>r.path.endsWith("/compartments/shelf"))).toBe(false);
    take("/containers/cabinet","PATCH").respond({container:{...container(),width_cm:190,version:2,compartments:[shelf]}});
    await size; await flush();
    const rename = take("/compartments/shelf","PATCH");
    expect(JSON.parse(String(rename.init.body))).toEqual({expected_container_version:2,custom_name:"证件抽屉"});
    const named = {...container(),width_cm:190,version:3,compartments:[{...shelf,name:"证件抽屉",custom_name:"证件抽屉"}]};
    rename.respond({container:named});
    expect(await renaming).toBe(true);
    expect(useWorkspace.getState().room?.containers[0].compartments[0].name).toBe("证件抽屉");
    const resize = useWorkspace.getState().patchContainer("cabinet",{height_cm:210}); await flush();
    const request = take("/containers/cabinet","PATCH");
    expect(JSON.parse(String(request.init.body)).expected_version).toBe(3);
    request.respond({container:{...named,height_cm:210,version:4}}); await resize;
  });
  // A conflict must reload, not resend the old custom name over another user's edit.
  it("reloads a naming conflict without overwriting the latest custom name", async () => {
    await enter("a",[{...container(),compartments:[shelf]}]);
    const naming = useWorkspace.getState().renameCompartment("cabinet","shelf","旧名称"); await flush();
    take("/compartments/shelf","PATCH").respond({error:{code:"version_conflict",message:"容器已被更新"}},409);
    expect(await naming).toBe(false);
    const retry = useWorkspace.getState().retryLastMutation(); await flush();
    take("/rooms/a").respond(detail("a",[{...container(),version:2,compartments:[{...shelf,name:"新名称",custom_name:"新名称"}]}]));
    expect(await retry).toBe(false);
    expect(useWorkspace.getState().room?.containers[0].compartments[0].name).toBe("新名称");
    expect(requests).toHaveLength(0);
  });
  // Names saved in a room that was left must not replace the new room or steal its selection.
  it("does not replace another room when a naming response arrives late", async () => {
    await enter("a",[{...container(),compartments:[shelf]}]);
    const naming = useWorkspace.getState().renameCompartment("cabinet","shelf","证件抽屉"); await flush();
    const request = take("/compartments/shelf","PATCH");
    await enter("b",[container("b","other")]);
    request.respond({container:{...container(),version:2,compartments:[{...shelf,name:"证件抽屉",custom_name:"证件抽屉"}]}});
    await naming;
    expect(useWorkspace.getState().room?.room.id).toBe("b");
    expect(useWorkspace.getState().room?.containers[0].id).toBe("other");
  });
});

describe("workspace request ordering", () => {
  // Missing request ownership lets a slow earlier selection replace the current room.
  it("keeps the most recently selected room when responses arrive in reverse order", async () => {
    const a = useWorkspace.getState().selectRoom("a");
    const b = useWorkspace.getState().selectRoom("b");
    take("/rooms/b").respond(detail("b")); await b;
    take("/rooms/a").respond(detail("a")); await a;
    expect(useWorkspace.getState().activeRoomId).toBe("b");
    expect(useWorkspace.getState().room?.room.id).toBe("b");
  });
  // A bootstrap request must not implicitly override navigation made while it was loading.
  it("does not let an earlier load replace a room selected while bootstrap was in flight", async () => {
    const loading = useWorkspace.getState().load();
    await enter("b");
    take("/bootstrap").respond(bootstrap); await flush();
    const late = requests.find((r) => r.path.includes("/rooms/"));
    late?.respond(detail("a")); await loading;
    expect(useWorkspace.getState().room?.room.id).toBe("b");
  });
  // A refresh snapshot taken before a save must not undo the saved dimensions.
  it("ignores a stale refresh that completes after a container save", async () => {
    await enter("a", [container()]);
    const refresh = useWorkspace.getState().refreshRoom();
    const old = take("/rooms/a");
    const save = useWorkspace.getState().patchContainer("cabinet", { width_cm: 200 }); await flush();
    take("/containers/cabinet", "PATCH").respond({ container: { ...container(), width_cm: 200, version: 2 } });
    await save; old.respond(detail("a", [container()])); await refresh;
    expect(useWorkspace.getState().room?.containers[0].width_cm).toBe(200);
  });
  // Logout needs to invalidate outstanding reads instead of repopulating private workspace data.
  it("reset invalidates pending room responses", async () => {
    const loading = useWorkspace.getState().selectRoom("a");
    useWorkspace.getState().reset();
    take("/rooms/a").respond(detail("a", [container()])); await loading;
    expect(useWorkspace.getState().room).toBeNull();
    expect(useWorkspace.getState().activeRoomId).toBeNull();
  });
});

describe("workspace saves", () => {
  // Losing the pre-drag server position would make a failed save appear successful.
  it("rolls a failed drag back and retries the intended position with visible status", async () => {
    await enter("a", [container()]);
    useWorkspace.getState().moveLocal("cabinet", 220, 140);
    const save = useWorkspace.getState().patchContainer("cabinet", { x_cm: 220, z_cm: 140 }); await flush();
    expect(useWorkspace.getState().saveStatus).toBe("saving");
    take("/containers/cabinet", "PATCH").respond({ error: { code: "save_failed", message: "保存失败" } }, 500);
    expect(await save).toBe(false);
    expect(useWorkspace.getState().room?.containers[0].x_cm).toBe(100);
    expect(useWorkspace.getState().error).toContain("保存失败");
    expect(useWorkspace.getState().saveStatus).toBe("error");
    const retry = useWorkspace.getState().retryLastMutation(); await flush();
    take("/containers/cabinet", "PATCH").respond({ container: { ...container(), x_cm: 220, z_cm: 140, version: 2 } });
    expect(await retry).toBe(true);
    expect(useWorkspace.getState().room?.containers[0].x_cm).toBe(220);
    expect(useWorkspace.getState().saveStatus).toBe("saved");
    expect(useWorkspace.getState().error).toBe("");
  });
  // An early patch response must not jump a later drag back, and writes need server ordering.
  it("serializes saves and preserves the newer optimistic drag while the first save completes", async () => {
    await enter("a", [container()]);
    useWorkspace.getState().moveLocal("cabinet", 150, 80);
    const first = useWorkspace.getState().patchContainer("cabinet", { x_cm: 150 }); await flush();
    const firstRequest = take("/containers/cabinet", "PATCH");
    useWorkspace.getState().moveLocal("cabinet", 200, 80);
    const second = useWorkspace.getState().patchContainer("cabinet", { x_cm: 200 }); await flush();
    firstRequest.respond({ container: { ...container(), x_cm: 150, version: 2 } }); await first; await flush();
    expect(useWorkspace.getState().room?.containers[0].x_cm).toBe(200);
    const secondRequest = take("/containers/cabinet", "PATCH");
    expect(JSON.parse(String(secondRequest.init.body)).expected_version).toBe(2);
    secondRequest.respond({ container: { ...container(), x_cm: 200, version: 3 } }); await second;
    expect(useWorkspace.getState().room?.containers[0].x_cm).toBe(200);
  });
  // A creation started in room A must neither replace room B nor select A's new cabinet.
  it("keeps room B intact when a container creation for room A finishes", async () => {
    await enter("a");
    const adding = useWorkspace.getState().addContainer("wardrobe", { name: "衣柜", width: 180, depth: 58, height: 220 });
    await flush(); const request = take("/containers", "POST");
    await enter("b", [container("b", "other")]);
    request.respond({ container: container() }); await flush();
    for (const pending of requests.splice(0)) pending.respond(detail("b", [container("b", "other")]));
    await adding;
    expect(useWorkspace.getState().room?.room.id).toBe("b");
    expect(useWorkspace.getState().room?.containers.map((c) => c.id)).toEqual(["other"]);
    expect(useWorkspace.getState().selectedContainerId).toBeNull();
  });
  // A deletion must update its originating room's count, not the current room's count.
  it("does not change room B selection or count when deleting a container from room A", async () => {
    await enter("a", [container()]);
    const removing = useWorkspace.getState().removeContainer("cabinet"); await flush();
    const request = take("/containers/cabinet", "DELETE");
    await enter("b", [container("b", "other")]); useWorkspace.getState().selectContainer("other");
    request.respond(null, 204); await removing;
    expect(useWorkspace.getState().selectedContainerId).toBe("other");
    expect(useWorkspace.getState().room?.containers.map((c) => c.id)).toEqual(["other"]);
    expect(useWorkspace.getState().room?.room.container_count).toBe(1);
  });
  // Fire-and-forget refresh failures must be represented in state, never unhandled rejections.
  it("reports refresh failure and allows dismissal", async () => {
    await enter("a"); const refresh = useWorkspace.getState().refreshRoom();
    take("/rooms/a").respond({ error: { code: "offline", message: "连接失败" } }, 503);
    await refresh;
    expect(useWorkspace.getState().error).toContain("连接失败");
    useWorkspace.getState().dismissError();
    expect(useWorkspace.getState().error).toBe("");
  });
  // Retrying an optimistic-lock conflict must read the other device's changes, never resend stale edits.
  it("refreshes after a conflict retry and requires a new edit instead of overwriting the other device", async () => {
    await enter("a", [container()]);
    const save = useWorkspace.getState().patchContainer("cabinet", { width_cm: 200 }); await flush();
    take("/containers/cabinet", "PATCH").respond({ error: { code: "version_conflict", message: "已被其他设备修改" } }, 409);
    expect(await save).toBe(false);
    expect(useWorkspace.getState().saveStatus).toBe("error");
    const retry = useWorkspace.getState().retryLastMutation(); await flush();
    take("/rooms/a").respond(detail("a", [{ ...container(), width_cm: 220, version: 2 }]));
    expect(await retry).toBe(false);
    expect(useWorkspace.getState().room?.containers[0].width_cm).toBe(220);
    expect(requests.filter((r) => r.init.method === "PATCH")).toHaveLength(0);
  });
  // Completing an old room's save must not cancel or leave a new room's read stuck loading.
  it("allows room B to finish loading when a room A save completes first", async () => {
    await enter("a", [container()]);
    const save = useWorkspace.getState().patchContainer("cabinet", { width_cm: 200 }); await flush();
    const write = take("/containers/cabinet", "PATCH");
    const navigation = useWorkspace.getState().selectRoom("b");
    write.respond({ container: { ...container(), width_cm: 200, version: 2 } }); await save;
    take("/rooms/b").respond(detail("b")); await navigation;
    expect(useWorkspace.getState().room?.room.id).toBe("b");
    expect(useWorkspace.getState().loading).toBe(false);
  });
  // A stale server view during an in-flight mutation must not undo the latest local drag.
  it("waits for pending writes before refreshing the same room", async () => {
    await enter("a", [container()]);
    useWorkspace.getState().moveLocal("cabinet", 200, 80);
    const save = useWorkspace.getState().patchContainer("cabinet", { x_cm: 200 }); await flush();
    const write = take("/containers/cabinet", "PATCH");
    const refresh = useWorkspace.getState().refreshRoom(); await flush();
    const premature = requests.find((r) => r.path.endsWith("/rooms/a"));
    premature?.respond(detail("a", [container()])); await flush();
    expect(useWorkspace.getState().room?.containers[0].x_cm).toBe(200);
    write.respond({ container: { ...container(), x_cm: 200, version: 2 } }); await save; await flush();
    const refreshed = requests.find((r) => r.path.endsWith("/rooms/a") && r !== premature);
    refreshed?.respond(detail("a", [{ ...container(), x_cm: 200, version: 2 }])); await refresh;
    expect(useWorkspace.getState().room?.containers[0].x_cm).toBe(200);
  });
  // A queued successor must not replay automatically after the server rejected its predecessor's version.
  it("halts queued edits after a version conflict", async () => {
    await enter("a", [container()]);
    const first = useWorkspace.getState().patchContainer("cabinet", { width_cm: 200 }); await flush();
    const write = take("/containers/cabinet", "PATCH");
    const second = useWorkspace.getState().patchContainer("cabinet", { width_cm: 210 }); await flush();
    write.respond({ error: { code: "version_conflict", message: "已被其他设备修改" } }, 409);
    expect(await first).toBe(false); await flush();
    const unexpected = requests.find((r) => r.init.method === "PATCH");
    unexpected?.respond({ container: { ...container(), width_cm: 210, version: 3 } });
    expect(await second).toBe(false);
    expect(useWorkspace.getState().room?.containers[0].width_cm).toBe(180);
  });
  // Moving a whole container must remove its old-room representation and keep room counts accurate.
  it("removes a relocated container from its old room", async () => {
    await enter("a", [container()]);
    useWorkspace.getState().selectContainer("cabinet");
    useWorkspace.setState({ bootstrap: { ...bootstrap, floors: [{ ...bootstrap.floors[0],
      rooms: [{ ...detail("a").room, container_count: 1 }, detail("b").room] }] } });
    const moving = useWorkspace.getState().patchContainer("cabinet", { room_id: "b" }); await flush();
    take("/containers/cabinet", "PATCH").respond({ container: { ...container(), room_id: "b", version: 2 } });
    expect(await moving).toBe(true);
    expect(useWorkspace.getState().room?.containers).toEqual([]);
    expect(useWorkspace.getState().selectedContainerId).toBeNull();
    expect(useWorkspace.getState().bootstrap?.floors[0].rooms.map((r) => r.container_count)).toEqual([0, 1]);
  });
  // A blocked direct edit after a conflict must never be presented as a successful save.
  it("keeps the conflict visible if the user edits again before refreshing", async () => {
    await enter("a", [container()]);
    const first = useWorkspace.getState().patchContainer("cabinet", { width_cm: 200 }); await flush();
    take("/containers/cabinet", "PATCH").respond({ error: { code: "version_conflict", message: "已被其他设备修改" } }, 409);
    await first;
    expect(await useWorkspace.getState().patchContainer("cabinet", { width_cm: 210 })).toBe(false);
    expect(useWorkspace.getState().saveStatus).toBe("error");
    expect(useWorkspace.getState().error).not.toBe("");
  });
  // Later queued edits cannot leave a relocated cabinet in its old room or double-count relocation.
  it("settles a queued edit after a relocation without duplicating room counts", async () => {
    await enter("a", [container()]);
    useWorkspace.setState({ bootstrap: { ...bootstrap, floors: [{ ...bootstrap.floors[0],
      rooms: [{ ...detail("a").room, container_count: 1 }, detail("b").room] }] } });
    const moving = useWorkspace.getState().patchContainer("cabinet", { room_id: "b" }); await flush();
    const request = take("/containers/cabinet", "PATCH");
    const changing = useWorkspace.getState().patchContainer("cabinet", { width_cm: 190 }); await flush();
    request.respond({ container: { ...container(), room_id: "b", version: 2 } }); await moving; await flush();
    const successor = requests.find((r) => r.init.method === "PATCH");
    successor?.respond({ container: { ...container(), room_id: "b", width_cm: 190, version: 3 } });
    await changing;
    expect(useWorkspace.getState().room?.containers).toEqual([]);
    expect(useWorkspace.getState().bootstrap?.floors[0].rooms.map((r) => r.container_count)).toEqual([0, 1]);
  });
  // Navigating to the destination during relocation must not freeze its pre-move snapshot in the UI.
  it("loads the relocated container when the destination is selected while the move is pending", async () => {
    await enter("a", [container()]);
    const moving = useWorkspace.getState().patchContainer("cabinet", { room_id: "b" }); await flush();
    const moveRequest = take("/containers/cabinet", "PATCH");
    const selecting = useWorkspace.getState().selectRoom("b"); await flush();
    const staleRead = requests.find((request) => request.path.endsWith("/rooms/b"));
    if (staleRead) take("/rooms/b").respond(detail("b"));
    await flush();
    moveRequest.respond({ container: { ...container(), room_id: "b", version: 2 } });
    expect(await moving).toBe(true); await flush();
    const freshRead = requests.find((request) => request.path.endsWith("/rooms/b"));
    freshRead?.respond(detail("b", [{ ...container(), room_id: "b", version: 2 }]));
    await selecting;
    expect(useWorkspace.getState().activeRoomId).toBe("b");
    expect(useWorkspace.getState().room?.containers.map((entry) => entry.id)).toEqual(["cabinet"]);
    expect(useWorkspace.getState().room?.room.container_count).toBe(1);
  });
  // A queued edit belongs to the relocation destination too; its earlier snapshot must not win.
  it("waits for a relocation's queued edit before accepting destination room data", async () => {
    await enter("a", [container()]);
    const moving = useWorkspace.getState().patchContainer("cabinet", { room_id: "b" }); await flush();
    const moveRequest = take("/containers/cabinet", "PATCH");
    const resizing = useWorkspace.getState().patchContainer("cabinet", { width_cm: 190 });
    const selecting = useWorkspace.getState().selectRoom("b"); await flush();
    const earlyRead = requests.find((request) => request.path.endsWith("/rooms/b"));
    if (earlyRead) take("/rooms/b").respond(detail("b"));
    moveRequest.respond({ container: { ...container(), room_id: "b", version: 2 } });
    await moving; await flush();
    const intermediateRead = requests.find((request) => request.path.endsWith("/rooms/b"));
    if (intermediateRead) take("/rooms/b").respond(detail("b", [{ ...container(), room_id: "b", version: 2 }]));
    take("/containers/cabinet", "PATCH").respond({ container: { ...container(), room_id: "b", width_cm: 190, version: 3 } });
    await resizing; await flush();
    requests.find((request) => request.path.endsWith("/rooms/b"))?.respond(
      detail("b", [{ ...container(), room_id: "b", width_cm: 190, version: 3 }])
    );
    await selecting;
    expect(useWorkspace.getState().activeRoomId).toBe("b");
    expect(useWorkspace.getState().room?.containers[0]?.width_cm).toBe(190);
  });
  // Waiting on a relocation must not navigate back to its destination after the user chooses another room.
  it("keeps the latest navigation when leaving the destination before a relocation completes", async () => {
    await enter("a", [container()]);
    const moving = useWorkspace.getState().patchContainer("cabinet", { room_id: "b" }); await flush();
    const moveRequest = take("/containers/cabinet", "PATCH");
    const selectingB = useWorkspace.getState().selectRoom("b"); await flush();
    const obsolete = requests.find((request) => request.path.endsWith("/rooms/b"));
    await enter("c", [container("c", "other")]);
    moveRequest.respond({ container: { ...container(), room_id: "b", version: 2 } });
    await moving; await flush();
    obsolete?.respond(detail("b", [{ ...container(), room_id: "b", version: 2 }]));
    await selectingB;
    expect(useWorkspace.getState().activeRoomId).toBe("c");
    expect(useWorkspace.getState().room?.containers.map((entry) => entry.id)).toEqual(["other"]);
  });
  // A deletion queued behind relocation belongs to the new room, not the original captured room.
  it("decrements the actual destination count when a queued deletion follows relocation", async () => {
    await enter("a", [container()]);
    useWorkspace.setState({ bootstrap: { ...bootstrap, floors: [{ ...bootstrap.floors[0],
      rooms: [{ ...detail("a").room, container_count: 1 }, detail("b").room] }] } });
    const moving = useWorkspace.getState().patchContainer("cabinet", { room_id: "b" }); await flush();
    const request = take("/containers/cabinet", "PATCH");
    const deleting = useWorkspace.getState().removeContainer("cabinet");
    request.respond({ container: { ...container(), room_id: "b", version: 2 } }); await moving; await flush();
    take("/containers/cabinet", "DELETE").respond(null, 204); await deleting;
    expect(useWorkspace.getState().room?.containers).toEqual([]);
    expect(useWorkspace.getState().bootstrap?.floors[0].rooms.map((r) => r.container_count)).toEqual([0, 0]);
  });
});
