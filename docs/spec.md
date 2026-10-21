# OfficeSpace · 办公空间管理 — 设计规格

> 由「坑位雷达」终极改造而来：沿用其账号体系、空间隔离、WebSocket 实时同步与
> PostgreSQL 持久化方案，把领域从「卫生间」升级为「办公空间」的多功能管理平台。

## 1. 产品定位

办公室 / 部门 / 楼层 **共用一个空间** 的内部管理看板，多人在同一局域网或集群内实时共用。
一个 `space` 即代表一个办公室（或一层楼、一个组织）的公共资源单元。围绕十类高频需求：

1. **会议室预约** —— 预约时段、冲突检测、取消，并提供会议室占用率统计。
2. **测试工具借用** —— 登记在库设备（测试电脑 / 测试机器 / 测试手机等）的借出与归还。
3. **物资申领** —— 提出是否需要电池等物资的请求，支持优先级，并由同事/管理员处理。
4. **报修** —— 上报厕所、灯光、空调等设施故障，支持优先级并推进状态，可添加跟进评论。
5. **坑位看板**（原「坑位雷达」）—— 卫生间坑位实时占用 / 预约 / 抢位 / 催促 / 评分。
6. **考勤打卡** —— 上下班打卡，管理员可配置工作时间与迟到宽限，自动判定迟到并统计。
7. **工位预约** —— 开放工位 / 共享座位的时段预约，签到签退并记录实际到场时长。
8. **外出登记** —— 外出 / 请假 / 出差 / 调休登记，同步在线状态与预计返回提醒。
9. **意见反馈** —— 匿名 / 实名提交建议、吐槽、问题、表扬，管理员回复后闭环。
10. **心情打卡** —— 每天用 emoji 记录一次心情，查看团队今日氛围分布。

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
- `room`: `{ id, name, capacity, location, description, tags?, equipment?, requireApproval, minMinutes, maxMinutes, maintenanceUntil? }`
  - `equipment`: 会议室固定设备清单（如投影 / 白板 / 电视 / 电话），最多 10 项、每项 ≤12 字符、去重保序；预约时可勾选实际使用设备，服务端仅保留会议室已有设备并写入预约 `equipment`。
  - `maintenanceUntil`: 维护截止时间戳（毫秒），维护期间 `roomPublic` 输出 `maintenance=true`，预约会被拒绝；管理员可设置或 `clear` 解除。
- `room_reservation`: `{ id, roomId, ownerAccount, title, startAt, endAt, note, status, repeat?, seriesId?, seriesIndex?, participants?, attendees?, attendedAccounts?, actualStartAt?, actualEndAt?, rating?, ratingComment?, ratedAt?, equipment? }`
  - 状态：`pending`(已约) / `pending_approval`(待审批) / `active`(进行中) / `completed` / `cancelled` / `expired`
  - 约束：同一房间在 `[startAt, endAt)` 内不得与他人预约重叠（冲突检测）。
  - 时长限制：每间会议室可配置 `minMinutes`（默认 5）与 `maxMinutes`（默认 720），预约时长必须落在区间内；超出返回 `roomDuration` 错误。
  - 评分：会议结束（`completed`）后，预约人或管理员可对会议室做环境 / 设备 / 服务三维评分（各 1-5 分，可选评价 ≤60 字），同一会议只评一次；也兼容单 `score` 一次性三维度同分。总体分取三维度平均并四舍五入，会议室平均分与评分数、维度分由 `roomRatingSummary` 聚合，随 `rooms` 广播（`room.rating = { avg, count, dimensions, ratings }`）。
  - 会议室洞察：`roomInsights` 聚合 `roomRatingSummary` 生成评分口碑榜（仅含 ≥1 条评分，按平均分降序）与使用率排行（按今日场次 + 今日分钟数降序），随 `rooms` 广播下发 `insights`，辅助选址与容量规划。
  - 周期预约：`repeat` 为 `daily` / `weekly`（或省略表示单次），`repeatCount` 限制场次（每天 ≤ 90、每周 ≤ 52）；
    创建时按天 / 周展开为多条独立预约，共用 `seriesId`，可整体取消待开始场次。
  - 收藏：成员可收藏会议室，`profiles.stats.favoriteRooms` 记录收藏房间 id，前端「我的收藏」快捷过滤。
  - 预约审批：管理员可对单间会议室开启 `requireApproval`；开启后新预约状态为 `pending_approval`，并产生一条 `roomApprovalRequested` 通知（管理员可见）。管理员可批准（`reservationApprove`）将状态改为 `pending`，或驳回（`reservationReject`）改为 `cancelled`；申请人收到 `reservationApproved` / `reservationRejected` 单发消息。`pending_approval` 预约计入时段冲突检测与待开始统计，申请人也可自行取消（`reservationCancel`）。待审批超过 `ROOM_APPROVAL_SLA_MS`（默认 24 小时）仍未处理时，定时器向管理员单发 `roomApprovalPending` 催办（按 `approvalRemindedAt` 去重）。候补晋升若命中 `requireApproval` 会议室，晋升后的预约同样进入 `pending_approval`。
  - 占用率统计：按「今日会议场次 / 今日会议分钟数 / 待开始场次」计算，占用率以工作时段（09:00–21:00）总容量分钟为分母，随 `rooms` 广播以 `roomStats` 类型下发。
  - 实际到场时长：预约开始（手动 `roomStart` 或定时器自动开始）时记录 `actualStartAt`，结束（手动 `roomEnd` 或定时器自动结束）时记录 `actualEndAt`；两者差值即实际到场时长，累计计入 `stats.meetingActualDuration`，`roomStats` 按「今日到场分钟数」展示，序列化时对外暴露 `actualStartAt` / `actualEndAt`。
  - 会议准时率：开始会议时比较 `actualStartAt - startAt`，若不超过 `MEETING_ONTIME_GRACE_MS`（默认 5 分钟）则 `stats.meetingOnTime + 1`，否则 `stats.meetingLate + 1`；排行榜每行返回 `meetingOnTimeRate`（准时次数 / 总开始次数 × 100%），活跃榜展示「准时 X%」，累计准时 5 次解锁「会议守时」成就（独立于坑位守时 `consecutiveOnTime`）。
  - 参会人名单与到场确认：预约可填写 `attendees`（账号数组，≤50 人，仅校验为该空间在线成员，去重、忽略空值）；预约创建 / 改参会人时清空已不在名单中的已到场记录；`reservationAttendees` 供预约人（或管理员）在会议开始前修改名单。会议开始（`roomStart`）时向全部参会人单发 `meetingStarted`；参会人在会议 `active` 时通过 `meetingAttend` 确认到场，写入 `attendedAccounts` 并广播；序列化对外暴露 `attendees` / `attendedAccounts` / `attendanceRate`（到场数 / 参会人数 × 100%，无参会人时为 0）。
  - 改期：待开始（`pending`）预约可调整时段（`reservationReschedule`），校验所有权（本人或管理员）、时段合法性（≥5 分钟且开始时间在当前之后）与冲突（排除自身）；成功后更新时段并广播。
  - 候补队列：时段冲突时用户可「加入候补」；当对应时段因他人取消 / 撤销被释放时，按先来先服务把候补第一位晋升为真实预约，
    并给晋升人推送 `roomWaitlistPromoted` 通知。候补必须对应当前被占用的时段，空闲时段应直接预约；同一用户对同一房间同一时段只保留一条候补。

- `room_waitlist`: `{ id, roomId, ownerAccount, ownerName, title, startAt, endAt, note, status, createdAt }`
  - 状态：`waiting`（候补中）/ `promoted`（已晋升，即转为真实预约）/ `cancelled`（已取消）/ `expired`（已过期）。

### 我的日程（my schedule）
- 聚合当前用户未来 N 天的日程：自己的会议室预约、工位预约、活动（作为组织者或已 RSVP「参加」）、已批准请假，按 `startAt` 升序排列，对外输出 `{ days, items[] }`。
- `items` 每项含 `{ id, type, module, title, startAt, endAt, room, location, status }`；`type` 为 `meeting` / `desk` / `event` / `leave`，前端「我的日程」按日期分组展示。
- 查询消息 `getMySchedule`，服务端返回 `mySchedule`，前端按 7 / 14 / 30 天切换。

### 工具借用（tools）
- `tool`: `{ id, name, category, total, available, minAvailable, location, description }`
  - `category`: 测试电脑 / 测试机器 / 测试手机 / 其它
  - `minAvailable`: 库存告急阈值（默认 1），`available <= minAvailable` 视为库存告急（`toolsPublic` 输出 `lowStock`）
- `tool_borrow`: `{ id, toolId, borrowerAccount, borrowerName, qty, borrowedAt, dueAt?, returnedAt?, status, extensions?, condition? }`
  - 状态：`borrowed` / `returned`
  - 借出时 `available -= qty`，归还时 `available += qty`；`available < qty` 不可借。
  - 默认归还期限为借出后 7 天（`dueAt`），借用人可「续借」延长 1-30 天；`extensions` 记录已续借次数，最多 2 次，逾期由 `dueAt` 判定。
  - 自定义归还期限：借用时可带 `dueAt`（至少晚于当前时间 30 分钟、最长 90 天），用于特殊设备临时借用。
   - 归还状态：归还时登记 `condition`（`intact` 完好 / `damaged` 损坏 / `missing` 丢失，默认 `intact`）；`missing` 不恢复可用数并扣减总数，`damaged` 仍恢复可用数但记录损坏。
   - 库存告急：借用 / 归还 / 调整库存后同步计算 `lowStock`；可用数跌破 `minAvailable` 时首次向管理员下发 `toolLowStock` 并写入公告，恢复后清除通知标记，以便下次再次跌破时重新提醒。
   - 设备洞察：`toolInsights` 聚合借用记录生成「借用热度榜」（Top 5 设备，按累计借用次数 + 在借数降序）、「归还状态统计」（`intact` / `damaged` / `missing` 分布与损坏率 / 丢失率）与「在借 / 逾期概览」（`activeCount` / `overdueCount`），随 `tools` 广播下发 `insights`，辅助库存与采购规划。
- `tool_waitlist`: `{ id, toolId, account, name, qty, status, createdAt, promotedAt?, borrowId? }`
  - 状态：`waiting`（排队中）/ `promoted`（已晋升为借用）。
  - 库存不足（`qty > available`）时可加入排队；归还或调整库存释放库存后，按先来先服务把第一位晋升为真实借用，并向该成员推送 `toolWaitlistPromoted` 通知，同一人对同一设备只保留一条排队。

### 物资库存台账（inventory）
- `inventory`: `{ id, name, category, unit, total, available, minAvailable, location, description }`
  - `category`: 办公文具 / 打印耗材 / 电池 / 清洁用品 / 食品饮料 / 其它
  - `unit`: 计量单位（个 / 节 / 盒等）
  - `minAvailable`: 库存告急阈值（默认 1），`available <= minAvailable` 视为库存告急（`inventoryPublic` 输出 `lowStock`）
- `inventory_issue`: `{ id, itemId, itemName, issuerAccount, issuerName, qty, status, createdAt, returnedAt?, dueAt }`
  - 状态：`issued`（在领）/ `returned`（已归还）
  - 领用后 `available -= qty`，默认 3 天后归还；归还后 `available += qty`（不超过 `total`）。
  - 库存告急：领用 / 归还 / 调整库存后同步计算 `lowStock`；首次跌破阈值时向管理员下发 `inventoryLowStock` 并写入公告，恢复后重置提醒标记。

### 钥匙 / 门禁卡（keys）
- `key`: `{ id, name, category, security, total, available, location, description }`
  - `category`：工卡 / 钥匙 / 门禁卡 / 登记薄 / 其它（`KEY_CATEGORIES`）。
  - `security`：`low`（普通，可直接借用）/ `high`（高安全，需管理员审批后借用）。
- `key_request`: `{ id, keyId, account, qty, status, securityCode, borrowedAt, dueAt, returnedAt, condition, approvedBy, approvedAt, createdAt, lastRemindedAt }`
  - 状态：`pending`（待审批）/ `borrowed`（在借）/ `rejected`（已驳回）/ `returned`（已归还）。
  - 高安全钥匙申请进入 `pending`，管理员 `keyApprove` 后变为 `borrowed` 并自动设置 3 天归还期限；`keyReject` 则置为 `rejected`。
  - 归还登记 `condition`（`intact` 完好 / `damaged` 损坏 / `missing` 丢失，默认 `intact`）；`missing` 不恢复可用数且自动扣减总数，并向管理员推送 `keyMissing` 通知。
  - 逾期催还：管理员可 `remindKeyOverdue` 一次性提醒所有逾期未还的钥匙，按 `lastRemindedAt` 去重避免重复刷屏。

### 冰箱 / 食品（fridge）
- `fridge_item`: `{ id, name, category, total, available, minAvailable, unit, expiryDate, location, note }`
  - 管理员登记共享冰箱物品；`minAvailable` 为库存告急阈值（默认 1）。
  - `fridgeTake` 扣减 `available`；`fridgeRestock` 增加 `total` 与 `available`；`fridgeReturn` 恢复 `available`（不超过 `total`）。
  - 库存告急：`available <= minAvailable` 时对外输出 `lowStock`，首次跌破阈值向管理员推送 `fridgeLowStock` 通知。
- `fridge_log`: `{ id, itemId, account, qty, type, at }`
  - `type`：`take`（取用）/ `restock`（补货）/ `return`（归还），最近 30 条公开。

### 车辆 / 停车位（parking）
- `parking_spot`: `{ id, name, type, total, available, location, note }`
  - `type`：`standard`（普通）/ `disabled`（无障碍）/ `ev`（充电）/ `reserved`（固定）。
- `parking_reservation`: `{ id, spotId, account, plateNumber, date, startAt, endAt, status, checkedInAt, checkedOutAt, createdAt }`
  - 状态：`reserved`（待签到）/ `checked_in`（已停放）/ `cancelled`（已取消）/ `checked_out`（已驶离）。
  - 预约时校验 `available >= 1` 与同一车位同一天 `[startAt, endAt)` 的时段冲突；预约成功后 `available -= 1`。
  - `spotCancel` 仅待签到可取消并释放车位；`spotCheckin` / `spotCheckout` 由预约人或管理员操作，签出后 `available += 1`。
  - 删除车位前校验该车位无 `reserved` / `checked_in` 预约。

### 包裹 / 快递（parcels）
- `parcel`: `{ id, recipientAccount, recipientName?, courier, trackingNumber?, remark?, status, expectedAt?, pickedAt?, returnedAt?, createdAt, lastRemindedAt? }`
  - 状态：`incoming`（待取）/ `picked`（已取）/ `returned`（已退回）/ `cancelled`（已取消）。
  - `parcelCreate` 由管理员登记，收件人须在当前空间；`parcelPick` 本人或管理员可领取（非本人的普通成员被拒）。
  - `parcelReturn` / `parcelCancel` 仅管理员可操作且仅限 `incoming`。
  - 逾期催收：`parcelRemind` 一次性提醒所有 `incoming` 且已过 `expectedAt`、尚未提醒过的包裹收件人，按 `lastRemindedAt` 去重。
  - 待取 / 已取 / 退回 / 取消 / 逾期统计由 `parcelStats` 聚合。

### 储物柜 / 寄存（lockers）
- `locker`: `{ id, name, type, total, available, location?, note? }`
  - `type`：`regular`（普通）/ `valuable`（贵重）/ `temporary`（临时）。
- `locker_reservation`: `{ id, lockerId, account, status, createdAt, checkedInAt?, checkedOutAt?, dueAt?, returnedAt?, lastRemindedAt? }`
  - 状态：`reserved`（待签到）/ `checked_in`（已使用）/ `checked_out`（已归还）/ `cancelled`（已取消）。
  - `lockerCreate` / `lockerDelete` 由管理员维护；预约时校验 `available >= 1`，成功后 `available -= 1`。
  - `lockerReserve` / `lockerCancel` / `lockerCheckin` / `lockerCheckout` 由本人或管理员操作；签退或取消后 `available += 1`。
  - 删除储物柜前校验该柜无 `reserved` / `checked_in` 预约。
  - 逾期催还：`lockerRemind` 一次性提醒所有逾期未处理的预约（`dueAt` 已过且未提醒），按 `lastRemindedAt` 去重。

### 用车 / 公务车辆（vehicles）
- `vehicle`: `{ id, name, plateNumber, type, seats, location?, note?, maintenance, createdAt }`
  - `type`：`sedan`（轿车）/ `suv`（SUV）/ `van`（商务车）/ `bus`（中巴）；`maintenance` 为保养中标记。
- `vehicle_reservation`: `{ id, vehicleId, account, date, startAt, endAt, purpose?, driver?, status, mileageStart?, mileageEnd?, checkedInAt?, checkedOutAt?, createdAt }`
  - 状态：`reserved`（待出车）/ `checked_in`（行驶中）/ `checked_out`（已归还）/ `cancelled`（已取消）。
  - `vehicleCreate` / `vehicleUpdate` / `vehicleDelete` 由管理员维护；删除前校验该车无 `reserved` / `checked_in` 预约。
  - `vehicleReserve` 校验保养状态与**同车同日** `[startAt, endAt)` 时段冲突（活动状态重叠即拒绝）；`vehicleCancel` / `vehicleCheckin` / `vehicleCheckout` 由本人或管理员操作。
  - `vehicleCheckin` 需登记出发里程，`vehicleCheckout` 需登记返回里程并校验不小于出发、单次不超 5000 公里，记录实际行驶公里数。

### 物资申领（materials）
- `material_request`: `{ id, requesterAccount, requesterName, name, qty, unit, reason, priority, status, handlerAccount?, handlerName?, createdAt, handledAt? }`
  - 状态：`pending` / `fulfilled` / `cancelled`
  - `priority`：`high` / `normal` / `low`（默认 `normal`），列表按优先级排序，申请人或管理员可通过 `materialUpdate` 调整。
  - 申请人或管理员可指派 `handlerAccount`（负责人）；申请人可取消自己的 `pending`。
  - 未指派时他人可将 `pending` 置为 `fulfilled`；已指派时由负责人或管理员处理。
- `material_template`: `{ id, name, defaultQty, defaultUnit, defaultReason, createdAt }`
  - 管理员可维护常用物资模板；成员提交申领时可选模板自动填充名称、数量、单位与说明。

### 报修（repairs）
- `repair`: `{ id, code, reporterAccount, reporterName, category, priority, location, description, status, handlerAccount?, handlerName?, createdAt, updatedAt, escalatedAt?, comments[], satisfaction?, satisfactionComment?, satisfiedAt? }`
  - `category`: 厕所 / 灯光 / 空调 / 其它
  - `priority`: `high` / `normal` / `low`（默认 `normal`），上报人或管理员可调整。
  - 上报人或管理员可指派 `handlerAccount`（负责人）。
  - 状态流转：`reported` → `in_progress` → `resolved`；上报人可取消 `reported`。
  - `comments[]`：跟进评论数组（最多 30 条）；每条 `{ id, account, name, text, createdAt }`，列表暴露 `commentCount` 与最近 20 条（倒序）。
  - `satisfaction` / `satisfactionComment` / `satisfiedAt`：仅 `resolved` 的报修可被评价；上报人或管理员可打 1-5 星并留评（最多 60 字），评价后不再允许重复评价，形成处理结果反馈闭环。
  - 满意度统计：`repairsStats` 聚合已解决报修的满意度，输出平均满意度（`avgSatisfaction`）、满意度分布（`distribution`，1-5 星计数）、低分工单数（`lowSatisfaction`，≤2 星）、平均处理时长（`avgHandledMinutes`）、故障类别分布（`byCategory`）与高频故障位置（`hotspots`，同一位置已解决 ≥2 次取 Top 3），随 `repairs` 广播下发 `stats`，帮助管理员识别反复故障的隐患点。
  - `code`：提交时生成的 `RP-YYYYMMDD-XXXX` 工单号，列表、导出 CSV 与重复报修提示中均可引用。
  - 跟进评论权限：上报人、负责人或管理员可添加；评论用于记录上门时间、配件进度、处理结果等跟进信息。
  - 升级：高优先级（`high`）报修超过 8 小时仍未解决（`reported` / `in_progress`）时自动升级一次，向上报人与所有管理员发送 `repairEscalated` 提醒，避免关键工单被漏掉。

### 访客登记（visitors）
- `visitor`: `{ id, hostAccount, hostName, visitorName, purpose, contact, expectedAt, arrivedAt, leftAt, status, createdAt, code }`
  - `purpose` 必填；`contact` / `expectedAt` 可选。
  - `code`：登记时自动生成的 6 位签到码（同空间唯一），访客到访时报码，由空间内成员核销（`visitorCheckin`）推进为 `arrived`。
  - 状态：`pending` → `arrived` → `left`；`pending` 可 `cancelled`；管理员可删除任意记录。
  - 归属人（host）或管理员可推进状态 / 删除；其他成员只读。

### 考勤打卡（attendance）
- `space.attendanceConfig`: `{ workStart, workEnd, lateMinutes }`（默认 `09:00` / `18:00` / `15` 分钟），管理员通过 `attendConfig` 配置。
- `space.attendance`: `Map<`账号::日期` => attendance_record>`，每天每人一条。
- `attendance_record`: `{ id, account, name, date, checkInAt, checkOutAt, isLate, status, workedMinutes }`
  - 上班打卡（`attendCheckIn`）创建记录并判定迟到；当天已有打卡时拒绝重复打卡。
  - 下班打卡（`attendCheckOut`）记录下班时间与工作时长（`workedMinutes`），当天已下班时拒绝重复。
  - 迟到判定：打卡时刻的「分钟数」≥ `workStart` 分钟数 + `lateMinutes`（即宽限 15 分钟时，09:15 起算迟到）。
  - 统计：`attendanceStats` 汇总今日打卡人数、迟到人数、已下班人数、最早打卡、最晚下班、下班完成率与迟到率，随 `attendance` 广播下发。
  - 战绩：打卡计入 `stats.attendanceCount`（累计打卡次数）、非迟到打卡计入 `stats.earlyCount`；周报与空间趋势新增 `attends` 指标。
  - 成就：「早到达人」（9 点前打卡累计 3 天）与「打卡达人」（累计打卡 10 次）。

### 工位预约（desks）
- `desk`: `{ id, name, location, description }`，管理员增删。
- `desk_reservation`: `{ id, deskId, account, name, startAt, endAt, note, status, actualStartAt?, actualEndAt? }`
  - 状态：`pending`(待开始) / `active`(进行中) / `completed` / `cancelled` / `expired`
  - 约束：同一工位在 `[startAt, endAt)` 内不得重叠（冲突检测）；开始时间须晚于当前时间；时长 ≥ 10 分钟。
  - 签到 / 签退：`deskStart` 把 `pending` 流转为 `active` 并记录 `actualStartAt`；`deskEnd` 把 `active` 流转为 `completed` 并记录 `actualEndAt`；二者均仅预约人或管理员可操作。
  - 自动流转：到点后（`now >= endAt`）定时器把过期的 `pending` 预约标记为 `completed`，避免「进行中」悬挂；超过 7 天的历史预约由 `pruneDeskReservations` 清理。
  - 统计：`deskUsageStats` 计算今日预约场次、今日分钟数、待开始数与占用率（以工作时段 09:00–21:00 总容量分钟为分母），随 `deskStats` 广播下发；序列化暴露 `todayCount` / `upcomingCount` / `todayMinutes`。
  - 战绩与成就：预约计入 `stats.deskCount` 与周报 `desks`；「工位达人」（预约工位累计 5 次）。

### 外出登记（ooo）
- `ooo`: `{ id, account, name, category, reason, startAt, expectedReturnAt?, endAt?, status, returnRemindedAt? }`
  - `category`: 外出 / 请假 / 出差 / 调休 / 其他。
  - 状态：`active`（外出中）/ `back`（已返回）/ `cancelled`（已取消）；管理员可删除任意记录。
  - 约束：同一账号同时只能有一条 `active` 记录；预计返回时间须晚于当前时间。
  - 在线状态同步：`active` 期间把成员在线状态标签覆盖为外出类别（出差 ✈️ / 请假 📅 / 其他 🚶），返回 / 取消后恢复 `prevStatus`。
  - 预计返回提醒：填写 `expectedReturnAt` 后，到点前 30 分钟内单发提醒一次（`oooReturnSoon`），避免漏回。
  - 战绩与成就：登记计入 `stats.oooCount` 与周报 `ooo`；「外出报备达人」（外出登记累计 5 次）。

### 请假审批（leaves）

成员提交请假申请，管理员批准 / 驳回，与「外出登记」互补：外出登记用于即时状态同步，请假审批用于长期假期留痕与审批。

- `leave`: `{ id, account, name, category, reason, startAt, endAt, status, createdAt, decidedAt?, decidedBy?, decideNote? }`
  - `category`: 事假 / 病假 / 年假 / 调休 / 婚假 / 产假 / 丧假 / 其他（`LEAVE_CATEGORIES`）。
  - `status`: `pending`（待审批）/ `approved`（已批准）/ `rejected`（已驳回）/ `cancelled`（已取消）。
- 约束：同一账号同时只能有一条 `pending` 记录；请假开始时间必须晚于当前时间，且 `endAt > startAt`。
- 权限：成员提交与取消自己的申请；仅管理员批准 / 驳回，驳回可填 `decideNote`（≤120）。
- 广播与单发：`leaves`（含 `leaves` / `total` / `stats`）全量广播；`leaveCreated`（管理员收到新申请）；`leaveApproved` / `leaveRejected` 单发申请人；待审批超过 SLA（24 小时）仍未处理时 `leaveSla` 提醒管理员（按 `slaRemindedAt` 去重，避免刷屏）。
- 批量审批：`leaveBatchApprove` / `leaveBatchReject`（仅管理员）一次性批准 / 驳回全部待审批申请，逐条记录审批人与单发通知申请人。
- 统计：`leavesStats` 返回 `pendingCount` / `todayCount` / `approvedCount` / `rejectedCount`，随 `leaves` 广播下发。

### 会议纪要（meeting notes）

成员把纪要挂到会议室预约上，与会议室预约通过 `reservationId` 关联。一个预约最多保留一条纪要，重复创建转为更新。

- `meeting_note`: `{ id, reservationId, title, content, account, name, createdAt, updatedAt }`
  - `title` 必填、≤120；`content` 必填、≤2000（`MEETING_NOTE_MAX_LEN`）。
  - 关联的会议室预约需存在，序列化补充 `meetingTitle` 与 `roomName` 便于展示。
- 权限：成员创建；作者或管理员编辑 / 删除。
- 广播：`meetingNotes`（含 `notes` / `stats`）全量广播；同一预约重复创建发 `meetingNoteUpdated`；管理员收到 `meetingNoteCreated`。
- 统计：`meetingNotesStats` 返回 `total` / `todayCount`，随 `meetingNotes` 广播下发。

### 值班排班（duty roster）

管理员按日期安排环境 / 接待 / 值班 / 其它类别的公共事务，成员完成或调换值班，避免公共事务漏排漏做。

- `duty`: `{ id, date, account, name, category, note, status, createdAt, completedAt?, reminderAt? }`
  - `date`: `YYYY-MM-DD`（本地日期，与 `todayKey` 口径一致）。
  - `category`: 环境 / 接待 / 值班 / 其它（`DUTY_CATEGORIES`）。
  - `status`: `assigned`（待完成）/ `completed`（已完成）。
  - 唯一约束：同一成员同一天只能有一条未完成（`assigned`）值班。
- 权限：`dutyAssign` 仅管理员；`dutyComplete` / `dutySwap` / `dutyCancel` 为值班人或管理员。
  - 调换 `dutySwap` 只能转给同空间成员，且不能调换给自己。
- 广播：`duties`（含 `records` / `stats`）全量广播；`dutyAssigned` / `dutySwapped` 单发通知被操作成员，`dutyCompleted` / `dutyCancelled` 确认回执。
- 统计：`dutyStats` 返回 `total` / `todayCount` / `todayCompleted` / `upcomingCount`。
- 提醒：每日对 `assigned` 且未提醒的值班按 `dueDutyReminders` 提醒一次（`reminderAt` 按天去重）。
- 成就与统计：完成值班累计 `stats.dutyCount` 与 `stats.helperCount`，记录周报 `duties`；累计 5 次解锁「值日达人」成就。

### 意见反馈（feedback）
- `feedback`: `{ id, account, name, anonymous, category, content, status, replies[], createdAt, handledAt? }`
  - `category`: 建议 / 吐槽 / 问题 / 表扬；`anonymous` 为真时对外作者显示「匿名成员」。
  - 状态：`open`（待处理）/ `answered`（已回复）/ `closed`（已关闭）。
  - `replies[]`: 管理员回复 `{ id, account, name, content, createdAt }`；回复后状态置为 `answered` 并记录 `handledAt`；已关闭不可继续回复。
  - 权限：成员提交，仅管理员回复 / 关闭 / 删除。
  - 成就：「倾听达人」（回复反馈累计 3 条）。

### 心情打卡（mood）
- `mood`: `{ id, account, name, date, emoji, createdAt }`
  - `emoji`：😊 / 😐 / 😴 / 😡 / 🤩 / 🥲 之一。
  - 约束：同一账号每天只能保留一条心情，重复打卡覆盖更新。
  - 序列化：`moodPublic` 仅返回今日记录并按展示名排序；`moodStats` 统计今日总人数与各 emoji 计数，随 `mood` 广播下发。

### 活动管理（events）
- `event`: `{ id, title, description, category, location, startAt, endAt, hostAccount, hostName, capacity, rsvps, cancelled, reminded, remindAt, createdAt }`
  - `category`: 培训 / 分享会 / 团建 / 生日会 / 会议 / 其它；`location` 可选。
  - `rsvps`: 对象映射 `{ account: 'going' | 'maybe' | 'not_going' }`（对象可 JSON 持久化）。
  - 约束：`startAt < endAt` 且开始时间晚于当前；活动未开始前可变更 RSVP，`going` 受 `capacity` 限制（名额满拒绝新参加）。
  - 状态由序列化实时计算：`upcoming / ongoing / ended / cancelled`（不落库，避免定时器依赖）。
  - 提醒：`remindAt = startAt - 10min`，定时器对未提醒且未开始的活动发送一次 `eventReminder` 给主办与所有报名人。
  - 权限：成员可发起；仅主办或管理员可取消；仅管理员可删除。
  - 成就：「活动主办」（举办 3 次）、「活动达人」（参加 5 次）。

### 投票（polls）
- `poll`: `{ id, question, options[], anonymous, creatorAccount, creatorName, status, createdAt, deadline, votes }`
  - `options[]`: `{ id, text }`，2-5 个；`votes` 对象映射 `{ account: optionId }`（对象可 JSON 持久化）。
  - 约束：单账号单票，截止前可改投；`deadline` 可选。
  - 状态：`open / closed`；序列化对 `closed` 与「超过 `deadline`」均标记 `closed` 并停止投票。
  - 权限：成员可发起；仅发起人或管理员可关闭；仅管理员可删除。
  - 成就：「决策发起人」（发起 3 次）、「参与决策者」（参与 5 次）。

### 知识库（knowledge）
- `knowledge`: `{ id, title, content, category, tags[], authorAccount, authorName, likes[], comments[], createdAt, updatedAt }`
  - `category`: 规章制度 / 操作指引 / 设备说明 / 常见问题 / 其他；`tags[]` 最多 10 个、单标签 ≤12 字。
  - `likes[]`: 点赞账号数组（数组可 JSON 持久化）；按点赞数降序、再按时间降序排序。
  - `comments[]`: 评论数组（最多 50 条）；每条 `{ id, account, name, text, createdAt, parentId, parentName }`，`parentId` 为空表示顶级评论，否则为一级回复，回复不可继续嵌套。
  - 权限：成员可发布；作者或管理员可编辑 / 删除；全员可点赞 / 取消点赞、发表评论与回复（回复仅针对顶级评论）。
  - 成就：「知识贡献者」（发布 3 篇）、「知识之星」（获得 10 赞，点赞计入文章作者）。

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
| `roomCreate` / `roomTag` / `roomEquipment` / `roomMaintenance` / `roomApproval` / `roomRemove` | 新增 / 编辑标签 / 设置设备清单 / 设置或解除维护 / 开启或关闭预约审批 / 删除会议室 | admin |
| `roomBook` | 预约会议室（含冲突检测），可带 `repeat`=`daily`/`weekly` + `repeatCount` 创建周期预约；可带 `equipment` 勾选实际使用设备（仅保留会议室已有设备）；会议室开启审批时预约进入 `pending_approval` | member |
| `reservationCancel` | 取消自己的单次预约（`pending` 或 `pending_approval`） | owner |
| `reservationReschedule` | 改期自己的（或管理员代改）待开始预约 | owner / admin |
| `reservationCancelSeries` | 取消自己的周期预约全部待开始场次（含 `pending_approval`） | owner |
| `reservationApprove` / `reservationReject` | 批准 / 驳回处于 `pending_approval` 的预约 | admin |
| `roomWaitlist` / `roomWaitlistCancel` | 时段冲突时加入候补 / 取消自己的候补 | member / owner |
| `roomRate` | 给已结束的会议评分：`scores = { environment, equipment, service }`（各 1-5），兼容单 `score`；总体分取平均 | owner / admin |
| `roomFavorite` | 收藏 / 取消收藏会议室 | member |
| `toolCreate` / `toolDelete` / `toolAdjust` | 增删设备 / 调整库存（`toolAdjust` 可带 `minAvailable` 修改库存告急阈值） | admin |
| `toolBorrow` / `toolReturn` / `toolExtend` / `toolWaitlist` | 借用（可带 `dueAt` 自定义归还时间） / 归还 / 续借设备 / 库存不足时排队 | member |
| `inventoryCreate` / `inventoryDelete` / `inventoryAdjust` | 维护物资库存（增删 / 调整库存与告急阈值） | admin |
| `inventoryIssue` / `inventoryReturn` | 领用物资 / 归还物资 | member / owner / admin |
| `materialRequest` / `materialCancel` | 提交 / 取消申领（提交可带 `templateId` 使用模板，可带 `priority` 设置优先级） | member / owner |
| `materialUpdate` | 调整申领优先级（`high` / `normal` / `low`） | requester / admin |
| `materialTemplateCreate` / `materialTemplateDelete` | 管理员维护常用物资模板 | admin |
| `materialAssign` | 指派申领负责人 | member / admin |
| `materialFulfill` | 处理申领为已满足 | 未指派时他人；已指派时负责人或管理员 |
| `repairCreate` | 提交报修（可带 `priority`，返回 `code` 工单号） | member |
| `repairAssign` | 指派报修负责人 | reporter / admin |
| `repairUpdate` | 推进 / 取消报修状态，或调整 `priority` | member / owner / admin |
| `repairComment` | 添加报修跟进评论（`repairId` + `text`） | reporter / handler / admin |
| `repairRate` | 对已解决报修打 1-5 星满意度并留评（`repairId` + `satisfaction` + `satisfactionComment`） | reporter / admin |
| `visitorCreate` / `visitorArrived` / `visitorLeft` / `visitorCancel` / `visitorRemove` / `visitorCheckin` | 访客登记与状态流转 / 删除 / 凭签到码核销 | member / host / admin |
| `deskCreate` / `deskDelete` | 新增 / 删除工位 | admin |
| `deskReserve` / `deskCancel` | 预约工位（含冲突检测）/ 取消自己的预约 | member / owner |
| `deskStart` / `deskEnd` | 工位签到 / 签退，记录实际到场起止 | owner / admin |
| `oooCreate` / `oooBack` / `oooCancel` / `oooRemove` | 外出登记 / 返回 / 取消 / 删除 | member / owner / admin |
| `leaveCreate` / `leaveCancel` | 提交请假申请 / 取消自己的待审批申请 | member / owner |
| `leaveApprove` / `leaveReject` | 批准 / 驳回（可带 `decideNote`） | admin |
| `leaveBatchApprove` / `leaveBatchReject` | 一键批准 / 驳回全部待审批（`leaveBatchReject` 可带 `decideNote`） | admin |
| `meetingNoteCreate` | 为会议室预约创建会议纪要（同一预约重复创建转为更新） | member |
| `meetingNoteEdit` / `meetingNoteRemove` | 编辑 / 删除自己的纪要（管理员也可） | author / admin |
| `feedbackCreate` | 提交反馈（可匿名） | member |
| `feedbackReply` / `feedbackClose` / `feedbackRemove` | 回复 / 关闭 / 删除反馈 | admin |
| `moodCheckIn` | 提交 / 更新今日心情（emoji） | member |
| `eventCreate` | 发起活动（含 `category` / `location` / `startAt` / `endAt` / `capacity`） | member |
| `eventRsvp` | 活动 RSVP（`going` / `maybe` / `not_going`） | member |
| `eventCancel` / `eventRemove` | 取消自己的活动 / 删除活动 | owner / admin |
| `pollCreate` | 发起投票（`question` / `options[]` / 可选 `deadline` / `anonymous`） | member |
| `pollVote` | 投票或改投（`optionId`） | member |
| `pollClose` / `pollRemove` | 关闭自己的投票 / 删除投票 | owner / admin |
| `knowledgeCreate` | 发布知识文章（`title` / `content` / `category` / `tags[]`） | member |
| `knowledgeEdit` / `knowledgeDelete` | 编辑 / 删除文章 | author / admin |
| `knowledgeLike` / `knowledgeComment` | 点赞 / 评论文章（`knowledgeComment` 可带 `parentId` 对顶级评论做一级回复） | member |
| `attendCheckIn` / `attendCheckOut` | 上班 / 下班打卡 | member |
| `attendConfig` | 配置工作时间与迟到宽限 | admin |
| `profileUpdate` / `passwordChange` | 修改展示名、头像 / 修改密码 | member |
| `stallControl`（子类型 reserve/grab/startUse/finish/release/cancel/urge/rate/toggleEmergency） | 坑位看板全部操作 | member |
| `stallConfig` | 配置蹲坑 / 尿槽数量 | admin |
| `spaceRename` | 修改空间名 | admin |
| `spacePause` | 暂停 / 恢复空间（暂停预约 / 借用 / 申领 / 报修 / 访客登记） | admin |
| `noticeReact` / `noticeUnreact` | 对公告点赞/回应（👍 / 🎉 / 😮 / 🤝 / 🔥），再次点击同表情可取消 | member |
| `keyCreate` / `keyUpdate` / `keyDelete` | 维护钥匙 / 门禁卡台账 | admin |
| `keyRequest` / `keyApprove` / `keyReject` / `keyReturn` | 借用申请（高安全需审批）/ 批准 / 驳回 / 归还 | member / admin / owner |
| `remindKeyOverdue` | 一次性提醒所有逾期未还钥匙 | member |
| `fridgeItemCreate` / `fridgeItemDelete` | 登记 / 删除冰箱物品 | admin |
| `fridgeTake` / `fridgeRestock` / `fridgeReturn` | 取用 / 补货 / 归还冰箱物品 | member / admin / owner |
| `spotCreate` / `spotDelete` | 新增 / 删除停车位 | admin |
| `spotReserve` / `spotCancel` / `spotCheckin` / `spotCheckout` | 预约 / 取消 / 签到 / 签退停车位 | member / owner / admin |
| `parcelCreate` | 登记到柜包裹（收件人 / 快递 / 运单号） | admin |
| `parcelPick` | 领取包裹（自己 / 管理员代领） | member / owner / admin |
| `parcelReturn` / `parcelCancel` / `parcelRemind` | 标记退回 / 取消 / 一键催收逾期 | admin |
| `lockerCreate` / `lockerDelete` | 新增 / 删除储物柜 | admin |
| `lockerReserve` / `lockerCancel` / `lockerCheckin` / `lockerCheckout` / `lockerRemind` | 预约 / 取消 / 签到 / 签退 / 一键催还逾期储物柜 | member / owner / admin |
| `vehicleCreate` / `vehicleUpdate` / `vehicleDelete` | 新增 / 编辑 / 删除公司车辆 | admin |
| `vehicleReserve` / `vehicleCancel` / `vehicleCheckin` / `vehicleCheckout` | 按时间段借用 / 取消 / 出车（登记里程）/ 还车（登记里程） | member / owner / admin |
| `spaceSearch` | 全局检索（会议室 / 设备 / 申领 / 报修 / 待办 / 知识库 / 公告 / 资产 / 人员），返回 `searchResults` | member |

### 服务端 → 客户端
`joined`、`loginSuccess`、`error`、`stats`，
以及 `rooms`（含 `rooms` / `reservations` / `waitlist` / `waitlistTotal`）、`tools`、`materials`（含 `requests` / `templates`）、`repairs`、`visitors`、`stalls`、`attendance`（含 `records` / `stats` / `config`）、`desks`（含 `desks` / `reservations` / `reservationTotal`）、`deskStats`、`ooo`（含 `records` / `stats`）、`leaves`（含 `leaves` / `total` / `stats`）、`meetingNotes`（含 `notes` / `stats`）、`feedback`（含 `records` / `stats`）、`mood`（含 `records` / `stats`）、`events`（含 `events` / `total` / `stats`）、`polls`（含 `polls` / `total` / `stats`）、`knowledge`（含 `knowledge` / `total` / `stats`）、`tasks`（含 `tasks` / `total` / `stats`）、`notifications`（含 `notifications` / `total` / `unreadCount`）、`users`、`leaderboard`（含 `account`、`role`、`display`）、`keys`（含 `keys` / `stats` / `requests`）、`fridge`（含 `items` / `stats` / `logs`）、`parking`（含 `spots` / `stats` / `reservations`）、`parcels`（含 `parcels` / `total` / `stats`）、`lockers`（含 `lockers` / `stats` / `reservations`）、`vehicles`（含 `vehicles` / `stats` / `reservations`）、`searchResults`（含 `q` / `hits`），
另有 `roomStats`、`spaceTrend`、`mySchedule`、`roomWaitlistPromoted`、`roomRated`、`roomFavorites`、`repairEscalated`、`repairRated`、`toolLowStock`、`inventoryLowStock`、`weeklyReport`、`attendanceCheckedIn`、`attendanceCheckedOut`、`attendanceCalendar`、`eventReminder`、`eventRsvpChanged`、`pollVoted`、`pollClosed`、`knowledgeLiked`、`knowledgeCommented`、`taskCreated`、`taskAssigned`、`taskCompleted`、`taskCommented`、`leaveCreated`、`leaveApproved`、`leaveRejected`、`leaveSla`、`meetingNoteCreated`、`meetingNoteUpdated`、`keyRequest`、`keyApproved`、`keyRejected`、`keyMissing`、`keyOverdueReminder`、`fridgeLowStock`、`parcelArrived`、`parcelPicked`、`parcelReturned`、`parcelOverdueReminder`、`lockerOverdueReminder`、`parcelRemindSent`、`lockerRemindSent` 等即时广播，另有 `oooBacked`、`oooReturnSoon`、`moodCheckedIn`；全量广播含 `inventory`、`keys`、`fridge`、`parking`、`parcels`、`lockers`、`vehicles`（物资库存台账 / 钥匙门禁 / 冰箱食品 / 车辆停车位 / 包裹快递 / 储物柜寄存 / 用车申请，随 `broadcastAll` 下发）；分页加载使用 `fetchPage`（支持 `rooms` / `materials` / `repairs` / `visitors` / `borrows` / `feedback` / `events` / `polls` / `knowledge` / `tasks`）。

## 5. 前端

单页应用：左侧导航（概览 / 会议室 / 工具借用 / 物资申领 / 物资库存 / 报修 / 访客登记 / 考勤打卡 / 工位预约 / 外出登记 / 请假审批 / 会议纪要 / 意见反馈 / 心情打卡 / 活动管理 / 投票 / 知识库 / 待办任务 / 通知中心 / 坑位看板 / 我的日程 / 空间趋势 / 资产台账 / 钥匙门禁 / 冰箱食品 / 车辆停车 / 包裹快递 / 储物柜 / 用车申请），
个人资料入口位于侧栏底部；桌面与移动端响应式，原生 HTML/CSS/JS，无构建步骤；静态文件由 Express 托管；
会议室预约支持每天 / 每周周期预约（列表按 `seriesId` 聚合展示并整组取消）；
会议室卡片展示设备清单徽标与「维护中」标记；管理员可为会议室设置设备清单、维护时段（维护期间不可预约）；预约时可勾选实际使用设备（仅保留会议室已有设备）；
报修列表展示工单号 `RP-日期-编号` 并可调整高 / 中 / 低优先级；空间暂停时顶部展示暂停横幅并限制对应创建操作；
物资申领支持管理员维护常用模板、成员选模板快捷提交；物资库存支持管理员维护台账、成员领用/归还与库存告急标记；公告支持 👍 / 🎉 / 😮 / 🤝 / 🔥 回应并可取消；
物资 / 报修 / 访客 / 会议室预约 / 借用记录列表支持一键导出 CSV（自动拉取全部分页）；
会议室卡片展示平均评分与维度分（环境 / 设备 / 服务），成员可收藏会议室并在「我的收藏」中过滤；已结束的会议可一键三维评分（各 1-5 星 + 评价）；报修列表展示「已升级」标记；
我的日程按日期分组展示未来会议 / 工位 / 活动 / 请假；工位预约支持热力时间轴与「签到 / 签退」按钮，成员可查看今日工位占用与占用率；外出登记同步在线状态、同事可见外出中与预计返回时间；意见反馈支持匿名 / 实名提交与管理员回复闭环；物资申领支持设置高 / 普通 / 低优先级并一键调整；心情打卡支持 emoji 选择与今日心情分布看板；钥匙门禁支持普通 / 高安全分类、借用审批与丢失告警；冰箱食品支持物品登记、取用 / 补货 / 归还与库存告急；车辆停车支持车位类型、时段预约、签到 / 签退与车牌登记。

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
  `{type:'page', module, offset, items, total}`，当前支持 `rooms` / `materials` / `repairs` / `visitors` / `borrows` / `feedback` 六个分页模块，
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

### SQL 查询审计（本版本）
- 权威运行状态保存在进程内存，SQL 只做「持久化透写」与「启动装载」，没有按单条业务查询分页的需求；业务列表分页（`fetchPage`）在内存完成 offset/limit。
- 写路径已按主键合并、去抖批量 upsert（默认 500ms），单批 500/1000 行分块，避免单条 SQL 参数数超过 PostgreSQL 的 65535 上限。
- 启动装载一次性 `SELECT` 全量 `entities` / `spaces` / `accounts` / `profiles` / `stall_ratings`，对办公室/楼层规模可接受；若未来实体规模增长，可改为按空间/时间分页装载。
- 并发一致性：工具库存扣减、坑位 `activeStallCount`、会议室时段冲突检测均在单线程事件循环内完成「检查-执行」，无竞态丢更新；写失败静默降级为内存，不影响可用性。

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
| 后勤达人成就 | 处理物资申领（满足）或解决报修累计 5 次解锁「后勤达人」徽章，奖励实际协作处理而非仅提交的人 | 复用 `stats` + `achievements`（`helperCount`） |
| 设备催还与占用王榜 | 借用超过 7 天标记「逾期」，他人可一键提醒借用人归还；逾期列表即「占用王榜」 | `remindReturn` |
| 一键智能选房 | 按时段+人数自动列出空闲会议室并推荐 | `suggestRoom` |
| 周期预约 | 会议室支持每天 / 每周重复，一次预约自动展开全部场次，列表聚合展示并整组取消 | `roomBook`(repeat/repeatCount) / `reservationCancelSeries` |
| 指派负责人 | 物资申领 / 报修可指派空间内在线成员为负责人，列表展示并据此约束处理权限 | `materialAssign` / `repairAssign` |
| 报修优先级 | 报修可标记高 / 中 / 低优先级，列表突出显示并可调整 | `repairCreate`(priority) / `repairUpdate`(priority) |
| 报修重复检测 | 同一空间内同类型 + 同位置且仍未处理/取消的报修视为重复，提交时拒绝并提示先处理旧单，避免重复工单 | `repairCreate`(返回 `duplicateRepair` 错误) |
| 报修/申领处理时长统计 | 报修解决、申领满足时记录 `handledAt`，列表与 CSV 导出处理时长，每日看点新增「今日已解决报修 / 已满足申领」计数 | 复用 `repairs` / `materials` / `digest` |
| 管理员成员管理 | 管理员可在空间设置中授予 / 取消其他在线成员的管理员角色，至少保留一名管理员；角色变更实时广播并通知当事人 | `spaceAdminSet` / `adminSet` |
| 成员移除 | 管理员可移除空间内在线成员，清理其坑位占用后强制下线并写入公告留痕；不能移除自己或最后一名管理员 | `spaceKick` / `spaceKicked` |
| 报修 SLA 超时提醒 | 报修超过 4 小时仍未处理（reported）时，提醒上报人与管理员跟进，只提醒一次 | 服务端下发 `repairSla` |
| 申领 SLA 超时提醒 | 申领超过 48 小时仍未处理（pending）时，提醒申请人与管理员跟进，只提醒一次 | 服务端下发 `materialSla` |
| 申领/报修状态通知 | 申领被指派/满足、报修被指派/进入处理中/解决时，单发通知申请人与负责人，闭环反馈 | 服务端下发 `materialAssigned` / `materialFulfilled` / `repairAssigned` / `repairInProgress` / `repairResolved` |
| 空间暂停 | 管理员可暂停空间，全员暂停预约 / 借用 / 申领 / 报修 / 访客登记，顶部横幅提示 | `spacePause` |
| 工具续借 | 借用可延长归还期限（默认 7 天，可续借 1-30 天），同一借用最多续借 2 次，列表展示应还日期、逾期状态与剩余续借次数 | `toolExtend` |
| 借用归还状态 | 归还设备时登记「完好 / 损坏 / 丢失」；丢失不恢复库存总数，损坏仍恢复可用但记录状态，归还公告同步标注状态 | `toolReturn`(condition) |
| 报修工单编号 | 报修提交时生成 `RP-YYYYMMDD-XXXX` 工单号，列表、CSV 导出与重复报修提示均引用 | `repairCreate` / `repairs` |
| 物资常用模板 | 管理员维护常用物资模板，成员提交时可选模板自动填充名称、数量、单位与说明 | `materialTemplateCreate` / `materialTemplateDelete` / `materialRequest`(templateId) |
| 公告回应 | 公告支持 👍 / 🎉 / 😮 / 🤝 / 🔥 回应，再次点击同表情取消，回应实时广播 | `noticeReact` / `noticeUnreact` |
| 访客重复登记 | 同一接待人对同一访客当天已有待到访/已到访记录时拒绝重复登记，避免同一访客重复占用接待资源 | `visitorCreate`(返回 `duplicateVisitor` 错误) |
| 工具排队 | 库存不足时加入排队，归还或调整库存释放库存后按先来先服务自动晋升为借用并通知排队人 | `toolWaitlist` / `toolWaitlistPromoted` |
| 借用归还通知 | 归还设备后自动向空间公告一条「已归还设备 ×数量」通知，资产归还留痕、全员可见 | 复用 `pushNotice`（服务端下发 `notices`） |
| 会议室评分 | 会议结束后给会议室做环境 / 设备 / 服务三维 1-5 分并留评价，聚合总体分与维度分 | `roomRate` / `rooms`(含 `room.rating`) |
| 收藏会议室 | 成员收藏常用会议室，前端「我的收藏」快捷过滤，收藏随个人资料持久化 | `roomFavorite` / `roomFavorites` |
| 会议室预约审批 | 管理员可对单间会议室开启审批；新预约进入「待审批」，批准转「待开始」、驳回取消并通知申请人；超时未处理自动催办管理员；候补晋升也遵守审批 | `roomApproval` / `reservationApprove` / `reservationReject` / `roomApprovalPending` / `reservationApproved` / `reservationRejected` |
| 报修升级 | 高优先级报修超过 8 小时未解决自动升级一次，提醒上报人与管理员，避免漏单 | `repairEscalated` |
| 报修满意度评分 | 已解决的报修，上报人/管理员可打 1-5 星并留评（最多 60 字），形成处理结果反馈闭环，评价后不可重复评价 | `repairRate` / `repairRated` |
| 自定义归还期限 | 借用设备时可指定特殊归还时间（≥30 分钟、≤90 天），默认 7 天不变 | `toolBorrow`(dueAt) |
| 访客登记 | 登记访客姓名、事由、预计到访，负责人/管理员推进到访与离开，实时同步 | `visitorCreate` / `visitorArrived` / `visitorLeft` / `visitorCancel` / `visitorRemove` |
| 访客签到码 | 登记访客时自动生成 6 位签到码，访客到访时报码由空间成员核销为已到访，并向接待人推送通知 | `visitorCheckin` / `visitorCheckinNotification` |
| 访客到访/离开通知 | 管理员或接待人推进访客到访 / 离开时，向登记接待人单发通知，闭环反馈 | 服务端下发 `visitorArrived` / `visitorLeft` |
| 访客预计到访提醒 | 登记访客时填写预计到访时间，到访前 15 分钟向接待人单发提醒，只提醒一次 | 服务端下发 `visitorReminder` |
| 个人资料 | 成员可改展示名/头像，并凭旧密码修改登录密码 | `profileUpdate` / `passwordChange` |
| 空间设置 | 管理员可修改空间名、配置蹲坑 / 尿槽数量 | `spaceRename` / `stallConfig` |
| 紧急模式 | 个人一键标记「紧急」，在线列表显示 🆘，方便他人避让 | `toggleEmergency` |
| 使用时长统计 | 归还设备 / 结束会议自动累计个人「借用时长」「会议时长」，概览与活跃榜展示 | 复用 `stats` + `leaderboard` |
| 电视墙大屏 | 独立只读页 `public/screen.html`，展示会议室「现在/接下来」+ 空间总览 + 坑位占用 + 公告 + 在线状态 + 访客待接待；支持全屏切换与多视图自动轮播（可暂停/手动切换） | 复用现有广播 |
| 每日看点 | 登录后推送今日要点：今天会议（含时长）、逾期借用、我的未还、待处理申领/报修、待接待访客、今日归还借用时长、本周之星 | 登录时下发 `digest` |
| 会议室候补 | 时段冲突时一键加入候补，他人取消后按先来先服务自动晋升为真实预约并通知 | `roomWaitlist` / `roomWaitlistCancel` / `roomWaitlistPromoted` |
| 会议室开始前提醒 | 预约创建时自动计算「开始前 10 分钟」提醒时间，定时器到点后向预约人单发提醒，只提醒一次避免刷屏 | 服务端下发 `roomReminder` |
| 借用到期前提醒 | 借用临近到期（默认到期前 24 小时内）时单发提醒借用人按时归还，列表展示「即将到期」标记，只提醒一次 | 服务端下发 `borrowDueSoon` |
| 会议室人数校验 | 预约时填写参会人数，超过会议室容量直接拒绝，防止超员开会 | `roomBook`(participants) |
| 会议室冲突建议 | 预约时段冲突时，错误响应自动附带其它空闲会议室建议，方便直接改订 | `roomConflict`(suggestions) |
| 借用记录导出 | 工具借用页一键导出全部借用记录 CSV（自动拉取分页） | 复用 `fetchPage`(`borrows`) |
| 会议室改期 | 待开始预约可调整时段，校验所有权、时段合法性与冲突（排除自身），成功后更新并广播 | `reservationReschedule` / `reservationRescheduled` |
| 会议室实际到场时长 | 开始/结束时记录实际到场起止时间，累计个人到场时长并纳入会议室统计 | `roomStart` / `roomEnd`（复用 `stats` + `roomStats` + `leaderboard`） |
| 会议室准时率 | 开始会议时比较 `actualStartAt - startAt`（宽限 5 分钟），计入准时 / 迟到次数；排行榜与活跃榜展示准时率，累计 5 次准时解锁「会议守时」成就 | `roomStart`（复用 `stats`(`meetingOnTime` / `meetingLate`) + `leaderboard`(`meetingOnTimeRate`) + `achievements`） |
| 会议室参会人与到场确认 | 预约可填写参会人账号名单；会议开始时自动提醒全部参会人，参会人可一键确认到场并实时展示到场率 | `roomBook`(`attendees`) / `reservationAttendees` / `roomStart`（下发 `meetingStarted`）/ `meetingAttend`，复用 `rooms` 广播与 `reservationPublic`(`attendedAccounts` / `attendanceRate`) |
| 会议室门禁码 | 会议开始时自动生成 6 位门禁码，仅预约人 / 管理员 / 参会人可见；结束后清除并拒绝继续请求 | `roomStart` / `roomDoorCodeRequest`（服务端下发 `roomDoorCode`） |
| 报修/申领批量处理 | 管理员可在列表勾选当前页报修 / 申领，一键批量解决或满足，并广播结果 | `repairBatchResolve` / `materialBatchFulfill`（服务端下发 `repairBatchResolved` / `materialBatchFulfilled`） |
| 会议室时长限制 | 每间会议室可配置最短/最长预约时长，预约时长超出区间被拒并返回 `roomDuration` 错误 | `roomCreate`(`minMinutes` / `maxMinutes`) / `roomBook`（复用 `rooms` 广播与 `roomPublic`） |
| 低库存预警 | 设备可设置库存告急阈值，借用 / 归还 / 调整库存后自动判定 `lowStock`；首次跌破阈值时向管理员下发 `toolLowStock` 并写入公告，恢复后重置提醒标记 | `toolCreate` / `toolAdjust`(`minAvailable`)、服务端下发 `toolLowStock` |
| 空间周报 | 每周一 09:00 自动汇总本周活动量（会议数 / 会议分钟数、借用、申领（含已满足）、报修（含已解决）、访客、考勤、工位、外出、待处理报修 / 申领、库存告急设备），广播全员并写入公告，当天只发一次 | 服务端下发 `weeklyReport` + 公告 |
| 会议室向导成就 | 给会议室评分累计 3 次解锁「会议室向导」徽章 | 复用 `stats.roomRatesGiven` + `achievements` |
| 收藏家成就 | 收藏会议室累计 3 个解锁「收藏家」徽章 | 复用 `stats.favoriteCount` + `achievements` |
| 物资库存台账 | 登记办公文具、耗材等公共物资库存，成员按需领用并归还；库存跌破阈值自动标记「库存告急」并通知管理员，阈值恢复后可再次提醒 | `inventoryCreate` / `inventoryAdjust`(`minAvailable`) / `inventoryIssue` / `inventoryReturn`、服务端下发 `inventoryLowStock` |
| 考勤打卡 | 上下班打卡；管理员可配置工作时间与迟到宽限，迟到自动标记；统计今日打卡 / 迟到 / 已下班人数与下班完成率，并计入个人战绩 | `attendCheckIn` / `attendCheckOut` / `attendConfig`、服务端下发 `attendance` |
| 待办任务 | 空间级任务看板：成员发起、指派负责人、认领推进；高 / 普通 / 低优先级与截止时间，按优先级 + 截止时间排序；负责人开始 / 完成 / 删除，创建人收到完成通知，创建人/负责人/管理员可评论跟进 | `taskCreate` / `taskAssign` / `taskUpdate` / `taskStart` / `taskComplete` / `taskRemove` / `taskComment`、服务端下发 `tasks` |
| 通知中心 | 系统重要事件留痕（指派 / 完成 / 超时 / 提醒），全员可看、按人标记已读；侧栏未读徽标，支持单条已读与一键全部已读 | `notificationRead` / `notificationReadAll`、服务端下发 `notifications`（含 `unreadCount`） |
| 考勤连续打卡与全勤 | 连续打卡天数（今天未打回退到昨天）与全勤月数统计；按月出勤日历网格展示每日打卡 / 迟到 / 工作时长，本月全勤标记 | `getAttendanceCalendar`、服务端下发 `attendanceCalendar`、复用 `stats`(`attendanceStreak` / `attendancePerfectMonths`) |
| 考勤战绩与成就 | 打卡计入累计打卡次数与非迟到打卡次数，周报与空间趋势新增打卡指标；解锁「早到达人」与「打卡达人」徽章 | 复用 `stats`(`attendanceCount` / `earlyCount`) + `achievements` |
| 工位达人成就 | 预约工位累计 5 次解锁「工位达人」徽章 | 复用 `stats.deskCount` + `achievements` |
| 外出报备达人 | 外出登记累计 5 次解锁「外出报备达人」徽章 | 复用 `stats.oooCount` + `achievements` |
| 请假审批 | 成员提交请假申请（事假 / 病假 / 年假 / 调休 / 婚假 / 产假 / 丧假 / 其他），同一时间只能有一条待审批申请；管理员批准 / 驳回（可填原因），全程留痕并单发通知申请人；待审批超过 24 小时未处理自动提醒管理员；管理员可一键批准 / 驳回全部待审批申请 | `leaveCreate` / `leaveCancel` / `leaveApprove` / `leaveReject` / `leaveBatchApprove` / `leaveBatchReject` + `leaves` / `leaveCreated` / `leaveApproved` / `leaveRejected` / `leaveSla` |
| 会议纪要 | 把纪要挂到会议室预约上，成员为预约创建纪要（标题 + 内容），作者或管理员可编辑 / 删除；按预约关联会议标题与会议室，统计总数与今日更新 | `meetingNoteCreate` / `meetingNoteEdit` / `meetingNoteRemove` + `meetingNotes` / `meetingNoteCreated` / `meetingNoteUpdated` |
| 倾听达人 | 回复意见反馈累计 3 条解锁「倾听达人」徽章 | 复用 `stats.feedbackReplyCount` + `achievements` |
| 物资申领优先级 | 申领可标记高 / 普通 / 低优先级，列表按优先级排序，申请人或管理员可调整 | `materialRequest`(priority) / `materialUpdate` |
| 心情打卡 | 每天 emoji 记录一次心情，同一账号每天只保留一条；统计今日人数与各表情计数 | `moodCheckIn` + `mood` |

### 客户端→服务端新增消息
`setStatus`、`announce`、`spaceRename`、`spacePause`、`spaceAdminSet`、`spaceKick`、`suggestRoom`、`remindReturn`、`toolExtend`、`toolBorrow`(`dueAt` 自定义归还时间)、`toolCreate` / `toolAdjust`(`minAvailable` 库存告急阈值)、`inventoryCreate` / `inventoryAdjust`(`minAvailable` 物资库存告急阈值) / `inventoryIssue` / `inventoryReturn`、`roomBook`(周期 `repeat`/`repeatCount`)、`reservationCancelSeries`、`reservationReschedule`、`roomRate`、`roomFavorite`、`roomApproval`、`reservationApprove`、`reservationReject`、`roomWaitlist`、`roomWaitlistCancel`、`materialAssign`、`repairAssign`、`repairUpdate`(优先级)、`repairComment`(跟进评论)、`repairRate`(满意度评分)、`visitorCreate`、`visitorArrived`、`visitorLeft`、`visitorCancel`、`visitorRemove`、`visitorCheckin`、`attendCheckIn` / `attendCheckOut` / `attendConfig`、`deskCreate` / `deskDelete` / `deskReserve` / `deskCancel` / `deskStart` / `deskEnd`、`oooCreate` / `oooBack` / `oooCancel` / `oooRemove`、`leaveCreate` / `leaveCancel` / `leaveApprove` / `leaveReject` / `leaveBatchApprove` / `leaveBatchReject`、`meetingNoteCreate` / `meetingNoteEdit` / `meetingNoteRemove`、`feedbackCreate` / `feedbackReply` / `feedbackClose` / `feedbackRemove`、`moodCheckIn`、`materialUpdate`、`profileUpdate`、`passwordChange`、`toggleEmergency`、`fetchPage`(`borrows` 等分页模块)；服务端相应广播/单发
`users`(含 `status`、`emergencyMode`、`role`) 、`notices`、`suggestRooms`、`borrowReminder`、`roomReminder`、`borrowDueSoon`、`materialAssigned`、`materialFulfilled`、`materialSla`、`repairAssigned`、`repairInProgress`、`repairResolved`、`repairSla`、`repairEscalated`、`repairRated`、`adminSet`、`spaceKicked`、`digest`、`visitors`、`spaceRenamed`、`spacePaused`、`roomWaitlistPromoted`、`reservationRescheduled`、`reservationApproved`、`reservationRejected`、`roomApprovalPending`、`rooms`(含 `waitlist`)、`roomRated`、`roomFavorites`、`visitorCheckinNotification`、`visitorArrived`、`visitorLeft`、`visitorReminder`、`toolLowStock`、`inventoryLowStock`、`weeklyReport`、`attendance`、`attendanceCheckedIn`、`attendanceCheckedOut`、`desks`、`deskStats`、`ooo`、`leaves`、`feedback`、`mood`、`oooBacked`、`oooReturnSoon`、`moodCheckedIn`、`leaveCreated`、`leaveApproved`、`leaveRejected`、`leaveSla`、`meetingNoteCreated`、`meetingNoteUpdated`。

## 9. 代码架构（多模块拆分）

后端按领域拆分到 `src/`，`server.js` 只做组装，降低单文件维护成本：

```
server.js        入口：Express + WS 分发 + 定时器 + 心跳 + 优雅停机 + 启动
src/context.js   共享上下文：状态 + 常量 + 基础工具 + 持久化(写合并) + 认证 + 序列化 + 广播 + 坑位成就 + 每日看点 + 空间周报
src/http.js      HTTP 路由：/api/spaces、/api/register
src/session.js   会话：进入/切换空间、登录（含 digest）
src/modules/     rooms / tools / materials / inventory / repairs / visitors / attendance / desks / ooo / leaves / meetingNotes / feedback / mood / profile / stalls / extras（各领域处理函数）
```

- 各领域模块是纯函数工厂 `module.exports = (api)=>({...})`，由 `server.js` 注入共享上下文 `api`，无全局状态、便于单测。
- 定时器、心跳、优雅停机属于进程级关注点，保留在入口。
- 该拆分不改变任何对外协议与行为，e2e（438 项）在内存与 PostgreSQL 双模式下均通过。

## 10. 健康检查、自测与 CI（本版本新增）

- **健康检查**：`GET /api/health` 返回 `{ ok, pg, uptime, spaces, users, time }`，供探活、容器 `HEALTHCHECK` 与 CI 等待服务就绪。
- **npm 脚本**：
  - `npm start`：启动服务
  - `npm run lint`：对 `server.js` / `public` / `src/` / `test/` 全部 JS 执行 `node --check` 语法检查（`scripts/lint.js`）
  - `npm run test:unit`：单元测试（`test/unit.js`，直接断言 `createContext` 纯函数：ID 生成、周统计、坑位段位、成就解锁与进度、口令哈希、管理员判定、历史预约清理、段位缓存、访客序列化、每日看点、我的待办、空间活跃趋势、用户广播、会议室时长累计 / 实际到场时长、周期预约展开、借用逾期判定、会议室占用率统计、报修优先级序列化、借用记录序列化、工具在借明细序列化、工具排队序列化、会议室候补序列化、访客签到码序列化、借用逾期提醒、会议室开始前提醒、借用到期前提醒、访客预计到访提醒、报修 SLA 超时提醒、申领 SLA 超时提醒、报修重复检测、管理员成员管理、通知统一入口、报修处理时长统计、成员移除、低库存预警、空间周报、成就扩展、物资库存台账、考勤打卡、物资优先级序列化、意见反馈序列化、工位签到字段、心情序列化、待办任务序列化、通知中心序列化、考勤连续打卡与出勤日历、请假审批序列化与统计、会议纪要序列化与统计、请假审批 SLA 提醒、值班排班序列化与统计，380 项）
  - `npm run test:restore`：前端「自动恢复会话」回归测试（`test/restore.js`，vm stub 加载内联脚本，无需服务）
  - `npm run smoke`：快速冒烟（`test/smoke.js`）——健康检查、首页与大屏可达、WS 连接、登录、收到广播
  - `npm test`：单元测试 + `test:restore` + 完整 e2e（`test/test.js`，438 项）
- **CI**：`.github/workflows/ci.yml` 在 push 到 `main` 或 pull_request 时自动：`npm ci` → `npm run lint` → `docker compose config` 校验 → `docker build` 构建校验 → 内存模式启动服务 → `npm run smoke` → `npm test`。用不可达的 PG 参数强制内存模式，无需外部数据库。
- **环境变量**：见 `.env.example`（`PORT`、`PGHOST`、`PGPORT`、`PGUSER`、`PGPASSWORD`、`PGDATABASE`）；`.env` 已加入 `.gitignore`。

## 11. 本版本新增：待办任务 / 通知中心 / 考勤连续打卡

### 11.1 待办任务（tasks）

空间级任务看板，覆盖「今天要做什么」的日常协作，任何成员可发起，指派或开放认领，推动闭环。

- `task`: `{ id, title(≤60), description(≤300), creatorAccount, creatorName, assigneeAccount, assigneeName, priority, status, dueAt, completedAt, createdAt, updatedAt, comments[] }`
  - `priority`: `high` / `normal` / `low`（默认 `normal`），列表按优先级 + 截止时间排序。
  - `status`: `pending`(待办) / `in_progress`(进行中) / `done`(已完成) / `cancelled`(已取消)。
  - `assigneeAccount` 为空表示开放认领；指派后由负责人跟进。
- 权限与消息：
  - `taskCreate`（成员，可带 `assigneeAccount` / `priority` / `dueAt`）
  - `taskAssign`（创建人或管理员改派 / 认领）
  - `taskUpdate`（创建人 / 负责人 / 管理员：改标题、说明、优先级、截止时间）
  - `taskStart`（负责人 / 创建人 / 管理员：流转为 `in_progress`）
  - `taskComplete`（负责人 / 创建人 / 管理员：流转为 `done`，记录 `completedAt`）
  - `taskRemove`（创建人或管理员删除）
  - `taskComment`（创建人 / 负责人 / 管理员：添加跟进评论，`comments[]` 最多 30 条）
- 广播与单发：`tasks`（含 `stats`）、`taskCreated`、`taskAssigned`、`taskCompleted`、`taskCommented`。
- 战绩与成就：`taskCreateCount` / `taskDoneCount`；「任务达人」（创建 5 次）、「高效执行」（完成 5 次）。

### 11.2 通知中心（notifications）

把系统里「会错过的事」（指派、完成、超时、提醒等）沉淀成空间级可回看的通知流，与「公告（notices）」的主动广播区分开——通知是系统对重要事件的留痕，全员可看、按人标记已读。

- `notification`: `{ id, type, level(`info`/`warn`/`success`), title, body, createdAt, readBy }`
  - `readBy`: 对象映射 `{ account: true }`，记录谁已读；随 `entities` 持久化。
- 统一入口 `pushNotification(space, { type, level, title, body })`：写入 + 持久化 + 广播。
- 消息：`notificationRead`（标记单条已读）、`notificationReadAll`（全部已读）。
- 广播：`notifications`（含每条 `read` 标记与当前用户未读数 `unreadCount`）。
- 接入点：任务指派 / 完成 / 删除、物资申领指派 / 满足、报修指派 / 解决、借用逾期等重要事件。

### 11.3 考勤连续打卡与全勤（attendance streak）

在既有打卡之上补充「连续」与「全勤」两个长期指标，用于月度复盘与成就。

- `attendanceStreak(space, account, now)`：连续打卡天数。今天尚未打卡时回退到昨天作为连续终点，避免「今天没打」直接断档；当天有打卡则从今天往前数。
- `attendanceCalendar(space, account, year, month)`：返回该月日历网格（每天 `checkedIn / checkedOut / isLate / workedMinutes`）及 `streak`、`perfectMonths`（历史全勤月数）、`currentMonthPerfect`（本月无迟到）。
- 消息：`attendanceCalendar`（按 `year` / `month` 请求）。
- 战绩与成就：`attendanceStreak`（最长连续）/ `attendancePerfectMonths`（全勤月数）；「连续打卡达人」（连续 ≥ 7 天）。

### 11.4 客户端→服务端新增消息

`taskCreate` / `taskAssign` / `taskUpdate` / `taskStart` / `taskComplete` / `taskRemove` / `taskComment` / `notificationRead` / `notificationReadAll` / `attendanceCalendar`；服务端相应广播
`tasks` / `taskCreated` / `taskAssigned` / `taskCompleted` / `taskCommented` / `notifications` / `attendanceCalendar`。