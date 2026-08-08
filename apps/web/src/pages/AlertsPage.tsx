import { AlertTriangle, CheckCircle2, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, Status } from "../components/Status";
import { api } from "../lib/api";
import { formatDate } from "../lib/format";
import type { AlertItem } from "../types";

export function AlertsPage() {
  const [items, setItems] = useState<AlertItem[]>([]);
  const [filter, setFilter] = useState("all");
  async function load(status = filter) { setItems((await api<{ alerts: AlertItem[] }>(`/api/alerts?status=${status}`)).alerts); }
  useEffect(() => { void load(filter); }, [filter]);
  return <div className="page-stack"><div className="page-actions"><div><span className="eyebrow">INCIDENTS</span><p className="page-summary">连续失败、节点离线与恢复记录</p></div><div className="segmented"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部</button><button className={filter === "open" ? "active" : ""} onClick={() => setFilter("open")}>处理中</button><button className={filter === "resolved" ? "active" : ""} onClick={() => setFilter("resolved")}>已恢复</button></div></div><section className="content-band">{items.length ? <div className="incident-list">{items.map((item) => <article key={item.id}><span className={`incident-icon ${item.status}`}>{item.status === "open" ? <AlertTriangle size={19} /> : <CheckCircle2 size={19} />}</span><div><header><strong>{item.title}</strong><Status good={item.status === "resolved"} label={item.status === "open" ? "处理中" : "已恢复"} /></header><p>{item.message}</p><footer><span>{item.source_type}</span><span>发生 {formatDate(item.opened_at)}</span>{item.resolved_at && <span>恢复 {formatDate(item.resolved_at)}</span>}</footer></div></article>)}</div> : <EmptyState title="没有告警记录" detail="连续两次探测失败后将创建告警事件" />}</section></div>;
}
