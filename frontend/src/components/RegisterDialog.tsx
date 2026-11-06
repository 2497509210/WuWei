import { useEffect, useRef, useState } from "react";
import { ApiError, registerItems, type Item, type MeResponse } from "../api/client";
import { forgetLocation, rememberLocation } from "../lib/recentLocation";
import { LocationPicker } from "./LocationPicker";
import { Modal } from "./Modal";

export function RegisterDialog({ me, initialCompartmentId = "", onClose, onSaved, onRegistered }: {
  me: MeResponse; initialCompartmentId?: string; onClose: () => void; onSaved: (count: number) => void; onRegistered?: (items: Item[]) => void;
}) {
  const [location, setLocation] = useState("");
  const [names, setNames] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef({ signature: "", id: "" });
  const saving = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);

  async function save() {
    if (saving.current) return;
    const entries = names.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
    if (!location || !entries.length) { setError("请选择隔层，并填写至少一件物品"); return; }
    if (entries.length > 100 || entries.some(name => name.length > 120)) { setError("每次最多登记 100 条，每条名称不超过 120 字"); return; }
    const signature = JSON.stringify({ location, entries });
    if (operation.current.signature !== signature) operation.current = { signature, id: crypto.randomUUID() };
    saving.current = true; setBusy(true); setError("");
    const owner = generation.current;
    try {
      const result = await registerItems(location, entries, operation.current.id);
      if (owner !== generation.current) return;
      rememberLocation(me, location); onRegistered?.(result.items); onSaved(result.items.length);
    } catch (error) {
      if (owner !== generation.current) return;
      if (error instanceof ApiError && error.code === "compartment_not_found") { forgetLocation(me, location); setLocation(""); }
      setError(error instanceof Error ? error.message : "登记失败，请重试");
    } finally { if (owner === generation.current) { saving.current = false; setBusy(false); } }
  }

  return <Modal title="一起记在这个位置" onClose={onClose} busy={busy} dirty={Boolean(names || (location && location !== initialCompartmentId))}><form className="inventory-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    <p className="inventory-muted">选一次位置，登记多件物品；也可以先记成一组。</p>
    <fieldset disabled={busy}>
      <LocationPicker me={me} value={location} onChange={setLocation} initialCompartmentId={initialCompartmentId} onInvalidInitial={id => forgetLocation(me, id)} />
      <label>物品名称，每行一件或一组<textarea rows={5} value={names} onChange={event => setNames(event.target.value)} placeholder={"护照\n备用线材一组\n露营工具一箱"} required /></label>
    </fieldset>
    {error && <p className="inventory-error" role="alert">{error}</p>}
    <button className="inventory-primary" disabled={busy} type="submit">{busy ? "正在登记…" : "保存登记"}</button>
  </form></Modal>;
}
