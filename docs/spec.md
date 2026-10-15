# OfficeSpace · 办公空间管理 — 设计规格

> 由「坑位雷达」终极改造而来：沿用其账号体系、空间隔离、WebSocket 实时同步与
> PostgreSQL 持久化方案，把领域从「卫生间」升级为「办公空间」的多功能管理平台。

## 1. 产品定位

办公室 / 部门 / 楼层 **共用一个空间** 的内部管理看板，多人在同一局域网或集群内实时共用。
一个 `space` 即代表一个办公室（或一层楼、一个组织）的公共资源单元。围绕五类高频需求：

1. **会议室预约** —— 预约时段、冲突检测、取消，并提供会议室占用率统计。
2. **测试工具借用** —— 登记在库设备（测试电脑 / 测试机器 / 测试手机等）的借出与归还。
3. **物资申领** —— 提出是否需要电池等物资的请求，并由同事/管理员处理。
4. **报修** —— 上报厕所、灯光、空调等设施故障，支持优先级并推进状态。
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
- `space.paused` / `space.pausedReason`: 管理员设置的暂停状态与原因；暂停时全员暂不可预约、借用、申领、报修、登记访客
- `space.members`: 在线成员由其连接携带

### 会议室（conference rooms）
- `room`: `{ id, name, capacity, location, description }`
- `room_reservation`: `{ id, roomId, ownerAccount, title, startAt, endAt, note, status, repeat?, seriesId?, seriesIndex? }`
  - 状态：`pending`(已约) / `active`(进行中) / `completed` / `cancelled` / `expired`
  - 约束：同一房间在 `[startAt, endAt)` 内不得与他人预约重叠（冲突检测）。
  - 周期预约：`repeat` 为 `daily` / `weekly`（或省略表示单次），`repeatCount` 限制场次（每天 ≤ 90、每周 ≤ 52）；
    创建时按天 / 周展开为多条独立预约，共用 `seriesId`，可整体取消待开始场次。
  - 占用率统计：按「今日会议场次 / 今日会议分钟数 / 待开始场次」计算，占用率以工作时段（09:00–21:00）总容量分钟为分母，随 `rooms` 广播以 `roomStats` 类型下发。
  - 候补队列：时段冲突时用户可「加入候补」；当对应时段因他人取消 / 撤销被释放时，按先来先服务把候补第一位晋升为真实预约，
    并给晋升人推送 `roomWaitlistPromoted` 通知。候补必须对应当前被占用的时段，空闲时段应直接预约；同一用户对同一房间同一时段只保留一条候补。

- `room_waitlist`: `{ id, roomId, ownerAccount, ownerName, title, startAt, endAt, note, status, createdAt }`
  - 状态：`waiting`（候补中）/ `promoted`（已晋升，即转为真实预约）/ `cancelled`（已取消）/ `expired`（已过期）。

### 工具借用（tools）
- `tool`: `{ id, name, category, total, available, location, description }`
  - `category`: 测试电脑 / 测试机器 / 测试手机 / 其它
- `tool_borrow`: `{ id, toolId, borrowerAccount, borrowerName, qty, borrowedAt, dueAt?, returnedAt?, status }`
  - 状态：`borrowed` / `returned`
  - 借出时 `available -= qty`，归还时 `available += qty`；`available < qty` 不可借。
  - 默认归还期限为借出后 7 天（`dueAt`），借用人可「续借」延长 1-30 天；逾期由 `dueAt` 判定。

### 物资申领（materials）
- `material_request`: `{ id, requesterAccount, requesterName, name, qty, unit, reason, status, handlerAccount?, handlerName?, createdAt, handledAt? }`
  - 状态：`pending` / `fulfilled` / `cancelled`
  - 申请人或管理员可指派 `handlerAccount`（负责人）；申请人可取消自己的 `pending`。
  - 未指派时他人可将 `pending` 置为 `fulfilled`；已指派时由负责人或管理员处理。

### 报修（repairs）
- `repair`: `{ id, reporterAccount, reporterName, category, priority, location, description, status, handlerAccount?, handlerName?, createdAt, updatedAt }`
  - `category`: 厕所 / 灯光 / 空调 / 其它
  - `priority`: `high` / `normal` / `low`（默认 `normal`），上报人或管理员可调整。
  - 上报人或管理员可指派 `handlerAccount`（负责人）。
  - 状态流转：`reported` → `in_progress` → `resolved`；上报人可取消 `reported`。

### 访客登记（visitors）
- `visitor`: `{ id, hostAccount, hostName, visitorName, purpose, contact, expectedAt, arrivedAt, leftAt, status, createdAt, code }`
  - `purpose` 必填；`contact` / `expectedAt` 可选。
  - `code`：登记时自动生成的 6 位签到码（同空间唯一），访客到访时报码，由空间内成员核销（`visitorCheckin`）推进为 `arrived`。
  - 状态：`pending` → `arrived` → `left`；`pending` 可 `cancelled`；管理员可删除任意记录。
  - 归属人（host）或管理员可推进状态 / 删除；其他成员只读。

### 坑位看板（restroom / 原坑位雷达）
- 每个空间独立配置 `squat_count`（蹲坑）、`urinal_count`（尿槽）。
- `stall`: `{ id, type: squat|urinal, name, status: free|reserved|waiting|occupied, ratings, reservation }`
- `reservation`: 预约 / 抢位产生的占用记录，身份键用 **账号**（防多开）。
  - 倒计时：尿槽 1 分钟、蹲坑 5 分钟（抢位）；确认到坑有 `[startTime, startTime+5min]` 时间窗。
- 操作：`reserve / cancel / grab / startUse / finish / release / urge / rate / toggleEmergency`。
- 评分：干净度 / 信号 / 纸巾 1-5 整数校验，同一账号同一坑位只记一次。
- 战绩与排行榜：按时率、累计时长、抢位次数、蹲坑次数等；按空间 + 账号维度独立。
- 配置守卫：管理员 `stallConfig` 仅在不存在 `reserved/waiting/occupied` 坑位时可用，避免重配后在线用户的 `currentStall` 指向已删除坑位。

## 4. 通信协议

前端通过单向 WebSocket（`/ws`）与服务端通信，服务端广播全量列表。

### 客户端 → 服务端
| 类型 | 说明 | 角色 |
| --- | --- | --- |
| `join` | 进入空间（首步 / 切换） | - |
| `login` / `logout` | 账号+密码 或 token 恢复 / 退出 | - |
| `roomCreate` / `roomRemove` | 新增 / 删除会议室 | admin |
| `roomBook` | 预约会议室（含冲突检测），可带 `repeat`=`daily`/`weekly` + `repeatCount` 创建周期预约 | member |
| `reservationCancel` | 取消自己的单次预约 | owner |
| `reservationCancelSeries` | 取消自己的周期预约全部待开始场次 | owner |
| `roomWaitlist` / `roomWaitlistCancel` | 时段冲突时加入候补 / 取消自己的候补 | member / owner |
| `toolCreate` / `toolDelete` / `toolAdjust` | 增删设备 / 调整库存 | admin |
| `toolBorrow` / `toolReturn` / `toolExtend` | 借用 / 归还 / 续借设备 | member |
| `materialRequest` / `materialCancel` | 提交 / 取消申领 | member / owner |
| `materialAssign` | 指派申领负责人 | member / admin |
| `materialFulfill` | 处理申领为已满足 | 未指派时他人；已指派时负责人或管理员 |
| `repairCreate` | 提交报修（可带 `priority`） | member |
| `repairAssign` | 指派报修负责人 | reporter / admin |
| `repairUpdate` | 推进 / 取消报修状态，或调整 `priority` | member / owner / admin |
| `visitorCreate` / `visitorArrived` / `visitorLeft` / `visitorCancel` / `visitorRemove` / `visitorCheckin` | 访客登记与状态流转 / 删除 / 凭签到码核销 | member / host / admin |
| `profileUpdate` / `passwordChange` | 修改展示名、头像 / 修改密码 | member |
| `stallControl`（子类型 reserve/grab/startUse/finish/release/cancel/urge/rate/toggleEmergency） | 坑位看板全部操作 | member |
| `stallConfig` | 配置蹲坑 / 尿槽数量 | admin |
| `spaceRename` | 修改空间名 | admin |
| `spacePause` | 暂停 / 恢复空间（暂停预约 / 借用 / 申领 / 报修 / 访客登记） | admin |

### 服务端 → 客户端
`joined`、`loginSuccess`、`error`、`stats`，
以及 `rooms`（含 `rooms` / `reservations` / `waitlist` / `waitlistTotal`）、`tools`、`materials`、`repairs`、`visitors`、`stalls`、`users`、`leaderboard`（含 `account`、`role`、`display`），
另有 `roomStats`、`spacePaused`、`roomWaitlistPromoted` 等即时广播；分页加载使用 `fetchPage`（支持 `rooms` / `materials` / `repairs` / `visitors` / `borrows`）。

## 5. 前端

单页应用：左侧导航（概览 / 会议室 / 工具借用 / 物资申领 / 报修 / 访客登记 / 坑位看板），
个人资料入口位于侧栏底部；桌面与移动端响应式，原生 HTML/CSS/JS，无构建步骤；静态文件由 Express 托管；
会议室预约支持每天 / 每周周期预约（列表按 `seriesId` 聚合展示并整组取消）；
报修列表展示并可调整高 / 中 / 低优先级；空间暂停时顶部展示暂停横幅并限制对应创建操作；
物资 / 报修 / 访客 / 会议室预约 / 借用记录列表支持一键导出 CSV（自动拉取全部分页）。

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
- 可增长的列表（会议室预约、物资申领、报修）**实时广播只推最近 `LIST_PAGE` 条**并附带 `total`，
  前端按需「加载更多」；工具库存列表在广播中内联「当前在借」明细，规模可控。
- 新增 `fetchPage` 消息：`{type:'fetchPage', module, offset, limit}`，服务端返回
  `{type:'page', module, offset, items, total}`，当前支持 `rooms` / `materials` / `repairs` / `visitors` / `borrows` 五个分页模块，
  实现 offset/limit 分页，避免每次全量下发。
- 排行榜保留 TopN（30）；坑位评分保留最近 60 条。

### 写入与数据库
- **写合并去抖**：`saveProfile` / `saveEntity` 改为按主键合并、去抖批量 upsert（默认 500ms），
  降低并发下的写放大；单批按 500/1000 行分块写入，避免单条 SQL 参数数超过 PostgreSQL 的 65535 上限；
  停机（SIGTERM/SIGINT）前强制 flush。
- **在途写追踪**：`saveSpace` / `saveAccount` / `saveStallRating` / `deleteEntity` 等直接写库查询统一登记为
  在途 Promise；`flushWrites` 与优雅停机前先 `Promise.allSettled` 等待，避免进程退出时这些即时写丢失。
- **索引**：`entities(kind)`、`stall_ratings(space, stall_id)`、`stall_ratings(space, created_at)`，
  支撑分页与载入查询。
- **内存索引**：排行榜按空间维护 `profilesBySpace` 索引，避免每次广播全量扫描 profile；
  工具在借明细按设备预聚合 borrows，避免 tools×borrows 双重扫描。
- **历史数据清理**：每 15s 清理超过 7 天且已结束（`completed/cancelled/expired`）的会议室预约，
  同步删除内存 Map 与 `entities` 行，避免长期运行无界增长。
- **广播计算复用**：`roomReservationsPublic` 支持传入已构建的 `spaceUserInfo`，`broadcastAll` 与
  `fetchPage` 复用同一份在线用户信息，避免同一轮广播重复扫描。
- **评分缓存**：坑位段位 `stallTier` 按评分版本缓存结果，评分变化时失效，减少每次广播重复求和。
- 启动只做幂等建表 / 迁移，不销毁数据。

### 连接健康度
- WebSocket 心跳：每 30s ping，未回 pong 的连接被终止，防止异常断开的僵尸连接持续占用内存与广播带宽。
- 客户端断线自动重连并凭 token 恢复会话。
- 输入边界：HTTP JSON 解析限制为 1MB，WebSocket 单帧上限 64KB；解析失败返回 400，超大请求体返回 413。
- 登录限流：同一账号 60 秒内失败 5 次后短暂拒绝，成功登录清除失败计数。

### 运维
- 优雅停机：SIGTERM/SIGINT 触发 flush 待写、等待在途写、关闭连接与连接池。

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
| 周期预约 | 会议室支持每天 / 每周重复，一次预约自动展开全部场次，列表聚合展示并整组取消 | `roomBook`(repeat/repeatCount) / `reservationCancelSeries` |
| 指派负责人 | 物资申领 / 报修可指派空间内在线成员为负责人，列表展示并据此约束处理权限 | `materialAssign` / `repairAssign` |
| 报修优先级 | 报修可标记高 / 中 / 低优先级，列表突出显示并可调整 | `repairCreate`(priority) / `repairUpdate`(priority) |
| 空间暂停 | 管理员可暂停空间，全员暂停预约 / 借用 / 申领 / 报修 / 访客登记，顶部横幅提示 | `spacePause` |
| 工具续借 | 借用可延长归还期限（默认 7 天，可续借 1-30 天），列表展示应还日期与逾期状态 | `toolExtend` |
| 访客登记 | 登记访客姓名、事由、预计到访，负责人/管理员推进到访与离开，实时同步 | `visitorCreate` / `visitorArrived` / `visitorLeft` / `visitorCancel` / `visitorRemove` |
| 访客签到码 | 登记访客时自动生成 6 位签到码，访客到访时报码由空间成员核销为已到访，并向接待人推送通知 | `visitorCheckin` / `visitorCheckinNotification` |
| 个人资料 | 成员可改展示名/头像，并凭旧密码修改登录密码 | `profileUpdate` / `passwordChange` |
| 空间设置 | 管理员可修改空间名、配置蹲坑 / 尿槽数量 | `spaceRename` / `stallConfig` |
| 紧急模式 | 个人一键标记「紧急」，在线列表显示 🆘，方便他人避让 | `toggleEmergency` |
| 使用时长统计 | 归还设备 / 结束会议自动累计个人「借用时长」「会议时长」，概览与活跃榜展示 | 复用 `stats` + `leaderboard` |
| 电视墙大屏 | 独立只读页 `public/screen.html`，展示会议室「现在/接下来」+ 空间总览 + 坑位占用 + 公告 + 在线状态 + 访客待接待；支持全屏切换与多视图自动轮播（可暂停/手动切换） | 复用现有广播 |
| 每日看点 | 登录后推送今日要点：今天会议（含时长）、逾期借用、我的未还、待处理申领/报修、待接待访客、今日归还借用时长、本周之星 | 登录时下发 `digest` |
| 会议室候补 | 时段冲突时一键加入候补，他人取消后按先来先服务自动晋升为真实预约并通知 | `roomWaitlist` / `roomWaitlistCancel` / `roomWaitlistPromoted` |
| 借用记录导出 | 工具借用页一键导出全部借用记录 CSV（自动拉取分页） | 复用 `fetchPage`(`borrows`) |

### 客户端→服务端新增消息
`setStatus`、`announce`、`spaceRename`、`spacePause`、`suggestRoom`、`remindReturn`、`toolExtend`、`roomBook`(周期 `repeat`/`repeatCount`)、`reservationCancelSeries`、`roomWaitlist`、`roomWaitlistCancel`、`materialAssign`、`repairAssign`、`repairUpdate`(优先级)、`visitorCreate`、`visitorArrived`、`visitorLeft`、`visitorCancel`、`visitorRemove`、`visitorCheckin`、`profileUpdate`、`passwordChange`、`toggleEmergency`、`fetchPage`(`borrows` 等分页模块)；服务端相应广播/单发
`users`(含 `status`、`emergencyMode`) 、`notices`、`suggestRooms`、`borrowReminder`、`digest`、`visitors`、`spaceRenamed`、`spacePaused`、`roomWaitlistPromoted`、`rooms`(含 `waitlist`)、`visitorCheckinNotification`。

## 9. 代码架构（多模块拆分）

后端按领域拆分到 `src/`，`server.js` 只做组装，降低单文件维护成本：

```
server.js        入口：Express + WS 分发 + 定时器 + 心跳 + 优雅停机 + 启动
src/context.js   共享上下文：状态 + 常量 + 基础工具 + 持久化(写合并) + 认证 + 序列化 + 广播 + 坑位成就 + 每日看点
src/http.js      HTTP 路由：/api/spaces、/api/register
src/session.js   会话：进入/切换空间、登录（含 digest）
src/modules/     rooms / tools / materials / repairs / visitors / profile / stalls / extras（各领域处理函数）
```

- 各领域模块是纯函数工厂 `module.exports = (api)=>({...})`，由 `server.js` 注入共享上下文 `api`，无全局状态、便于单测。
- 定时器、心跳、优雅停机属于进程级关注点，保留在入口。
- 该拆分不改变任何对外协议与行为，e2e（122 项）在内存与 PostgreSQL 双模式下均通过。

## 10. 健康检查、自测与 CI（本版本新增）

- **健康检查**：`GET /api/health` 返回 `{ ok, pg, uptime, spaces, users, time }`，供探活、容器 `HEALTHCHECK` 与 CI 等待服务就绪。
- **npm 脚本**：
  - `npm start`：启动服务
  - `npm run lint`：对 `server.js` / `public` / `src/` / `test/` 全部 JS 执行 `node --check` 语法检查（`scripts/lint.js`）
  - `npm run test:unit`：单元测试（`test/unit.js`，直接断言 `createContext` 纯函数：ID 生成、周统计、坑位段位、成就解锁与进度、口令哈希、管理员判定、历史预约清理、段位缓存、访客序列化、每日看点、用户广播、会议室时长累计、周期预约展开、借用逾期判定、会议室占用率统计、报修优先级序列化、借用记录序列化、会议室候补序列化、访客签到码序列化、借用逾期提醒，78 项）
  - `npm run test:restore`：前端「自动恢复会话」回归测试（`test/restore.js`，vm stub 加载内联脚本，无需服务）
  - `npm run smoke`：快速冒烟（`test/smoke.js`）——健康检查、首页与大屏可达、WS 连接、登录、收到广播
  - `npm test`：单元测试 + `test:restore` + 完整 e2e（`test/test.js`，122 项）
- **CI**：`.github/workflows/ci.yml` 在 push 到 `main` 或 pull_request 时自动：`npm ci` → `npm run lint` → `docker compose config` 校验 → `docker build` 构建校验 → 内存模式启动服务 → `npm run smoke` → `npm test`。用不可达的 PG 参数强制内存模式，无需外部数据库。
- **环境变量**：见 `.env.example`（`PORT`、`PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE`）；`.env` 已加入 `.gitignore`。