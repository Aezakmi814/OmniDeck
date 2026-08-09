import {
  Bell,
  BellRing,
  CheckCheck,
  CircleAlert,
  Copy,
  KeyRound,
  Plus,
  Radio,
  Smartphone,
  Trash2,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "../components/Modal";
import { useAuth } from "../contexts/AuthContext";
import { api, ApiError, json } from "../lib/api";
import { formatDate } from "../lib/format";

type Tab = "inbox" | "subscriptions" | "delivery" | "admin";
interface EventType {
  id: string;
  eventKey: string;
  name: string;
  description: string;
  defaultPriority: number;
  lifecycle: string;
}
interface Project {
  id: string;
  projectKey: string;
  moduleKey: string;
  name: string;
  description: string;
  eventTypes: EventType[];
}
interface Subscription {
  id: string;
  projectId: string | null;
  projectName: string | null;
  eventTypeId: string | null;
  eventTypeName: string | null;
  minPriority: number;
  deliveryPriority: number | null;
  channels: string[];
  emailAddresses: string[];
  cooldownMode: string;
  cooldownSeconds: number;
  repeatCount: number;
  quietStart: string | null;
  quietEnd: string | null;
  recoverySummaryMode: string;
  enabled: boolean;
}
interface InboxItem {
  id: string;
  title: string;
  body: string;
  priority: number;
  read_at: string | null;
  occurred_at: string;
  project_name: string;
  event_type_name: string;
  lifecycle: string;
}
interface NtfyStatus {
  account: null | {
    username: string;
    topic: string;
    status: string;
    provisioned_at: string | null;
    last_error: string | null;
  };
  devices: Array<{
    id: string;
    name: string;
    token_hint: string;
    expires_at: string;
    created_at: string;
  }>;
  job: null | {
    id: string;
    operation: string;
    status: string;
    last_error: string | null;
    updated_at: string;
    result_available: number;
  };
  provider: { configured: boolean; enabled: boolean; baseUrl: string };
  provisioner: { configured: boolean; url: string };
}
interface AdminProject extends Record<string, unknown> {
  id: string;
  project_key: string;
  module_key: string;
  name: string;
  description: string;
  enabled: boolean;
  eventTypes: Array<{
    id: string;
    event_key: string;
    name: string;
    lifecycle: string;
    default_priority: number;
  }>;
  members: Array<{
    user_id: string;
    username: string;
    display_name: string;
    permission: string;
  }>;
  tokens: Array<{
    id: string;
    name: string;
    token_hint: string;
    created_at: string;
    expires_at: string | null;
    last_used_at: string | null;
  }>;
}
interface Delivery {
  id: string;
  channel: string;
  status: string;
  attempt_count: number;
  next_attempt_at: string;
  delivered_at: string | null;
  last_error: string | null;
  title: string;
  priority: number;
  project_name: string;
  username: string;
}

const blankSubscription = {
  projectId: "",
  eventTypeId: "",
  minPriority: 1,
  channels: ["in_app"],
  emailAddresses: "",
  cooldownMode: "once",
  cooldownMinutes: 30,
  repeatCount: 3,
  quietEnabled: false,
  quietStart: "22:00",
  quietEnd: "07:00",
  recoverySummaryMode: "merged",
  enabled: true,
};

export function NotificationsPage() {
  const { user, refresh } = useAuth();
  const [tab, setTab] = useState<Tab>("inbox");
  const [projects, setProjects] = useState<Project[]>([]);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [ntfy, setNtfy] = useState<NtfyStatus | null>(null);
  const [profile, setProfile] = useState({
    email: "",
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
  });
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [adminProjects, setAdminProjects] = useState<AdminProject[]>([]);
  const [subscriptionOpen, setSubscriptionOpen] = useState(false);
  const [subscription, setSubscription] = useState(blankSubscription);
  const [credentials, setCredentials] = useState<Record<string, string> | null>(
    null,
  );
  const [pendingProvisionJob, setPendingProvisionJob] = useState<string | null>(
    null,
  );
  const [credentialJobId, setCredentialJobId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [
      catalog,
      inboxResult,
      subscriptionResult,
      profileResult,
      ntfyResult,
    ] = await Promise.all([
      api<{ projects: Project[] }>("/api/notifications/catalog"),
      api<{ items: InboxItem[]; unreadCount: number }>(
        "/api/notifications/inbox",
      ),
      api<{ subscriptions: Subscription[] }>(
        "/api/notifications/subscriptions",
      ),
      api<{
        profile: { email: string | null; locale: string; timezone: string };
      }>("/api/notifications/profile"),
      api<NtfyStatus>("/api/notifications/ntfy"),
    ]);
    setProjects(catalog.projects);
    setInbox(inboxResult.items);
    setUnread(inboxResult.unreadCount);
    setSubscriptions(subscriptionResult.subscriptions);
    setProfile({
      ...profileResult.profile,
      email: profileResult.profile.email ?? "",
    });
    setNtfy(ntfyResult);
    if (
      ntfyResult.job &&
      (["pending", "processing"].includes(ntfyResult.job.status) ||
        (ntfyResult.job.status === "completed" &&
          Boolean(ntfyResult.job.result_available)))
    ) {
      setPendingProvisionJob((current) => current ?? ntfyResult.job!.id);
    }
    if (user?.role === "admin") {
      const [projectResult, deliveryResult] = await Promise.all([
        api<{ projects: AdminProject[] }>("/api/admin/notifications/projects"),
        api<{ items: Delivery[] }>("/api/admin/notifications/deliveries"),
      ]);
      setAdminProjects(projectResult.projects);
      setDeliveries(deliveryResult.items);
    }
  }
  useEffect(() => {
    void load().catch((reason) => setError(String(reason)));
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!pendingProvisionJob) return;
    const checkJob = () => {
      void api<{
        operation: string;
        status: string;
        error: string | null;
        result: { token?: string; expiresAt?: string } | null;
      }>(`/api/notifications/ntfy/jobs/${pendingProvisionJob}`)
        .then(async (job) => {
          if (job.status === "failed") {
            setPendingProvisionJob(null);
            setError(job.error ?? "ntfy 开通失败");
            return;
          }
          if (job.status !== "completed" || !job.result?.token) return;
          const status = await api<NtfyStatus>("/api/notifications/ntfy");
          setCredentials({
            baseUrl: status.provider.baseUrl,
            username: status.account?.username ?? "",
            topic: status.account?.topic ?? "",
            token: job.result.token,
            expiresAt: job.result.expiresAt ?? "",
          });
          setCredentialJobId(pendingProvisionJob);
          setNtfy(status);
          setPendingProvisionJob(null);
          setMessage(
            job.operation === "add-device"
              ? "设备令牌已创建，请立即保存"
              : "ntfy 已启用，请立即保存设备令牌",
          );
        })
        .catch(() => undefined);
    };
    checkJob();
    const timer = window.setInterval(checkJob, 2_000);
    return () => window.clearInterval(timer);
  }, [pendingProvisionJob]);

  async function run(action: () => Promise<void>, success: string) {
    setBusy(true);
    setError("");
    try {
      await action();
      setMessage(success);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function closeCredentials() {
    const jobId = credentialJobId;
    setCredentials(null);
    setCredentialJobId(null);
    if (!jobId) return;
    try {
      await api(`/api/notifications/ntfy/jobs/${jobId}/ack`, json("POST"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  async function markRead(item: InboxItem) {
    if (!item.read_at)
      await run(async () => {
        await api(`/api/notifications/inbox/${item.id}/read`, json("POST"));
      }, "通知已标记为已读");
  }
  async function readAll() {
    await run(async () => {
      await api("/api/notifications/inbox/read-all", json("POST"));
    }, "全部通知已读");
  }
  async function saveProfile(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      await api(
        "/api/notifications/profile",
        json("PUT", { ...profile, email: profile.email || null }),
      );
      await refresh();
    }, "通知资料已保存");
  }
  async function createSubscription(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      await api(
        "/api/notifications/subscriptions",
        json("POST", {
          projectId: subscription.projectId || null,
          eventTypeId: subscription.eventTypeId || null,
          minPriority: subscription.minPriority,
          channels: subscription.channels,
          emailAddresses: subscription.emailAddresses
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          cooldownMode: subscription.cooldownMode,
          cooldownSeconds: subscription.cooldownMinutes * 60,
          repeatCount: subscription.repeatCount,
          quietStart: subscription.quietEnabled
            ? subscription.quietStart
            : null,
          quietEnd: subscription.quietEnabled ? subscription.quietEnd : null,
          recoverySummaryMode: subscription.recoverySummaryMode,
          enabled: subscription.enabled,
        }),
      );
      setSubscriptionOpen(false);
      setSubscription(blankSubscription);
    }, "订阅已创建");
  }
  async function removeSubscription(id: string) {
    await run(async () => {
      await api(`/api/notifications/subscriptions/${id}`, json("DELETE"));
    }, "订阅已删除");
  }
  async function enableNtfy() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ jobId: string }>(
        "/api/notifications/ntfy/enable",
        json("POST", { deviceName: "Primary device" }),
      );
      setPendingProvisionJob(result.jobId);
      setMessage("ntfy 开通任务正在完成");
      await load();
    } catch (reason) {
      const jobId =
        reason instanceof ApiError && typeof reason.data?.jobId === "string"
          ? reason.data.jobId
          : null;
      if (jobId) {
        setPendingProvisionJob(jobId);
        setMessage("ntfy 开通任务将在后台重试");
      } else
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function addNtfyDevice() {
    const name = window.prompt("设备名称");
    if (!name) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ jobId: string }>(
        "/api/notifications/ntfy/devices",
        json("POST", { name }),
      );
      setPendingProvisionJob(result.jobId);
      setMessage("设备令牌任务正在完成");
      await load();
    } catch (reason) {
      const jobId =
        reason instanceof ApiError && typeof reason.data?.jobId === "string"
          ? reason.data.jobId
          : null;
      if (jobId) {
        setPendingProvisionJob(jobId);
        setMessage("设备令牌任务将在后台重试");
      } else
        setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  async function revokeDevice(id: string) {
    await run(async () => {
      await api(`/api/notifications/ntfy/devices/${id}`, json("DELETE"));
    }, "设备令牌已撤销");
  }
  async function disableNtfy() {
    if (!window.confirm("停用 ntfy 会撤销当前账号的所有设备令牌，是否继续？"))
      return;
    await run(async () => {
      await api("/api/notifications/ntfy", json("DELETE"));
    }, "ntfy 已停用，全部设备令牌已撤销");
  }

  const selectedProject = projects.find(
    (project) => project.id === subscription.projectId,
  );
  return (
    <div className="page-stack">
      {(message || error) && (
        <div className={error ? "error-banner" : "success-banner"}>
          {error ? <CircleAlert size={17} /> : <BellRing size={17} />}
          {error || message}
          <button
            onClick={() => {
              setMessage("");
              setError("");
            }}
          >
            关闭
          </button>
        </div>
      )}
      <div className="page-actions">
        <div>
          <span className="eyebrow">Delivery control</span>
          <p className="page-summary">统一管理站内、邮件和 ntfy 通知</p>
        </div>
        <div className="segmented notification-tabs">
          <button
            className={tab === "inbox" ? "active" : ""}
            onClick={() => setTab("inbox")}
          >
            收件箱 {unread > 0 && `(${unread})`}
          </button>
          <button
            className={tab === "subscriptions" ? "active" : ""}
            onClick={() => setTab("subscriptions")}
          >
            订阅规则
          </button>
          <button
            className={tab === "delivery" ? "active" : ""}
            onClick={() => setTab("delivery")}
          >
            通知渠道
          </button>
          {user?.role === "admin" && (
            <button
              className={tab === "admin" ? "active" : ""}
              onClick={() => setTab("admin")}
            >
              项目管理
            </button>
          )}
        </div>
      </div>

      {tab === "inbox" && (
        <section className="content-band">
          <header className="section-header">
            <div>
              <h2>站内通知</h2>
              <span>按发生时间排序，保留 90 天</span>
            </div>
            <button
              className="secondary-button small"
              onClick={() => void readAll()}
              disabled={!unread || busy}
            >
              <CheckCheck size={15} />
              全部已读
            </button>
          </header>
          {inbox.length === 0 ? (
            <div className="empty-state">
              <Bell size={24} />
              <strong>暂无通知</strong>
              <span>创建订阅后，匹配的事件会显示在这里。</span>
            </div>
          ) : (
            <div className="notification-list">
              {inbox.map((item) => (
                <button
                  key={item.id}
                  className={
                    item.read_at
                      ? "notification-row"
                      : "notification-row unread"
                  }
                  onClick={() => void markRead(item)}
                >
                  <span className={`priority-mark p${item.priority}`}>
                    {item.priority}
                  </span>
                  <span className="notification-copy">
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {item.project_name} · {item.event_type_name}
                      </small>
                    </span>
                    <p>{item.body}</p>
                    <time>{formatDate(item.occurred_at)}</time>
                  </span>
                  {!item.read_at && <i />}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "subscriptions" && (
        <>
          <div className="page-actions">
            <div>
              <span className="eyebrow">Routing rules</span>
              <p className="page-summary">
                新用户默认无订阅，规则按项目、事件和优先级匹配
              </p>
            </div>
            <button
              className="primary-button"
              onClick={() => setSubscriptionOpen(true)}
            >
              <Plus size={16} />
              新增订阅
            </button>
          </div>
          <section className="content-band">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>范围</th>
                    <th>渠道</th>
                    <th>最低优先级</th>
                    <th>发送策略</th>
                    <th>免打扰</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <span className="table-primary">
                          {item.projectName ?? "全部项目"}
                        </span>
                        <small>{item.eventTypeName ?? "全部事件"}</small>
                      </td>
                      <td>{item.channels.map(channelName).join(" · ")}</td>
                      <td>P{item.minPriority}</td>
                      <td>
                        {cooldownName(
                          item.cooldownMode,
                          item.cooldownSeconds,
                          item.repeatCount,
                        )}
                      </td>
                      <td>
                        {item.quietStart && item.quietEnd
                          ? `${item.quietStart}-${item.quietEnd}`
                          : "关闭"}
                      </td>
                      <td>
                        <button
                          className="icon-button danger"
                          title="删除订阅"
                          onClick={() => void removeSubscription(item.id)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {subscriptions.length === 0 && (
                <div className="empty-state">
                  <Radio size={24} />
                  <strong>尚未订阅任何事件</strong>
                  <span>添加规则后才会产生面向当前用户的通知交付。</span>
                </div>
              )}
            </div>
          </section>
        </>
      )}

      {tab === "delivery" && (
        <div className="settings-stack">
          <section className="settings-section">
            <header>
              <span className="settings-icon">
                <UserRound size={19} />
              </span>
              <div>
                <h2>通知资料</h2>
                <p>邮件地址、显示语言与免打扰时区</p>
              </div>
            </header>
            <form
              className="settings-form settings-form-wide"
              onSubmit={saveProfile}
            >
              <label>
                <span>邮箱</span>
                <input
                  type="email"
                  value={profile.email}
                  onChange={(event) =>
                    setProfile({ ...profile, email: event.target.value })
                  }
                  placeholder="name@example.com"
                />
              </label>
              <label>
                <span>时区</span>
                <input
                  value={profile.timezone}
                  onChange={(event) =>
                    setProfile({ ...profile, timezone: event.target.value })
                  }
                  required
                />
              </label>
              <label>
                <span>语言</span>
                <select
                  value={profile.locale}
                  onChange={(event) =>
                    setProfile({ ...profile, locale: event.target.value })
                  }
                >
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English</option>
                </select>
              </label>
              <div className="settings-actions">
                <button className="primary-button" disabled={busy}>
                  保存资料
                </button>
              </div>
            </form>
          </section>
          <section className="settings-section">
            <header>
              <span className="settings-icon">
                <Smartphone size={19} />
              </span>
              <div>
                <h2>ntfy 设备通知</h2>
                <p>独立账号、私有主题和每设备一年令牌</p>
              </div>
            </header>
            <div className="channel-panel">
              {!ntfy?.account || ntfy.account.status !== "active" ? (
                <>
                  <div className="channel-status">
                    <Radio size={17} />
                    <span>
                      <strong>尚未启用</strong>
                      <small>
                        {ntfy?.provider.configured &&
                        ntfy.provisioner.configured
                          ? "服务已就绪"
                          : "管理员尚未完成 Provider 配置"}
                      </small>
                    </span>
                  </div>
                  <button
                    className="primary-button"
                    onClick={() => void enableNtfy()}
                    disabled={
                      busy ||
                      !ntfy?.provider.configured ||
                      !ntfy.provisioner.configured
                    }
                  >
                    <BellRing size={16} />
                    启用 ntfy
                  </button>
                </>
              ) : (
                <>
                  <div className="channel-status good">
                    <Radio size={17} />
                    <span>
                      <strong>{ntfy.account.topic}</strong>
                      <small>账号 {ntfy.account.username}</small>
                    </span>
                  </div>
                  <button
                    className="secondary-button small"
                    onClick={() => void addNtfyDevice()}
                  >
                    <Plus size={15} />
                    添加设备
                  </button>
                  <button
                    className="secondary-button small danger-text"
                    onClick={() => void disableNtfy()}
                  >
                    <Trash2 size={15} />
                    停用 ntfy
                  </button>
                  <div className="device-list">
                    {ntfy.devices.map((device) => (
                      <div key={device.id}>
                        <Smartphone size={16} />
                        <span>
                          <strong>{device.name}</strong>
                          <small>
                            令牌尾号 {device.token_hint} · 到期{" "}
                            {formatDate(device.expires_at)}
                          </small>
                        </span>
                        <button
                          className="icon-button danger"
                          onClick={() => void revokeDevice(device.id)}
                          title="撤销设备令牌"
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      )}

      {tab === "admin" && user?.role === "admin" && (
        <AdminPanel
          projects={adminProjects}
          deliveries={deliveries}
          busy={busy}
          run={run}
          setCredentials={setCredentials}
        />
      )}

      <Modal
        open={subscriptionOpen}
        title="新增通知订阅"
        onClose={() => setSubscriptionOpen(false)}
        wide
      >
        <form className="form-grid" onSubmit={createSubscription}>
          <label>
            <span>项目</span>
            <select
              value={subscription.projectId}
              onChange={(event) =>
                setSubscription({
                  ...subscription,
                  projectId: event.target.value,
                  eventTypeId: "",
                })
              }
            >
              <option value="">全部项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>事件类型</span>
            <select
              value={subscription.eventTypeId}
              onChange={(event) =>
                setSubscription({
                  ...subscription,
                  eventTypeId: event.target.value,
                })
              }
              disabled={!selectedProject}
            >
              <option value="">全部事件</option>
              {selectedProject?.eventTypes.map((eventType) => (
                <option key={eventType.id} value={eventType.id}>
                  {eventType.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>最低优先级</span>
            <select
              value={subscription.minPriority}
              onChange={(event) =>
                setSubscription({
                  ...subscription,
                  minPriority: Number(event.target.value),
                })
              }
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>
                  P{value}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>发送策略</span>
            <select
              value={subscription.cooldownMode}
              onChange={(event) =>
                setSubscription({
                  ...subscription,
                  cooldownMode: event.target.value,
                })
              }
            >
              <option value="once">仅一次</option>
              <option value="interval">冷却抑制</option>
              <option value="repeat_count">重复指定次数</option>
              <option value="until_recovery">重复直至恢复</option>
            </select>
          </label>
          <label>
            <span>间隔（分钟）</span>
            <input
              type="number"
              min={1}
              max={43200}
              value={subscription.cooldownMinutes}
              onChange={(event) =>
                setSubscription({
                  ...subscription,
                  cooldownMinutes: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            <span>重复次数</span>
            <input
              type="number"
              min={1}
              max={100}
              value={subscription.repeatCount}
              disabled={subscription.cooldownMode !== "repeat_count"}
              onChange={(event) =>
                setSubscription({
                  ...subscription,
                  repeatCount: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            <span>恢复策略</span>
            <select
              value={subscription.recoverySummaryMode}
              onChange={(event) =>
                setSubscription({
                  ...subscription,
                  recoverySummaryMode: event.target.value,
                })
              }
            >
              <option value="merged">合并未发送故障</option>
              <option value="all">故障与恢复均发送</option>
              <option value="recovery_only">仅发送恢复</option>
            </select>
          </label>
          <div className="field-span channel-options">
            <span>通知渠道</span>
            {(["in_app", "email", "ntfy"] as const).map((channel) => (
              <label key={channel}>
                <input
                  type="checkbox"
                  checked={subscription.channels.includes(channel)}
                  disabled={
                    channel === "ntfy" && ntfy?.account?.status !== "active"
                  }
                  onChange={(event) =>
                    setSubscription({
                      ...subscription,
                      channels: event.target.checked
                        ? [...subscription.channels, channel]
                        : subscription.channels.filter(
                            (item) => item !== channel,
                          ),
                    })
                  }
                />
                {channelName(channel)}
              </label>
            ))}
          </div>
          {subscription.channels.includes("email") && (
            <label className="field-span">
              <span>收件邮箱（逗号分隔，留空使用个人邮箱）</span>
              <input
                value={subscription.emailAddresses}
                onChange={(event) =>
                  setSubscription({
                    ...subscription,
                    emailAddresses: event.target.value,
                  })
                }
              />
            </label>
          )}
          <label className="switch-field field-span">
            <input
              type="checkbox"
              checked={subscription.quietEnabled}
              onChange={(event) =>
                setSubscription({
                  ...subscription,
                  quietEnabled: event.target.checked,
                })
              }
            />
            <span>启用免打扰时段（P5 仍立即发送）</span>
          </label>
          {subscription.quietEnabled && (
            <>
              <label>
                <span>开始</span>
                <input
                  type="time"
                  value={subscription.quietStart}
                  onChange={(event) =>
                    setSubscription({
                      ...subscription,
                      quietStart: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                <span>结束</span>
                <input
                  type="time"
                  value={subscription.quietEnd}
                  onChange={(event) =>
                    setSubscription({
                      ...subscription,
                      quietEnd: event.target.value,
                    })
                  }
                />
              </label>
            </>
          )}
          <div className="modal-actions field-span">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setSubscriptionOpen(false)}
            >
              取消
            </button>
            <button
              className="primary-button"
              disabled={busy || subscription.channels.length === 0}
            >
              创建订阅
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={Boolean(credentials)}
        title="一次性凭据"
        onClose={() => void closeCredentials()}
      >
        <div className="token-panel">
          <p>关闭后不会再次显示明文。每个设备使用自己的令牌。</p>
          {credentials &&
            Object.entries(credentials).map(([key, value]) => (
              <label key={key}>
                <span>{key}</span>
                <div className="secret-output">
                  <code>{value}</code>
                  <button
                    className="icon-button"
                    title="复制"
                    onClick={() => void navigator.clipboard.writeText(value)}
                  >
                    <Copy size={15} />
                  </button>
                </div>
              </label>
            ))}
        </div>
      </Modal>
    </div>
  );
}

function AdminPanel({
  projects,
  deliveries,
  busy,
  run,
  setCredentials,
}: {
  projects: AdminProject[];
  deliveries: Delivery[];
  busy: boolean;
  run: (action: () => Promise<void>, success: string) => Promise<void>;
  setCredentials: (value: Record<string, string>) => void;
}) {
  const [projectOpen, setProjectOpen] = useState(false);
  const [eventOpen, setEventOpen] = useState<string | null>(null);
  const [project, setProject] = useState({
    moduleKey: "custom",
    projectKey: "",
    name: "",
    description: "",
    enabled: true,
  });
  const [eventType, setEventType] = useState({
    eventKey: "",
    name: "",
    description: "",
    schema: '{\n  "type": "object",\n  "additionalProperties": true\n}',
    titleTemplate: "{{message}}",
    bodyTemplate: "{{message}}",
    defaultPriority: 3,
    lifecycle: "event",
  });
  async function createProject(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      await api("/api/admin/notifications/projects", json("POST", project));
      setProjectOpen(false);
    }, "项目已创建");
  }
  async function createEventType(event: React.FormEvent) {
    event.preventDefault();
    if (!eventOpen) return;
    await run(async () => {
      await api(
        `/api/admin/notifications/projects/${eventOpen}/event-types`,
        json("POST", {
          ...eventType,
          schema: JSON.parse(eventType.schema),
          enabled: true,
        }),
      );
      setEventOpen(null);
    }, "事件类型已创建");
  }
  async function createToken(projectId: string) {
    const name = window.prompt("令牌名称", "integration");
    if (!name) return;
    await run(async () => {
      const result = await api<{ token: Record<string, string> }>(
        `/api/admin/notifications/projects/${projectId}/tokens`,
        json("POST", { name }),
      );
      setCredentials(result.token);
    }, "项目令牌已创建");
  }
  async function addMember(projectId: string) {
    const username = window.prompt("授权用户名");
    if (!username) return;
    await run(async () => {
      await api(
        `/api/admin/notifications/projects/${projectId}/members`,
        json("POST", { username, permission: "read" }),
      );
    }, "项目权限已更新");
  }
  async function removeMember(projectId: string, userId: string) {
    await run(async () => {
      await api(
        `/api/admin/notifications/projects/${projectId}/members/${userId}`,
        json("DELETE"),
      );
    }, "项目权限已撤销");
  }
  async function revokeToken(id: string) {
    await run(async () => {
      await api(`/api/admin/notifications/tokens/${id}`, json("DELETE"));
    }, "项目令牌已撤销");
  }
  return (
    <>
      <div className="page-actions">
        <div>
          <span className="eyebrow">Project registry</span>
          <p className="page-summary">
            注册事件类型后，外部系统才可通过项目令牌发布
          </p>
        </div>
        <button className="primary-button" onClick={() => setProjectOpen(true)}>
          <Plus size={16} />
          新增项目
        </button>
      </div>
      <section className="content-band">
        <header className="section-header">
          <div>
            <h2>项目与事件类型</h2>
            <span>模块 + 项目实例</span>
          </div>
        </header>
        <div className="project-registry">
          {projects.map((item) => (
            <article key={item.id}>
              <header>
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.module_key} / {item.project_key}
                  </small>
                </span>
                <div>
                  <button
                    className="secondary-button small"
                    onClick={() => setEventOpen(item.id)}
                  >
                    <Plus size={14} />
                    事件类型
                  </button>
                  <button
                    className="secondary-button small"
                    onClick={() => void addMember(item.id)}
                  >
                    <UserRound size={14} />
                    授权
                  </button>
                  <button
                    className="secondary-button small"
                    onClick={() => void createToken(item.id)}
                  >
                    <KeyRound size={14} />
                    项目令牌
                  </button>
                </div>
              </header>
              <p>{item.description}</p>
              <div>
                {item.eventTypes.map((type) => (
                  <span className="event-chip" key={type.id}>
                    {type.event_key} · P{type.default_priority}
                  </span>
                ))}
                {item.members.map((member) => (
                  <span className="member-chip" key={member.user_id}>
                    {member.username} · {member.permission}
                    <button
                      title="撤销项目权限"
                      onClick={() => void removeMember(item.id, member.user_id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </span>
                ))}
                {item.tokens.map((token) => (
                  <span className="token-chip" key={token.id}>
                    {token.name} · {token.token_hint}
                    <button
                      title="撤销项目令牌"
                      onClick={() => void revokeToken(token.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="content-band">
        <header className="section-header">
          <div>
            <h2>最近交付</h2>
            <span>Provider 执行状态与重试信息</span>
          </div>
        </header>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>事件</th>
                <th>用户</th>
                <th>渠道</th>
                <th>状态</th>
                <th>尝试</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className="table-primary">{item.title}</span>
                    <small>
                      {item.project_name} · P{item.priority}
                    </small>
                  </td>
                  <td>{item.username}</td>
                  <td>{channelName(item.channel)}</td>
                  <td>
                    <span className={`delivery-state ${item.status}`}>
                      {item.status}
                    </span>
                  </td>
                  <td>{item.attempt_count}</td>
                  <td>
                    {formatDate(item.delivered_at ?? item.next_attempt_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <Modal
        open={projectOpen}
        title="新增通知项目"
        onClose={() => setProjectOpen(false)}
      >
        <form className="form-grid" onSubmit={createProject}>
          <label>
            <span>模块标识</span>
            <input
              value={project.moduleKey}
              onChange={(e) =>
                setProject({ ...project, moduleKey: e.target.value })
              }
              required
            />
          </label>
          <label>
            <span>项目标识</span>
            <input
              value={project.projectKey}
              onChange={(e) =>
                setProject({ ...project, projectKey: e.target.value })
              }
              required
            />
          </label>
          <label className="field-span">
            <span>名称</span>
            <input
              value={project.name}
              onChange={(e) => setProject({ ...project, name: e.target.value })}
              required
            />
          </label>
          <label className="field-span">
            <span>说明</span>
            <textarea
              value={project.description}
              onChange={(e) =>
                setProject({ ...project, description: e.target.value })
              }
            />
          </label>
          <div className="modal-actions field-span">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setProjectOpen(false)}
            >
              取消
            </button>
            <button className="primary-button" disabled={busy}>
              创建
            </button>
          </div>
        </form>
      </Modal>
      <Modal
        open={Boolean(eventOpen)}
        title="注册事件类型"
        onClose={() => setEventOpen(null)}
        wide
      >
        <form className="form-grid" onSubmit={createEventType}>
          <label>
            <span>事件标识</span>
            <input
              value={eventType.eventKey}
              onChange={(e) =>
                setEventType({ ...eventType, eventKey: e.target.value })
              }
              required
            />
          </label>
          <label>
            <span>名称</span>
            <input
              value={eventType.name}
              onChange={(e) =>
                setEventType({ ...eventType, name: e.target.value })
              }
              required
            />
          </label>
          <label>
            <span>默认优先级</span>
            <select
              value={eventType.defaultPriority}
              onChange={(e) =>
                setEventType({
                  ...eventType,
                  defaultPriority: Number(e.target.value),
                })
              }
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>
                  P{value}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>生命周期</span>
            <select
              value={eventType.lifecycle}
              onChange={(e) =>
                setEventType({ ...eventType, lifecycle: e.target.value })
              }
            >
              <option value="event">普通事件</option>
              <option value="opened">故障打开</option>
              <option value="recovered">故障恢复</option>
            </select>
          </label>
          <label className="field-span">
            <span>标题模板</span>
            <input
              value={eventType.titleTemplate}
              onChange={(e) =>
                setEventType({ ...eventType, titleTemplate: e.target.value })
              }
              required
            />
          </label>
          <label className="field-span">
            <span>正文模板</span>
            <textarea
              value={eventType.bodyTemplate}
              onChange={(e) =>
                setEventType({ ...eventType, bodyTemplate: e.target.value })
              }
              required
            />
          </label>
          <label className="field-span">
            <span>JSON Schema</span>
            <textarea
              className="code-input"
              value={eventType.schema}
              onChange={(e) =>
                setEventType({ ...eventType, schema: e.target.value })
              }
              required
            />
          </label>
          <div className="modal-actions field-span">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setEventOpen(null)}
            >
              取消
            </button>
            <button className="primary-button" disabled={busy}>
              注册
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

function channelName(channel: string) {
  return channel === "in_app" ? "站内" : channel === "email" ? "邮件" : "ntfy";
}
function cooldownName(mode: string, seconds: number, repeats: number) {
  if (mode === "once") return "仅一次";
  if (mode === "repeat_count")
    return `${Math.round(seconds / 60)} 分钟，共 ${repeats} 次`;
  if (mode === "until_recovery")
    return `每 ${Math.round(seconds / 60)} 分钟至恢复`;
  return `${Math.round(seconds / 60)} 分钟冷却`;
}
