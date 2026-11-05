import { create } from "zustand";
import {
  ApiError,
  createContainer as apiCreateContainer,
  deleteContainer as apiDeleteContainer,
  deleteRoom as apiDeleteRoom,
  getBootstrap,
  getRoom,
  updateContainer as apiUpdateContainer,
  updateRoom as apiUpdateRoom,
  renameCompartment as apiRenameCompartment,
  type Bootstrap,
  type Container,
  type RoomDetail,
  type RoomPatch,
  type RoomSummary,
} from "../api/client";

type SaveStatus = "idle" | "saving" | "saved" | "error";
type ContainerPatch = Parameters<typeof apiUpdateContainer>[1];
type ContainerChange = { kind: "patch"; patch: ContainerPatch } | { kind: "rename"; compartmentId: string; customName: string | null };
type ContainerDefaults = { width: number; depth: number; height: number; name: string };
export type RoomSaveResult = { ok: true; room: RoomSummary } | { ok: false; error: string; conflict: boolean };

type WorkspaceState = {
  bootstrap: Bootstrap | null;
  activeRoomId: string | null;
  room: RoomDetail | null;
  selectedContainerId: string | null;
  editMode: boolean;
  loading: boolean;
  saveStatus: SaveStatus;
  error: string;
  load: () => Promise<void>;
  selectRoom: (roomId: string) => Promise<void>;
  refreshRoom: () => Promise<void>;
  reloadRoom: (roomId: string) => Promise<RoomSummary | null>;
  saveRoom: (roomId: string, patch: RoomPatch) => Promise<RoomSaveResult>;
  removeRoom: (roomId: string, expectedVersion: number) => Promise<boolean>;
  selectContainer: (id: string | null) => void;
  setEditMode: (value: boolean) => void;
  moveLocal: (id: string, x_cm: number, z_cm: number) => void;
  // Mutations settle to false on failure; callers may safely use them from event handlers.
  addContainer: (preset: string, defaults: ContainerDefaults) => Promise<boolean>;
  patchContainer: (id: string, patch: ContainerPatch) => Promise<boolean>;
  renameCompartment: (containerId: string, compartmentId: string, customName: string | null) => Promise<boolean>;
  removeContainer: (id: string) => Promise<boolean>;
  retryLastMutation: () => Promise<boolean>;
  dismissError: () => void;
  reset: () => void;
};

function firstRoom(bootstrap: Bootstrap): RoomSummary | null {
  return bootstrap.floors.flatMap((floor) => floor.rooms)[0] ?? null;
}

function withRoomCount(bootstrap: Bootstrap | null, roomId: string, delta: number): Bootstrap | null {
  if (!bootstrap) return bootstrap;
  return {
    ...bootstrap,
    floors: bootstrap.floors.map((floor) => ({
      ...floor,
      rooms: floor.rooms.map((room) =>
        room.id === roomId ? { ...room, container_count: Math.max(0, room.container_count + delta) } : room
      ),
    })),
  };
}

function withRoomSummary(bootstrap: Bootstrap | null, room: RoomSummary): Bootstrap | null {
  if (!bootstrap) return bootstrap;
  return { ...bootstrap, floors: bootstrap.floors.map(floor => ({
    ...floor, rooms: floor.rooms.map(entry => entry.id === room.id ? room : entry),
  })) };
}

const emptyState = {
  bootstrap: null,
  activeRoomId: null,
  room: null,
  selectedContainerId: null,
  editMode: false,
  loading: false,
  saveStatus: "idle" as SaveStatus,
  error: "",
};

export const useWorkspace = create<WorkspaceState>((set, get) => {
  let session = 0;
  let navigation = 0;
  let readSequence = 0;
  let pendingSaves = 0;
  let retry: (() => Promise<boolean>) | null = null;
  let failed = false;
  // Keep confirmed values separately from drag previews, so failed writes can roll back.
  const confirmed = new Map<string, Container>();
  const revisions = new Map<string, number>();
  const queues = new Map<string, Promise<unknown>>();
  const roomQueues = new Map<string, Promise<unknown>>();
  const queuedRooms = new Map<string, Set<string>>();
  const conflicts = new Set<string>();
  const roomConflicts = new Set<string>();
  const pendingByRoom = new Map<string, number>();
  const writeEpoch = new Map<string, number>();
  const settled = new Map<string, Array<() => void>>();
  const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
  const isCurrentRoom = (roomId: string, view: number) =>
    navigation === view && get().activeRoomId === roomId && get().room?.room.id === roomId;

  function acceptRoom(room: RoomDetail) {
    roomConflicts.delete(room.room.id);
    for (const container of room.containers) {
      confirmed.set(container.id, container);
      conflicts.delete(container.id);
    }
    set((state) => ({
      room,
      bootstrap: withRoomSummary(state.bootstrap, room.room),
      loading: false,
      selectedContainerId: room.containers.some((container) => container.id === state.selectedContainerId)
        ? state.selectedContainerId : null,
    }));
  }

  function acceptRoomMetadata(rooms?: RoomSummary[]) {
    if (!rooms?.length) return;
    set(state => {
      let bootstrap = state.bootstrap;
      let room = state.room;
      for (const summary of rooms) {
        bootstrap = withRoomSummary(bootstrap, summary);
        if (room?.room.id === summary.id) room = { ...room, room: summary };
      }
      return { bootstrap, room };
    });
  }

  async function readRoom(roomId: string, sequence: number, owner: number): Promise<boolean> {
    if (pendingByRoom.get(roomId)) {
      await new Promise<void>((resolve) => settled.set(roomId, [...(settled.get(roomId) ?? []), resolve]));
    }
    if (owner !== session || sequence !== readSequence || get().activeRoomId !== roomId) return false;
    const epoch = writeEpoch.get(roomId) ?? 0;
    try {
      const room = await getRoom(roomId);
      if (owner !== session || sequence !== readSequence || get().activeRoomId !== roomId) return false;
      if (epoch !== (writeEpoch.get(roomId) ?? 0) || pendingByRoom.get(roomId)) {
        // A newer save already owns the visible room. A fresh navigation still needs a room.
        return get().room ? false : readRoom(roomId, sequence, owner);
      }
      acceptRoom(room);
      return true;
    } catch (error) {
      if (owner === session && sequence === readSequence) {
        set({ loading: false, error: message(error, "房间加载失败") });
      }
      return false;
    }
  }

  function beginSave(...roomIds: string[]) {
    pendingSaves++;
    for (const roomId of roomIds) {
      pendingByRoom.set(roomId, (pendingByRoom.get(roomId) ?? 0) + 1);
      writeEpoch.set(roomId, (writeEpoch.get(roomId) ?? 0) + 1);
    }
    retry = null;
    failed = false;
    set({ saveStatus: "saving", loading: false, error: "" });
  }

  function finishSave(...roomIds: string[]) {
    pendingSaves--;
    for (const roomId of roomIds) {
      pendingByRoom.set(roomId, (pendingByRoom.get(roomId) ?? 1) - 1);
      writeEpoch.set(roomId, (writeEpoch.get(roomId) ?? 0) + 1);
      if (!pendingByRoom.get(roomId)) {
        for (const resolve of settled.get(roomId) ?? []) resolve();
        settled.delete(roomId);
      }
    }
    set({ saveStatus: failed ? "error" : pendingSaves ? "saving" : "saved" });
  }

  function failSave(error: unknown, retryAction: () => Promise<boolean>) {
    failed = true;
    retry = retryAction;
    set({ error: message(error, "保存失败，请重试"), saveStatus: "error" });
  }

  // Container writes are ordered on the server as well as in the UI. A queued patch
  // obtains expected_version only when it starts, after the preceding response.
  function enqueue<T>(id: string, roomIds: string[], operation: () => Promise<T>): Promise<T> {
    // Room dimensions and container bounds depend on each other. Reserve these
    // tails when a write is requested, so later writes cannot overtake it.
    const previous = [...new Set([queues.get(id), ...roomIds.map(roomId => roomQueues.get(roomId))]
      .filter((entry): entry is Promise<unknown> => Boolean(entry)))];
    const result = previous.length ? Promise.allSettled(previous).then(operation) : operation();
    queues.set(id, result);
    for (const roomId of roomIds) roomQueues.set(roomId, result);
    void result.then(() => {
      if (queues.get(id) === result) {
        queues.delete(id);
        queuedRooms.delete(id);
      }
      for (const roomId of roomIds) if (roomQueues.get(roomId) === result) roomQueues.delete(roomId);
    });
    return result;
  }

  function affectedRooms(id: string, origin: string, destination?: string) {
    // Later edits in this container's queue may execute after it has moved rooms.
    // Reserve every affected room until all of those writes have settled, so a
    // newly selected destination cannot accept a snapshot from before the move.
    const rooms = new Set(queuedRooms.get(id));
    rooms.add(origin);
    if (destination) rooms.add(destination);
    queuedRooms.set(id, rooms);
    return [...rooms];
  }

  function saveContainer(id: string, change: ContainerChange): Promise<boolean> {
      const container = get().room?.containers.find((entry) => entry.id === id);
      if (!container) return Promise.resolve(false);
      if (conflicts.has(id)) {
        const snapshot = confirmed.get(id);
        const current = get().room!;
        if (snapshot) set({ room: { ...current, containers: current.containers.map((entry) => entry.id === id ? snapshot : entry) } });
        failSave(new Error("这条记录已被其他设备修改，请先重新加载后再编辑"), async () => {
          const roomId = container.room_id;
          if (get().activeRoomId !== roomId) return false;
          if (await readRoom(roomId, ++readSequence, session)) {
            set({ error: "已重新加载最新数据，请确认后重新修改", saveStatus: "idle" });
          }
          return false;
        });
        return Promise.resolve(false);
      }
      const owner = session;
      const view = navigation;
      const roomId = container.room_id;
      const revision = (revisions.get(id) ?? 0) + 1;
      revisions.set(id, revision);
      if (!confirmed.has(id)) confirmed.set(id, container);
      const roomIds = affectedRooms(id, roomId, change.kind === "patch" ? change.patch.room_id : undefined);
      beginSave(...roomIds);
      return enqueue(id, roomIds, async () => {
        if (owner !== session) return false;
        try {
          if (conflicts.has(id)) {
            const snapshot = confirmed.get(id);
            if (snapshot && isCurrentRoom(roomId, view)) {
              const current = get().room!;
              set({ room: { ...current, containers: current.containers.map((entry) => entry.id === id ? snapshot : entry) } });
            }
            return false;
          }
          const beforeSave = confirmed.get(id);
          const response = change.kind === "patch"
            ? await apiUpdateContainer(id, { ...change.patch, expected_version: beforeSave?.version })
            : await apiRenameCompartment(change.compartmentId, beforeSave?.version ?? container.version, change.customName);
          if (owner !== session) return false;
          confirmed.set(id, response.container);
          const destination = response.container.room_id;
          const origin = beforeSave?.room_id ?? roomId;
          if (destination !== origin) {
            set({ bootstrap: withRoomCount(withRoomCount(get().bootstrap, origin, -1), destination, 1) });
          }
          if (isCurrentRoom(roomId, view)) {
            const current = get().room!;
            if (destination !== roomId && current.containers.some((entry) => entry.id === id)) {
              set({ room: { room: { ...current.room, container_count: Math.max(0, current.room.container_count - 1) },
                containers: current.containers.filter((entry) => entry.id !== id) },
                selectedContainerId: get().selectedContainerId === id ? null : get().selectedContainerId });
            } else if (destination === roomId && revisions.get(id) === revision) {
              set({ room: { ...current, containers: current.containers.map((entry) => entry.id === id ? response.container : entry) } });
            }
          }
          acceptRoomMetadata(response.rooms);
          return true;
        } catch (error) {
          if (owner !== session) return false;
          const snapshot = confirmed.get(id);
          if (snapshot && isCurrentRoom(roomId, view) && revisions.get(id) === revision) {
            const current = get().room!;
            set({ room: { ...current, containers: current.containers.map((entry) => entry.id === id ? snapshot : entry) } });
          }
          const conflict = error instanceof ApiError && error.status === 409 &&
            (error.code === "version_conflict" || error.code === "container_version_conflict");
          if (conflict) conflicts.add(id);
          failSave(error, async () => {
            const retryRoomId = confirmed.get(id)?.room_id ?? roomId;
            if (get().activeRoomId !== retryRoomId) return false;
            if (conflict) {
              const refreshed = await readRoom(retryRoomId, ++readSequence, session);
              if (refreshed) set({ error: "已重新加载最新数据，请确认后重新修改", saveStatus: "idle" });
              return false;
            }
            return saveContainer(id, change);
          });
          return false;
        } finally { if (owner === session) finishSave(...roomIds); }
      });
  }

  async function saveRoom(roomId: string, patch: RoomPatch): Promise<RoomSaveResult> {
    if (get().room?.room.id !== roomId || get().bootstrap?.user.role !== "owner") {
      return { ok: false, error: "当前房间不可编辑，请重新打开房间设置", conflict: false };
    }
    if (roomConflicts.has(roomId)) {
      return { ok: false, error: "房间已被更新，请加载最新房间后重新编辑", conflict: true };
    }
    const owner = session;
    const view = navigation;
    beginSave(roomId);
    return enqueue(`room:${roomId}`, [roomId], async () => {
      if (owner !== session) return { ok: false, error: "登录状态已改变", conflict: false };
      try {
        if (roomConflicts.has(roomId)) {
          return { ok: false, error: "房间已被更新，请加载最新房间后重新编辑", conflict: true };
        }
        // Keep the version from the editor's original snapshot. Raising it while
        // queued would turn an old draft into an overwrite of someone else's edit.
        const response = await apiUpdateRoom(roomId, patch);
        if (owner !== session) return { ok: false, error: "登录状态已改变", conflict: false };
        set(state => ({ bootstrap: withRoomSummary(state.bootstrap, response.room) }));
        if (isCurrentRoom(roomId, view)) set(state => ({ room: { ...state.room!, room: response.room } }));
        return { ok: true, room: response.room };
      } catch (error) {
        if (owner !== session) return { ok: false, error: "登录状态已改变", conflict: false };
        const conflict = error instanceof ApiError && error.status === 409 &&
          (error.code === "room_version_conflict" || (error.code === "version_conflict" && Boolean(error.currentRoom)));
        if (conflict) roomConflicts.add(roomId);
        failSave(error, async () => {
          if (get().activeRoomId !== roomId) return false;
          if (conflict) {
            if (await get().reloadRoom(roomId)) set({ error: "已加载最新房间，请重新修改后保存", saveStatus: "idle" });
            return false;
          }
          return (await saveRoom(roomId, patch)).ok;
        });
        return { ok: false, error: message(error, "房间保存失败，请重试"), conflict };
      } finally { if (owner === session) finishSave(roomId); }
    });
  }

  return {
    ...emptyState,
    load: async () => {
      const owner = session;
      const view = navigation;
      const sequence = ++readSequence;
      set({ loading: true, error: "" });
      try {
        const bootstrap = await getBootstrap();
        if (owner !== session || view !== navigation || sequence !== readSequence) return;
        const current = get().activeRoomId;
        const roomId = current && bootstrap.floors.some((floor) => floor.rooms.some((room) => room.id === current))
          ? current : firstRoom(bootstrap)?.id ?? null;
        set({ bootstrap, activeRoomId: roomId });
        if (roomId) await readRoom(roomId, sequence, owner);
        else set({ room: null, selectedContainerId: null, loading: false });
      } catch (error) {
        if (owner === session && sequence === readSequence) set({ loading: false, error: message(error, "加载失败") });
      }
    },
    selectRoom: async (roomId) => {
      navigation++;
      const sequence = ++readSequence;
      set({ activeRoomId: roomId, room: null, selectedContainerId: null, loading: true, error: "" });
      await readRoom(roomId, sequence, session);
    },
    refreshRoom: async () => {
      const roomId = get().activeRoomId;
      if (roomId) await readRoom(roomId, ++readSequence, session);
    },
    reloadRoom: async (roomId) => {
      if (get().activeRoomId !== roomId) return null;
      const loaded = await readRoom(roomId, ++readSequence, session);
      return loaded && get().room?.room.id === roomId ? get().room!.room : null;
    },
    saveRoom,
    removeRoom: async (roomId, expectedVersion) => {
      if (get().room?.room.id !== roomId || get().bootstrap?.user.role !== "owner") return false;
      const owner = session;
      const view = navigation;
      beginSave(roomId);
      const removed = await enqueue(`room:${roomId}`, [roomId], async () => {
        if (owner !== session) return false;
        try {
          await apiDeleteRoom(roomId, expectedVersion);
          if (owner !== session) return false;
          set(state => ({ bootstrap: state.bootstrap ? { ...state.bootstrap, floors: state.bootstrap.floors.map(floor => ({ ...floor, rooms: floor.rooms.filter(room => room.id !== roomId) })) } : null }));
          for (const [id, container] of confirmed) if (container.room_id === roomId) { confirmed.delete(id); conflicts.delete(id); }
          return true;
        } catch (error) {
          if (owner === session) failSave(new Error(`${message(error, "删除结果尚未确认")}；请加载最新记录并重新确认删除`), async () => {
            await get().load();
            if (!get().loading && !get().error) set({ error: "已加载最新记录，请核对后重新确认删除", saveStatus: "idle" });
            return false;
          });
          return false;
        } finally { if (owner === session) finishSave(roomId); }
      });
      if (removed && owner === session && view === navigation && get().activeRoomId === roomId) {
        const next = get().bootstrap ? firstRoom(get().bootstrap!) : null;
        if (next) await get().selectRoom(next.id);
        else { navigation++; readSequence++; set({ activeRoomId: null, room: null, selectedContainerId: null, editMode: false, loading: false }); }
      }
      return removed;
    },
    selectContainer: (id) => set({ selectedContainerId: id }),
    setEditMode: (value) => set({ editMode: value }),
    moveLocal: (id, x_cm, z_cm) => {
      const room = get().room;
      const container = room?.containers.find((entry) => entry.id === id);
      if (!room || !container) return;
      if (!confirmed.has(id)) confirmed.set(id, container);
      revisions.set(id, (revisions.get(id) ?? 0) + 1);
      readSequence++;
      set({ room: { ...room, containers: room.containers.map((entry) => entry.id === id ? { ...entry, x_cm, z_cm } : entry) } });
    },
    addContainer: async (preset, defaults) => {
      const room = get().room;
      const roomId = get().activeRoomId;
      if (!room || !roomId || room.room.id !== roomId) return false;
      const owner = session;
      const view = navigation;
      beginSave(roomId);
      return enqueue(`create:${roomId}`, [roomId], async () => {
      if (owner !== session) return false;
      try {
        const response = await apiCreateContainer({
          room_id: roomId, preset, name: defaults.name,
          x_cm: Math.round(room.room.width_cm / 2), z_cm: Math.round(defaults.depth / 2),
          width_cm: defaults.width, depth_cm: defaults.depth, height_cm: defaults.height,
          config: { layers: preset === "wardrobe" || preset === "drawer_unit" ? 3 : preset === "shelf" ? 4 : 1, cols: 1 },
        });
        if (owner !== session) return false;
        confirmed.set(response.container.id, response.container);
        set({ bootstrap: withRoomCount(get().bootstrap, roomId, 1) });
        if (isCurrentRoom(roomId, view)) {
          const current = get().room!;
          set({ room: { room: { ...current.room, container_count: current.room.container_count + 1 },
            containers: [...current.containers, response.container] }, selectedContainerId: response.container.id });
        }
        acceptRoomMetadata(response.rooms);
        return true;
      } catch (error) {
        if (owner === session) failSave(error, async () => {
          if (get().activeRoomId !== roomId) return false;
          return get().addContainer(preset, defaults);
        });
        return false;
      } finally { if (owner === session) finishSave(roomId); }
      });
    },
    patchContainer: (id, patch) => saveContainer(id, { kind: "patch", patch }),
    renameCompartment: (id, compartmentId, customName) => saveContainer(id, { kind: "rename", compartmentId, customName }),
    removeContainer: (id) => {
      const container = get().room?.containers.find((entry) => entry.id === id);
      if (!container) return Promise.resolve(false);
      const owner = session;
      const view = navigation;
      const roomId = container.room_id;
      const confirmedVersion = container.version;
      const roomIds = affectedRooms(id, roomId);
      beginSave(...roomIds);
      return enqueue(id, roomIds, async () => {
        if (owner !== session) return false;
        try {
          const actualRoomId = confirmed.get(id)?.room_id ?? roomId;
          await apiDeleteContainer(id, confirmedVersion);
          if (owner !== session) return false;
          confirmed.delete(id);
          set({ bootstrap: withRoomCount(get().bootstrap, actualRoomId, -1) });
          if (isCurrentRoom(actualRoomId, view)) {
            const current = get().room!;
            set({ room: { room: { ...current.room, container_count: Math.max(0, current.room.container_count - 1) },
              containers: current.containers.filter((entry) => entry.id !== id) },
              selectedContainerId: get().selectedContainerId === id ? null : get().selectedContainerId });
            // This read waits for pending writes to settle before accepting the
            // new parent version; it never resubmits the deletion.
            void readRoom(actualRoomId, ++readSequence, owner);
          }
          return true;
        } catch (error) {
          if (owner === session) failSave(new Error(`${message(error, "删除结果尚未确认")}；请加载最新记录并重新确认删除`), async () => {
            const actualRoomId = confirmed.get(id)?.room_id ?? roomId;
            if (get().activeRoomId !== actualRoomId) return false;
            if (await readRoom(actualRoomId, ++readSequence, session)) {
              set({ error: "已加载最新记录，请核对后重新确认删除", saveStatus: "idle" });
            }
            return false;
          });
          return false;
        } finally { if (owner === session) finishSave(...roomIds); }
      });
    },
    retryLastMutation: async () => {
      const action = retry;
      retry = null;
      return action ? action() : false;
    },
    dismissError: () => {
      retry = null;
      failed = false;
      set({ error: "", saveStatus: pendingSaves ? "saving" : "idle" });
    },
    reset: () => {
      session++;
      navigation++;
      readSequence++;
      pendingSaves = 0;
      retry = null;
      failed = false;
      confirmed.clear();
      revisions.clear();
      queues.clear();
      roomQueues.clear();
      queuedRooms.clear();
      conflicts.clear();
      roomConflicts.clear();
      pendingByRoom.clear();
      writeEpoch.clear();
      for (const waiters of settled.values()) for (const resolve of waiters) resolve();
      settled.clear();
      set(emptyState);
    },
  };
});

export function activeContainer(state: WorkspaceState): Container | null {
  if (!state.room || !state.selectedContainerId) return null;
  return state.room.containers.find((container) => container.id === state.selectedContainerId) ?? null;
}
