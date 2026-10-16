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
  const INVENTORY_CATEGORIES = ['办公文具', '打印耗材', '电池', '清洁用品', '食品饮料', '其它'];
  const OOO_CATEGORIES = ['外出', '请假', '出差', '调休', '其他'];
  const FEEDBACK_CATEGORIES = ['建议', '吐槽', '问题', '表扬'];
  const MATERIAL_PRIORITIES = ['high', 'normal', 'low'];
  const MOOD_EMOJIS = ['😊', '😐', '😴', '😡', '🤩', '🥲'];
  const EVENT_CATEGORIES = ['培训', '分享会', '团建', '生日会', '会议', '其它'];
  const POLL_MAX_OPTIONS = 5;
  const KNOWLEDGE_CATEGORIES = ['规章制度', '操作指引', '设备说明', '常见问题', '其他'];
  const TASK_PRIORITIES = ['high', 'normal', 'low'];
  const TASK_STATUSES = ['pending', 'in_progress', 'done', 'cancelled'];
  const NOTIFICATION_LEVELS = ['info', 'warn', 'success'];
  const LIST_PAGE = 30;
  const PERSIST_DEBOUNCE_MS = 500;
  const WS_PING_MS = 30000;
  const RESERVE_CONFIRM_WINDOW_MS = 5 * 60000;
  const OVERDUE_REMIND_THROTTLE_MS = 24 * 3600 * 1000;
  const ROOM_REMIND_WINDOW_MS = 10 * 60000;
  const BORROW_SOON_WINDOW_MS = 24 * 3600 * 1000;
  const OOO_RETURN_WINDOW_MS = 30 * 60000;
  const OOO_RETURN_REMIND_THROTTLE_MS = 4 * 3600 * 1000;
  const VISIT_REMIND_WINDOW_MS = 15 * 60000;
  const REPAIR_SLA_MS = 4 * 3600 * 1000;
  const MATERIAL_SLA_MS = 2 * 24 * 3600 * 1000;
  const REPAIR_ESCALATE_MS = 8 * 3600 * 1000;
  const VISIT_TOKEN_TTL_MS = 24 * 3600 * 1000;
  const ATTEND_DEFAULT_WORK_START = '09:00';
  const ATTEND_DEFAULT_WORK_END = '18:00';
  const ATTEND_DEFAULT_LATE_MINUTES = 15;

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
    const sp = spaces.get(spaceId);
    const activeOoo = new Map();
    if (sp) for (const r of sp.ooo.values()) if (r.status === 'active') activeOoo.set(r.account, r);
    for (const u of getUsersIn(spaceId)) {
      const ooo = activeOoo.get(u.account);
      const status = u.status || { label: '在岗' };
      info.set(u.account, { account: u.account, username: u.nickname, avatar: u.avatar, online: true, role: isAdmin(sp, u.account) ? 'admin' : 'member', status: ooo ? Object.assign({}, status, { label: ooo.category, emoji: status.emoji || (ooo.category === '出差' ? '✈️' : ooo.category === '请假' ? '📅' : '🚶') }) : status });
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
      else if (r.kind === 'material_template') sp.materialTemplates.set(data.id, data);
      else if (r.kind === 'inventory') sp.inventory.push(data);
      else if (r.kind === 'inventory_issue') sp.inventoryIssues.set(data.id, data);
      else if (r.kind === 'repair') sp.repairs.set(data.id, data);
      else if (r.kind === 'visitor') sp.visitors.set(data.id, data);
      else if (r.kind === 'attendance') sp.attendanceConfig = Object.assign(newAttendanceConfig(), data || {});
      else if (r.kind === 'attendance_record') sp.attendance.set(`${data.account}::${data.date}`, data);
      else if (r.kind === 'desk') sp.desks.push(data);
      else if (r.kind === 'desk_reservation') sp.deskReservations.set(data.id, data);
      else if (r.kind === 'ooo') sp.ooo.set(data.id, data);
      else if (r.kind === 'feedback') sp.feedbacks.set(data.id, data);
      else if (r.kind === 'mood') sp.moods.set(data.id, data);
      else if (r.kind === 'event') sp.events.set(data.id, data);
      else if (r.kind === 'poll') sp.polls.set(data.id, data);
      else if (r.kind === 'knowledge') sp.knowledge.set(data.id, data);
      else if (r.kind === 'notification') sp.notifications.set(data.id, data);
      else if (r.kind === 'task') sp.tasks.set(data.id, data);
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
  function newWeekly() { return { key: weekKey(), visits: 0, borrows: 0, requests: 0, repairs: 0, meetings: 0, attends: 0, desks: 0, ooo: 0, events: 0, polls: 0, tasks: 0 }; }
  function newStats() { return { totalVisits: 0, totalDuration: 0, favoriteStall: null, onTimeRate: 0, consecutiveOnTime: 0, maxDuration: 0, nightVisits: 0, grabSuccess: 0, ratingsGiven: 0, borrowCount: 0, borrowDuration: 0, requestCount: 0, repairCount: 0, meetingCount: 0, meetingDuration: 0, meetingActualDuration: 0, helperCount: 0, favoriteRooms: [], roomRatesGiven: 0, favoriteCount: 0, attendanceCount: 0, earlyCount: 0, deskCount: 0, oooCount: 0, eventCount: 0, eventAttendCount: 0, pollCreateCount: 0, pollVoteCount: 0, knowledgeCount: 0, knowledgeLikeCount: 0, taskCreateCount: 0, taskDoneCount: 0, attendanceStreak: 0, attendancePerfectMonths: 0, weekly: newWeekly() }; }
  function recordWeekly(user, field) { if (!user.stats.weekly || user.stats.weekly.key !== weekKey()) user.stats.weekly = newWeekly(); user.stats.weekly[field] = (user.stats.weekly[field] || 0) + 1; }
  function weeklyScore(stats) { const w = stats.weekly; if (!w || w.key !== weekKey()) return 0; return (w.visits || 0) + (w.borrows || 0) + (w.requests || 0) + (w.repairs || 0) + (w.meetings || 0) + (w.attends || 0) + (w.desks || 0) + (w.ooo || 0) + (w.events || 0) + (w.polls || 0) + (w.tasks || 0); }
  function borrowOverdue(b, now) {
    if (!b || b.status !== 'borrowed') return false;
    const nowMs = now == null ? Date.now() : now;
    const dueAt = b.dueAt || b.borrowedAt + 7 * 86400000;
    return nowMs >= dueAt;
  }
  // 低库存预警：可用数 ≤ 阈值（默认 1）即视为库存告急
  function isStockLow(item) {
    if (!item) return false;
    const min = Number.isInteger(item.minAvailable) ? item.minAvailable : 1;
    return item.available <= min;
  }
  function isToolLowStock(tool) { return isStockLow(tool); }
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
  // 活动开始前提醒：开始前 10 分钟内提醒一次，避免刷屏
  function dueEventReminders(space, now) {
    const nowMs = now == null ? Date.now() : now;
    return [...space.events.values()].filter((e) => {
      if (e.cancelled) return false;
      if (e.reminded) return false;
      if (!e.remindAt) return false;
      return nowMs >= e.remindAt && nowMs < e.startAt;
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
  // 外出登记临近预计返回（默认前 30 分钟内）且尚未提醒过的外出记录
  function dueOooReturnReminders(space, now) {
    const nowMs = now == null ? Date.now() : now;
    return [...space.ooo.values()].filter((r) => {
      if (!r || r.status !== 'active') return false;
      if (!r.expectedReturnAt) return false;
      if (r.returnRemindedAt) return false;
      return nowMs >= r.expectedReturnAt - OOO_RETURN_WINDOW_MS && nowMs < r.expectedReturnAt;
    });
  }
  // 访客临近预计到访（默认到访前 15 分钟内）且尚未提醒过的待到访访客
  function dueVisitorReminders(space, now) {
    const nowMs = now == null ? Date.now() : now;
    return [...space.visitors.values()].filter((v) => {
      if (!v || v.status !== 'pending') return false;
      if (v.reminded) return false;
      if (!v.remindAt) return false;
      return nowMs >= v.remindAt;
    });
  }
  // 报修超过 SLA 仍未处理（reported），提醒上报人与管理员跟进
  function dueRepairSlaReminders(space, now) {
    const nowMs = now == null ? Date.now() : now;
    return [...space.repairs.values()].filter((r) => {
      if (!r || r.status !== 'reported') return false;
      if (r.slaRemindedAt) return false;
      return nowMs >= (r.createdAt || 0) + REPAIR_SLA_MS;
    });
  }
  // 物资申领超过 SLA 仍未处理（pending），提醒申请人与管理员跟进
  function dueMaterialSlaReminders(space, now) {
    const nowMs = now == null ? Date.now() : now;
    return [...space.materialRequests.values()].filter((m) => {
      if (!m || m.status !== 'pending') return false;
      if (m.slaRemindedAt) return false;
      return nowMs >= (m.createdAt || 0) + MATERIAL_SLA_MS;
    });
  }
  // 高优先级报修超过升级阈值仍未解决（reported/in_progress），升级一次提醒上报人与所有管理员
  function dueRepairEscalations(space, now) {
    const nowMs = now == null ? Date.now() : now;
    return [...space.repairs.values()].filter((r) => {
      if (!r) return false;
      if (r.status !== 'reported' && r.status !== 'in_progress') return false;
      if (r.priority !== 'high') return false;
      if (r.escalatedAt) return false;
      return nowMs >= (r.createdAt || 0) + REPAIR_ESCALATE_MS;
    });
  }
  // 报修重复检测：同一空间下相同类型 + 相同位置、且仍未解决/取消的报修视为重复
  function findDuplicateRepair(space, category, location) {
    const loc = String(location || '').trim().toLowerCase();
    if (!loc) return null;
    let found = null;
    for (const r of space.repairs.values()) {
      if (r.status !== 'reported' && r.status !== 'in_progress') continue;
      if (r.category !== category) continue;
      if (String(r.location || '').trim().toLowerCase() !== loc) continue;
      if (!found || r.createdAt > found.createdAt) found = r;
    }
    return found;
  }
  function createSpace(id, name, squat, urinal) {
    const sp = {
      id, name, squatCount: squat == null ? 4 : squat, urinalCount: urinal == null ? 3 : urinal,
      admins: new Set(), clients: new Set(), notices: [],
      paused: false, pausedReason: '',
      rooms: [], roomReservations: new Map(), roomWaitlist: new Map(), reservations: new Map(),
      tools: [], borrows: new Map(), toolWaitlist: new Map(), materialRequests: new Map(), materialTemplates: new Map(), repairs: new Map(), visitors: new Map(), urges: new Map(), inventory: [], inventoryIssues: new Map(),
      attendanceConfig: newAttendanceConfig(), attendance: new Map(),
      desks: [], deskReservations: new Map(), ooo: new Map(), feedbacks: new Map(), moods: new Map(),
      events: new Map(), polls: new Map(), knowledge: new Map(),
      notifications: new Map(), tasks: new Map(),
    };
    sp.weeklyReportDate = null;
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
      const actualMinutes = today.reduce((s, x) => {
        if (!x.actualStartAt || !x.actualEndAt) return s;
        return s + Math.max(0, Math.round((x.actualEndAt - x.actualStartAt) / 60000));
      }, 0);
      const rsum = roomRatingSummary(space, r.id);
      return { roomId: r.id, name: r.name, capacity: r.capacity, todayCount: today.length, todayMinutes, actualMinutes, upcomingCount: upcoming.length, ratingAvg: rsum.avg, ratingCount: rsum.count };
    });
    const totalToday = rooms.reduce((s, r) => s + r.todayMinutes, 0);
    const totalActual = rooms.reduce((s, r) => s + r.actualMinutes, 0);
    const capacity = space.rooms.length * (workEnd - workStart) / 60000;
    return { rooms, totalTodayMinutes: totalToday, totalActualMinutes: totalActual, capacityMinutes: capacity, utilizationPct: capacity ? Math.round(totalToday / capacity * 100) : 0, workStart: workStart.getTime(), workEnd: workEnd.getTime() };
  }

  // ---------- 考勤打卡 ----------
  // 考勤规则 + 今日打卡记录；按「账号::日期」存 Map，支持多人同一天各有一条记录
  function todayKey(ts) {
    const d = new Date(ts == null ? Date.now() : ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function newAttendanceConfig() {
    return { workStart: ATTEND_DEFAULT_WORK_START, workEnd: ATTEND_DEFAULT_WORK_END, lateMinutes: ATTEND_DEFAULT_LATE_MINUTES };
  }
  function parseTime(t) {
    const m = String(t == null ? '' : t).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  function minutesOfDay(ts) {
    const d = new Date(ts == null ? Date.now() : ts);
    return d.getHours() * 60 + d.getMinutes();
  }
  // 判断某时刻是否迟到：到点时间 + 宽限分钟之后（含）视为迟到
  function isLateAt(ts, cfg) {
    const start = parseTime(cfg && cfg.workStart);
    if (start == null) return false;
    const grace = Math.max(0, parseInt(cfg && cfg.lateMinutes, 10) || 0);
    return minutesOfDay(ts) - start >= grace;
  }
  // 今日打卡记录（按打卡时间升序），name 优先取在线展示名、其次账号注册名
  function attendancePublic(sp, now) {
    const nowMs = now == null ? Date.now() : now;
    const today = todayKey(nowMs);
    const info = spaceUserInfo(sp.id);
    const out = [];
    for (const [key, r] of sp.attendance) {
      const [account, date] = key.split('::');
      if (date !== today) continue;
      const who = info.get(account);
      const acc = accounts.get(account);
      out.push({
        id: r.id, account, name: who ? who.display : (acc ? acc.username : account),
        date, checkInAt: r.checkInAt || null, checkOutAt: r.checkOutAt || null,
        isLate: !!r.isLate, status: r.status || 'checked_in',
        workedMinutes: r.workedMinutes || 0,
      });
    }
    return out.sort((a, b) => (a.checkInAt || 0) - (b.checkInAt || 0));
  }
  // 今日考勤汇总：打卡人数 / 迟到 / 已下班 / 最早打卡 / 最晚下班 / 完成率
  function attendanceStats(sp, now) {
    const nowMs = now == null ? Date.now() : now;
    const today = todayKey(nowMs);
    const recs = [];
    for (const r of sp.attendance.values()) if (r.date === today) recs.push(r);
    const checkedIn = recs.length;
    const late = recs.filter((r) => r.isLate).length;
    const checkedOut = recs.filter((r) => r.checkOutAt).length;
    const checkins = recs.map((r) => r.checkInAt || 0).filter((x) => x > 0);
    const checkouts = recs.map((r) => r.checkOutAt || 0).filter((x) => x > 0);
    return {
      date: today, checkedIn, late, checkedOut,
      earliestCheckIn: checkins.length ? Math.min(...checkins) : null,
      latestCheckOut: checkouts.length ? Math.max(...checkouts) : null,
      completeRate: checkedIn ? Math.round((checkedOut / checkedIn) * 100) : 0,
      lateRate: checkedIn ? Math.round((late / checkedIn) * 100) : 0,
    };
  }
  // ---------- 序列化 ----------
  // 会议室评分：扫描该会议室已完成预约上的评分，聚合平均分、评分数与最近评分
  function roomRatingSummary(space, roomId) {
    const dims = ['environment', 'equipment', 'service'];
    const list = [];
    for (const r of space.roomReservations.values()) {
      if (r.roomId !== roomId) continue;
      if (r.status !== 'completed') continue;
      if (!r.rating) continue;
      list.push({ account: r.ownerAccount, ownerName: r.ownerName, score: r.rating, comment: r.ratingComment || '', createdAt: r.ratedAt || 0, scores: r.ratings || null });
    }
    const count = list.length;
    const sum = list.reduce((s, x) => s + (x.score || 0), 0);
    const avg = count ? +(sum / count).toFixed(1) : 0;
    const dimensions = {};
    for (const k of dims) {
      const vals = list.map((x) => x.scores && x.scores[k]).filter((v) => Number.isInteger(v));
      dimensions[k] = { avg: vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : 0, count: vals.length };
    }
    return { avg, count, dimensions, ratings: list.slice(-8).reverse() };
  }
  function roomPublic(space, r) { return { id: r.id, name: r.name, capacity: r.capacity, location: r.location, description: r.description, tags: r.tags || [], rating: roomRatingSummary(space, r.id) }; }
  function reservationPublic(res, info) {
    const who = info.get(res.ownerAccount);
    return { id: res.id, roomId: res.roomId, ownerAccount: res.ownerAccount, ownerName: who ? who.display : res.ownerName, title: res.title, startAt: res.startAt, endAt: res.endAt, note: res.note, status: res.status, repeat: res.repeat || null, seriesId: res.seriesId || null, remindAt: res.remindAt || null, participants: res.participants || null, actualStartAt: res.actualStartAt || null, actualEndAt: res.actualEndAt || null, rating: res.rating || null, ratedAt: res.ratedAt || null, ratingComment: res.ratingComment || '', ratings: res.ratings || null };
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
        id: t.id, name: t.name, category: t.category, total: t.total, available: t.available, minAvailable: t.minAvailable || 1, lowStock: isToolLowStock(t),
        location: t.location, description: t.description,
        borrowedCount: active.reduce((s, b) => s + b.qty, 0),
        activeBorrows: active.map((b) => { const days = Math.floor((now - b.borrowedAt) / 86400000); return { id: b.id, qty: b.qty, borrowerAccount: b.borrowerAccount, borrowerName: info.get(b.borrowerAccount) ? info.get(b.borrowerAccount).display : b.borrowerName, borrowedAt: b.borrowedAt, dueAt: b.dueAt || null, days, extensions: b.extensions || 0, overdue: borrowOverdue(b, now), reminded: !!b.lastRemindedAt, dueSoon: b.status === 'borrowed' && !!b.dueAt && now >= b.dueAt - BORROW_SOON_WINDOW_MS && now < b.dueAt }; }),
      };
    });
  }
  function toolWaitlistPublic(sp, info) {
    if (!info) info = spaceUserInfo(sp.id);
    return [...sp.toolWaitlist.values()].filter((w) => w.status === 'waiting').map((w) => {
      const tool = sp.tools.find((t) => t.id === w.toolId);
      return {
        id: w.id, toolId: w.toolId, toolName: tool ? tool.name : '',
        account: w.account, name: info.get(w.account) ? info.get(w.account).display : w.name,
        qty: w.qty, status: w.status, createdAt: w.createdAt,
      };
    }).sort((a, b) => a.createdAt - b.createdAt);
  }
  function inventoryPublic(sp, info) {
    const now = Date.now();
    const activeByItem = new Map();
    for (const r of sp.inventoryIssues.values()) {
      if (r.status !== 'issued') continue;
      const arr = activeByItem.get(r.itemId) || [];
      arr.push(r);
      activeByItem.set(r.itemId, arr);
    }
    return sp.inventory.map((it) => {
      const active = activeByItem.get(it.id) || [];
      return {
        id: it.id, name: it.name, category: it.category, unit: it.unit,
        total: it.total, available: it.available, minAvailable: it.minAvailable || 1, lowStock: isStockLow(it),
        location: it.location, description: it.description,
        borrowedCount: active.reduce((s, r) => s + r.qty, 0),
        activeIssues: active.map((r) => {
          const days = Math.floor((now - r.createdAt) / 86400000);
          return {
            id: r.id, qty: r.qty, issuerAccount: r.issuerAccount,
            issuerName: info.get(r.issuerAccount) ? info.get(r.issuerAccount).display : r.issuerName,
            borrowedAt: r.createdAt, dueAt: r.dueAt || null, days,
            overdue: r.dueAt ? now >= r.dueAt : false,
          };
        }),
      };
    });
  }
  function inventoryIssuesPublic(sp, info) {
    return [...sp.inventoryIssues.values()]
      .filter((r) => r.status === 'issued')
      .map((r) => {
        const item = sp.inventory.find((it) => it.id === r.itemId);
        return {
          id: r.id, itemId: r.itemId, itemName: item ? item.name : '', qty: r.qty,
          issuerAccount: r.issuerAccount,
          issuerName: info.get(r.issuerAccount) ? info.get(r.issuerAccount).display : r.issuerName,
          borrowedAt: r.createdAt, dueAt: r.dueAt || null,
        };
      })
      .sort((a, b) => b.borrowedAt - a.borrowedAt);
  }
  function materialTemplatePublic(t) {
    return { id: t.id, name: t.name, defaultQty: t.defaultQty, defaultUnit: t.defaultUnit || '', defaultReason: t.defaultReason || '', createdAt: t.createdAt };
  }
  function materialsTemplatesPublic(sp) {
    return [...sp.materialTemplates.values()].map(materialTemplatePublic).sort((a, b) => a.createdAt - b.createdAt);
  }
  function materialsPublic(sp, info) {
    const weight = { high: 0, normal: 1, low: 2 };
    return [...sp.materialRequests.values()].map((m) => ({
      id: m.id, name: m.name, qty: m.qty, unit: m.unit, reason: m.reason, status: m.status, priority: m.priority || 'normal',
      requesterAccount: m.requesterAccount,
      requesterName: info.get(m.requesterAccount) ? info.get(m.requesterAccount).display : m.requesterName,
      handlerAccount: m.handlerAccount || null,
      handlerName: info.get(m.handlerAccount) ? info.get(m.handlerAccount).display : (m.handlerName || ''),
      createdAt: m.createdAt, handledAt: m.handledAt,
      handleDurationMinutes: m.handledAt ? Math.max(0, Math.round((m.handledAt - m.createdAt) / 60000)) : null,
      slaReminded: !!m.slaRemindedAt,
    })).sort((a, b) => ((weight[a.priority] ?? 2) - (weight[b.priority] ?? 2)) || (b.createdAt - a.createdAt));
  }
  function repairsPublic(sp, info) {
    return [...sp.repairs.values()].map((r) => ({
      id: r.id, code: r.code || '', category: r.category, priority: r.priority || 'normal', location: r.location, description: r.description, status: r.status,
      reporterAccount: r.reporterAccount,
      reporterName: info.get(r.reporterAccount) ? info.get(r.reporterAccount).display : r.reporterName,
      handlerAccount: r.handlerAccount || null,
      handlerName: info.get(r.handlerAccount) ? info.get(r.handlerAccount).display : (r.handlerName || ''),
      createdAt: r.createdAt, updatedAt: r.updatedAt,
      handledAt: r.handledAt || null,
      handleDurationMinutes: r.handledAt ? Math.max(0, Math.round((r.handledAt - r.createdAt) / 60000)) : null,
       slaReminded: !!r.slaRemindedAt,
       escalated: !!r.escalatedAt,
      commentCount: (r.comments || []).length,
      comments: (r.comments || []).map((c) => ({ id: c.id, account: c.account, name: c.name, text: c.text || '', createdAt: c.createdAt || 0 })).reverse().slice(0, 20),
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
        status: b.status, condition: b.condition || 'intact', overdue: borrowOverdue(b), soonReminded: !!b.soonRemindedAt, extensions: b.extensions || 0,
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
       remindAt: v.remindAt || null,
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

  // ---------- 工位预约 + 外出登记序列化 ----------
  // 工位：单工位时段预约，同一工位同一时段只能有一条有效预约
  function deskPublic(space, desk) {
    const now = Date.now();
    const today = [...space.deskReservations.values()].filter((r) => r.deskId === desk.id && r.status !== 'cancelled' && r.status !== 'expired');
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = todayStart.getTime() + 86400000;
    const todayList = today.filter((r) => r.startAt >= todayStart.getTime() && r.startAt < todayEnd);
    const upcoming = todayList.filter((r) => r.status === 'pending' && r.startAt >= now);
    return { id: desk.id, name: desk.name, location: desk.location || '', description: desk.description || '', todayCount: todayList.length, upcomingCount: upcoming.length, todayMinutes: todayList.reduce((s, r) => s + Math.max(0, Math.round((Math.min(r.endAt, todayEnd) - r.startAt) / 60000)), 0) };
  }
  function deskReservationsPublic(space, info) {
    return [...space.deskReservations.values()].map((r) => {
      const who = info.get(r.account);
      return { id: r.id, deskId: r.deskId, account: r.account, name: who ? who.display : r.name, startAt: r.startAt, endAt: r.endAt, note: r.note || '', status: r.status, actualStartAt: r.actualStartAt || null, actualEndAt: r.actualEndAt || null };
    }).sort((a, b) => (b.startAt - a.startAt));
  }
  function deskUsageStats(space, now) {
    const nowMs = now == null ? Date.now() : now;
    const ds = new Date(nowMs); ds.setHours(0, 0, 0, 0);
    const dStart = ds.getTime(), dEnd = dStart + 86400000;
    const workStart = new Date(ds); workStart.setHours(9, 0, 0, 0);
    const workEnd = new Date(ds); workEnd.setHours(21, 0, 0, 0);
    const rooms = space.desks.map((d) => {
      const res = [...space.deskReservations.values()].filter((x) => x.deskId === d.id && x.status !== 'cancelled' && x.status !== 'expired');
      const today = res.filter((x) => x.startAt >= dStart && x.startAt < dEnd);
      const upcoming = res.filter((x) => x.startAt >= nowMs && x.status === 'pending');
      const todayMinutes = today.reduce((s, x) => s + Math.max(0, Math.round((Math.min(x.endAt, dEnd) - x.startAt) / 60000)), 0);
      return { deskId: d.id, name: d.name, location: d.location || '', todayCount: today.length, todayMinutes, upcomingCount: upcoming.length };
    });
    const capacity = space.desks.length * (workEnd - workStart) / 60000;
    return { desks: rooms, totalTodayMinutes: rooms.reduce((s, r) => s + r.todayMinutes, 0), capacityMinutes: capacity, utilizationPct: capacity ? Math.round(rooms.reduce((s, r) => s + r.todayMinutes, 0) / capacity * 100) : 0, workStart: workStart.getTime(), workEnd: workEnd.getTime() };
  }
  function pruneDeskReservations(space, before, max = 200) {
    let removed = 0;
    for (const [id, r] of [...space.deskReservations]) {
      if (removed >= max) break;
      if (r.status !== 'completed' && r.status !== 'cancelled' && r.status !== 'expired') continue;
      const ts = r.endAt || r.startAt || 0;
      if (ts >= before) continue;
      space.deskReservations.delete(id);
      deleteEntity(space.id, 'desk_reservation', id);
      removed++;
    }
    return removed;
  }
  // 外出登记：外出 / 请假 / 出差 / 调休，active 期间其他成员可见
  function oooPublic(space, info, now) {
    const nowMs = now == null ? Date.now() : now;
    return [...space.ooo.values()].filter((r) => r.status === 'active').map((r) => {
      const who = info.get(r.account);
      return {
        id: r.id, account: r.account, name: who ? who.display : r.name, category: r.category, reason: r.reason || '',
        startAt: r.startAt, expectedReturnAt: r.expectedReturnAt || null, endAt: r.endAt || null, status: r.status,
      };
    }).sort((a, b) => a.startAt - b.startAt);
  }
  function oooStats(space, now) {
    const nowMs = now == null ? Date.now() : now;
    const ds = new Date(nowMs); ds.setHours(0, 0, 0, 0);
    const dStart = ds.getTime(), dEnd = dStart + 86400000;
    const recs = [...space.ooo.values()];
    return {
      activeCount: recs.filter((r) => r.status === 'active').length,
      todayCount: recs.filter((r) => r.startAt >= dStart && r.startAt < dEnd).length,
      onLeaveCount: recs.filter((r) => r.category === '请假').length,
      onTripCount: recs.filter((r) => r.category === '出差').length,
    };
  }

  // ---------- 意见反馈序列化 ----------
  // 意见反馈：成员匿名/实名提交，管理员回复 / 关闭，全员可见处理闭环
  function feedbackPublic(space, info) {
    return [...space.feedbacks.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((r) => {
      const who = info.get(r.account);
      return {
        id: r.id, anonymous: !!r.anonymous,
        author: r.anonymous ? '匿名成员' : (who ? who.display : r.name || r.account),
        category: r.category || '建议', content: r.content || '', status: r.status,
        replies: (r.replies || []).map((rp) => ({ account: rp.account, name: rp.name || rp.account, content: rp.content || '', createdAt: rp.createdAt || 0 })),
        createdAt: r.createdAt || 0, handledAt: r.handledAt || null,
      };
    });
  }
  function feedbackStats(space) {
    const recs = [...space.feedbacks.values()];
    return { open: recs.filter((r) => r.status === 'open').length, answered: recs.filter((r) => r.status === 'answered').length, closed: recs.filter((r) => r.status === 'closed').length };
  }
  // ---------- 每日心情序列化 ----------
  function moodPublic(space, info, now) {
    const nowMs = now == null ? Date.now() : now;
    const key = todayKey(nowMs);
    return [...space.moods.values()].filter((r) => r.date === key).map((r) => {
      const who = info.get(r.account);
      return { id: r.id, account: r.account, name: who ? who.display : r.name, emoji: r.emoji, createdAt: r.createdAt };
    }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }
  function moodStats(space, now) {
    const nowMs = now == null ? Date.now() : now;
    const key = todayKey(nowMs);
    const counts = {};
    for (const e of MOOD_EMOJIS) counts[e] = 0;
    for (const r of space.moods.values()) {
      if (r.date === key) counts[r.emoji] = (counts[r.emoji] || 0) + 1;
    }
    return { total: [...space.moods.values()].filter((r) => r.date === key).length, counts };
  }

  // ---------- 活动序列化 ----------
  // 活动：培训 / 分享会 / 团建 / 生日会 / 会议，支持 RSVP 与开始前提醒
  function eventPublic(space, info, user, now) {
    const nowMs = now == null ? Date.now() : now;
    return [...space.events.values()].sort((a, b) => (a.startAt || 0) - (b.startAt || 0)).map((e) => {
      const host = info.get(e.hostAccount);
      const rsvps = e.rsvps || {};
      let going = 0, maybe = 0, notGoing = 0;
      for (const v of Object.values(rsvps)) {
        if (v === 'going') going++;
        else if (v === 'maybe') maybe++;
        else notGoing++;
      }
      let status = 'upcoming';
      if (e.cancelled) status = 'cancelled';
      else if (nowMs >= (e.endAt || 0)) status = 'ended';
      else if (nowMs >= e.startAt) status = 'ongoing';
      return {
        id: e.id, title: e.title, description: e.description || '', category: e.category, location: e.location || '',
        hostAccount: e.hostAccount, hostName: host ? host.display : e.hostName,
        startAt: e.startAt, endAt: e.endAt, capacity: e.capacity || 0, status,
        goingCount: going, maybeCount: maybe, notGoingCount: notGoing,
        myRsvp: user ? (rsvps[user.account] || null) : null,
        reminded: !!e.reminded, createdAt: e.createdAt || 0,
      };
    });
  }
  function eventStats(space, now) {
    const nowMs = now == null ? Date.now() : now;
    const evs = [...space.events.values()];
    return {
      total: evs.length,
      upcoming: evs.filter((e) => !e.cancelled && nowMs < e.startAt).length,
      ongoing: evs.filter((e) => !e.cancelled && nowMs >= e.startAt && nowMs < e.endAt).length,
      ended: evs.filter((e) => !e.cancelled && nowMs >= (e.endAt || 0)).length,
      cancelled: evs.filter((e) => e.cancelled).length,
      hostCount: new Set(evs.map((e) => e.hostAccount)).size,
      todayCount: evs.filter((e) => !e.cancelled && todayKey(e.startAt) === todayKey(nowMs)).length,
    };
  }

  // ---------- 投票序列化 ----------
  // 投票：空间内快速决策（午饭 / 办公改进 / 时间安排），单账号单票，可匿名
  function pollPublic(space, info, user, now) {
    const nowMs = now == null ? Date.now() : now;
    return [...space.polls.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((p) => {
      const creator = info.get(p.creatorAccount);
      const votes = p.votes || {};
      const options = (p.options || []).map((o) => ({ id: o.id, text: o.text, count: Object.values(votes).filter((v) => v === o.id).length }));
      return {
        id: p.id, question: p.question, options,
        anonymous: !!p.anonymous,
        creatorAccount: p.creatorAccount, creatorName: creator ? creator.display : p.creatorName,
        status: p.status || 'open', createdAt: p.createdAt || 0, deadline: p.deadline || null,
        myVote: user ? (votes[user.account] || null) : null,
        totalVotes: Object.keys(votes).length,
        closed: p.status === 'closed' || (p.deadline && nowMs >= p.deadline),
      };
    });
  }
  function pollStats(space) {
    const ps = [...space.polls.values()];
    return {
      open: ps.filter((p) => p.status !== 'closed').length,
      closed: ps.filter((p) => p.status === 'closed').length,
      total: ps.length,
      totalVotes: ps.reduce((s, p) => s + (p.votes ? Object.keys(p.votes).length : 0), 0),
    };
  }

  // ---------- 知识库序列化 ----------
  // 知识库：办公规章制度 / 操作指引 / 设备说明 / 常见问题，支持点赞与检索
  function knowledgePublic(space, info, user) {
    return [...space.knowledge.values()].sort((a, b) => {
      const la = a.likes ? a.likes.length : 0, lb = b.likes ? b.likes.length : 0;
      if (lb !== la) return lb - la;
      return (b.createdAt || 0) - (a.createdAt || 0);
    }).map((k) => {
      const author = info.get(k.authorAccount);
      const likes = k.likes || [];
      const comments = (k.comments || []).map((c) => ({ id: c.id, account: c.account, name: c.name, text: c.text || '', createdAt: c.createdAt || 0, parentId: c.parentId || null, parentName: c.parentName || null })).reverse().slice(0, 20);
      return {
        id: k.id, title: k.title, content: k.content || '', category: k.category, tags: k.tags || [],
        authorAccount: k.authorAccount, authorName: author ? author.display : k.authorName,
        likeCount: likes.length, liked: user ? likes.includes(user.account) : false,
        commentCount: (k.comments || []).length, comments,
        createdAt: k.createdAt || 0, updatedAt: k.updatedAt || 0,
      };
    });
  }
  function knowledgeStats(space) {
    const ks = [...space.knowledge.values()];
    return { total: ks.length, liked: ks.reduce((s, k) => s + (k.likes ? k.likes.length : 0), 0), comments: ks.reduce((s, k) => s + (k.comments ? k.comments.length : 0), 0), authors: new Set(ks.map((k) => k.authorAccount)).size };
  }

  // ---------- 待办任务序列化 ----------
  // 空间级任务看板：成员可发起 / 指派 / 认领，按优先级 + 截止时间排序
  function tasksPublic(space, info, user) {
    const weight = { high: 0, normal: 1, low: 2 };
    return [...space.tasks.values()].map((t) => {
      const assignee = t.assigneeAccount ? info.get(t.assigneeAccount) : null;
      return {
        id: t.id, title: t.title, description: t.description || '',
        creatorAccount: t.creatorAccount,
        creatorName: info.get(t.creatorAccount) ? info.get(t.creatorAccount).display : t.creatorName,
        assigneeAccount: t.assigneeAccount || null,
        assigneeName: assignee ? assignee.display : (t.assigneeName || ''),
        priority: t.priority || 'normal', status: t.status,
        dueAt: t.dueAt || null, completedAt: t.completedAt || null,
        createdAt: t.createdAt, updatedAt: t.updatedAt,
        myAssignee: user && t.assigneeAccount === user.account,
        myCreator: user && t.creatorAccount === user.account,
        myTask: user && (t.assigneeAccount === user.account || t.creatorAccount === user.account || isAdmin(space, user.account)),
        commentCount: (t.comments || []).length,
        comments: (t.comments || []).map((c) => ({ id: c.id, account: c.account, name: c.name, text: c.text || '', createdAt: c.createdAt || 0 })).reverse().slice(0, 20),
      };
    }).sort((a, b) => {
      const done = (s) => s.status === 'done' || s.status === 'cancelled';
      if (done(a) !== done(b)) return done(a) ? 1 : -1;
      if ((weight[a.priority] ?? 2) !== (weight[b.priority] ?? 2)) return weight[a.priority] - weight[b.priority];
      return ((a.dueAt || Infinity) - (b.dueAt || Infinity));
    });
  }
  function taskStats(space) {
    const tasks = [...space.tasks.values()];
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === 'pending').length,
      in_progress: tasks.filter((t) => t.status === 'in_progress').length,
      done: tasks.filter((t) => t.status === 'done').length,
      cancelled: tasks.filter((t) => t.status === 'cancelled').length,
      open: tasks.filter((t) => !t.assigneeAccount && t.status !== 'done' && t.status !== 'cancelled').length,
    };
  }

  // ---------- 通知中心序列化 ----------
  // 系统重要事件留痕（指派 / 完成 / 超时 / 提醒），全员可看、按人标记已读
  function notificationPublic(n, user) {
    return {
      id: n.id, type: n.type, level: n.level || 'info',
      title: n.title, body: n.body || '',
      createdAt: n.createdAt,
      read: user ? !!(n.readBy && n.readBy[user.account]) : false,
    };
  }
  function notificationsPublic(space, user) {
    const list = [...space.notifications.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map((n) => notificationPublic(n, user));
    return { notifications: list.slice(0, LIST_PAGE), total: list.length, unreadCount: user ? list.filter((n) => !n.read).length : 0 };
  }

  // ---------- 考勤连续打卡 / 日历 ----------
  // 连续打卡天数（今天未打则从昨天起算），避免「今天没打」直接断档
  function attendanceStreak(space, account, now) {
    const nowMs = now == null ? Date.now() : now;
    const daySet = new Set();
    for (const [key, r] of space.attendance) {
      if (key.split('::')[0] !== account) continue;
      daySet.add(r.date);
    }
    const ds = new Date(nowMs); ds.setHours(0, 0, 0, 0);
    if (!daySet.has(todayKey(ds.getTime()))) ds.setDate(ds.getDate() - 1);
    let streak = 0;
    while (daySet.has(todayKey(ds.getTime()))) { streak++; ds.setDate(ds.getDate() - 1); }
    return streak;
  }
  // 全勤月数：按月聚合，至少 1 天打卡且当月无迟到
  function attendancePerfectMonths(space, account) {
    const monthMap = new Map();
    for (const [key, r] of space.attendance) {
      if (key.split('::')[0] !== account) continue;
      if (!r.checkInAt) continue;
      const d = new Date(r.date + 'T00:00:00');
      const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const cur = monthMap.get(mk) || { total: 0, late: 0 };
      cur.total++;
      if (r.isLate) cur.late++;
      monthMap.set(mk, cur);
    }
    return [...monthMap.values()].filter((v) => v.late === 0).length;
  }
  // 某月考勤日历 + 连续打卡 + 全勤月数
  function attendanceCalendar(space, account, year, month, now) {
    const nowMs = now == null ? Date.now() : now;
    const d0 = new Date(nowMs);
    const y = parseInt(year, 10) || d0.getFullYear();
    const m = parseInt(month, 10) || (d0.getMonth() + 1);
    const monthKey = `${y}-${String(m).padStart(2, '0')}`;
    const byDate = new Map();
    for (const [key, r] of space.attendance) {
      if (key.split('::')[0] !== account) continue;
      byDate.set(r.date, r);
    }
    const first = new Date(y, m - 1, 1);
    const last = new Date(y, m, 0);
    const lead = first.getDay();
    const total = last.getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let day = 1; day <= total; day++) {
      const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const rec = byDate.get(dateStr);
      cells.push(rec ? { date: dateStr, checkedIn: rec.checkInAt || null, checkedOut: rec.checkOutAt || null, isLate: !!rec.isLate, workedMinutes: rec.workedMinutes || 0 } : { date: dateStr });
    }
    const monthMap = new Map();
    for (const [key, r] of space.attendance) {
      if (key.split('::')[0] !== account) continue;
      if (!r.checkInAt) continue;
      const d = new Date(r.date + 'T00:00:00');
      const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const cur = monthMap.get(mk) || { total: 0, late: 0 };
      cur.total++;
      if (r.isLate) cur.late++;
      monthMap.set(mk, cur);
    }
    const curMonth = monthMap.get(monthKey);
    const currentMonthPerfect = !!curMonth && curMonth.late === 0;
    return { year: y, month: m, cells, streak: attendanceStreak(space, account, now), perfectMonthCount: attendancePerfectMonths(space, account), currentMonthPerfect };
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
  // 公告/通知统一入口：写入 + 持久化 + 广播；超过 50 条自动裁剪并删除旧公告
  function pushNotice(space, text, fromAccount, fromName) {
    const notice = { id: genId('n', null), text, from: fromName || fromAccount || '系统', ts: Date.now(), reactions: [] };
    space.notices.unshift(notice);
    if (space.notices.length > 50) {
      const removed = space.notices.splice(50);
      removed.forEach((n) => deleteEntity(space.id, 'notice', n.id));
    }
    saveEntity(space.id, 'notice', notice.id, notice);
    noticesBroadcast(space);
    return notice;
  }
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
  function attendanceBroadcast(sp) { broadcast(sp.id, 'attendance', { records: attendancePublic(sp), stats: attendanceStats(sp), config: sp.attendanceConfig || newAttendanceConfig() }); }
  function desksBroadcast(sp) {
    const info = spaceUserInfo(sp.id);
    const reservations = deskReservationsPublic(sp, info);
    broadcast(sp.id, 'desks', { desks: sp.desks.map((d) => deskPublic(sp, d)), reservations: reservations.slice(0, LIST_PAGE), reservationTotal: reservations.length });
  }
  function deskStatsBroadcast(sp) { broadcast(sp.id, 'deskStats', deskUsageStats(sp)); }
  function oooBroadcast(sp) {
    const info = spaceUserInfo(sp.id);
    broadcast(sp.id, 'ooo', { records: oooPublic(sp, info), stats: oooStats(sp) });
  }
  function feedbackBroadcast(sp) {
    const info = spaceUserInfo(sp.id);
    broadcast(sp.id, 'feedback', { records: feedbackPublic(sp, info), stats: feedbackStats(sp) });
  }
  function moodBroadcast(sp) {
    const info = spaceUserInfo(sp.id);
    broadcast(sp.id, 'mood', { records: moodPublic(sp, info), stats: moodStats(sp) });
  }
  function eventsBroadcast(sp) {
    const info = spaceUserInfo(sp.id);
    const events = eventPublic(sp, info, null);
    broadcast(sp.id, 'events', { events: events.slice(0, LIST_PAGE), total: events.length, stats: eventStats(sp) });
  }
  function pollsBroadcast(sp) {
    const info = spaceUserInfo(sp.id);
    const polls = pollPublic(sp, info, null);
    broadcast(sp.id, 'polls', { polls: polls.slice(0, LIST_PAGE), total: polls.length, stats: pollStats(sp) });
  }
  function knowledgeBroadcast(sp) {
    const info = spaceUserInfo(sp.id);
    const knowledge = knowledgePublic(sp, info, null);
    broadcast(sp.id, 'knowledge', { knowledge: knowledge.slice(0, LIST_PAGE), total: knowledge.length, stats: knowledgeStats(sp) });
  }
  function tasksBroadcast(sp) {
    const info = spaceUserInfo(sp.id);
    const tasks = tasksPublic(sp, info, null);
    // 全空间广播（含未登录大屏）；个人权限在前端按 creatorAccount / assigneeAccount 计算
    broadcast(sp.id, 'tasks', { tasks: tasks.slice(0, LIST_PAGE), total: tasks.length, stats: taskStats(sp) });
  }
  function notificationsBroadcast(sp) {
    const info = spaceUserInfo(sp.id);
    for (const u of getUsersIn(sp.id)) {
      sendToUser(u.id, { type: 'notifications', ...notificationsPublic(sp, u) });
    }
  }
  // 通知中心统一入口：写入 + 持久化 + 广播给全员（含各自未读数）
  function pushNotification(space, n) {
    const notice = { id: genId('nt', null), type: n.type || 'info', level: NOTIFICATION_LEVELS.includes(n.level) ? n.level : 'info', title: String(n.title || '').slice(0, 80), body: String(n.body || '').slice(0, 300), createdAt: Date.now(), readBy: {} };
    space.notifications.set(notice.id, notice);
    if (space.notifications.size > 200) {
      const removed = [...space.notifications.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt).slice(0, space.notifications.size - 200);
      for (const [id] of removed) { space.notifications.delete(id); deleteEntity(space.id, 'notification', id); }
    }
    saveEntity(space.id, 'notification', notice.id, notice);
    notificationsBroadcast(space);
    return notice;
  }
  function broadcastAll(sp) {
    const info = spaceUserInfo(sp.id);
    const reservations = roomReservationsPublic(sp, info);
    const waitlist = roomWaitlistPublic(sp, info);
    const materials = materialsPublic(sp, info);
    const repairs = repairsPublic(sp, info);
    const visitors = visitorsPublic(sp, info);
    broadcast(sp.id, 'rooms', { rooms: sp.rooms.map((r) => roomPublic(sp, r)), reservations: reservations.slice(0, LIST_PAGE), reservationTotal: reservations.length, waitlist: waitlist.slice(0, LIST_PAGE), waitlistTotal: waitlist.length });
    broadcast(sp.id, 'tools', { tools: toolsPublic(sp, info) });
    broadcast(sp.id, 'inventory', { items: inventoryPublic(sp, info), issues: inventoryIssuesPublic(sp, info) });
    broadcast(sp.id, 'materials', { requests: materials.slice(0, LIST_PAGE), total: materials.length });
    broadcast(sp.id, 'repairs', { repairs: repairs.slice(0, LIST_PAGE), total: repairs.length });
    broadcast(sp.id, 'visitors', { visitors: visitors.slice(0, LIST_PAGE), total: visitors.length });
    broadcast(sp.id, 'stalls', { squat_count: sp.squatCount, urinal_count: sp.urinalCount, stalls: stallsPublic(sp, info) });
    broadcast(sp.id, 'notices', { notices: sp.notices });
    roomStatsBroadcast(sp);
    attendanceBroadcast(sp);
    desksBroadcast(sp);
    deskStatsBroadcast(sp);
    oooBroadcast(sp);
    feedbackBroadcast(sp);
    moodBroadcast(sp);
    eventsBroadcast(sp);
    pollsBroadcast(sp);
    knowledgeBroadcast(sp);
    tasksBroadcast(sp);
    notificationsBroadcast(sp);
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
    { id: 'logistician', name: '后勤达人', desc: '处理申领或解决报修累计5次', icon: '🛎️', check: (u) => (u.stats.helperCount || 0) >= 5 },
    { id: 'roomGuide', name: '会议室向导', desc: '给会议室评分3次', icon: '📝', check: (u) => (u.stats.roomRatesGiven || 0) >= 3 },
    { id: 'collector', name: '收藏家', desc: '收藏3个会议室', icon: '⭐', check: (u) => (u.stats.favoriteCount || 0) >= 3 },
    { id: 'earlyBird', name: '早到达人', desc: '累计3天在9点前打卡', icon: '🐦', check: (u) => (u.stats.earlyCount || 0) >= 3 },
    { id: 'attendanceKing', name: '打卡达人', desc: '累计打卡10次', icon: '🕒', check: (u) => (u.stats.attendanceCount || 0) >= 10 },
    { id: 'deskKnight', name: '工位达人', desc: '预约工位累计5次', icon: '🪑', check: (u) => (u.stats.deskCount || 0) >= 5 },
    { id: 'awayReporter', name: '外出报备达人', desc: '外出登记累计5次', icon: '🧳', check: (u) => (u.stats.oooCount || 0) >= 5 },
    { id: 'listener', name: '倾听达人', desc: '回复意见反馈累计3条', icon: '👂', check: (u) => (u.stats.feedbackReplyCount || 0) >= 3 },
    { id: 'eventHost', name: '活动主办', desc: '举办活动累计3次', icon: '🎤', check: (u) => (u.stats.eventCount || 0) >= 3 },
    { id: 'eventAttendee', name: '活动达人', desc: '参加活动累计5次', icon: '🎟️', check: (u) => (u.stats.eventAttendCount || 0) >= 5 },
    { id: 'pollMaker', name: '决策发起人', desc: '发起投票累计3次', icon: '🗳️', check: (u) => (u.stats.pollCreateCount || 0) >= 3 },
    { id: 'pollVoter', name: '参与决策者', desc: '参与投票累计5次', icon: '🙋', check: (u) => (u.stats.pollVoteCount || 0) >= 5 },
    { id: 'knowledgeAuthor', name: '知识贡献者', desc: '发布知识累计3篇', icon: '📝', check: (u) => (u.stats.knowledgeCount || 0) >= 3 },
    { id: 'knowledgeLiked', name: '知识之星', desc: '获得点赞累计10个', icon: '⭐', check: (u) => (u.stats.knowledgeLikeCount || 0) >= 10 },
    { id: 'taskMaker', name: '任务达人', desc: '创建任务累计5次', icon: '📝', check: (u) => (u.stats.taskCreateCount || 0) >= 5 },
    { id: 'taskDoer', name: '高效执行', desc: '完成任务累计5次', icon: '✅', check: (u) => (u.stats.taskDoneCount || 0) >= 5 },
    { id: 'streakKnight', name: '连续打卡达人', desc: '连续打卡7天', icon: '🔥', check: (u) => (u.stats.attendanceStreak || 0) >= 7 },
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
    logistician: { field: 'helperCount', target: 5 },
    roomGuide: { field: 'roomRatesGiven', target: 3 },
    collector: { field: 'favoriteCount', target: 3 },
    earlyBird: { field: 'earlyCount', target: 3 },
    attendanceKing: { field: 'attendanceCount', target: 10 },
    deskKnight: { field: 'deskCount', target: 5 },
    awayReporter: { field: 'oooCount', target: 5 },
    listener: { field: 'feedbackReplyCount', target: 3 },
    eventHost: { field: 'eventCount', target: 3 },
    eventAttendee: { field: 'eventAttendCount', target: 5 },
    pollMaker: { field: 'pollCreateCount', target: 3 },
    pollVoter: { field: 'pollVoteCount', target: 5 },
    knowledgeAuthor: { field: 'knowledgeCount', target: 3 },
    knowledgeLiked: { field: 'knowledgeLikeCount', target: 10 },
    taskMaker: { field: 'taskCreateCount', target: 5 },
    taskDoer: { field: 'taskDoneCount', target: 5 },
    streakKnight: { field: 'attendanceStreak', target: 7 },
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
  function buildDigest(space, user, now) {
    const nowMs = now == null ? Date.now() : now;
    const day0 = new Date(nowMs); day0.setHours(0, 0, 0, 0);
    const today0 = day0.getTime(), todayEnd = today0 + 86400000;
    const todayMeetings = roomReservationsPublic(space).filter((r) => r.startAt >= today0 && r.startAt < todayEnd && r.status !== 'cancelled' && r.status !== 'expired');
    const overdue = [...space.borrows.values()].filter((b) => borrowOverdue(b));
    const myBorrows = [...space.borrows.values()].filter((b) => b.borrowerAccount === user.account && b.status === 'borrowed');
    const pendingMaterials = [...space.materialRequests.values()].filter((r) => r.status === 'pending');
    const openRepairs = [...space.repairs.values()].filter((r) => r.status === 'reported' || r.status === 'in_progress');
    const resolvedRepairs = [...space.repairs.values()].filter((r) => r.status === 'resolved' && r.handledAt && r.handledAt >= today0 && r.handledAt < todayEnd);
    const resolvedMaterials = [...space.materialRequests.values()].filter((r) => r.status === 'fulfilled' && r.handledAt && r.handledAt >= today0 && r.handledAt < todayEnd);
    const pendingVisitors = [...space.visitors.values()].filter((v) => v.status === 'pending' || v.status === 'arrived');
    const todayAttendance = attendanceStats(space, now);
    const oooStatsToday = oooStats(space, now);
    const activeOoo = [...space.ooo.values()].filter((r) => r.status === 'active').map((r) => ({ id: r.id, account: r.account, name: r.name, category: r.category, expectedReturnAt: r.expectedReturnAt || null }));
    const deskTodayCount = [...space.deskReservations.values()].filter((r) => r.status !== 'cancelled' && r.status !== 'expired' && r.startAt >= today0 && r.startAt < todayEnd).length;
    const deskStatsToday = deskUsageStats(space, now);
    const todayMeetingMinutes = todayMeetings.reduce((s, r) => s + Math.max(0, Math.round((Math.min(r.endAt, todayEnd) - r.startAt) / 60000)), 0);
    const todayBorrowMinutes = [...space.borrows.values()].filter((b) => b.returnedAt && b.returnedAt >= today0 && b.returnedAt < todayEnd).reduce((s, b) => s + Math.max(0, Math.round((b.returnedAt - b.borrowedAt) / 60000)), 0);
    const todayEvents = [...space.events.values()].filter((e) => !e.cancelled && e.startAt >= today0 && e.startAt < todayEnd);
    const myUpcomingEvents = [...space.events.values()].filter((e) => !e.cancelled && e.startAt >= nowMs && e.startAt <= nowMs + 60 * 60000 && (e.rsvps && e.rsvps.get(user.account) === 'going'));
    const mvp = leaderboardPublic(space).rankings.find((r) => r.mvp) || null;
    return { todayMeetingCount: todayMeetings.length, todayMeetings: todayMeetings.slice(0, 5), todayMeetingMinutes, todayBorrowMinutes, overdueCount: overdue.length, myBorrows: myBorrows.length, pendingMaterialsCount: pendingMaterials.length, openRepairsCount: openRepairs.length, resolvedRepairsCount: resolvedRepairs.length, resolvedMaterialsCount: resolvedMaterials.length, pendingVisitorsCount: pendingVisitors.length, pendingVisitors: pendingVisitors.slice(0, 5).map((v) => ({ visitorName: v.visitorName, hostName: v.hostName, status: v.status })), attendanceCheckedIn: todayAttendance.checkedIn, attendanceLate: todayAttendance.late, attendanceCompleteRate: todayAttendance.completeRate, oooActiveCount: oooStatsToday.activeCount, activeOoo, deskTodayCount, deskUtilizationPct: deskStatsToday.utilizationPct, todayEventCount: todayEvents.length, todayEvents: todayEvents.slice(0, 5).map((e) => ({ id: e.id, title: e.title, startAt: e.startAt, endAt: e.endAt })), upcomingEventCount: myUpcomingEvents.length, mvp };
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
    const upcomingDesk = [...space.deskReservations.values()].filter((r) => r.account === user.account && r.status === 'pending' && r.startAt >= nowMs && r.startAt <= nowMs + 60 * 60000);
    const activeOoo = [...space.ooo.values()].filter((r) => r.account === user.account && r.status === 'active');
    const upcomingEvents = [...space.events.values()].filter((e) => !e.cancelled && e.startAt >= nowMs && e.startAt <= nowMs + 60 * 60000 && (e.rsvps && e.rsvps.get(user.account) === 'going' || e.hostAccount === user.account));
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
      upcomingDeskCount: upcomingDesk.length,
      upcomingDesk: upcomingDesk.map((r) => ({ id: r.id, deskId: r.deskId, startAt: r.startAt, endAt: r.endAt })),
      activeOooCount: activeOoo.length,
      activeOoo: activeOoo.map((r) => ({ id: r.id, category: r.category, expectedReturnAt: r.expectedReturnAt || null })),
      upcomingEventCount: upcomingEvents.length,
      upcomingEvents: upcomingEvents.map((e) => ({ id: e.id, title: e.title, startAt: e.startAt, endAt: e.endAt, host: e.hostAccount === user.account })),
    };
  }

  // ---------- 空间活跃趋势 ----------
  // 按天聚合会议室 / 借用 / 申领 / 报修 / 访客的活动量，供空间趋势看板展示
  function buildSpaceTrend(space, days) {
    const n = Math.max(1, Math.min(30, parseInt(days, 10) || 7));
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    const dayStart = today0.getTime() - (n - 1) * 86400000;
    const buckets = [];
    for (let i = 0; i < n; i++) buckets.push({ date: dayStart + i * 86400000, meetings: 0, borrows: 0, requests: 0, repairs: 0, visitors: 0, attends: 0, desks: 0, ooo: 0, events: 0, polls: 0 });
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
    for (const r of space.attendance.values()) { if (r.checkInAt) bump(idxOf(r.checkInAt), 'attends'); }
    for (const r of space.deskReservations.values()) { if (r.status !== 'cancelled' && r.status !== 'expired') bump(idxOf(r.startAt), 'desks'); }
    for (const r of space.ooo.values()) { bump(idxOf(r.startAt), 'ooo'); }
    for (const e of space.events.values()) { if (!e.cancelled) bump(idxOf(e.startAt), 'events'); }
    for (const p of space.polls.values()) { bump(idxOf(p.createdAt), 'polls'); }
    return buckets.map((b) => ({ date: b.date, meetings: b.meetings, borrows: b.borrows, requests: b.requests, repairs: b.repairs, visitors: b.visitors, attends: b.attends, desks: b.desks, ooo: b.ooo, events: b.events, polls: b.polls }));
  }

  // ---------- 空间周报 ----------
  // 汇总本周（周一至今）活动量：会议 / 借用 / 申领 / 报修 / 访客 / 已解决工单，供周报推送
  function buildWeeklyReport(space, now) {
    const nowMs = now == null ? Date.now() : now;
    const week0 = new Date(nowMs); week0.setDate(week0.getDate() - ((week0.getDay() + 6) % 7)); week0.setHours(0, 0, 0, 0);
    const weekStart = week0.getTime(), weekEnd = nowMs;
    const inWeek = (ts) => ts >= weekStart && ts <= weekEnd;
    const meetings = [...space.roomReservations.values()].filter((r) => r.status !== 'cancelled' && r.status !== 'expired' && inWeek(r.startAt));
    const borrows = [...space.borrows.values()].filter((b) => inWeek(b.borrowedAt));
    const requests = [...space.materialRequests.values()].filter((m) => inWeek(m.createdAt));
    const repairs = [...space.repairs.values()].filter((r) => inWeek(r.createdAt));
    const visitors = [...space.visitors.values()].filter((v) => inWeek(v.createdAt));
    const attendance = [...space.attendance.values()].filter((r) => r.checkInAt && inWeek(r.checkInAt));
    const ooo = [...space.ooo.values()].filter((r) => inWeek(r.startAt));
    const desks = [...space.deskReservations.values()].filter((r) => r.status !== 'cancelled' && r.status !== 'expired' && inWeek(r.startAt));
    const events = [...space.events.values()].filter((e) => !e.cancelled && inWeek(e.startAt));
    const polls = [...space.polls.values()].filter((p) => inWeek(p.createdAt));
    const resolvedRepairs = [...space.repairs.values()].filter((r) => r.status === 'resolved' && r.handledAt && inWeek(r.handledAt));
    const fulfilledMaterials = [...space.materialRequests.values()].filter((m) => m.status === 'fulfilled' && m.handledAt && inWeek(m.handledAt));
    const lowStock = space.tools.filter((t) => isToolLowStock(t)).map((t) => ({ id: t.id, name: t.name, available: t.available, minAvailable: t.minAvailable || 1 }));
    const openRepairs = [...space.repairs.values()].filter((r) => r.status === 'reported' || r.status === 'in_progress');
    const pendingMaterials = [...space.materialRequests.values()].filter((m) => m.status === 'pending');
    const meetingMinutes = meetings.reduce((s, r) => s + Math.max(0, Math.round((Math.min(r.endAt, weekEnd) - r.startAt) / 60000)), 0);
    return {
      weekStart, weekEnd,
      meetings: meetings.length, meetingMinutes,
      borrows: borrows.length,
      requests: requests.length, fulfilledMaterials: fulfilledMaterials.length,
      repairs: repairs.length, resolvedRepairs: resolvedRepairs.length,
      visitors: visitors.length,
      attendance: attendance.length,
      ooo: ooo.length,
      desks: desks.length,
      events: events.length,
      polls: polls.length,
      openRepairsCount: openRepairs.length,
      pendingMaterialsCount: pendingMaterials.length,
      lowStockTools: lowStock,
    };
  }

  return {
    // 状态
    spaces, users, accounts, tokens, profiles,
    // 访问器
    LIST_PAGE, RESERVE_CONFIRM_WINDOW_MS, OVERDUE_REMIND_THROTTLE_MS, ROOM_REMIND_WINDOW_MS, BORROW_SOON_WINDOW_MS, OOO_RETURN_WINDOW_MS, OOO_RETURN_REMIND_THROTTLE_MS, VISIT_REMIND_WINDOW_MS, REPAIR_SLA_MS, MATERIAL_SLA_MS, REPAIR_ESCALATE_MS, VISIT_TOKEN_TTL_MS, WS_PING_MS, REPAIR_CATEGORIES, REPAIR_PRIORITIES, TOOL_CATEGORIES, INVENTORY_CATEGORIES, OOO_CATEGORIES, FEEDBACK_CATEGORIES, MATERIAL_PRIORITIES, MOOD_EMOJIS, EVENT_CATEGORIES, POLL_MAX_OPTIONS, KNOWLEDGE_CATEGORIES, TASK_PRIORITIES, TASK_STATUSES, NOTIFICATION_LEVELS, ATTEND_DEFAULT_WORK_START, ATTEND_DEFAULT_WORK_END, ATTEND_DEFAULT_LATE_MINUTES,
    pool,
    get pgEnabled() { return usePg; },
    set pgEnabled(v) { usePg = v; },
    initDb, flushWrites, scheduleFlush,
    // 工具
    genId, genSpaceId, genCheckinCode, sendTo, broadcastTo, sendToUser, sendToAccount, getUsersIn, getUserByAccount, isAdmin, serError, lk, spaceUserInfo, isToolLowStock, isStockLow,
    // 认证
    hashPassword, verifyPassword, issueToken, accountByLogin,
    // 持久化
    saveSpace, saveAccount, saveProfile, saveEntity, deleteEntity, saveStallRating, saveStatsToSpace,
    // 空间
    weekKey, newWeekly, newStats, recordWeekly, weeklyScore, borrowOverdue, dueBorrowReminders, dueRoomReminders, dueEventReminders, dueBorrowSoonReminders, dueOooReturnReminders, dueVisitorReminders, dueRepairSlaReminders, dueMaterialSlaReminders, dueRepairEscalations, findDuplicateRepair, createSpace, buildStalls, applyProfileToUser,
    // 序列化
    roomPublic, roomRatingSummary, reservationPublic, roomWaitlistPublic, toolsPublic, toolWaitlistPublic, materialsPublic, materialTemplatePublic, materialsTemplatesPublic, repairsPublic, borrowsPublic, visitorsPublic, visitorCodeExpired, stallsPublic, leaderboardPublic, roomReservationsPublic, pruneRoomReservations, stallTier, expandRecurring, roomUsageStats, inventoryPublic, inventoryIssuesPublic, newAttendanceConfig, todayKey, parseTime, minutesOfDay, isLateAt, attendancePublic, attendanceStats, deskPublic, deskReservationsPublic, deskUsageStats, pruneDeskReservations, oooPublic, oooStats, feedbackPublic, feedbackStats, moodPublic, moodStats, eventPublic, eventStats, pollPublic, pollStats, knowledgePublic, knowledgeStats, tasksPublic, taskStats, notificationPublic, notificationsPublic, attendanceStreak, attendanceCalendar, attendancePerfectMonths,
    // 广播
    broadcast, broadcastAll, broadcastUsers, broadcastLeaderboard, broadcastStalls, roomStatsBroadcast, attendanceBroadcast, desksBroadcast, deskStatsBroadcast, oooBroadcast, feedbackBroadcast, moodBroadcast, eventsBroadcast, pollsBroadcast, knowledgeBroadcast, tasksBroadcast, notificationsBroadcast, noticesBroadcast, pushNotification, pushNotice, visitorsBroadcast,
    // 坑位辅助
    activeStallCount, checkAchievements, notifyUrge, ACHIEVEMENT_DEFS,
    achievementProgress, achievementDefsPublic,
    // 每日看点
    buildDigest, buildWeeklyReport,
    // 我的待办
    buildMyReminders,
    // 空间活跃趋势
    buildSpaceTrend,
  };
}

module.exports = { createContext };