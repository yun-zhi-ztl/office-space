// =========================================================
// OfficeSpace · 办公空间管理 — 后端
// 单文件 Node.js + Express + ws + PostgreSQL(可选，失败降级内存)
// 模块：会议室预约 / 工具借用 / 物资申领 / 报修
// =========================================================
'use strict';
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ================= 常量 =================
const PORT = process.env.PORT || 3000;
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000;
const SPACE_ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const ROOM_STATUS = ['pending', 'active', 'completed', 'cancelled', 'expired'];
const BORROW_STATUS = ['borrowed', 'returned'];
const MATERIAL_STATUS = ['pending', 'fulfilled', 'cancelled'];
const REPAIR_STATUS = ['reported', 'in_progress', 'resolved', 'cancelled'];
const REPAIR_CATEGORIES = ['厕所', '灯光', '空调', '其它'];
const TOOL_CATEGORIES = ['测试电脑', '测试机器', '测试手机', '其它'];

// 可扩展性参数：实时广播只推最近 LIST_PAGE 条（分页加载），写合并去抖窗口，WS 心跳周期
const LIST_PAGE = 30;
const PERSIST_DEBOUNCE_MS = 500;
const WS_PING_MS = 30000;

// ================= 内存状态 =================
// space -> { id, name, admins:Set<account>, rooms:Room[], reservations:Map, tools:Tool[], borrows:Map, materialRequests:Map, repairs:Map, invites:Set, clients:Set }
const spaces = new Map();
const users = new Map();        // userId -> user（在线会话，含 currentSpace）
const accounts = new Map();     // account(原样) -> { account, passwordHash, username, avatar }
const tokens = new Map();       // token -> { account, expiresAt }

// ================= 基础工具 =================
function genId(prefix, set) {
  let id;
  do {
    id = prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  } while (set && set.has(id));
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
function sendTo(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
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
function requireSpace(sp) {
  return sp ? null : { type: 'error', message: '请先选择空间' };
}
function requireLogin(ws) {
  return users.get(ws._userId) || null;
}
function isAdmin(space, account) {
  return !!space.admins.has(account);
}
function serError(message) {
  return { type: 'error', message };
}

// 昵称显示名唯一化（同空间同用户名追加账号区分）
function lk(s) { return String(s == null ? '' : s).toLowerCase(); }
function spaceUserInfo(spaceId) {
  const info = new Map();
  for (const u of getUsersIn(spaceId)) {
    info.set(u.account, { account: u.account, username: u.nickname, avatar: u.avatar, online: true, role: isAdmin(spaces.get(spaceId), u.account) ? 'admin' : 'member', status: u.status || { label: '在岗' } });
  }
  // 统计撞名并生成 display
  const count = new Map();
  for (const d of info.values()) { const k = lk(d.username); count.set(k, (count.get(k) || 0) + 1); }
  for (const d of info.values()) {
    d.dup = count.get(lk(d.username)) > 1;
    d.display = d.dup ? `${d.username}(${d.account})` : d.username;
  }
  return info;
}

// ================= PostgreSQL =================
const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: +(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'toilet_dev',
  database: process.env.PGDATABASE || process.env.PGDATABASE || 'toilet',
});
pool.on('error', (err) => console.error('⚠️  Postgres 池错误:', err.message));
let usePg = false;

// ================= 持久化（幂等建表，不销毁数据） =================
async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS spaces(
    id text PRIMARY KEY, name text NOT NULL,
    admins jsonb NOT NULL DEFAULT '[]'::jsonb,
    squat_count int NOT NULL DEFAULT 4, urinal_count int NOT NULL DEFAULT 3,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS accounts(
    account text PRIMARY KEY, password_hash text NOT NULL,
    username text NOT NULL, avatar text NOT NULL DEFAULT '🧑',
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS profiles(
    space text NOT NULL, account text NOT NULL,
    nick text DEFAULT '', avatar text NOT NULL DEFAULT '🧑',
    stats jsonb NOT NULL DEFAULT '{}'::jsonb, achievements text[] NOT NULL DEFAULT '{}',
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(space, account)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS stall_ratings(
    space text NOT NULL, stall_id int NOT NULL, account text DEFAULT '',
    nickname text DEFAULT '', cleanliness int NOT NULL, signal int NOT NULL, paper int NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS entities(
    space text NOT NULL, kind text NOT NULL, id text NOT NULL, data jsonb NOT NULL,
    PRIMARY KEY(space, kind, id)
  )`);

  // 幂等迁移：兼容旧「坑位雷达」时期已存在的表结构
  // 1) spaces 补 admins 列
  await pool.query(`ALTER TABLE spaces ADD COLUMN IF NOT EXISTS admins jsonb NOT NULL DEFAULT '[]'::jsonb`);
  // 2) profiles / stall_ratings 旧列名 ns_id -> space（并给 stall_ratings 补 account 列）
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

  // 索引：支撑分页与载入查询（幂等）
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(kind)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stall_ratings_space_stall ON stall_ratings(space, stall_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_stall_ratings_space_time ON stall_ratings(space, created_at)`);

  // 载入空间
  const spRows = await pool.query('SELECT id,name,admins,squat_count,urinal_count FROM spaces');
  for (const r of spRows.rows) {
    const sp = createSpace(r.id, r.name, r.squat_count, r.urinal_count);
    sp.admins = new Set(r.admins || []);
  }
  // 载入账号
  const accRows = await pool.query('SELECT account,password_hash,username,avatar FROM accounts');
  for (const r of accRows.rows) accounts.set(r.account, { account: r.account, passwordHash: r.password_hash, username: r.username, avatar: r.avatar || '🧑' });
  // 载入战绩
  const pr = await pool.query('SELECT space,account,nick,avatar,stats,achievements FROM profiles');
  for (const r of pr.rows) profiles.set(`${r.space}::${r.account}`, { account: r.account, nick: r.nick, avatar: r.avatar, stats: r.stats || {}, achievements: r.achievements || [] });
  // 载入评分（挂回坑位）
  const rat = await pool.query('SELECT space,stall_id,account,nickname,cleanliness,signal,paper,created_at FROM stall_ratings ORDER BY created_at ASC');
  const byStall = {};
  for (const r of rat.rows) {
    const k = `${r.space}::${r.stall_id}`;
    (byStall[k] = byStall[k] || []).push({ account: r.account || '', nickname: r.nickname, cleanliness: r.cleanliness, signal: r.signal, paper: r.paper, timestamp: Date.parse(r.created_at) });
  }
  // 载入通用实体（rooms/tools/borrows/materials/repairs/room_reservations）
  const ent = await pool.query('SELECT space,kind,id,data FROM entities');
  for (const r of ent.rows) {
    const sp = spaces.get(r.space);
    if (!sp) continue;
    const data = r.data;
    if (r.kind === 'room') {
      sp.rooms.push(data);
      sp.roomReservations.set(data.id, data);
    } else if (r.kind === 'tool') {
      sp.tools.push(data);
    } else if (r.kind === 'borrow') {
      sp.borrows.set(data.id, data);
    } else if (r.kind === 'material') {
      sp.materialRequests.set(data.id, data);
    } else if (r.kind === 'repair') {
      sp.repairs.set(data.id, data);
    } else if (r.kind === 'stall') {
      const st = sp.stalls.find((s) => s.id === data.id);
      if (st) st.ratings = (data.ratings || []).slice(-60);
    }
  }
  // 把评分挂回坑位
  for (const [key, ratings] of Object.entries(byStall)) {
    const [ns, sid] = key.split('::');
    const sp = spaces.get(ns);
    if (!sp) continue;
    const st = sp.stalls.find((s) => s.id === +sid);
    if (st) st.ratings = ratings.slice(-60);
  }
}
const profiles = new Map(); // `${space}::${account}` -> { account, nick, avatar, stats, achievements }

function saveSpace(sp) {
  if (!usePg) return;
  pool.query(
    `INSERT INTO spaces(id,name,admins,squat_count,urinal_count) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, admins=EXCLUDED.admins, squat_count=EXCLUDED.squat_count, urinal_count=EXCLUDED.urinal_count`,
    [sp.id, sp.name, JSON.stringify([...sp.admins]), sp.squatCount, sp.urinalCount]
  ).catch(() => {});
}
function saveAccount(acct) {
  if (!usePg) return;
  pool.query(`INSERT INTO accounts(account,password_hash,username,avatar) VALUES($1,$2,$3,$4)
    ON CONFLICT(account) DO UPDATE SET username=EXCLUDED.username, avatar=EXCLUDED.avatar`,
    [acct.account, acct.passwordHash, acct.username, acct.avatar]).catch(() => {});
}
// ---- 写合并去抖：profile / entity 按主键合并，批量 upsert，降低并发写放大 ----
const queuedProfiles = new Map(); // `${space}::${account}` -> row [space,account,nick,avatar,statsJson,achievements]
const queuedEntities = new Map(); // `${space}|${kind}|${id}` -> row [space,kind,id,dataJson]
let flushTimer = null;

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
function deleteEntity(spaceId, kind, id) {
  if (!usePg) return;
  pool.query(`DELETE FROM entities WHERE space=$1 AND kind=$2 AND id=$3`, [spaceId, kind, id]).catch(() => {});
}
function saveStallRating(spaceId, stallId, r) {
  if (!usePg) return;
  pool.query(`INSERT INTO stall_ratings(space,stall_id,account,nickname,cleanliness,signal,paper) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [spaceId, stallId, r.account || '', r.nickname, r.cleanliness, r.signal, r.paper]).catch(() => {});
}

// ================= 账号 / 认证 =================
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

// ================= 空间 =================
function weekKey(ts) {
  const d = new Date(ts || Date.now());
  const day = (d.getDay() + 6) % 7; // 周一为一周起点
  d.setDate(d.getDate() - day);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function newWeekly() {
  return { key: weekKey(), visits: 0, borrows: 0, requests: 0, repairs: 0, meetings: 0 };
}
function newStats() {
  return { totalVisits: 0, totalDuration: 0, favoriteStall: null, onTimeRate: 0, consecutiveOnTime: 0, maxDuration: 0, nightVisits: 0, grabSuccess: 0, ratingsGiven: 0, borrowCount: 0, requestCount: 0, repairCount: 0, meetingCount: 0, weekly: newWeekly() };
}
// 记录本周活跃（若跨周自动清零）
function recordWeekly(user, field) {
  if (!user.stats.weekly || user.stats.weekly.key !== weekKey()) user.stats.weekly = newWeekly();
  user.stats.weekly[field] = (user.stats.weekly[field] || 0) + 1;
}
function weeklyScore(stats) {
  const w = stats.weekly;
  if (!w || w.key !== weekKey()) return 0;
  return (w.visits || 0) + (w.borrows || 0) + (w.requests || 0) + (w.repairs || 0) + (w.meetings || 0);
}
function createSpace(id, name, squat, urinal) {
  const sp = {
    id, name, squatCount: squat == null ? 4 : squat, urinalCount: urinal == null ? 3 : urinal,
    admins: new Set(),
    clients: new Set(),
    notices: [],                               // 空间公告（最近 N 条）
    rooms: [],                               // Room[]
    roomReservations: new Map(),             // id -> RoomReservation（会议室预约）
    reservations: new Map(),                 // id -> StallReservation（坑位预约/抢位，供过期清理）
    tools: [],                               // Tool[]
    borrows: new Map(),                      // id -> Borrow
    materialRequests: new Map(),             // id -> MaterialRequest
    repairs: new Map(),                      // id -> Repair
    urges: new Map(),                        // stallId -> count
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

// ================= HTTP 路由 =================
app.get('/api/spaces', (req, res) => {
  const list = [];
  for (const sp of spaces.values()) list.push({ id: sp.id, name: sp.name, admin_count: sp.admins.size });
  res.json(list);
});
app.post('/api/spaces', (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 30);
  const squat = parseInt(req.body.squat_count, 10);
  const urinal = parseInt(req.body.urinal_count, 10);
  if (!name) return res.status(400).json({ error: '请输入空间名' });
  const id = genSpaceId();
  const sp = createSpace(id, name, Number.isInteger(squat) ? Math.max(0, Math.min(10, squat)) : 4, Number.isInteger(urinal) ? Math.max(0, Math.min(10, urinal)) : 3);
  saveSpace(sp);
  res.json({ id: sp.id, name: sp.name, squat_count: sp.squatCount, urinal_count: sp.urinalCount });
});
app.post('/api/register', (req, res) => {
  const account = (req.body.account || '').trim();
  const username = (req.body.username || '').trim().slice(0, 12);
  const avatar = (req.body.avatar || '🧑').slice(0, 4);
  const password = String(req.body.password || '');
  if (!account || !password) return res.status(400).json({ error: '请输入账号和密码' });
  if (accounts.has(account)) return res.status(409).json({ error: '账号已被占用' });
  const acct = { account, passwordHash: hashPassword(password), username: username || account, avatar };
  accounts.set(account, acct);
  saveAccount(acct);
  res.json({ ok: true, account, username: acct.username, avatar: acct.avatar });
});

// ============ 广播序列化 ============
function roomPublic(r) {
  return { id: r.id, name: r.name, capacity: r.capacity, location: r.location, description: r.description };
}
function reservationPublic(res, info) {
  const who = info.get(res.ownerAccount);
  return {
    id: res.id, roomId: res.roomId, ownerAccount: res.ownerAccount,
    ownerName: who ? who.display : res.ownerName, title: res.title,
    startAt: res.startAt, endAt: res.endAt, note: res.note, status: res.status,
  };
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
      o.reservation = {
        by: who, startTime: s.reservation.startTime, endTime: s.reservation.endTime,
        duration: s.reservation.duration, isGrab: !!s.reservation.isGrab, reservationId: s.reservation.reservationId,
      };
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
  rows.forEach((r, i) => { r.mvp = (r.weekly || 0) > 0 && (r.weekly || 0) === maxWeekly; });
  rows.sort((a, b) => score(b.stats) - score(a.stats));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return { rankings: rows.slice(0, 30) };
}

// ============ 广播 ============
function broadcast(spaceId, type, payload) { broadcastTo(spaceId, Object.assign({ type }, payload)); }
// 分页：只推最近 LIST_PAGE 条 + 总数，前端按需 fetchPage
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

// ============ 统计隔离：切空间时保存旧空间、加载目标空间 ============
function saveStatsToSpace(user, spaceId) {
  const ns = spaceId;
  if (!ns || !spaces.has(ns)) return;
  const key = ns + '::' + user.account;
  profiles.set(key, { account: user.account, nick: user.nickname, avatar: user.avatar, stats: { ...user.stats }, achievements: [...user.achievements] });
  if (!usePg) return;
  queuedProfiles.set(key, [ns, user.account, user.nickname, user.avatar, JSON.stringify(user.stats), user.achievements]);
  scheduleFlush();
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

// ============ 加入空间 / 切换 ============
function joinSpace(ws, spaceId) {
  const sp = spaces.get(String(spaceId));
  if (!sp) return sendTo(ws, serError('空间不存在'));
  const u = users.get(ws._userId);
  const oldSp = ws._ns ? spaces.get(ws._ns) : null;
  if (u && oldSp && oldSp.id !== sp.id) {
    const busy = oldSp.stalls.some((s) => s.reservation && s.reservation.account === u.account);
    if (busy) return sendTo(ws, serError('你仍占用着坑位，请先释放或取消再切换空间'));
    saveStatsToSpace(u, oldSp.id);
    applyProfileToUser(u, sp.id);
  }
  if (oldSp) oldSp.clients.delete(ws);
  ws._ns = sp.id;
  sp.clients.add(ws);
  if (u) u.currentSpace = sp.id;
  sendTo(ws, { type: 'joined', space: { id: sp.id, name: sp.name, squat_count: sp.squatCount, urinal_count: sp.urinalCount, isAdmin: u ? isAdmin(sp, u.account) : false } });
  if (u) {
    if (sp.admins.size === 0) { sp.admins.add(u.account); saveSpace(sp); }
  }
  broadcastAll(sp);
}

// ============ 登录 ============
function handleLogin(ws, msg, space) {
  let account = null;
  if (msg.token) {
    const tok = tokens.get(msg.token);
    if (tok && tok.expiresAt > Date.now()) account = tok.account;
    if (!account) return sendTo(ws, serError('登录已过期，请重新登录'));
  } else {
    account = (msg.account || '').trim();
    const password = (msg.password || '');
    if (!account || !password) return sendTo(ws, serError('请输入账号和密码'));
    const acct = accountByLogin(account);
    if (!acct) return sendTo(ws, serError('账号不存在，请先注册'));
    if (!verifyPassword(password, acct.passwordHash)) return sendTo(ws, serError('账号或密码错误'));
    account = acct.account;
  }
  const acct = accounts.get(account);
  if (!acct) return sendTo(ws, serError('账号不存在，请先注册'));
  const userId = 'u' + Date.now() + Math.random().toString(36).slice(2, 6);
  const token = issueToken(account);
  if (space.admins.size === 0) { space.admins.add(account); saveSpace(space); }
  const user = {
    id: userId, account, token, nickname: acct.username, avatar: acct.avatar || '🧑',
    currentSpace: space.id, ws, stats: newStats(), achievements: [],
    currentStall: null, emergencyMode: false, wasOnTime: true,
  };
  applyProfileToUser(user, space.id);
  users.set(userId, user);
  ws._userId = userId;
  sendTo(ws, { type: 'loginSuccess', userId, account, nickname: user.nickname, avatar: user.avatar, token, role: isAdmin(space, account) ? 'admin' : 'member', spaceId: space.id });
  broadcastAll(space);
  sendToUser(userId, { type: 'digest', digest: buildDigest(space, user) });
}

// ============ 会议室模块 ============
function roomReservationsPublic(space) {
  const info = spaceUserInfo(space.id);
  return [...space.roomReservations.values()].map((r) => reservationPublic(r, info)).sort((a, b) => a.startAt - b.startAt);
}
function roomsBroadcast(space) {
  const reservations = roomReservationsPublic(space);
  broadcast(space.id, 'rooms', { rooms: space.rooms.map(roomPublic), reservations: reservations.slice(0, LIST_PAGE), reservationTotal: reservations.length });
}
function handleRooms(ws, user, space, msg) {
  const info = spaceUserInfo(space.id);
  if (msg.type === 'roomCreate') {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可新增会议室'));
    const name = (msg.name || '').trim().slice(0, 30);
    const capacity = parseInt(msg.capacity, 10);
    if (!name) return sendTo(ws, serError('请输入会议室名称'));
    if (!Number.isInteger(capacity) || capacity < 1) return sendTo(ws, serError('请输入有效容纳人数'));
    const room = { id: genId('rm', null), name, capacity, location: (msg.location || '').trim().slice(0, 40), description: (msg.description || '').trim().slice(0, 100) };
    space.rooms.push(room);
    saveEntity(space.id, 'room', room.id, room);
    roomsBroadcast(space);
  } else if (msg.type === 'roomRemove') {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除会议室'));
    const idx = space.rooms.findIndex((r) => r.id === msg.roomId);
    if (idx < 0) return sendTo(ws, serError('会议室不存在'));
    const room = space.rooms[idx];
    const hasActive = [...space.roomReservations.values()].some((r) => r.roomId === room.id && (r.status === 'pending' || r.status === 'active'));
    if (hasActive) return sendTo(ws, serError('该会议室仍有进行/待开始的预约，无法删除'));
    space.rooms.splice(idx, 1);
    for (const r of [...space.roomReservations.values()]) if (r.roomId === room.id) { space.roomReservations.delete(r.id); deleteEntity(space.id, 'room_reservation', r.id); }
    deleteEntity(space.id, 'room', room.id);
    roomsBroadcast(space);
  } else if (msg.type === 'roomBook') {
    const room = space.rooms.find((r) => r.id === msg.roomId);
    if (!room) return sendTo(ws, serError('会议室不存在'));
    const startAt = Math.floor(+msg.startAt || 0);
    const endAt = Math.floor(+msg.endAt || 0);
    if (!(startAt > 0) || !(endAt > startAt)) return sendTo(ws, serError('请选择有效的时间段'));
    if (endAt - startAt < 5 * 60000) return sendTo(ws, serError('至少预约 5 分钟'));
    const clash = [...space.roomReservations.values()].some((r) => r.roomId === room.id && (r.status === 'pending' || r.status === 'active') && startAt < r.endAt && endAt > r.startAt);
    if (clash) return sendTo(ws, serError('该时段已被预约，请另选时间'));
    const res = { id: genId('res', null), roomId: room.id, ownerAccount: user.account, ownerName: user.nickname, title: (msg.title || '').trim().slice(0, 40) || '会议', startAt, endAt, note: (msg.note || '').trim().slice(0, 120), status: 'pending' };
    space.roomReservations.set(res.id, res);
    saveEntity(space.id, 'room_reservation', res.id, res);
    recordWeekly(user, 'meetings');
    roomsBroadcast(space);
  } else if (msg.type === 'reservationCancel') {
    const res = space.roomReservations.get(msg.reservationId);
    if (!res) return sendTo(ws, serError('预约不存在'));
    if (res.ownerAccount !== user.account) return sendTo(ws, serError('只能取消自己的预约'));
    if (res.status !== 'pending') return sendTo(ws, serError('该预约已不能取消'));
    res.status = 'cancelled';
    saveEntity(space.id, 'room_reservation', res.id, res);
    roomsBroadcast(space);
  } else if (msg.type === 'roomStart' || msg.type === 'roomEnd') {
    const res = space.roomReservations.get(msg.reservationId);
    if (!res) return sendTo(ws, serError('预约不存在'));
    if (res.ownerAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能操作自己的预约'));
    if (msg.type === 'roomStart' && res.status === 'pending' && res.startAt <= Date.now()) res.status = 'active';
    if (msg.type === 'roomEnd' && res.status === 'active') res.status = 'completed';
    saveEntity(space.id, 'room_reservation', res.id, res);
    roomsBroadcast(space);
  }
  void info;
}

// ============ 工具借用模块 ============
function toolsBroadcast(space) {
  const info = spaceUserInfo(space.id);
  broadcast(space.id, 'tools', { tools: toolsPublic(space, info) });
}
function handleTools(ws, user, space, msg) {
  if (msg.type === 'toolCreate') {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可新增设备'));
    const name = (msg.name || '').trim().slice(0, 30);
    const total = parseInt(msg.total, 10);
    if (!name) return sendTo(ws, serError('请输入设备名称'));
    if (!Number.isInteger(total) || total < 1) return sendTo(ws, serError('请输入有效库存数量'));
    const category = TOOL_CATEGORIES.includes(msg.category) ? msg.category : '其它';
    const tool = { id: genId('tl', null), name, category, total, available: total, location: (msg.location || '').trim().slice(0, 40), description: (msg.description || '').trim().slice(0, 100) };
    space.tools.push(tool);
    saveEntity(space.id, 'tool', tool.id, tool);
    toolsBroadcast(space);
  } else if (msg.type === 'toolDelete') {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除设备'));
    const idx = space.tools.findIndex((t) => t.id === msg.toolId);
    if (idx < 0) return sendTo(ws, serError('设备不存在'));
    const tool = space.tools[idx];
    const hasBorrowed = [...space.borrows.values()].some((b) => b.toolId === tool.id && b.status === 'borrowed');
    if (hasBorrowed) return sendTo(ws, serError('该设备仍有未归还的借用，无法删除'));
    space.tools.splice(idx, 1);
    for (const b of [...space.borrows.values()]) if (b.toolId === tool.id) { space.borrows.delete(b.id); deleteEntity(space.id, 'borrow', b.id); }
    deleteEntity(space.id, 'tool', tool.id);
    toolsBroadcast(space);
  } else if (msg.type === 'toolAdjust') {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可调整库存'));
    const tool = space.tools.find((t) => t.id === msg.toolId);
    if (!tool) return sendTo(ws, serError('设备不存在'));
    const total = parseInt(msg.total, 10);
    if (!Number.isInteger(total) || total < 1) return sendTo(ws, serError('请输入有效库存数量'));
    const diff = total - tool.total;
    if (tool.available + diff < 0) return sendTo(ws, serError('无法将库存调低到少于当前在借数量'));
    tool.total = total;
    tool.available += diff;
    saveEntity(space.id, 'tool', tool.id, tool);
    toolsBroadcast(space);
  } else if (msg.type === 'toolBorrow') {
    const tool = space.tools.find((t) => t.id === msg.toolId);
    if (!tool) return sendTo(ws, serError('设备不存在'));
    const qty = parseInt(msg.qty, 10);
    if (!Number.isInteger(qty) || qty < 1) return sendTo(ws, serError('请输入有效借用数量'));
    if (qty > tool.available) return sendTo(ws, serError('库存不足，当前可用 ' + tool.available));
    tool.available -= qty;
    const borrow = { id: genId('bw', null), toolId: tool.id, borrowerAccount: user.account, borrowerName: user.nickname, qty, borrowedAt: Date.now(), returnedAt: null, status: 'borrowed' };
    space.borrows.set(borrow.id, borrow);
    user.stats.borrowCount = (user.stats.borrowCount || 0) + 1;
    recordWeekly(user, 'borrows');
    saveProfile(user);
    saveEntity(space.id, 'tool', tool.id, tool);
    saveEntity(space.id, 'borrow', borrow.id, borrow);
    toolsBroadcast(space);
    broadcastLeaderboard(space);
  } else if (msg.type === 'toolReturn') {
    const borrow = space.borrows.get(msg.borrowId);
    if (!borrow) return sendTo(ws, serError('借用记录不存在'));
    if (borrow.status !== 'borrowed') return sendTo(ws, serError('该借用已归还'));
    if (borrow.borrowerAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能归还自己的借用'));
    const tool = space.tools.find((t) => t.id === borrow.toolId);
    if (!tool) return sendTo(ws, serError('设备不存在'));
    borrow.status = 'returned';
    borrow.returnedAt = Date.now();
    tool.available = Math.min(tool.total, tool.available + borrow.qty);
    saveEntity(space.id, 'tool', tool.id, tool);
    saveEntity(space.id, 'borrow', borrow.id, borrow);
    toolsBroadcast(space);
  }
}

// ============ 物资申领模块 ============
function materialsBroadcast(space) {
  const info = spaceUserInfo(space.id);
  const all = materialsPublic(space, info);
  broadcast(space.id, 'materials', { requests: all.slice(0, LIST_PAGE), total: all.length });
}
function handleMaterials(ws, user, space, msg) {
  if (msg.type === 'materialRequest') {
    const name = (msg.name || '').trim().slice(0, 30);
    const qty = parseInt(msg.qty, 10);
    if (!name) return sendTo(ws, serError('请输入物资名称'));
    if (!Number.isInteger(qty) || qty < 1) return sendTo(ws, serError('请输入有效数量'));
    const req = { id: genId('mt', null), requesterAccount: user.account, requesterName: user.nickname, name, qty, unit: (msg.unit || '个').trim().slice(0, 10), reason: (msg.reason || '').trim().slice(0, 120), status: 'pending', createdAt: Date.now(), handledAt: null };
    space.materialRequests.set(req.id, req);
    user.stats.requestCount = (user.stats.requestCount || 0) + 1;
    recordWeekly(user, 'requests');
    saveProfile(user);
    saveEntity(space.id, 'material', req.id, req);
    materialsBroadcast(space);
    broadcastLeaderboard(space);
  } else if (msg.type === 'materialCancel') {
    const req = space.materialRequests.get(msg.requestId);
    if (!req) return sendTo(ws, serError('申领记录不存在'));
    if (req.requesterAccount !== user.account) return sendTo(ws, serError('只能取消自己的申领'));
    if (req.status !== 'pending') return sendTo(ws, serError('该申领已处理，无法取消'));
    req.status = 'cancelled';
    saveEntity(space.id, 'material', req.id, req);
    materialsBroadcast(space);
  } else if (msg.type === 'materialFulfill') {
    const req = space.materialRequests.get(msg.requestId);
    if (!req) return sendTo(ws, serError('申领记录不存在'));
    if (req.requesterAccount === user.account) return sendTo(ws, serError('不能处理自己的申领'));
    if (req.status !== 'pending') return sendTo(ws, serError('该申领已处理'));
    req.status = 'fulfilled';
    req.handledAt = Date.now();
    saveEntity(space.id, 'material', req.id, req);
    materialsBroadcast(space);
  }
}

// ============ 报修模块 ============
function repairsBroadcast(space) {
  const info = spaceUserInfo(space.id);
  const all = repairsPublic(space, info);
  broadcast(space.id, 'repairs', { repairs: all.slice(0, LIST_PAGE), total: all.length });
}
function handleRepairs(ws, user, space, msg) {
  if (msg.type === 'repairCreate') {
    const category = REPAIR_CATEGORIES.includes(msg.category) ? msg.category : '其它';
    const location = (msg.location || '').trim().slice(0, 40);
    const description = (msg.description || '').trim().slice(0, 160);
    if (!location || !description) return sendTo(ws, serError('请填写故障位置与描述'));
    const rep = { id: genId('rp', null), reporterAccount: user.account, reporterName: user.nickname, category, location, description, status: 'reported', createdAt: Date.now(), updatedAt: Date.now() };
    space.repairs.set(rep.id, rep);
    user.stats.repairCount = (user.stats.repairCount || 0) + 1;
    recordWeekly(user, 'repairs');
    saveProfile(user);
    saveEntity(space.id, 'repair', rep.id, rep);
    repairsBroadcast(space);
    broadcastLeaderboard(space);
  } else if (msg.type === 'repairUpdate') {
    const rep = space.repairs.get(msg.repairId);
    if (!rep) return sendTo(ws, serError('报修记录不存在'));
    const to = msg.status;
    const from = rep.status;
    const isReporter = rep.reporterAccount === user.account;
    if (to === 'cancelled') {
      if (!isReporter || from !== 'reported') return sendTo(ws, serError('仅上报人可取消未处理的报修'));
    } else if (to === 'in_progress') {
      if (from !== 'reported') return sendTo(ws, serError('仅可从未处理的报修进入处理中'));
    } else if (to === 'resolved') {
      if (from !== 'reported' && from !== 'in_progress') return sendTo(ws, serError('仅可从处理中/未处理置为已解决'));
    } else {
      return sendTo(ws, serError('无效的报修状态'));
    }
    rep.status = to;
    rep.updatedAt = Date.now();
    saveEntity(space.id, 'repair', rep.id, rep);
    repairsBroadcast(space);
  }
}

// ============ 扩展功能：公告 / 状态灯 / 智能选房 / 催还 / 每日看点 ============
function noticesBroadcast(sp) { broadcast(sp.id, 'notices', { notices: sp.notices }); }
function pushNotice(space, text, fromAccount, fromName) {
  space.notices.unshift({ id: genId('n', null), text, from: fromName || fromAccount || '系统', ts: Date.now() });
  if (space.notices.length > 50) space.notices.length = 50;
  noticesBroadcast(space);
}
function handleSetStatus(ws, user, space, msg) {
  const label = (msg.label || '').trim().slice(0, 8) || '在岗';
  const emoji = (msg.emoji || '').slice(0, 4) || '';
  user.status = { label, emoji };
  broadcastUsers(space);
  sendTo(ws, { type: 'statusSet', status: user.status });
}
function handleAnnounce(ws, user, space, msg) {
  const text = (msg.text || '').trim().slice(0, 120);
  if (!text) return sendTo(ws, serError('公告不能为空'));
  pushNotice(space, text, user.account, user.nickname);
}
function suggestRooms(space, startAt, endAt, capacity) {
  const st = Math.floor(+startAt || 0), en = Math.floor(+endAt || 0);
  if (!(st > 0) || !(en > st)) return [];
  let list = space.rooms.filter((r) => ![...space.roomReservations.values()].some((x) => x.roomId === r.id && (x.status === 'pending' || x.status === 'active') && st < x.endAt && en > x.startAt));
  if (Number.isInteger(capacity) && capacity > 0) list = list.filter((r) => r.capacity >= capacity);
  return list.sort((a, b) => a.capacity - b.capacity);
}
function handleSuggestRoom(ws, user, space, msg) {
  const capacity = parseInt(msg.capacity, 10);
  const list = suggestRooms(space, msg.startAt, msg.endAt, capacity);
  sendTo(ws, { type: 'suggestRooms', suggestions: list.map(roomPublic) });
}
function handleRemindReturn(ws, user, space, msg) {
  const b = space.borrows.get(msg.borrowId);
  if (!b || b.status !== 'borrowed') return sendTo(ws, serError('借用记录不存在或已归还'));
  if (b.borrowerAccount === user.account) return sendTo(ws, serError('自己的借用无需提醒'));
  let n = 0;
  for (const [, u] of users) if (u.currentSpace === space.id && u.account === b.borrowerAccount && u.ws && u.ws.readyState === 1) { u.ws.send(JSON.stringify({ type: 'borrowReminder', borrowId: b.id, from: user.nickname })); n++; }
  if (n === 0) return sendTo(ws, serError('借用人当前离线，无法提醒'));
  pushNotice(space, `提醒 ${b.borrowerName} 归还设备`, user.account, user.nickname);
  sendTo(ws, { type: 'remindSent', count: n });
}
function buildDigest(space, user) {
  const monday0 = new Date(); monday0.setHours(0, 0, 0, 0);
  const today0 = monday0.getTime(), todayEnd = today0 + 86400000;
  const todayMeetings = roomReservationsPublic(space).filter((r) => r.startAt >= today0 && r.startAt < todayEnd && (r.status === 'pending' || r.status === 'active'));
  const overdue = [...space.borrows.values()].filter((b) => b.status === 'borrowed' && (Date.now() - b.borrowedAt) >= 7 * 86400000);
  const myBorrows = [...space.borrows.values()].filter((b) => b.borrowerAccount === user.account && b.status === 'borrowed');
  const pendingMaterials = [...space.materialRequests.values()].filter((r) => r.status === 'pending');
  const openRepairs = [...space.repairs.values()].filter((r) => r.status === 'reported' || r.status === 'in_progress');
  const mvp = leaderboardPublic(space).rankings.find((r) => r.mvp) || null;
  return {
    todayMeetingCount: todayMeetings.length, todayMeetings: todayMeetings.slice(0, 5),
    overdueCount: overdue.length, myBorrows: myBorrows.length, pendingMaterialsCount: pendingMaterials.length, openRepairsCount: openRepairs.length, mvp,
  };
}

// ============ 坑位看板模块（原坑位雷达） ============
const RESERVE_CONFIRM_WINDOW_MS = 5 * 60000;
function broadcastStalls(space) {
  const info = spaceUserInfo(space.id);
  broadcast(space.id, 'stalls', { squat_count: space.squatCount, urinal_count: space.urinalCount, stalls: stallsPublic(space, info) });
}
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
function handleStalls(ws, user, space, msg) {
  const type = msg.type;
  const stall = space.stalls.find((x) => x.id === msg.stallId);

  if (type === 'stallConfig') {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可配置坑位'));
    const squat = parseInt(msg.squat_count, 10);
    const urinal = parseInt(msg.urinal_count, 10);
    const sq = Number.isInteger(squat) ? Math.max(0, Math.min(10, squat)) : space.squatCount;
    const ur = Number.isInteger(urinal) ? Math.max(0, Math.min(10, urinal)) : space.urinalCount;
    const oldRatings = {};
    for (const s of space.stalls) oldRatings[s.id] = s.ratings || [];
    space.squatCount = sq;
    space.urinalCount = ur;
    space.stalls = buildStalls(sq, ur);
    for (const s of space.stalls) if (oldRatings[s.id]) s.ratings = oldRatings[s.id].slice(-60);
    space.reservations.clear();
    saveSpace(space);
    broadcastStalls(space);
    return;
  }

  if (type === 'reserve') {
    if (!stall) return sendTo(ws, serError('坑位不存在'));
    if (stall.status !== 'free') return sendTo(ws, serError('该坑位已被占用'));
    if (activeStallCount(space, user) >= 1) return sendTo(ws, serError('你已占着一个坑位，一次只能用一个'));
    const durOpts = stall.type === 'urinal' ? [1, 2, 5] : [15, 30, 45];
    const duration = durOpts.includes(msg.duration) ? msg.duration : durOpts[0];
    const startTime = Date.now() + 60000;
    const endTime = startTime + duration * 60000;
    const reservationId = genId('r', null);
    const res = { id: reservationId, stallId: stall.id, userId: user.id, account: user.account, nickname: user.nickname, startTime, endTime, duration, status: 'pending' };
    space.reservations.set(reservationId, res);
    stall.status = 'reserved';
    stall.currentUser = null;
    stall.reservation = { userId: user.id, account: user.account, nickname: user.nickname, startTime, endTime, duration, reservationId, isGrab: false };
    sendTo(ws, { type: 'reservation', reservation: { id: reservationId, stallId: stall.id, startTime, endTime, duration, status: 'pending' } });
    broadcastStalls(space);
    return;
  }

  if (type === 'cancel') {
    const reservation = space.reservations.get(msg.reservationId);
    if (!reservation || reservation.account !== user.account) return sendTo(ws, serError('预约不存在'));
    const target = space.stalls.find((x) => x.id === reservation.stallId);
    if (!target) return sendTo(ws, serError('预约不存在'));
    if (target.status === 'occupied') return sendTo(ws, serError('正在使用中，无法取消'));
    target.status = 'free'; target.reservation = null;
    reservation.status = 'cancelled';
    space.reservations.delete(reservation.id);
    sendTo(ws, { type: 'cancelSuccess', reservationId: reservation.id });
    broadcastStalls(space);
    return;
  }

  if (type === 'grab') {
    if (!stall) return sendTo(ws, serError('坑位不存在'));
    if (stall.status !== 'free') return sendTo(ws, serError('手慢了，已被抢'));
    if (activeStallCount(space, user) >= 1) return sendTo(ws, serError('你已占着一个坑位，一次只能用一个'));
    stall.status = 'occupied';
    stall.currentUser = user.account;
    const gmin = stall.type === 'urinal' ? 1 : 5;
    const now = Date.now();
    stall.reservation = { userId: user.id, account: user.account, nickname: user.nickname, startTime: now, endTime: now + gmin * 60000, duration: gmin, reservationId: 'g' + Date.now(), isGrab: true };
    user.currentStall = stall.id;
    user.stats.grabSuccess++;
    // 不在此处累计 totalVisits：一次抢位由 finish / 自动释放各计一次，避免“抢位+结束”重复计数（issue #8）
    checkAchievements(user);
    saveProfile(user);
    broadcastStalls(space);
    broadcastLeaderboard(space);
    sendToUser(user.id, { type: 'stats', stats: user.stats });
    return;
  }

  if (type === 'startUse') {
    if (!stall || !stall.reservation) return sendTo(ws, serError('无有效预约'));
    if (stall.reservation.account !== user.account) return sendTo(ws, serError('这不是你的预约'));
    if (stall.status === 'occupied') return sendTo(ws, serError('坑位正在使用中'));
    if (Date.now() < stall.reservation.startTime) return sendTo(ws, serError('尚未到预约时间，请到点后再确认到坑'));
    if (Date.now() > stall.reservation.startTime + RESERVE_CONFIRM_WINDOW_MS) return sendTo(ws, serError('预约已过期，未在规定时间内确认到坑'));
    stall.status = 'occupied';
    stall.currentUser = user.account;
    const r = space.reservations.get(stall.reservation.reservationId);
    if (r) r.status = 'active';
    user.currentStall = stall.id;
    user.wasOnTime = true;
    broadcastStalls(space);
    return;
  }

  if (type === 'finish' || type === 'release') {
    if (!stall || !stall.reservation) return sendTo(ws, serError('无有效预约'));
    if (stall.reservation.account !== user.account) return sendTo(ws, serError('只有当前使用者可操作'));
    const wasReserve = stall.reservation.reservationId && space.reservations.get(stall.reservation.reservationId);
    if (type === 'finish') {
      const duration = Math.round((Date.now() - stall.reservation.startTime) / 60000);
      user.stats.totalDuration += duration;
      user.stats.maxDuration = Math.max(user.stats.maxDuration, duration);
      if (user.stats.favoriteStall === null) user.stats.favoriteStall = stall.id;
      user.stats.totalVisits++;
      recordWeekly(user, 'visits');
      const hour = new Date().getHours();
      if (hour < 6 || hour > 22) user.stats.nightVisits++;
      if (user.wasOnTime) user.stats.consecutiveOnTime++; else user.stats.consecutiveOnTime = 0;
      user.stats.onTimeRate = user.stats.totalVisits > 0 ? 1 : 0;
    }
    if (wasReserve) { wasReserve.status = 'completed'; space.reservations.delete(wasReserve.id); }
    stall.status = 'free'; stall.currentUser = null; stall.reservation = null;
    user.currentStall = null; user.wasOnTime = true;
    space.urges.delete(stall.id);
    checkAchievements(user);
    broadcast(space.id, 'stallReleased', { stallId: stall.id });
    broadcastStalls(space);
    broadcastLeaderboard(space);
    sendToUser(user.id, { type: 'stats', stats: user.stats });
    saveProfile(user);
    return;
  }

  if (type === 'urge') {
    if (!stall || stall.status !== 'occupied') return sendTo(ws, serError('坑位空闲，无需催促'));
    const count = (space.urges.get(stall.id) || 0) + 1;
    space.urges.set(stall.id, count);
    notifyUrge(space, stall.id, count, stall.reservation.account);
    broadcastStalls(space);
    return;
  }

  if (type === 'rate') {
    if (!stall) return sendTo(ws, serError('坑位不存在'));
    const s = (v) => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
    const cleanliness = s(msg.cleanliness);
    const signal = s(msg.signal);
    const paper = s(msg.paper);
    if (![cleanliness, signal, paper].every((n) => n >= 1 && n <= 5)) return sendTo(ws, serError('评分需为 1-5 的整数'));
    if (stall.ratings.some((r) => r.account && r.account === user.account)) return sendTo(ws, serError('你已为该坑位评过分'));
    stall.ratings.push({ account: user.account, nickname: user.nickname, cleanliness, signal, paper, timestamp: Date.now() });
    if (stall.ratings.length > 60) stall.ratings = stall.ratings.slice(-60);
    user.stats.ratingsGiven++;
    checkAchievements(user);
    saveProfile(user);
    saveStallRating(space.id, stall.id, { account: user.account, nickname: user.nickname, cleanliness, signal, paper });
    broadcastStalls(space);
    sendToUser(user.id, { type: 'stats', stats: user.stats });
    return;
  }

  if (type === 'toggleEmergency') {
    user.emergencyMode = !!msg.enabled;
    sendTo(ws, { type: 'emergencyToggled', enabled: user.emergencyMode });
    broadcastUsers(space);
    return;
  }
}

// ============ 分页加载 ============
function handleFetchPage(ws, user, space, msg) {
  const offset = Math.max(0, parseInt(msg.offset, 10) || 0);
  const limit = Math.min(50, Math.max(1, parseInt(msg.limit, 10) || LIST_PAGE));
  const info = spaceUserInfo(space.id);
  let items = [];
  let total = 0;
  if (msg.module === 'materials') {
    const all = materialsPublic(space, info); total = all.length; items = all.slice(offset, offset + limit);
  } else if (msg.module === 'repairs') {
    const all = repairsPublic(space, info); total = all.length; items = all.slice(offset, offset + limit);
  } else if (msg.module === 'rooms') {
    const all = roomReservationsPublic(space); total = all.length; items = all.slice(offset, offset + limit);
  } else {
    return sendTo(ws, serError('不支持的分页模块'));
  }
  sendTo(ws, { type: 'page', module: msg.module, offset, items, total });
}

// ================= WebSocket 分发 =================
wss.on('connection', (ws) => {
  ws._userId = null;
  ws._ns = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') { joinSpace(ws, msg.spaceId); return; }

    const space = ws._ns ? spaces.get(ws._ns) : null;
    if (!space) return sendTo(ws, serError('请先选择空间'));

    if (msg.type === 'login') { handleLogin(ws, msg, space); return; }

    const user = users.get(ws._userId);
    if (!user) return sendTo(ws, serError('请先登录'));

    if (msg.type === 'logout') { if (user.token) tokens.delete(user.token); return; }
    if (msg.type === 'getStats') { sendToUser(user.id, { type: 'stats', stats: user.stats }); return; }
    if (msg.type === 'fetchPage') { handleFetchPage(ws, user, space, msg); return; }

    switch (msg.type) {
      case 'roomCreate': case 'roomRemove': case 'roomBook': case 'reservationCancel': case 'roomStart': case 'roomEnd':
        handleRooms(ws, user, space, msg); break;
      case 'toolCreate': case 'toolDelete': case 'toolAdjust': case 'toolBorrow': case 'toolReturn':
        handleTools(ws, user, space, msg); break;
      case 'materialRequest': case 'materialCancel': case 'materialFulfill':
        handleMaterials(ws, user, space, msg); break;
      case 'repairCreate': case 'repairUpdate':
        handleRepairs(ws, user, space, msg); break;
      case 'reserve': case 'cancel': case 'grab': case 'startUse': case 'finish': case 'release': case 'urge': case 'rate': case 'toggleEmergency': case 'stallConfig':
        handleStalls(ws, user, space, msg); break;
      case 'setStatus':
        handleSetStatus(ws, user, space, msg); break;
      case 'announce':
        handleAnnounce(ws, user, space, msg); break;
      case 'suggestRoom':
        handleSuggestRoom(ws, user, space, msg); break;
      case 'remindReturn':
        handleRemindReturn(ws, user, space, msg); break;
      default:
        sendTo(ws, serError('未知操作'));
    }
  });

  ws.on('close', () => {
    const sp = ws._ns ? spaces.get(ws._ns) : null;
    if (sp) sp.clients.delete(ws);
    const u = users.get(ws._userId);
    if (u) {
      saveProfile(u);
      if (sp) {
        // 释放 connection 占用中的坑位
        if (u.currentStall !== null) {
          const stall = sp.stalls.find((s) => s.id === u.currentStall && s.reservation && s.reservation.account === u.account);
          if (stall) {
            const rr = stall.reservation.reservationId ? sp.reservations.get(stall.reservation.reservationId) : null;
            stall.status = 'free'; stall.currentUser = null; stall.reservation = null;
            if (rr) sp.reservations.delete(rr.id);
            sp.urges.delete(stall.id);
            broadcastStalls(sp);
          }
          u.currentStall = null;
        }
        // 取消该账号所有待开始/已预约的坑位预约
        for (const [rid, r] of [...sp.reservations]) {
          if (r.account === u.account && r.status === 'pending') {
            const stall = sp.stalls.find((s) => s.id === r.stallId);
            if (stall && stall.reservation && stall.reservation.reservationId === rid) { stall.status = 'free'; stall.reservation = null; }
            sp.reservations.delete(rid);
          }
        }
        broadcastUsers(sp);
        broadcastLeaderboard(sp);
      }
      users.delete(u.id);
    }
  });
});

// ============ 定时器：过期释放（每 15 秒） ============
setInterval(() => {
  const now = Date.now();
  for (const sp of spaces.values()) {
    // 1) 坑位：预约未确认到坑 → 进入等待(waiting)，超窗 → 过期释放
    for (const [rid, r] of [...sp.reservations]) {
      if (r.status !== 'pending') continue;
      if (now > r.startTime + RESERVE_CONFIRM_WINDOW_MS) {
        r.status = 'expired';
        const stall = sp.stalls.find((s) => s.id === r.stallId);
        if (stall && stall.reservation && stall.reservation.reservationId === rid && stall.status !== 'occupied') {
          stall.status = 'free'; stall.reservation = null;
          broadcast(sp.id, 'reservationExpired', { stallId: stall.id });
          broadcast(sp.id, 'stallReleased', { stallId: stall.id });
          broadcastStalls(sp);
        }
        sp.reservations.delete(rid);
        const user = users.get(r.userId);
        if (user) { user.wasOnTime = false; user.stats.consecutiveOnTime = 0; }
      } else if (now >= r.startTime) {
        const stall = sp.stalls.find((s) => s.id === r.stallId);
        if (stall && stall.status === 'reserved') stall.status = 'waiting';
      }
    }
    // 2) 坑位：占用超时自动释放
    for (const stall of sp.stalls) {
      if (stall.status !== 'occupied' || !stall.reservation) continue;
      if (now < (stall.reservation.endTime || 0)) continue;
      const user = users.get(stall.reservation.userId);
      if (user) {
        const duration = Math.max(0, Math.round((now - (stall.reservation.startTime || now)) / 60000));
        user.stats.totalDuration += duration;
        user.stats.maxDuration = Math.max(user.stats.maxDuration, duration);
        user.stats.totalVisits++;
        recordWeekly(user, 'visits');
        user.stats.onTimeRate = user.stats.totalVisits > 0 ? 1 : 0;
        checkAchievements(user);
        saveProfile(user);
        user.currentStall = null;
      }
      const rr = stall.reservation.reservationId ? sp.reservations.get(stall.reservation.reservationId) : null;
      if (rr) sp.reservations.delete(rr.id);
      stall.status = 'free'; stall.currentUser = null; stall.reservation = null;
      sp.urges.delete(stall.id);
      broadcast(sp.id, 'autoRelease', { stallId: stall.id });
      broadcast(sp.id, 'stallReleased', { stallId: stall.id });
      broadcastStalls(sp);
      broadcastLeaderboard(sp);
    }
    // 3) 会议室：预约自动流转（开始→进行中，超时→过期）
    let roomsChanged = false;
    for (const res of [...sp.roomReservations.values()]) {
      if (res.status === 'pending') {
        if (now >= res.endAt) { res.status = 'expired'; roomsChanged = true; }
        else if (now >= res.startAt) { res.status = 'active'; roomsChanged = true; }
      }
    }
    if (roomsChanged) roomsBroadcast(sp);
  }
}, 15000);

// ============ 心跳：清理异常断开的僵尸连接 ============
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
}, WS_PING_MS);

// ============ 优雅停机：flush 待写、关闭连接与连接池 ============
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在优雅停机…`);
  flushWrites().finally(() => {
    try { for (const ws of wss.clients) ws.close(); } catch {}
    server.close(() => { pool.end().catch(() => {}); process.exit(0); });
    setTimeout(() => { pool.end().catch(() => {}); process.exit(0); }, 2500).unref();
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ============ 启动 ============
initDb()
  .then(() => {
    usePg = true;
    console.log(`PostgreSQL 已连接；已载入 ${spaces.size} 个空间`);
    server.listen(PORT, '0.0.0.0', () => console.log(`OfficeSpace · 办公空间管理 运行在 http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('❌ 无法连接 PostgreSQL，仅以内存运行:', err.message);
    server.listen(PORT, '0.0.0.0', () => console.log(`OfficeSpace · 办公空间管理 运行在 http://localhost:${PORT}（内存模式）`));
  });