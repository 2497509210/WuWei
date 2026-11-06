import { useLayoutEffect, useRef, type RefObject } from "react";
import type { MeResponse } from "../api/client";
import { findOwner, findScroll, rememberFindPath } from "../lib/findNavigation";

export function useFindScroll(me: MeResponse, path: string | undefined, trusted: boolean, heading: RefObject<HTMLDivElement | null>) {
  const liveTrusted = useRef(trusted); liveTrusted.current = trusted;
  const pendingPage = useRef<string | null>(null);
  const restoration = useRef<{ path: string; done: boolean; y: number } | null>(null);
  const owner = findOwner(me);

  useLayoutEffect(() => {
    if (!path) return;
    const state = { path, done: false, y: findScroll(me, path) };
    restoration.current = state;
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    const save = () => {
      if (!state.done || !liveTrusted.current) return;
      state.y = window.scrollY;
      rememberFindPath(me, path, state.y);
    };
    const hide = () => { save(); if (state.done) rememberFindPath(me, path, state.y); };
    window.addEventListener("scroll", save, { passive: true });
    window.addEventListener("pagehide", hide);
    return () => {
      // Loading another view can shrink the document before cleanup. The last
      // observed trusted offset is more reliable than reading the new layout.
      if (state.done) rememberFindPath(me, path, state.y);
      window.removeEventListener("scroll", save);
      window.removeEventListener("pagehide", hide);
      window.history.scrollRestoration = previous;
    };
  }, [owner, path]);

  useLayoutEffect(() => {
    const state = restoration.current;
    if (!path || !state || state.path !== path) return;
    if (!trusted) { state.done = false; return; }
    if (state.done) return;
    if (pendingPage.current === path) heading.current?.scrollIntoView?.({ block: "start" });
    else window.scrollTo({ top: state.y, behavior: "instant" });
    pendingPage.current = null;
    state.done = true; state.y = window.scrollY;
    rememberFindPath(me, path, state.y);
  }, [owner, path, trusted, heading]);

  return (nextPath: string) => { pendingPage.current = nextPath; };
}
