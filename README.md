# 🏢 OfficeSpace · 办公空间管理

> 一个给办公室 / 部门 / 楼层 **共用一个空间** 的实时管理看板：会议室预约、测试工具借用、物资申领、物资库存、报修、访客登记、考勤打卡、工位预约、外出登记、请假审批、会议纪要、意见反馈、心情打卡、活动管理、投票、知识库、待办任务、通知中心、卫生间坑位看板、成就墙、我的待办、空间趋势，全部实时同步。

多人在同一局域网打开即可使用。由「坑位雷达」终极改造而来，沿用其账号体系、空间隔离、WebSocket 实时同步与 PostgreSQL 持久化方案。

详细设计与协议见 [docs/spec.md](docs/spec.md)。

---

## ✨ 功能一览

| 模块 | 说明 |
| --- | --- |
| 会议室预约 | 预约时段、自动冲突检测、改期（待开始可调整时段）、取消；逾期自动流转；支持每天 / 每周周期预约（自动展开全部场次并可整组取消）；开始/结束时记录实际到场时长并统计到场分钟数；概览展示会议室占用率与到场时长统计；管理员可为单间会议室开启「预约审批」：开启后新预约进入「待审批」，批准后自动变为「待开始」，驳回则取消并通知申请人；待审批超过 24 小时仍未处理会自动提醒管理员；会议结束后可给会议室多维度评分（环境 / 设备 / 服务，各 1-5 星 + 评价），并聚合总体分与维度分，成员可收藏会议室并按「我的收藏」过滤 |
| 工具借用 | 登记在库设备（测试电脑 / 测试机器 / 测试手机等），借用与归还、库存实时扣减、续借（最多 2 次）、到期提醒与排队（库存不足可排队，归还后自动晋升为借用），归还时登记完好/损坏/丢失状态，归还后自动推送归还公告留痕；借用时可自定义归还时间（≥30 分钟、≤90 天）；支持设置库存告急阈值，可用数跌破阈值自动标记「库存告急」并通知管理员，阈值恢复后可再次提醒 |
| 物资申领 | 提出需要电池等物资的请求，管理员可维护常用模板、成员选模板快捷提交；支持高/普通/低优先级并按优先级排序；可指派负责人，由同事/管理员处理，满足后记录处理时长 |
| 物资库存 | 登记办公文具、耗材等公共物资库存，成员按需领用并归还，自动扣减/恢复可用数；支持设置库存告急阈值，可用数跌破阈值自动标记「库存告急」并通知管理员，恢复后可再次提醒 |
| 报修 | 上报厕所 / 灯光 / 空调等故障，自动生成 `RP-日期-编号` 工单号，支持高/中/低优先级、指派负责人并推进状态，上报人/负责人/管理员可添加跟进评论（上门时间、配件进度等），同位置同类未处理工单自动识别为重复并拒绝重复提交，解决后记录处理时长；高优先级工单超过 8 小时未解决自动升级一次并提醒上报人与管理员 |
| 访客登记 | 登记访客姓名、事由、预计到访；负责人 / 管理员推进到访、离开、取消，实时同步；访客凭 6 位签到码到访核销，签到码 24 小时有效；同一接待人对同一访客当天重复登记会被识别并拒绝 |
| 工位预约 | 开放工位 / 共享座位的时段预约，实时占用；管理员可增删工位，成员预约时段、冲突检测、取消；支持「签到 / 签退」手动开始与结束并记录实际到场时间；概览展示工位占用率与热力时间轴，我的待办提醒临近工位 |
| 外出登记 | 登记外出 / 请假 / 出差 / 调休，同步在线状态与同事可见的「外出中」；可填写预计返回时间，到点前 30 分钟自动提醒本人；返回 / 取消自动恢复原状态，管理员可删除 |
| 请假审批 | 成员提交请假申请（事假 / 病假 / 年假 / 调休 / 婚假 / 产假 / 丧假 / 其他），同一时间只能有一条待审批申请；管理员可批准 / 驳回（可填驳回原因），全程留痕并单发通知申请人；待审批超过 24 小时未处理自动提醒管理员 |
| 会议纪要 | 把纪要挂到会议室预约上，成员可为未结束的预约创建纪要（标题 + 内容），作者或管理员可编辑 / 删除；按预约关联会议标题与会议室，统计总数与今日更新 |
| 意见反馈 | 成员可匿名 / 实名提「建议 / 吐槽 / 问题 / 表扬」，管理员回复后闭环；状态待处理 / 已回复 / 已关闭；统计待处理、已回复、已关闭数量 |
| 心情打卡 | 每天用 emoji 记录一次心情（😊/😐/😴/😡/🤩/🥲），同一账号每天只保留一条；概览展示今日心情分布与计数，团队氛围一目了然 |
| 活动管理 | 发起培训 / 分享会 / 团建 / 生日会 / 会议等空间活动，支持描述、地点、人数上限；成员 RSVP 参加 / 可能 / 不参加，名额满自动拒绝；活动开始前 10 分钟提醒主办与报名人；主办或管理员可取消，管理员可删除 |
| 投票 | 发起空间快速决策（午饭 / 办公改进 / 时间安排），2-5 个选项、可匿名、可设截止时间；单账号单票且可改投，截止前实时看票数，发起人或管理员可关闭，管理员可删除 |
| 知识库 | 沉淀规章制度 / 操作指引 / 设备说明 / 常见问题；按点赞数与时间排序，支持标题/内容/标签即时搜索；作者或管理员可编辑 / 删除，全员可点赞、发表评论与一级回复，点赞数贡献作者成就 |
| 待办任务 | 空间级任务看板：成员可发起、指派负责人、认领推进；支持高/普通/低优先级与截止时间，按优先级与截止时间排序；负责人可开始 / 完成 / 删除，创建人收到完成通知，创建人/负责人/管理员可评论跟进，新增「任务达人 / 高效执行」成就 |
| 通知中心 | 系统重要事件留痕（指派 / 完成 / 超时 / 提醒），全员可看、按人标记已读；侧栏实时展示未读数徽标，支持单条已读与一键全部已读 |
| 考勤打卡 | 上下班打卡；管理员可配置工作时间（默认 09:00-18:00）与迟到宽限（默认 15 分钟），迟到自动标记；连续打卡天数、全勤月数统计与出勤日历；每日统计打卡人数、迟到人数、已下班人数与下班完成率，概览与每日看点同步展示 |
| 坑位看板 | 卫生间坑位实时占用、预约、抢位、催促、三维评分，含排行榜与成就 |
| 我的待办 | 聚合「我的逾期借用 / 临近会议 / 待接待访客 / 指派给我的申领与报修 / 临近工位 / 外出中」，一键刷新 |
| 空间趋势 | 近 7 / 14 / 30 天会议室、借用、申领、报修、访客、考勤、工位、外出、活动、投票十类活动量柱状图 |
| 空间周报 | 每周一 09:00 自动汇总本周活动量（会议 / 借用 / 申领 / 报修 / 访客、考勤、工位、外出、活动、投票、已解决工单、待处理清单、库存告急设备）并广播全员、写入公告 |
| 个人资料 | 成员可改展示名 / 头像，凭旧密码修改登录密码 |
| 空间设置 | 管理员可改空间名、配置蹲坑 / 尿槽数量、授予 / 取消其他成员管理员（至少保留一名）、移除在线成员，并可暂停空间（暂停预约 / 借用 / 申领 / 报修 / 访客登记） |
| 数据导出 | 物资申领 / 报修 / 访客 / 会议室预约 / 借用记录一键导出 CSV（自动拉取全部分页） |
| 趣味扩展 | 心情状态灯、一键喊话公告（支持 👍 / 🎉 / 😮 / 🤝 / 🔥 回应）、每日心情打卡（团队氛围看板）、每周之星 MVP、坑位段位传说榜、设备催还与占用王榜、一键智能选房、电视墙大屏（全屏 / 自动轮播）、每日看点、紧急模式、使用时长统计、成就墙（27 项成就进度与解锁徽章，含早到达人 / 打卡达人 / 工位达人 / 外出报备达人 / 倾听达人 / 活动主办 / 活动达人 / 决策发起人 / 参与决策者 / 知识贡献者 / 知识之星 / 任务达人 / 高效执行 / 连续打卡达人） |

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
├── server.js                # 入口：Express + WS 分发 + 定时器 + 心跳 + 停机 + 启动
├── src/                     # 后端逻辑按领域拆分
│   ├── context.js           # 共享上下文：状态/工具/持久化/认证/序列化/广播
│   ├── http.js              # HTTP 路由（/api/health、/api/spaces、/api/register）
│   ├── session.js           # ws 会话：进入/切换空间、登录
│   └── modules/             # 业务模块
│       ├── rooms.js         # 会议室
│       ├── tools.js         # 工具借用
│       ├── materials.js     # 物资申领
│       ├── inventory.js    # 物资库存台账
│       ├── repairs.js       # 报修
│       ├── visitors.js     # 访客登记
│       ├── attendance.js   # 考勤打卡
│       ├── desks.js        # 工位预约
│       ├── ooo.js          # 外出登记
│       ├── leaves.js      # 请假审批
│       ├── meetingNotes.js  # 会议纪要
│       ├── feedback.js    # 意见反馈
│       ├── mood.js        # 心情打卡
│       ├── events.js       # 活动管理
│       ├── polls.js        # 投票
│       ├── knowledge.js     # 知识库
│       ├── tasks.js         # 待办任务
│       ├── notifications.js # 通知中心
│       ├── profile.js      # 个人资料
│       ├── stalls.js        # 坑位看板
│       └── extras.js        # 状态灯/公告/智能选房/催还
├── public/
│   ├── index.html           # 前端单页应用入口（含 app.js / styles.css）
│   ├── app.js                # 前端逻辑（拆分自 index.html）
│   ├── styles.css            # 前端样式（拆分自 index.html）
│   ├── screen.html          # 电视墙大屏入口（含 screen.js / screen.css）
│   ├── screen.js             # 大屏逻辑（拆分自 screen.html）
│   └── screen.css            # 大屏样式（拆分自 screen.html）
├── test/
│   ├── test.js              # 端到端测试（覆盖六模块+扩展功能，需先启动服务）
│   ├── restore.js           # 前端会话恢复回归测试（vm stub，无需服务）
│   └── smoke.js             # 快速冒烟测试（健康检查/页面/WS/登录）
├── scripts/
│   └── lint.js              # 语法检查（node --check 全量）
├── .github/workflows/
│   └── ci.yml               # push/PR 自动跑 lint + smoke + e2e
├── docs/
│   └── spec.md              # 产品/数据模型/协议/性能/架构设计规格
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example
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

### 方式二：Docker（推荐，含 PostgreSQL 持久化）

```bash
docker compose up -d --build
# 打开 http://localhost:3000
```

`docker-compose.yml` 会一并拉起应用 + PostgreSQL（`office/office_pass`/库 `office`），数据持久化到 `office-pgdata` 卷，重启容器不再丢数据。容器内置 `HEALTHCHECK`（基于 `/api/health`），`docker inspect` 可查看健康状态。

### 可选：连接 PostgreSQL

默认尝试连接 `127.0.0.1:5432`（用户 `postgres`、库 `toilet`、密码 `toilet_dev`）。连接失败自动切到内存模式，不影响功能。可通过环境变量覆盖（示例见 `.env.example`）：

```
PORT / PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE
```

健康检查：`GET /api/health` 返回 `{ ok, pg, uptime, spaces, users, time }`，可用于探活或 CI 等待服务就绪。

> 说明：PostgreSQL 持久化「空间 / 账号 / 战绩 / 评分 / 会议室 / 工具 / 申领 / 报修」；
> 运行状态（坑位占用、在线用户）实时保存在内存并由 WebSocket 广播。重启不再清空历史数据。

---

## 🧪 运行测试

```bash
# 先在一个终端启动服务
npm start

# 另开一个终端跑测试
npm run lint          # 语法检查（无需启动服务）
npm run test:unit     # 单元测试（纯函数，无需启动服务）
npm run test:restore  # 前端回归测试（会话恢复 + CSV 导出，无需启动服务）
npm run smoke         # 快速冒烟（需服务已启动）
npm test              # 单元 + 会话恢复回归 + 完整 e2e（e2e 需服务已启动）
```

包含单元测试（ID 生成 / 周统计 / 坑位段位 / 成就解锁与进度 / 口令哈希 / 管理员判定 / 历史预约清理 / 段位缓存 / 访客序列化 / 每日看点 / 我的待办 / 用户广播 / 会议室时长累计 / 周期预约展开 / 借用逾期判定 / 会议室占用率统计 / 报修优先级序列化 / 借用记录序列化 / 工具在借明细序列化 / 工具排队序列化 / 会议室候补序列化、访客签到码序列化、借用逾期提醒 / 会议室开始前提醒 / 借用到期前提醒 / 访客预计到访提醒 / 报修 SLA 超时提醒 / 申领 SLA 超时提醒 / 报修升级提醒 / 报修重复检测 / 管理员成员管理 / 通知统一入口 / 报修处理时长统计 / 会议室评分聚合 / 收藏会议室、低库存预警、空间周报、成就扩展、物资库存台账、考勤打卡、物资优先级序列化、意见反馈序列化、工位签到字段与心情序列化、待办任务序列化、通知中心序列化、考勤连续打卡、考勤出勤日历、请假审批序列化与统计、会议纪要序列化与统计、请假审批 SLA 提醒，329 项），以及会议室（冲突检测 / 取消 / 改期 / 周期预约 / 候补晋升 / RBAC / 智能选房 / 占用率统计 / 开始前提醒 / 人数校验 / 冲突建议 / 实际到场时长统计 / 预约审批（含催办与候补晋升） / 多维度评分与收藏）、工具借用（借用 / 不足 / 归还 / 续借次数上限 / 逾期催还 / 批量催还 / 到期前提醒 / 归还时长统计 / 借用记录分页 / 排队晋升 / 归还公告 / 完好损坏丢失归还状态 / 自定义归还期限 / 低库存预警 / 库存阈值校验）、物资申领（提交 / 指派 / 优先级 / 自处理限制 / 负责人处理 / 指派与满足通知 / SLA 超时提醒 / 处理人计入后勤达人 / 常用模板）、报修（状态流转 / 优先级 / 指派 / 跟进评论 / 越权取消 / 处理中与解决通知 / SLA 超时提醒 / 升级 / 重复检测 / 处理时长 / 解决人计入后勤达人 / RP 工单号）、访客登记（登记 / 状态流转 / 签到码核销与有效期 / 到访与离开通知 / 预计到访提醒 / 越权 / 管理员删除 / 当天重复登记检测）、考勤打卡（规则配置 / 上班打卡 / 迟到判定 / 重复打卡 / 下班打卡 / 连续打卡 / 出勤日历 / 统计 / 越权配置）、工位预约（创建 / 预约冲突 / 统计广播 / 签到签退 / 实际到场时间）、外出登记（登记 / 同步在线状态 / 我的待办聚合 / 返回 / 取消 / 删除）、请假审批（提交 / 取消 / 重复提交拒绝 / 成员审批 RBAC / 批准 / 驳回与原因 / 单发通知）、意见反馈（匿名提交 / 越权回复 / 管理员回复 / 关闭）/心情打卡（提交 / 更新 / 统计）、活动管理（创建 / RSVP / 名额满 / 取消 / 管理员删除）、投票（创建 / 投票 / 改投 / 匿名 / 关闭 / 删除）、知识库（发布 / 点赞 / 搜索 / 编辑 / 删除 / 评论与一级回复）、待办任务（创建 / 指派 / 开始 / 完成 / 删除 / 评论 / 通知）、通知中心（通知到达 / 未读 / 单条已读 / 全部已读）、个人资料（改名头像 / 改密 / 旧密码校验）、空间设置（改名 / RBAC / 暂停恢复 / 管理员成员管理 / 成员移除）、紧急模式，坑位看板（预约时间窗、评分越界、重复评分、同账号多开限制、切换空间守卫、重配守卫、段位）、成就墙（27 项成就进度与解锁状态，含办公向、后勤向、会议室向导、收藏家、早鸟、打卡达人、工位达人、外出报备达人、倾听达人、活动主办、活动达人、决策发起人、参与决策者、知识贡献者、知识之星、任务达人、高效执行、连续打卡达人）、公告管理（管理员删除公告 / 👍🎉😮🤝🔥 回应）、我的待办（逾期借用 / 临近会议 / 待接待访客 / 指派任务 / 临近工位 / 外出中聚合）、空间趋势（近 7/14/30 天十类活动量）、空间周报、物资库存台账，以及分页、状态灯、公告、每周之星 MVP、每日看点、借用导出 CSV、低库存预警、库存阈值校验等 **379 项 e2e 断言**。push 到 `main` 或提 PR 时，CI（`.github/workflows/ci.yml`）会自动执行 lint + compose 校验 + docker 构建 + smoke + e2e。

---

## 🔌 交互协议简述

前端通过 WebSocket（`/ws`）与服务端通信；先 `join` 进入空间，再 `login`（账号+密码 或 token 恢复会话）。业务消息统一按类型下发：

| 模块 | 客户端→服务端消息 |
| --- | --- |
| 会议室 | `roomCreate` / `roomTag`(admin) / `roomApproval`(admin) / `roomRemove`(admin) · `roomBook` · `reservationCancel` · `reservationCancelSeries` · `reservationApprove`(admin) / `reservationReject`(admin) · `reservationReschedule` · `roomRate`(环境/设备/服务) · `roomFavorite` |
| 工具借用 | `toolCreate` / `toolDelete` / `toolAdjust`(admin，可带 `minAvailable`) · `toolBorrow`(可带 `dueAt`) / `toolReturn`(可带 condition) / `toolExtend` |
| 物资申领 | `materialRequest`(可带 templateId) / `materialCancel` / `materialFulfill` / `materialAssign` / `materialUpdate`(改优先级) · `materialTemplateCreate` / `materialTemplateDelete`(admin) |
| 物资库存 | `inventoryCreate` / `inventoryDelete` / `inventoryAdjust`(admin，可带 `minAvailable`) · `inventoryIssue` / `inventoryReturn` |
| 报修 | `repairCreate` / `repairUpdate`(状态+优先级) / `repairAssign` / `repairComment`(跟进评论) |
| 工位预约 | `deskCreate` / `deskDelete`(admin) · `deskReserve` / `deskCancel`(owner) · `deskStart` / `deskEnd`(owner) |
| 外出登记 | `oooCreate` / `oooBack` / `oooCancel` / `oooRemove`(admin) |
| 请假审批 | `leaveCreate` · `leaveCancel`(owner) · `leaveApprove` / `leaveReject`(admin，可带 `decideNote`) |
| 会议纪要 | `meetingNoteCreate` · `meetingNoteEdit`(author/admin) · `meetingNoteRemove`(author/admin) |
| 意见反馈 | `feedbackCreate` · `feedbackReply` / `feedbackClose` / `feedbackRemove`(admin) |
| 心情打卡 | `moodCheckIn` |
| 活动管理 | `eventCreate`(admin) · `eventRsvp` / `eventCancel`(owner/admin) · `eventRemove`(admin) |
| 投票 | `pollCreate`(admin) · `pollVote` · `pollClose`(owner/admin) · `pollRemove`(admin) |
| 知识库 | `knowledgeCreate` · `knowledgeEdit`(author/admin) · `knowledgeDelete`(author/admin) · `knowledgeLike` · `knowledgeComment`(支持 `parentId` 一级回复) |
| 待办任务 | `taskCreate`(可指派 assigneeAccount) · `taskAssign`(creator/admin) · `taskUpdate`(creator/assignee/admin) · `taskStart` / `taskComplete`(assignee/creator/admin) · `taskRemove`(creator/admin) · `taskComment`(creator/assignee/admin) |
| 通知中心 | `notificationRead`(单条已读) · `notificationReadAll`(全部已读) |
| 访客登记 | `visitorCreate` / `visitorArrived` / `visitorLeft` / `visitorCancel` / `visitorRemove` / `visitorCheckin` |
| 考勤打卡 | `attendCheckIn` / `attendCheckOut` · `attendConfig`(admin，可配工作时间与迟到宽限) · `getAttendanceCalendar`(出勤日历 + 连续打卡) |
| 个人资料 | `profileUpdate` / `passwordChange` |
| 空间设置 | `spaceRename` · `stallConfig`(admin) · `spacePause`(admin 暂停/恢复) · `spaceAdminSet`(admin 授予/取消管理员) · `spaceKick`(admin 移除成员) |
| 公告回应 | `noticeReact` / `noticeUnreact`（👍 / 🎉 / 😮 / 🤝 / 🔥，再次点击同表情取消） |
| 坑位看板 | `reserve` / `cancel` / `grab` / `startUse` / `finish` / `release` / `urge` / `rate` / `toggleEmergency` · `stallConfig`(admin) |

服务端广播全量列表：`rooms`、`tools`、`materials`、`inventory`、`repairs`、`stalls`、`attendance`、`desks`、`ooo`、`leaves`、`meetingNotes`、`feedback`、`events`、`polls`、`knowledge`、`tasks`、`notifications`、`users`、`leaderboard`（均含 `account` 身份、`role`、`display`），并另有 `roomStats`、`deskStats`、`spacePaused`、`toolLowStock`、`inventoryLowStock`、`weeklyReport`、`attendanceCalendar`、`leaveCreated`、`leaveApproved`、`leaveRejected`、`leaveSla`、`meetingNoteCreated`、`meetingNoteUpdated` 等即时广播。分页加载使用 `fetchPage`（支持 `rooms` / `materials` / `repairs` / `visitors` / `borrows` / `feedback` / `tasks`）。

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