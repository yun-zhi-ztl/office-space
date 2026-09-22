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
  const TOOL_CATEGORIES = ['测试电脑', '测试机器', '测试手机', '其它'];
  const LIST_PAGE = 30;
  const PERSIST_DEBOUNCE_MS = 500;
  const WS_PING_MS = 30000;
  const RESERVE_CONFIRM_WINDOW_MS = 5 * 60000;

  // ---------- 内存状态 ----------
  const spaces = new Map();
  const users = new Map();
  const accounts = new Map();
  const tokens = new Map();
  const profiles = new Map(); // `${space}::${account}` -> { account, nick, avatar, stats, achievements }
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
  function getUsersIn(spaceId) {
    const out = [];
    for (const [, u] of users) if (u.currentSpace === spaceId) out.push(u);
    return out;
  }
  function isAdmin(space, account) { return !!space.admins.has(account); }
  function serError(message) { return { type: 'error', message }; }
  function lk(s) { return String(s == null ? '' : s).toLowerCase(); }
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
    database: process.env.PGDATABASE || process.env.PGDATABASE || 'toilet',
  });
  pool.on('error', (err) => console.error('⚠️  Postgres 池错误:', err.message));

  async function initDb() {
    await pool.query(`CREATE TABLE IF NOT EXISTS spaces(
      id text PRIMARY KEY, name text NOT NULL,
      admins jsonb NOT NULL DEFAULT '[]'::jsonb,
      squat_count int NOT NULL DEFAULT 4, urinal_count int NOT NULL DEFAULT 3,
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

    const spRows = await pool.query('SELECT id,name,admins,squat_count,urinal_count FROM spaces');
    for (const r of spRows.rows) { const sp = createSpace(r.id, r.name, r.squat_count, r.urinal_count); sp.admins = new Set(r.admins || []); }
    const accRows = await pool.query('SELECT account,password_hash,username,avatar FROM accounts');
    for (const r of accRows.rows) accounts.set(r.account, { account: r.account, passwordHash: r.password_hash, username: r.username, avatar: r.avatar || '🧑' });
    const pr = await pool.query('SELECT space,account,nick,avatar,stats,achievements FROM profiles');
    for (const r of pr.rows) profiles.set(`${r.space}::${r.account}`, { account: r.account, nick: r.nick, avatar: r.avatar, stats: r.stats || {}, achievements: r.achievements || [] });
    const rat = await pool.query('SELECT space,stall_id,account,nickname,cleanliness,signal,paper,created_at FROM stall_ratings ORDER BY created_at ASC');
    const byStall = {};
    for (const r of rat.rows) { const k = `${r.space}::${r.stall_id}`; (byStall[k] = byStall[k] || []).push({ account: r.account || '', nickname: r.nickname, cleanliness: r.cleanliness, signal: r.signal, paper: r.paper, timestamp: Date.parse(r.created_at) }); }
    const ent = await pool.query('SELECT space,kind,id,data FROM entities');
    for (const r of ent.rows) {
      const sp = spaces.get(r.space);
      if (!sp) continue;
      const data = r.data;
      if (r.kind === 'room') { sp.rooms.push(data); sp.roomReservations.set(data.id, data); }
      else if (r.kind === 'tool') sp.tools.push(data);
      else if (r.kind === 'borrow') sp.borrows.set(data.id, data);
      else if (r.kind === 'material') sp.materialRequests.set(data.id, data);
      else if (r.kind === 'repair') sp.repairs.set(data.id, data);
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
    pool.query(`INSERT INTO spaces(id,name,admins,squat_count,urinal_count) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, admins=EXCLUDED.admins, squat_count=EXCLUDED.squat_count, urinal_count=EXCLUDED.urinal_count`,
      [sp.id, sp.name, JSON.stringify([...sp.admins]), sp.squatCount, sp.urinalCount]).catch(() => {});
  }
  function saveAccount(acct) {
    if (!usePg) return;
    pool.query(`INSERT INTO accounts(account,password_hash,username,avatar) VALUES($1,$2,$3,$4)
      ON CONFLICT(account) DO UPDATE SET username=EXCLUDED.username, avatar=EXCLUDED.avatar`,
      [acct.account, acct.passwordHash, acct.username, acct.avatar]).catch(() => {});
  }
  const queuedProfiles = new Map();
  const queuedEntities = new Map();
  let flushTimer = null;
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flushWrites, PERSIST_DEBOUNCE_MS);
    if (flushTimer.unref) flushTimer.unref();
  }
  async function flushWrites() {
    flushTimer = null;
    if (!usePg) { queuedProfiles.clear(); queuedEntities.clear(); return; }
    const pRows = [...queuedProfiles.values()];
    const eRows = [...queuedEntities.values()];
    queuedProfiles.clear();
    queuedEntities.clear();
    if (pRows.length) {
      try {
        const valueSql = pRows.map((_, i) => `($${i * 6 + 1},$${i * 6 + 2},$${i * 6 + 3},$${i * 6 + 4},$${i * 6 + 5}::jsonb,$${i * 6 + 6})`).join(',');
        await pool.query(`INSERT INTO profiles(space,account,nick,avatar,stats,achievements) VALUES ${valueSql}
          ON CONFLICT(space,account) DO UPDATE SET nick=EXCLUDED.nick, avatar=EXCLUDED.avatar, stats=EXCLUDED.stats, achievements=EXCLUDED.achievements, updated_at=now()`, pRows.flat());
      } catch (e) { console.error('⚠️ flush profiles 失败:', e.message); }
    }
    if (eRows.length) {
      try {
        const valueSql = eRows.map((_, i) => `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4}::jsonb)`).join(',');
        await pool.query(`INSERT INTO entities(space,kind,id,data) VALUES ${valueSql}
          ON CONFLICT(space,kind,id) DO UPDATE SET data=EXCLUDED.data`, eRows.flat());
      } catch (e) { console.error('⚠️ flush entities 失败:', e.message); }
    }
  }
  function saveProfile(user) {
    const ns = user.currentSpace;
    if (!ns || !spaces.has(ns)) return;
    const key = ns + '::' + user.account;
    profiles.set(key, { account: user.account, nick: user.nickname, avatar: user.avatar, stats: { ...user.stats }, achievements: [...user.achievements] });
    if (!usePg) return;
    queuedProfiles.set(key, [ns, user.account, user.nickname, user.avatar, JSON.stringify(user.stats), user.achievements]);
    scheduleFlush();
  }
  function saveEntity(spaceId, kind, id, data) {
    if (!usePg) return;
    queuedEntities.set(`${spaceId}|${kind}|${id}`, [spaceId, kind, id, JSON.stringify(data)]);
    scheduleFlush();
  }
  function deleteEntity(spaceId, kind, id) {
    if (!usePg) return;
    pool.query(`DELETE FROM entities WHERE space=$1 AND kind=$2 AND id=$3`, [spaceId, kind, id]).catch(() => {});
  }
  function saveStallRating(spaceId, stallId, r) {
    if (!usePg) return;
    pool.query(`INSERT INTO stall_ratings(space,stall_id,account,nickname,cleanliness,signal,paper) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [spaceId, stallId, r.account || '', r.nickname, r.cleanliness, r.signal, r.paper]).catch(() => {});
  }
  function saveStatsToSpace(user, spaceId) {
    const ns = spaceId;
    if (!ns || !spaces.has(ns)) return;
    const key = ns + '::' + user.account;
    profiles.set(key, { account: user.account, nick: user.nickname, avatar: user.avatar, stats: { ...user.stats }, achievements: [...user.achievements] });
    if (!usePg) return;
    queuedProfiles.set(key, [ns, user.account, user.nickname, user.avatar, JSON.stringify(user.stats), user.achievements]);
    scheduleFlush();
  }

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
  function newStats() { return { totalVisits: 0, totalDuration: 0, favoriteStall: null, onTimeRate: 0, consecutiveOnTime: 0, maxDuration: 0, nightVisits: 0, grabSuccess: 0, ratingsGiven: 0, borrowCount: 0, requestCount: 0, repairCount: 0, meetingCount: 0, weekly: newWeekly() }; }
  function recordWeekly(user, field) { if (!user.stats.weekly || user.stats.weekly.key !== weekKey()) user.stats.weekly = newWeekly(); user.stats.weekly[field] = (user.stats.weekly[field] || 0) + 1; }
  function weeklyScore(stats) { const w = stats.weekly; if (!w || w.key !== weekKey()) return 0; return (w.visits || 0) + (w.borrows || 0) + (w.requests || 0) + (w.repairs || 0) + (w.meetings || 0); }
  function createSpace(id, name, squat, urinal) {
    const sp = {
      id, name, squatCount: squat == null ? 4 : squat, urinalCount: urinal == null ? 3 : urinal,
      admins: new Set(), clients: new Set(), notices: [],
      rooms: [], roomReservations: new Map(), reservations: new Map(),
      tools: [], borrows: new Map(), materialRequests: new Map(), repairs: new Map(), urges: new Map(),
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

  // ---------- 序列化 ----------
  function roomPublic(r) { return { id: r.id, name: r.name, capacity: r.capacity, location: r.location, description: r.description }; }
  function reservationPublic(res, info) {
    const who = info.get(res.ownerAccount);
    return { id: res.id, roomId: res.roomId, ownerAccount: res.ownerAccount, ownerName: who ? who.display : res.ownerName, title: res.title, startAt: res.startAt, endAt: res.endAt, note: res.note, status: res.status };
  }
  function toolsPublic(sp, info) {
    const now = Date.now();
    return sp.tools.map((t) => {
      const active = [...sp.borrows.values()].filter((b) => b.toolId === t.id && b.status === 'borrowed');
      return {
        id: t.id, name: t.name, category: t.category, total: t.total, available: t.available,
        location: t.location, description: t.description,
        borrowedCount: active.reduce((s, b) => s + b.qty, 0),
        activeBorrows: active.map((b) => { const days = Math.floor((now - b.borrowedAt) / 86400000); return { id: b.id, qty: b.qty, borrowerAccount: b.borrowerAccount, borrowerName: info.get(b.borrowerAccount) ? info.get(b.borrowerAccount).display : b.borrowerName, borrowedAt: b.borrowedAt, days, overdue: days >= 7 }; }),
      };
    });
  }
  function materialsPublic(sp, info) {
    return [...sp.materialRequests.values()].map((m) => ({
      id: m.id, name: m.name, qty: m.qty, unit: m.unit, reason: m.reason, status: m.status,
      requesterAccount: m.requesterAccount,
      requesterName: info.get(m.requesterAccount) ? info.get(m.requesterAccount).display : m.requesterName,
      createdAt: m.createdAt, handledAt: m.handledAt,
    })).sort((a, b) => (b.createdAt - a.createdAt));
  }
  function repairsPublic(sp, info) {
    return [...sp.repairs.values()].map((r) => ({
      id: r.id, category: r.category, location: r.location, description: r.description, status: r.status,
      reporterAccount: r.reporterAccount,
      reporterName: info.get(r.reporterAccount) ? info.get(r.reporterAccount).display : r.reporterName,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    })).sort((a, b) => (b.createdAt - a.createdAt));
  }
  function stallTier(s) {
    const n = s.ratings.length;
    if (!n) return { name: '新坑', icon: '🌱', rank: 0, avg: 0, count: 0 };
    let sum = 0;
    for (const r of s.ratings) sum += (r.cleanliness + r.signal + r.paper) / 3;
    const avg = sum / n;
    const score = avg * 16 + Math.min(n, 10) * 2;
    let name = score >= 85 ? '王者' : score >= 68 ? '黄金' : score >= 50 ? '白银' : '青铜';
    const icon = name === '王者' ? '👑' : name === '黄金' ? '🏅' : name === '白银' ? '🥈' : '🥉';
    return { name, icon, rank: Math.round(score), avg: +avg.toFixed(1), count: n };
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
    for (const [key, p] of profiles) {
      if (!key.startsWith(sp.id + '::')) continue;
      if (!key.slice(sp.id.length + 2)) continue;
      rows.push({ account: p.account, username: p.nick || p.account, avatar: p.avatar || '🧑', stats: p.stats || {}, achievements: p.achievements || [], weekly: weeklyScore(p.stats || {}) });
    }
    const score = (s) => (s.totalVisits || 0) + (s.borrowCount || 0) + (s.requestCount || 0) + (s.repairCount || 0) + (s.meetingCount || 0);
    const maxWeekly = rows.reduce((m, r) => Math.max(m, r.weekly || 0), 0);
    rows.forEach((r) => { r.mvp = (r.weekly || 0) > 0 && (r.weekly || 0) === maxWeekly; });
    rows.sort((a, b) => score(b.stats) - score(a.stats));
    rows.forEach((r, i) => { r.rank = i + 1; });
    return { rankings: rows.slice(0, 30) };
  }
  function roomReservationsPublic(space) {
    const info = spaceUserInfo(space.id);
    return [...space.roomReservations.values()].map((r) => reservationPublic(r, info)).sort((a, b) => a.startAt - b.startAt);
  }

  // ---------- 广播 ----------
  function broadcast(spaceId, type, payload) { broadcastTo(spaceId, Object.assign({ type }, payload)); }
  function broadcastUsers(sp) {
    const info = spaceUserInfo(sp.id);
    const arr = [];
    for (const [, u] of users) {
      if (u.currentSpace !== sp.id) continue;
      const d = info.get(u.account) || {};
      arr.push({ account: u.account, online: true, username: u.nickname, avatar: u.avatar, role: d.role || 'member', display: d.display || u.nickname, status: u.status || { label: '在岗' } });
    }
    broadcast(sp.id, 'users', { users: arr });
  }
  function broadcastLeaderboard(sp) { broadcast(sp.id, 'leaderboard', leaderboardPublic(sp)); }
  function noticesBroadcast(sp) { broadcast(sp.id, 'notices', { notices: sp.notices }); }
  function broadcastStalls(sp) {
    const info = spaceUserInfo(sp.id);
    broadcast(sp.id, 'stalls', { squat_count: sp.squatCount, urinal_count: sp.urinalCount, stalls: stallsPublic(sp, info) });
  }
  function broadcastAll(sp) {
    const info = spaceUserInfo(sp.id);
    const reservations = roomReservationsPublic(sp);
    const materials = materialsPublic(sp, info);
    const repairs = repairsPublic(sp, info);
    broadcast(sp.id, 'rooms', { rooms: sp.rooms.map(roomPublic), reservations: reservations.slice(0, LIST_PAGE), reservationTotal: reservations.length });
    broadcast(sp.id, 'tools', { tools: toolsPublic(sp, info) });
    broadcast(sp.id, 'materials', { requests: materials.slice(0, LIST_PAGE), total: materials.length });
    broadcast(sp.id, 'repairs', { repairs: repairs.slice(0, LIST_PAGE), total: repairs.length });
    broadcast(sp.id, 'stalls', { squat_count: sp.squatCount, urinal_count: sp.urinalCount, stalls: stallsPublic(sp, info) });
    broadcast(sp.id, 'notices', { notices: sp.notices });
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
  ];
  function checkAchievements(user) {
    let changed = false;
    for (const a of ACHIEVEMENT_DEFS) {
      if (a.check(user) && !user.achievements.includes(a.id)) { user.achievements.push(a.id); changed = true; }
    }
    return changed;
  }
  function notifyUrge(space, stallId, count, account) {
    for (const [, u] of users) if (u.currentSpace === space.id && u.account === account && u.ws && u.ws.readyState === 1) u.ws.send(JSON.stringify({ type: 'urgeNotification', stallId, count }));
  }

  // ---------- 每日看点 ----------
  function buildDigest(space, user) {
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const today0 = day0.getTime(), todayEnd = today0 + 86400000;
    const todayMeetings = roomReservationsPublic(space).filter((r) => r.startAt >= today0 && r.startAt < todayEnd && (r.status === 'pending' || r.status === 'active'));
    const overdue = [...space.borrows.values()].filter((b) => b.status === 'borrowed' && (Date.now() - b.borrowedAt) >= 7 * 86400000);
    const myBorrows = [...space.borrows.values()].filter((b) => b.borrowerAccount === user.account && b.status === 'borrowed');
    const pendingMaterials = [...space.materialRequests.values()].filter((r) => r.status === 'pending');
    const openRepairs = [...space.repairs.values()].filter((r) => r.status === 'reported' || r.status === 'in_progress');
    const mvp = leaderboardPublic(space).rankings.find((r) => r.mvp) || null;
    return { todayMeetingCount: todayMeetings.length, todayMeetings: todayMeetings.slice(0, 5), overdueCount: overdue.length, myBorrows: myBorrows.length, pendingMaterialsCount: pendingMaterials.length, openRepairsCount: openRepairs.length, mvp };
  }

  return {
    // 状态
    spaces, users, accounts, tokens, profiles,
    // 访问器
    LIST_PAGE, RESERVE_CONFIRM_WINDOW_MS, WS_PING_MS, REPAIR_CATEGORIES, TOOL_CATEGORIES,
    pool,
    get pgEnabled() { return usePg; },
    set pgEnabled(v) { usePg = v; },
    initDb, flushWrites, scheduleFlush,
    // 工具
    genId, genSpaceId, sendTo, broadcastTo, sendToUser, getUsersIn, isAdmin, serError, lk, spaceUserInfo,
    // 认证
    hashPassword, verifyPassword, issueToken, accountByLogin,
    // 持久化
    saveSpace, saveAccount, saveProfile, saveEntity, deleteEntity, saveStallRating, saveStatsToSpace,
    // 空间
    weekKey, newWeekly, newStats, recordWeekly, weeklyScore, createSpace, buildStalls, applyProfileToUser,
    // 序列化
    roomPublic, reservationPublic, toolsPublic, materialsPublic, repairsPublic, stallsPublic, leaderboardPublic, roomReservationsPublic, stallTier,
    // 广播
    broadcast, broadcastAll, broadcastUsers, broadcastLeaderboard, broadcastStalls, noticesBroadcast,
    // 坑位辅助
    activeStallCount, checkAchievements, notifyUrge, ACHIEVEMENT_DEFS,
    // 每日看点
    buildDigest,
  };
}

module.exports = { createContext };