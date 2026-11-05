import { useEffect, useRef, useState } from "react";
import type { Compartment } from "../api/client";
import { useWorkspace } from "../store/useWorkspace";

export function CompartmentNameEditor({ compartment }: { compartment: Compartment }) {
  const [name, setName] = useState(compartment.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const draft = useRef({ dirty: false, revision: 0 });
  const rename = useWorkspace(state => state.renameCompartment);
  const defaultName = compartment.default_name ?? compartment.name;
  useEffect(() => {
    if (!draft.current.dirty) setName(compartment.name);
    setError(""); setSaved(false);
  }, [compartment.id, compartment.name]);

  async function save(customName: string | null) {
    if (busy) return;
    const revision = draft.current.revision;
    setBusy(true); setError(""); setSaved(false);
    const ok = await rename(compartment.container_id, compartment.id, customName);
    setBusy(false);
    if (ok && draft.current.revision === revision) {
      const current = useWorkspace.getState().room?.containers.find(container => container.id === compartment.container_id)
        ?.compartments.find(entry => entry.id === compartment.id);
      draft.current.dirty = false;
      setName(customName ?? current?.default_name ?? defaultName);
      setSaved(true);
    }
    else if (!ok) setError(useWorkspace.getState().error || "名称保存失败，请重试");
  }

  return <form className="compartment-name-editor inventory-form" onSubmit={event => { event.preventDefault(); void save(name.trim()); }}>
    <label>隔层名称<input maxLength={60} required value={name} disabled={busy} onChange={event => {
      draft.current = { dirty: true, revision: draft.current.revision + 1 };
      setName(event.target.value); setSaved(false);
    }} placeholder="例如：证件抽屉" /></label>
    <p className="inventory-muted">自动名称：{defaultName}。自定义名称会随这个隔层保留。</p>
    <div className="inventory-actions">
      <button type="submit" disabled={busy || !name.trim() || name.trim() === compartment.name}>{busy ? "正在保存…" : "保存名称"}</button>
      {compartment.custom_name != null && <button type="button" disabled={busy} onClick={() => void save(null)}>恢复自动名称</button>}
    </div>
    {error && <p className="inventory-error" role="alert">{error}</p>}
    {saved && <p className="inventory-success" role="status">隔层名称已保存</p>}
  </form>;
}
