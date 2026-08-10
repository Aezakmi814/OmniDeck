# OmniDeck

[English](README.md) | [简体中文](README.zh-CN.md)

OmniDeck 是一个面向服务、基础设施、数据源、告警、通知和自动化任务的自托管控制与可观测平台。`0.3.x` 版本用于监控基础设施、公网接口、OpenAI 兼容上游和市场采购目标，并通过轻量级 Agent 管理 Linux 与 Windows 节点。

平台提供统一认证、项目权限、导航、持久通知任务和带类型的事件接入协议。数据库迁移会自动执行，但生产环境升级前仍应备份数据。

## 功能

- 管理员和查看者角色，关闭公开注册。
- 管理员创建用户并直接重置密码，包括 root 管理员。
- 管理 Linux、Windows、NAS、笔记本和按需虚拟机。
- 采集 CPU、内存、磁盘、网络、运行时间和指定服务指标。
- 监控 HTTP 接口状态、响应码、TTFB、总耗时和 TLS 证书。
- 通过真实 OpenAI 兼容 SSE 请求探测 TTFT 并验证响应内容。
- 使用可配置的 JSON 字段路径采集可选的余额信息。
- 从界面向指定 Agent 分配分布式探测任务。
- 统一站内、SMTP 和每用户私有 ntfy 通知，支持订阅、免打扰、优先级、冷却、重试和恢复处理。
- 模块/项目注册表、JSON Schema 事件类型、哈希项目令牌、幂等外部 API 与 `@omnideck/sdk`。
- 基于 PriceAI 公共 Feed 的采购清单、目标价通知、可见 Top 报价对比和 90 天价格/库存趋势。
- Prometheus 指标支持位置标签和 90 天保留策略。
- Grafana 仪表盘复用 OmniDeck 登录会话。
- 使用 Docker Compose 部署，数据库、Prometheus 和 Grafana 端口均不直接公开。

## 架构

```text
浏览器
  -> HTTPS 边缘代理 / FRP
  -> gateway:3200
     -> OmniDeck app:3000
     -> Grafana:3000（通过 auth_request 实现 SSO）

Linux / Windows Agent
  -> HTTPS /api/agent/report
  -> HTTPS /api/agent/tasks
  -> 执行已分配的探测任务
  -> HTTPS /api/agent/result

Prometheus
  -> 使用独立 Bearer Token 访问私有 /metrics
  -> Grafana 数据源

项目 / 模块
  -> @omnideck/sdk / HTTPS 事件 API
  -> SQLite 持久发件箱
   -> 站内 / 邮件 / ntfy Provider

市场数据源适配器
  -> 标准化商品 / 报价 / 历史观测
  -> 用户采购规则
  -> 定向通知事件
```

OmniDeck 中心实例始终会执行每个已启用的探测任务，Agent 则提供额外的地理位置和网络视角。探测使用的 API 密钥会在控制端加密保存，仅通过 HTTPS 发送给已分配且通过认证的 Agent，只保留在内存中，不会写入 Agent 配置文件。

通知架构、API 限制和 ntfy 隔离方案见 [docs/notifications.md](docs/notifications.md)，市场数据边界与扩展接口见 [docs/market-intelligence.md](docs/market-intelligence.md)，机器可读的外部事件协议见 [docs/openapi.yaml](docs/openapi.yaml)。

## 快速开始

环境要求：

- Docker Engine 24 或更高版本，并安装 Docker Compose v2。
- 至少具有 2 GiB 内存的 Linux 主机或 NAS。
- 生产环境必须在端口 `3200` 前配置 HTTPS。

生成部署密钥：

```powershell
./scripts/prepare-deploy.ps1 -AppUrl "https://sys.example.com"
```

该命令会生成已被 Git 忽略的 `.env` 和 `deploy/secrets/` 文件。一次性 root 密码保存在本地 `deploy/secrets/initial_admin_password.txt`，不会包含在部署归档中。

启动服务：

```bash
docker compose up -d --build
```

本地测试时访问 `http://127.0.0.1:3200`。当 `APP_URL` 使用 HTTPS 时，会话 Cookie 将设置为 `Secure`，因此生产环境必须使用 HTTPS。

## FNOS 部署

在 Windows PowerShell 中执行：

```powershell
./scripts/prepare-deploy.ps1 `
  -AppUrl "https://sys.example.com" `
  -NpmRegistry "https://registry.npmjs.org/"

./scripts/deploy-fnos.ps1 `
  -SshHost "fnos" `
  -RemoteDirectory "/vol1/docker/omnideck" `
  -NtfyBaseUrl "https://notify.example.com" `
  -NtfyProvisionerUrl "http://host.docker.internal:6601"
```

只有同时存在两个被忽略的 ntfy 密钥文件时才需要 ntfy URL 参数，否则使用基础部署模式。更新会备份源码和停写后的数据卷、保留旧镜像，并在新 App 健康检查失败时自动恢复。部署只在 NAS 上公开 `127.0.0.1:3200`。请将本地反向代理或 FRP 客户端指向该端口。详细说明参见 [docs/deployment.md](docs/deployment.md)。

## Agent

使用本地 Go 工具链构建 Agent：

```bash
cd agent
go build -o omnideck-agent .
```

也可以使用 Docker：

```powershell
./scripts/build-agent.ps1 -TargetOS windows -TargetArch amd64
./scripts/build-agent.ps1 -TargetOS linux -TargetArch amd64
```

在 OmniDeck 界面创建节点，然后以管理员或 root 身份执行页面生成的安装命令。

界面会从当前部署的 `/downloads/` 路径下载安装产物，并将 Agent 安装为开机服务。旋转节点令牌会立即使现有安装失效，因此旋转后需要执行使用新令牌生成的命令。

```powershell
omnideck-agent.exe install `
  --server https://sys.example.com `
  --token ONE_TIME_NODE_TOKEN `
  --services frpc,OpenCode
```

```bash
sudo ./omnideck-agent install \
  --server https://sys.example.com \
  --token ONE_TIME_NODE_TOKEN \
  --services frpc,docker
```

Windows 使用以 `SYSTEM` 身份运行的开机计划任务，Linux 使用经过安全加固的 systemd 服务。节点令牌可以在节点管理页面中旋转。

## 开发

需要 Node.js 24 或更高版本。

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

Web 应用运行在 `127.0.0.1:5173`，并将 `/api` 请求代理到 `127.0.0.1:3000`。

## 安全

- 密码使用带盐的 `scrypt` 哈希。
- API 密钥和 SMTP 凭据使用 AES-256-GCM 加密保存。
- 会话令牌和 Agent 令牌仅保存为 SHA-256 哈希。
- 项目 API 令牌仅保存哈希；ntfy 设备令牌与 Provider 凭据使用 AES-256-GCM 加密。
- 每位用户使用随机私有 ntfy 主题、只读订阅 ACL 和独立的一年期设备令牌。
- 禁止用户自行注册。
- 应用日志会隐藏授权头、Cookie、密码和 API 密钥。
- Grafana 和 Prometheus 只能从 Docker 内部网络访问。
- 指标接口需要独立的 Bearer Token。

禁止提交 `.env`、`deploy/secrets/` 中的文件、运行时数据库或生成的 Agent。将部署公开到网络前，请阅读 [SECURITY.md](SECURITY.md)。

## 许可证

本仓库源码使用 [Apache License 2.0](LICENSE) 许可证。项目包含或引用的第三方组件继续使用各自的许可证，包括 Grafana、Prometheus、Nginx、React 及其依赖。
