import {
  BadgeDollarSign,
  Boxes,
  ChartNoAxesCombined,
  CircleCheck,
  Database,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Modal } from "../components/Modal";
import { EmptyState, Status } from "../components/Status";
import { useAuth } from "../contexts/AuthContext";
import { api, json } from "../lib/api";
import { formatDate } from "../lib/format";

interface MarketProduct {
  id: string;
  canonicalKey: string;
  externalId: string | null;
  slug: string | null;
  name: string;
  platform: string;
  productType: string;
  spec: string | null;
  summary: string | null;
  offerCount: number;
  inStockCount: number;
  lowestPriceMinor: number | null;
  currency: string;
  latestSeenAt: string | null;
  snapshotGeneratedAt: string | null;
  lowestOffer: { storeName: string | null; title: string; url: string; stockCount: number | null } | null;
}

interface MarketWatch {
  id: string;
  productId: string;
  targetPriceMinor: number;
  currency: string;
  enabled: boolean;
  state: "waiting" | "met" | "unknown";
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  product: MarketProduct;
}

interface MarketDashboard {
  source: {
    id: string;
    name: string;
    status: "pending" | "healthy" | "stale" | "error";
    stale: boolean;
    partial: boolean;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastSnapshotId: string | null;
    lastPublishedAt: string | null;
    lastError: string | null;
    nextPollAt: string;
  } | null;
  summary: { catalogProducts: number; watchedProducts: number; targetsMet: number; inStockOffers: number };
  watches: MarketWatch[];
  catalog: MarketProduct[];
  coverage: { kind: "partial"; label: string; detail: string };
}

interface ProductDetail {
  product: MarketProduct;
  offers: Array<{
    id: string;
    sourceId: string | null;
    sourceName: string;
    storeName: string;
    title: string;
    priceMinor: number;
    currency: string;
    status: string;
    available: boolean;
    stockCount: number | null;
    minOrderQuantity: number | null;
    url: string;
    capturedAt: string | null;
    expiresAt: string | null;
  }>;
  points: Array<{
    time: string;
    lowestPriceMinor: number | null;
    visibleMedianPriceMinor: number | null;
    inStockCount: number;
    offerCount: number;
    stale: boolean;
    partial: boolean;
  }>;
  watch: MarketWatch | null;
  coverage: "partial";
}

function money(value: number | null | undefined, currency = "CNY") {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value / 100);
}

function sourceState(source: MarketDashboard["source"]) {
  if (!source || source.status === "pending") return { good: false, muted: true, label: "等待首次同步" };
  if (source.status === "healthy") return { good: true, muted: false, label: "数据源正常" };
  if (source.status === "stale") return { good: false, muted: false, label: "数据已过期" };
  return { good: false, muted: false, label: "同步失败" };
}

const emptyForm = { productId: "", targetPrice: "", enabled: true };

export function MarketPage() {
  const { user } = useAuth();
  const [dashboard, setDashboard] = useState<MarketDashboard | null>(null);
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<MarketWatch | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState("");
  const detailRequest = useRef(0);

  async function loadDashboard() {
    setLoading(true);
    try {
      const result = await api<MarketDashboard>(`/api/market/dashboard?days=${days}`);
      setDashboard(result);
      setSelectedProductId((current) => current || result.watches[0]?.productId || result.catalog[0]?.id || "");
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "市场数据加载失败");
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(productId = selectedProductId) {
    const requestId = ++detailRequest.current;
    if (!productId) { setDetail(null); return; }
    setDetailLoading(true);
    try {
      const result = await api<ProductDetail>(`/api/market/products/${productId}/history?days=${days}`);
      if (requestId === detailRequest.current) setDetail(result);
    } catch (loadError) {
      if (requestId === detailRequest.current) setError(loadError instanceof Error ? loadError.message : "商品趋势加载失败");
    } finally {
      if (requestId === detailRequest.current) setDetailLoading(false);
    }
  }

  useEffect(() => {
    void loadDashboard();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadDashboard();
      void loadDetail(selectedProductId);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [selectedProductId, days]);

  useEffect(() => { void loadDetail(); }, [selectedProductId, days]);

  async function sync() {
    setSyncing(true);
    try {
      await api("/api/market/sync", json("POST"));
      await loadDashboard();
      await loadDetail();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "同步失败");
    } finally {
      setSyncing(false);
    }
  }

  function openCreate(product?: MarketProduct) {
    setEditing(null);
    setForm({ ...emptyForm, productId: product?.id ?? selectedProductId });
    setFormOpen(true);
  }

  function openEdit(watch: MarketWatch) {
    setEditing(watch);
    setForm({ productId: watch.productId, targetPrice: String(watch.targetPriceMinor / 100), enabled: watch.enabled });
    setFormOpen(true);
  }

  async function saveWatch(event: React.FormEvent) {
    event.preventDefault();
    const targetPriceMinor = Math.round(Number(form.targetPrice) * 100);
    if (!Number.isFinite(targetPriceMinor) || targetPriceMinor <= 0) {
      setError("目标价格必须大于 0");
      return;
    }
    try {
      if (editing) {
        await api(`/api/market/watches/${editing.id}`, json("PATCH", { targetPriceMinor, enabled: form.enabled }));
      } else {
        await api("/api/market/watches", json("POST", {
          productId: form.productId,
          targetPriceMinor,
          currency: "CNY",
          enabled: form.enabled,
        }));
      }
      setFormOpen(false);
      setEditing(null);
      await loadDashboard();
      setSelectedProductId(form.productId);
      await loadDetail(form.productId);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "采购目标保存失败");
    }
  }

  async function removeWatch(watch: MarketWatch) {
    if (!window.confirm(`删除“${watch.product.name}”的采购目标？`)) return;
    try {
      await api(`/api/market/watches/${watch.id}`, json("DELETE"));
      await loadDashboard();
      await loadDetail();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "采购目标删除失败");
    }
  }

  const watchedIds = new Set(dashboard?.watches.map((watch) => watch.productId));
  const selectedWatch = dashboard?.watches.find((watch) => watch.productId === selectedProductId) ?? null;
  const chartData = detail?.points.filter((point) => !point.stale).map((point) => ({
    ...point,
    lowestPrice: point.lowestPriceMinor === null ? null : point.lowestPriceMinor / 100,
    visibleMedianPrice: point.visibleMedianPriceMinor === null ? null : point.visibleMedianPriceMinor / 100,
    label: new Date(point.time).toLocaleString("zh-CN", days === 1
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "2-digit", day: "2-digit", hour: "2-digit" }),
  })) ?? [];
  const state = sourceState(dashboard?.source ?? null);

  return (
    <div className="page-stack market-page">
      <div className="page-actions">
        <div><span className="eyebrow">Market intelligence</span><p className="page-summary">采购目标、可见报价与库存趋势</p></div>
        <div className="market-page-buttons">
          {user?.role === "admin" && <button className="secondary-button" onClick={() => void sync()} disabled={syncing}><RefreshCw size={16} className={syncing ? "spin" : ""} />同步市场</button>}
          <button className="primary-button" onClick={() => openCreate()} disabled={!dashboard?.catalog.length}><Plus size={16} />添加采购目标</button>
        </div>
      </div>

      {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}>关闭</button></div>}

      <section className="stat-grid">
        <article className="stat-item"><span className="stat-icon stat-icon-green"><ShoppingCart size={19} /></span><div><small>采购目标</small><strong>{dashboard?.summary.watchedProducts ?? "-"}</strong><span>最多 10 个</span></div></article>
        <article className="stat-item"><span className="stat-icon stat-icon-red"><BadgeDollarSign size={19} /></span><div><small>目标已达成</small><strong>{dashboard?.summary.targetsMet ?? "-"}</strong><span>有货且低于目标价</span></div></article>
        <article className="stat-item"><span className="stat-icon stat-icon-blue"><Boxes size={19} /></span><div><small>当前有货报价</small><strong>{dashboard?.summary.inStockOffers ?? "-"}</strong><span>来源聚合数量</span></div></article>
        <article className="stat-item"><span className="stat-icon stat-icon-cyan"><Database size={19} /></span><div><small>标准商品</small><strong>{dashboard?.summary.catalogProducts ?? "-"}</strong><span>PriceAI 公共快照</span></div></article>
      </section>

      <div className={`market-source-strip ${dashboard?.source?.status ?? "pending"}`}>
        <div><Status good={state.good} muted={state.muted} label={state.label} /><strong>{dashboard?.source?.name ?? "PriceAI 公共价格雷达"}</strong></div>
        <span>{dashboard?.coverage.detail ?? "等待首次同步"}</span>
        <time>{dashboard?.source?.lastPublishedAt ? `快照 ${formatDate(dashboard.source.lastPublishedAt)}` : "尚无快照"}</time>
      </div>

      <div className="market-main-grid">
        <section className="content-band market-chart-band">
          <header className="section-header market-chart-header">
            <div><h2>价格与库存趋势</h2><span>最低有货价、可见 Top 报价中位线与市场库存</span></div>
            <div className="market-chart-controls">
              <select aria-label="趋势商品" value={selectedProductId} onChange={(event) => setSelectedProductId(event.target.value)}>
                {dashboard?.catalog.map((product) => <option key={product.id} value={product.id}>{product.platform} · {product.name}</option>)}
              </select>
              <div className="segmented" aria-label="趋势周期">
                {[1, 7, 30, 90].map((value) => <button key={value} aria-pressed={days === value} className={days === value ? "active" : ""} onClick={() => setDays(value)}>{value === 1 ? "24h" : `${value}天`}</button>)}
              </div>
            </div>
          </header>
          <div className="market-chart-summary">
            <div><span>当前最低</span><strong>{money(detail?.product.lowestPriceMinor, detail?.product.currency)}</strong></div>
            <div><span>目标价格</span><strong>{selectedWatch ? money(selectedWatch.targetPriceMinor, selectedWatch.currency) : "未设置"}</strong></div>
            <div><span>有货报价</span><strong>{detail?.product.inStockCount ?? "-"}</strong></div>
            <div><span>可见店铺</span><strong>{detail?.offers.filter((offer) => offer.available).length ?? "-"}</strong></div>
          </div>
          <div className="market-chart-shell">
            {detailLoading ? <div className="market-chart-loading"><RefreshCw className="spin" size={20} />加载趋势</div> : chartData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 18, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="#e8eaed" vertical={false} />
                  <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#7b818a", fontSize: 10 }} minTickGap={34} />
                  <YAxis yAxisId="price" axisLine={false} tickLine={false} tick={{ fill: "#7b818a", fontSize: 10 }} width={58} tickFormatter={(value) => `¥${value}`} />
                  <YAxis yAxisId="stock" orientation="right" axisLine={false} tickLine={false} tick={{ fill: "#7b818a", fontSize: 10 }} width={42} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ border: "1px solid #dfe2e6", borderRadius: 6, boxShadow: "0 8px 24px rgba(25,28,33,.1)", fontSize: 12 }}
                    formatter={(value, name) => name === "有货报价" ? [String(value), name] : [`¥${Number(value).toFixed(2)}`, name]}
                  />
                  <Area yAxisId="price" type="monotone" dataKey="lowestPrice" name="最低有货价" stroke="#087f5b" strokeWidth={2.4} fill="#dff3eb" connectNulls />
                  <Line yAxisId="price" type="monotone" dataKey="visibleMedianPrice" name="可见 Top 中位价" stroke="#a85c00" strokeWidth={1.8} dot={false} connectNulls />
                  <Bar yAxisId="stock" dataKey="inStockCount" name="有货报价" fill="#8fb3e8" opacity={0.48} barSize={days > 30 ? 4 : 8} />
                  {selectedWatch && <ReferenceLine yAxisId="price" y={selectedWatch.targetPriceMinor / 100} stroke="#c43131" strokeDasharray="5 4" label={{ value: "目标价", fill: "#c43131", fontSize: 10, position: "insideTopRight" }} />}
                </ComposedChart>
              </ResponsiveContainer>
            ) : <EmptyState title="等待价格历史" detail="首次同步后会开始记录真实行情，不使用演示数据" />}
          </div>
          <footer className="market-chart-note"><ChartNoAxesCombined size={14} />中位线只统计公共 Feed 当前可见的 Top 报价；过期快照不会进入曲线。</footer>
        </section>

        <section className="content-band market-watch-band">
          <header className="section-header"><div><h2>采购清单</h2><span>达到目标价时只通知规则创建者</span></div><button className="icon-button" onClick={() => openCreate()} title="添加采购目标"><Plus size={17} /></button></header>
          {dashboard?.watches.length ? <div className="market-watch-list">{dashboard.watches.map((watch) => (
            <div key={watch.id} className={selectedProductId === watch.productId ? "active" : ""}>
              <button className="market-watch-select" onClick={() => setSelectedProductId(watch.productId)}>
                <span className={`market-watch-state ${watch.state}`}><CircleCheck size={16} /></span>
                <span><strong>{watch.product.name}</strong><small>{watch.product.platform} · {watch.enabled ? watch.state === "met" ? "价格已达标" : "等待目标价" : "已暂停"}</small></span>
                <span><strong>{money(watch.product.lowestPriceMinor, watch.product.currency)}</strong><small>目标 {money(watch.targetPriceMinor, watch.currency)}</small></span>
              </button>
              <span className="row-actions">
                <button className="icon-button" onClick={() => openEdit(watch)} title="编辑采购目标"><Pencil size={15} /></button>
                <button className="icon-button danger" onClick={() => void removeWatch(watch)} title="删除采购目标"><Trash2 size={15} /></button>
              </span>
            </div>
          ))}</div> : <EmptyState title="还没有采购目标" detail="选择重点商品和目标价格，达到条件时通过通知中心提醒" />}
        </section>
      </div>

      <section className="content-band">
        <header className="section-header"><div><h2>当前可见报价</h2><span>{detail?.product.name ?? "选择商品"} · 按有货和价格排序</span></div><span className="market-coverage-badge">部分覆盖</span></header>
        {detail?.offers.length ? <div className="table-wrap"><table><thead><tr><th>店铺</th><th>原始商品</th><th>价格</th><th>库存</th><th>更新时间</th><th /></tr></thead><tbody>{detail.offers.map((offer) => (
          <tr key={offer.id}>
            <td><div className="target-name"><strong>{offer.storeName}</strong><span>{offer.sourceName}</span></div></td>
            <td><div className="market-offer-title">{offer.title}</div></td>
            <td><strong className="market-price">{money(offer.priceMinor, offer.currency)}</strong></td>
            <td><Status good={offer.available} label={offer.available ? offer.stockCount === null ? "有货" : `有货 ${offer.stockCount}` : "不可购买"} /></td>
            <td>{formatDate(offer.capturedAt)}</td>
            <td><a className="icon-button" href={offer.url} target="_blank" rel="noreferrer" title="打开原店铺"><ExternalLink size={15} /></a></td>
          </tr>
        ))}</tbody></table></div> : <EmptyState title="暂无可见报价" detail="公共 Feed 当前没有为这个商品返回 Top 报价" />}
      </section>

      <section className="content-band">
        <header className="section-header"><div><h2>市场商品</h2><span>从 PriceAI 公共快照中选择采购目标</span></div></header>
        {dashboard?.catalog.length ? <div className="table-wrap"><table><thead><tr><th>商品</th><th>平台</th><th>最低有货价</th><th>有货/全部</th><th>最低渠道</th><th /></tr></thead><tbody>{dashboard.catalog.map((product) => (
          <tr key={product.id}>
            <td><button className="market-product-link" onClick={() => setSelectedProductId(product.id)}><strong>{product.name}</strong><small>{product.spec ?? product.productType}</small></button></td>
            <td>{product.platform}</td>
            <td><strong className="market-price">{money(product.lowestPriceMinor, product.currency)}</strong></td>
            <td>{product.inStockCount} / {product.offerCount}</td>
            <td>{product.lowestOffer?.storeName ?? "-"}</td>
            <td>{watchedIds.has(product.id) ? <span className="market-watched-label">监控中</span> : <button className="icon-button bordered" onClick={() => openCreate(product)} title="添加采购目标"><Plus size={15} /></button>}</td>
          </tr>
        ))}</tbody></table></div> : <EmptyState title={loading ? "正在载入市场" : "尚无市场商品"} detail="管理员执行首次同步后会显示 PriceAI 标准商品" />}
      </section>

      <Modal open={formOpen} title={editing ? "编辑采购目标" : "添加采购目标"} onClose={() => setFormOpen(false)}>
        <form className="form-grid" onSubmit={saveWatch}>
          <label className="field-span"><span>商品</span><select value={form.productId} disabled={Boolean(editing)} onChange={(event) => setForm({ ...form, productId: event.target.value })} required>
            <option value="" disabled>选择要采购的商品</option>
            {dashboard?.catalog.map((product) => <option key={product.id} value={product.id}>{product.platform} · {product.name}</option>)}
          </select></label>
          <label className="field-span"><span>目标价格（人民币）</span><input type="number" min="0.01" max="1000000" step="0.01" value={form.targetPrice} onChange={(event) => setForm({ ...form, targetPrice: event.target.value })} placeholder="例如 40.00" required autoFocus /></label>
          <div className="notice field-span"><BadgeDollarSign size={17} /><span>只有公开 Feed 显示商品有货且价格不高于目标价时才通知。</span></div>
          <label className="switch-field field-span"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} /><span>启用这个采购目标</span></label>
          <div className="modal-actions field-span"><button type="button" className="secondary-button" onClick={() => setFormOpen(false)}>取消</button><button className="primary-button">保存目标</button></div>
        </form>
      </Modal>
    </div>
  );
}
