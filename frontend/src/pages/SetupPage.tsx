import { useState, type FormEvent } from "react";
import { ApiError, setup } from "../api/client";
import { AuthShell } from "../components/AuthShell";

export function SetupPage({ onDone }: { onDone: () => Promise<void> }) {
  const [token, setToken] = useState("");
  const [household, setHousehold] = useState("我家");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await setup({ token: token.trim(), household_name: household.trim(), username: username.trim(), password });
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "初始化失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell footer={<span>令牌在服务器的 <code>/var/lib/wuwei/setup-token</code> 里，只显示一次。</span>}>
      <div className="auth-kicker">FIRST RUN</div>
      <h1>第一次见面</h1>
      <p className="auth-sub">创建你的家庭空间。之后家人可以通过邀请码加入。</p>

      <form onSubmit={submit} className="auth-form">
        <label>
          <span>初始化令牌</span>
          <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="粘贴 setup-token" autoComplete="one-time-code" required />
        </label>
        <label>
          <span>家庭名称</span>
          <input value={household} onChange={(e) => setHousehold(e.target.value)} placeholder="我家" required />
        </label>
        <label>
          <span>你的用户名</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="例如：xiaoming" autoComplete="username" required />
        </label>
        <label>
          <span>密码</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 8 位" autoComplete="new-password" minLength={8} required />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-btn" type="submit" disabled={busy}>
          {busy ? "正在创建…" : "创建家庭"}
        </button>
      </form>
    </AuthShell>
  );
}
