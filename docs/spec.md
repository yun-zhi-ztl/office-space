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

## 7. 性能、分页与并发设计

设计目标是「办公室 / 楼层规模的多人在线实时协作」，兼顾可扩展到更大组织。

### 并发一致性
- 实时权威状态保存在进程内存，Node 单线程事件循环内完成关键操作的「检查-执行」：
  工具库存扣减、坑位 `activeStallCount`、会议室时段冲突检测均为原子判定，不产生竞态丢更新。
- PostgreSQL 作为持久化透写（写最终态），非事务关键路径；异常时降级纯内存。

### 分页与广播
- 可增长的列表（会议室预约、物资申领、报修、借用记录）**实时广播只推最近 `LIST_PAGE` 条**并附带 `total`，
  前端按需「加载更多」。
- 新增 `fetchPage` 消息：`{type:'fetchPage', module, offset, limit}`，服务端返回
  `{type:'page', module, offset, items, total}`，实现 offset/limit 分页，避免每次全量下发。
- 排行榜保留 TopN（30）；坑位评分保留最近 60 条。

### 写入与数据库
- **写合并去抖**：`saveProfile` / `saveEntity` 改为按主键合并、去抖批量 upsert（默认 500ms），
  降低并发下的写放大；停机（SIGTERM/SIGINT）前强制 flush。
- **索引**：`entities(kind)`、`stall_ratings(space, stall_id)`、`stall_ratings(space, created_at)`，
  支撑分页与载入查询。
- 启动只做幂等建表 / 迁移，不销毁数据。

### 连接健康度
- WebSocket 心跳：每 30s ping，未回 pong 的连接被终止，防止异常断开的僵尸连接持续占用内存与广播带宽。
- 客户端断线自动重连并凭 token 恢复会话。

### 运维
- 优雅停机：SIGTERM/SIGINT 触发 flush 待写、关闭连接与连接池。

## 8. 趣味与效率功能（本版本新增）

在五大模块之上补充一组轻量、好用的趣味功能，全部复用实时同步与排行榜底子：

| 功能 | 说明 | 消息 |
| --- | --- | --- |
| 心情状态灯 | 每个人设状态（在岗/开会/午饭/外出/休息/勿扰），在线列表与侧栏实时亮灯 | `setStatus` |
| 一键喊话/公告 | 向整个空间发一句话，进入公告栏并实时广播给所有人 & 大屏 | `announce` |
| 每周之星 MVP | 统计本周活跃（上坑/借用/申领/报修/开会），本周最高者成为 MVP（👑） | 排行榜 `mvp` + `weekly` |
| 徽章与段位 | 现有成就 + 每个坑位按评分/使用量形成段位（青铜→王者「坑位传说榜」） | 排行榜/坑位 `tier` |
| 设备催还与占用王榜 | 借用超过 7 天标记「逾期」，他人可一键提醒借用人归还；逾期列表即「占用王榜」 | `remindReturn` |
| 一键智能选房 | 按时段+人数自动列出空闲会议室并推荐 | `suggestRoom` |
| 电视墙大屏 | 独立只读页 `public/screen.html`，展示会议室「现在/接下来」+ 空间总览 + 坑位占用 + 公告 + 在线状态；支持全屏切换与多视图自动轮播（可暂停/手动切换） | 复用现有广播 |
| 每日看点 | 登录后推送今日要点：今天会议、逾期借用、我的未还、待处理申领/报修、本周之星 | 登录时下发 `digest` |

### 客户端→服务端新增消息
`setStatus`、`announce`、`suggestRoom`、`remindReturn`；服务端相应广播/单发
`users`(含 `status`) 、`notices`、`suggestRooms`、`borrowReminder`、`digest`。

## 9. 代码架构（多模块拆分）

后端按领域拆分到 `src/`，`server.js` 只做组装，降低单文件维护成本：

```
server.js        入口：Express + WS 分发 + 定时器 + 心跳 + 优雅停机 + 启动
src/context.js   共享上下文：状态 + 常量 + 基础工具 + 持久化(写合并) + 认证 + 序列化 + 广播 + 坑位成就 + 每日看点
src/http.js      HTTP 路由：/api/spaces、/api/register
src/session.js   会话：进入/切换空间、登录（含 digest）
src/modules/     rooms / tools / materials / repairs / stalls / extras（各领域处理函数）
```

- 各领域模块是纯函数工厂 `module.exports = (api)=>({...})`，由 `server.js` 注入共享上下文 `api`，无全局状态、便于单测。
- 定时器、心跳、优雅停机属于进程级关注点，保留在入口。
- 该拆分不改变任何对外协议与行为，e2e（48 项）在内存与 PostgreSQL 双模式下均通过。