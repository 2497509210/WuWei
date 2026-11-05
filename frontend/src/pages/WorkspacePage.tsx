import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import type { Container, ContainerPatch, MeResponse, RoomSummary } from "../api/client";
import { createRoom } from "../api/client";
import { Brand } from "../components/Brand";
import {
  MobileActionBar,
  MobileMoreSheet,
  MobileMovePill,
  MobileRoomBar,
  MobileRoomSheet,
  MobileSizeSheet,
} from "../components/MobilePanels";
import { useIsMobile } from "../hooks/useIsMobile";
import type { RoomSceneHandle } from "../three/RoomScene";
import type { LocateTarget } from "./InventoryPage";
import { RoomPlan } from "../components/RoomPlan";
import { CompartmentGrid } from "../components/CompartmentGrid";
import { CompartmentNameEditor } from "../components/CompartmentNameEditor";
import { RoomEditor } from "../components/RoomEditor";
import { LocationLabel } from "../components/LocationLabel";
import { Modal } from "../components/Modal";
import { clampContainerCenter } from "../three/layout";
import { activeContainer, useWorkspace } from "../store/useWorkspace";

const RoomScene = lazy(() => import("../three/RoomScene").then(module => ({ default: module.RoomScene })));

const PRESET_LABELS: Record<string, string> = {
  wardrobe: "衣柜",
  drawer_unit: "抽屉柜",
  storage_box: "收纳箱",
  shelf: "置物架",
  bed: "床下",
  coffee_table: "茶几",
  desk: "书桌",
  custom_box: "自定义",
};

const PRESET_DEFAULTS: Record<string, { width: number; depth: number; height: number; name: string }> = {
  wardrobe: { width: 180, depth: 58, height: 220, name: "衣柜" },
  drawer_unit: { width: 95, depth: 50, height: 80, name: "抽屉柜" },
  storage_box: { width: 62, depth: 44, height: 38, name: "收纳箱" },
  shelf: { width: 120, depth: 35, height: 180, name: "置物架" },
  bed: { width: 180, depth: 200, height: 45, name: "床下" },
  coffee_table: { width: 110, depth: 60, height: 40, name: "茶几" },
  desk: { width: 120, depth: 60, height: 75, name: "书桌" },
  custom_box: { width: 70, depth: 50, height: 40, name: "自定义收纳" },
};

type MobileMode = "view" | "move" | "size" | "more";

export function WorkspacePage({ me, onLogout, onInventory, target, onSettings }: { me: MeResponse; onLogout: () => Promise<void>; onInventory: (compartmentId?: string) => void; target?: LocateTarget; onSettings?: () => void }) {
  const bootstrap = useWorkspace((state) => state.bootstrap);
  const room = useWorkspace((state) => state.room);
  const activeRoomId = useWorkspace((state) => state.activeRoomId);
  const selectedId = useWorkspace((state) => state.selectedContainerId);
  const editMode = useWorkspace((state) => state.editMode);
  const loading = useWorkspace((state) => state.loading);
  const error = useWorkspace((state) => state.error);
  const saveStatus = useWorkspace((state) => state.saveStatus);
  const retryLastMutation = useWorkspace((state) => state.retryLastMutation);
  const dismissError = useWorkspace((state) => state.dismissError);
  const load = useWorkspace((state) => state.load);
  const selectRoom = useWorkspace((state) => state.selectRoom);
  const selectContainer = useWorkspace((state) => state.selectContainer);
  const setEditMode = useWorkspace((state) => state.setEditMode);
  const moveLocal = useWorkspace((state) => state.moveLocal);
  const patchContainer = useWorkspace((state) => state.patchContainer);
  const removeContainer = useWorkspace((state) => state.removeContainer);
  const addContainer = useWorkspace((state) => state.addContainer);
  const selected = useWorkspace((state) => activeContainer(state));

  const [showRooms, setShowRooms] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [roomError, setRoomError] = useState("");
  const [mobileMode, setMobileMode] = useState<MobileMode>("view");
  const [roomSheetOpen, setRoomSheetOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<RoomSummary | null>(null);
  const [view, setView] = useState<"3d" | "plan">("plan");
  const [showCompartments, setShowCompartments] = useState(false);
  const [showLocationLabel, setShowLocationLabel] = useState(false);
  const [compartmentId, setCompartmentId] = useState(target?.compartmentId ?? "");
  const [actionError, setActionError] = useState("");
  const isMobile = useIsMobile();
  const sceneRef = useRef<RoomSceneHandle | null>(null);
  const roomDeletion = useRef(false);
  const loaded = useRef(false);
  const canManageRooms = me.user.role === "owner";

  useEffect(() => {
    if (editingRoom && editingRoom.id !== activeRoomId) setEditingRoom(null);
  }, [activeRoomId, editingRoom]);

  useEffect(() => {
    if (!selected?.id) setMobileMode("view");
    setShowLocationLabel(false);
  }, [selected?.id]);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void (async () => {
      await load();
      if (target) {
        await selectRoom(target.roomId);
        selectContainer(target.containerId);
        setShowCompartments(true);
      }
    })();
  }, [load]);

  function openNewRoom() {
    if (canManageRooms) setShowRooms(true);
  }

  async function handleCreateRoom(input: { name: string; width: number; depth: number; height: number }) {
    if (!canManageRooms) return;
    setRoomError("");
    try {
      const result = await createRoom({ name: input.name, width_cm: input.width, depth_cm: input.depth, height_cm: input.height });
      setShowRooms(false);
      await load();
      await selectRoom(result.room.id);
    } catch (err) {
      setRoomError(err instanceof Error ? err.message : "创建房间失败");
    }
  }

  async function handleDeleteRoom(): Promise<boolean> {
    if (!room || !canManageRooms || roomDeletion.current) return false;
    const snapshot = room.room;
    if (!window.confirm(`删除「${snapshot.name}」以及里面的所有容器？`)) return false;
    roomDeletion.current = true;
    try { setActionError(""); return await useWorkspace.getState().removeRoom(snapshot.id, snapshot.version); }
    finally { roomDeletion.current = false; }
  }

  async function openRoomEditor() {
    if (!room || !canManageRooms) return;
    const id = room.room.id;
    const current = await useWorkspace.getState().reloadRoom(id);
    if (current && useWorkspace.getState().activeRoomId === id) setEditingRoom(current);
  }

  const totalContainers = room?.containers.length ?? 0;
  const totalItems = room?.containers.reduce((sum, item) => sum + item.item_count, 0) ?? 0;

  async function patchSelected(patch: ContainerPatch) {
    if (!selected) return;
    if (!await patchContainer(selected.id, patch)) throw new Error(useWorkspace.getState().error || "保存失败，请重试");
  }

  async function rotateSelected() {
    if (!selected || !room) return;
    const nextRot = (selected.rot_deg + 90) % 360;
    const fitted = clampContainerCenter({
      x: selected.x_cm,
      z: selected.z_cm,
      width: selected.width_cm,
      depth: selected.depth_cm,
      rot: nextRot,
      roomWidth: room.room.width_cm,
      roomDepth: room.room.depth_cm,
      margin: 1,
    });
    await patchContainer(selected.id, { rot_deg: nextRot, x_cm: Math.round(fitted.x), z_cm: Math.round(fitted.z) });
  }

  function enterMoveMode() {
    setMobileMode("move");
    setEditMode(true);
  }

  function finishMoveMode() {
    setMobileMode("view");
    setEditMode(false);
  }

  function closeSelection() {
    selectContainer(null);
    setMobileMode("view");
    setEditMode(false);
  }

  return (
    <div className="workspace">
      <header className="workspace-top">
        <Brand compact />
        <button type="button" className="workspace-inventory-btn" onClick={() => onInventory()}>家庭找物</button>
        <div className="workspace-breadcrumb">
          <span>{me.household.name}</span>
          <span className="slash">/</span>
          <strong>{room?.room.name ?? "还没有房间"}</strong>
        </div>
        <div className="workspace-top-right">
          <span className="env-badge">{editMode ? "布置模式" : "浏览模式"}</span>
          <div className="user-chip">
            <span className="avatar">{me.user.display_name.slice(0, 1)}</span>
            <span>{me.user.display_name}</span>
          </div>
          <button className="text-btn" type="button" onClick={onLogout}>
            退出
          </button>
          {onSettings && <button className="text-btn" type="button" aria-label="账号与家庭" onClick={onSettings}>账号</button>}
        </div>
      </header>

      <aside className="room-rail">
        <div className="rail-label">房间</div>
        {bootstrap?.floors.map((floor) => (
          <div key={floor.id} className="floor-group">
            <div className="floor-name">{floor.name}</div>
            {floor.rooms.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`room-chip ${item.id === activeRoomId ? "active" : ""}`}
                onClick={() => void selectRoom(item.id)}
              >
                <span>{item.name}</span>
                <small>{item.container_count}</small>
              </button>
            ))}
          </div>
        ))}
        {canManageRooms && <button type="button" className="rail-add" onClick={openNewRoom}>
          ＋ 房间
        </button>}
      </aside>

      {room && <div className="workspace-view-switch" aria-label="房间视图">
        <button aria-pressed={view === "plan"} onClick={() => {setView("plan"); setEditMode(false);}}>平面</button>
        <button aria-pressed={view === "3d"} onClick={() => setView("3d")}>3D</button>
        {view === "3d" && <button onClick={() => sceneRef.current?.reset()}>全景</button>}
        {view === "3d" && selected && <button onClick={() => sceneRef.current?.focus(selected.id, true)}>正视</button>}
      </div>}
      {selected && <button className="workspace-shelf-button" onClick={() => {setCompartmentId(target?.containerId === selected.id ? target.compartmentId ?? "" : "");setShowCompartments(true);}}>{selected.name} · 查看隔层与物品</button>}

      <main className="viewport">
        {loading && <div className="viewport-loading">正在加载房间…</div>}
        {!loading && !room && (
          <div className="empty-room">
            <div className="empty-icon">⌂</div>
            <h2>先搭第一间房</h2>
            <p>输入房间的真实尺寸，然后在里面放衣柜、抽屉柜、收纳箱。</p>
            {canManageRooms ? <button type="button" className="primary-btn compact" onClick={openNewRoom}>
              新建房间
            </button> : <p>请家庭管理员先创建房间。</p>}
          </div>
        )}
        {!loading && room && view === "plan" && <div className="workspace-plan-wrap"><RoomPlan room={room.room} containers={room.containers} selectedId={selectedId} onSelect={selectContainer} /></div>}
        {!loading && room && view === "3d" && <SceneBoundary onFallback={() => setView("plan")}><Suspense fallback={<div className="viewport-loading">正在加载 3D…</div>}><RoomScene
            room={room.room}
            containers={room.containers}
            selectedId={selectedId}
            editMode={editMode}
            onSelect={selectContainer}
            onMove={moveLocal}
            onCommit={(id, x, z) => void patchContainer(id, { x_cm: x, z_cm: z })}
            controllerRef={sceneRef}
            focusContainerId={selectedId}
          /></Suspense></SceneBoundary>}
        {isMobile && room && view === "3d" && (
          <div className="camera-controls" aria-label="相机缩放">
            <button type="button" aria-label="放大" onClick={() => sceneRef.current?.zoom(0.8)}>
              ＋
            </button>
            <button type="button" aria-label="缩小" onClick={() => sceneRef.current?.zoom(1.25)}>
              −
            </button>
            <button type="button" aria-label="复位视角" onClick={() => sceneRef.current?.reset()}>
              ⌂
            </button>
          </div>
        )}
      </main>

      {(saveStatus !== "idle" || error || actionError) && <div className={`workspace-save-status ${error || actionError ? "error" : ""}`} role={error || actionError ? "alert" : "status"}>
        <span>{actionError || error || (saveStatus === "saving" ? "正在保存…" : "已保存")}</span>
        {error && <button onClick={() => void (saveStatus === "error" ? retryLastMutation() : load())}>{error.includes("更新") || error.includes("版本") || error.includes("重新确认删除") ? "加载最新记录" : "重试"}</button>}
        {(error || actionError) && <button onClick={() => {dismissError();setActionError("");}}>关闭提示</button>}
      </div>}

      <div className="workspace-tools">
        {!isMobile && selected && room && canManageRooms && <button type="button" className="tool-pill" onClick={() => void openRoomEditor()}>编辑房间</button>}
        {!isMobile && (
          <button type="button" className={`tool-pill ${editMode ? "active" : ""}`} onClick={() => {setView("3d");setEditMode(!editMode);}}>
            {editMode ? "完成" : "布置"}
          </button>
        )}
        <button type="button" className="tool-pill" onClick={() => setShowLibrary(true)} disabled={!room}>
          ＋ 容器
        </button>
      </div>

      {!isMobile && (
        <aside className={`inspector ${selected || room ? "open" : ""}`}>
          {room && selected ? (
            <ContainerInspector
              container={selected}
              room={room.room}
              onPatch={(patch) => void patchContainer(selected.id, patch)}
              onDelete={() => {
                if (window.confirm(`删除「${selected.name}」？`)) void removeContainer(selected.id);
              }}
            />
          ) : room ? (
            <RoomInspector room={room.room} containers={totalContainers} items={totalItems}
              onEdit={canManageRooms ? () => void openRoomEditor() : undefined}
              onDelete={canManageRooms ? handleDeleteRoom : undefined} />
          ) : null}
        </aside>
      )}

      {isMobile && selected && mobileMode === "view" && (
        <MobileActionBar
          container={selected}
          onMove={() => {setView("3d");enterMoveMode();}}
          onSize={() => setMobileMode("size")}
          onRotate={() => void rotateSelected()}
          onMore={() => setMobileMode("more")}
          onClose={closeSelection}
        />
      )}
      {isMobile && selected && mobileMode === "move" && <MobileMovePill onFinish={finishMoveMode} />}
      {isMobile && selected && mobileMode === "size" && (
        <MobileSizeSheet container={selected} onClose={() => setMobileMode("view")} onPatch={patchSelected} />
      )}
      {isMobile && selected && mobileMode === "more" && (
        <MobileMoreSheet
          container={selected}
          onClose={() => setMobileMode("view")}
          onRename={(name) => patchSelected({ name })}
          onDelete={async () => {
            if (await removeContainer(selected.id)) setMobileMode("view");
          }}
        />
      )}
      {isMobile && !selected && room && (
        <MobileRoomBar
          room={room.room}
          containers={totalContainers}
          items={totalItems}
          onOpen={() => setRoomSheetOpen(true)}
        />
      )}
      {isMobile && roomSheetOpen && room && (
        <MobileRoomSheet
          room={room.room}
          containers={totalContainers}
          items={totalItems}
          onClose={() => setRoomSheetOpen(false)}
          onEdit={canManageRooms ? () => { setRoomSheetOpen(false); void openRoomEditor(); } : undefined}
          onDelete={canManageRooms ? async () => {
            if (await handleDeleteRoom()) setRoomSheetOpen(false);
          } : undefined}
        />
      )}

      {showLibrary && (
        <div className="modal-backdrop" onClick={() => setShowLibrary(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div>
                <span className="eyebrow">CONTAINER LIBRARY</span>
                <h2>放一个容器</h2>
              </div>
              <button type="button" className="modal-close" onClick={() => setShowLibrary(false)}>
                ×
              </button>
            </div>
            <div className="preset-grid">
              {Object.entries(PRESET_DEFAULTS).map(([preset, defaults]) => (
                <button
                  key={preset}
                  type="button"
                  className="preset-card"
                  onClick={() => {
                    void addContainer(preset, defaults).then(ok => {if (ok) setShowLibrary(false);});
                  }}
                >
                  <span className="preset-icon">{preset === "wardrobe" ? "▥" : preset === "bed" ? "▬" : preset === "coffee_table" ? "◫" : "▣"}</span>
                  <strong>{PRESET_LABELS[preset]}</strong>
                  <small>
                    {defaults.width} × {defaults.depth} × {defaults.height} cm
                  </small>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {showRooms && (
        <NewRoomModal onClose={() => setShowRooms(false)} onCreate={handleCreateRoom} error={roomError} />
      )}
      {editingRoom && room?.room.id === editingRoom.id && canManageRooms && <RoomEditor key={editingRoom.id} room={editingRoom} onClose={() => setEditingRoom(null)} />}
      {showCompartments && selected && !showLocationLabel && <Modal title={selected.name} onClose={() => setShowCompartments(false)}>
        <CompartmentGrid container={selected} selectedId={compartmentId} onSelect={compartment => setCompartmentId(compartment.id)} />
        <div className="inventory-actions"><button className="inventory-primary" disabled={!compartmentId || !selected.compartments.some(entry => entry.id === compartmentId)} onClick={() => onInventory(compartmentId)}>查看隔层里的物品</button>
          <button type="button" onClick={() => setShowLocationLabel(true)}>位置标签</button></div>
        {selected.compartments.filter(entry => entry.id === compartmentId).map(entry => <CompartmentNameEditor key={entry.id} compartment={entry} />)}
        <WholeContainerMove container={selected} rooms={bootstrap?.floors.flatMap(floor => floor.rooms) ?? []} onMoved={() => setShowCompartments(false)} />
      </Modal>}
      {showCompartments && showLocationLabel && selected && room && <LocationLabel key={selected.id} container={selected} roomName={room.room.name}
        compartmentId={selected.compartments.some(entry => entry.id === compartmentId) ? compartmentId : undefined} onClose={() => setShowLocationLabel(false)} />}
    </div>
  );
}

class SceneBoundary extends Component<{ children: ReactNode; onFallback: () => void }, {failed: boolean}> {
  state = { failed: false };
  static getDerivedStateFromError() { return {failed:true}; }
  render() { return this.state.failed ? <div className="workspace-spatial-error"><p>当前设备无法显示 3D，仍可使用平面图查找物品。</p><button onClick={this.props.onFallback}>打开平面图</button></div> : this.props.children; }
}

function WholeContainerMove({container,rooms,onMoved}:{container:Container;rooms:RoomSummary[];onMoved:()=>void}) {
  const [roomId,setRoomId] = useState("");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const destination = rooms.find(room => room.id === roomId);
  return <div className="box-move"><h3>整个容器移到其他房间</h3><p>保留所有隔层和物品记录，移入后可继续调整摆放位置。</p>
    <label>目标房间<select value={roomId} disabled={busy} onChange={event => setRoomId(event.target.value)}><option value="">选择房间</option>{rooms.filter(room => room.id !== container.room_id).map(room => <option value={room.id} key={room.id}>{room.name}</option>)}</select></label>
    {error && <p className="inventory-error" role="alert">{error}</p>}
    <button disabled={!destination || busy} onClick={() => {
      if (!destination) return;
      setBusy(true);setError("");
      const fitted=clampContainerCenter({x:destination.width_cm/2,z:destination.depth_cm/2,width:container.width_cm,depth:container.depth_cm,rot:container.rot_deg,roomWidth:destination.width_cm,roomDepth:destination.depth_cm});
      void useWorkspace.getState().patchContainer(container.id,{room_id:roomId,x_cm:Math.round(fitted.x),z_cm:Math.round(fitted.z)}).then(ok => {if(ok) onMoved();else setError(useWorkspace.getState().error||"移动失败");}).finally(()=>setBusy(false));
    }}>{busy ? "正在移动…" : "移动整个容器"}</button>
  </div>;
}

function ContainerInspector({
  container,
  room,
  onPatch,
  onDelete,
}: {
  container: Container;
  room: RoomSummary;
  onPatch: (patch: ContainerPatch) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState({
    width: container.width_cm,
    depth: container.depth_cm,
    height: container.height_cm,
    layers: container.config.layers ?? 1,
    name: container.name,
  });

  useEffect(() => {
    setDraft({
      width: container.width_cm,
      depth: container.depth_cm,
      height: container.height_cm,
      layers: container.config.layers ?? 1,
      name: container.name,
    });
  }, [container.id, container.width_cm, container.depth_cm, container.height_cm, container.config.layers, container.name]);

  function commit(patch: ContainerPatch) {
    onPatch(patch);
  }

  return (
    <div className="inspector-inner">
      <div className="inspector-head">
        <span className="eyebrow">SELECTED CONTAINER</span>
        <h2>{container.name}</h2>
        <p>
          {PRESET_LABELS[container.preset] ?? container.preset} · {container.compartments.length} 个隔层
        </p>
      </div>

      <div className="field-grid">
        <label>
          <span>宽 cm</span>
          <input
            type="number"
            value={draft.width}
            min={20}
            max={400}
            onChange={(event) => setDraft({ ...draft, width: Number(event.target.value) })}
            onBlur={() => commit({ width_cm: draft.width })}
          />
        </label>
        <label>
          <span>深 cm</span>
          <input
            type="number"
            value={draft.depth}
            min={20}
            max={400}
            onChange={(event) => setDraft({ ...draft, depth: Number(event.target.value) })}
            onBlur={() => commit({ depth_cm: draft.depth })}
          />
        </label>
        <label>
          <span>高 cm</span>
          <input
            type="number"
            value={draft.height}
            min={10}
            max={300}
            onChange={(event) => setDraft({ ...draft, height: Number(event.target.value) })}
            onBlur={() => commit({ height_cm: draft.height })}
          />
        </label>
        <label>
          <span>层 / 格</span>
          <input
            type="number"
            value={draft.layers}
            min={1}
            max={8}
            onChange={(event) => setDraft({ ...draft, layers: Number(event.target.value) })}
            onBlur={() => commit({ config: { ...container.config, layers: draft.layers } })}
          />
        </label>
      </div>

      <div className="compartment-list">
        {container.compartments.map((compartment) => (
          <div key={compartment.id} className="compartment-row">
            <span className="compartment-dot" />
            <span>{compartment.name}</span>
            <small>{compartment.kind}</small>
          </div>
        ))}
      </div>

      <div className="inspector-actions">
        <button
          type="button"
          className="ghost-btn"
          onClick={() => {
            const nextRot = (container.rot_deg + 90) % 360;
            const fitted = clampContainerCenter({
              x: container.x_cm,
              z: container.z_cm,
              width: container.width_cm,
              depth: container.depth_cm,
              rot: nextRot,
              roomWidth: room.width_cm,
              roomDepth: room.depth_cm,
              margin: 1,
            });
            commit({ rot_deg: nextRot, x_cm: Math.round(fitted.x), z_cm: Math.round(fitted.z) });
          }}
        >
          旋转 90°
        </button>
        <button type="button" className="danger-btn" onClick={onDelete}>
          删除
        </button>
      </div>
    </div>
  );
}

function RoomInspector({
  room,
  containers,
  items,
  onEdit,
  onDelete,
}: {
  room: RoomSummary;
  containers: number;
  items: number;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="inspector-inner">
      <div className="inspector-head">
        <span className="eyebrow">ROOM</span>
        <h2>{room.name}</h2>
        <p>点击任意容器查看尺寸、层数；点「布置」后可拖动。</p>
      </div>
      <div className="room-stats">
        <div>
          <strong>{room.width_cm} × {room.depth_cm}</strong>
          <span>厘米</span>
        </div>
        <div>
          <strong>{containers}</strong>
          <span>个容器</span>
        </div>
        <div>
          <strong>{items}</strong>
          <span>件物品</span>
        </div>
      </div>
      <div className="inspector-actions">
        {onEdit && <button type="button" className="ghost-btn" onClick={onEdit}>编辑房间</button>}
        {onDelete && <button type="button" className="danger-btn" onClick={onDelete}>
          删除房间
        </button>}
        {!onEdit && <p className="room-readonly-note">仅家庭管理员可修改房间。</p>}
      </div>
    </div>
  );
}

function NewRoomModal({
  onClose,
  onCreate,
  error,
}: {
  onClose: () => void;
  onCreate: (input: { name: string; width: number; depth: number; height: number }) => Promise<void>;
  error: string;
}) {
  const [name, setName] = useState("主卧");
  const [width, setWidth] = useState(460);
  const [depth, setDepth] = useState(360);
  const [height, setHeight] = useState(260);
  const [busy, setBusy] = useState(false);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal small"
        onClick={(event) => event.stopPropagation()}
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          await onCreate({ name, width, depth, height });
          setBusy(false);
        }}
      >
        <div className="modal-head">
          <div>
            <span className="eyebrow">NEW ROOM</span>
            <h2>新建房间</h2>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-form">
          <label>
            <span>名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <div className="field-grid">
            <label>
              <span>宽 cm</span>
              <input type="number" value={width} min={100} max={1200} onChange={(event) => setWidth(Number(event.target.value))} />
            </label>
            <label>
              <span>深 cm</span>
              <input type="number" value={depth} min={100} max={1200} onChange={(event) => setDepth(Number(event.target.value))} />
            </label>
            <label>
              <span>层高 cm</span>
              <input type="number" value={height} min={200} max={400} onChange={(event) => setHeight(Number(event.target.value))} />
            </label>
          </div>
          {error && <div className="form-error">{error}</div>}
          <button type="submit" className="primary-btn" disabled={busy}>
            {busy ? "正在创建…" : "创建房间"}
          </button>
        </div>
      </form>
    </div>
  );
}
