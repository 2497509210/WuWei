import { useEffect, useMemo, useRef, useState } from "react";
import { listItems, type Item, type MeResponse } from "../api/client";
import { Brand } from "../components/Brand";
import { ItemDetail, confirmedDate } from "../components/ItemDetail";
import { RegisterDialog } from "../components/RegisterDialog";
import { QuickRegisterDialog } from "../components/QuickRegisterDialog";
import { recentLocation } from "../lib/recentLocation";
import { InstallGuide } from "../components/InstallGuide";
import { BulkActionDialog, type BulkSelection } from "../components/BulkActionDialog";
import type { BulkAction, BulkResult } from "../api/bulk";
import { ExportDialog } from "../components/ExportDialog";
import type { ExportFilter } from "../api/exports";
import "../styles/bulk.css";

export type LocateTarget = { roomId: string; containerId: string; compartmentId: string | null };

type InventoryProps = { me: MeResponse; onLogout: () => Promise<void>; onArrange: (target?: LocateTarget) => void; onSettings?: () => void; onClearCompartment?: () => void; initialCompartment?: string; initialAction?: "register" | "capture"; onConsumedAction?: () => void };
export function InventoryPage(props: InventoryProps) {
  return <InventoryContent key={`${props.me.household.id}:${props.me.user.id}`} {...props} />;
}
function InventoryContent({ me, onLogout, onArrange, onSettings, onClearCompartment, initialCompartment = "", initialAction, onConsumedAction }: InventoryProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(initialCompartment);
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item | null>(null);
  const [registration, setRegistration] = useState<{ kind: "register" | "capture"; initialId: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [bulkMode, setBulkMode] = useState(false);
  const [selection, setSelection] = useState<BulkSelection[]>([]);
  const [selectionError, setSelectionError] = useState("");
  const [bulkDialog, setBulkDialog] = useState<{ action: BulkAction; items: BulkSelection[] } | null>(null);
  const [exportDialog, setExportDialog] = useState<{ filter: ExportFilter; selectedIds: string[] } | null>(null);
  // Every committed query or refresh gets its own identity, even when returning
  // to previously viewed criteria. Only its successful response permits writes.
  const requestedView = useMemo(() => ({ query, filter, status, revision, initialCompartment }), [query, filter, status, revision, initialCompartment]);
  const [verifiedView, setVerifiedView] = useState<typeof requestedView | null>(null);
  const [failedView, setFailedView] = useState<typeof requestedView | null>(null);
  const liveView = useRef(requestedView); liveView.current = requestedView;
  const failed = failedView === requestedView;
  const trusted = verifiedView === requestedView && !loading && !failed;
  const pending = !failed && (loading || verifiedView !== requestedView);
  const sequence = useRef(0);
  const consumed = useRef("");
  const onConsumed = useRef(onConsumedAction); onConsumed.current = onConsumedAction;
  useEffect(() => { setFilter(initialCompartment); }, [initialCompartment]);
  useEffect(() => { setSelection([]); setSelectionError(""); setBulkDialog(null); setExportDialog(null); }, [query, filter, status]);
  useEffect(() => { setBulkDialog(null); setExportDialog(null); }, [requestedView]);
  useEffect(() => {
    if (!initialAction) { consumed.current = ""; return; }
    const key = `${initialAction}:${initialCompartment}`;
    if (consumed.current === key) return;
    consumed.current = key;
    setStatus("active"); setSelected(null); setBulkDialog(null); setExportDialog(null); setBulkMode(false); setSelection([]);
    setRegistration({ kind: initialAction, initialId: initialCompartment || recentLocation(me) });
    onConsumed.current?.();
  }, [initialAction, initialCompartment, me.user.id, me.household.id]);
  function openRegistration(kind: "register" | "capture") {
    setRegistration({ kind, initialId: filter || recentLocation(me) });
  }
  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setLoading(true); setError("");
    const isCurrent = () => current === sequence.current && liveView.current === requestedView && !controller.signal.aborted;
    const timeout = window.setTimeout(() => {
      listItems(query, status === "active" ? filter : "", controller.signal, status).then(result => {
        if (isCurrent()) {
          setItems(result.items);
          setVerifiedView(requestedView); setFailedView(null);
          setSelection(selected => selected.filter(entry => result.items.some(item => item.id === entry.id)));
        }
      })
        .catch(error => {
          if (isCurrent()) {
            setError(error instanceof Error ? error.message : "加载失败"); setFailedView(requestedView);
            setSelection([]); setSelectionError(""); setBulkDialog(null); setExportDialog(null);
          }
        })
        .finally(() => { if (isCurrent()) setLoading(false); });
    }, query ? 180 : 0);
    return () => { ++sequence.current; controller.abort(); window.clearTimeout(timeout); };
  }, [requestedView]);
  function updated(item: Item) {
    setItems(current => current.map(entry => entry.id === item.id ? item : entry)
      .filter(entry => Boolean(entry.archived_at) === (status === "archived")));
    setRevision(value => value + 1);
  }
  function snapshot(item: Item): BulkSelection {
    return { id: item.id, name: item.name, quantity: item.quantity, version: item.version, compartment_id: item.compartment_id, archived_at: item.archived_at };
  }
  function toggleItem(item: Item) {
    if (!trusted || bulkDialog) return;
    setSelectionError("");
    setSelection(current => {
      if (current.some(entry => entry.id === item.id)) return current.filter(entry => entry.id !== item.id);
      if (current.length >= 100) { setSelectionError("每次最多选择 100 条物品记录"); return current; }
      return [...current, snapshot(item)];
    });
  }
  function selectAll() {
    if (!trusted) return;
    if (items.length > 100) { setSelectionError("当前结果超过 100 条，请缩小筛选范围后再全选"); return; }
    setSelectionError("");
    setSelection(current => items.map(item => current.find(entry => entry.id === item.id) ?? snapshot(item)));
  }
  function bulkSucceeded(result: BulkResult) {
    setBulkDialog(null); setSelection([]); setSelectionError("");
    setItems(current => current.map(item => result.items.find(updated => updated.id === item.id) ?? item)
      .filter(item => Boolean(item.archived_at) === (status === "archived")));
    setNotice(`已处理 ${result.processed} 条，实际更改 ${result.changed} 条`);
    setRevision(value => value + 1);
  }
  function refreshAfterConflict() {
    setBulkDialog(null); setSelection([]); setSelectionError(""); setRevision(value => value + 1);
    setNotice("请核对刷新后的清单，重新选择需要处理的物品");
  }
  function openBulk(action: BulkAction) {
    if (trusted && selection.length) setBulkDialog({ action, items: [...selection] });
  }
  function openExport() {
    if (trusted) setExportDialog({ filter: { status, q: query.trim(), compartmentId: status === "active" ? filter : "" }, selectedIds: selection.map(item => item.id) });
  }
  return <div className="inventory-page">
    <header className="inventory-header"><Brand compact /><nav aria-label="主导航"><button aria-current="page">家庭找物</button><button onClick={() => onArrange()}>空间</button></nav><span className="inventory-household">{me.household.name}</span>{onSettings && <button className="inventory-logout" aria-label="账号与家庭" onClick={onSettings}>账号</button>}<button className="inventory-logout" onClick={() => void onLogout()}>退出</button></header>
    <main className="inventory-main">
      <section className="inventory-intro"><span className="eyebrow">EVERYTHING HAS A PLACE</span><h1>记住物品的位置，<br />把时间留给生活。</h1><p>从证件、工具和备用物品开始，慢慢整理你的家。</p></section>
      <InstallGuide />
      <div className="inventory-search-row"><label className="inventory-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="搜索物品" placeholder="找什么？试试名称、别名或备注" value={query} onChange={event => setQuery(event.target.value)} /></label>{status === "active" && <div className="inventory-entry-actions"><button className="inventory-primary" onClick={() => openRegistration("capture")}>拍照登记</button><button onClick={() => openRegistration("register")}>登记物品</button></div>}</div>
      <div className="inventory-status-tabs" role="group" aria-label="物品状态">
        <button type="button" aria-pressed={status === "active"} onClick={() => { setStatus("active"); setNotice(""); }}>在用</button>
        <button type="button" aria-pressed={status === "archived"} onClick={() => { setStatus("archived"); setNotice(""); }}>已归档</button>
      </div>
      <div className="inventory-tools">
        <button type="button" onClick={() => { setBulkMode(value => !value); setSelection([]); setSelectionError(""); }}>{bulkMode ? "退出批量整理" : "批量整理"}</button>
        <button type="button" disabled={pending} onClick={() => setRevision(value => value + 1)}>刷新清单</button>
        <button type="button" disabled={!trusted} onClick={openExport}>导出清单</button>
      </div>
      {bulkMode && <div className="bulk-toolbar" role="group" aria-label="批量整理操作">
        <strong>已选 {selection.length} 条</strong>
        <button type="button" disabled={!trusted || items.length === 0} onClick={selectAll}>全选当前结果</button>
        <button type="button" disabled={selection.length === 0} onClick={() => { setSelection([]); setSelectionError(""); }}>清空选择</button>
        <div className="bulk-toolbar-actions">
          {status === "active" ? <><button type="button" disabled={!trusted || selection.length === 0} onClick={() => openBulk("move")}>批量移动</button><button type="button" disabled={!trusted || selection.length === 0} onClick={() => openBulk("archive")}>批量归档</button></>
            : <button type="button" disabled={!trusted || selection.length === 0} onClick={() => openBulk("restore")}>批量恢复</button>}
        </div>
      </div>}
      {selectionError && <div className="inventory-error bulk-selection-error" role="alert">{selectionError}</div>}
      <div className="inventory-list-heading"><h2>{!trusted ? (pending ? "正在核验清单" : "上次加载的结果") : query ? "搜索结果" : status === "archived" ? "已归档的物品" : filter ? "这个隔层里的物品" : "家里的物品"}</h2><span>{trusted ? `${items.length} 条记录` : pending ? "正在查找…" : "当前数量未确认"}</span>{filter && status === "active" && <button onClick={() => { setFilter(""); onClearCompartment?.(); }}>查看全部</button>}</div>
      {failed && <div className="inventory-error" role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>重新加载</button></div>}
      {failed && <div className="inventory-stale-note" role="status"><strong>{verifiedView ? "当前筛选未能加载，以下为上次结果" : "当前筛选未能加载，尚无已核验的结果"}</strong><p>可打开单件详情重新读取最新资料；清单重新加载成功前，不能勾选、批量处理或导出。</p></div>}
      {notice && <p className="inventory-success" role="status">{notice}</p>}
      {pending ? <p role="status" className="inventory-loading">正在读取物品…</p> : !items.length ? (failed ? null : <div className="inventory-empty"><span aria-hidden="true">⌂</span><h3>{query ? "还没有找到这件物品" : status === "archived" ? "还没有归档物品" : "给第一件物品留下位置"}</h3><p>{query ? "换个叫法试试，也可以在资料中补充别名。" : status === "archived" ? "暂时不用的物品可以归档；需要时选择一个位置恢复。" : "选择一个隔层，一次登记多件；一箱露营工具也可以先记成一组。"}</p>{(query || status === "active") && <button onClick={() => query ? setQuery("") : openRegistration("register")}>{query ? "清除搜索" : "开始登记"}</button>}{status === "active" && <button onClick={() => onArrange()}>布置房间和容器</button>}</div>) :
        <div className="inventory-grid">{items.map(item => <div key={item.id} className={bulkMode ? `inventory-selection-row${selection.some(entry => entry.id === item.id) ? " is-selected" : ""}` : "inventory-item-wrap"}>
          {bulkMode && <label className="bulk-select-box"><input type="checkbox" aria-label={`选择${item.name}`} disabled={!trusted} checked={selection.some(entry => entry.id === item.id)} onChange={() => toggleItem(item)} /><span className="bulk-select-caption">选择{item.name}</span></label>}
          <button className="inventory-item" aria-label={`查看${item.name}`} onClick={() => setSelected(item)}>
          {item.photo_url ? <img loading="lazy" src={item.photo_url} alt="" /> : <span className="inventory-item-placeholder" aria-hidden="true">{item.name.slice(0,1)}</span>}
          <div className="inventory-item-copy"><strong>{item.name}</strong><span>{item.archived_at && "归档前："}{item.location_path.join(" › ") || "暂未分配位置"}</span><small className={!item.archived_at && item.location_status === "missing" ? "missing-note" : ""}>{item.archived_at ? `已归档 · ${item.archive_reason || confirmedDate(item.archived_at)}` : item.location_status === "missing" ? "待找回 · 位置需更新" : `最后确认 ${confirmedDate(item.last_confirmed_at)}`}</small></div><span aria-hidden="true">↗</span>
        </button></div>)}</div>}
    </main>
    {selected && <ItemDetail key={selected.id} initial={selected} onClose={() => setSelected(null)} onUpdated={updated} onLocate={onArrange} />}
    {registration?.kind === "register" && <RegisterDialog key={registration.initialId} me={me} initialCompartmentId={registration.initialId} onClose={() => setRegistration(null)} onSaved={count => { setRegistration(null); setRevision(value => value + 1); setNotice(`已登记 ${count} 条物品记录`); }} />}
    {registration?.kind === "capture" && <QuickRegisterDialog key={registration.initialId} me={me} initialCompartmentId={registration.initialId} onClose={() => setRegistration(null)} onSaved={item => { setRegistration(null); setRevision(value => value + 1); setNotice(`已登记「${item.name}」`); }} />}
    {trusted && bulkDialog && <BulkActionDialog action={bulkDialog.action} items={bulkDialog.items} onClose={() => setBulkDialog(null)} onSuccess={bulkSucceeded} onConflict={refreshAfterConflict} />}
    {trusted && exportDialog && <ExportDialog filter={exportDialog.filter} selectedIds={exportDialog.selectedIds} onClose={() => setExportDialog(null)} />}
  </div>;
}
