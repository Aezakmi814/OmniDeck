import { Activity, Bot, CircleAlert, Clock3, RefreshCw, Server } from "lucide-react";
import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { EmptyState, Status } from "../components/Status";
import { api } from "../lib/api";
import { formatDate, formatLatency } from "../lib/format";

interface Dashboard {
  summary: {
    nodes: { total: number; online: number };
    endpoints: { total: number; healthy: number };
    aiTargets: { total: number; healthy: number; avg_ttft: number | null };
    openAlerts: number;
  };
  recentChecks: Array<{
    type: "endpoint" | "ai";
    id: string;
    name: string;
    checked_at: string;
    success: number;
    status_code: number | null;
    ttfb_ms: number | null;
    total_ms: number | null;
    error: string | null;
    location: string;
  }>;
  latency: Array<{ time: string; endpointTtfb?: number; aiTtft?: number }>;
}

export function OverviewPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try { setData(await api<Dashboard>("/api/dashboard")); } finally { setLoading(false); }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const summary = data?.summary;
  const chartData = data?.latency.map((point) => ({
    ...point,
    label: new Date(point.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
  })) ?? [];

  return (
    <div className="page-stack">
      <div className="page-actions">
        <div><span className="eyebrow">最近 24 小时</span><p className="page-summary">关键服务、节点和流式请求的实时运行状态</p></div>
        <button className="icon-button bordered" onClick={() => void load()} disabled={loading} title="刷新">
          <RefreshCw size={17} className={loading ? "spin" : ""} />
        </button>
      </div>

      <section className="stat-grid">
        <article className="stat-item">
          <span className="stat-icon stat-icon-green"><Activity size={19} /></span>
          <div><small>公网入口</small><strong>{summary ? `${summary.endpoints.healthy}/${summary.endpoints.total}` : "-"}</strong><span>健康目标</span></div>
        </article>
        <article className="stat-item">
          <span className="stat-icon stat-icon-blue"><Server size={19} /></span>
          <div><small>在线节点</small><strong>{summary ? `${summary.nodes.online}/${summary.nodes.total}` : "-"}</strong><span>最近上报</span></div>
        </article>
        <article className="stat-item">
          <span className="stat-icon stat-icon-cyan"><Clock3 size={19} /></span>
          <div><small>AI 平均首包</small><strong>{formatLatency(summary?.aiTargets.avg_ttft)}</strong><span>{summary ? `${summary.aiTargets.healthy}/${summary.aiTargets.total} 正常` : "等待数据"}</span></div>
        </article>
        <article className="stat-item">
          <span className={`stat-icon ${summary?.openAlerts ? "stat-icon-red" : "stat-icon-gray"}`}><CircleAlert size={19} /></span>
          <div><small>未恢复告警</small><strong>{summary?.openAlerts ?? "-"}</strong><span>{summary?.openAlerts ? "需要处理" : "当前无告警"}</span></div>
        </article>
      </section>

      <section className="content-band">
        <header className="section-header"><div><h2>链路延迟</h2><span>公网 TTFB 与 AI 流式首包</span></div><span className="legend"><i className="legend-blue" />公网入口<i className="legend-green" />AI 上游</span></header>
        <div className="chart-shell">
          {chartData.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 12, right: 18, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="#e8eaed" vertical={false} />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#7b818a", fontSize: 11 }} minTickGap={30} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: "#7b818a", fontSize: 11 }} unit=" ms" width={62} />
                <Tooltip contentStyle={{ border: "1px solid #dfe2e6", borderRadius: 6, boxShadow: "0 8px 24px rgba(25,28,33,.1)", fontSize: 12 }} />
                <Line type="monotone" dataKey="endpointTtfb" name="公网 TTFB" stroke="#2563eb" strokeWidth={2} dot={false} connectNulls />
                <Line type="monotone" dataKey="aiTtft" name="AI 首包" stroke="#0f9f6e" strokeWidth={2} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          ) : <EmptyState title="等待监控数据" detail="创建公网入口或 AI 上游后将显示延迟趋势" />}
        </div>
      </section>

      <section className="content-band">
        <header className="section-header"><div><h2>最近探测</h2><span>按时间倒序</span></div></header>
        {data?.recentChecks.length ? (
          <div className="table-wrap"><table><thead><tr><th>目标</th><th>探测节点</th><th>类型</th><th>状态</th><th>首包</th><th>总耗时</th><th>时间</th></tr></thead><tbody>
            {data.recentChecks.map((check, index) => (
              <tr key={`${check.type}-${check.id}-${check.checked_at}-${index}`}>
                <td><div className="table-primary">{check.type === "ai" ? <Bot size={16} /> : <Activity size={16} />}<span>{check.name}</span></div></td>
                <td>{check.location}</td><td>{check.type === "ai" ? "AI 流式" : "HTTP"}</td>
                <td><Status good={Boolean(check.success)} label={check.success ? "正常" : "失败"} /></td>
                <td>{formatLatency(check.ttfb_ms)}</td><td>{formatLatency(check.total_ms)}</td><td>{formatDate(check.checked_at)}</td>
              </tr>
            ))}
          </tbody></table></div>
        ) : <EmptyState title="暂无探测记录" detail="监控任务执行后会显示在这里" />}
      </section>
    </div>
  );
}
