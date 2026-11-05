type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
let snapshot: { pending: InstallEvent | null; installed: boolean } = { pending: null, installed: false };
const listeners = new Set<() => void>();
function publish(value: typeof snapshot) { snapshot = value; for (const listener of listeners) listener(); }

// Loaded with the app shell so an event arriving before the lazy find page is retained.
window.addEventListener("beforeinstallprompt", event => {
  const candidate = event as InstallEvent;
  if (typeof candidate.prompt !== "function") return;
  event.preventDefault(); publish({ pending: candidate, installed: false });
});
window.addEventListener("appinstalled", () => publish({ pending: null, installed: true }));

export function getInstallState() { return snapshot; }
export function subscribeInstall(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export async function requestInstallation(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = snapshot.pending;
  if (!event) return "unavailable";
  publish({ ...snapshot, pending: null });
  await event.prompt();
  return (await event.userChoice).outcome;
}
