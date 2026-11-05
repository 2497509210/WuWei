import { useEffect, useRef, useState } from "react";
import type { Container } from "../api/client";
import { createLocationLabel, locationEntrances, locationUrl, type LocationEntrance } from "../utils/locationLabel";
import { Modal } from "./Modal";
import "../styles/location.css";

export function LocationLabel({ container, roomName, compartmentId, onClose }: {
  container: Container; roomName: string; compartmentId?: string; onClose: () => void;
}) {
  const [target, setTarget] = useState(compartmentId ?? "");
  const [entrance, setEntrance] = useState<LocationEntrance["id"]>("current");
  const [generated, setGenerated] = useState<{ key: string; dataUrl: string } | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [retry, setRetry] = useState(0);
  const copyRevision = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const options = locationEntrances(window.location.origin);
  const option = options.find(entry => entry.id === entrance) ?? options[0];
  const compartment = container.compartments.find(entry => entry.id === target);
  const valid = !target || Boolean(compartment && compartment.container_id === container.id);
  const link = valid ? locationUrl({ origin: option.origin, basePath: import.meta.env.BASE_URL, containerId: container.id, compartmentId: target || undefined }) : "";
  const name = compartment?.name ?? container.name;
  const context = compartment ? `${roomName} / ${container.name}` : roomName;
  const key = JSON.stringify([link, name, context]);

  useEffect(() => {
    let active = true;
    copyRevision.current++;
    setCopied(""); setError(""); setGenerated(null);
    if (link) void createLocationLabel(link, name, context)
      .then(label => { if (active) setGenerated({ key, dataUrl: label.dataUrl }); })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : "标签生成失败"); });
    return () => { active = false; copyRevision.current++; };
  }, [key, retry]);

  async function copy() {
    if (!link) return;
    const revision = ++copyRevision.current;
    setCopied("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(link);
      if (revision === copyRevision.current) setCopied("链接已复制");
    } catch {
      if (revision !== copyRevision.current) return;
      input.current?.focus(); input.current?.select();
      setCopied("复制未成功，请长按或选中链接复制。");
    }
  }

  const preview = generated?.key === key ? generated : null;
  return <Modal title="位置标签" onClose={onClose}>
    <div className="location-label inventory-form">
      <p className="inventory-muted">将标签贴在容器或隔层上。扫码后仍需登录本家庭账号；容器换房间后，链接会显示当前位置。</p>
      {!valid ? <p className="inventory-error" role="alert">所选隔层已不存在，请关闭标签并重新加载容器。</p> : <>
        <label>标签位置<select value={target} onChange={event => { copyRevision.current++; setCopied(""); setTarget(event.target.value); }}>
          <option value="">整个容器 · {container.name}</option>
          {compartment && <option value={compartment.id}>所选隔层 · {compartment.name}</option>}
          {!compartment && compartmentId && container.compartments.filter(entry => entry.id === compartmentId).map(entry => <option key={entry.id} value={entry.id}>所选隔层 · {entry.name}</option>)}
        </select></label>
        <label>链接入口<select value={option.id} onChange={event => { copyRevision.current++; setCopied(""); setEntrance(event.target.value as LocationEntrance["id"]); }}>
          {options.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select></label>
        <p className="inventory-muted">{option.id === "tailnet" ? "此入口需要手机已连接 Tailscale。" : option.id === "public" ? "此入口可从公网访问，仍需登录。" : "使用当前页面的地址；手机需要能够访问同一入口。"}</p>
        <label>位置链接<input ref={input} readOnly value={link} onFocus={event => event.currentTarget.select()} /></label>
        <button type="button" onClick={() => void copy()}>复制链接</button>
        {copied && <p className="inventory-muted" role="status">{copied}</p>}
        {error ? <div className="inventory-error" role="alert">{error}<button type="button" onClick={() => setRetry(value => value + 1)}>重新生成标签</button></div>
          : preview ? <><img className="location-label-preview" src={preview.dataUrl} alt="位置二维码" />
            <a className="location-download" href={preview.dataUrl} download={`wuwei-location-${container.id.replace(/[^a-zA-Z0-9_-]/g, "_")}${target ? "-shelf" : ""}.svg`}>下载标签（SVG）</a>
            <p className="inventory-muted">下载后可打印；名称为生成时的标注，改名后可重新下载。</p></>
          : <p role="status">正在生成位置标签…</p>}
      </>}
    </div>
  </Modal>;
}
