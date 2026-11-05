export type SessionTicket = Readonly<{ epoch: number; active: boolean }>;

let epoch = 0;
let active = false;
const expiredListeners = new Set<() => void>();

export function captureSession(): SessionTicket { return { epoch, active }; }

export function activateSession(): void { epoch++; active = true; }

export function invalidateSession(): void { epoch++; active = false; }

export function subscribeSessionExpired(listener: () => void): () => void {
  expiredListeners.add(listener);
  return () => { expiredListeners.delete(listener); };
}

export function notifyUnauthorized(ticket: SessionTicket, path: string, status: number): void {
  // These public authentication endpoints can legitimately return 401 while the
  // user corrects credentials. They never represent expiration of a known login.
  const endpoint = path.split("?")[0];
  if (status !== 401 || ["/auth/login", "/auth/join", "/setup", "/setup/status", "/health"].includes(endpoint)) return;
  if (!ticket.active || !active || ticket.epoch !== epoch) return;
  invalidateSession();
  for (const listener of [...expiredListeners]) listener();
}
