import { useEffect, useRef, useState } from "react";
import { ApiError, getBootstrap, getRoom, type MeResponse, type RoomDetail, type RoomSummary } from "../api/client";
import { forgetLocation } from "../lib/recentLocation";
import { verifiedLocation } from "../lib/verifiedLocation";
import { CompartmentGrid } from "./CompartmentGrid";
import { RecentLocations } from "./RecentLocations";

export function LocationPicker({ value, onChange, initialCompartmentId = "", onInvalidInitial, me, recentRevision = 0 }: {
  value: string; onChange: (id: string) => void; initialCompartmentId?: string; onInvalidInitial?: (id: string) => void; me?: MeResponse; recentRevision?: number;
}) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [roomId, setRoomId] = useState("");
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [containerId, setContainerId] = useState("");
  const [error, setError] = useState("");
  const [bootstrapError, setBootstrapError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [chosenRecent, setChosenRecent] = useState<{ id: string; revision: number } | null>(null);
  const choiceSequence = useRef(0);
  const manuallySelected = useRef(false);
  const callbacks = useRef({ onChange, onInvalidInitial });
  callbacks.current = { onChange, onInvalidInitial };
  const scope = me ? `${encodeURIComponent(me.household.id)}:${encodeURIComponent(me.user.id)}` : "";
  useEffect(() => {
    let active = true;
    setBootstrapError("");
    getBootstrap().then(result => { if (active) setRooms(result.floors.flatMap(floor => floor.rooms)); })
      .catch(error => { if (active) setBootstrapError(error instanceof Error ? error.message : "位置加载失败"); });
    return () => { active = false; };
  }, [retry, scope]);

  useEffect(() => {
    manuallySelected.current = false; setChosenRecent(null);
    choiceSequence.current++;
    callbacks.current.onChange(""); setRoomId(""); setContainerId(""); setDetail(null); setLoading(false); setError("");
  }, [initialCompartmentId, scope]);
  useEffect(() => {
    const requestedId = chosenRecent?.id ?? initialCompartmentId;
    if (!requestedId || manuallySelected.current) return;
    const sequence = ++choiceSequence.current;
    const controller = new AbortController();
    callbacks.current.onChange("");
    setRoomId(""); setContainerId(""); setDetail(null); setLoading(true); setError("");
    void (async () => {
      try {
        const { location, detail: room } = await verifiedLocation(requestedId, controller.signal);
        if (controller.signal.aborted || sequence !== choiceSequence.current) return;
        setRoomId(location.room_id); setContainerId(location.container_id); setDetail(room);
        callbacks.current.onChange(location.compartment_id);
      } catch (error) {
        if (controller.signal.aborted || sequence !== choiceSequence.current) return;
        setRoomId(""); setContainerId(""); setDetail(null); callbacks.current.onChange("");
        setError(error instanceof Error ? error.message : "位置加载失败");
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          if (me) forgetLocation(me, requestedId);
          callbacks.current.onInvalidInitial?.(requestedId);
        }
      } finally {
        if (!controller.signal.aborted && sequence === choiceSequence.current) setLoading(false);
      }
    })();
    return () => { controller.abort(); };
  }, [initialCompartmentId, chosenRecent, retry, scope]);

  async function chooseRoom(id: string) {
    manuallySelected.current = true;
    const sequence = ++choiceSequence.current;
    setRoomId(id); setContainerId(""); setDetail(null); callbacks.current.onChange("");
    if (!id) { setLoading(false); setError(""); return; }
    setLoading(true); setError("");
    try {
      const room = await getRoom(id);
      if (sequence === choiceSequence.current) setDetail(room);
    } catch (error) {
      if (sequence === choiceSequence.current) setError(error instanceof Error ? error.message : "房间加载失败");
    } finally { if (sequence === choiceSequence.current) setLoading(false); }
  }
  useEffect(() => () => { choiceSequence.current++; }, []);
  const selected = detail?.containers.find(container => container.id === containerId);
  return <div className="location-picker">
    {me && <RecentLocations me={me} value={value} revision={recentRevision} onChoose={id => { manuallySelected.current = false; choiceSequence.current++; setChosenRecent(previous => ({ id, revision: (previous?.revision ?? 0) + 1 })); }} />}
    <div className="inventory-form-row">
      <label>房间<select aria-label="房间" value={roomId} onChange={event => void chooseRoom(event.target.value)}>
        <option value="">选择房间</option>{rooms.map(room => <option key={room.id} value={room.id}>{room.name}</option>)}
      </select></label>
      <label>容器<select aria-label="容器" value={containerId} disabled={!detail || loading} onChange={event => { manuallySelected.current = true; choiceSequence.current++; setContainerId(event.target.value); onChange(""); }}>
        <option value="">选择容器</option>{detail?.containers.map(container => <option key={container.id} value={container.id}>{container.name}</option>)}
      </select></label>
    </div>
    {loading && <p role="status">正在加载位置…</p>}
    {(error || bootstrapError) && <div className="inventory-error" role="alert">{[bootstrapError,error].filter(Boolean).join("；")}<button type="button" onClick={() => { setRetry(value => value + 1); if (manuallySelected.current && roomId) void chooseRoom(roomId); }}>重试</button></div>}
    {!loading && detail && !detail.containers.length && <p>这个房间还没有容器，请先到「空间」添加。</p>}
    {selected && <CompartmentGrid container={selected} selectedId={value} onSelect={compartment => { manuallySelected.current = true; choiceSequence.current++; onChange(compartment.id); }} />}
  </div>;
}
