// =========================================================
// OfficeSpace · 办公空间管理 — 入口
// 逻辑按领域拆分在 src/：context(状态/工具/持久化/序列化/广播) +
// http + session(加入/登录) + modules(rooms/tools/materials/repairs/stalls/extras)
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
const repairsModule = require('./src/modules/repairs');
const stallsModule = require('./src/modules/stalls');
const extrasModule = require('./src/modules/extras');

// ---------- 上下文 ----------
const api = createContext();
const { spaces, users, tokens } = api;

// ---------- HTTP / WS ----------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
httpApi(api, app);

// ---------- 会话 + 各领域模块 ----------
const session = sessionApi(api);
const rooms = roomsModule(api);
const tools = toolsModule(api);
const materials = materialsModule(api);
const repairs = repairsModule(api);
const stalls = stallsModule(api);
const extras = extrasModule(api);

// ---------- 分页加载 ----------
function handleFetchPage(ws, user, space, msg) {
  const offset = Math.max(0, parseInt(msg.offset, 10) || 0);
  const limit = Math.min(50, Math.max(1, parseInt(msg.limit, 10) || api.LIST_PAGE));
  const info = api.spaceUserInfo(space.id);
  let items = [];
  let total = 0;
  if (msg.module === 'materials') { const all = api.materialsPublic(space, info); total = all.length; items = all.slice(offset, offset + limit); }
  else if (msg.module === 'repairs') { const all = api.repairsPublic(space, info); total = all.length; items = all.slice(offset, offset + limit); }
  else if (msg.module === 'rooms') { const all = api.roomReservationsPublic(space); total = all.length; items = all.slice(offset, offset + limit); }
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

    if (msg.type === 'join') { session.joinSpace(ws, msg.spaceId); return; }

    const space = ws._ns ? spaces.get(ws._ns) : null;
    if (!space) return api.sendTo(ws, api.serError('请先选择空间'));

    if (msg.type === 'login') { session.handleLogin(ws, msg, space); return; }

    const user = users.get(ws._userId);
    if (!user) return api.sendTo(ws, api.serError('请先登录'));

    if (msg.type === 'logout') { if (user.token) tokens.delete(user.token); return; }
    if (msg.type === 'getStats') { api.sendToUser(user.id, { type: 'stats', stats: user.stats }); return; }
    if (msg.type === 'fetchPage') { handleFetchPage(ws, user, space, msg); return; }

    switch (msg.type) {
      case 'roomCreate': case 'roomRemove': case 'roomBook': case 'reservationCancel': case 'roomStart': case 'roomEnd':
        rooms.handleRooms(ws, user, space, msg); break;
      case 'toolCreate': case 'toolDelete': case 'toolAdjust': case 'toolBorrow': case 'toolReturn':
        tools.handleTools(ws, user, space, msg); break;
      case 'materialRequest': case 'materialCancel': case 'materialFulfill':
        materials.handleMaterials(ws, user, space, msg); break;
      case 'repairCreate': case 'repairUpdate':
        repairs.handleRepairs(ws, user, space, msg); break;
      case 'reserve': case 'cancel': case 'grab': case 'startUse': case 'finish': case 'release': case 'urge': case 'rate': case 'toggleEmergency': case 'stallConfig':
        stalls.handleStalls(ws, user, space, msg); break;
      case 'setStatus': extras.setStatus(ws, user, space, msg); break;
      case 'announce': extras.announce(ws, user, space, msg); break;
      case 'suggestRoom': extras.suggestRoom(ws, user, space, msg); break;
      case 'remindReturn': extras.remindReturn(ws, user, space, msg); break;
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
        if (user) { user.wasOnTime = false; user.stats.consecutiveOnTime = 0; }
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
        if (now >= res.endAt) { res.status = 'expired'; roomsChanged = true; }
        else if (now >= res.startAt) { res.status = 'active'; roomsChanged = true; }
      }
    }
    if (roomsChanged) rooms.roomsBroadcast(sp);
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