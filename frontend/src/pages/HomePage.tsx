import type { MeResponse } from "../api/client";
import { Brand } from "../components/Brand";
import { RoomPlaceholder } from "../components/RoomPlaceholder";

export function HomePage({ me, onLogout }: { me: MeResponse; onLogout: () => Promise<void> }) {
  const initial = me.user.display_name.slice(0, 1).toUpperCase();

  return (
    <div className="home-page">
      <header className="home-top">
        <Brand compact />
        <div className="home-top-right">
          <span className="env-badge">M0 · 骨架已通</span>
          <div className="user-chip">
            <span className="avatar">{initial}</span>
            <span>{me.user.display_name}</span>
          </div>
          <button className="text-btn" type="button" onClick={onLogout}>
            退出
          </button>
        </div>
      </header>

      <main className="home-main">
        <section className="hero-card">
          <div className="hero-copy">
            <span className="eyebrow">YOUR HOME · 3D</span>
            <h1>你家的东西，<br />都在这间房里。</h1>
            <p>M1 会把这里换成真正的 3D 房间：点击柜子打开，搜一件东西就飞过去高亮。</p>
          </div>
          <RoomPlaceholder />
        </section>

        <aside className="status-card">
          <div className="status-head">
            <span className="eyebrow">M0 CHECKLIST</span>
            <span className="status-dot" />
          </div>
          <h2>底座已经跑起来了</h2>
          <ul className="check-list">
            <li><span>✓</span> FastAPI + SQLite 已连通</li>
            <li><span>✓</span> 登录态已写入 HttpOnly Cookie</li>
            <li><span>✓</span> 密码使用 argon2id 哈希</li>
            <li><span>✓</span> 家庭：{me.household.name}</li>
            <li className="pending"><span>→</span> M1：房间、容器、3D 编辑器</li>
            <li className="pending"><span>→</span> M2：物品、搜索、高亮</li>
          </ul>
          <div className="status-foot">
            <span>下一步</span>
            <strong>搭第一间房</strong>
          </div>
        </aside>
      </main>

      <footer className="home-foot">
        <span>物位 · 私有部署在 bd-a</span>
        <span>数据只属于你家</span>
      </footer>
    </div>
  );
}
