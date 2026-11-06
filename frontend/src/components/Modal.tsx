import { useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { UNSAFE_DataRouterContext, useBlocker } from "react-router-dom";
import { captureSession } from "../api/sessionEvents";

export function confirmDiscard(dirty: boolean): boolean {
  return !dirty || window.confirm("有尚未保存的内容，确定放弃这些修改吗？");
}

function NavigationGuard({ dirty, busy }: { dirty: boolean; busy: boolean }) {
  const ticket = useRef(captureSession());
  const blocker = useBlocker(useCallback(() => {
    const session = captureSession();
    return session.active && session.epoch === ticket.current.epoch && (dirty || busy);
  }, [dirty, busy]));
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const session = captureSession();
    if (!session.active || session.epoch !== ticket.current.epoch) { blocker.proceed(); return; }
    if (busy) { blocker.reset(); return; }
    if (confirmDiscard(dirty)) blocker.proceed(); else blocker.reset();
  }, [blocker, busy, dirty]);
  return null;
}

export function Modal({ title, onClose, children, busy = false, dirty = false }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean; dirty?: boolean }) {
  const router = useContext(UNSAFE_DataRouterContext);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    if (node?.showModal) node.showModal(); else node?.setAttribute("open", "");
    return () => { node?.close?.(); previous?.focus(); };
  }, []);
  useEffect(() => {
    if (!dirty && !busy) return;
    const preventUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty, busy]);
  function close() { if (!busy && confirmDiscard(dirty)) onClose(); }
  return createPortal(<dialog ref={dialog} className="inventory-dialog" aria-label={title} onCancel={event => { event.preventDefault(); close(); }}>
    {router && (dirty || busy) && <NavigationGuard dirty={dirty} busy={busy} />}
    <div className="inventory-dialog-head"><h2>{title}</h2><button type="button" aria-label="关闭对话框" disabled={busy} onClick={close}>×</button></div>
    {children}
  </dialog>, document.body);
}
