import { useEffect, useState } from "react";
import { getContainerLocation, type ContainerLocation } from "../api/locations";
import { Brand } from "../components/Brand";
import { CompartmentGrid } from "../components/CompartmentGrid";
import "../styles/location.css";

export type LocationPageProps = {
  containerId: string;
  compartmentId?: string;
  onViewItems: (compartmentId: string) => void;
  onRegister: (compartmentId: string) => void;
  onCapture?: (compartmentId: string) => void;
  onBack: () => void;
};

type LocationState = { key: string; data: ContainerLocation | null; error: string; loading: boolean; selected: string };

export function LocationPage({ containerId, compartmentId, onViewItems, onRegister, onCapture, onBack }: LocationPageProps) {
  const key = JSON.stringify([containerId, compartmentId]);
  const [state, setState] = useState<LocationState>({ key, data: null, error: "", loading: true, selected: "" });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ key, data: null, error: "", loading: true, selected: "" });
    void getContainerLocation(containerId, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      if (data.container.id !== containerId || data.container.room_id !== data.room.id ||
          data.container.compartments.some(entry => entry.container_id !== containerId)) throw new Error("位置信息不完整，请重新加载。");
      if (compartmentId !== undefined && !data.container.compartments.some(entry => entry.id === compartmentId)) {
        throw new Error("标签指定的隔层已删除或不属于这个容器，请重新确认位置。");
      }
      setState({ key, data, error: "", loading: false, selected: compartmentId ?? "" });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ key, data: null, error: error instanceof Error ? error.message : "位置加载失败，请重试", loading: false, selected: "" });
    });
    return () => controller.abort();
  }, [key, revision]);
  const current = state.key === key ? state : null;
  const data = current?.data;
  const selected = data?.container.compartments.find(entry => entry.id === current?.selected);
  return <div className="location-page">
    <header className="location-header"><Brand compact /><button type="button" onClick={onBack}>返回空间</button></header>
    <main className="location-main">
      {(!current || current.loading) && <p className="inventory-muted" role="status">正在核对当前位置…</p>}
      {current?.error && <section className="location-card"><h1>无法打开此位置</h1><p className="inventory-error" role="alert">{current.error}</p><button type="button" onClick={() => setRevision(value => value + 1)}>重新加载位置</button></section>}
      {data && <section className="location-card">
        <span className="eyebrow">当前位置</span><h1>{data.container.name}</h1>
        <p className="location-breadcrumb">{data.room.name} / {data.container.name}{selected ? ` / ${selected.name}` : ""}</p>
        <p className="inventory-muted">{selected ? "已选中标签对应的隔层，也可以选择下方其他隔层。" : "请选择一个隔层，再查看或登记物品。"}</p>
        <CompartmentGrid container={data.container} selectedId={current.selected} onSelect={compartment => {
          if (data.container.compartments.some(entry => entry.id === compartment.id && entry.container_id === containerId)) setState(previous => ({ ...previous, selected: compartment.id }));
        }} />
        <div className="location-actions">
          <button type="button" disabled={!selected} onClick={() => selected && onViewItems(selected.id)}>查看隔层物品</button>
          <button type="button" className="inventory-primary" disabled={!selected} onClick={() => selected && onRegister(selected.id)}>登记到此隔层</button>
          {onCapture && <button type="button" disabled={!selected} onClick={() => selected && onCapture(selected.id)}>拍照登记到此隔层</button>}
        </div>
      </section>}
    </main>
  </div>;
}
