import type { Container, RoomSummary } from "../api/client";
import "../styles/spatial.css";

type RoomPlanProps = {
  room: RoomSummary;
  containers: Container[];
  selectedId?: string | null;
  onSelect: (containerId: string) => void;
};

export function RoomPlan({ room, containers, selectedId, onSelect }: RoomPlanProps) {
  const width = Math.max(1, room.width_cm);
  const depth = Math.max(1, room.depth_cm);

  return (
    <section className="room-plan" aria-label={`${room.name}的空间位置`}>
      <div className="room-plan-heading">
        <strong>{room.name}</strong>
        <span>{room.width_cm} × {room.depth_cm} cm</span>
      </div>
      <div className="room-plan-frame">
        <div className="room-plan-floor" role="group" aria-label={`${room.name}平面图`} style={{ aspectRatio: `${width} / ${depth}` }}>
          {containers.map((container) => {
            const quarterTurn = Math.abs(container.rot_deg % 180) === 90;
            const footprintWidth = quarterTurn ? container.depth_cm : container.width_cm;
            const footprintDepth = quarterTurn ? container.width_cm : container.depth_cm;
            return (
              <button
                key={container.id}
                type="button"
                className="room-plan-container"
                data-preset={container.preset}
                aria-label={container.name}
                aria-pressed={container.id === selectedId}
                style={{
                  left: `${((container.x_cm - footprintWidth / 2) / width) * 100}%`,
                  top: `${((container.z_cm - footprintDepth / 2) / depth) * 100}%`,
                  width: `${(footprintWidth / width) * 100}%`,
                  height: `${(footprintDepth / depth) * 100}%`,
                }}
                onClick={() => onSelect(container.id)}
              >
                <span className="room-plan-container-name">{container.name}</span>
                <span className="room-plan-front" aria-hidden="true" style={{ transform: `rotate(${-container.rot_deg}deg)` }}>↓</span>
              </button>
            );
          })}
        </div>
      </div>
      {containers.length ? (
        <ul className="room-plan-list" aria-label="房间容器">
          {containers.map((container) => (
            <li key={container.id}>
              <button type="button" aria-pressed={selectedId === container.id} onClick={() => onSelect(container.id)}>
                <span>{container.name}</span>
                <small>{container.width_cm} × {container.depth_cm} cm</small>
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="spatial-empty" role="status">房间里还没有容器。</p>}
    </section>
  );
}
