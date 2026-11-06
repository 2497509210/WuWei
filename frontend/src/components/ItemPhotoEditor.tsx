import { useEffect, useRef, useState } from "react";
import { ApiError, type Item } from "../api/client";
import { replaceItemPhoto, type UploadProgress } from "../api/mobile";
import { preparePhoto, type PreparedPhoto } from "../lib/preparePhoto";
import { confirmDiscard } from "./Modal";

type PendingPhoto = PreparedPhoto & { expectedVersion: number; operationId: string };
type Transfer = UploadProgress & { started: number; changed: number; uploaded: number | null };
function size(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : `${Math.round(bytes / 1024)} KB`; }

export function ItemPhotoEditor({ item, disabled, onSaved, onConflict, onDirtyChange, onBusyChange }: {
  item: Item; disabled: boolean; onSaved: (item: Item) => void; onConflict: (error: ApiError) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [pending, setPending] = useState<PendingPhoto | null>(null);
  const [preview, setPreview] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState(false);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [clock, setClock] = useState(0);
  const preparation = useRef<AbortController | null>(null);
  const upload = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const generation = useRef(0);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => () => { generation.current++; preparation.current?.abort(); upload.current?.abort(); }, []);
  useEffect(() => { onDirtyChange(Boolean(pending || preparing)); }, [pending, preparing, onDirtyChange]);
  useEffect(() => { onBusyChange(working); }, [working, onBusyChange]);
  useEffect(() => {
    if (!pending) { setPreview(""); return; }
    const url = URL.createObjectURL(pending.file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pending?.file]);
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [working]);
  useEffect(() => { if (working) panel.current?.scrollIntoView?.({ block: "nearest" }); }, [working, transfer?.phase]);

  async function choose(file?: File) {
    if (!file || saving.current) return;
    preparation.current?.abort();
    const controller = new AbortController(); preparation.current = controller;
    const owner = generation.current;
    setPreparing(true); setError(""); setTransfer(null); setReview(false);
    try {
      const prepared = await preparePhoto(file, controller.signal);
      if (owner !== generation.current || preparation.current !== controller || controller.signal.aborted) return;
      setPending({ ...prepared, expectedVersion: item.version, operationId: crypto.randomUUID() });
    } catch (cause) {
      if (owner !== generation.current || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "照片处理失败，请重新选择");
    } finally {
      if (owner === generation.current && preparation.current === controller) { preparation.current = null; setPreparing(false); }
    }
  }

  function discard() {
    if (saving.current || !confirmDiscard(Boolean(pending || preparing))) return;
    preparation.current?.abort(); preparation.current = null;
    setPreparing(false); setPending(null); setTransfer(null); setError(""); setReview(false);
  }

  async function save() {
    if (!pending || saving.current || preparation.current || disabled || review) return;
    saving.current = true; setWorking(true); setError("");
    const owner = generation.current;
    const controller = new AbortController(); upload.current = controller;
    const started = Date.now(); setClock(started);
    setTransfer({ phase: "uploading", loaded: 0, total: null, started, changed: started, uploaded: null });
    try {
      const result = await replaceItemPhoto({ itemId: item.id, expectedVersion: pending.expectedVersion, operationId: pending.operationId, image: pending.file }, controller.signal, progress => {
        if (owner !== generation.current || controller.signal.aborted) return;
        const now = Date.now(); setClock(now);
        setTransfer(previous => ({ ...progress, started,
          changed: !previous || progress.loaded > previous.loaded ? now : previous.changed,
          uploaded: progress.phase === "saving" ? previous?.uploaded ?? now : null }));
      });
      if (owner !== generation.current) return;
      setPending(null); setTransfer(null); setReview(false); onSaved(result.item);
    } catch (cause) {
      if (owner !== generation.current) return;
      if (cause instanceof ApiError && cause.status === 409) { setReview(true); await onConflict(cause); }
      if (owner === generation.current) setError(cause instanceof Error ? cause.message : "照片保存失败，请重试");
    } finally {
      if (upload.current === controller) upload.current = null;
      if (owner === generation.current) { saving.current = false; setWorking(false); }
    }
  }
  const elapsed = transfer ? Math.max(0, Math.floor((clock - transfer.started) / 1000)) : 0;
  const quiet = transfer ? Math.max(0, Math.floor((clock - transfer.changed) / 1000)) : 0;
  const sentSeconds = transfer ? ((transfer.uploaded ?? clock) - transfer.started) / 1000 : 0;
  const percentage = transfer?.total ? Math.min(100, Math.floor(transfer.loaded / transfer.total * 100)) : undefined;
  return <section className="item-photo-editor" aria-label="更换物品照片">
    <label className="inventory-upload">添加 / 更换照片<input aria-label="物品照片" type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled || working} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void choose(file); }} /></label>
    {preparing && <p role="status">正在处理照片…</p>}
    {pending && preview && <div className="quick-photo-preview"><img src={preview} alt="待上传照片预览" /><p className="quick-photo-size">原照片 {size(pending.originalBytes)} · 待上传 {size(pending.file.size)}{pending.compressed ? " · 已在本机压缩" : " · 保留原图"}</p></div>}
    {error && <p role="alert" className="inventory-error">{error}</p>}
    {review && <div className="inventory-error"><p>照片仍已保留。请先核对上方最新资料，再确认是否替换当前照片。</p><button type="button" disabled={disabled || working || Boolean(item.archived_at)} onClick={() => {
      if (pending) setPending({ ...pending, expectedVersion: item.version, operationId: crypto.randomUUID() });
      setReview(false); setError("");
    }}>核对后继续换图</button></div>}
    {working && transfer && <section className="quick-upload-status" aria-label="照片上传进度" ref={panel}>
      <div className="quick-upload-heading"><strong>{transfer.phase === "saving" ? "照片已传完，等待服务器确认保存" : "正在上传照片…"}</strong>{percentage !== undefined && <span>{percentage}%</span>}</div>
      <progress style={{ width: "100%", accentColor: "var(--accent)" }} max={100} value={percentage} aria-label="上传进度" />
      <p role="status">已上传 {size(transfer.loaded)}{transfer.total ? ` / ${size(transfer.total)}` : " · 总量尚未获知"} · 已等待 {elapsed} 秒{sentSeconds > 0 && transfer.loaded > 0 ? ` · ${size(transfer.loaded / sentSeconds)}/秒` : ""}</p>
      {transfer.phase === "uploading" && quiet >= 10 && <p>暂时没有新的上传进度，可以继续等待或取消后重试。</p>}
      <button type="button" onClick={() => upload.current?.abort()}>取消上传</button>
    </section>}
    {(pending || preparing) && <div className="inventory-actions"><button type="button" className="inventory-primary" disabled={disabled || working || preparing || review || !pending} onClick={() => void save()}>保存照片</button><button type="button" disabled={working} onClick={discard}>放弃所选照片</button></div>}
  </section>;
}
