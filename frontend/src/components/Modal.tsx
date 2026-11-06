import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { confirmDiscard, useDraftNavigation } from "./DraftNavigationProvider";
export { confirmDiscard } from "./DraftNavigationProvider";

export function Modal({ title, onClose, children, busy = false, dirty = false }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean; dirty?: boolean }) {
  useDraftNavigation(dirty, busy);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    if (node?.showModal) node.showModal(); else node?.setAttribute("open", "");
    return () => { node?.close?.(); previous?.focus(); };
  }, []);
  useLayoutEffect(() => {
    if (!dirty && !busy) return;
    const preventUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty, busy]);
  function close() { if (!busy && confirmDiscard(dirty)) onClose(); }
  return createPortal(<dialog ref={dialog} className="inventory-dialog" aria-label={title} onCancel={event => { event.preventDefault(); close(); }}>
    <div className="inventory-dialog-head"><h2>{title}</h2><button type="button" aria-label="关闭对话框" disabled={busy} onClick={close}>×</button></div>
    {children}
  </dialog>, document.body);
}
