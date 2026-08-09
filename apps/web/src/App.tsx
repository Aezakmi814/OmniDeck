import { useEffect } from "react";
import { Layout } from "./components/Layout";
import { useAuth } from "./contexts/AuthContext";
import { navigate, usePath } from "./lib/router";
import { AiTargetsPage } from "./pages/AiTargetsPage";
import { AlertsPage } from "./pages/AlertsPage";
import { EndpointsPage } from "./pages/EndpointsPage";
import { LoginPage } from "./pages/LoginPage";
import { NodesPage } from "./pages/NodesPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { UsersPage } from "./pages/UsersPage";

const knownPaths = new Set(["/", "/alerts", "/notifications", "/nodes", "/endpoints", "/ai-targets", "/users", "/settings", "/login"]);

export default function App() {
  const path = usePath();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user && path !== "/login") navigate("/login", true);
    if (user && path === "/login") navigate(user.mustChangePassword ? "/settings" : "/", true);
    if (user?.mustChangePassword && path !== "/settings") navigate("/settings", true);
    if (!knownPaths.has(path)) navigate(user ? "/" : "/login", true);
    if (user && user.role !== "admin" && (path === "/users" || path === "/settings") && !user.mustChangePassword) navigate("/", true);
  }, [loading, path, user]);

  if (loading) return <div className="app-loading"><span className="loading-pulse" /><strong>OmniDeck</strong></div>;
  if (!user) return <LoginPage />;

  let page: React.ReactNode;
  switch (path) {
    case "/alerts": page = <AlertsPage />; break;
    case "/notifications": page = <NotificationsPage />; break;
    case "/nodes": page = <NodesPage />; break;
    case "/endpoints": page = <EndpointsPage />; break;
    case "/ai-targets": page = <AiTargetsPage />; break;
    case "/users": page = <UsersPage />; break;
    case "/settings": page = <SettingsPage />; break;
    default: page = <OverviewPage />;
  }
  return <Layout>{page}</Layout>;
}
