import { ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "../components/Modal";
import { EmptyState, Status } from "../components/Status";
import { useAuth } from "../contexts/AuthContext";
import { api, json } from "../lib/api";
import { formatDate, formatLatency } from "../lib/format";
import type { EndpointItem, NodeItem } from "../types";

const emptyForm = { name: "", url: "", method: "GET", expectedStatus: 200, timeoutSeconds: 15, intervalSeconds: 30, enabled: true, verifyTls: true, probeNodeIds: [] as string[] };

export function EndpointsPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<EndpointItem[]>([]);
  const [nodes, setNodes] = useState<NodeItem[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<EndpointItem | null>(null);
  const [open, setOpen] = useState(false);
  async function load() {
    const [endpoints, nodeList] = await Promise.all([
      api<{ endpoints: EndpointItem[] }>("/api/endpoints"), api<{ nodes: NodeItem[] }>("/api/nodes"),
    ]);
    setItems(endpoints.endpoints); setNodes(nodeList.nodes);
  }
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(timer); }, []);
  function create() { setEditing(null); setForm(emptyForm); setOpen(true); }
  function edit(item: EndpointItem) { setEditing(item); setForm({ name: item.name, url: item.url, method: item.method, expectedStatus: item.expectedStatus, timeoutSeconds: item.timeoutSeconds, intervalSeconds: item.intervalSeconds, enabled: item.enabled, verifyTls: item.verifyTls, probeNodeIds: item.probeNodeIds }); setOpen(true); }
  async function save(event: React.FormEvent) { event.preventDefault(); await api(editing ? `/api/endpoints/${editing.id}` : "/api/endpoints", json(editing ? "PATCH" : "POST", { ...form, headers: {} })); setOpen(false); await load(); }
  async function remove(item: EndpointItem) { if (!window.confirm(`删除监控项“${item.name}”？`)) return; await api(`/api/endpoints/${item.id}`, json("DELETE")); await load(); }
  return <div className="page-stack">
    <div className="page-actions"><div><span className="eyebrow">HTTP / TLS</span><p className="page-summary">公网域名、边缘入口与证书可用性</p></div>{user?.role === "admin" && <button className="primary-button" onClick={create}><Plus size={17} />添加入口</button>}</div>
    <section className="content-band">
      {items.length ? <div className="table-wrap"><table><thead><tr><th>名称</th><th>状态</th><th>HTTP</th><th>首包</th><th>总耗时</th><th>最近探测</th>{user?.role === "admin" && <th />}</tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><div className="target-name"><strong>{item.name}</strong><a href={item.url} target="_blank" rel="noreferrer">{item.url}<ExternalLink size={12} /></a></div></td><td><Status good={Boolean(item.latest?.success)} muted={!item.enabled} label={!item.enabled ? "停用" : item.latest?.success ? "正常" : item.latest ? "失败" : "等待"} /></td><td>{item.latest?.statusCode ?? "-"}</td><td>{formatLatency(item.latest?.ttfbMs)}</td><td>{formatLatency(item.latest?.totalMs)}</td><td>{formatDate(item.latest?.checkedAt)}</td>{user?.role === "admin" && <td><div className="row-actions"><button className="icon-button" onClick={() => edit(item)} title="编辑"><Pencil size={16} /></button><button className="icon-button danger" onClick={() => void remove(item)} title="删除"><Trash2 size={16} /></button></div></td>}</tr>)}</tbody></table></div> : <EmptyState title="暂无公网入口" detail="添加 cxcapi、FNOS 或区域中转域名开始探测" />}
    </section>
    <Modal open={open} title={editing ? "编辑公网入口" : "添加公网入口"} onClose={() => setOpen(false)}><form className="form-grid" onSubmit={save}><label className="field-span"><span>名称</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label><label className="field-span"><span>URL</span><input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://api.example.com/health" required /></label><label><span>方法</span><select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}><option>GET</option><option>HEAD</option></select></label><label><span>预期状态码</span><input type="number" value={form.expectedStatus} onChange={(e) => setForm({ ...form, expectedStatus: Number(e.target.value) })} /></label><label><span>频率（秒）</span><input type="number" min="10" value={form.intervalSeconds} onChange={(e) => setForm({ ...form, intervalSeconds: Number(e.target.value) })} /></label><label><span>超时（秒）</span><input type="number" min="2" value={form.timeoutSeconds} onChange={(e) => setForm({ ...form, timeoutSeconds: Number(e.target.value) })} /></label><div className="field-span probe-selector"><span>分布式探测节点</span><div><label className="probe-option fixed"><input type="checkbox" checked readOnly /><span>监控核心</span><small>始终启用</small></label>{nodes.map((node) => <label className="probe-option" key={node.id}><input type="checkbox" checked={form.probeNodeIds.includes(node.id)} onChange={(event) => setForm({ ...form, probeNodeIds: event.target.checked ? [...form.probeNodeIds, node.id] : form.probeNodeIds.filter((id) => id !== node.id) })} /><span>{node.name}</span><small>{node.online ? "在线" : "离线"}</small></label>)}</div></div><label className="switch-field field-span"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /><span>启用监控</span></label><div className="modal-actions field-span"><button type="button" className="secondary-button" onClick={() => setOpen(false)}>取消</button><button className="primary-button">保存</button></div></form></Modal>
  </div>;
}
