import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createBrowserRouter, Navigate, Route, RouterProvider, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { ApiError, getMe, getSetupStatus, logout, type MeResponse } from "./api/client";
import { Brand } from "./components/Brand";
import { DraftNavigationProvider } from "./components/DraftNavigationProvider";
import { LoginPage } from "./pages/LoginPage";
import { SetupPage } from "./pages/SetupPage";
import type { LocateTarget } from "./pages/InventoryPage";
import { useWorkspace } from "./store/useWorkspace";
import { activateSession, captureSession, invalidateSession, subscribeSessionExpired } from "./api/sessionEvents";
import { activateFindNavigation, clearFindNavigation, findOwner, findSearch, lastFindPath, readFindView, type FindView } from "./lib/findNavigation";

const WorkspacePage = lazy(() => import("./pages/WorkspacePage").then(module => ({default:module.WorkspacePage})));
const InventoryPage = lazy(() => import("./pages/InventoryPage").then(module => ({default:module.InventoryPage})));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then(module => ({default:module.SettingsPage})));
const JoinPage = lazy(() => import("./pages/JoinPage").then(module => ({default:module.JoinPage})));
const LocationPage = lazy(() => import("./pages/LocationPage").then(module => ({default:module.LocationPage})));
const ItemPage = lazy(() => import("./pages/ItemPage").then(module => ({default:module.ItemPage})));

const isItemPath = (path: string) => /^\/items\/[A-Za-z0-9_-]{1,128}\/?$/.test(path);
const safeJoinDestination = (path?: string) => path && (/^\/(?:find|settings|location\/[^/?#]+)(?:\?[^#]*)?$/.test(path) || isItemPath(path)) ? path : "/";

type Screen = "loading" | "setup" | "login" | "home" | "error";

export default function App() {
  const [router, setRouter] = useState<ReturnType<typeof createBrowserRouter> | null>(null);
  useEffect(() => {
    const current = createBrowserRouter([{ path: "*", element: <DraftNavigationProvider><AppContent /></DraftNavigationProvider> }], {
      basename: import.meta.env.BASE_URL.replace(/\/$/, "") || "/",
    });
    setRouter(current);
    return () => current.dispose();
  }, []);
  return router ? <RouterProvider router={router} /> : <div className="loading-page"><Brand /></div>;
}

function AppContent() {
  const navigate = useNavigate();
  const location = useLocation();
  const navigation = location.state as { target?: LocateTarget; compartment?: string; returnTo?: string; joinReturnTo?: string; findOwner?: string } | null;
  const search = new URLSearchParams(location.search);
  const initialCompartment = search.has("compartment") ? search.get("compartment") ?? "" : navigation?.compartment ?? "";
  const [screen, setScreen] = useState<Screen>("loading");
  const [me, setMe] = useState<MeResponse | null>(null);
  const identity = me ? findOwner(me) : undefined;
  const foreignHistory = Boolean(identity && navigation?.findOwner && navigation.findOwner !== identity);
  const settingsReturn = !foreignHistory && navigation?.returnTo && /^\/find(?:\?[^#]*)?$/.test(navigation.returnTo) ? navigation.returnTo : "/";
  const joinDestination = foreignHistory ? "/" : safeJoinDestination(navigation?.joinReturnTo);
  const initialAction = foreignHistory ? undefined : search.get("capture") === "1" ? "capture" : search.get("register") === "1" ? "register" : undefined;
  const parsedFindView = foreignHistory ? readFindView("") : readFindView(location.search, initialCompartment);
  const findView: FindView = initialAction ? { ...parsedFindView, status: "active", page: 1 } : parsedFindView;
  const [error, setError] = useState("");
  const [loginNotice, setLoginNotice] = useState("");
  const authRequest = useRef(0);
  const currentLocation = useRef(location); currentLocation.current = location;
  const currentNavigate = useRef(navigate); currentNavigate.current = navigate;

  useEffect(() => {
    const unsubscribe = subscribeSessionExpired(() => {
      authRequest.current++;
      useWorkspace.getState().reset();
      setMe(null); setError(""); setLoginNotice("登录已失效，请重新登录"); setScreen("login");
      const current = currentLocation.current;
      const safe = current.pathname === "/" || /^\/(?:find|settings|location\/[^/?#]+)$/.test(current.pathname) || isItemPath(current.pathname);
      if (!safe) currentNavigate.current("/", { replace: true, state: null });
      // Keep a safe internal pathname/query and its location state, so logging
      // back in returns to the same shelf instead of silently changing scope.
    });
    return () => { unsubscribe(); invalidateSession(); };
  }, []);

  const bootstrap = useCallback(async () => {
    const requestId = ++authRequest.current;
    try {
      const status = await getSetupStatus();
      if (status.needed) {
        if (requestId === authRequest.current) setScreen("setup");
        return;
      }
      const current = await getMe();
      if (requestId !== authRequest.current) return;
      activateSession();
      const nextOwner = findOwner(current);
      const entry = currentLocation.current;
      const entryOwner = entry.state?.findOwner;
      const itemEntry = isItemPath(entry.pathname);
      const identityChanged = activateFindNavigation(current);
      if (identityChanged || (entryOwner && entryOwner !== nextOwner)) {
        const pathname = entry.pathname;
        // A return destination can contain the previous account's search even
        // when the current page is Settings or an invitation form. A newly
        // opened shared item has no owner and is authorized afresh by its API.
        const destination = itemEntry && !entryOwner ? pathname : pathname === "/find" || pathname === "/settings" ? pathname : "/";
        currentNavigate.current(destination, { replace: true, state: { findOwner: nextOwner } });
      } else if ((entry.pathname === "/find" || entry.pathname === "/settings" || itemEntry) && !entryOwner) {
        currentNavigate.current(entry.pathname + entry.search, { replace: true,
          state: { ...entry.state, findOwner: nextOwner } });
      }
      setMe(current);
      setLoginNotice("");
      setScreen("home");
    } catch (error) {
      if (requestId === authRequest.current) setScreen(error instanceof ApiError && error.status === 401 ? "login" : "error");
    }
  }, []);

  useEffect(() => {
    void bootstrap();
    return () => { authRequest.current++; };
  }, [bootstrap]);

  async function handleLogout() {
    const owner = captureSession();
    try {
      await logout();
      if (captureSession().epoch !== owner.epoch) return;
      invalidateSession();
      clearFindNavigation();
      authRequest.current++;
      useWorkspace.getState().reset();
      setMe(null); setError("");
      navigate("/", { replace: true });
      setScreen("login");
    } catch { if (captureSession().epoch === owner.epoch) setError("退出未成功，请检查连接后重试"); }
  }

  function sessionEnded(message: string) {
    // The event bus may already have ended this generation from the same 401.
    // Do not let an obsolete page callback replace its preserved destination.
    if (!captureSession().active) return;
    invalidateSession();
    clearFindNavigation();
    authRequest.current++;
    useWorkspace.getState().reset();
    setMe(null); setError(""); setLoginNotice(message);
    setScreen("login"); navigate("/", { replace: true });
  }

  function openSettings() { navigate("/settings", { state: { returnTo: location.pathname + location.search, findOwner: identity } }); }

  function changeFindView(view: FindView, replace = false, immediate = false) {
    navigate({ pathname: "/find", search: findSearch(view, location.search) }, { replace, flushSync: immediate, state: { findOwner: identity } });
  }

  useEffect(() => {
    if (screen !== "home" || location.pathname !== "/find" || initialAction) return;
    const canonical = findSearch(findView, foreignHistory ? "" : location.search);
    if (canonical !== location.search || navigation?.compartment || foreignHistory) navigate({ pathname: "/find", search: canonical }, { replace: true, state: { findOwner: identity } });
  }, [screen, location.pathname, location.search, navigation?.compartment, navigation?.findOwner, identity]);

  function consumeFindAction() {
    const parameters = new URLSearchParams(location.search);
    parameters.delete("capture"); parameters.delete("register");
    const view = readFindView(parameters.toString(), initialCompartment);
    navigate({ pathname: "/find", search: findSearch({ ...view, status: "active", page: 1 }) }, { replace: true, state: { findOwner: identity } });
  }

  async function enterJoinedHousehold() {
    const requestId = ++authRequest.current;
    const current = await getMe();
    if (requestId !== authRequest.current) return;
    activateSession();
    const identityChanged = activateFindNavigation(current);
    useWorkspace.getState().reset();
    setMe(current); setLoginNotice(""); setError(""); setScreen("home");
    const previousOwner = navigation?.findOwner;
    const externalItem = isItemPath(joinDestination) && !previousOwner;
    const staleOwner = Boolean(previousOwner && previousOwner !== findOwner(current));
    navigate(staleOwner || (identityChanged && !externalItem) ? "/" : joinDestination,
      { replace: true, state: { findOwner: findOwner(current) } });
  }

  if (screen === "loading") {
    return (
      <div className="loading-page">
        <Brand />
        <span className="loading-dot" />
      </div>
    );
  }

  if (screen === "setup") {
    return <SetupPage onDone={bootstrap} />;
  }

  if (screen === "login") {
    if (location.pathname === "/join") return <Suspense fallback={<div className="loading-page">正在打开加入页面…</div>}><JoinPage onDone={enterJoinedHousehold} onBack={() => navigate(joinDestination, { replace: true, state: { findOwner: navigation?.findOwner } })} /></Suspense>;
    return <LoginPage onDone={bootstrap} onJoin={() => navigate("/join", { state: {
      joinReturnTo: isItemPath(location.pathname) ? location.pathname : location.pathname + location.search,
      findOwner: navigation?.findOwner,
    } })} notice={loginNotice} />;
  }

  if (screen === "home" && me) {
    return <>{error && <div className="workspace-save-status error" role="alert">{error}<button onClick={() => void handleLogout()}>重试退出</button></div>}
      <Suspense fallback={<div className="loading-page">正在打开页面…</div>}><Routes>
        <Route path="/" element={<WorkspacePage key={`${identity}:${location.key}`} me={me} onLogout={handleLogout} onSettings={openSettings} target={foreignHistory ? undefined : navigation?.target} onInventory={id => navigate(id ? `/find?${new URLSearchParams({ compartment: id })}` : lastFindPath(me), { state: { findOwner: identity } })} />} />
        <Route path="/find" element={<InventoryPage key={`${me.household.id}:${me.user.id}`} me={me} onLogout={handleLogout} onSettings={openSettings} initialCompartment={findView.filter} initialAction={initialAction} onConsumedAction={consumeFindAction} navigation={{ view: findView, entry: location.key, onChange: changeFindView }} onArrange={target => navigate("/", { state: { target } })} />} />
        <Route path="/location/:containerId" element={<LocationRoute owner={identity} />} />
        <Route path="/items/:itemId" element={foreignHistory ? <Navigate to="/" replace state={{ findOwner: identity }} /> : <ItemRoute me={me} />} />
        <Route path="/settings" element={<SettingsPage me={me} onMeChanged={user => setMe(current => current && current.user.id === user.id ? { ...current, user } : current)} onSessionEnded={sessionEnded} returnLabel={settingsReturn === "/" ? "返回空间" : "返回找物"} onBack={() => navigate(settingsReturn, { state: { findOwner: identity } })} />} />
        <Route path="/join" element={<Navigate to={joinDestination} replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes></Suspense>
    </>;
  }

  return (
    <div className="loading-page">
      <Brand />
      <p>页面出了点问题，刷新试试。</p>
      <button className="primary-btn" type="button" onClick={() => void bootstrap()}>
        重试
      </button>
    </div>
  );
}

function ItemRoute({ me }: { me: MeResponse }) {
  const { itemId = "" } = useParams();
  const navigate = useNavigate();
  const owner = findOwner(me);
  return <ItemPage key={`${owner}:${itemId}`} itemId={itemId}
    onBack={() => navigate(lastFindPath(me), { replace: true, state: { findOwner: owner } })}
    onLocate={target => navigate("/", { state: { target, findOwner: owner } })} />;
}

function LocationRoute({ owner }: { owner?: string }) {
  const { containerId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const compartmentId = new URLSearchParams(location.search).get("compartment") ?? undefined;
  function openItems(id: string, action?: "register" | "capture") {
    const query = new URLSearchParams({ compartment: id });
    if (action) query.set(action, "1");
    navigate(`/find?${query}`, { state: { findOwner: owner } });
  }
  return <LocationPage key={`${containerId}:${compartmentId ?? ""}`} containerId={containerId} compartmentId={compartmentId}
    onViewItems={id => openItems(id)} onRegister={id => openItems(id, "register")} onCapture={id => openItems(id, "capture")} onBack={() => navigate("/")} />;
}
