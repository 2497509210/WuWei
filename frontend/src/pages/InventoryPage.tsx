import { useEffect, useMemo, useRef, useState } from "react";
import { getBootstrap, listItems, type Item, type MeResponse, type RoomSummary } from "../api/client";
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
import { resolveCompartment } from "../api/mobile";
import { findSearch, type FindNavigation, type FindView } from "../lib/findNavigation";
import { useFindScroll } from "../hooks/useFindScroll";
import { useInventoryRefresh } from "../hooks/useInventoryRefresh";
import { RegistrationReceipt } from "../components/RegistrationReceipt";
import "../styles/bulk.css";
import "../styles/inventory-controls.css";
import "../styles/registration-receipt.css";

export type LocateTarget = { roomId: string; containerId: string; compartmentId: string | null };

type InventoryProps = { me: MeResponse; onLogout: () => Promise<void>; onArrange: (target?: LocateTarget) => void; onSettings?: () => void; onClearCompartment?: () => void; initialCompartment?: string; initialAction?: "register" | "capture"; onConsumedAction?: () => void; navigation?: FindNavigation };
export function InventoryPage(props: InventoryProps) {
  return <InventoryContent key={`${props.me.household.id}:${props.me.user.id}`} {...props} />;
}
function InventoryContent({ me, onLogout, onArrange, onSettings, onClearCompartment, initialCompartment = "", initialAction, onConsumedAction, navigation }: InventoryProps) {
  const [localView, setLocalView] = useState<FindView>({ query: "", filter: initialCompartment, status: "active", roomId: "", page: 1 });
  const view = navigation?.view ?? localView;
  const { query, filter, status, roomId, page } = view;
  function updateView(change: Partial<FindView>, replace = false, immediate = false) {
    const normalizeRoomSelection = (next: FindView): FindView => {
      const choice = chosenRoomForShelf.current;
      const verifiedRoom = shelfLocation.id === next.filter && !shelfLocation.loading && !shelfLocation.error && shelfLocation.roomId;
      return next.status !== "archived" && next.filter && next.roomId && choice?.shelf === next.filter
        && choice.room === next.roomId && verifiedRoom && next.roomId !== verifiedRoom
        ? { ...next, filter: "", page: 1 } : next;
    };
    const next = normalizeRoomSelection({ ...view, ...change });
    if (navigation) navigation.onChange(next, replace, immediate);
    else setLocalView(current => normalizeRoomSelection({ ...current, ...change }));
  }
  // A user can change another control before a router transition paints. Commit
  // event-driven criteria together; effects and async page corrections stay deferred.
  function changeView(change: Partial<FindView>, replace = false) { updateView(change, replace, true); }
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [roomError, setRoomError] = useState("");
  const [roomRevision, setRoomRevision] = useState(0);
  const [shelfRevision, setShelfRevision] = useState(0);
  const [shelfLocation, setShelfLocation] = useState<{ id: string; roomId: string; error: string; loading: boolean }>({ id: "", roomId: "", error: "", loading: false });
  const chosenRoomForShelf = useRef<{ shelf: string; room: string } | null>(null);
  const clearCompartment = useRef(onClearCompartment); clearCompartment.current = onClearCompartment;
  const [pagination, setPagination] = useState({ total: 0, page: 1, pageSize: 40, hasMore: false });
  const [more, setMore] = useState(false);
  const moreArea = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const listHeading = useRef<HTMLDivElement>(null);
  const apiStatus = status === "archived" ? "archived" : "active";
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<Item | null>(null);
  const [registration, setRegistration] = useState<{ kind: "register" | "capture"; initialId: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [registered, setRegistered] = useState<Item[]>([]);
  const [bulkMode, setBulkMode] = useState(false);
  const [selection, setSelection] = useState<BulkSelection[]>([]);
  const [selectionError, setSelectionError] = useState("");
  const [bulkDialog, setBulkDialog] = useState<{ action: BulkAction; items: BulkSelection[] } | null>(null);
  const [exportDialog, setExportDialog] = useState<{ filter: ExportFilter; selectedIds: string[] } | null>(null);
  // Every committed query or refresh gets its own identity, even when returning
  // to previously viewed criteria. Only its successful response permits writes.
  const requestedView = useMemo(() => ({ query, filter, status, roomId, page, revision, initialCompartment }), [query, filter, status, roomId, page, revision, initialCompartment]);
  const [verifiedView, setVerifiedView] = useState<typeof requestedView | null>(null);
  const [failedView, setFailedView] = useState<typeof requestedView | null>(null);
  const liveView = useRef(requestedView); liveView.current = requestedView;
  const failed = failedView === requestedView;
  const trusted = verifiedView === requestedView && !loading && !failed;
  const pending = !failed && (loading || verifiedView !== requestedView);
  const refresh = useInventoryRefresh(Boolean(selected || registration || bulkMode || selection.length || bulkDialog || exportDialog), pending,
    () => setRevision(value => value + 1));
  const scrollPage = useFindScroll(me, navigation ? "/find" + findSearch(view) : undefined, trusted, listHeading);
  const sequence = useRef(0);
  const consumed = useRef("");
  const onConsumed = useRef(onConsumedAction); onConsumed.current = onConsumedAction;
  useEffect(() => { if (!navigation) setLocalView(current => ({ ...current, filter: initialCompartment, page: 1, ...(initialCompartment ? { roomId: "" } : {}) })); }, [initialCompartment]);
  useEffect(() => { setSelection([]); setSelectionError(""); setBulkDialog(null); setExportDialog(null); }, [query, filter, status, roomId, page, navigation?.entry]);
  useEffect(() => { setBulkDialog(null); setExportDialog(null); }, [requestedView]);
  useEffect(() => {
    let current = true;
    setRoomError("");
    getBootstrap().then(result => { if (current) setRooms(result.floors?.flatMap(floor => floor.rooms) ?? []); })
      .catch(error => { if (current) setRoomError(error instanceof Error ? error.message : "房间筛选暂时不可用"); });
    return () => { current = false; };
  }, [roomRevision]);
  useEffect(() => {
    const controller = new AbortController();
    if (!filter) { setShelfLocation({ id: "", roomId: "", error: "", loading: false }); return; }
    setShelfLocation({ id: filter, roomId: "", error: "", loading: true });
    resolveCompartment(filter, controller.signal).then(({ location }) => {
      if (controller.signal.aborted) return;
      if (!location || location.compartment_id !== filter || !location.room_id) throw new Error("无法核对隔层位置，请重试");
      setShelfLocation({ id: filter, roomId: location.room_id, error: "", loading: false });
    }).catch(error => {
      if (!controller.signal.aborted) setShelfLocation({ id: filter, roomId: "", error: error instanceof Error ? error.message : "无法核对隔层位置，请重试", loading: false });
    });
    return () => controller.abort();
  }, [filter, shelfRevision]);
  useEffect(() => {
    if (!filter || status === "archived") { chosenRoomForShelf.current = null; return; }
    const choice = chosenRoomForShelf.current;
    if (!choice || choice.shelf !== filter || choice.room !== roomId
      || !roomId || shelfLocation.id !== filter || !shelfLocation.roomId || shelfLocation.error || shelfLocation.loading) return;
    if (roomId !== shelfLocation.roomId) {
      updateView({ filter: "", page: 1 }, true); if (!navigation) clearCompartment.current?.();
    }
  }, [filter, roomId, shelfLocation, status]);
  useEffect(() => {
    if (!more) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !moreArea.current?.contains(event.target) && !(event.target instanceof Element && event.target.closest("dialog"))) setMore(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector("dialog[open]")) { setMore(false); moreButton.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [more]);
  useEffect(() => {
    if (!initialAction) { consumed.current = ""; return; }
    const key = `${initialAction}:${initialCompartment}`;
    if (consumed.current === key) return;
    consumed.current = key;
    if (!navigation) updateView({ status: "active", page: 1 });
    setSelected(null); setBulkDialog(null); setExportDialog(null); setBulkMode(false); setSelection([]);
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
      listItems(query, status !== "archived" ? filter : "", controller.signal, apiStatus, {
        page, pageSize: 40, roomId: status !== "archived" ? roomId : "", locationStatus: status === "missing" ? "missing" : undefined,
      }).then(result => {
        if (isCurrent()) {
          // Deletions/archiving may remove the final page while this client is browsing it.
          if (result.total !== undefined && page > 1 && result.items.length === 0 && result.total <= (page - 1) * 40) {
            updateView({ page: Math.max(1, Math.ceil(result.total / 40)) }, true); return;
          }
          setItems(result.items);
          setPagination({ total: result.total ?? result.items.length, page: result.page ?? page, pageSize: result.page_size ?? 40, hasMore: result.has_more ?? false });
          setVerifiedView(requestedView); setFailedView(null);
          refresh.verified();
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
    if (trusted) {
      setMore(false);
      setExportDialog({ filter: { status: apiStatus, q: query.trim(), compartmentId: status !== "archived" ? filter : "", ...(status !== "archived" && roomId ? { roomId, roomName: rooms.find(room => room.id === roomId)?.name } : {}), ...(status === "missing" ? { locationStatus: "missing" as const } : {}) }, selectedIds: selection.map(item => item.id) });
    }
  }
  function changeStatus(value: typeof status) { changeView({ status: value, page: 1, ...(value === "archived" ? { roomId: "" } : {}) }); setNotice(""); }
  function changeRoom(value: string) {
    chosenRoomForShelf.current = filter && value ? { shelf: filter, room: value } : null;
    if (!navigation && filter && value && shelfLocation.id === filter && !shelfLocation.loading && !shelfLocation.error
      && shelfLocation.roomId && shelfLocation.roomId !== value) clearCompartment.current?.();
    changeView({ roomId: value, page: 1 });
  }
  function changePage(value: number) {
    if (!trusted) return;
    if (navigation) scrollPage("/find" + findSearch({ ...view, page: value }));
    else listHeading.current?.scrollIntoView?.({ block: "start" });
    changeView({ page: value }); setNotice("");
  }
  const rangeStart = items.length ? (pagination.page - 1) * pagination.pageSize + 1 : 0;
  const rangeEnd = items.length ? rangeStart + items.length - 1 : 0;
  return <div className="inventory-page">
    <header className="inventory-header"><Brand compact /><nav aria-label="主导航"><button aria-current="page">家庭找物</button><button onClick={() => onArrange()}>空间</button></nav><span className="inventory-household">{me.household.name}</span>{onSettings && <button className="inventory-logout" aria-label="账号与家庭" onClick={onSettings}>账号</button>}<button className="inventory-logout" onClick={() => void onLogout()}>退出</button></header>
    <main className="inventory-main">
      <section className="inventory-intro inventory-intro-compact"><h1>家庭找物</h1><p>记下位置，下次少找一会儿。</p></section>
      <div className="inventory-search-row"><label className="inventory-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="搜索物品" placeholder="找什么？名称、别名或备注" value={query} onChange={event => { changeView({ query: event.target.value, page: 1 }, true); }} /></label>{status !== "archived" && <div className="inventory-entry-actions"><button className="inventory-primary" onClick={() => openRegistration("capture")}>拍照登记</button><button onClick={() => openRegistration("register")}>登记物品</button></div>}</div>
      <div className="inventory-filter-row"><div className="inventory-status-tabs" role="group" aria-label="物品状态">
        <button type="button" aria-pressed={status === "active"} onClick={() => changeStatus("active")}>在用</button>
        <button type="button" aria-pressed={status === "missing"} onClick={() => changeStatus("missing")}>待找回</button>
        <button type="button" aria-pressed={status === "archived"} onClick={() => changeStatus("archived")}>已归档</button>
      </div><label className="inventory-room-filter"><span>房间范围</span><select aria-label="筛选房间" disabled={status === "archived"} value={roomId} onChange={event => changeRoom(event.target.value)}><option value="">全部房间</option>{rooms.map(room => <option value={room.id} key={room.id}>{room.name}</option>)}</select></label>
      <div className="inventory-tools inventory-tools-compact">
        <button type="button" onClick={() => { setBulkMode(value => !value); setSelection([]); setSelectionError(""); }}>{bulkMode ? "退出批量整理" : "批量整理"}</button>
        <div className="inventory-more" ref={moreArea}><button type="button" ref={moreButton} aria-expanded={more} aria-controls="inventory-more-actions" onClick={() => setMore(value => !value)}>更多</button>
          {more && <div id="inventory-more-actions" className="inventory-more-actions" role="group" aria-label="更多操作">
            <button type="button" disabled={pending} onClick={() => { setMore(false); setRevision(value => value + 1); }}>刷新清单</button>
            <button type="button" disabled={!trusted} onClick={openExport}>导出清单</button>
            <InstallGuide />
          </div>}
        </div>
      </div></div>
      {roomError && <div className="inventory-error" role="alert">{roomError}<button type="button" onClick={() => setRoomRevision(value => value + 1)}>重试房间筛选</button></div>}
      {filter && status !== "archived" && shelfLocation.id === filter && shelfLocation.error && <div className="inventory-error" role="alert">{shelfLocation.error}<button type="button" onClick={() => setShelfRevision(value => value + 1)}>重试隔层位置</button></div>}
      {filter && roomId && shelfLocation.id === filter && shelfLocation.loading && <p className="inventory-muted" role="status">正在核对隔层所属房间…</p>}
      {bulkMode && <div className="bulk-toolbar" role="group" aria-label="批量整理操作">
        <strong>已选 {selection.length} 条</strong>
        <button type="button" disabled={!trusted || items.length === 0} onClick={selectAll}>全选当前页</button>
        <button type="button" disabled={selection.length === 0} onClick={() => { setSelection([]); setSelectionError(""); }}>清空选择</button>
        <div className="bulk-toolbar-actions">
          {status !== "archived" ? <><button type="button" disabled={!trusted || selection.length === 0} onClick={() => openBulk("move")}>批量移动</button><button type="button" disabled={!trusted || selection.length === 0} onClick={() => openBulk("archive")}>批量归档</button></>
            : <button type="button" disabled={!trusted || selection.length === 0} onClick={() => openBulk("restore")}>批量恢复</button>}
        </div>
      </div>}
      {selectionError && <div className="inventory-error bulk-selection-error" role="alert">{selectionError}</div>}
      <div className="inventory-list-heading" ref={listHeading}><h2>{!trusted ? (pending ? "正在核验清单" : "上次加载的结果") : query ? "搜索结果" : status === "archived" ? "已归档的物品" : status === "missing" ? "待找回的物品" : filter ? "这个隔层里的物品" : "家里的物品"}</h2><span>{trusted ? `共 ${pagination.total} 条记录` : pending ? "正在查找…" : "当前数量未确认"}</span>{filter && status !== "archived" && <button onClick={() => { changeView({ filter: "", page: 1 }); if (!navigation) onClearCompartment?.(); }}>查看全部</button>}</div>
      {failed && <div className="inventory-error" role="alert">{error}<button onClick={() => setRevision(value => value + 1)}>重新加载</button></div>}
      {failed && <div className="inventory-stale-note" role="status"><strong>{verifiedView ? "当前筛选未能加载，以下为上次结果" : "当前筛选未能加载，尚无已核验的结果"}</strong><p>可打开单件详情重新读取最新资料；清单重新加载成功前，不能勾选、批量处理或导出。</p></div>}
      {notice && <p className="inventory-success" role="status">{notice}</p>}
      {refresh.deferred && <p className="inventory-refresh-notice" role="status">清单可能已有更新，完成当前操作并关闭弹窗或退出批量整理后，会自动核验最新记录。</p>}
      {registered.length > 0 && <RegistrationReceipt key={registered.map(item => item.id).join(":")} items={registered} visibleIds={items.map(item => item.id)} verified={trusted} onView={setSelected} onDismiss={() => setRegistered([])} />}
      {pending ? <p role="status" className="inventory-loading">正在读取物品…</p> : !items.length ? (failed ? null : <div className="inventory-empty"><span aria-hidden="true">⌂</span><h3>{query ? "还没有找到这件物品" : status === "archived" ? "还没有归档物品" : status === "missing" ? "没有待找回的物品" : "给第一件物品留下位置"}</h3><p>{query ? "换个叫法试试，也可以在资料中补充别名。" : status === "archived" ? "暂时不用的物品可以归档；需要时选择一个位置恢复。" : status === "missing" ? "记录为“这里没找到”的物品会显示在这里。" : "选择一个隔层，一次登记多件；一箱露营工具也可以先记成一组。"}</p>{(query || status === "active") && <button onClick={() => { if (query) { changeView({ query: "", page: 1 }, true); } else openRegistration("register"); }}>{query ? "清除搜索" : "开始登记"}</button>}{status === "active" && <button onClick={() => onArrange()}>布置房间和容器</button>}</div>) :
        <div className="inventory-grid">{items.map(item => <div key={item.id} className={bulkMode ? `inventory-selection-row${selection.some(entry => entry.id === item.id) ? " is-selected" : ""}` : "inventory-item-wrap"}>
          {bulkMode && <label className="bulk-select-box"><input type="checkbox" aria-label={`选择${item.name}`} disabled={!trusted} checked={selection.some(entry => entry.id === item.id)} onChange={() => toggleItem(item)} /><span className="bulk-select-caption">选择{item.name}</span></label>}
          <button className="inventory-item" aria-label={`查看${item.name}`} onClick={() => setSelected(item)}>
          {(item.thumbnail_url ?? item.photo_url) ? <img loading="lazy" src={item.thumbnail_url ?? item.photo_url!} alt="" /> : <span className="inventory-item-placeholder" aria-hidden="true">{item.name.slice(0,1)}</span>}
          <div className="inventory-item-copy"><strong>{item.name}</strong><span>{item.archived_at && "归档前："}{item.location_path.join(" › ") || "暂未分配位置"}</span><small className={!item.archived_at && item.location_status === "missing" ? "missing-note" : ""}>{item.archived_at ? `已归档 · ${item.archive_reason || confirmedDate(item.archived_at)}` : item.location_status === "missing" ? "待找回 · 位置需更新" : `最后确认 ${confirmedDate(item.last_confirmed_at)}`}</small></div><span aria-hidden="true">↗</span>
        </button></div>)}</div>}
      <nav className="inventory-pagination" aria-label="物品清单分页"><button type="button" disabled={!trusted || page <= 1} onClick={() => changePage(page - 1)}>上一页</button><span>{trusted ? `第 ${rangeStart}–${rangeEnd} 条，共 ${pagination.total} 条` : "当前分页未确认"}</span><button type="button" disabled={!trusted || !pagination.hasMore} onClick={() => changePage(page + 1)}>下一页</button></nav>
    </main>
    {selected && <ItemDetail key={selected.id} initial={selected} refreshPending={refresh.deferred} onClose={() => setSelected(null)} onUpdated={updated} onLocate={onArrange} />}
    {registration?.kind === "register" && <RegisterDialog key={registration.initialId} me={me} initialCompartmentId={registration.initialId} onClose={() => setRegistration(null)} onRegistered={setRegistered} onSaved={() => { setRegistration(null); setRevision(value => value + 1); setNotice(""); }} />}
    {registration?.kind === "capture" && <QuickRegisterDialog key={registration.initialId} me={me} initialCompartmentId={registration.initialId} onClose={() => setRegistration(null)} onSaved={(item, options) => { if (!options?.continueRegistration) setRegistration(null); setRegistered([item]); setRevision(value => value + 1); setNotice(""); }} />}
    {trusted && bulkDialog && <BulkActionDialog action={bulkDialog.action} items={bulkDialog.items} refreshPending={refresh.deferred} onClose={() => setBulkDialog(null)} onSuccess={bulkSucceeded} onConflict={refreshAfterConflict} />}
    {trusted && exportDialog && <ExportDialog filter={exportDialog.filter} selectedIds={exportDialog.selectedIds} onClose={() => setExportDialog(null)} />}
  </div>;
}
