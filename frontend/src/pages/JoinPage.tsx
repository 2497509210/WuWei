import { useEffect, useRef, useState, type FormEvent } from "react";
import { browserDeviceName, joinHousehold } from "../api/account";
import { AuthShell } from "../components/AuthShell";
import "../styles/account.css";

export function JoinPage({ onDone, onBack }: { onDone: () => Promise<void>; onBack: () => void }) {
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);
  const submitted = useRef(false);
  const redeemed = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitted.current) return;
    setError("");
    if (!redeemed.current) {
      if (!code.trim() || code.trim().length > 200) { setError("请填写有效的邀请码（最多 200 个字符）"); return; }
      if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]{1,40}$/.test(username.trim())) { setError("用户名需为 1–40 个字符，可用中文、字母、数字、下划线或短横线"); return; }
      if (!displayName.trim() || displayName.trim().length > 60) { setError("昵称需为 1–60 个字符"); return; }
      if (password.length < 8 || password.length > 200) { setError("密码需为 8–200 个字符"); return; }
      if (password !== confirmation) { setError("两次密码不一致"); return; }
    }
    submitted.current = true; setBusy(true);
    const owner = generation.current;
    try {
      if (!redeemed.current) {
        await joinHousehold({ code: code.trim(), username: username.trim(), display_name: displayName.trim(), password, remember, device_name: browserDeviceName() });
        if (owner !== generation.current) return;
        redeemed.current = true; setJoined(true); setCode(""); setPassword(""); setConfirmation("");
      }
      try { await onDone(); }
      catch { if (owner === generation.current) setError("已加入家庭，页面加载失败，请重试进入"); }
    } catch (error) {
      if (owner === generation.current) setError(error instanceof Error ? error.message : "加入失败，请重试");
    } finally {
      if (owner === generation.current) { submitted.current = false; setBusy(false); }
    }
  }

  return <AuthShell footer={<button type="button" className="account-back-link" disabled={busy} onClick={onBack}>返回登录</button>}>
    <div className="auth-kicker">JOIN YOUR HOME</div><h1>加入家人的空间</h1>
    <p className="auth-sub">向家庭管理员获取邀请码，创建你自己的账号。邀请码仅能使用一次，生成后 7 天内有效。</p>
    <form className="auth-form account-join-form" onSubmit={event => void submit(event)}>
      {!joined && <fieldset disabled={busy}>
        <label><span>邀请码</span><input value={code} onChange={event => setCode(event.target.value)} maxLength={200} autoComplete="off" autoCapitalize="none" spellCheck={false} required /></label>
        <label><span>用户名</span><input value={username} onChange={event => setUsername(event.target.value)} maxLength={40} autoComplete="username" autoCapitalize="none" required /></label>
        <label><span>昵称</span><input value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={60} autoComplete="nickname" required /></label>
        <label><span>密码</span><input type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={8} maxLength={200} autoComplete="new-password" required /></label>
        <label><span>确认密码</span><input type="password" value={confirmation} onChange={event => setConfirmation(event.target.value)} minLength={8} maxLength={200} autoComplete="new-password" required /></label>
        <label className="remember"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} /><span>记住这台设备（一年内不用再登录）</span></label>
      </fieldset>}
      {joined && <p role="status" className="account-success">账号已创建，可以进入家庭。</p>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <button type="submit" className="primary-btn" disabled={busy}>{busy ? "正在处理…" : joined ? "进入家庭" : "加入家庭"}</button>
    </form>
  </AuthShell>;
}
