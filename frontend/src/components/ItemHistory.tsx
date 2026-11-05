import { useEffect, useRef, useState } from "react";
import { getItemEvents, type ItemEvent } from "../api/client";

const eventNames: Record<ItemEvent["type"], string> = {
  create: "登记物品", update: "修改资料", move: "移动物品", confirm: "确认位置", missing: "标记未找到",
  photo: "更换照片", archive: "归档物品", restore: "恢复物品", container_move: "整柜换房间", undo: "撤销移动",
};
const fieldNames: Record<string, string> = {
  name: "名称", aliases: "别名", notes: "备注", quantity: "数量", archive_reason: "归档原因", reason: "归档原因",
};
function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "无";
  return Array.isArray(value) ? value.join("、") || "无" : String(value);
}

export function ItemHistory({ itemId, disabled, onUndo }: {
  itemId: string; disabled: boolean; onUndo: (eventId: string) => void;
}) {
  const [events, setEvents] = useState<ItemEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const nextOffset = useRef(0);
  const retryOffset = useRef(0);
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);

  async function load(offset: number) {
    if (inFlight.current) return;
    inFlight.current = true;
    const request = new AbortController();
    controller.current = request;
    setLoading(true); setError(""); retryOffset.current = offset;
    try {
      const page = await getItemEvents(itemId, offset, request.signal);
      if (request.signal.aborted) return;
      setEvents(previous => offset === 0 ? page.events : [
        ...previous, ...page.events.filter(event => !previous.some(existing => existing.id === event.id)),
      ]);
      nextOffset.current = offset + page.events.length;
      setHasMore(page.has_more);
    } catch (error) {
      if (!request.signal.aborted) setError(error instanceof Error ? error.message : "历史加载失败");
    } finally {
      if (controller.current === request) {
        inFlight.current = false;
        if (!request.signal.aborted) setLoading(false);
      }
    }
  }

  useEffect(() => {
    void load(0);
    return () => { controller.current?.abort(); inFlight.current = false; };
  }, [itemId]);

  return <section className="item-history" aria-label="操作历史">
    <div className="item-history-heading"><h3>操作历史</h3><span>最新记录在前</span></div>
    {events.length > 0 && <ol className="item-history-list">
      {events.map(event => <li key={event.id}>
        <div className="item-history-title"><strong>{eventNames[event.type] ?? "物品变更"}</strong><time dateTime={event.created_at}>
          {new Date(event.created_at).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
        </time></div>
        <p className="inventory-muted">{event.actor_name ? <span>{event.actor_name}</span> : "操作者未记录"}</p>
        {event.from_path && <p className="item-history-path"><span>原位置</span><strong>{event.from_path.join(" / ") || "未分配位置"}</strong></p>}
        {event.to_path && <p className="item-history-path"><span>新位置</span><strong>{event.to_path.join(" / ") || "未分配位置"}</strong></p>}
        {event.legacy && <p className="item-history-incomplete">历史信息不完整</p>}
        {Object.entries(event.changes ?? {}).filter(([field]) => fieldNames[field]).map(([field, change]) =>
          <p className="item-history-change" key={field}><span>{fieldNames[field]}</span>
            <span>{displayValue(change.before)} → {displayValue(change.after)}</span></p>
        )}
        {event.can_undo && <button type="button" className="item-history-undo" disabled={disabled || loading || Boolean(error)} onClick={() => onUndo(event.id)}>撤销这次移动</button>}
      </li>)}
    </ol>}
    {loading && <p role="status" className="inventory-muted">正在读取历史…</p>}
    {error && <div className="inventory-error" role="alert">{error}<button type="button" onClick={() => void load(retryOffset.current)}>重试历史</button></div>}
    {!loading && !error && !events.length && <p className="inventory-muted">还没有操作记录</p>}
    {!loading && !error && hasMore && <button type="button" className="item-history-more" onClick={() => void load(nextOffset.current)}>加载更早记录</button>}
  </section>;
}
