import { useEffect, useRef, useState } from "react";
import { ApiError, type Item, type MeResponse } from "../api/client";
import { quickRegisterItem, type UploadProgress } from "../api/mobile";
import { forgetLocation, rememberLocation } from "../lib/recentLocation";
import { preparePhoto } from "../lib/preparePhoto";
import { LocationPicker } from "./LocationPicker";
import { Modal } from "./Modal";

function transferSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  const kilobytes = bytes / 1024;
  return `${kilobytes.toFixed(kilobytes > 0 && kilobytes < 10 && !Number.isInteger(kilobytes) ? 1 : 0)} KB`;
}
type TransferState = UploadProgress & { startedAt: number; lastProgressAt: number; uploadedAt: number | null };

export function QuickRegisterDialog({ me, initialCompartmentId = "", onClose, onSaved }: {
  me: MeResponse; initialCompartmentId?: string; onClose: () => void; onSaved: (item: Item) => void;
}) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [photo, setPhoto] = useState<File | undefined>();
  const [preview, setPreview] = useState("");
  const [preparing, setPreparing] = useState(false);
  const [photoInfo, setPhotoInfo] = useState<{ originalBytes: number; compressed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const [clock, setClock] = useState(0);
  const photoRevision = useRef(0);
  const operation = useRef({ signature: "", id: "" });
  const saving = useRef(false);
  const generation = useRef(0);
  const upload = useRef<AbortController | null>(null);
  const preparation = useRef<AbortController | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const locationFields = useRef<HTMLDivElement>(null);
  const progressPanel = useRef<HTMLElement>(null);
  useEffect(() => () => { generation.current++; upload.current?.abort(); preparation.current?.abort(); }, []);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (busy) progressPanel.current?.scrollIntoView?.({ block: "nearest" });
  }, [busy, transfer?.phase]);
  useEffect(() => {
    if (!photo) { setPreview(""); return; }
    const objectUrl = URL.createObjectURL(photo); setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [photo]);

  async function selectPhoto(file?: File) {
    if (!file || saving.current) return;
    preparation.current?.abort();
    const controller = new AbortController(); preparation.current = controller;
    const owner = generation.current;
    photoRevision.current++;
    setPhoto(undefined); setPhotoInfo(null); setError(""); setPreparing(true);
    try {
      const prepared = await preparePhoto(file, controller.signal);
      if (owner !== generation.current || preparation.current !== controller || controller.signal.aborted) return;
      setPhoto(prepared.file); setPhotoInfo({ originalBytes: prepared.originalBytes, compressed: prepared.compressed });
    } catch (error) {
      if (owner !== generation.current || preparation.current !== controller || controller.signal.aborted) return;
      setError(error instanceof Error ? error.message : "照片处理失败，请重新选择");
    } finally {
      if (owner === generation.current && preparation.current === controller) {
        preparation.current = null; setPreparing(false);
      }
    }
  }

  function removePhoto() {
    preparation.current?.abort(); preparation.current = null;
    photoRevision.current++; setPreparing(false); setPhoto(undefined); setPhotoInfo(null);
  }

  async function save() {
    if (saving.current || preparation.current) return;
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 120) { setError("请填写 1–120 字的物品名称"); nameInput.current?.focus(); return; }
    if (!location) {
      setError("请选择物品所在的隔层");
      const selects = Array.from(locationFields.current?.querySelectorAll("select") ?? []);
      const emptySelect = selects.find(select => !select.value && !select.disabled);
      (emptySelect ?? locationFields.current?.querySelector<HTMLButtonElement>("button[aria-pressed]"))?.focus();
      return;
    }
    const signature = JSON.stringify({ name: trimmedName, location, photo: photoRevision.current });
    try {
      if (signature !== operation.current.signature) operation.current = { signature, id: crypto.randomUUID() };
    } catch { setError("无法开始登记，请刷新页面后重试"); return; }
    saving.current = true; setBusy(true); setError("");
    const owner = generation.current;
    const controller = new AbortController(); upload.current = controller;
    const startedAt = Date.now();
    setClock(startedAt);
    setTransfer({ phase: "uploading", loaded: 0, total: null, startedAt, lastProgressAt: startedAt, uploadedAt: null });
    try {
      const { item } = await quickRegisterItem({ name: trimmedName, compartmentId: location, operationId: operation.current.id, image: photo }, controller.signal, progress => {
        if (owner !== generation.current || upload.current !== controller || controller.signal.aborted) return;
        const now = Date.now();
        setClock(now);
        setTransfer(previous => ({
          ...progress,
          startedAt,
          lastProgressAt: !previous || progress.loaded > previous.loaded ? now : previous.lastProgressAt,
          uploadedAt: progress.phase === "saving" ? previous?.uploadedAt ?? now : null,
        }));
      });
      if (owner !== generation.current) return;
      rememberLocation(me, location); onSaved(item);
    } catch (error) {
      if (owner !== generation.current) return;
      if (error instanceof ApiError && error.code === "compartment_not_found") { forgetLocation(me, location); setLocation(""); }
      setError(error instanceof Error ? error.message : "登记失败，请重试");
    } finally {
      if (upload.current === controller) upload.current = null;
      if (owner === generation.current) { saving.current = false; setBusy(false); }
    }
  }

  const elapsed = transfer ? Math.max(0, Math.floor((clock - transfer.startedAt) / 1000)) : 0;
  const quietSeconds = transfer ? Math.max(0, Math.floor((clock - transfer.lastProgressAt) / 1000)) : 0;
  const uploadSeconds = transfer ? Math.max(0, ((transfer.uploadedAt ?? clock) - transfer.startedAt) / 1000) : 0;
  const speed = transfer && uploadSeconds > 0 && transfer.loaded > 0 ? transferSize(transfer.loaded / uploadSeconds) : null;
  const percentage = transfer?.total ? Math.min(100, Math.floor((transfer.loaded / transfer.total) * 100)) : undefined;

  return <Modal title="拍照登记" onClose={onClose} busy={busy} dirty={Boolean(name || photo || preparing || (location && location !== initialCompartmentId))}>
    <form className="inventory-form quick-register-form" noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className="inventory-muted">拍一张实物或所在抽屉的照片，再填写名称和位置。也可以暂不添加照片。</p>
      <fieldset disabled={busy}>
        <label className="quick-photo-picker"><span>拍摄或选择照片</span><input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void selectPhoto(file); }} /></label>
        {preparing && <div className="quick-photo-processing"><p role="status">正在处理照片…</p><p className="inventory-muted">在这台设备上减小照片后上传。你可以继续填写名称和位置，或重新选择照片。</p><button type="button" onClick={removePhoto}>取消照片处理</button></div>}
        {preview && photo && <div className="quick-photo-preview"><img src={preview} alt="待登记照片预览" />{photoInfo && <p className="quick-photo-size">原照片 {transferSize(photoInfo.originalBytes)} · 待上传 {transferSize(photo.size)}{photoInfo.compressed ? "（已压缩）" : "（保留原图）"}</p>}<button type="button" onClick={removePhoto}>移除照片</button></div>}
        <label>物品名称<input ref={nameInput} value={name} onChange={event => setName(event.target.value)} maxLength={120} required placeholder="例如：备用相机" autoComplete="off" /></label>
        <div ref={locationFields}><LocationPicker value={location} onChange={setLocation} initialCompartmentId={initialCompartmentId} onInvalidInitial={id => forgetLocation(me, id)} /></div>
      </fieldset>
      {error && <div className="inventory-error" role="alert">{error}</div>}
      {busy && transfer && <section ref={progressPanel} className="quick-upload-status" aria-label="上传状态" role="status" aria-live="polite">
        <div className="quick-upload-heading"><strong>{transfer.phase === "saving" ? (photo ? "照片已传完，等待服务器确认保存" : "数据已传完，等待服务器确认保存") : photo ? "正在上传照片…" : "正在发送物品信息…"}</strong>{percentage !== undefined && <span>{percentage}%</span>}</div>
        <div className={`quick-upload-track${percentage === undefined ? " is-indeterminate" : ""}`} role="progressbar" aria-label="上传进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}>
          {percentage !== undefined && <span style={{ width: `${percentage}%` }} />}
        </div>
        <p className="quick-upload-bytes">已发送 {transferSize(transfer.loaded)} / {transfer.total !== null ? transferSize(transfer.total) : "总量未知"}</p>
        <div className="quick-upload-metrics"><span>已用时 {elapsed} 秒</span><span>{speed ? `平均速度 ${speed}/s` : "等待上传速度数据"}</span></div>
        {transfer.phase === "uploading" && quietSeconds > 10 && <p className="quick-upload-notice">已 {quietSeconds} 秒没有新的上传进度，可继续等待或停止等待</p>}
        {transfer.phase === "saving" && <p className="quick-upload-notice">正在等待服务器返回结果，请勿重复登记。</p>}
        <button type="button" onClick={() => upload.current?.abort()}>停止等待</button>
      </section>}
      <button type="submit" className="inventory-primary" disabled={busy || preparing}>{busy ? "正在保存…" : "保存物品"}</button>
    </form>
  </Modal>;
}
