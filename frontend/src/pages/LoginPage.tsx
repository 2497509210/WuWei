import { useState, type FormEvent } from "react";
import { ApiError, login } from "../api/client";
import { AuthShell } from "../components/AuthShell";

export function LoginPage({ onDone, onJoin, notice }: { onDone: () => Promise<void>; onJoin?: () => void; notice?: string }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const deviceName = /Android/i.test(navigator.userAgent)
        ? "Android 手机"
        : /iPhone|iPad/i.test(navigator.userAgent)
          ? "iPhone / iPad"
          : "浏览器";
      await login({ username: username.trim(), password, remember, device_name: deviceName });
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "登录失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell footer={<span>忘记密码？请联系服务器管理员恢复账号。</span>}>
      <div className="auth-kicker">WELCOME BACK</div>
      <h1>回到你家</h1>
      <p className="auth-sub">登录后查看家里的空间与物品位置。</p>
      {notice && <p className="inventory-success" role="status">{notice}</p>}

      <form onSubmit={submit} className="auth-form">
        <label>
          <span>用户名</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          <span>密码</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <label className="remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>记住这台设备（一年内不用再登录）</span>
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-btn" type="submit" disabled={busy}>
          {busy ? "正在登录…" : "登录"}
        </button>
      </form>
      {onJoin && <button type="button" className="ghost-btn join-entry" onClick={onJoin}>使用邀请码加入家庭</button>}
    </AuthShell>
  );
}
