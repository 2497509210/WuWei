import { useEffect, useRef, useState } from "react";

/** Revalidate reads on return, while never replacing an active form or selection. */
export function useInventoryRefresh(blocked: boolean, loading: boolean, onRefresh: () => void) {
  const [deferred, setDeferred] = useState(false);
  const pending = useRef(false);
  const lastVerified = useRef(Date.now());
  const lastAttempt = useRef(-Infinity);
  const current = useRef({ blocked, loading, onRefresh }); current.current = { blocked, loading, onRefresh };

  function flush() {
    if (!pending.current || current.current.blocked || current.current.loading || document.visibilityState === "hidden") return;
    pending.current = false; setDeferred(false); lastAttempt.current = Date.now();
    current.current.onRefresh();
  }
  useEffect(() => {
    function wake(force = false) {
      if (pending.current) { flush(); return; }
      const now = Date.now();
      if (now - lastAttempt.current < 15_000 || (!force && now - lastVerified.current < 60_000)) return;
      pending.current = true; setDeferred(true); flush();
    }
    const visible = () => { if (document.visibilityState !== "hidden") wake(); };
    const online = () => wake(true);
    const pageshow = (event: PageTransitionEvent) => wake(event.persisted);
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    window.addEventListener("online", online);
    window.addEventListener("pageshow", pageshow);
    return () => {
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", visible);
      window.removeEventListener("online", online);
      window.removeEventListener("pageshow", pageshow);
    };
  }, []);
  useEffect(() => { flush(); }, [blocked, loading]);
  function verified() { lastVerified.current = Date.now(); if (!pending.current) setDeferred(false); }
  return { deferred, verified };
}
