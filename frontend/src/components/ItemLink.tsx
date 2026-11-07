import { useId, useLayoutEffect, useRef, useState } from "react";
import { itemUrl } from "../lib/itemLink";
import { locationEntrances, type LocationEntrance } from "../utils/locationLabel";
import "../styles/item-link.css";

export function ItemLink({ itemId, disabled = false }: { itemId: string; disabled?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [entrance, setEntrance] = useState<LocationEntrance["id"]>("current");
  const [copied, setCopied] = useState<"success" | "failure" | "">("");
  const input = useRef<HTMLInputElement>(null);
  const copyRevision = useRef(0);
  const optionsId = useId();
  const options = locationEntrances(window.location.origin);
  const option = options.find(entry => entry.id === entrance) ?? options[0];
  const link = disabled ? "" : itemUrl({ origin: option.origin, basePath: import.meta.env.BASE_URL, itemId }) ?? "";

  useLayoutEffect(() => {
    copyRevision.current++;
    setCopied("");
    return () => { copyRevision.current++; };
  }, [itemId, link, disabled]);

  useLayoutEffect(() => {
    if (expanded && copied === "failure") {
      input.current?.focus();
      input.current?.select();
    }
  }, [expanded, copied]);

  async function copy() {
    if (!link || disabled) return;
    const revision = ++copyRevision.current;
    setCopied("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(link);
      if (revision === copyRevision.current) setCopied("success");
    } catch {
      if (revision !== copyRevision.current) return;
      setExpanded(true);
      setCopied("failure");
    }
  }

  return <section className="item-link" aria-label="分享物品">
    <div className="item-link-actions">
      <button type="button" disabled={!link} onClick={() => void copy()}>复制物品链接</button>
      <button type="button" aria-expanded={expanded} aria-controls={optionsId} onClick={() => setExpanded(value => !value)}>链接选项</button>
    </div>
    <div id={optionsId} hidden={!expanded} className="item-link-options">
      <p className="inventory-muted">打开链接后仍需登录本家庭账号，才能查看物品及其当前位置。</p>
      <label>物品链接入口<select value={option.id} onChange={event => {
        copyRevision.current++; setCopied(""); setEntrance(event.target.value as LocationEntrance["id"]);
      }}>
        {options.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select></label>
      <p className="inventory-muted">{option.id === "tailnet" ? "此入口需要手机已连接 Tailscale。" : option.id === "public" ? "此入口可从公网访问，仍需登录。" : "使用当前页面的地址；家人需要能够访问同一入口。"}</p>
      <label>物品链接<input ref={input} readOnly disabled={!link} value={link} onFocus={event => event.currentTarget.select()} /></label>
    </div>
    {copied && <p role="status" className="inventory-muted">{copied === "success" ? "物品链接已复制" : "复制未成功，请长按或选中链接复制。"}</p>}
  </section>;
}
