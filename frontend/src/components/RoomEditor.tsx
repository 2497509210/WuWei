import { useEffect, useRef, useState } from "react";
import type { RoomSummary } from "../api/client";
import { useWorkspace } from "../store/useWorkspace";
import { confirmDiscard, Modal } from "./Modal";
import "../styles/room-editor.css";

function roomDraft(room: RoomSummary) {
  return { name: room.name, width_cm: room.width_cm, depth_cm: room.depth_cm, height_cm: room.height_cm };
}

export function RoomEditor({ room, onClose }: { room: RoomSummary; onClose: () => void }) {
  const [baseline, setBaseline] = useState(room);
  const [draft, setDraft] = useState(() => roomDraft(room));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const valid = Boolean(draft.name.trim()) && draft.name.trim().length <= 40 &&
    Number.isInteger(draft.width_cm) && draft.width_cm >= 100 && draft.width_cm <= 2000 &&
    Number.isInteger(draft.depth_cm) && draft.depth_cm >= 100 && draft.depth_cm <= 2000 &&
    Number.isInteger(draft.height_cm) && draft.height_cm >= 200 && draft.height_cm <= 400;
  const changed = draft.name.trim() !== baseline.name || draft.width_cm !== baseline.width_cm ||
    draft.depth_cm !== baseline.depth_cm || draft.height_cm !== baseline.height_cm;

  async function save() {
    if (inFlight.current || conflict || !valid || !changed) return;
    inFlight.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await useWorkspace.getState().saveRoom(room.id, {
        ...draft, name: draft.name.trim(), expected_version: baseline.version,
      });
      if (!mounted.current) return;
      if (result.ok) onClose();
      else { setError(result.error); setConflict(result.conflict); }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "房间保存失败，请重试");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function reload() {
    if (inFlight.current || !confirmDiscard(changed)) return;
    inFlight.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      const current = await useWorkspace.getState().reloadRoom(room.id);
      if (!mounted.current) return;
      if (!current) { setError(useWorkspace.getState().error || "房间加载失败，请重试"); return; }
      setBaseline(current); setDraft(roomDraft(current)); setConflict(false);
      setMessage("已加载最新房间，请重新修改后保存");
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <Modal title="编辑房间" onClose={onClose} busy={busy} dirty={changed}>
    <form className="room-editor inventory-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className="inventory-muted">修改名称和实际尺寸。缩小房间前，请先调整可能超出范围的容器。</p>
      <fieldset disabled={busy || conflict}>
        <label>房间名称<input required maxLength={40} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <div className="room-editor-dimensions">
          <label>宽（厘米）<input type="number" required min={100} max={2000} step={1} value={draft.width_cm} onChange={event => setDraft({ ...draft, width_cm: Number(event.target.value) })} /></label>
          <label>深（厘米）<input type="number" required min={100} max={2000} step={1} value={draft.depth_cm} onChange={event => setDraft({ ...draft, depth_cm: Number(event.target.value) })} /></label>
          <label>高（厘米）<input type="number" required min={200} max={400} step={1} value={draft.height_cm} onChange={event => setDraft({ ...draft, height_cm: Number(event.target.value) })} /></label>
        </div>
      </fieldset>
      {error && <p className="inventory-error" role="alert">{error}</p>}
      {message && <p className="inventory-success" role="status">{message}</p>}
      {conflict && <button type="button" disabled={busy} onClick={() => void reload()}>加载最新房间</button>}
      <div className="inventory-actions">
        <button className="inventory-primary" type="submit" disabled={busy || conflict || !valid || !changed}>{busy ? "正在处理…" : "保存房间"}</button>
        <button type="button" disabled={busy} onClick={() => { if (confirmDiscard(changed)) onClose(); }}>取消</button>
      </div>
    </form>
  </Modal>;
}
