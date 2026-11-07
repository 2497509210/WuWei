import { useEffect, useState } from "react";
import { ApiError, getItem, type Item } from "../api/client";
import { Brand } from "../components/Brand";
import { ItemDetail } from "../components/ItemDetail";
import type { LocateTarget } from "./InventoryPage";
import "../styles/item-page.css";

type ItemPageProps = { itemId: string; onBack: () => void; onLocate: (target: LocateTarget) => void };
type ItemState = { id: string; item: Item | null; loading: boolean; error: string };

export function ItemPage({ itemId, onBack, onLocate }: ItemPageProps) {
  const validId = /^[A-Za-z0-9_-]{1,128}$/.test(itemId);
  const [state, setState] = useState<ItemState>({ id: itemId, item: null, loading: validId, error: "" });
  const [revision, setRevision] = useState(0);
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    if (!validId) return;
    let active = true;
    setState({ id: itemId, item: null, loading: true, error: "" });
    void getItem(itemId).then(result => {
      if (!active) return;
      if (result.item.id !== itemId) throw new Error("物品记录与链接不一致，请重新加载。");
      setState({ id: itemId, item: result.item, loading: false, error: "" });
    }).catch(error => {
      if (!active) return;
      const message = error instanceof ApiError && (error.status === 403 || error.status === 404)
        ? "物品不存在或无权访问。请确认链接及当前登录的家庭。"
        : error instanceof Error ? error.message : "物品加载失败，请重试。";
      setState({ id: itemId, item: null, loading: false, error: message });
    });
    return () => { active = false; };
  }, [itemId, revision, validId]);
  // Modal has already confirmed discarding its draft. Unmount it before routing
  // so the global navigation guard does not ask the same question a second time.
  useEffect(() => { if (closed) onBack(); }, [closed, onBack]);
  const current = state.id === itemId ? state : null;
  return <div className="item-page">
    <header className="item-page-header"><Brand compact /><button type="button" onClick={onBack}>返回找物</button></header>
    <main className="item-page-main">
      <h1>物品详情</h1>
      {!validId ? <p role="alert" className="inventory-error">物品链接无效，请向家人获取完整链接。</p>
        : (!current || current.loading) ? <p role="status" className="inventory-muted">正在读取物品…</p>
          : current.error ? <section className="item-page-message"><p role="alert" className="inventory-error">{current.error}</p><button type="button" onClick={() => setRevision(value => value + 1)}>重新加载物品</button></section>
            : <p className="inventory-muted">关闭详情后可返回家庭找物。</p>}
    </main>
    {current?.item && !closed && <ItemDetail key={itemId} initial={current.item} onClose={() => setClosed(true)}
      onUpdated={item => setState(value => ({ ...value, item }))} onLocate={onLocate} />}
  </div>;
}
