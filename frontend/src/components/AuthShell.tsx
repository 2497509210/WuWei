import type { ReactNode } from "react";
import { Brand } from "./Brand";

export function AuthShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-glow" />
      <header className="auth-top">
        <Brand />
        <span className="auth-badge">PRIVATE · FAMILY ONLY</span>
      </header>
      <main className="auth-card">
        {children}
        {footer && <div className="auth-footer">{footer}</div>}
      </main>
      <p className="auth-note">数据只存在你自己家的服务器上 · 每天自动备份</p>
    </div>
  );
}
