import { Activity, ArrowRight, LockKeyhole, UserRound } from "lucide-react";
import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { ApiError } from "../lib/api";
import { navigate } from "../lib/router";

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(username, password);
      navigate("/", true);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "暂时无法连接监控核心");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-brand">
          <span className="brand-mark brand-mark-large"><Activity size={24} /></span>
          <div><strong>OmniDeck</strong><span>Unified Operations Console</span></div>
        </div>
        <div className="login-heading">
          <span className="environment-tag">PRIVATE OPERATIONS</span>
          <h1>登录监控控制台</h1>
          <p>使用管理员分配的账号继续。</p>
        </div>
        <form onSubmit={submit} className="login-form">
          <label>
            <span>用户名</span>
            <div className="input-with-icon"><UserRound size={17} /><input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required autoFocus /></div>
          </label>
          <label>
            <span>密码</span>
            <div className="input-with-icon"><LockKeyhole size={17} /><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
          </label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <button className="primary-button login-button" disabled={busy}>
            {busy ? "正在验证" : "登录"}<ArrowRight size={17} />
          </button>
        </form>
        <footer className="login-footer"><span className="status-dot" />受保护的管理入口</footer>
      </section>
      <aside className="login-aside" aria-hidden="true">
        <div className="signal-grid">
          {Array.from({ length: 48 }, (_, index) => <i key={index} style={{ opacity: 0.16 + ((index * 7) % 10) / 16 }} />)}
        </div>
        <div className="login-aside-copy">
          <Activity size={30} />
          <strong>Measure every route.</strong>
          <span>Infrastructure, public edges, FRP links and AI upstreams in one operational view.</span>
        </div>
      </aside>
    </main>
  );
}
