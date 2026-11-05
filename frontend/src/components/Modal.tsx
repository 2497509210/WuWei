import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Modal({ title, onClose, children, busy = false }: { title: string; onClose: () => void; children: ReactNode; busy?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    if (node?.showModal) node.showModal(); else node?.setAttribute("open", "");
    return () => { node?.close?.(); previous?.focus(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="inventory-dialog" aria-label={title} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className="inventory-dialog-head"><h2>{title}</h2><button type="button" aria-label="关闭对话框" disabled={busy} onClick={onClose}>×</button></div>
    {children}
  </dialog>, document.body);
}
