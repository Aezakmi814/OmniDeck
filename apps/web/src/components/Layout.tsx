import {
  Activity,
  Bell,
  Bot,
  ChevronDown,
  Gauge,
  Globe2,
  LogOut,
  Menu,
  Server,
  Settings,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { AppLink, navigate, usePath } from "../lib/router";

const navigation = [
  { href: "/", label: "系统总览", icon: Gauge },
  { href: "/alerts", label: "告警事件", icon: Bell },
  { href: "/nodes", label: "基础设施", icon: Server },
  { href: "/endpoints", label: "公网入口", icon: Globe2 },
  { href: "/ai-targets", label: "AI 上游", icon: Bot },
];

const adminNavigation = [
  { href: "/users", label: "用户权限", icon: Users },
  { href: "/settings", label: "系统设置", icon: Settings },
];

const pageTitles: Record<string, string> = {
  "/": "系统总览",
  "/alerts": "告警事件",
  "/nodes": "基础设施",
  "/endpoints": "公网入口",
  "/ai-targets": "AI 上游",
  "/users": "用户权限",
  "/settings": "系统设置",
};

export function Layout({ children }: { children: React.ReactNode }) {
  const path = usePath();
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const items = user?.role === "admin" ? [...navigation, ...adminNavigation] : navigation;

  async function signOut() {
    await logout();
    navigate("/login", true);
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <span className="brand-mark"><Activity size={20} /></span>
          <span><strong>SysFNOS</strong><small>Operations</small></span>
          <button className="sidebar-close" onClick={() => setMenuOpen(false)} title="关闭菜单"><X size={19} /></button>
        </div>
        <nav className="sidebar-nav" aria-label="主导航">
          {items.map(({ href, label, icon: Icon }) => (
            <AppLink
              key={href}
              href={href}
              className={path === href ? "nav-item nav-item-active" : "nav-item"}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{label}</span>
            </AppLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="live-indicator"><span />监控核心运行中</span>
          <a className="grafana-link" href="/grafana/" target="_blank" rel="noreferrer">
            打开 Grafana
          </a>
        </div>
      </aside>
      {menuOpen && <button className="sidebar-scrim" aria-label="关闭菜单" onClick={() => setMenuOpen(false)} />}

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-title">
            <button className="mobile-menu" onClick={() => setMenuOpen(true)} title="打开菜单"><Menu size={20} /></button>
            <div>
              <span>控制台</span>
              <h1>{pageTitles[path] ?? "SysFNOS"}</h1>
            </div>
          </div>
          <div className="account-wrap">
            <button className="account-button" onClick={() => setAccountOpen((value) => !value)}>
              <span className="avatar">{user?.displayName.slice(0, 1).toUpperCase()}</span>
              <span className="account-copy"><strong>{user?.displayName}</strong><small>{user?.role === "admin" ? "管理员" : "查看者"}</small></span>
              <ChevronDown size={16} />
            </button>
            {accountOpen && (
              <div className="account-menu">
                <button onClick={() => void signOut()}><LogOut size={16} />退出登录</button>
              </div>
            )}
          </div>
        </header>
        <div className="page-content">{children}</div>
      </main>
    </div>
  );
}
