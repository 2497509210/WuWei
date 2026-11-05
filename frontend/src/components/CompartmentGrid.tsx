import type { CSSProperties } from "react";
import type { Compartment, Container } from "../api/client";
import "../styles/spatial.css";

type CompartmentGridProps = {
  container: Container;
  selectedId?: string | null;
  onSelect: (compartment: Compartment) => void;
};

export function CompartmentGrid({ container, selectedId, onSelect }: CompartmentGridProps) {
  const compartments = [...container.compartments].sort((a, b) =>
    a.level_index - b.level_index || a.row - b.row || a.col - b.col || a.sort - b.sort
  );
  if (!compartments.length) {
    return <p className="spatial-empty" role="status">这个容器还没有隔层。</p>;
  }

  const columns = [...new Set(compartments.map((compartment) => compartment.col))].sort((a, b) => a - b);
  const rows = [...new Set(compartments.map((compartment) => `${compartment.level_index}:${compartment.row}`))];
  const columnNames = columns.length === 3 ? ["左", "中", "右"] : columns.length === 2 ? ["左", "右"] : ["整层"];

  return (
    <section className="compartment-map" aria-label={`${container.name}的隔层`}>
      <div className="compartment-map-heading">
        <span>柜内正视图</span>
        <span>从上到下</span>
      </div>
      <div className="compartment-map-columns" aria-hidden="true" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
        {columns.map((col, index) => <span key={col}>{columnNames[index] ?? `第 ${index + 1} 列`}</span>)}
      </div>
      <div
        className="compartment-map-body"
        style={{ "--compartment-columns": columns.length } as CSSProperties}
      >
        {compartments.map((compartment) => (
          <button
            key={compartment.id}
            type="button"
            className="compartment-map-cell"
            aria-label={compartment.name}
            aria-pressed={selectedId === compartment.id}
            style={{
              gridColumn: columns.indexOf(compartment.col) + 1,
              gridRow: rows.indexOf(`${compartment.level_index}:${compartment.row}`) + 1,
            }}
            onClick={() => onSelect(compartment)}
          >
            <span>{compartment.name}</span>
            <small>{selectedId === compartment.id ? "已选中" : "查看此处"}</small>
          </button>
        ))}
      </div>
    </section>
  );
}
