import { useEffect, useRef, useState } from "react";
import type { Container, ContainerPatch, RoomSummary } from "../api/client";

export function MobileActionBar({
  container,
  onMove,
  onSize,
  onRotate,
  onMore,
  onClose,
}: {
  container: Container;
  onMove: () => void;
  onSize: () => void;
  onRotate: () => void;
  onMore: () => void;
  onClose: () => void;
}) {
  return (
    <div className="mobile-action-bar">
      <div className="mobile-action-title">
        <strong>{container.name}</strong>
        <small>{container.config.layers ?? 1} 层</small>
      </div>
      <button type="button" className="mobile-action-btn" onClick={onMove}>
        <span className="mobile-action-icon">✥</span>
        <span>移动</span>
      </button>
      <button type="button" className="mobile-action-btn" onClick={onSize}>
        <span className="mobile-action-icon">⤢</span>
        <span>尺寸</span>
      </button>
      <button type="button" className="mobile-action-btn" onClick={onRotate}>
        <span className="mobile-action-icon">↻</span>
        <span>旋转</span>
      </button>
      <button type="button" className="mobile-action-btn" onClick={onMore}>
        <span className="mobile-action-icon">⋯</span>
        <span>更多</span>
      </button>
      <button type="button" className="mobile-action-close" aria-label="关闭" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

export function MobileMovePill({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="mobile-move-pill">
      <span>单指拖动容器 · 靠近墙会自动吸附</span>
      <button type="button" onClick={onFinish}>
        完成
      </button>
    </div>
  );
}

function patchForField(container: Container, field: "width" | "depth" | "height" | "layers", value: number): ContainerPatch {
  if (field === "layers") return { config: { ...container.config, layers: value } };
  return { [`${field}_cm`]: value } as ContainerPatch;
}

export function MobileSizeSheet({
  container,
  onClose,
  onPatch,
}: {
  container: Container;
  onClose: () => void;
  onPatch: (patch: ContainerPatch) => Promise<void>;
}) {
  const [draft, setDraft] = useState({
    width: container.width_cm,
    depth: container.depth_cm,
    height: container.height_cm,
    layers: container.config.layers ?? 1,
  });
  const [error, setError] = useState("");
  const pending = useRef<ContainerPatch>({});
  const timer = useRef<number | undefined>(undefined);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const closing = useRef(false);

  useEffect(() => {
    setDraft({
      width: container.width_cm,
      depth: container.depth_cm,
      height: container.height_cm,
      layers: container.config.layers ?? 1,
    });
  }, [container.id, container.width_cm, container.depth_cm, container.height_cm, container.config.layers]);

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  async function flush(): Promise<boolean> {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    if (inFlight.current) {
      if (!(await inFlight.current)) return false;
      return flush();
    }
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return true;
    const request = Promise.resolve()
      .then(() => onPatch(patch))
      .then(() => { setError(""); return true; })
      .catch((err: unknown) => {
        // Retain the failed draft; any more recent field values take precedence.
        pending.current = { ...patch, ...pending.current };
        setError(err instanceof Error ? err.message : "保存失败");
        return false;
      })
      .finally(() => { inFlight.current = null; });
    inFlight.current = request;
    return request;
  }

  function closeSheet() {
    if (closing.current) return;
    closing.current = true;
    void (async () => {
      try {
        do {
          if (!(await flush())) return;
        } while (Object.keys(pending.current).length || inFlight.current);
        onClose();
      } finally { closing.current = false; }
    })();
  }

  function schedule(patch: ContainerPatch) {
    pending.current = { ...pending.current, ...patch };
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      void flush();
    }, 260);
  }

  function step(field: "width" | "depth" | "height" | "layers", delta: number) {
    const limits = field === "layers" ? [1, 8] : field === "height" ? [10, 300] : [20, 400];
    const value = Math.min(Math.max(draft[field] + delta, limits[0]), limits[1]);
    setDraft((current) => ({ ...current, [field]: value }));
    schedule(patchForField(container, field, value));
  }

  function commit(field: "width" | "depth" | "height" | "layers") {
    schedule(patchForField(container, field, draft[field]));
  }

  const rows: Array<{ field: "width" | "depth" | "height" | "layers"; label: string; unit: string }> = [
    { field: "width", label: "宽", unit: "cm" },
    { field: "depth", label: "深", unit: "cm" },
    { field: "height", label: "高", unit: "cm" },
    { field: "layers", label: "层数", unit: "层" },
  ];

  return (
    <div className="mobile-sheet-backdrop" onClick={closeSheet}>
      <div className="mobile-sheet" onClick={(event) => event.stopPropagation()}>
        <div className="mobile-sheet-handle" />
        <div className="mobile-sheet-head">
          <div>
            <span className="eyebrow">SIZE</span>
            <h2>调整尺寸</h2>
          </div>
          <button type="button" className="mobile-sheet-close" aria-label="关闭" onClick={closeSheet}>
            ×
          </button>
        </div>

        <div className="size-rows">
          {rows.map((row) => (
            <div className="size-row" key={row.field}>
              <span className="size-row-label">{row.label}</span>
              <button type="button" className="size-step" aria-label={`${row.label}减小`} onClick={() => step(row.field, -1)}>
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                className="size-value"
                value={draft[row.field]}
                aria-label={row.label}
                onChange={(event) => setDraft((current) => ({ ...current, [row.field]: Number(event.target.value) }))}
                onBlur={() => commit(row.field)}
              />
              <button type="button" className="size-step" aria-label={`${row.label}增大`} onClick={() => step(row.field, 1)}>
                +
              </button>
              <span className="size-unit">{row.unit}</span>
            </div>
          ))}
        </div>

        {error && <div className="mobile-sheet-error">{error}</div>}

        <details className="mobile-compartments">
          <summary>隔层（{container.compartments.length}）</summary>
          {container.compartments.map((compartment) => (
            <div className="compartment-row" key={compartment.id}>
              <span className="compartment-dot" />
              <span>{compartment.name}</span>
              <small>{compartment.kind}</small>
            </div>
          ))}
        </details>

        <button type="button" className="primary-btn mobile-sheet-done" onClick={closeSheet}>
          完成
        </button>
      </div>
    </div>
  );
}

export function MobileMoreSheet({
  container,
  onClose,
  onRename,
  onDelete,
}: {
  container: Container;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [name, setName] = useState(container.name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function saveName() {
    setBusy(true);
    try {
      await onRename(name.trim() || container.name);
      setError("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mobile-sheet-backdrop" onClick={onClose}>
      <div className="mobile-sheet small" onClick={(event) => event.stopPropagation()}>
        <div className="mobile-sheet-handle" />
        <div className="mobile-sheet-head">
          <div>
            <span className="eyebrow">CONTAINER</span>
            <h2>{container.name}</h2>
          </div>
          <button type="button" className="mobile-sheet-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>

        <label className="mobile-field">
          <span>名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {error && <div className="mobile-sheet-error">{error}</div>}
        <button type="button" className="ghost-btn" disabled={busy} onClick={() => void saveName()}>
          {busy ? "正在保存…" : "保存名称"}
        </button>

        <div className="mobile-danger-row">
          <button
            type="button"
            className="danger-btn"
            onClick={() => {
              if (window.confirm(`删除「${container.name}」？`)) void onDelete();
            }}
          >
            删除容器
          </button>
        </div>
      </div>
    </div>
  );
}

export function MobileRoomBar({
  room,
  containers,
  items,
  onOpen,
}: {
  room: RoomSummary;
  containers: number;
  items: number;
  onOpen: () => void;
}) {
  return (
    <div className="mobile-room-bar">
      <div>
        <strong>{room.name}</strong>
        <small>
          {room.width_cm} × {room.depth_cm} cm · {containers} 个容器 · {items} 件物品
        </small>
      </div>
      <button type="button" onClick={onOpen}>
        房间设置
      </button>
    </div>
  );
}

export function MobileRoomSheet({
  room,
  containers,
  items,
  onClose,
  onEdit,
  onDelete,
}: {
  room: RoomSummary;
  containers: number;
  items: number;
  onClose: () => void;
  onEdit?: () => void;
  onDelete?: () => Promise<void>;
}) {
  return (
    <div className="mobile-sheet-backdrop" onClick={onClose}>
      <div className="mobile-sheet small" onClick={(event) => event.stopPropagation()}>
        <div className="mobile-sheet-handle" />
        <div className="mobile-sheet-head">
          <div>
            <span className="eyebrow">ROOM</span>
            <h2>{room.name}</h2>
          </div>
          <button type="button" className="mobile-sheet-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="room-stats">
          <div>
            <strong>
              {room.width_cm} × {room.depth_cm}
            </strong>
            <span>厘米</span>
          </div>
          <div>
            <strong>{containers}</strong>
            <span>个容器</span>
          </div>
          <div>
            <strong>{items}</strong>
            <span>件物品</span>
          </div>
        </div>
        {onEdit && <button type="button" className="primary-btn mobile-sheet-done" onClick={onEdit}>编辑房间</button>}
        {onDelete && <button type="button" className="danger-btn mobile-sheet-done" onClick={() => void onDelete()}>
          删除房间
        </button>}
        {!onEdit && <p className="room-readonly-note">仅家庭管理员可修改房间。</p>}
      </div>
    </div>
  );
}

