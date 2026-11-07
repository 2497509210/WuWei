import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import "../styles/photo-viewer.css";

type Point = { x: number; y: number };
type View = Point & { scale: number };
type Gesture = { view: View; points: Point[] };
const resetView: View = { scale: 1, x: 0, y: 0 };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** An independent top-layer dialog: closing a photo never discards its parent form. */
export function PhotoViewer({ src, name, onClose, returnFocus }: { src: string; name: string; onClose: () => void; returnFocus?: HTMLElement | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const photo = useRef<HTMLImageElement>(null);
  const [view, setView] = useState(resetView);
  const viewRef = useRef(view);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");

  useEffect(() => {
    const node = dialog.current;
    const previous = returnFocus ?? document.activeElement as HTMLElement | null;
    if (node?.showModal) node.showModal(); else node?.setAttribute("open", "");
    closeButton.current?.focus();
    return () => { node?.close?.(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const resize = () => { pointers.current.clear(); gesture.current = null; apply(viewRef.current); };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  function apply(next: View) {
    const bounds = stage.current?.getBoundingClientRect();
    const image = photo.current;
    const scale = Math.min(4, Math.max(1, next.scale));
    let x = next.x, y = next.y;
    if (bounds && image?.naturalWidth && image.naturalHeight) {
      const fit = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
      const maxX = Math.max(0, (image.naturalWidth * fit * scale - bounds.width) / 2);
      const maxY = Math.max(0, (image.naturalHeight * fit * scale - bounds.height) / 2);
      x = Math.min(maxX, Math.max(-maxX, x)); y = Math.min(maxY, Math.max(-maxY, y));
    }
    const value = scale === 1 ? resetView : { scale, x, y };
    viewRef.current = value; setView(value);
  }
  function beginGesture() { gesture.current = { view: viewRef.current, points: Array.from(pointers.current.values()).slice(0, 2) }; }
  function zoom(delta: number) {
    if (state !== "loaded") return;
    const previous = viewRef.current;
    const scale = Math.min(4, Math.max(1, previous.scale + delta));
    apply({ scale, x: previous.x * scale / previous.scale, y: previous.y * scale / previous.scale });
    beginGesture();
  }
  function reset() { apply(resetView); beginGesture(); }
  function down(event: PointerEvent<HTMLDivElement>) {
    if (state !== "loaded" || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture?.(event.pointerId); beginGesture();
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    event.preventDefault();
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = Array.from(pointers.current.values()).slice(0, 2), start = gesture.current;
    if (points.length === 2 && start.points.length === 2) {
      const initialDistance = distance(start.points[0], start.points[1]);
      if (!initialDistance) return;
      const scale = Math.min(4, Math.max(1, start.view.scale * distance(points[0], points[1]) / initialDistance));
      const ratio = scale / start.view.scale;
      const before = midpoint(start.points[0], start.points[1]), after = midpoint(points[0], points[1]);
      const bounds = stage.current!.getBoundingClientRect();
      const center = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      apply({ scale, x: start.view.x * ratio + after.x - center.x - (before.x - center.x) * ratio, y: start.view.y * ratio + after.y - center.y - (before.y - center.y) * ratio });
    } else if (points.length === 1 && start.points.length === 1) {
      apply({ scale: start.view.scale, x: start.view.x + points[0].x - start.points[0].x, y: start.view.y + points[0].y - start.points[0].y });
    }
  }
  function end(event: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    beginGesture();
  }
  const imageSource = attempt ? `${src}${src.includes("?") ? "&" : "?"}retry=${attempt}` : src;
  return createPortal(<dialog ref={dialog} className="photo-viewer" aria-label={`${name}照片查看`} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onKeyDown={event => {
      event.stopPropagation();
      if (["Escape", "+", "=", "-", "0"].includes(event.key)) event.preventDefault();
      if (event.key === "Escape") onClose();
      else if (event.key === "+" || event.key === "=") zoom(.5);
      else if (event.key === "-") zoom(-.5);
      else if (event.key === "0") reset();
    }}>
    <div className="photo-viewer-toolbar"><strong>{name}</strong><div>
      <button type="button" aria-label="缩小" disabled={state !== "loaded" || view.scale <= 1} onClick={() => zoom(-.5)}>−</button>
      <output aria-label="缩放比例" aria-live="polite">{Math.round(view.scale * 100)}%</output>
      <button type="button" aria-label="放大" disabled={state !== "loaded" || view.scale >= 4} onClick={() => zoom(.5)}>＋</button>
      <button type="button" aria-label="重置缩放" disabled={state !== "loaded"} onClick={reset}>重置</button>
      <button ref={closeButton} type="button" aria-label="关闭照片" onClick={onClose}>关闭</button>
    </div></div>
    <div ref={stage} className="photo-viewer-stage" aria-label="照片缩放区域" onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
      {state === "loading" && <p className="photo-viewer-status" role="status">正在加载原图…</p>}
      {state === "error" && <div className="photo-viewer-status"><p role="alert">无法加载照片，请检查连接后重试。</p><button type="button" onClick={() => { setAttempt(value => value + 1); setState("loading"); reset(); }}>重新加载照片</button></div>}
      <img ref={photo} key={imageSource} src={imageSource} alt={`${name}原图`} draggable={false} onDragStart={event => event.preventDefault()} onLoad={() => { setState("loaded"); apply(viewRef.current); }} onError={() => setState("error")}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, visibility: state === "loaded" ? "visible" : "hidden" }} />
    </div>
    <p className="photo-viewer-help">双指缩放，放大后拖动查看 · 键盘 + / − 缩放，Esc 关闭</p>
  </dialog>, document.body);
}
