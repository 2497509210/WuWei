import { useEffect, useRef, useState } from "react";
import { ApiError, type Item } from "../api/client";
import { applyBulkAction, type BulkAction, type BulkInput, type BulkResult } from "../api/bulk";
import { LocationPicker } from "./LocationPicker";
import { confirmDiscard, Modal } from "./Modal";
import "../styles/bulk.css";

export type BulkSelection = Pick<Item, "id" | "name" | "quantity" | "version" | "compartment_id" | "archived_at">;
const verbs: Record<BulkAction, string> = { move: "移动", archive: "归档", restore: "恢复" };

export function BulkActionDialog({ action, items, onClose, onSuccess, onConflict, refreshPending = false }: {
  action: BulkAction; items: BulkSelection[]; onClose: () => void;
  onSuccess: (result: BulkResult) => void; onConflict: () => void;
  refreshPending?: boolean;
}) {
  const [destination, setDestination] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const operation = useRef<{ signature: string; id: string }>({ signature: "", id: "" });
  const saving = useRef(false);
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { generation.current++; request.current?.abort(); }, []);
  const invalidCount = items.length < 1 || items.length > 100;
  const sameLocation = action === "move" && destination ? items.filter(item => item.compartment_id === destination).length : 0;
  const dirty = action === "archive" ? Boolean(reason.trim()) : Boolean(destination);

  async function submit() {
    if (saving.current || conflict) return;
    if (invalidCount) { setError("请选择 1–100 条物品记录"); return; }
    if (action !== "archive" && !destination) { setError("请选择目标隔层"); return; }
    if (reason.trim().length > 500) { setError("归档原因不能超过 500 字"); return; }
    const payload: Omit<BulkInput, "operation_id"> = {
      action, items: items.map(item => ({ id: item.id, expected_version: item.version })),
      ...(action === "archive" ? { reason: reason.trim() } : { compartment_id: destination }),
    };
    const signature = JSON.stringify(payload);
    try {
      if (signature !== operation.current.signature) operation.current = { signature, id: crypto.randomUUID() };
    } catch { setError("无法开始批量操作，请刷新后重新选择"); return; }
    saving.current = true; setBusy(true); setError("");
    const owner = generation.current;
    const controller = new AbortController(); request.current = controller;
    try {
      const result = await applyBulkAction({ ...payload, operation_id: operation.current.id }, controller.signal);
      if (owner === generation.current) onSuccess(result);
    } catch (error) {
      if (owner !== generation.current) return;
      if (error instanceof ApiError && (error.status === 409 || error.code === "item_not_found")) setConflict(true);
      setError(error instanceof Error ? error.message : "批量操作失败，请重试");
    } finally {
      if (request.current === controller) request.current = null;
      if (owner === generation.current) { saving.current = false; setBusy(false); }
    }
  }

  return <Modal title={`批量${verbs[action]}`} onClose={onClose} busy={busy} dirty={dirty}>
    <form className="inventory-form bulk-form" noValidate onSubmit={event => { event.preventDefault(); void submit(); }}>
      <p className="bulk-summary">将{verbs[action]} {items.length} 条物品记录，请确认所选名称和数量。</p>
      {refreshPending && <p className="inventory-muted" role="status">清单可能已有更新，当前选择与版本保持不变；完成或退出批量整理后会自动核验。</p>}
      <ul className="bulk-target-list" aria-label="本次选择">{items.map(item => <li key={item.id}><strong>{item.name}</strong><span>数量 {item.quantity}</span></li>)}</ul>
      <fieldset disabled={busy || conflict}>
        {action === "archive" ? <>
          <p className="inventory-muted">归档会保留资料、照片和历史，解除当前隔层关联；之后可选择位置恢复。</p>
          <label>归档原因（选填）<textarea aria-label="归档原因（选填）" value={reason} onChange={event => setReason(event.target.value)} rows={3} maxLength={500} /></label>
        </> : <><p className="inventory-muted">选择这批物品共同的目标隔层。{action === "restore" ? "恢复后将确认其位置。" : "已在目标隔层的记录保持不变。"}</p><LocationPicker value={destination} onChange={setDestination} /></>}
      </fieldset>
      {sameLocation > 0 && <p className="bulk-noop">{sameLocation} 条记录已在这个隔层，移动时将保持不变</p>}
      {error && <div className="inventory-error" role="alert">{error}</div>}
      {conflict && <div className="bulk-conflict"><p>所选记录已变化，不能直接重试这批操作。请刷新清单，再核对并重新选择。</p><button type="button" onClick={() => { if (confirmDiscard(dirty)) onConflict(); }}>刷新并重新选择</button></div>}
      {busy && <div className="bulk-wait"><p role="status">正在处理 {items.length} 条记录，请等待确认…</p><button type="button" onClick={() => request.current?.abort()}>停止等待</button></div>}
      <button type="submit" className="inventory-primary" disabled={busy || conflict || invalidCount || (action !== "archive" && !destination)}>{busy ? "正在处理…" : `确认${verbs[action]}`}</button>
    </form>
  </Modal>;
}
