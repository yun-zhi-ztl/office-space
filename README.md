# 🏢 OfficeSpace · 办公空间管理

> 一个给办公室 / 部门 / 楼层 **共用一个空间** 的实时管理看板：会议室预约、测试工具借用、物资申领、报修、卫生间坑位看板，全部实时同步。

多人在同一局域网打开即可使用。由「坑位雷达」终极改造而来，沿用其账号体系、空间隔离、WebSocket 实时同步与 PostgreSQL 持久化方案。

详细设计与协议见 [docs/spec.md](docs/spec.md)。

---

## ✨ 功能一览

| 模块 | 说明 |
| --- | --- |
| 会议室预约 | 预约时段、自动冲突检测、取消；逾期自动流转 |
| 工具借用 | 登记在库设备（测试电脑 / 测试机器 / 测试手机等），借用与归还、库存实时扣减 |
| 物资申领 | 提出需要电池等物资的请求，同事/管理员可处理为已满足 |
| 报修 | 上报厕所 / 灯光 / 空调等故障，并推进状态 |
| 坑位看板 | 卫生间坑位实时占用、预约、抢位、催促、三维评分，含排行榜与成就 |
| 趣味扩展 | 心情状态灯、一键喊话公告、每周之星 MVP、坑位段位传说榜、设备催还与占用王榜、一键智能选房、电视墙大屏、每日看点 |

- **空间隔离**：每个空间即一个办公室 / 层 / 组织，拥有独立的会议室、设备、物资、报修与坑位数据。
- **账号体系**：账号唯一且大小写敏感，scrypt 加盐哈希；空间首个登录用户自动成为**管理员**（可配置资源）。
- **实时同步**：任何变更通过 WebSocket 广播给该空间所有在线成员。
- **响应式**：桌面与手机两套布局。

---

## 🧱 技术栈

- **后端**：Node.js + Express + `ws`（WebSocket 实时推送）
- **存储**：PostgreSQL（保存空间 / 战绩 / 评分 / 各业务实体）；连接失败自动降级为进程内内存模式
- **前端**：原生 HTML / CSS / JS 单页（无构建步骤），由 Express 托管
- **部署**：Dockerfile + docker-compose

---

## 📁 项目结构

```
OfficeSpace/
├── server.js                # 后端：HTTP + WebSocket + 五模块业务逻辑 + PostgreSQL
├── public/
│   ├── index.html           # 前端单页应用（原生三件套）
│   └── screen.html          # 电视墙大屏（会议室 now/next + 空间总览，只读）
├── test/
│   └── test.js              # 端到端冒烟测试（覆盖五模块+扩展功能，需先启动服务）
├── docs/
│   └── spec.md              # 产品/数据模型/协议/性能设计规格
├── Dockerfile               # 后端容器镜像
├── docker-compose.yml       # 一键本地启动
├── package.json
└── .gitignore
```

---

## 🚀 快速开始

### 方式一：直接运行（推荐）

```bash
npm install        # 安装依赖
npm start          # 启动，默认 http://localhost:3000
```

浏览器打开 http://localhost:3000，创建一个空间并注册账号即可（空间首个登录用户为管理员）。

### 方式二：Docker

```bash
docker compose up -d --build
# 打开 http://localhost:3000
```

### 可选：连接 PostgreSQL

默认尝试连接 `127.0.0.1:5432`（用户 `postgres`、库 `toilet`、密码 `toilet_dev`）。连接失败自动切到内存模式，不影响功能。可通过环境变量覆盖：

```
PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE / PORT
```

> 说明：PostgreSQL 持久化「空间 / 账号 / 战绩 / 评分 / 会议室 / 工具 / 申领 / 报修」；
> 运行状态（坑位占用、在线用户）实时保存在内存并由 WebSocket 广播。重启不再清空历史数据。

---

## 🧪 运行测试

```bash
# 先在一个终端启动服务
npm start

# 另开一个终端跑测试
npm test
```

包含会议室（冲突检测 / 取消 / RBAC / 智能选房）、工具借用（借用 / 不足 / 归还 / 逾期催还）、物资申领（提交 / 处理 / 自处理限制）、报修（状态流转 / 越权取消）、坑位看板（预约时间窗、评分越界、重复评分、同账号多开限制、切换空间守卫、段位），以及分页、状态灯、公告、每周之星 MVP、每日看点等 **48 项断言**。

---

## 🔌 交互协议简述

前端通过 WebSocket（`/ws`）与服务端通信；先 `join` 进入空间，再 `login`（账号+密码 或 token 恢复会话）。业务消息统一按类型下发：

| 模块 | 客户端→服务端消息 |
| --- | --- |
| 会议室 | `roomCreate` / `roomRemove`(admin) · `roomBook` · `reservationCancel` |
| 工具借用 | `toolCreate` / `toolDelete` / `toolAdjust`(admin) · `toolBorrow` / `toolReturn` |
| 物资申领 | `materialRequest` / `materialCancel` / `materialFulfill` |
| 报修 | `repairCreate` / `repairUpdate` |
| 坑位看板 | `reserve` / `cancel` / `grab` / `startUse` / `finish` / `release` / `urge` / `rate` / `toggleEmergency` · `stallConfig`(admin) |

服务端广播全量列表：`rooms`、`tools`、`materials`、`repairs`、`stalls`、`users`、`leaderboard`（均含 `account` 身份、`role`、`display`）。

**命名约定**：`account` 为全局唯一身份键（区分大小写）；`display` 为展示名（重名时自动追加账号区分）。

---

## 🚻 坑位看板（原坑位雷达）

卫生间坑位实时看板作为独立模块保留：

- 预约到点锁定 / 临时抢位（蹲坑 5 分钟、尿槽 1 分钟倒计时）
- 确认到坑需在时间窗内（预约开始后 5 分钟内超时释放）
- 主观催促，超时自动释放
- 干净度 / 信号 / 纸巾三维评分（1-5 整数校验，同一账号同一坑位只记一次）
- 同账号多开连接也只能占一个坑位；占用中不可切换空间（跨空间统计隔离）
- 按时率 / 时长 / 抢位等维度排行榜与成就

---

## 📝 开发方式

从「坑位雷达」以 vibe coding 方式迭代而来：先落地单模块，再在对话中逐条重构为多模块平台，并针对评审发现的真实 bug 逐个修复、验证、合入。

仓库链接：https://github.com/yun-zhi-ztl/office-space