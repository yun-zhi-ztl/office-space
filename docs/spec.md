# OfficeSpace · 办公空间管理 — 设计规格

> 由「坑位雷达」终极改造而来：沿用其账号体系、空间隔离、WebSocket 实时同步与
> PostgreSQL 持久化方案，把领域从「卫生间」升级为「办公空间」的多功能管理平台。

## 1. 产品定位

办公室 / 部门 / 楼层 **共用一个空间** 的内部管理看板，多人在同一局域网或集群内实时共用。
一个 `space` 即代表一个办公室（或一层楼、一个组织）的公共资源单元。围绕五类高频需求：

1. **会议室预约** —— 预约时段、冲突检测、取消。
2. **测试工具借用** —— 登记在库设备（测试电脑 / 测试机器 / 测试手机等）的借出与归还。
3. **物资申领** —— 提出是否需要电池等物资的请求，并由同事/管理员处理。
4. **报修** —— 上报厕所、灯光、空调等设施故障，推进状态。
5. **坑位看板**（原「坑位雷达」）—— 卫生间坑位实时占用 / 预约 / 抢位 / 催促 / 评分。

## 2. 关键设计原则

- **身份模型**：账号（`account`）全局唯一、区分大小写；用户名允许重名。
- **空间隔离**：每个「空间空间」（space）相当于一个办公室/团队，拥有独立的房间、设备、
  物资与报修数据；运行状态保存在内存，通过 WebSocket 实时广播。
- **角色**：创建空间者即为该空间「管理员」（admin）。管理员管理房间与设备资源；
  普通成员可预约、借用、申领、报修。申领处理与报修推进允许任意成员协作完成，保证空间可用。
- **实时同步**：任何变更后，服务端把对应模块的全量列表广播给该空间所有在线成员。
- **持久化**：PostgreSQL 保存各实体；连接失败自动降级为进程内内存模式。启动不再清空数据。

## 3. 数据模型

### 账号与空间
- `account | account`: 登录身份（唯一、大小写敏感）
- `space`: `{ id, name }`，`space.adminAccounts: string[]`（管理员账号）
- `space.members`: 在线成员由其连接携带

### 会议室（conference rooms）
- `room`: `{ id, name, capacity, location, description }`
- `room_reservation`: `{ id, roomId, ownerAccount, title, startAt, endAt, note, status }`
  - 状态：`pending`(已约) / `active`(进行中) / `completed` / `cancelled` / `expired`
  - 约束：同一房间在 `[startAt, endAt)` 内不得与他人预约重叠（ конфл检测）。

### 工具借用（tools）
- `tool`: `{ id, name, category, total, available, location, description }`
  - `category`: 测试电脑 / 测试机器 / 测试手机 / 其它
- `tool_borrow`: `{ id, toolId, borrowerAccount, borrowerName, qty, borrowedAt, returnedAt?, status }`
  - 状态：`borrowed` / `returned`
  - 借出时 `available -= qty`，归还时 `available += qty`；`available < qty` 不可借。

### 物资申领（materials）
- `material_request`: `{ id, requesterAccount, requesterName, name, qty, unit, reason, status, createdAt, handledAt? }`
  - 状态：`pending` / `fulfilled` / `cancelled`
  - 申请人可取消自己的 `pending`；他人可将 `pending` 置为 `fulfilled`。

### 报修（repairs）
- `repair`: `{ id, reporterAccount, reporterName, category, location, description, status, createdAt, updatedAt }`
  - `category`: 厕所 / 灯光 / 空调 / 其它
  - 状态流转：`reported` → `in_progress` → `resolved`；上报人可取消 `reported`。

### 坑位看板（restroom / 原坑位雷达）
- 每个空间独立配置 `squat_count`（蹲坑）、`urinal_count`（尿槽）。
- `stall`: `{ id, type: squat|urinal, name, status: free|reserved|waiting|occupied, ratings, reservation }`
- `reservation`: 预约 / 抢位产生的占用记录，身份键用 **账号**（防多开）。
  - 倒计时：尿槽 1 分钟、蹲坑 5 分钟（抢位）；确认到坑有 `[startTime, startTime+5min]` 时间窗。
- 操作：`reserve / cancel / grab / startUse / finish / release / urge / rate / toggleEmergency`。
- 评分：干净度 / 信号 / 纸巾 1-5 整数校验，同一账号同一坑位只记一次。
- 战绩与排行榜：按时率、累计时长、抢位次数、蹲坑次数等；按空间 + 账号维度独立。

## 4. 通信协议

前端通过单向 WebSocket（`/ws`）与服务端通信，服务端广播全量列表。

### 客户端 → 服务端
| 类型 | 说明 | 角色 |
| --- | --- | --- |
| `join` | 进入空间（首步 / 切换） | - |
| `login` / `logout` | 账号+密码 或 token 恢复 / 退出 | - |
| `roomCreate` / `roomRemove` | 新增 / 删除会议室 | admin |
| `roomBook` | 预约会议室（含冲突检测） | member |
| `reservationCancel` | 取消自己的预约 | owner |
| `toolCreate` / `toolDelete` / `toolAdjust` | 增删设备 / 调整库存 | admin |
| `toolBorrow` / `toolReturn` | 借用 / 归还设备 | member |
| `materialRequest` / `materialCancel` | 提交 / 取消申领 | member / owner |
| `materialFulfill` | 处理申领为已满足 | 他人 |
| `repairCreate` | 提交报修 | member |
| `repairUpdate` | 推进 / 取消报修状态 | member / owner |
| `stallControl`（子类型 reserve/grab/startUse/finish/release/cancel/urge/rate/toggleEmergency） | 坑位看板全部操作 | member |
| `stallConfig` | 配置蹲坑 / 尿槽数量 | admin |

### 服务端 → 客户端
`joined`、`loginSuccess`、`error`、`stats`，
以及 `rooms`、`tools`、`materials`、`repairs`、`stalls`、`users`、`leaderboard`（含 `account`、`role`、`display`）。

## 5. 前端

单页应用：左侧导航（概览 / 会议室 / 工具借用 / 物资申领 / 报修 / 坑位看板）。
桌面与移动端响应式，原生 HTML/CSS/JS，无构建步骤；静态文件由 Express 托管。

## 6. 非目标（本版本暂不实现）
- 复杂审批流、权限细粒度分级、通知系统、文件上传、消息私聊。
- 跨空间统计串用（每个空间的战绩 / 排行榜相互独立）。