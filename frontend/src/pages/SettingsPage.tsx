import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type MeResponse, type User } from "../api/client";
import {
  changePassword, createHouseholdInvite, listDeviceGroups, listHouseholdInvites, listHouseholdMembers,
  logoutAllDevices, removeHouseholdMember, revokeDeviceGroup, revokeHouseholdInvite, updateProfile,
  type DeviceGroup, type HouseholdInvite, type HouseholdMember,
} from "../api/account";
import { Brand } from "../components/Brand";
import "../styles/account.css";

const deviceRows = async (signal: AbortSignal) => (await listDeviceGroups(signal)).devices;
const memberRows = async (signal: AbortSignal) => (await listHouseholdMembers(signal)).members;
const inviteRows = async (signal: AbortSignal) => (await listHouseholdInvites(signal)).invites;

function useAccountList<T>(load: (signal: AbortSignal) => Promise<T[]>, identity: string, enabled: boolean, onExpired: () => void) {
  const [data, setData] = useState<T[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const latest = useRef<AbortController | null>(null);
  const expired = useRef(onExpired); expired.current = onExpired;
  const invalidate = useCallback(() => { latest.current?.abort(); latest.current = null; setLoading(false); }, []);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    latest.current?.abort();
    const controller = new AbortController(); latest.current = controller;
    setLoading(true); setError("");
    try {
      const rows = await load(controller.signal);
      if (!controller.signal.aborted) setData(rows);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) expired.current();
      else setError(error instanceof Error ? error.message : "读取失败，请重试");
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [load, identity, enabled]);
  useEffect(() => {
    setData(null); setError("");
    void refresh();
    return () => { latest.current?.abort(); };
  }, [refresh]);
  return { data, setData, error, loading, refresh, invalidate };
}

type Confirmation = { kind: "device"; device: DeviceGroup } | { kind: "member"; member: HouseholdMember } | { kind: "all" } | null;
function when(value: string | null): string { return value ? new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "未记录"; }

export function SettingsPage(props: { me: MeResponse; onMeChanged: (user: User) => void; onSessionEnded: (message: string) => void; onBack: () => void; returnLabel?: string }) {
  // A change of identity discards private drafts, invitation codes, and in-flight responses.
  return <AccountSettings key={props.me.user.id} {...props} />;
}

function AccountSettings({ me, onMeChanged, onSessionEnded, onBack, returnLabel = "返回空间" }: Parameters<typeof SettingsPage>[0]) {
  const [displayName, setDisplayName] = useState(me.user.display_name);
  const nameDirty = useRef(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmationPassword, setConfirmationPassword] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [issued, setIssued] = useState<{ id: string; code: string } | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const issuedRevision = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const locked = useRef(false);
  const ended = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { if (!nameDirty.current) setDisplayName(me.user.display_name); }, [me.user.display_name]);
  const finishSession = (message: string) => {
    if (ended.current) return;
    ended.current = true; generation.current++;
    setIssued(null); setCurrentPassword(""); setNewPassword(""); setConfirmationPassword("");
    onSessionEnded(message);
  };
  const expired = () => finishSession("登录已失效，请重新登录");
  const devices = useAccountList(deviceRows, me.user.id, true, expired);
  const members = useAccountList(memberRows, me.user.id, me.user.role === "owner", expired);
  const invites = useAccountList(inviteRows, me.user.id, me.user.role === "owner", expired);
  useEffect(() => {
    if (!issued) return;
    const current = invites.data?.find(invite => invite.id === issued.id);
    if (current && (current.used_at || current.revoked_at || new Date(current.expires_at).getTime() <= Date.now())) {
      issuedRevision.current++; setIssued(null); setCopyStatus("");
    }
  }, [invites.data, issued]);

  async function mutate<T>(request: () => Promise<T>, apply: (value: T) => void) {
    if (locked.current || ended.current) return;
    locked.current = true; setBusy(true); setError(""); setNotice("");
    const owner = generation.current;
    try {
      const result = await request();
      if (owner === generation.current) apply(result);
    } catch (error) {
      if (owner !== generation.current) return;
      if (error instanceof ApiError && error.status === 401) expired();
      else setError(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      if (owner === generation.current) { locked.current = false; setBusy(false); }
    }
  }

  function saveProfile() {
    const name = displayName.trim();
    if (!name || name.length > 60) { setError("昵称需为 1–60 个字符"); return; }
    void mutate(() => updateProfile(name), ({ user }) => {
      nameDirty.current = false; setDisplayName(user.display_name); onMeChanged(user);
      members.setData(rows => rows?.map(member => member.id === user.id ? { ...member, ...user } : member) ?? null);
      setNotice("昵称已保存");
    });
  }
  function savePassword() {
    if (!currentPassword || currentPassword.length > 200) { setError("请输入当前密码（最多 200 个字符）"); return; }
    if (newPassword.length < 8 || newPassword.length > 200) { setError("新密码需为 8–200 个字符"); return; }
    if (newPassword !== confirmationPassword) { setError("两次新密码不一致"); return; }
    devices.invalidate(); members.invalidate(); invites.invalidate();
    void mutate(() => changePassword(currentPassword, newPassword), () => finishSession("密码已修改，请重新登录"));
  }
  function acceptConfirmation() {
    if (!confirmation || locked.current) return;
    if (confirmation.kind === "device") {
      const { device } = confirmation;
      devices.invalidate();
      if (device.current) { members.invalidate(); invites.invalidate(); }
      void mutate(() => revokeDeviceGroup(device.id), ({ current_revoked }) => {
        if (current_revoked) finishSession("当前设备已退出，请重新登录");
        else {
          devices.setData(rows => rows?.filter(row => row.id !== device.id) ?? []);
          setConfirmation(null); setNotice("设备已退出，记住设备的登录也已失效");
        }
      });
    } else if (confirmation.kind === "all") {
      devices.invalidate(); members.invalidate(); invites.invalidate();
      void mutate(logoutAllDevices, () => finishSession("所有设备已退出，请重新登录"));
    } else {
      const { member } = confirmation;
      members.invalidate();
      void mutate(() => removeHouseholdMember(member.id), () => {
        members.setData(rows => rows?.filter(row => row.id !== member.id) ?? []);
        setConfirmation(null); setNotice("成员已移除，其登录已失效；物品和历史仍保留");
      });
    }
  }
  function createInvite() {
    if (locked.current) return;
    invites.invalidate();
    void mutate(createHouseholdInvite, ({ invite, code }) => {
      invites.setData(rows => [invite, ...(rows ?? []).filter(row => row.id !== invite.id)]);
      issuedRevision.current++; setIssued({ id: invite.id, code }); setCopyStatus("");
    });
  }
  function revokeInvite(invite: HouseholdInvite) {
    if (locked.current) return;
    invites.invalidate();
    void mutate(() => revokeHouseholdInvite(invite.id), () => {
      invites.setData(rows => rows?.map(row => row.id === invite.id ? { ...row, revoked_at: new Date().toISOString() } : row) ?? []);
      issuedRevision.current++; setIssued(current => current?.id === invite.id ? null : current); setCopyStatus(""); setNotice("邀请码已撤销");
    });
  }
  async function copyInvite() {
    if (!issued) return;
    const owner = generation.current;
    const revision = issuedRevision.current;
    try {
      await navigator.clipboard.writeText(issued.code);
      if (owner === generation.current && revision === issuedRevision.current) setCopyStatus("邀请码已复制，请自行分享给家人");
    } catch { if (owner === generation.current && revision === issuedRevision.current) setCopyStatus("复制失败，请手动选择邀请码复制"); }
  }

  return <div className="account-page">
    <header className="account-header"><Brand compact /><span>{me.household.name}</span><button type="button" disabled={busy} onClick={onBack}>{returnLabel}</button></header>
    <main className="account-main"><div className="account-intro"><span className="eyebrow">ACCOUNT & HOME</span><h1>账号与家庭</h1><p>维护个人资料、登录设备与家人的访问权限。</p></div>
      {error && <div className="account-error" role="alert">{error}</div>}
      {notice && <p className="account-success" role="status">{notice}</p>}
      <div className="account-columns">
        <section className="account-card" aria-label="个人资料"><h2>个人资料</h2><p className="account-muted">用户名：{me.user.username} · {me.user.role === "owner" ? "家庭管理员" : "家庭成员"}</p>
          <form className="account-form" onSubmit={event => { event.preventDefault(); saveProfile(); }}><label>昵称<input value={displayName} disabled={busy} maxLength={60} required autoComplete="nickname" onChange={event => { nameDirty.current = true; setDisplayName(event.target.value); }} /></label><button className="account-primary" disabled={busy || !displayName.trim()}>保存昵称</button></form>
        </section>
        <section className="account-card" aria-label="修改密码"><h2>修改密码</h2><p className="account-muted">修改后包括当前设备在内的所有登录都会退出，请使用新密码重新登录。</p>
          <form className="account-form" onSubmit={event => { event.preventDefault(); savePassword(); }}><fieldset disabled={busy}>
            <label>当前密码<input type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} maxLength={200} autoComplete="current-password" required /></label>
            <label>新密码<input type="password" value={newPassword} onChange={event => setNewPassword(event.target.value)} minLength={8} maxLength={200} autoComplete="new-password" required /></label>
            <label>确认新密码<input type="password" value={confirmationPassword} onChange={event => setConfirmationPassword(event.target.value)} minLength={8} maxLength={200} autoComplete="new-password" required /></label>
          </fieldset><button className="account-primary" disabled={busy}>修改密码并退出</button></form>
        </section>
      </div>
      <section className="account-card" aria-label="登录设备"><div className="account-section-head"><h2>登录设备</h2><button type="button" disabled={busy || devices.loading} onClick={() => void devices.refresh()}>刷新设备</button></div>
        <p className="account-muted">每次登录是一组。退出设备会同时撤销该次登录和「记住设备」，不会仅清除临时登录。</p>
        {devices.loading && <p role="status">正在读取设备…</p>}{devices.error && <p className="account-error" role="alert">{devices.error}</p>}
        <ul className="account-list">{devices.data?.map(device => <li key={device.id}><div><strong>{device.legacy ? "升级前登录（可能包含多台设备）" : device.device_name || "未命名设备"}</strong>{device.current && <span className="account-badge">当前设备</span>}<small>登录于 {when(device.created_at)} · 最近使用 {when(device.last_seen_at)}</small><small>有效至 {when(device.expires_at)}</small></div><button type="button" aria-label={`退出设备 ${device.device_name || "未命名设备"}`} disabled={busy} onClick={() => { setConfirmation({ kind: "device", device }); setError(""); }}>退出</button></li>)}</ul>
        {!devices.loading && devices.data?.length === 0 && <p className="account-muted">没有可显示的登录设备。</p>}
        <button type="button" className="account-danger" disabled={busy} onClick={() => { setConfirmation({ kind: "all" }); setError(""); }}>退出所有设备</button>
        {(confirmation?.kind === "device" || confirmation?.kind === "all") && <div className="account-confirm" role="group" aria-label="确认退出设备">
          <p>{confirmation.kind === "all" ? "所有设备都需要重新登录，包括当前设备。" : `确定退出「${confirmation.device.device_name || "未命名设备"}」？${confirmation.device.current ? "当前页面也将返回登录。" : "该设备需要重新登录。"}`}</p>
          <div className="account-actions"><button type="button" className="account-danger" disabled={busy} onClick={acceptConfirmation}>{confirmation.kind === "all" ? "确认退出所有设备" : "确认退出此设备"}</button><button type="button" disabled={busy} onClick={() => setConfirmation(null)}>取消</button></div>
        </div>}
      </section>
      {me.user.role === "owner" && <>
        <section className="account-card" aria-label="家庭成员"><div className="account-section-head"><h2>家庭成员</h2><button type="button" disabled={busy || members.loading} onClick={() => void members.refresh()}>刷新成员</button></div>
          {members.loading && <p role="status">正在读取成员…</p>}{members.error && <p className="account-error" role="alert">{members.error}</p>}
          <ul className="account-list">{members.data?.map(member => <li key={member.id}><div><strong>{member.display_name}</strong><small>{member.username} · {member.role === "owner" ? "管理员" : "成员"}</small><small>加入于 {when(member.created_at)}</small></div>{member.role === "member" && member.id !== me.user.id && <button type="button" className="account-danger" aria-label={`移除成员 ${member.display_name}`} disabled={busy} onClick={() => { setConfirmation({ kind: "member", member }); setError(""); }}>移除</button>}</li>)}</ul>
          {confirmation?.kind === "member" && <div className="account-confirm" role="group" aria-label="确认移除成员"><p>确定移除「{confirmation.member.display_name}」？该成员将无法登录，所有设备立即退出。已有物品和历史仍保留。</p><p className="account-muted">如需重新加入，需要新的邀请码和未占用的用户名。</p><div className="account-actions"><button type="button" className="account-danger" disabled={busy} onClick={acceptConfirmation}>确认移除成员</button><button type="button" disabled={busy} onClick={() => setConfirmation(null)}>取消</button></div></div>}
        </section>
        <section className="account-card" aria-label="邀请家人"><div className="account-section-head"><h2>邀请家人</h2><button type="button" className="account-primary" disabled={busy} onClick={createInvite}>生成邀请码</button></div><p className="account-muted">邀请码 7 天内有效，且只能使用一次。请自行分享给家人，我们不会自动发送。</p>
          {issued && <div className="account-issued"><label>新邀请码<input readOnly value={issued.code} autoComplete="off" spellCheck={false} onFocus={event => event.target.select()} /></label><p>原始邀请码仅在这次生成后显示，请复制保存；离开页面后无法再次查看。</p><button type="button" disabled={busy} onClick={() => void copyInvite()}>复制邀请码</button>{copyStatus && <p role="status">{copyStatus}</p>}</div>}
          <button type="button" disabled={busy || invites.loading} onClick={() => void invites.refresh()}>刷新邀请</button>
          {invites.loading && <p role="status">正在读取邀请…</p>}{invites.error && <p className="account-error" role="alert">{invites.error}</p>}
          <ul className="account-list">{invites.data?.map(invite => {
            const status = invite.revoked_at ? "已撤销" : invite.used_at ? "已使用" : new Date(invite.expires_at).getTime() <= Date.now() ? "已过期" : "待使用";
            return <li key={invite.id}><div><strong>{status}</strong><small>生成于 {when(invite.created_at)}</small><small>有效至 {when(invite.expires_at)}</small></div>{status === "待使用" && <button type="button" disabled={busy} onClick={() => revokeInvite(invite)}>撤销邀请码</button>}</li>;
          })}</ul>
          {!invites.loading && invites.data?.length === 0 && <p className="account-muted">还没有邀请码。</p>}
        </section>
      </>}
      {busy && <p className="account-progress" role="status">正在保存，请稍候…</p>}
    </main>
  </div>;
}
