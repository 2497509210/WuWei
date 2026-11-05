import { useEffect, useRef, useState } from "react";
import { ApiError, archiveItem, confirmItem, getItem, patchItem, restoreItem, undoItemMove, uploadItemPhoto, type Item } from "../api/client";
import type { LocateTarget } from "../pages/InventoryPage";
import { LocationPicker } from "./LocationPicker";
import { Modal } from "./Modal";
import { ItemHistory } from "./ItemHistory";

export function confirmedDate(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "尚未确认";
}

export function ItemDetail({ initial, onClose, onUpdated, onLocate }: { initial: Item; onClose: () => void; onUpdated: (item: Item) => void; onLocate: (target: LocateTarget) => void }) {
  const [item, setItem] = useState(initial);
  const [mode, setMode] = useState<"view" | "edit" | "move" | "archive" | "restore">("view");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [verified, setVerified] = useState(false);
  const [reload, setReload] = useState(0);
  const [destination, setDestination] = useState("");
  const [archiveReason, setArchiveReason] = useState("");
  const [historyRevision, setHistoryRevision] = useState(0);
  const saving = useRef(false);
  const [draft, setDraft] = useState({ name: initial.name, aliases: initial.aliases.join("、"), quantity: initial.quantity, notes: initial.notes ?? "" });
  useEffect(() => {
    let active = true;
    setLoading(true); setVerified(false); setError("");
    getItem(initial.id).then(result => { if (active) {setItem(result.item);setVerified(true);} })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : "无法读取最新记录"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [initial.id, reload]);

  async function mutate(operation: () => Promise<{ item: Item }>, success: string) {
    if (saving.current || loading || !verified) return;
    saving.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await operation(); setItem(result.item); onUpdated(result.item); setMode("view"); setMessage(success);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        let current = error.current;
        if (!current) {
          try { current = (await getItem(item.id)).item; }
          catch { setVerified(false); }
        }
        if (current) {
          setItem(current); onUpdated(current);
          // Keep the archive/restore draft if it is still a valid action. A second
          // confirmation uses the newly displayed version instead of repeating a stale write.
          if (!((mode === "archive" && !current.archived_at) || (mode === "restore" && current.archived_at))) setMode("view");
        }
      }
      setError(error instanceof Error ? error.message : "保存失败，请重试");
    } finally { saving.current = false; setBusy(false); setHistoryRevision(value => value + 1); }
  }
  function edit() { setDraft({name:item.name, aliases:item.aliases.join("、"), quantity:item.quantity, notes:item.notes ?? ""}); setMode("edit"); setMessage(""); }
  const disabled = busy || loading || !verified;
  const archived = Boolean(item.archived_at);
  return <Modal title={item.name} onClose={onClose} busy={busy}>
    <div className="item-detail">
      {item.photo_url ? <img className="item-detail-photo" src={item.photo_url} alt={item.name} /> : <div className="item-photo-empty">{archived ? "没有保存照片" : "添加实物或所在抽屉的照片，方便辨认"}</div>}
      <div className="item-location"><span>{archived ? "归档前的位置" : "记录的位置"}</span><strong>{item.location_path.length ? item.location_path.join(" / ") : "暂未分配位置"}</strong></div>
      {archived ? <div className="item-archive-note"><strong>已归档 · {confirmedDate(item.archived_at)}</strong><p>{item.archive_reason || "未填写归档原因"}</p><p>资料、照片和历史已保留。恢复时请选择现在存放的隔层。</p></div>
        : <p className={item.location_status === "missing" ? "missing-note" : "inventory-muted"}>{item.location_status === "missing" ? "这里没找到 · 位置需要更新" : "已确认位置"} · {confirmedDate(item.last_confirmed_at)}</p>}
      {item.notes && <p className="item-notes">{item.notes}</p>}
      <p className="inventory-muted">数量 {item.quantity}{item.aliases.length ? ` · 也叫 ${item.aliases.join("、")}` : ""}</p>
      {loading && <p role="status">正在核对最新记录…</p>}
      {error && <div className="inventory-error" role="alert">{error}</div>}
      {!verified && !loading && <button onClick={() => setReload(value=>value+1)}>重新加载记录</button>}
      {message && <p role="status" className="inventory-success">{message}</p>}
      {mode === "view" && !archived && <>
        <div className="inventory-actions">
          <button className="inventory-primary" disabled={disabled || !item.compartment_id} onClick={() => void mutate(() => confirmItem(item.id, item.version), "已确认物品就在这里")}>就在这里</button>
          <button disabled={disabled} onClick={() => void mutate(() => confirmItem(item.id, item.version, true), "已标记，找到后可以更新位置")}>这里没找到</button>
        </div>
        <div className="inventory-actions">
          <button disabled={disabled} onClick={() => { setDestination(""); setMode("move"); }}>移到别处</button>
          <button disabled={disabled} onClick={edit}>编辑资料</button>
          <button disabled={!item.room_id || !item.container_id || disabled} onClick={() => onLocate({roomId:item.room_id!,containerId:item.container_id!,compartmentId:item.compartment_id})}>在房间中定位</button>
        </div>
        <label className="inventory-upload">添加 / 更换照片<input aria-label="物品照片" type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (!file) return;
          if (file.size > 8 * 1024 * 1024) { setError("照片不能超过 8 MB"); return; }
          void mutate(() => uploadItemPhoto(item.id, item.version, file), "照片已保存");
        }} /></label>
        <button type="button" className="item-archive-button" disabled={disabled} onClick={() => { setMode("archive"); setMessage(""); }}>归档物品</button>
      </>}
      {mode === "view" && archived && <button className="inventory-primary" disabled={disabled} onClick={() => { setDestination(""); setMode("restore"); setMessage(""); }}>恢复物品</button>}
      {mode === "archive" && !archived && <form className="inventory-form" onSubmit={event => { event.preventDefault(); void mutate(() => archiveItem(item.id, item.version, archiveReason.trim()), "物品已归档，可在「已归档」中恢复"); }}>
        <h3>确认归档「{item.name}」</h3><p className="inventory-muted">归档后从在用列表移出，并解除当前隔层关联。资料、照片和历史保留，之后可选择位置恢复。</p>
        <label>归档原因（选填）<textarea rows={3} maxLength={500} disabled={busy} value={archiveReason} onChange={event => setArchiveReason(event.target.value)} placeholder="例如：已换新、暂时不用" /></label>
        <div className="inventory-actions"><button className="inventory-primary" disabled={disabled}>确认归档</button><button type="button" disabled={busy} onClick={() => setMode("view")}>取消</button></div>
      </form>}
      {mode === "restore" && archived && <form onSubmit={event => { event.preventDefault(); if (destination) void mutate(() => restoreItem(item.id, item.version, destination), "物品已恢复到所选位置"); }}>
        <h3>选择恢复位置</h3><p className="inventory-muted">请选择物品现在存放的隔层，恢复后会记录为已确认。</p>
        <fieldset disabled={busy}><LocationPicker value={destination} onChange={setDestination} /></fieldset>
        <div className="inventory-actions"><button className="inventory-primary" disabled={disabled || !destination}>确认恢复</button><button type="button" disabled={busy} onClick={() => setMode("view")}>取消</button></div>
      </form>}
      {mode === "move" && !archived && <form onSubmit={event => { event.preventDefault(); void mutate(() => patchItem(item.id, {expected_version:item.version,compartment_id:destination}), "位置已更新"); }}>
        <h3>选择新位置</h3><LocationPicker value={destination} onChange={setDestination} />
        <div className="inventory-actions"><button className="inventory-primary" disabled={disabled || !destination || destination === item.compartment_id}>保存新位置</button><button type="button" disabled={busy} onClick={() => setMode("view")}>取消</button></div>
      </form>}
      {mode === "edit" && !archived && <form className="inventory-form" onSubmit={event => {event.preventDefault(); void mutate(() => patchItem(item.id, {expected_version:item.version,name:draft.name.trim(),aliases:draft.aliases.split(/[、,，\n]/).map(value => value.trim()).filter(Boolean),quantity:draft.quantity,notes:draft.notes}), "资料已保存");}}>
        <label>名称<input required maxLength={120} value={draft.name} onChange={event => setDraft({...draft,name:event.target.value})} /></label>
        <label>别名（用顿号分隔）<input value={draft.aliases} onChange={event => setDraft({...draft,aliases:event.target.value})} /></label>
        <label>数量<input type="number" min={1} max={99999} required value={draft.quantity} onChange={event => setDraft({...draft,quantity:Number(event.target.value)})} /></label>
        <label>备注<textarea maxLength={4000} value={draft.notes} onChange={event => setDraft({...draft,notes:event.target.value})} /></label>
        <div className="inventory-actions"><button className="inventory-primary" disabled={disabled || !draft.name.trim()}>保存资料</button><button type="button" disabled={busy} onClick={() => setMode("view")}>取消</button></div>
      </form>}
      {busy && <p role="status">正在保存…</p>}
      <ItemHistory key={`${item.id}:${item.version}:${historyRevision}`} itemId={item.id} disabled={disabled || archived || mode !== "view"}
        onUndo={eventId => void mutate(() => undoItemMove(item.id, eventId, item.version), "已撤销这次移动")} />
    </div>
  </Modal>;
}
