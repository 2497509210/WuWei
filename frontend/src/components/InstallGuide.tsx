import { useState, useSyncExternalStore } from "react";
import { getInstallState, requestInstallation, subscribeInstall } from "../pwaInstall";
import { Modal } from "./Modal";
import "../styles/install.css";

export function InstallGuide() {
  const state = useSyncExternalStore(subscribeInstall, getInstallState);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone;
  if (state.installed || standalone) return null;

  async function install() {
    if (busy) return;
    if (!state.pending) { setShow(true); return; }
    setBusy(true); setMessage("");
    try {
      const outcome = await requestInstallation();
      if (outcome === "unavailable") setShow(true);
      else setMessage(outcome === "accepted" ? "已提交添加请求，可从桌面打开物位。" : "本次未添加，可以稍后再试。");
    } catch { setShow(true); }
    finally { setBusy(false); }
  }
  return <div className="install-guide">
    <button type="button" disabled={busy} onClick={() => void install()}>添加到手机桌面</button>
    {message && <span role="status">{message}</span>}
    {show && <Modal title="添加到手机桌面" onClose={() => setShow(false)}>
      <p className="inventory-muted">从桌面直接进入家庭找物，使用时需要网络连接。</p>
      <ol className="install-steps">
        <li><strong>iPhone / iPad</strong><p>在 Safari 中打开物位，点击分享，再选择“添加到主屏幕”。</p></li>
        <li><strong>Android</strong><p>在 Chrome 或系统浏览器菜单中选择“安装应用”或“添加到桌面”。</p></li>
        <li><strong>电脑浏览器</strong><p>使用地址栏的安装按钮，或浏览器菜单中的应用安装选项。</p></li>
      </ol>
      <p className="inventory-muted">连接 Tailscale 的设备请从内网入口添加；其他设备请使用公网入口。桌面图标会保留添加时的访问地址。</p>
    </Modal>}
  </div>;
}
