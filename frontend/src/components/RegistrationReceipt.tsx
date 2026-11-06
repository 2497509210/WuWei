import { useState } from "react";
import type { Item } from "../api/client";
import { Modal } from "./Modal";

export function RegistrationReceipt({ items, visibleIds, verified, onView, onDismiss }: {
  items: Item[]; visibleIds: string[]; verified: boolean; onView: (item: Item) => void; onDismiss: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hidden = verified && items.some(item => !visibleIds.includes(item.id));
  return <section className="registration-receipt" aria-label="登记成功">
    <div role="status"><strong>{`已登记 ${items.length} 条物品记录`}</strong>{items.length === 1 && <p>{`已登记「${items[0].name}」`}</p>}
      {hidden && <p>刚登记的物品未显示在当前页，可能受筛选或页码影响。</p>}</div>
    <div className="inventory-actions"><button type="button" onClick={() => items.length === 1 ? onView(items[0]) : setOpen(true)}>{items.length === 1 ? "查看刚登记物品" : `查看刚登记的${items.length}件物品`}</button>
      <button type="button" onClick={onDismiss}>关闭登记提示</button></div>
    {open && <Modal title="刚登记的物品" onClose={() => setOpen(false)}><p>点击物品读取最新资料，当前找物筛选保持不变。</p><ul className="registration-receipt-list">{items.map(item => <li key={item.id}><button type="button" aria-label={`查看${item.name}`} onClick={() => { setOpen(false); onView(item); }}>{item.name}</button></li>)}</ul></Modal>}
  </section>;
}
