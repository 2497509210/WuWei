import { request, type Container, type RoomSummary } from "./client";

export type ContainerLocation = { room: RoomSummary; container: Container };

export function getContainerLocation(containerId: string, signal?: AbortSignal): Promise<ContainerLocation> {
  return request(`/containers/${encodeURIComponent(containerId)}`, { signal });
}
