import { Copy, Cpu, HardDrive, KeyRound, Laptop, MemoryStick, Pencil, Plus, Server, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "../components/Modal";
import { EmptyState, Status } from "../components/Status";
import { useAuth } from "../contexts/AuthContext";
import { api, json } from "../lib/api";
import { formatBytes, formatDuration, timeAgo } from "../lib/format";
import type { NodeItem } from "../types";

const emptyForm = {
  name: "", platform: "windows", kind: "laptop", alertOnOffline: false, offlineAfterSeconds: 180,
};

export function NodesPage() {
  const { user } = useAuth();
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<NodeItem | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [token, setToken] = useState("");
  const [tokenMode, setTokenMode] = useState<"create" | "rotate">("create");
  const [busy, setBusy] = useState(false);

  async function load() {
    const response = await api<{ nodes: NodeItem[] }>("/api/nodes");
    setNodes(response.nodes);
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(timer); }, []);

  function openCreate() {
    setEditing(null); setForm(emptyForm); setToken(""); setTokenMode("create"); setModalOpen(true);
  }
  function openEdit(node: NodeItem) {
    setEditing(node);
    setForm({ name: node.name, platform: node.platform, kind: node.kind, alertOnOffline: node.alertOnOffline, offlineAfterSeconds: node.offlineAfterSeconds });
    setToken(""); setModalOpen(true);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      if (editing) {
        await api(`/api/nodes/${editing.id}`, json("PATCH", form));
        setModalOpen(false);
      } else {
        const response = await api<{ enrollmentToken: string }>("/api/nodes", json("POST", { ...form, labels: {} }));
        setTokenMode("create"); setToken(response.enrollmentToken);
      }
      await load();
    } finally { setBusy(false); }
  }

  async function rotate(node: NodeItem) {
    if (!window.confirm(`轮换“${node.name}”的节点令牌？现有代理会立即停止上报，必须执行新安装命令才能恢复。`)) return;
    const response = await api<{ enrollmentToken: string }>(`/api/nodes/${node.id}/rotate-token`, json("POST"));
    openEdit(node); setTokenMode("rotate"); setToken(response.enrollmentToken);
  }

  async function remove(node: NodeItem) {
    if (!window.confirm(`删除节点“${node.name}”及其历史指标？`)) return;
    await api(`/api/nodes/${node.id}`, json("DELETE")); await load();
  }

  const installCommand = form.platform === "windows"
    ? `$agent = Join-Path $env:TEMP 'sysfnos-agent.exe'; Invoke-WebRequest '${window.location.origin}/downloads/sysfnos-agent-windows-amd64.exe' -OutFile $agent; & $agent install --server '${window.location.origin}' --token '${token}'`
    : `curl -fsSL '${window.location.origin}/downloads/sysfnos-agent-linux-amd64' -o /tmp/sysfnos-agent && chmod +x /tmp/sysfnos-agent && sudo /tmp/sysfnos-agent install --server '${window.location.origin}' --token '${token}'`;

  return (
    <div className="page-stack">
      <div className="page-actions"><div><span className="eyebrow">INVENTORY</span><p className="page-summary">服务器、NAS、笔记本与按需虚拟机</p></div>{user?.role === "admin" && <button className="primary-button" onClick={openCreate}><Plus size={17} />添加节点</button>}</div>
      {nodes.length ? <section className="node-grid">
        {nodes.map((node) => {
          const memoryPercent = node.latest?.memoryTotalBytes ? node.latest.memoryUsedBytes / node.latest.memoryTotalBytes * 100 : 0;
          const disk = node.latest?.disks[0];
          const diskPercent = disk?.totalBytes ? disk.usedBytes / disk.totalBytes * 100 : 0;
          return <article className="node-card" key={node.id}>
            <header><span className="node-type-icon">{node.kind === "laptop" ? <Laptop size={20} /> : <Server size={20} />}</span><div><strong>{node.name}</strong><span>{node.platform} · {node.kind}</span></div><Status good={node.online} muted={!node.enabled} label={!node.enabled ? "停用" : node.online ? "在线" : "离线"} /></header>
            <div className="metric-list">
              <div><span><Cpu size={15} />CPU</span><strong>{node.latest ? `${node.latest.cpuPercent.toFixed(1)}%` : "-"}</strong><i><b style={{ width: `${node.latest?.cpuPercent ?? 0}%` }} /></i></div>
              <div><span><MemoryStick size={15} />内存</span><strong>{node.latest ? `${formatBytes(node.latest.memoryUsedBytes)} / ${formatBytes(node.latest.memoryTotalBytes)}` : "-"}</strong><i><b style={{ width: `${memoryPercent}%` }} /></i></div>
              <div><span><HardDrive size={15} />磁盘</span><strong>{disk ? `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}` : "-"}</strong><i><b style={{ width: `${diskPercent}%` }} /></i></div>
            </div>
            <footer><span>上次上报 {timeAgo(node.lastSeenAt)}</span><span>运行 {formatDuration(node.latest?.uptimeSeconds)}</span>{user?.role === "admin" && <div className="row-actions"><button className="icon-button" onClick={() => openEdit(node)} title="编辑"><Pencil size={16} /></button><button className="icon-button" onClick={() => void rotate(node)} title="轮换节点令牌（会使现有代理离线）"><KeyRound size={16} /></button><button className="icon-button danger" onClick={() => void remove(node)} title="删除"><Trash2 size={16} /></button></div>}</footer>
          </article>;
        })}
      </section> : <section className="content-band"><EmptyState title="尚未添加节点" detail="添加 NAS、云服务器或 Windows 电脑开始采集资源指标" /></section>}

      <Modal open={modalOpen} title={editing ? `编辑 ${editing.name}` : "添加监控节点"} onClose={() => setModalOpen(false)} wide={Boolean(token)}>
        {token ? <div className="token-panel"><span className="success-mark">{tokenMode === "rotate" ? "节点令牌已轮换" : "注册令牌已生成"}</span><p>{tokenMode === "rotate" ? "旧代理已经失效。请在目标设备重新执行安装命令。" : "令牌只显示一次。完成安装前不要关闭此窗口。"}</p><div className="secret-output"><code>{token}</code><button className="icon-button" onClick={() => void navigator.clipboard.writeText(token)} title="复制令牌"><Copy size={16} /></button></div><label><span>安装命令</span><div className="command-output"><code>{installCommand}</code><button className="icon-button" onClick={() => void navigator.clipboard.writeText(installCommand)} title="复制命令"><Copy size={16} /></button></div></label><div className="modal-actions"><button className="primary-button" onClick={() => setModalOpen(false)}>完成</button></div></div> :
          <form onSubmit={save} className="form-grid">
            <label className="field-span"><span>节点名称</span><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required placeholder="例如：哈尔滨 FNOS" /></label>
            <label><span>操作系统</span><select value={form.platform} onChange={(event) => setForm({ ...form, platform: event.target.value })}><option value="windows">Windows</option><option value="linux">Linux</option><option value="unknown">其他</option></select></label>
            <label><span>设备类型</span><select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value })}><option value="server">服务器</option><option value="nas">NAS</option><option value="laptop">笔记本</option><option value="vm">虚拟机</option></select></label>
            <label><span>离线阈值（秒）</span><input type="number" min="60" value={form.offlineAfterSeconds} onChange={(event) => setForm({ ...form, offlineAfterSeconds: Number(event.target.value) })} /></label>
            <label className="switch-field"><input type="checkbox" checked={form.alertOnOffline} onChange={(event) => setForm({ ...form, alertOnOffline: event.target.checked })} /><span>离线时发送告警</span></label>
            <div className="modal-actions field-span"><button type="button" className="secondary-button" onClick={() => setModalOpen(false)}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中" : editing ? "保存" : "创建并生成令牌"}</button></div>
          </form>}
      </Modal>
    </div>
  );
}
