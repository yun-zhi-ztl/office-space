// =========================================================
// OfficeSpace · 办公空间管理 — 入口
// 逻辑按领域拆分在 src/：context(状态/工具/持久化/序列化/广播) +
// http + session(加入/登录) + modules(rooms/tools/materials/repairs/visitors/profile/stalls/extras)
// 本文件只负责：Express + WS 组装、消息分发、定时器、心跳、优雅停机、启动。
// =========================================================
'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const { createContext } = require('./src/context');
const httpApi = require('./src/http');
const sessionApi = require('./src/session');
const roomsModule = require('./src/modules/rooms');
const toolsModule = require('./src/modules/tools');
const materialsModule = require('./src/modules/materials');
const inventoryModule = require('./src/modules/inventory');
const repairsModule = require('./src/modules/repairs');
const visitorsModule = require('./src/modules/visitors');
const profileModule = require('./src/modules/profile');
const stallsModule = require('./src/modules/stalls');
const extrasModule = require('./src/modules/extras');
const attendanceModule = require('./src/modules/attendance');
const desksModule = require('./src/modules/desks');
const oooModule = require('./src/modules/ooo');
const feedbackModule = require('./src/modules/feedback');
const moodModule = require('./src/modules/mood');
const eventsModule = require('./src/modules/events');
const pollsModule = require('./src/modules/polls');
const knowledgeModule = require('./src/modules/knowledge');
const tasksModule = require('./src/modules/tasks');
const notificationsModule = require('./src/modules/notifications');
const leavesModule = require('./src/modules/leaves');
const meetingNotesModule = require('./src/modules/meetingNotes');
const dutiesModule = require('./src/modules/duties');
const assetsModule = require('./src/modules/assets');
const keysModule = require('./src/modules/keys');
const fridgeModule = require('./src/modules/fridge');
const parkingModule = require('./src/modules/parking');
const parcelsModule = require('./src/modules/parcels');
const lockersModule = require('./src/modules/lockers');
const vehiclesModule = require('./src/modules/vehicles');
const lostFoundModule = require('./src/modules/lostfound');

// ---------- 上下文 ----------
const api = createContext();
const { spaces, users, tokens } = api;

// ---------- HTTP / WS ----------
const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
httpApi(api, app);

// ---------- HTTP 兜底错误处理 ----------
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: '请求体不是合法 JSON' });
  if (err && err.status === 413) return res.status(413).json({ error: '请求体过大' });
  console.error('HTTP 请求错误:', err && err.message);
  next(err);
});
app.use((req, res) => res.status(404).json({ error: '接口或页面不存在' }));

wss.on('error', (err) => console.error('WebSocket 错误:', err.message));

// ---------- 会话 + 各领域模块 ----------
const session = sessionApi(api);
const rooms = roomsModule(api);
const tools = toolsModule(api);
const materials = materialsModule(api);
const inventory = inventoryModule(api);
const repairs = repairsModule(api);
const visitors = visitorsModule(api);
const profile = profileModule(api);
const stalls = stallsModule(api);
const extras = extrasModule(api);
const attendance = attendanceModule(api);
const desks = desksModule(api);
const ooo = oooModule(api);
const feedback = feedbackModule(api);
const mood = moodModule(api);
const events = eventsModule(api);
const polls = pollsModule(api);
const knowledge = knowledgeModule(api);
const tasks = tasksModule(api);
const notifications = notificationsModule(api);
const leaves = leavesModule(api);
const meetingNotes = meetingNotesModule(api);
const duties = dutiesModule(api);
const assets = assetsModule(api);
const keys = keysModule(api);
const fridge = fridgeModule(api);
const parking = parkingModule(api);
const parcels = parcelsModule(api);
const lockers = lockersModule(api);
const vehicles = vehiclesModule(api);
const lostFound = lostFoundModule(api);

// ---------- 分页加载 ----------
function handleFetchPage(ws, user, space, msg) {
  const offset = Math.max(0, parseInt(msg.offset, 10) || 0);
  const limit = Math.min(50, Math.max(1, parseInt(msg.limit, 10) || api.LIST_PAGE));
  const info = api.spaceUserInfo(space.id);
  let items = [];
  let total = 0;
  if (msg.module === 'materials') { const all = api.materialsPublic(space, info); total = all.length; items = all.slice(offset, offset + limit); }
  else if (msg.module === 'repairs') { const all = api.repairsPublic(space, info); total = all.length; items = all.slice(offset, offset + limit); }
  else if (msg.module === 'rooms') { const all = api.roomReservationsPublic(space, info); total = all.length; items = all.slice(offset, offset + limit); }
  else if (msg.module === 'visitors') { const all = api.visitorsPublic(space, info); total = all.length; items = all.slice(offset, offset + limit); }
  else if (msg.module === 'borrows') { const all = api.borrowsPublic(space, info); total = all.length; items = all.slice(offset, offset + limit); }
  else if (msg.module === 'feedback') { const all = api.feedbackPublic(space, info); total = all.length; items = all.slice(offset, offset + limit); }
  else if (msg.module === 'events') { const all = api.eventPublic(space, info); total = all.length; items = all.slice(offset, offset + limit); }
  else if (msg.module === 'polls') { const all = api.pollPublic(space, info); total = all.length; items = all.slice(offset, offset + limit); }
  else if (msg.module === 'knowledge') { const all = api.knowledgePublic(space, info); total = all.length; items = all.slice(offset, offset + limit); }
  else return api.sendTo(ws, api.serError('不支持的分页模块'));
  api.sendTo(ws, { type: 'page', module: msg.module, offset, items, total });
}

// ---------- WebSocket 分发 ----------
wss.on('connection', (ws) => {
  ws._userId = null;
  ws._ns = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') { session.joinSpace(ws, msg.spaceId, msg.inviteCode); return; }

    const space = ws._ns ? spaces.get(ws._ns) : null;
    if (!space) return api.sendTo(ws, api.serError('请先选择空间'));

    if (msg.type === 'login') { session.handleLogin(ws, msg, space); return; }

    const user = users.get(ws._userId);
    if (!user) return api.sendTo(ws, api.serError('请先登录'));

    if (msg.type === 'logout') { api.saveProfile(user); if (user.token) tokens.delete(user.token); return; }
    if (msg.type === 'getStats') { api.sendToUser(user.id, { type: 'stats', stats: user.stats }); return; }
    if (msg.type === 'getAchievements') { api.sendTo(ws, { type: 'achievements', achievements: api.achievementDefsPublic(user) }); return; }
    if (msg.type === 'getMyReminders') { api.sendTo(ws, { type: 'myReminders', reminders: api.buildMyReminders(space, user) }); return; }
    if (msg.type === 'getMySchedule') { api.sendTo(ws, { type: 'mySchedule', schedule: api.buildMySchedule(space, user, msg.days) }); return; }
    if (msg.type === 'getSpaceCalendar') { api.sendTo(ws, { type: 'spaceCalendar', calendar: api.buildSpaceCalendar(space, msg.year, msg.month) }); return; }
    if (msg.type === 'getAssets') { const info = api.spaceUserInfo(space.id); api.sendTo(ws, { type: 'assets', assets: api.assetsPublic(space, info), stats: api.assetsStats(space) }); return; }
    if (msg.type === 'getKeys') { const info = api.spaceUserInfo(space.id); api.sendTo(ws, { type: 'keys', keys: api.keysPublic(space, info), stats: api.keysStats(space), requests: api.keyRequestsPublic(space, info) }); return; }
    if (msg.type === 'getFridge') { const info = api.spaceUserInfo(space.id); api.sendTo(ws, { type: 'fridge', items: api.fridgeItemsPublic(space, info), stats: api.fridgeStats(space), logs: api.fridgeLogsPublic(space, info) }); return; }
    if (msg.type === 'getParking') { const info = api.spaceUserInfo(space.id); api.sendTo(ws, { type: 'parking', spots: api.parkingSpotsPublic(space, info), stats: api.parkingStats(space), reservations: api.parkingReservationsPublic(space, info) }); return; }
    if (msg.type === 'getParcels') { const info = api.spaceUserInfo(space.id); api.sendTo(ws, { type: 'parcels', parcels: api.parcelsPublic(space, info).slice(0, api.LIST_PAGE), total: api.parcelsPublic(space, info).length, stats: api.parcelStats(space) }); return; }
    if (msg.type === 'getLockers') { const info = api.spaceUserInfo(space.id); api.sendTo(ws, { type: 'lockers', lockers: api.lockersPublic(space, info), stats: api.lockerStats(space), reservations: api.lockerReservationsPublic(space, info) }); return; }
    if (msg.type === 'getVehicles') { const info = api.spaceUserInfo(space.id); api.sendTo(ws, { type: 'vehicles', vehicles: api.vehiclesPublic(space, info), stats: api.vehicleStats(space), reservations: api.vehicleReservationsPublic(space, info) }); return; }
    if (msg.type === 'spaceSearch') { const info = api.spaceUserInfo(space.id); api.sendTo(ws, { type: 'searchResults', q: msg.q || '', hits: api.spaceSearch(space, info, msg.q || '').hits }); return; }
    if (msg.type === 'getLost') { const info = api.spaceUserInfo(space.id); api.sendTo(ws, { type: 'lostFound', items: api.lostPublic(space, info), stats: api.lostStats(space) }); return; }
    if (msg.type === 'getSpaceTrend') { api.sendTo(ws, { type: 'spaceTrend', trend: api.buildSpaceTrend(space, msg.days) }); return; }
    if (msg.type === 'getAttendanceCalendar') { api.sendTo(ws, { type: 'attendanceCalendar', calendar: api.attendanceCalendar(space, user.account, msg.year, msg.month) }); return; }
    if (msg.type === 'fetchPage') { handleFetchPage(ws, user, space, msg); return; }

    switch (msg.type) {
      case 'roomCreate': case 'roomTag': case 'roomApproval': case 'roomEquipment': case 'roomMaintenance': case 'roomRemove': case 'roomBook': case 'reservationCancel': case 'reservationCancelSeries': case 'reservationApprove': case 'reservationReject': case 'reservationReschedule': case 'reservationAttendees': case 'roomWaitlist': case 'roomWaitlistCancel': case 'roomStart': case 'roomEnd': case 'roomExtend': case 'roomDoorCodeRequest': case 'meetingAttend': case 'roomRate': case 'roomFavorite':
        rooms.handleRooms(ws, user, space, msg); break;
      case 'toolCreate': case 'toolDelete': case 'toolAdjust': case 'toolBorrow': case 'toolReturn': case 'toolExtend': case 'toolWaitlist': case 'remindOverdue':
        tools.handleTools(ws, user, space, msg); break;
      case 'materialRequest': case 'materialCancel': case 'materialFulfill': case 'materialBatchFulfill': case 'materialAssign': case 'materialUpdate': case 'materialTemplateCreate': case 'materialTemplateDelete':
        materials.handleMaterials(ws, user, space, msg); break;
      case 'inventoryCreate': case 'inventoryDelete': case 'inventoryAdjust': case 'inventoryIssue': case 'inventoryReturn':
        inventory.handleInventory(ws, user, space, msg); break;
      case 'repairCreate': case 'repairUpdate': case 'repairBatchResolve': case 'repairAssign': case 'repairComment': case 'repairRate':
        repairs.handleRepairs(ws, user, space, msg); break;
      case 'visitorCreate': case 'visitorArrived': case 'visitorLeft': case 'visitorCancel': case 'visitorRemove': case 'visitorCheckin':
        visitors.handleVisitors(ws, user, space, msg); break;
      case 'profileUpdate': case 'passwordChange':
        profile.handleProfile(ws, user, space, msg); break;
      case 'reserve': case 'cancel': case 'grab': case 'startUse': case 'finish': case 'release': case 'urge': case 'rate': case 'toggleEmergency': case 'stallConfig':
        stalls.handleStalls(ws, user, space, msg); break;
      case 'attendConfig': case 'attendCheckIn': case 'attendCheckOut':
        attendance.handleAttendance(ws, user, space, msg); break;
      case 'deskCreate': case 'deskDelete': case 'deskReserve': case 'deskCancel': case 'deskStart': case 'deskEnd': case 'deskExtend':
        desks.handleDesks(ws, user, space, msg); break;
      case 'oooCreate': case 'oooBack': case 'oooCancel': case 'oooRemove':
        ooo.handleOoo(ws, user, space, msg); break;
      case 'feedbackCreate': case 'feedbackReply': case 'feedbackClose': case 'feedbackRemove':
        feedback.handleFeedback(ws, user, space, msg); break;
      case 'moodCheckIn':
        mood.handleMood(ws, user, space, msg); break;
      case 'eventCreate': case 'eventRsvp': case 'eventCancel': case 'eventRemove':
        events.handleEvents(ws, user, space, msg); break;
      case 'pollCreate': case 'pollVote': case 'pollClose': case 'pollRemove':
        polls.handlePolls(ws, user, space, msg); break;
      case 'knowledgeCreate': case 'knowledgeEdit': case 'knowledgeDelete': case 'knowledgeLike': case 'knowledgeComment':
        knowledge.handleKnowledge(ws, user, space, msg); break;
      case 'taskCreate': case 'taskAssign': case 'taskUpdate': case 'taskStart': case 'taskComplete': case 'taskRemove': case 'taskComment':
        tasks.handleTasks(ws, user, space, msg); break;
      case 'notificationRead': case 'notificationReadAll':
        notifications.handleNotifications(ws, user, space, msg); break;
      case 'leaveCreate': case 'leaveCancel': case 'leaveApprove': case 'leaveReject': case 'leaveBatchApprove': case 'leaveBatchReject':
        leaves.handleLeaves(ws, user, space, msg); break;
      case 'meetingNoteCreate': case 'meetingNoteEdit': case 'meetingNoteRemove':
        meetingNotes.handleMeetingNotes(ws, user, space, msg); break;
      case 'dutyAssign': case 'dutyComplete': case 'dutySwap': case 'dutyCancel':
        duties.handleDuties(ws, user, space, msg); break;
      case 'assetCreate': case 'assetUpdate': case 'assetDelete': case 'assetCheck':
        assets.handleAssets(ws, user, space, msg); break;
      case 'keyCreate': case 'keyDelete': case 'keyUpdate': case 'keyRequest': case 'keyApprove': case 'keyReject': case 'keyReturn': case 'remindKeyOverdue':
        keys.handleKeys(ws, user, space, msg); break;
      case 'fridgeItemCreate': case 'fridgeItemDelete': case 'fridgeTake': case 'fridgeRestock': case 'fridgeReturn':
        fridge.handleFridge(ws, user, space, msg); break;
      case 'spotCreate': case 'spotDelete': case 'spotReserve': case 'spotCancel': case 'spotCheckin': case 'spotCheckout':
        parking.handleParking(ws, user, space, msg); break;
      case 'parcelCreate': case 'parcelPick': case 'parcelReturn': case 'parcelCancel': case 'parcelRemind':
        parcels.handleParcels(ws, user, space, msg); break;
      case 'lockerCreate': case 'lockerDelete': case 'lockerReserve': case 'lockerCancel': case 'lockerCheckin': case 'lockerCheckout': case 'lockerRemind':
        lockers.handleLockers(ws, user, space, msg); break;
      case 'vehicleCreate': case 'vehicleUpdate': case 'vehicleDelete': case 'vehicleReserve': case 'vehicleCancel': case 'vehicleCheckin': case 'vehicleCheckout':
        vehicles.handleVehicles(ws, user, space, msg); break;
      case 'lostReport': case 'lostResolve': case 'lostReopen': case 'lostDelete':
        lostFound.handleLostFound(ws, user, space, msg); break;
      case 'setStatus': extras.setStatus(ws, user, space, msg); break;
      case 'announce': extras.announce(ws, user, space, msg); break;
      case 'spaceRename': extras.renameSpace(ws, user, space, msg); break;
      case 'spaceAdminSet': extras.adminSet(ws, user, space, msg); break;
      case 'spaceKick': extras.kick(ws, user, space, msg); break;
      case 'spacePause': extras.pause(ws, user, space, msg); break;
      case 'spaceInviteCreate': extras.inviteCreate(ws, user, space, msg); break;
      case 'spaceInviteRevoke': extras.inviteRevoke(ws, user, space, msg); break;
      case 'spaceInviteList': extras.inviteList(ws, user, space, msg); break;
      case 'spaceInviteRequire': extras.inviteRequire(ws, user, space, msg); break;
      case 'spaceAuditList': extras.auditList(ws, user, space, msg); break;
      case 'announceEdit': extras.announceEdit(ws, user, space, msg); break;
      case 'announcePin': extras.announcePin(ws, user, space, msg); break;
      case 'suggestRoom': extras.suggestRoom(ws, user, space, msg); break;
      case 'remindReturn': extras.remindReturn(ws, user, space, msg); break;
      case 'removeNotice': extras.removeNotice(ws, user, space, msg); break;
      case 'noticeReact': extras.noticeReact(ws, user, space, msg); break;
      case 'noticeUnreact': extras.noticeUnreact(ws, user, space, msg); break;
      default:
        api.sendTo(ws, api.serError('未知操作'));
    }
  });

  ws.on('close', () => {
    const sp = ws._ns ? spaces.get(ws._ns) : null;
    if (sp) sp.clients.delete(ws);
    const u = users.get(ws._userId);
    if (u) {
      api.saveProfile(u);
      if (sp) {
        if (u.currentStall !== null) {
          const stall = sp.stalls.find((s) => s.id === u.currentStall && s.reservation && s.reservation.account === u.account);
          if (stall) {
            const rr = stall.reservation.reservationId ? sp.reservations.get(stall.reservation.reservationId) : null;
            stall.status = 'free'; stall.currentUser = null; stall.reservation = null;
            if (rr) sp.reservations.delete(rr.id);
            sp.urges.delete(stall.id);
            api.broadcastStalls(sp);
          }
          u.currentStall = null;
        }
        for (const [rid, r] of [...sp.reservations]) {
          if (r.account === u.account && r.status === 'pending') {
            const stall = sp.stalls.find((s) => s.id === r.stallId);
            if (stall && stall.reservation && stall.reservation.reservationId === rid) { stall.status = 'free'; stall.reservation = null; }
            sp.reservations.delete(rid);
          }
        }
        api.broadcastUsers(sp);
        api.broadcastLeaderboard(sp);
      }
      users.delete(u.id);
    }
  });
});

// ---------- 定时器：过期释放（每 15 秒） ----------
setInterval(() => {
  const now = Date.now();
  for (const sp of spaces.values()) {
    for (const [rid, r] of [...sp.reservations]) {
      if (r.status !== 'pending') continue;
      if (now > r.startTime + api.RESERVE_CONFIRM_WINDOW_MS) {
        r.status = 'expired';
        const stall = sp.stalls.find((s) => s.id === r.stallId);
        if (stall && stall.reservation && stall.reservation.reservationId === rid && stall.status !== 'occupied') {
          stall.status = 'free'; stall.reservation = null;
          api.broadcast(sp.id, 'reservationExpired', { stallId: stall.id });
          api.broadcast(sp.id, 'stallReleased', { stallId: stall.id });
          api.broadcastStalls(sp);
        }
        sp.reservations.delete(rid);
        const user = users.get(r.userId);
        if (user) { user.wasOnTime = false; user.stats.consecutiveOnTime = 0; api.saveProfile(user); }
      } else if (now >= r.startTime) {
        const stall = sp.stalls.find((s) => s.id === r.stallId);
        if (stall && stall.status === 'reserved') stall.status = 'waiting';
      }
    }
    for (const stall of sp.stalls) {
      if (stall.status !== 'occupied' || !stall.reservation) continue;
      if (now < (stall.reservation.endTime || 0)) continue;
      const user = users.get(stall.reservation.userId);
      if (user) {
        const duration = Math.max(0, Math.round((now - (stall.reservation.startTime || now)) / 60000));
        user.stats.totalDuration += duration;
        user.stats.maxDuration = Math.max(user.stats.maxDuration, duration);
        user.stats.totalVisits++;
        api.recordWeekly(user, 'visits');
        user.stats.onTimeRate = user.stats.totalVisits > 0 ? 1 : 0;
        api.checkAchievements(user);
        api.saveProfile(user);
        user.currentStall = null;
      }
      const rr = stall.reservation.reservationId ? sp.reservations.get(stall.reservation.reservationId) : null;
      if (rr) sp.reservations.delete(rr.id);
      stall.status = 'free'; stall.currentUser = null; stall.reservation = null;
      sp.urges.delete(stall.id);
      api.broadcast(sp.id, 'autoRelease', { stallId: stall.id });
      api.broadcast(sp.id, 'stallReleased', { stallId: stall.id });
      api.broadcastStalls(sp);
      api.broadcastLeaderboard(sp);
    }
    let roomsChanged = false;
    for (const res of [...sp.roomReservations.values()]) {
      if (res.status === 'pending') {
        if (now >= res.endAt) { res.status = 'expired'; roomsChanged = true; api.saveEntity(sp.id, 'room_reservation', res.id, res); }
        else if (now >= res.startAt) {
          if (rooms.startMeeting(sp, res, now)) roomsChanged = true;
          api.saveEntity(sp.id, 'room_reservation', res.id, res);
        }
      } else if (res.status === 'active' && now >= res.endAt) {
        // 预约时段自然结束：自动置为已完成，避免「进行中」悬挂；同时持久化，防止重启后状态回退
        res.status = 'completed';
        if (!res.actualEndAt) res.actualEndAt = now;
        roomsChanged = true; api.saveEntity(sp.id, 'room_reservation', res.id, res);
        const owner = api.getUserByAccount(res.ownerAccount);
        if (owner) {
          owner.stats.meetingDuration += Math.max(0, Math.round((res.endAt - res.startAt) / 60000));
          if (res.actualStartAt) owner.stats.meetingActualDuration = (owner.stats.meetingActualDuration || 0) + Math.max(0, Math.round((res.actualEndAt - res.actualStartAt) / 60000));
          api.saveProfile(owner);
        }
      }
    }
    if (roomsChanged) rooms.roomsBroadcast(sp);
    if (api.pruneRoomReservations(sp, now - 7 * 86400000)) rooms.roomsBroadcast(sp);
    // 工位预约：到点自动流转为已完成，避免「进行中」悬挂
    let desksChanged = false;
    for (const res of [...sp.deskReservations.values()]) {
      if (res.status === 'pending' && now >= res.endAt) { res.status = 'completed'; desksChanged = true; api.saveEntity(sp.id, 'desk_reservation', res.id, res); }
    }
    if (desksChanged) { desks.desksBroadcast(sp); api.deskStatsBroadcast(sp); }
    if (api.pruneDeskReservations(sp, now - 7 * 86400000)) { desks.desksBroadcast(sp); api.deskStatsBroadcast(sp); }
    // 候补清理：时段已过仍未晋升的候补标记为 expired
    let waitlistChanged = false;
    for (const [wid, w] of [...sp.roomWaitlist]) {
      if (w.status === 'waiting' && now > w.endAt) {
        w.status = 'expired';
        sp.roomWaitlist.delete(wid);
        api.deleteEntity(sp.id, 'room_waitlist', wid);
        waitlistChanged = true;
      }
    }
    if (waitlistChanged) rooms.roomsBroadcast(sp);
    // 借用逾期自动提醒：逾期且超过静默期（默认 24h）才再次提醒，避免刷屏
    const reminders = api.dueBorrowReminders(sp, now);
    if (reminders.length) {
      for (const b of reminders) {
        b.lastRemindedAt = now;
        api.saveEntity(sp.id, 'borrow', b.id, b);
        api.sendToAccount(b.borrowerAccount, { type: 'overdueReminder', borrowId: b.id });
      }
      tools.toolsBroadcast(sp);
    }
    // 会议室预约开始前提醒：开始前 10 分钟提醒一次，避免刷屏
    const roomReminders = api.dueRoomReminders(sp, now);
    if (roomReminders.length) {
      for (const r of roomReminders) {
        r.reminded = true;
        api.saveEntity(sp.id, 'room_reservation', r.id, r);
        api.sendToAccount(r.ownerAccount, { type: 'roomReminder', reservationId: r.id, roomId: r.roomId, startAt: r.startAt });
      }
      rooms.roomsBroadcast(sp);
    }
    // 会议室预约审批催办：待审批超过 SLA 仍未处理时提醒管理员，避免漏审批
    const roomApprovalReminders = api.dueRoomApprovalReminders(sp, now);
    if (roomApprovalReminders.length) {
      for (const r of roomApprovalReminders) {
        r.approvalRemindedAt = now;
        api.saveEntity(sp.id, 'room_reservation', r.id, r);
        const rm = sp.rooms.find((x) => x.id === r.roomId);
        for (const acc of sp.admins) api.sendToAccount(acc, { type: 'roomApprovalPending', reservationId: r.id, roomId: r.roomId, roomName: rm ? rm.name : '', title: r.title });
      }
      rooms.roomsBroadcast(sp);
    }
    // 活动开始前提醒：开始前 10 分钟内提醒一次
    const eventReminders = api.dueEventReminders(sp, now);
    if (eventReminders.length) {
      for (const e of eventReminders) {
        e.reminded = true;
        api.saveEntity(sp.id, 'event', e.id, e);
        api.sendToAccount(e.hostAccount, { type: 'eventReminder', eventId: e.id, title: e.title, startAt: e.startAt });
        for (const acc of Object.keys(e.rsvps || {})) api.sendToAccount(acc, { type: 'eventReminder', eventId: e.id, title: e.title, startAt: e.startAt });
      }
      api.eventsBroadcast(sp);
    }
    // 借用到期前提醒：到期前 24 小时内提醒一次，避免逾期
    const borrowSoonReminders = api.dueBorrowSoonReminders(sp, now);
    if (borrowSoonReminders.length) {
      for (const b of borrowSoonReminders) {
        b.soonRemindedAt = now;
        api.saveEntity(sp.id, 'borrow', b.id, b);
        api.sendToAccount(b.borrowerAccount, { type: 'borrowDueSoon', borrowId: b.id });
      }
      tools.toolsBroadcast(sp);
    }
    // 外出预计返回提醒：预计返回前 30 分钟内提醒一次
    const oooReturnReminders = api.dueOooReturnReminders(sp, now);
    if (oooReturnReminders.length) {
      for (const r of oooReturnReminders) {
        r.returnRemindedAt = now;
        api.saveEntity(sp.id, 'ooo', r.id, r);
        api.sendToAccount(r.account, { type: 'oooReturnSoon', oooId: r.id, expectedReturnAt: r.expectedReturnAt });
      }
      ooo.oooBroadcast(sp);
    }
    // 访客预计到访提醒：到访前 15 分钟内提醒接待人一次
    const visitorReminders = api.dueVisitorReminders(sp, now);
    if (visitorReminders.length) {
      for (const v of visitorReminders) {
        v.reminded = true;
        api.saveEntity(sp.id, 'visitor', v.id, v);
        api.sendToAccount(v.hostAccount, { type: 'visitorReminder', visitorId: v.id, visitorName: v.visitorName, expectedAt: v.expectedAt });
      }
      visitors.visitorsBroadcast(sp);
    }
    // 报修 SLA 提醒：超时仍未处理时提醒上报人与管理员
    const repairSlaReminders = api.dueRepairSlaReminders(sp, now);
    if (repairSlaReminders.length) {
      for (const r of repairSlaReminders) {
        r.slaRemindedAt = now;
        api.saveEntity(sp.id, 'repair', r.id, r);
        api.sendToAccount(r.reporterAccount, { type: 'repairSla', repairId: r.id, category: r.category, location: r.location, priority: r.priority });
        for (const acc of sp.admins) api.sendToAccount(acc, { type: 'repairSla', repairId: r.id, category: r.category, location: r.location, priority: r.priority });
      }
      repairs.repairsBroadcast(sp);
    }
    // 物资申领 SLA 提醒：超时仍未处理时提醒申请人与管理员
    const materialSlaReminders = api.dueMaterialSlaReminders(sp, now);
    if (materialSlaReminders.length) {
      for (const m of materialSlaReminders) {
        m.slaRemindedAt = now;
        api.saveEntity(sp.id, 'material', m.id, m);
        api.sendToAccount(m.requesterAccount, { type: 'materialSla', requestId: m.id, name: m.name, qty: m.qty });
        for (const acc of sp.admins) api.sendToAccount(acc, { type: 'materialSla', requestId: m.id, name: m.name, qty: m.qty });
      }
      materials.materialsBroadcast(sp);
    }
    // 请假审批 SLA 提醒：待审批超过 SLA 仍未处理时提醒管理员，避免漏审批
    const leaveSlaReminders = api.dueLeaveSlaReminders(sp, now);
    if (leaveSlaReminders.length) {
      for (const r of leaveSlaReminders) {
        r.slaRemindedAt = now;
        api.saveEntity(sp.id, 'leave', r.id, r);
        for (const acc of sp.admins) api.sendToAccount(acc, { type: 'leaveSla', leaveId: r.id, category: r.category, name: r.name, startAt: r.startAt });
      }
      leaves.leavesBroadcast(sp);
    }
    // 今日值班提醒：每个未完成值班每日只提醒一次
    const dutyReminders = api.dueDutyReminders(sp, now);
    if (dutyReminders.length) {
      for (const d of dutyReminders) {
        d.reminderAt = api.todayKey(now);
        api.saveEntity(sp.id, 'duty', d.id, d);
        api.sendToAccount(d.account, { type: 'dutyReminder', dutyId: d.id, date: d.date, category: d.category });
      }
      duties.dutiesBroadcast(sp);
    }
    // 高优先级报修升级：超过阈值仍未解决时升级提醒一次
    const repairEscalations = api.dueRepairEscalations(sp, now);
    if (repairEscalations.length) {
      for (const r of repairEscalations) {
        r.escalatedAt = now;
        api.saveEntity(sp.id, 'repair', r.id, r);
        api.sendToAccount(r.reporterAccount, { type: 'repairEscalated', repairId: r.id, category: r.category, location: r.location });
        for (const acc of sp.admins) api.sendToAccount(acc, { type: 'repairEscalated', repairId: r.id, category: r.category, location: r.location });
      }
      repairs.repairsBroadcast(sp);
    }
    // 空间周报：每周一 09:00 汇总本周活动并广播给全员，当天只发一次
    const nowMon = new Date(now); nowMon.setHours(0, 0, 0, 0);
    const dow = (nowMon.getDay() + 6) % 7;
    nowMon.setDate(nowMon.getDate() - dow);
    const monday9 = nowMon.getTime() + 9 * 3600 * 1000;
    if (now >= monday9 && sp.weeklyReportDate !== api.weekKey(monday9)) {
      sp.weeklyReportDate = api.weekKey(monday9);
      const report = api.buildWeeklyReport(sp, now);
      api.broadcast(sp.id, 'weeklyReport', { report });
      api.pushNotice(sp, `📅 本周空间周报：会议 ${report.meetings} · 借用 ${report.borrows} · 申领 ${report.requests} · 报修 ${report.repairs}（已解决 ${report.resolvedRepairs}） · 工位 ${report.desks} · 外出 ${report.ooo}`, 'system', '系统');
    }
  }
}, 15000);

// ---------- 心跳：清理异常断开的僵尸连接 ----------
setInterval(() => {
  const seen = new Set();
  for (const sp of spaces.values()) {
    for (const c of [...sp.clients]) {
      if (seen.has(c)) continue;
      seen.add(c);
      if (!c.isAlive) { c.terminate(); sp.clients.delete(c); continue; }
      c.isAlive = false;
      try { c.ping(); } catch { c.terminate(); sp.clients.delete(c); }
    }
  }
}, api.WS_PING_MS);

// ---------- 优雅停机 ----------
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在优雅停机…`);
  api.flushWrites().finally(() => {
    try { for (const ws of wss.clients) ws.close(); } catch {}
    server.close(() => { api.pool.end().catch(() => {}); process.exit(0); });
    setTimeout(() => { api.pool.end().catch(() => {}); process.exit(0); }, 2500).unref();
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ---------- 启动 ----------
const PORT = process.env.PORT || 3000;
api.initDb()
  .then(() => {
    api.pgEnabled = true;
    console.log(`PostgreSQL 已连接；已载入 ${spaces.size} 个空间`);
    server.listen(PORT, '0.0.0.0', () => console.log(`OfficeSpace · 办公空间管理 运行在 http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('❌ 无法连接 PostgreSQL，仅以内存运行:', err.message);
    server.listen(PORT, '0.0.0.0', () => console.log(`OfficeSpace · 办公空间管理 运行在 http://localhost:${PORT}（内存模式）`));
  });