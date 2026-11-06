import { useEffect, useState } from "react";
import { ApiError, type MeResponse } from "../api/client";
import { forgetLocation, recentLocations } from "../lib/recentLocation";
import { verifiedLocation } from "../lib/verifiedLocation";
import "./RecentLocations.css";

type Entry = { id: string; label: string | null; failed: boolean };

export function RecentLocations({ me, value, revision = 0, onChoose }: {
  me: MeResponse; value: string; revision?: number; onChoose: (id: string) => void;
}) {
  const scope = `${encodeURIComponent(me.household.id)}:${encodeURIComponent(me.user.id)}`;
  const [state, setState] = useState<{ scope: string; entries: Entry[] }>({ scope, entries: [] });
  const [retry, setRetry] = useState(0);
  const ids = recentLocations(me).join("\u0000");
  useEffect(() => {
    const controller = new AbortController();
    const entries = ids ? ids.split("\u0000").map(id => ({ id, label: null, failed: false })) : [];
    setState({ scope, entries });
    for (const entry of entries) {
      void verifiedLocation(entry.id, controller.signal).then(({ location }) => {
        if (controller.signal.aborted) return;
        setState(previous => previous.scope !== scope ? previous : { scope, entries: previous.entries.map(current => current.id === entry.id ? { ...current, label: location.path.join(" / "), failed: false } : current) });
      }).catch(error => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          forgetLocation(me, entry.id);
          setState(previous => previous.scope !== scope ? previous : { scope, entries: previous.entries.filter(current => current.id !== entry.id) });
        } else {
          setState(previous => previous.scope !== scope ? previous : { scope, entries: previous.entries.map(current => current.id === entry.id ? { ...current, failed: true } : current) });
        }
      });
    }
    return () => controller.abort();
  }, [ids, me.household.id, me.user.id, scope, revision, retry]);
  const entries = state.scope === scope ? state.entries : [];
  if (!entries.length) return null;
  const failed = entries.some(entry => entry.failed);
  return <section className="recent-locations" aria-label="最近使用的位置">
    <p className="recent-locations-title">最近使用的位置</p>
    <div className="recent-locations-options">{entries.filter(entry => entry.label).map(entry => <button key={entry.id} type="button" aria-label={`使用最近位置：${entry.label}`} aria-pressed={value === entry.id} onClick={() => onChoose(entry.id)}>{entry.label}</button>)}</div>
    {entries.some(entry => !entry.label && !entry.failed) && <p className="inventory-muted" role="status">正在核对最近位置…</p>}
    {failed && <p className="recent-locations-retry">部分最近位置暂时无法读取，已保留。<button type="button" onClick={() => setRetry(current => current + 1)}>重试读取最近位置</button></p>}
  </section>;
}
