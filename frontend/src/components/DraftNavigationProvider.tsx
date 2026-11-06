import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useBlocker } from "react-router-dom";
import { captureSession, type SessionTicket } from "../api/sessionEvents";

type Draft = { dirty: boolean; busy: boolean; session: SessionTicket };
type RegisterDraft = (id: symbol, draft: Draft) => () => void;
const DraftNavigationContext = createContext<RegisterDraft | null>(null);

export function confirmDiscard(dirty: boolean): boolean {
  return !dirty || window.confirm("有尚未保存的内容，确定放弃这些修改吗？");
}

/** Keep one router blocker installed for the full app lifetime, including clean forms. */
export function DraftNavigationProvider({ children }: { children: ReactNode }) {
  const drafts = useRef(new Map<symbol, Draft>());
  const register = useCallback<RegisterDraft>((id, draft) => {
    drafts.current.set(id, draft);
    return () => { drafts.current.delete(id); };
  }, []);
  const currentDrafts = useCallback(() => {
    const session = captureSession();
    if (!session.active) return [];
    return Array.from(drafts.current.values()).filter(draft => draft.session.active && draft.session.epoch === session.epoch);
  }, []);
  const blocker = useBlocker(useCallback(() => currentDrafts().some(draft => draft.dirty || draft.busy), [currentDrafts]));
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const active = currentDrafts();
    // Leaving is not cancellation of a write whose server result is still unknown.
    if (active.some(draft => draft.busy)) { blocker.reset(); return; }
    if (confirmDiscard(active.some(draft => draft.dirty))) blocker.proceed(); else blocker.reset();
  }, [blocker, currentDrafts]);
  return <DraftNavigationContext.Provider value={register}>{children}</DraftNavigationContext.Provider>;
}

/** Publish committed form state before any parent layout effect or browser event can navigate. */
export function useDraftNavigation(dirty: boolean, busy: boolean): void {
  const register = useContext(DraftNavigationContext);
  const id = useRef(Symbol("draft"));
  const session = useRef(captureSession());
  useLayoutEffect(() => register?.(id.current, { dirty, busy, session: session.current }), [register, dirty, busy]);
}
