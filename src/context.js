'use strict';
// ============================================================================
// src/context.js — 共享上下文：状态 + 常量 + 基础工具 + 持久化 + 认证
//                  + 空间 + 序列化 + 广播 + 坑位成就 + 每日看点
// 由 server.js createContext 一次创建，再注入给各领域模块（rooms/tools/...）。
// ============================================================================
const crypto = require('crypto');
const { Pool } = require('pg');

function createContext() {
  // ---------- 常量 ----------
  const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000;
  const SPACE_ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
  const REPAIR_CATEGORIES = ['厕所', '灯光', '空调', '其它'];
  const REPAIR_PRIORITIES = ['high', 'normal', 'low'];
  const TOOL_CATEGORIES = ['测试电脑', '测试机器', '测试手机', '其它'];
  const LIST_PAGE = 30;
  const PERSIST_DEBOUNCE_MS = 500;
  const WS_PING_MS = 30000;
  const RESERVE_CONFIRM_WINDOW_MS = 5 * 60000;
  const OVERDUE_REMIND_THROTTLE_MS = 24 * 3600 * 1000;
  const ROOM_REMIND_WINDOW_MS = 10 * 60000;
  const BORROW_SOON_WINDOW_MS = 24 * 3600 * 1000;
  const VISIT_TOKEN_TTL_MS = 24 * 3600 * 1000;

  // ---------- 内存状态 ----------
  const spaces = new Map();
  const users = new Map();
  const accounts = new Map();
  const tokens = new Map();
  const profiles = new Map(); // `${space}::${account}` -> { account, nick, avatar, stats, achievements }
  const profilesBySpace = new Map(); // spaceId -> Map<account, profileEntry>，避免排行榜全量扫描
  let usePg = false;

  // ---------- 基础工具 ----------
  function genId(prefix, set) {
    let id;
    do { id = prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); } while (set && set.has(id));
    return id;
  }
  function genSpaceId() {
    let id;
    do {
      id = '';
      for (let i = 0; i < 4; i++) id += SPACE_ID_CHARS[Math.floor(Math.random() * SPACE_ID_CHARS.length)];
    } while (spaces.has(id));
    return id;
  }
  function genCheckinCode(space) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = '';
      for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    } while ([...space.visitors.values()].some((v) => v.code === code));
    return code;
  }
  function sendTo(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function broadcastTo(spaceId, obj) {
    const sp = spaces.get(spaceId);
    if (!sp) return;
    const msg = JSON.stringify(obj);
    for (const c of sp.clients) if (c.readyState === 1) c.send(msg);
  }
  function sendToUser(userId, obj) {
    for (const [, u] of users) if (u.id === userId && u.ws && u.ws.readyState === 1) u.ws.send(JSON.stringify(obj));
  }
  function sendToAccount(account, obj) {
    for (const [, u] of users) if (u.account === account && u.ws && u.ws.readyState === 1) u.ws.send(JSON.stringify(obj));
  }
  function getUsersIn(spaceId) {
    const out = [];
    for (const [, u] of users) if (u.currentSpace === spaceId) out.push(u);
    return out;
  }
  function getUserByAccount(account) {
    if (!account) return null;
    for (const [, u] of users) if (u.account === account) return u;
    return null;
  }
  function isAdmin(space, account) { return !!space.admins.has(account); }
  function serError(message) { return { type: 'error', message }; }
  function lk(s) { return String(s == null ? '' : s).toLowerCase(); }
  function reindexProfile(spaceId, account, value) {
    let m = profilesBySpace.get(spaceId);
    if (!m) { m = new Map(); profilesBySpace.set(spaceId, m); }
    m.set(account, value);
  }
  function spaceUserInfo(spaceId) {
    const info = new Map();
    for (const u of getUsersIn(spaceId)) {
      info.set(u.account, { account: u.account, username: u.nickname, avatar: u.avatar, online: true, role: isAdmin(spaces.get(spaceId), u.account) ? 'admin' : 'member', status: u.status || { label: '在岗' } });
    }
    const count = new Map();
    for (const d of info.values()) { const k = lk(d.username); count.set(k, (count.get(k) || 0) + 1); }
    for (const d of info.values()) {
      d.dup = count.get(lk(d.username)) > 1;
      d.display = d.dup ? `${d.username}(${d.account})` : d.username;
    }
    return info;
  }

  // ---------- PostgreSQL + 持久化 ----------
  const pool = new Pool({
    host: process.env.PGHOST || '127.0.0.1',
    port: +(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'toilet_dev',
    database: process.env.PGDATABASE || 'toilet',
  });
  pool.on('error', (err) => console.error('⚠️  Postgres 池错误:', err.message));

  async function initDb() {
    await pool.query(`CREATE TABLE IF NOT EXISTS spaces(
      id text PRIMARY KEY, name text NOT NULL,
      admins jsonb NOT NULL DEFAULT '[]'::jsonb,
      squat_count int NOT NULL DEFAULT 4, urinal_count int NOT NULL DEFAULT 3,
      paused boolean NOT NULL DEFAULT false, paused_reason text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS accounts(
      account text PRIMARY KEY, password_hash text NOT NULL,
      username text NOT NULL, avatar text NOT NULL DEFAULT '🧑',
      created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS profiles(
      space text NOT NULL, account text NOT NULL,
      nick text DEFAULT '', avatar text NOT NULL DEFAULT '🧑',
      stats jsonb NOT NULL DEFAULT '{}'::jsonb, achievements text[] NOT NULL DEFAULT '{}',
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(space, account))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS stall_ratings(
      space text NOT NULL, stall_id int NOT NULL, account text DEFAULT '',
      nickname text DEFAULT '', cleanliness int NOT NULL, signal int NOT NULL, paper int NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS entities(
      space text NOT NULL, kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL,
      PRIMARY KEY(space, kind, id))`);

    await pool.query(`ALTER TABLE spaces ADD COLUMN IF NOT EXISTS admins jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await pool.query(`ALTER TABLE spaces ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE spaces ADD COLUMN IF NOT EXISTS paused_reason text NOT NULL DEFAULT ''`);
    await pool.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='profiles' AND column_name='ns_id') THEN
        ALTER TABLE profiles RENAME COLUMN ns_id TO space;
      ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='profiles' AND column_name='space') THEN
        ALTER TABLE profiles ADD COLUMN space text;
      END IF;
    END $$`);
    await pool.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='stall_ratings' AND column_name='ns_id') THEN
        ALTER TABLE stall_ratings RENAME COLUMN ns_id TO space;
      END IF;
    END $$`);
    await pool.query(`ALTER TABLE stall_ratings ADD COLUMN IF NOT EXISTS account text DEFAULT ''`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stall_ratings_space_stall ON stall_ratings(space, stall_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stall_ratings_space_time ON stall_ratings(space, created_at)`);

    const spRows = await pool.query('SELECT id,name,admins,squat_count,urinal_count,paused,paused_reason FROM spaces');
    for (const r of spRows.rows) { const sp = createSpace(r.id, r.name, r.squat_count, r.urinal_count); sp.admins = new Set(r.admins || []); sp.paused = !!r.paused; sp.pausedReason = r.paused_reason || ''; }
    const accRows = await pool.query('SELECT account,password_hash,username,avatar FROM accounts');
    for (const r of accRows.rows) accounts.set(r.account, { account: r.account, passwordHash: r.password_hash, username: r.username, avatar: r.avatar || '🧑' });
    const pr = await pool.query('SELECT space,account,nick,avatar,stats,achievements FROM profiles');
    for (const r of pr.rows) {
      const p = { account: r.account, nick: r.nick, avatar: r.avatar, stats: r.stats || {}, achievements: r.achievements || [] };
      profiles.set(`${r.space}::${r.account}`, p);
      reindexProfile(r.space, r.account, p);
    }
    const rat = await pool.query('SELECT space,stall_id,account,nickname,cleanliness,signal,paper,created_at FROM stall_ratings ORDER BY created_at ASC');
    const byStall = {};
    for (const r of rat.rows) { const k = `${r.space}::${r.stall_id}`; (byStall[k] = byStall[k] || []).push({ account: r.account || '', nickname: r.nickname, cleanliness: r.cleanliness, signal: r.signal, paper: r.paper, timestamp: Date.parse(r.created_at) }); }
    const ent = await pool.query('SELECT space,kind,id,data FROM entities');
    for (const r of ent.rows) {
      const sp = spaces.get(r.space);
      if (!sp) continue;
      const data = r.data;
      if (r.kind === 'room') sp.rooms.push(data);
      else if (r.kind === 'room_reservation') sp.roomReservations.set(data.id, data);
      else if (r.kind === 'room_waitlist') sp.roomWaitlist.set(data.id, data);
      else if (r.kind === 'tool') sp.tools.push(data);
      else if (r.kind === 'borrow') sp.borrows.set(data.id, data);
      else if (r.kind === 'material') sp.materialRequests.set(data.id, data);
      else if (r.kind === 'repair') sp.repairs.set(data.id, data);
      else if (r.kind === 'visitor') sp.visitors.set(data.id, data);
      else if (r.kind === 'notice') { sp.notices.push(data); sp.notices.sort((a, b) => (b.ts || 0) - (a.ts || 0)); }
      else if (r.kind === 'stall') { const st = sp.stalls.find((s) => s.id === data.id); if (st) st.ratings = (data.ratings || []).slice(-60); }
    }
    for (const [key, ratings] of Object.entries(byStall)) {
      const [ns, sid] = key.split('::');
      const sp = spaces.get(ns);
      if (!sp) continue;
      const st = sp.stalls.find((s) => s.id === +sid);
      if (st) st.ratings = ratings.slice(-60);
    }
  }

  function saveSpace(sp) {
    if (!usePg) return;
    trackWrite(pool.query(`INSERT INTO spaces(id,name,admins,squat_count,urinal_count,paused,paused_reason) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, admins=EXCLUDED.admins, squat_count=EXCLUDED.squat_count, urinal_count=EXCLUDED.urinal_count, paused=EXCLUDED.paused, paused_reason=EXCLUDED.paused_reason`,
      [sp.id, sp.name, JSON.stringify([...sp.admins]), sp.squatCount, sp.urinalCount, !!sp.paused, sp.pausedReason || '']).catch(() => {}));
  }
  function saveAccount(acct) {
    if (!usePg) return;
    trackWrite(pool.query(`INSERT INTO accounts(account,password_hash,username,avatar) VALUES($1,$2,$3,$4)
      ON CONFLICT(account) DO UPDATE SET username=EXCLUDED.username, avatar=EXCLUDED.avatar`,
      [acct.account, acct.passwordHash, acct.username, acct.avatar]).catch(() => {}));
  }
  const queuedProfiles = new Map();
  const queuedEntities = new Map();
  const inflightWrites = new Set();
  let flushTimer = null;
  function trackWrite(promise) {
    inflightWrites.add(promise);
    promise.catch(() => {}).finally(() => inflightWrites.delete(promise));
    return promise;
  }
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flushWrites, PERSIST_DEBOUNCE_MS);
    if (flushTimer.unref) flushTimer.unref();
  }
  async function flushWrites() {
    flushTimer = null;
    if (inflightWrites.size > 0) {
      try { await Promise.allSettled([...inflightWrites]); } catch {}
    }
    if (!usePg) { queuedProfiles.clear(); queuedEntities.clear(); return; }
    const pRows = [...queuedProfiles.values()];
    const eRows = [...queuedEntities.values()];
    queuedProfiles.clear();
    queuedEntities.clear();
    // 分块写入：单条 SQL 参数数上限为 65535，分块避免大批量写触发参数超限
    if (pRows.length) {
      try {
        for (let i = 0; i < pRows.length; i += 500) {
          const chunk = pRows.slice(i, i + 500);
          const valueSql = chunk.map((_, j) => `($${j * 6 + 1},$${j * 6 + 2},$${j * 6 + 3},$${j * 6 + 4},$${j * 6 + 5}::jsonb,$${j * 6 + 6})`).join(',');
          await pool.query(`INSERT INTO profiles(space,account,nick,avatar,stats,achievements) VALUES ${valueSql}
            ON CONFLICT(space,account) DO UPDATE SET nick=EXCLUDED.nick, avatar=EXCLUDED.avatar, stats=EXCLUDED.stats, achievements=EXCLUDED.achievements, updated_at=now()`, chunk.flat());
        }
      } catch (e) { console.error('⚠️ flush profiles 失败:', e.message); }
    }
    if (eRows.length) {
      try {
        for (let i = 0; i < eRows.length; i += 1000) {
          const chunk = eRows.slice(i, i + 1000);
          const valueSql = chunk.map((_, j) => `($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4}::jsonb)`).join(',');
          await pool.query(`INSERT INTO entities(space,kind,id,data) VALUES ${valueSql}
            ON CONFLICT(space,kind,id) DO UPDATE SET data=EXCLUDED.data`, chunk.flat());
        }
      } catch (e) { console.error('⚠️ flush entities 失败:', e.message); }
    }
  }
  function queueProfile(user, spaceId) {
    if (!spaceId || !spaces.has(spaceId)) return;
    const key = spaceId + '::' + user.account;
    const value = { account: user.account, nick: user.nickname, avatar: user.avatar, stats: { ...user.stats }, achievements: [...user.achievements] };
    profiles.set(key, value);
    reindexProfile(spaceId, user.account, value);
    if (!usePg) return;
    queuedProfiles.set(key, [spaceId, user.account, user.nickname, user.avatar, JSON.stringify(user.stats), user.achievements]);
    scheduleFlush();
  }
  function saveProfile(user) { queueProfile(user, user.currentSpace); }
  function saveEntity(spaceId, kind, id, data) {
    if (!usePg) return;
    queuedEntities.set(`${spaceId}|${kind}|${id}`, [spaceId, kind, id, JSON.stringify(data)]);
    scheduleFlush();
  }
  function deleteEntity(spaceId, kind, id) {
    if (!usePg) return;
    const key = `${spaceId}|${kind}|${id}`;
    queuedEntities.delete(key);
    trackWrite(pool.query(`DELETE FROM entities WHERE space=$1 AND kind=$2 AND id=$3`, [spaceId, kind, id]).catch(() => {}));
  }
  function saveStallRating(spaceId, stallId, r) {
    if (!usePg) return;
    trackWrite(pool.query(`INSERT INTO stall_ratings(space,stall_id,account,nickname,cleanliness,signal,paper) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [spaceId, stallId, r.account || '', r.nickname, r.cleanliness, r.signal, r.paper]).catch(() => {}));
  }
  function saveStatsToSpace(user, spaceId) { queueProfile(user, spaceId); }

  // ---------- 认证 ----------
  function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    return `${salt}:${hash}`;
  }
  function verifyPassword(pw, stored) {
    try {
      const [salt, hash] = String(stored).split(':');
      const calc = crypto.scryptSync(String(pw), salt, 64).toString('hex');
      return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'));
    } catch { return false; }
  }
  function issueToken(account) {
    const token = crypto.randomBytes(24).toString('base64url');
    tokens.set(token, { account, expiresAt: Date.now() + TOKEN_TTL });
    return token;
  }
  setInterval(() => { for (const [k, v] of tokens) if (v.expiresAt < Date.now()) tokens.delete(k); }, 3600000).unref();
  function accountByLogin(account) { return accounts.get(account); }

  // ---------- 空间 ----------
  function weekKey(ts) { const d = new Date(ts || Date.now()); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function newWeekly() { return { key: weekKey(), visits: 0, borrows: 0, requests: 0, repairs: 0, meetings: 0 }; }
  function newStats() { return { totalVisits: 0, totalDuration: 0, favoriteStall: null, onTimeRate: 0, consecutiveOnTime: 0, maxDuration: 0, nightVisits: 0, grabSuccess: 0, ratingsGiven: 0, borrowCount: 0, borrowDuration: 0, requestCount: 0, repairCount: 0, meetingCount: 0, meetingDuration: 0, weekly: newWeekly() }; }
  function recordWeekly(user, field) { if (!user.stats.weekly || user.stats.weekly.key !== weekKey()) user.stats.weekly = newWeekly(); user.stats.weekly[field] = (user.stats.weekly[field] || 0) + 1; }
  function weeklyScore(stats) { const w = stats.weekly; if (!w || w.key !== weekKey()) return 0; return (w.visits || 0) + (w.borrows || 0) + (w.requests || 0) + (w.repairs || 0) + (w.meetings || 0); }
  function borrowOverdue(b, now) {
    if (!b || b.status !== 'borrowed') return false;
    const nowMs = now == null ? Date.now() : now;
    const dueAt = b.dueAt || b.borrowedAt + 7 * 86400000;
    return nowMs >= dueAt;
  }
  // 逾期但尚未在静默期内重复提醒的借用（按 lastRemindedAt 去重）
  function dueBorrowReminders(space, now) {
    const nowMs = now == null ? Date.now() : now;
    return [...space.borrows.values()].filter((b) => {
      if (!borrowOverdue(b, nowMs)) return false;
      const last = b.lastRemindedAt || 0;
      return nowMs - last >= OVERDUE_REMIND_THROTTLE_MS;
    });
  }
  // 会议室预约临近开始、且尚未提醒过的待开始预约
  function dueRoomReminders(space, now) {
    const nowMs = now == null ? Date.now() : now;
    return [...space.roomReservations.values()].filter((r) => {
      if (r.status !== 'pending') return false;
      if (r.reminded) return false;
      if (!r.remindAt) return false;
      return nowMs >= r.remindAt;
    });
  }
  // 借用临近到期（默认到期前 24 小时内）且尚未提醒过的在借用
  function dueBorrowSoonReminders(space, now) {
    const nowMs = now == null ? Date.now() : now;
    return [...space.borrows.values()].filter((b) => {
      if (!b || b.status !== 'borrowed') return false;
      if (b.soonRemindedAt) return false;
      if (!b.dueAt) return false;
      return nowMs >= b.dueAt - BORROW_SOON_WINDOW_MS && nowMs < b.dueAt;
    });
  }
  function createSpace(id, name, squat, urinal) {
    const sp = {
      id, name, squatCount: squat == null ? 4 : squat, urinalCount: urinal == null ? 3 : urinal,
      admins: new Set(), clients: new Set(), notices: [],
      paused: false, pausedReason: '',
      rooms: [], roomReservations: new Map(), roomWaitlist: new Map(), reservations: new Map(),
      tools: [], borrows: new Map(), materialRequests: new Map(), repairs: new Map(), visitors: new Map(), urges: new Map(),
    };
    sp.stalls = buildStalls(squat == null ? 4 : squat, urinal == null ? 3 : urinal);
    spaces.set(id, sp);
    return sp;
  }
  function buildStalls(squat, urinal) {
    const stalls = [];
    for (let i = 1; i <= squat; i++) stalls.push({ id: i, type: 'squat', name: `蹲坑${i}`, status: 'free', currentUser: null, reservation: null, ratings: [] });
    for (let j = 1; j <= urinal; j++) stalls.push({ id: squat + j, type: 'urinal', name: `尿槽${j}`, status: 'free', currentUser: null, reservation: null, ratings: [] });
    return stalls;
  }
  function applyProfileToUser(user, spaceId) {
    user.stats = newStats();
    user.achievements = [];
    const pk = spaceId + '::' + user.account;
    if (profiles.has(pk)) {
      const p = profiles.get(pk);
      user.stats = Object.assign(newStats(), p.stats || {});
      user.achievements = [...(p.achievements || [])];
      if (p.avatar) user.avatar = p.avatar;
    }
  }

  // ---------- 会议室周期辅助 ----------
  function expandRecurring(startAt, endAt, repeat, count) {
    if (repeat !== 'daily' && repeat !== 'weekly') return [{ startAt, endAt }];
    const span = endAt - startAt;
    const maxCount = repeat === 'daily' ? 90 : 52;
    const n = Math.max(1, Math.min(parseInt(count, 10) || 1, maxCount));
    const step = repeat === 'daily' ? 86400000 : 7 * 86400000;
    const out = [];
    for (let i = 0; i < n; i++) { const s = startAt + i * step; out.push({ startAt: s, endAt: s + span }); }
    return out;
  }

  // ---------- 会议室统计 ----------
  function roomUsageStats(space, now) {
    const nowMs = now == null ? Date.now() : now;
    const ds = new Date(nowMs); ds.setHours(0, 0, 0, 0);
    const dStart = ds.getTime(), dEnd = dStart + 86400000;
    const workStart = new Date(ds); workStart.setHours(9, 0, 0, 0);
    const workEnd = new Date(ds); workEnd.setHours(21, 0, 0, 0);
    const rooms = space.rooms.map((r) => {
      const res = [...space.roomReservations.values()].filter((x) => x.roomId === r.id && x.status !== 'cancelled' && x.status !== 'expired');
      const today = res.filter((x) => x.startAt >= dStart && x.startAt < dEnd);
      const upcoming = res.filter((x) => x.startAt >= nowMs && x.status === 'pending');
      const todayMinutes = today.reduce((s, x) => s + Math.max(0, Math.round((Math.min(x.endAt, dEnd) - x.startAt) / 60000)), 0);
      return { roomId: r.id, name: r.name, capacity: r.capacity, todayCount: today.length, todayMinutes, upcomingCount: upcoming.length };
    });
    const totalToday = rooms.reduce((s, r) => s + r.todayMinutes, 0);
    const capacity = space.rooms.length * (workEnd - workStart) / 60000;
    return { rooms, totalTodayMinutes: totalToday, capacityMinutes: capacity, utilizationPct: capacity ? Math.round(totalToday / capacity * 100) : 0, workStart: workStart.getTime(), workEnd: workEnd.getTime() };
  }

  // ---------- 序列化 ----------
  function roomPublic(r) { return { id: r.id, name: r.name, capacity: r.capacity, location: r.location, description: r.description }; }
  function reservationPublic(res, info) {
    const who = info.get(res.ownerAccount);
    return { id: res.id, roomId: res.roomId, ownerAccount: res.ownerAccount, ownerName: who ? who.display : res.ownerName, title: res.title, startAt: res.startAt, endAt: res.endAt, note: res.note, status: res.status, repeat: res.repeat || null, seriesId: res.seriesId || null, remindAt: res.remindAt || null, participants: res.participants || null };
  }
  function roomWaitlistPublic(space, info) {
    if (!info) info = spaceUserInfo(space.id);
    return [...space.roomWaitlist.values()].filter((w) => w.status === 'waiting').map((w) => {
      const who = info.get(w.ownerAccount);
      return { id: w.id, roomId: w.roomId, ownerAccount: w.ownerAccount, ownerName: who ? who.display : w.ownerName, title: w.title, startAt: w.startAt, endAt: w.endAt, note: w.note, createdAt: w.createdAt };
    }).sort((a, b) => a.createdAt - b.createdAt);
  }
    function toolsPublic(sp, info) {
    const now = Date.now();
    const activeByTool = new Map();
    for (const b of sp.borrows.values()) {
      if (b.status !== 'borrowed') continue;
      const arr = activeByTool.get(b.toolId) || [];
      arr.push(b);
      activeByTool.set(b.toolId, arr);
    }
    return sp.tools.map((t) => {
      const active = activeByTool.get(t.id) || [];
      return {
        id: t.id, name: t.name, category: t.category, total: t.total, available: t.available,
        location: t.location, description: t.description,
        borrowedCount: active.reduce((s, b) => s + b.qty, 0),
        activeBorrows: active.map((b) => { const days = Math.floor((now - b.borrowedAt) / 86400000); return { id: b.id, qty: b.qty, borrowerAccount: b.borrowerAccount, borrowerName: info.get(b.borrowerAccount) ? info.get(b.borrowerAccount).display : b.borrowerName, borrowedAt: b.borrowedAt, dueAt: b.dueAt || null, days, overdue: borrowOverdue(b, now), reminded: !!b.lastRemindedAt, dueSoon: b.status === 'borrowed' && !!b.dueAt && now >= b.dueAt - BORROW_SOON_WINDOW_MS && now < b.dueAt }; }),
      };
    });
  }
  function materialsPublic(sp, info) {
    return [...sp.materialRequests.values()].map((m) => ({
      id: m.id, name: m.name, qty: m.qty, unit: m.unit, reason: m.reason, status: m.status,
      requesterAccount: m.requesterAccount,
      requesterName: info.get(m.requesterAccount) ? info.get(m.requesterAccount).display : m.requesterName,
      handlerAccount: m.handlerAccount || null,
      handlerName: info.get(m.handlerAccount) ? info.get(m.handlerAccount).display : (m.handlerName || ''),
      createdAt: m.createdAt, handledAt: m.handledAt,
    })).sort((a, b) => (b.createdAt - a.createdAt));
  }
  function repairsPublic(sp, info) {
    return [...sp.repairs.values()].map((r) => ({
      id: r.id, category: r.category, priority: r.priority || 'normal', location: r.location, description: r.description, status: r.status,
      reporterAccount: r.reporterAccount,
      reporterName: info.get(r.reporterAccount) ? info.get(r.reporterAccount).display : r.reporterName,
      handlerAccount: r.handlerAccount || null,
      handlerName: info.get(r.handlerAccount) ? info.get(r.handlerAccount).display : (r.handlerName || ''),
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    })).sort((a, b) => (b.createdAt - a.createdAt));
  }
  function borrowsPublic(sp, info) {
    return [...sp.borrows.values()].map((b) => {
      const tool = sp.tools.find((t) => t.id === b.toolId);
      return {
        id: b.id, toolId: b.toolId, toolName: tool ? tool.name : '', toolCategory: tool ? tool.category : '',
        borrowerAccount: b.borrowerAccount,
        borrowerName: info.get(b.borrowerAccount) ? info.get(b.borrowerAccount).display : b.borrowerName,
        qty: b.qty, borrowedAt: b.borrowedAt, dueAt: b.dueAt || null, returnedAt: b.returnedAt || null,
        status: b.status, overdue: borrowOverdue(b), soonReminded: !!b.soonRemindedAt,
      };
    }).sort((a, b) => (b.borrowedAt - a.borrowedAt));
  }
  function visitorsPublic(sp, info) {
    return [...sp.visitors.values()].map((v) => ({
      id: v.id,
      hostAccount: v.hostAccount,
      hostName: info.get(v.hostAccount) ? info.get(v.hostAccount).display : v.hostName,
      visitorName: v.visitorName, purpose: v.purpose, contact: v.contact || '',
      expectedAt: v.expectedAt || null, arrivedAt: v.arrivedAt || null, leftAt: v.leftAt || null,
      status: v.status, createdAt: v.createdAt, code: v.code || '',
      expiresAt: v.expiresAt || null, expired: visitorCodeExpired(v),
    })).sort((a, b) => (b.createdAt - a.createdAt));
  }
  function visitorCodeExpired(v, now) {
    const nowMs = now == null ? Date.now() : now;
    return !!(v && v.expiresAt && nowMs > v.expiresAt);
  }
  function stallTier(s) {
    if (s.__tier && s.__tierAt === s.ratings.length) return s.__tier;
    const n = s.ratings.length;
    if (!n) return { name: '新坑', icon: '🌱', rank: 0, avg: 0, count: 0 };
    let sum = 0;
    for (const r of s.ratings) sum += (r.cleanliness + r.signal + r.paper) / 3;
    const avg = sum / n;
    const score = avg * 16 + Math.min(n, 10) * 2;
    let name = score >= 85 ? '王者' : score >= 68 ? '黄金' : score >= 50 ? '白银' : '青铜';
    const icon = name === '王者' ? '👑' : name === '黄金' ? '🏅' : name === '白银' ? '🥈' : '🥉';
    const tier = { name, icon, rank: Math.round(score), avg: +avg.toFixed(1), count: n };
    s.__tier = tier;
    s.__tierAt = n;
    return tier;
  }
  function stallsPublic(sp, info) {
    return sp.stalls.map((s) => {
      const o = { id: s.id, type: s.type, name: s.name, status: s.status, urgeCount: sp.urges.get(s.id) || 0, ratings: s.ratings, tier: stallTier(s), reservation: null, currentBy: null };
      if (s.reservation) {
        const w = info.get(s.reservation.account) || {};
        const who = { account: s.reservation.account, display: w.display || s.reservation.nickname, avatar: w.avatar || '🧑' };
        o.reservation = { by: who, startTime: s.reservation.startTime, endTime: s.reservation.endTime, duration: s.reservation.duration, isGrab: !!s.reservation.isGrab, reservationId: s.reservation.reservationId };
        if (s.status === 'occupied' || s.status === 'reserved' || s.status === 'waiting') o.currentBy = who;
      }
      return o;
    });
  }
  function leaderboardPublic(sp) {
    const rows = [];
    const bySpace = profilesBySpace.get(sp.id);
    if (bySpace) {
      for (const [, p] of bySpace) {
        rows.push({ account: p.account, username: p.nick || p.account, avatar: p.avatar || '🧑', stats: p.stats || {}, achievements: p.achievements || [], weekly: weeklyScore(p.stats || {}) });
      }
    }
    const score = (s) => (s.totalVisits || 0) + (s.borrowCount || 0) + (s.requestCount || 0) + (s.repairCount || 0) + (s.meetingCount || 0);
    const maxWeekly = rows.reduce((m, r) => Math.max(m, r.weekly || 0), 0);
    rows.forEach((r) => { r.mvp = (r.weekly || 0) > 0 && (r.weekly || 0) === maxWeekly; });
    rows.sort((a, b) => score(b.stats) - score(a.stats));
    rows.forEach((r, i) => { r.rank = i + 1; });
    return { rankings: rows.slice(0, 30) };
  }
  function roomReservationsPublic(space, info) {
    if (!info) info = spaceUserInfo(space.id);
    return [...space.roomReservations.values()].map((r) => reservationPublic(r, info)).sort((a, b) => a.startAt - b.startAt);
  }
  function pruneRoomReservations(space, before, max = 200) {
    let removed = 0;
    for (const [id, r] of [...space.roomReservations]) {
      if (removed >= max) break;
      if (r.status !== 'completed' && r.status !== 'cancelled' && r.status !== 'expired') continue;
      const ts = r.endAt || r.startAt || 0;
      if (ts >= before) continue;
      space.roomReservations.delete(id);
      deleteEntity(space.id, 'room_reservation', id);
      removed++;
    }
    return removed;
  }

  // ---------- 广播 ----------
  function broadcast(spaceId, type, payload) { broadcastTo(spaceId, Object.assign({ type }, payload)); }
  function broadcastUsers(sp) {
    const info = spaceUserInfo(sp.id);
    const arr = [];
    for (const [, u] of users) {
      if (u.currentSpace !== sp.id) continue;
      const d = info.get(u.account) || {};
      arr.push({ account: u.account, online: true, username: u.nickname, avatar: u.avatar, role: d.role || 'member', display: d.display || u.nickname, status: u.status || { label: '在岗' }, emergencyMode: !!u.emergencyMode });
    }
    broadcast(sp.id, 'users', { users: arr });
  }
  function broadcastLeaderboard(sp) { broadcast(sp.id, 'leaderboard', leaderboardPublic(sp)); }
  function noticesBroadcast(sp) { broadcast(sp.id, 'notices', { notices: sp.notices }); }
  function visitorsBroadcast(sp) {
    const info = spaceUserInfo(sp.id);
    const all = visitorsPublic(sp, info);
    broadcast(sp.id, 'visitors', { visitors: all.slice(0, LIST_PAGE), total: all.length });
  }
  function broadcastStalls(sp) {
    const info = spaceUserInfo(sp.id);
    broadcast(sp.id, 'stalls', { squat_count: sp.squatCount, urinal_count: sp.urinalCount, stalls: stallsPublic(sp, info) });
  }
  function roomStatsBroadcast(sp) { broadcast(sp.id, 'roomStats', roomUsageStats(sp)); }
  function broadcastAll(sp) {
    const info = spaceUserInfo(sp.id);
    const reservations = roomReservationsPublic(sp, info);
    const waitlist = roomWaitlistPublic(sp, info);
    const materials = materialsPublic(sp, info);
    const repairs = repairsPublic(sp, info);
    const visitors = visitorsPublic(sp, info);
    broadcast(sp.id, 'rooms', { rooms: sp.rooms.map(roomPublic), reservations: reservations.slice(0, LIST_PAGE), reservationTotal: reservations.length, waitlist: waitlist.slice(0, LIST_PAGE), waitlistTotal: waitlist.length });
    broadcast(sp.id, 'tools', { tools: toolsPublic(sp, info) });
    broadcast(sp.id, 'materials', { requests: materials.slice(0, LIST_PAGE), total: materials.length });
    broadcast(sp.id, 'repairs', { repairs: repairs.slice(0, LIST_PAGE), total: repairs.length });
    broadcast(sp.id, 'visitors', { visitors: visitors.slice(0, LIST_PAGE), total: visitors.length });
    broadcast(sp.id, 'stalls', { squat_count: sp.squatCount, urinal_count: sp.urinalCount, stalls: stallsPublic(sp, info) });
    broadcast(sp.id, 'notices', { notices: sp.notices });
    roomStatsBroadcast(sp);
    broadcastUsers(sp);
    broadcastLeaderboard(sp);
  }

  // ---------- 坑位看板辅助 ----------
  function activeStallCount(space, user) {
    let n = 0;
    for (const st of space.stalls) if (st.reservation && st.reservation.account === user.account) n++;
    return n;
  }
  const ACHIEVEMENT_DEFS = [
    { id: 'punctual', name: '守时达人', desc: '连续3次准时到坑', icon: '⏰', check: (u) => u.stats.consecutiveOnTime >= 3 },
    { id: 'endurance', name: '持久战', desc: '单次蹲坑超过20分钟', icon: '🐌', check: (u) => u.stats.maxDuration >= 20 },
    { id: 'night', name: '夜行者', desc: '凌晨时段使用', icon: '🌙', check: (u) => u.stats.nightVisits >= 1 },
    { id: 'king', name: '蹲坑之王', desc: '累计使用超过10次', icon: '👑', check: (u) => u.stats.totalVisits >= 10 },
    { id: 'grabber', name: '抢位达人', desc: '临时抢位成功5次', icon: '⚡', check: (u) => u.stats.grabSuccess >= 5 },
    { id: 'rater', name: '评论家', desc: '给坑位评分3次', icon: '✍️', check: (u) => u.stats.ratingsGiven >= 3 },
    { id: 'borrower', name: '借阅达人', desc: '累计借用设备超过3次', icon: '💳', check: (u) => (u.stats.borrowCount || 0) >= 3 },
    { id: 'requester', name: '物资管家', desc: '累计申领物资超过3次', icon: '📦', check: (u) => (u.stats.requestCount || 0) >= 3 },
    { id: 'reporter', name: '热心市民', desc: '累计上报报修超过3次', icon: '🛠️', check: (u) => (u.stats.repairCount || 0) >= 3 },
    { id: 'meeter', name: '会议达人', desc: '累计会议时长超过60分钟', icon: '🗓️', check: (u) => (u.stats.meetingDuration || 0) >= 60 },
  ];
  function checkAchievements(user) {
    let changed = false;
    for (const a of ACHIEVEMENT_DEFS) {
      if (a.check(user) && !user.achievements.includes(a.id)) { user.achievements.push(a.id); changed = true; }
    }
    return changed;
  }
  // 成就进度：把「check」的判定口径与对应统计字段、目标值显式化，避免进度无法计算
  const ACH_TARGETS = {
    punctual: { field: 'consecutiveOnTime', target: 3 },
    endurance: { field: 'maxDuration', target: 20 },
    night: { field: 'nightVisits', target: 1 },
    king: { field: 'totalVisits', target: 10 },
    grabber: { field: 'grabSuccess', target: 5 },
    rater: { field: 'ratingsGiven', target: 3 },
    borrower: { field: 'borrowCount', target: 3 },
    requester: { field: 'requestCount', target: 3 },
    reporter: { field: 'repairCount', target: 3 },
    meeter: { field: 'meetingDuration', target: 60 },
  };
  function achievementProgress(user, def) {
    const t = ACH_TARGETS[def.id] || { field: 'totalVisits', target: 1 };
    const current = Math.max(0, user.stats ? (user.stats[t.field] || 0) : 0);
    const unlocked = !!(def.check(user));
    return {
      id: def.id, name: def.name, desc: def.desc, icon: def.icon,
      current, target: t.target,
      pct: t.target ? Math.min(100, Math.round(current / t.target * 100)) : (unlocked ? 100 : 0),
      unlocked,
    };
  }
  function achievementDefsPublic(user) {
    return ACHIEVEMENT_DEFS.map((d) => achievementProgress(user, d));
  }
  function notifyUrge(space, stallId, count, account) {
    for (const [, u] of users) if (u.currentSpace === space.id && u.account === account && u.ws && u.ws.readyState === 1) u.ws.send(JSON.stringify({ type: 'urgeNotification', stallId, count }));
  }

  // ---------- 每日看点 ----------
  function buildDigest(space, user) {
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const today0 = day0.getTime(), todayEnd = today0 + 86400000;
    const todayMeetings = roomReservationsPublic(space).filter((r) => r.startAt >= today0 && r.startAt < todayEnd && r.status !== 'cancelled' && r.status !== 'expired');
    const overdue = [...space.borrows.values()].filter((b) => borrowOverdue(b));
    const myBorrows = [...space.borrows.values()].filter((b) => b.borrowerAccount === user.account && b.status === 'borrowed');
    const pendingMaterials = [...space.materialRequests.values()].filter((r) => r.status === 'pending');
    const openRepairs = [...space.repairs.values()].filter((r) => r.status === 'reported' || r.status === 'in_progress');
    const pendingVisitors = [...space.visitors.values()].filter((v) => v.status === 'pending' || v.status === 'arrived');
    const todayMeetingMinutes = todayMeetings.reduce((s, r) => s + Math.max(0, Math.round((Math.min(r.endAt, todayEnd) - r.startAt) / 60000)), 0);
    const todayBorrowMinutes = [...space.borrows.values()].filter((b) => b.returnedAt && b.returnedAt >= today0 && b.returnedAt < todayEnd).reduce((s, b) => s + Math.max(0, Math.round((b.returnedAt - b.borrowedAt) / 60000)), 0);
    const mvp = leaderboardPublic(space).rankings.find((r) => r.mvp) || null;
    return { todayMeetingCount: todayMeetings.length, todayMeetings: todayMeetings.slice(0, 5), todayMeetingMinutes, todayBorrowMinutes, overdueCount: overdue.length, myBorrows: myBorrows.length, pendingMaterialsCount: pendingMaterials.length, openRepairsCount: openRepairs.length, pendingVisitorsCount: pendingVisitors.length, pendingVisitors: pendingVisitors.slice(0, 5).map((v) => ({ visitorName: v.visitorName, hostName: v.hostName, status: v.status })), mvp };
  }

  // ---------- 我的待办 ----------
  // 聚合当前用户与个人相关的到期/待处理事项：逾期借用、临近会议、待接待访客、指派给我的物资与报修
  function buildMyReminders(space, user, now) {
    const nowMs = now == null ? Date.now() : now;
    const overdue = [...space.borrows.values()].filter((b) => b.borrowerAccount === user.account && borrowOverdue(b, nowMs));
    const upcoming = [...space.roomReservations.values()].filter((r) => r.ownerAccount === user.account && r.status === 'pending' && r.startAt >= nowMs && r.startAt <= nowMs + 60 * 60000);
    const pendingVisitors = [...space.visitors.values()].filter((v) => v.hostAccount === user.account && (v.status === 'pending' || v.status === 'arrived'));
    const assignedMaterials = [...space.materialRequests.values()].filter((m) => m.handlerAccount === user.account && m.status !== 'fulfilled' && m.status !== 'cancelled');
    const assignedRepairs = [...space.repairs.values()].filter((r) => r.handlerAccount === user.account && (r.status === 'reported' || r.status === 'in_progress'));
    return {
      overdueCount: overdue.length,
      overdue: overdue.map((b) => ({ id: b.id, toolId: b.toolId, qty: b.qty, dueAt: b.dueAt || null, days: Math.floor((nowMs - (b.borrowedAt || nowMs)) / 86400000) })),
      upcomingCount: upcoming.length,
      upcoming: upcoming.map((r) => ({ id: r.id, roomId: r.roomId, title: r.title, startAt: r.startAt, endAt: r.endAt })),
      pendingVisitorCount: pendingVisitors.length,
      pendingVisitors: pendingVisitors.map((v) => ({ id: v.id, visitorName: v.visitorName, status: v.status })),
      assignedMaterialCount: assignedMaterials.length,
      assignedMaterials: assignedMaterials.map((m) => ({ id: m.id, name: m.name, status: m.status })),
      assignedRepairCount: assignedRepairs.length,
      assignedRepairs: assignedRepairs.map((r) => ({ id: r.id, category: r.category, location: r.location, status: r.status })),
    };
  }

  // ---------- 空间活跃趋势 ----------
  // 按天聚合会议室 / 借用 / 申领 / 报修 / 访客的活动量，供空间趋势看板展示
  function buildSpaceTrend(space, days) {
    const n = Math.max(1, Math.min(30, parseInt(days, 10) || 7));
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    const dayStart = today0.getTime() - (n - 1) * 86400000;
    const buckets = [];
    for (let i = 0; i < n; i++) buckets.push({ date: dayStart + i * 86400000, meetings: 0, borrows: 0, requests: 0, repairs: 0, visitors: 0 });
    const idxOf = (ts) => Math.floor((ts - dayStart) / 86400000);
    const bump = (b, k) => { if (b >= 0 && b < n) buckets[b][k]++; };
    for (const r of space.roomReservations.values()) {
      if (r.status === 'cancelled' || r.status === 'expired') continue;
      bump(idxOf(r.startAt), 'meetings');
    }
    for (const b of space.borrows.values()) { bump(idxOf(b.borrowedAt), 'borrows'); }
    for (const m of space.materialRequests.values()) { bump(idxOf(m.createdAt), 'requests'); }
    for (const r of space.repairs.values()) { bump(idxOf(r.createdAt), 'repairs'); }
    for (const v of space.visitors.values()) { bump(idxOf(v.createdAt), 'visitors'); }
    return buckets.map((b) => ({ date: b.date, meetings: b.meetings, borrows: b.borrows, requests: b.requests, repairs: b.repairs, visitors: b.visitors }));
  }

  return {
    // 状态
    spaces, users, accounts, tokens, profiles,
    // 访问器
    LIST_PAGE, RESERVE_CONFIRM_WINDOW_MS, OVERDUE_REMIND_THROTTLE_MS, ROOM_REMIND_WINDOW_MS, BORROW_SOON_WINDOW_MS, VISIT_TOKEN_TTL_MS, WS_PING_MS, REPAIR_CATEGORIES, REPAIR_PRIORITIES, TOOL_CATEGORIES,
    pool,
    get pgEnabled() { return usePg; },
    set pgEnabled(v) { usePg = v; },
    initDb, flushWrites, scheduleFlush,
    // 工具
    genId, genSpaceId, genCheckinCode, sendTo, broadcastTo, sendToUser, sendToAccount, getUsersIn, getUserByAccount, isAdmin, serError, lk, spaceUserInfo,
    // 认证
    hashPassword, verifyPassword, issueToken, accountByLogin,
    // 持久化
    saveSpace, saveAccount, saveProfile, saveEntity, deleteEntity, saveStallRating, saveStatsToSpace,
    // 空间
    weekKey, newWeekly, newStats, recordWeekly, weeklyScore, borrowOverdue, dueBorrowReminders, dueRoomReminders, dueBorrowSoonReminders, createSpace, buildStalls, applyProfileToUser,
    // 序列化
    roomPublic, reservationPublic, roomWaitlistPublic, toolsPublic, materialsPublic, repairsPublic, borrowsPublic, visitorsPublic, visitorCodeExpired, stallsPublic, leaderboardPublic, roomReservationsPublic, pruneRoomReservations, stallTier, expandRecurring, roomUsageStats,
    // 广播
    broadcast, broadcastAll, broadcastUsers, broadcastLeaderboard, broadcastStalls, roomStatsBroadcast, noticesBroadcast, visitorsBroadcast,
    // 坑位辅助
    activeStallCount, checkAchievements, notifyUrge, ACHIEVEMENT_DEFS,
    achievementProgress, achievementDefsPublic,
    // 每日看点
    buildDigest,
    // 我的待办
    buildMyReminders,
    // 空间活跃趋势
    buildSpaceTrend,
  };
}

module.exports = { createContext };