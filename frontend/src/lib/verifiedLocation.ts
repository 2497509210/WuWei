import { ApiError, getRoom } from "../api/client";
import { resolveCompartment } from "../api/mobile";

/** Verify both ownership and current room membership before using a remembered ID. */
export async function verifiedLocation(id: string, signal?: AbortSignal) {
  const { location } = await resolveCompartment(id, signal);
  if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
  const detail = await getRoom(location.room_id);
  if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
  const container = detail.containers.find(entry => entry.id === location.container_id);
  const compartment = container?.compartments.find(entry => entry.id === id);
  if (location.compartment_id !== id || detail.room.id !== location.room_id || !container || container.room_id !== location.room_id || !compartment || compartment.container_id !== container.id) {
    throw new ApiError(404, "compartment_not_found", "原来的隔层已不可用，请重新选择位置");
  }
  return { location: { ...location, path: [detail.room.name, container.name, compartment.name] }, detail };
}
