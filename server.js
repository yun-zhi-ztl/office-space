const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// =========================================================
// 命名空间（厕所空间）：每个空间拥有自己的一套坑位配置与运行状态
// 开放加入：任何人可创建空间、可进入任何空间
// =========================================================
const spaces = new Map();  // spaceId -> { id,name,squatCount,urinalCount,stalls,reservations,urges,clients }
const users = new Map();   // userId -> user（user.currentSpace 指向所在空间）

// 预约"确认到坑"允许的时间窗：从预约开始时间起，超过该窗口未确认则预约过期释放。
// 与下方定时器保持同一来源，避免两处魔法数字漂移。
const RESERVE_CONFIRM_WINDOW_MS = 5 * 60000;

const ACHIEVEMENT_DEFS = [
  { id: 'punctual', name: '守时达人', desc: '连续3次准时到坑', icon: '⏰', check: (u) => u.stats.consecutiveOnTime >= 3 },
  { id: 'endurance', name: '持久战', desc: '单次蹲坑超过20分钟', icon: '🐌', check: (u) => u.stats.maxDuration >= 20 },
  { id: 'night', name: '夜行者', desc: '凌晨时段使用', icon: '🌙', check: (u) => u.stats.nightVisits >= 1 },
  { id: 'king', name: '蹲坑之王', desc: '累计使用超过10次', icon: '👑', check: (u) => u.stats.totalVisits >= 10 },
  { id: 'grabber', name: '抢位达人', desc: '临时抢位成功5次', icon: '⚡', check: (u) => u.stats.grabSuccess >= 5 },
  { id: 'rater', name: '评论家', desc: '给坑位评分3次', icon: '✍️', check: (u) => u.stats.ratingsGiven >= 3 },
];

// ============ 工具函数 ============
function lk(s) { return String(s == null ? '' : s).toLowerCase(); }

function getUsersIn(spaceId) {
  const out = [];
  for (const [, u] of users) if (u.currentSpace === spaceId) out.push(u);
  return out;
}
// 统计某人在某空间里当前占用的坑位数（含已预约未到坑、正使用中）。
// 约定：一次只能占一个坑——要么蹲坑要么尿槽，不许一个人把坑位占满。
function activeStallCount(space, user) {
  let n = 0;
  for (const st of space.stalls) if (st.reservation && st.reservation.userId === user.id) n++;
  return n;
}
function sendToUser(userId, data) {
  for (const [, user] of users) {
    if (user.id === userId && user.ws.readyState === 1) user.ws.send(JSON.stringify(data));
  }
}
function broadcastTo(spaceId, data) {
  const sp = spaces.get(spaceId);
  if (!sp) return;
  const msg = JSON.stringify(data);
  sp.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
}
// =========================================================
// 空间内成员身份与显示名解析
// 身份键：账号（全局唯一、区分大小写）。用户名允许重名；
// 当同一空间内多个账号的用户名（忽略大小写）相同时，显示名追加账号作区分，
// 例如「王伟」「王伟(wangwei01)」。
// =========================================================
function spaceInfo(spaceId) {
  const entries = new Map(); // account -> { account, username, avatar, stats, achievements, online }
  for (const u of getUsersIn(spaceId)) {
    entries.set(u.account, { account: u.account, username: u.nickname, avatar: u.avatar, stats: u.stats, achievements: u.achievements, online: true });
  }
  const prefix = spaceId + '::';
  for (const [key, p] of profiles) {
    if (!key.startsWith(prefix)) continue;
    const account = key.slice(prefix.length);
    const e = entries.get(account);
    if (e) { if (p.nick) e.username = p.nick; }
    else entries.set(account, { account, username: p.nick || account, avatar: p.avatar, stats: p.stats, achievements: p.achievements, online: false });
  }
  // 按用户名（忽略大小写）统计是否撞名，撞名则显示名追加账号
  const count = new Map();
  for (const d of entries.values()) { const k = lk(d.username); count.set(k, (count.get(k) || 0) + 1); }
  for (const d of entries.values()) {
    d.dup = count.get(lk(d.username)) > 1;
    d.display = d.dup ? `${d.username}(${d.account})` : d.username;
  }
  return entries;
}
function displayOf(spaceId, account, fallback) {
  const d = spaceInfo(spaceId).get(account);
  return (d && d.display) || fallback || '';
}
function broadcastStalls(spaceId) {
  const sp = spaces.get(spaceId);
  if (!sp) return;
  const info = spaceInfo(spaceId);
  broadcastTo(spaceId, {
    type: 'stalls',
    stalls: sp.stalls.map((s) => {
      const o = { id: s.id, type: s.type, name: s.name, status: s.status, urgeCount: sp.urges.get(s.id) || 0, ratings: s.ratings, reservation: null, currentBy: null };
      if (s.reservation) {
        const w = info.get(s.reservation.account) || {};
        const who = { account: s.reservation.account, display: w.display || s.reservation.nickname, dup: !!w.dup, avatar: w.avatar || '🧑' };
        o.reservation = {
          by: who, startTime: s.reservation.startTime, endTime: s.reservation.endTime,
          duration: s.reservation.duration, isGrab: !!s.reservation.isGrab, reservationId: s.reservation.reservationId,
        };
        if (s.status === 'occupied' || s.status === 'reserved' || s.status === 'waiting') o.currentBy = who;
      }
      return o;
    }),
  });
}
function broadcastUsers(spaceId) {
  const info = spaceInfo(spaceId);
  broadcastTo(spaceId, {
    type: 'users',
    users: getUsersIn(spaceId).map((u) => {
      const w = info.get(u.account) || {};
      return { id: u.id, account: u.account, display: w.display || u.nickname, dup: !!w.dup, avatar: u.avatar };
    }),
  });
}
function broadcastLeaderboard(spaceId) {
  const sp = spaces.get(spaceId);
  if (!sp) return;
  const list = [];
  for (const d of spaceInfo(spaceId).values()) {
    list.push({ account: d.account, display: d.display, dup: d.dup, avatar: d.avatar, stats: d.stats, achievements: d.achievements });
  }
  list.sort((a, b) => (b.stats.totalDuration || 0) - (a.stats.totalDuration || 0));
  broadcastTo(spaceId, { type: 'leaderboard', rankings: list });
}
function checkAchievements(user) {
  for (const def of ACHIEVEMENT_DEFS) {
    if (!user.achievements.includes(def.id) && def.check(user)) {
      user.achievements.push(def.id);
      sendToUser(user.id, { type: 'achievement', achievement: def });
      if (user.currentSpace) {
        const d = displayOf(user.currentSpace, user.account, user.nickname);
        broadcastTo(user.currentSpace, { type: 'achievementUnlocked', nickname: d, achievement: def });
      }
    }
  }
}
function getStats(user) {
  return {
    totalVisits: user.stats.totalVisits,
    totalDuration: user.stats.totalDuration,
    favoriteStall: user.stats.favoriteStall,
    onTimeRate: user.stats.onTimeRate,
    maxDuration: user.stats.maxDuration,
    grabSuccess: user.stats.grabSuccess,
    nightVisits: user.stats.nightVisits,
    consecutiveOnTime: user.stats.consecutiveOnTime,
    achievements: user.achievements,
  };
}

// ============ 空间构建 ============
function buildStalls(squat, urinal) {
  const stalls = [];
  for (let i = 1; i <= squat; i++) stalls.push({ id: i, type: 'squat', name: `蹲坑${i}`, status: 'free', currentUser: null, reservation: null, ratings: [] });
  for (let j = 1; j <= urinal; j++) stalls.push({ id: squat + j, type: 'urinal', name: `尿槽${j}`, status: 'free', currentUser: null, reservation: null, ratings: [] });
  return stalls;
}
function createSpace(id, name, squat, urinal) {
  const sp = { id, name, squatCount: squat, urinalCount: urinal, stalls: buildStalls(squat, urinal), reservations: new Map(), urges: new Map(), clients: new Set() };
  spaces.set(id, sp);
  return sp;
}
const SPACE_ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
function genSpaceId() {
  let id;
  do {
    id = '';
    for (let i = 0; i < 4; i++) id += SPACE_ID_CHARS[Math.floor(Math.random() * SPACE_ID_CHARS.length)];
  } while (spaces.has(id));
  return id;
}

// ============ HTTP：空间列表 / 创建 ============
app.get('/api/spaces', (req, res) => {
  const list = [];
  for (const sp of spaces.values()) list.push({ id: sp.id, name: sp.name, squat_count: sp.squatCount, urinal_count: sp.urinalCount });
  res.json(list);
});
app.post('/api/spaces', (req, res) => {
  const name = (req.body.name || '').trim().slice(0, 30);
  const squat = parseInt(req.body.squat_count, 10);
  const urinal = parseInt(req.body.urinal_count, 10);
  if (!name) return res.status(400).json({ error: '请输入空间名' });
  if (!Number.isInteger(squat) || squat < 1 || squat > 10 || !Number.isInteger(urinal) || urinal < 0 || urinal > 10) {
    return res.status(400).json({ error: '蹲坑数 1-10，尿槽数 0-10' });
  }
  const id = genSpaceId();
  const sp = createSpace(id, name, squat, urinal);
  saveSpace(sp);
  res.json({ id: sp.id, name: sp.name, squat_count: sp.squatCount, urinal_count: sp.urinalCount });
});

// ============ 账号注册 ============
app.post('/api/register', (req, res) => {
  const account = String(req.body.account || '').trim();
  const password = String(req.body.password || '');
  const username = String(req.body.username || '').trim();
  const avatar = String(req.body.avatar || '🧑').trim().slice(0, 4) || '🧑';
  if (!account) return res.status(400).json({ error: '请输入账号' });
  if (account.length > 24) return res.status(400).json({ error: '账号最长 24 个字符' });
  if (!password) return res.status(400).json({ error: '请输入密码' });
  if (password.length > 72) return res.status(400).json({ error: '密码最长 72 个字符' });
  if (!username) return res.status(400).json({ error: '请输入用户名' });
  if (username.length > 12) return res.status(400).json({ error: '用户名最长 12 个字符' });
  if (accounts.has(account)) return res.status(409).json({ error: '账号已被占用，请换一个' });
  const acct = { account, passwordHash: hashPassword(password), username, avatar };
  accounts.set(account, acct);
  saveAccount(acct);
  res.json({ ok: true, account, username, avatar });
});

// ============ PostgreSQL 持久化（空间 / 战绩 / 评分） ============
const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: +(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'toilet_dev',
  database: process.env.PGDATABASE || 'toilet',
});
pool.on('error', (err) => console.error('⚠️  Postgres 池错误:', err.message));

// 持久化用户战绩，键：`${spaceId}::${小写昵称}`
const profiles = new Map();

// ============ 账号体系 ============
// 账号全局唯一且区分大小写（"Alice" 与 "alice" 是两个账号）；
// 登录用 账号+密码；密码按原始字节哈希（大小写敏感）；会话签发 token，刷新/重连不记明文密码
const accounts = new Map(); // account(原样) -> { account, passwordHash, username, avatar }
const tokens = new Map();   // token -> { account, expiresAt }
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}
function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const derived = crypto.scryptSync(String(pw), parts[1], 64);
    return crypto.timingSafeEqual(Buffer.from(parts[2], 'hex'), derived);
  } catch { return false; }
}
function issueToken(account) {
  const token = 't' + crypto.randomBytes(16).toString('hex');
  tokens.set(token, { account, expiresAt: Date.now() + TOKEN_TTL });
  // 定期清理过期 token
  setInterval(() => { for (const [k, v] of tokens) if (v.expiresAt < Date.now()) tokens.delete(k); }, 3600000).unref();
  return token;
}
function accountByLogin(account) {
  return accounts.get(String(account || '').trim()) || null;
}
function saveAccount(acct) {
  pool.query(
    `INSERT INTO accounts(account, password_hash, username, avatar) VALUES($1,$2,$3,$4)
     ON CONFLICT(account) DO UPDATE SET password_hash=EXCLUDED.password_hash, username=EXCLUDED.username, avatar=EXCLUDED.avatar`,
    [acct.account, acct.passwordHash, acct.username, acct.avatar]
  ).catch(() => {});
}
function saveSpace(sp) {
  pool.query(
    `INSERT INTO spaces(id, name, squat_count, urinal_count) VALUES($1,$2,$3,$4)
     ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name, squat_count=EXCLUDED.squat_count, urinal_count=EXCLUDED.urinal_count`,
    [sp.id, sp.name, sp.squatCount, sp.urinalCount]
  ).catch(() => {});
}
function saveProfile(user) {
  const ns = user.currentSpace;
  if (!ns || !spaces.has(ns)) return;
  // 身份键用账号（全局唯一）；nick 仅作显示名展示
  const key = ns + '::' + user.account;
  profiles.set(key, { account: user.account, nick: user.nickname, avatar: user.avatar, stats: { ...user.stats }, achievements: [...user.achievements] });
  pool.query(
    `INSERT INTO profiles(ns_id, account, nick, avatar, stats, achievements) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(ns_id, account) DO UPDATE SET nick=EXCLUDED.nick, avatar=EXCLUDED.avatar, stats=EXCLUDED.stats, achievements=EXCLUDED.achievements, updated_at=now()`,
    [ns, user.account, user.nickname, user.avatar, JSON.stringify(user.stats), user.achievements]
  ).catch(() => {});
}
function saveStallRating(ns, stallId, r) {
  pool.query(
    `INSERT INTO stall_ratings(ns_id, stall_id, nickname, cleanliness, signal, paper) VALUES($1,$2,$3,$4,$5,$6)`,
    [ns, stallId, r.nickname, r.cleanliness, r.signal, r.paper]
  ).catch(() => {});
}
async function initDb() {
  // 幂等建表；不再在启动时 DROP 业务表，避免重启清空战绩/评分（持久化数据需跨重启保留）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS spaces(
      id text PRIMARY KEY,
      name text NOT NULL,
      squat_count int NOT NULL DEFAULT 4,
      urinal_count int NOT NULL DEFAULT 3,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles(
      ns_id text NOT NULL,
      account text NOT NULL,
      nick text DEFAULT '',
      avatar text NOT NULL DEFAULT '🧑',
      stats jsonb NOT NULL DEFAULT '{}'::jsonb,
      achievements text[] NOT NULL DEFAULT '{}',
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(ns_id, account)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts(
      id serial PRIMARY KEY,
      account text NOT NULL,
      password_hash text NOT NULL,
      username text NOT NULL,
      avatar text NOT NULL DEFAULT '🧑',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT accounts_account_key UNIQUE (account)
    )`);
  // 迁移：去掉旧的大小写折叠列，确保 account 原样唯一
  await pool.query('ALTER TABLE accounts DROP COLUMN IF EXISTS account_ci');
  await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='accounts_account_key' AND conrelid='accounts'::regclass) THEN
        ALTER TABLE accounts ADD CONSTRAINT accounts_account_key UNIQUE (account);
      END IF;
    END $$`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stall_ratings(
      ns_id text NOT NULL,
      stall_id int NOT NULL,
      nickname text DEFAULT '',
      cleanliness int NOT NULL,
      signal int NOT NULL,
      paper int NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  // 载入空间
  const spRows = await pool.query('SELECT id, name, squat_count, urinal_count FROM spaces');
  for (const r of spRows.rows) createSpace(r.id, r.name, r.squat_count, r.urinal_count);
  // 载入账号（账号体系全局唯一、区分大小写）
  const accRows = await pool.query('SELECT account, password_hash, username, avatar FROM accounts');
  for (const r of accRows.rows) accounts.set(r.account, { account: r.account, passwordHash: r.password_hash, username: r.username, avatar: r.avatar || '🧑' });
  // 载入战绩
  const pr = await pool.query('SELECT ns_id, account, nick, avatar, stats, achievements FROM profiles');
  for (const r of pr.rows) profiles.set(`${r.ns_id}::${r.account}`, { account: r.account, nick: r.nick, avatar: r.avatar, stats: r.stats || {}, achievements: r.achievements || [] });
  // 载入评分（按空间+坑位分组挂回）
  const rat = await pool.query('SELECT ns_id, stall_id, nickname, cleanliness, signal, paper, created_at FROM stall_ratings ORDER BY created_at ASC');
  const byKey = {};
  for (const r of rat.rows) {
    const k = `${r.ns_id}::${r.stall_id}`;
    (byKey[k] = byKey[k] || []).push({ nickname: r.nickname, cleanliness: r.cleanliness, signal: r.signal, paper: r.paper, timestamp: Date.parse(r.created_at) });
  }
  for (const [key, ratings] of Object.entries(byKey)) {
    const [ns, sid] = key.split('::');
    const sp = spaces.get(ns);
    if (!sp) continue;
    const st = sp.stalls.find((s) => s.id === +sid);
    if (st) st.ratings = ratings.slice(-60);
  }
}

// ============ 进入某个空间 ============
function joinSpace(ws, spaceId) {
  const sp = spaces.get(String(spaceId));
  if (!sp) return ws.send(JSON.stringify({ type: 'error', message: '空间不存在' }));
  if (ws._ns && spaces.get(ws._ns)) spaces.get(ws._ns).clients.delete(ws);
  ws._ns = sp.id;
  sp.clients.add(ws);
  const u = users.get(ws._userId);
  if (u) u.currentSpace = sp.id;
  ws.send(JSON.stringify({ type: 'joined', space: { id: sp.id, name: sp.name, squat_count: sp.squatCount, urinal_count: sp.urinalCount } }));
  broadcastStalls(sp.id);
  broadcastUsers(sp.id);
  broadcastLeaderboard(sp.id);
  if (u) sendToUser(u.id, { type: 'stats', stats: getStats(u) });
}

// ============ WebSocket 处理 ============
wss.on('connection', (ws) => {
  ws._userId = null;
  ws._ns = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // 加入空间（连接后第一件事；切换空间也走这里）
    if (msg.type === 'join') { joinSpace(ws, msg.spaceId); return; }

    const space = ws._ns ? spaces.get(ws._ns) : null;

    // --- 登录（必须在已 join 空间后；支持账号+密码，或凭 token 恢复会话） ---
    if (msg.type === 'login') {
      if (!space) return ws.send(JSON.stringify({ type: 'error', message: '请先选择厕所空间' }));
      let account = null;
      if (msg.token) {
        const tok = tokens.get(msg.token);
        if (tok && tok.expiresAt > Date.now()) account = tok.account;
        if (!account) return ws.send(JSON.stringify({ type: 'error', message: '登录已过期，请重新登录' }));
      } else {
        account = (msg.account || '').trim();
        const password = (msg.password || '');
        if (!account || !password) return ws.send(JSON.stringify({ type: 'error', message: '请输入账号和密码' }));
        const acct = accountByLogin(account);
        if (!acct) return ws.send(JSON.stringify({ type: 'error', message: '账号不存在，请先注册' }));
        if (!verifyPassword(password, acct.passwordHash)) return ws.send(JSON.stringify({ type: 'error', message: '账号或密码错误' }));
        account = acct.account;
      }
      const acct = accounts.get(account);
      const nickname = acct.username;
      const avatar = acct.avatar || '🧑';
      const userId = 'u' + Date.now() + Math.random().toString(36).slice(2, 6);
      const token = issueToken(account);
      const user = {
        id: userId, account, token, nickname, avatar, currentSpace: space.id,
        stats: { totalVisits: 0, totalDuration: 0, favoriteStall: null, onTimeRate: 0, consecutiveOnTime: 0, maxDuration: 0, nightVisits: 0, grabSuccess: 0, ratingsGiven: 0 },
        achievements: [], currentStall: null, emergencyMode: false, wasOnTime: true,
      };
      users.set(userId, user);
      // 恢复该空间下此账号的历史战绩（账号全局唯一，避免重名用户之间互相覆盖）
      const pk = space.id + '::' + account;
      if (profiles.has(pk)) {
        const p = profiles.get(pk);
        user.stats = { ...user.stats, ...(p.stats || {}) };
        user.achievements = [...(p.achievements || [])];
        if (p.avatar) user.avatar = p.avatar;
      }
      profiles.set(pk, { account, nick: nickname, avatar: user.avatar, stats: { ...user.stats }, achievements: [...user.achievements] });
      ws._userId = userId;
      user.ws = ws;
      const selfInfo = spaceInfo(space.id).get(account) || {};
      ws.send(JSON.stringify({ type: 'loginSuccess', userId, account, nickname, display: selfInfo.display || nickname, dup: !!selfInfo.dup, avatar, token }));
      broadcastStalls(space.id);
      broadcastUsers(space.id);
      broadcastLeaderboard(space.id);
      sendToUser(userId, { type: 'stats', stats: getStats(user) });
      return;
    }

    // --- 退出登录：吊销 token ---
    if (msg.type === 'logout') {
      const lg = users.get(ws._userId);
      if (lg && lg.token) tokens.delete(lg.token);
      return;
    }

    const user = users.get(ws._userId);
    if (!user) return ws.send(JSON.stringify({ type: 'error', message: '请先登录' }));
    const s = space; // 当前所在空间
    if (!s) return ws.send(JSON.stringify({ type: 'error', message: '请先选择厕所空间' }));

    const stall = s.stalls.find((x) => x.id === msg.stallId);

    // --- 预约 ---
    if (msg.type === 'reserve') {
      if (!stall) return ws.send(JSON.stringify({ type: 'error', message: '坑位不存在' }));
      if (stall.status !== 'free') return ws.send(JSON.stringify({ type: 'error', message: '该坑位已被占用' }));
      if (activeStallCount(s, user) >= 1) return ws.send(JSON.stringify({ type: 'error', message: '你已占着一个坑位，一次只能用一个，先释放或取消再去下一个' }));
      const durOpts = stall.type === 'urinal' ? [1, 2, 5] : [15, 30, 45];
      const duration = durOpts.includes(msg.duration) ? msg.duration : durOpts[0];
      const startTime = Date.now() + 60000;
      const endTime = startTime + duration * 60000;
      const reservationId = 'r' + Date.now();
      stall.reservation = { userId: user.id, account: user.account, nickname: user.nickname, startTime, endTime, duration, reservationId };
      stall.status = 'reserved';
      const reservation = { id: reservationId, userId: user.id, nickname: user.nickname, stallId: stall.id, startTime, endTime, duration, status: 'pending' };
      s.reservations.set(reservationId, reservation);
      ws.send(JSON.stringify({ type: 'reservation', reservation }));
      broadcastStalls(s.id);
      return;
    }

    // --- 取消预约 ---
    if (msg.type === 'cancel') {
      const reservation = s.reservations.get(msg.reservationId);
      if (!reservation || reservation.userId !== user.id) return ws.send(JSON.stringify({ type: 'error', message: '预约不存在' }));
      const st = s.stalls.find((x) => x.id === reservation.stallId);
      if (st) { st.status = 'free'; st.reservation = null; }
      reservation.status = 'cancelled';
      s.reservations.delete(msg.reservationId);
      ws.send(JSON.stringify({ type: 'cancelSuccess', reservationId: msg.reservationId }));
      broadcastStalls(s.id);
      return;
    }

    // --- 临时抢位 ---
    if (msg.type === 'grab') {
      if (!stall) return ws.send(JSON.stringify({ type: 'error', message: '坑位不存在' }));
      if (stall.status !== 'free') return ws.send(JSON.stringify({ type: 'error', message: '手慢了，已被抢' }));
      if (activeStallCount(s, user) >= 1) return ws.send(JSON.stringify({ type: 'error', message: '你已占着一个坑位，一次只能用一个，先释放或取消再去下一个' }));
      stall.status = 'occupied';
      stall.currentUser = user.account;
      const gmin = stall.type === 'urinal' ? 1 : 5;
      stall.reservation = { userId: user.id, account: user.account, nickname: user.nickname, startTime: Date.now(), endTime: Date.now() + gmin * 60000, duration: gmin, reservationId: 'g' + Date.now(), isGrab: true };
      user.currentStall = stall.id;
      user.stats.grabSuccess++;
      user.stats.totalVisits++;
      checkAchievements(user);
      saveProfile(user);
      broadcastStalls(s.id);
      broadcastLeaderboard(s.id);
      sendToUser(user.id, { type: 'stats', stats: getStats(user) });
      return;
    }

    // --- 确认到坑（开始使用） ---
    if (msg.type === 'startUse') {
      if (!stall || !stall.reservation) return ws.send(JSON.stringify({ type: 'error', message: '无有效预约' }));
      if (stall.reservation.userId !== user.id) return ws.send(JSON.stringify({ type: 'error', message: '这不是你的预约' }));
      if (stall.status === 'occupied') return ws.send(JSON.stringify({ type: 'error', message: '坑位正在使用中' }));
      // 仅允许在"确认到坑"时间窗内开始使用：开始时间前拒绝，超窗未确认则预约已过期
      if (Date.now() < stall.reservation.startTime) {
        return ws.send(JSON.stringify({ type: 'error', message: '尚未到预约时间，请到点后再确认到坑' }));
      }
      if (Date.now() > stall.reservation.startTime + RESERVE_CONFIRM_WINDOW_MS) {
        return ws.send(JSON.stringify({ type: 'error', message: '预约已过期，未在规定时间内确认到坑' }));
      }
      stall.status = 'occupied';
      stall.currentUser = user.account;
      if (stall.reservation.reservationId) {
        const r = s.reservations.get(stall.reservation.reservationId);
        if (r) r.status = 'active';
      }
      user.currentStall = stall.id;
      user.wasOnTime = true;
      broadcastStalls(s.id);
      return;
    }

    // --- 完成使用 ---
    if (msg.type === 'finish') {
      if (!stall || !stall.reservation || stall.reservation.account !== user.account) return ws.send(JSON.stringify({ type: 'error', message: '只有当前使用者可操作' }));
      const duration = stall.reservation ? Math.round((Date.now() - stall.reservation.startTime) / 60000) : 0;
      user.stats.totalDuration += duration;
      user.stats.maxDuration = Math.max(user.stats.maxDuration, duration);
      if (user.stats.favoriteStall === null) user.stats.favoriteStall = stall.id;
      user.stats.totalVisits++;
      const hour = new Date().getHours();
      if (hour < 6 || hour >= 24) user.stats.nightVisits++;
      if (user.wasOnTime) user.stats.consecutiveOnTime++;
      else user.stats.consecutiveOnTime = 0;
      user.stats.onTimeRate = user.stats.totalVisits > 0 ? 1 : 0;
      if (stall.reservation && stall.reservation.reservationId) {
        const r = s.reservations.get(stall.reservation.reservationId);
        if (r) { r.status = 'completed'; s.reservations.delete(r.id); }
      }
      stall.status = 'free'; stall.currentUser = null; stall.reservation = null;
      user.currentStall = null; user.wasOnTime = true;
      s.urges.delete(stall.id);
      checkAchievements(user);
      broadcastTo(s.id, { type: 'stallReleased', stallId: stall.id });
      broadcastStalls(s.id);
      broadcastLeaderboard(s.id);
      sendToUser(user.id, { type: 'stats', stats: getStats(user) });
      saveProfile(user);
      return;
    }

    // --- 评分 ---
    if (msg.type === 'rate') {
      if (!stall) return ws.send(JSON.stringify({ type: 'error', message: '坑位不存在' }));
      const { cleanliness, signal, paper } = msg;
      if (!cleanliness || !signal || !paper) return ws.send(JSON.stringify({ type: 'error', message: '请完成所有评分' }));
      stall.ratings.push({ userId: user.id, nickname: user.nickname, cleanliness, signal, paper, timestamp: Date.now() });
      user.stats.ratingsGiven++;
      checkAchievements(user);
      saveProfile(user);
      saveStallRating(s.id, stall.id, { nickname: user.nickname, cleanliness, signal, paper });
      broadcastStalls(s.id);
      sendToUser(user.id, { type: 'stats', stats: getStats(user) });
      return;
    }

    // --- 催促 ---
    if (msg.type === 'urge') {
      if (!stall || stall.status !== 'occupied') return ws.send(JSON.stringify({ type: 'error', message: '坑位空闲，无需催促' }));
      const count = (s.urges.get(stall.id) || 0) + 1;
      s.urges.set(stall.id, count);
      sendToUser(stall.reservation?.userId || '', { type: 'urgeNotification', stallId: stall.id, count });
      broadcastStalls(s.id);
      return;
    }

    // --- 紧急模式 ---
    if (msg.type === 'toggleEmergency') {
      user.emergencyMode = !!msg.enabled;
      ws.send(JSON.stringify({ type: 'emergencyToggled', enabled: user.emergencyMode }));
      return;
    }

    // --- 提前释放 ---
    if (msg.type === 'release') {
      if (!stall || stall.status !== 'occupied') return ws.send(JSON.stringify({ type: 'error', message: '坑位空闲' }));
      if (!stall.reservation || stall.reservation.account !== user.account) return ws.send(JSON.stringify({ type: 'error', message: '只有当前使用者可释放' }));
      const duration = stall.reservation ? Math.round((Date.now() - stall.reservation.startTime) / 60000) : 0;
      user.stats.totalDuration += duration;
      user.stats.totalVisits++;
      if (stall.reservation && stall.reservation.reservationId) {
        const r = s.reservations.get(stall.reservation.reservationId);
        if (r) { r.status = 'completed'; s.reservations.delete(r.id); }
      }
      stall.status = 'free'; stall.currentUser = null; stall.reservation = null;
      user.currentStall = null;
      s.urges.delete(stall.id);
      broadcastTo(s.id, { type: 'stallReleased', stallId: stall.id });
      broadcastStalls(s.id);
      broadcastLeaderboard(s.id);
      sendToUser(user.id, { type: 'stats', stats: getStats(user) });
      saveProfile(user);
      return;
    }

    // --- 获取统计 ---
    if (msg.type === 'getStats') {
      sendToUser(user.id, { type: 'stats', stats: getStats(user) });
      return;
    }
  });

  ws.on('close', () => {
    if (ws._ns && spaces.get(ws._ns)) spaces.get(ws._ns).clients.delete(ws);
    if (ws._userId) {
      const user = users.get(ws._userId);
      if (user) {
        saveProfile(user);
        const sp = user.currentSpace ? spaces.get(user.currentSpace) : null;
        if (sp && user.currentStall) {
          const stall = sp.stalls.find((x) => x.id === user.currentStall);
          if (stall) { stall.status = 'free'; stall.currentUser = null; stall.reservation = null; user.currentStall = null; }
        }
        users.delete(ws._userId);
        if (sp) { broadcastStalls(sp.id); broadcastUsers(sp.id); broadcastLeaderboard(sp.id); }
      }
    }
  });
});

// ============ 定时器：过期释放（按空间） ============
setInterval(() => {
  const now = Date.now();
  for (const sp of spaces.values()) {
    // 1) 未到坑的预约：超时未确认则释放
    for (const [rid, r] of sp.reservations) {
      if (r.status === 'pending' && now > r.startTime + RESERVE_CONFIRM_WINDOW_MS) {
        r.status = 'expired';
        const stall = sp.stalls.find((x) => x.id === r.stallId);
        if (stall && stall.reservation && stall.reservation.reservationId === rid) {
          stall.status = 'free'; stall.reservation = null;
          broadcastTo(sp.id, { type: 'reservationExpired', stallId: stall.id });
          broadcastTo(sp.id, { type: 'stallReleased', stallId: stall.id });
          broadcastStalls(sp.id);
        }
        const user = users.get(r.userId);
        if (user) { user.wasOnTime = false; user.stats.consecutiveOnTime = 0; }
      }
      if (r.status === 'pending' && now >= r.startTime && now < r.startTime + RESERVE_CONFIRM_WINDOW_MS) {
        const stall = sp.stalls.find((x) => x.id === r.stallId);
        if (stall && stall.status === 'reserved') stall.status = 'waiting';
      }
    }
    // 2) 已在使用的坑位：超过预定结束时间则自动释放（抢位倒计时 / 预约时段到期）
    for (const stall of sp.stalls) {
      if (stall.status !== 'occupied' || !stall.reservation) continue;
      if (now < (stall.reservation.endTime || 0)) continue;
      const user = users.get(stall.reservation.userId);
      if (user) {
        const duration = Math.max(0, Math.round((now - (stall.reservation.startTime || now)) / 60000));
        user.stats.totalDuration += duration;
        user.stats.maxDuration = Math.max(user.stats.maxDuration, duration);
        user.stats.totalVisits++;
        if (user.wasOnTime) user.stats.consecutiveOnTime++; else user.stats.consecutiveOnTime = 0;
        user.stats.onTimeRate = user.stats.totalVisits > 0 ? 1 : 0;
        checkAchievements(user);
        saveProfile(user);
        user.currentStall = null;
      }
      if (stall.reservation.reservationId) sp.reservations.delete(stall.reservation.reservationId);
      stall.status = 'free'; stall.currentUser = null; stall.reservation = null;
      sp.urges.delete(stall.id);
      broadcastTo(sp.id, { type: 'autoRelease', stallId: stall.id });
      broadcastTo(sp.id, { type: 'stallReleased', stallId: stall.id });
      broadcastStalls(sp.id);
      broadcastLeaderboard(sp.id);
      if (user) sendToUser(user.id, { type: 'stats', stats: getStats(user) });
    }
  }
}, 15000);

// ============ 启动 ============
const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`卫生间坑位预约系统运行在 http://localhost:${PORT}`);
      console.log(`PostgreSQL 已连接；已载入 ${spaces.size} 个空间，${profiles.size} 份历史战绩`);
    });
  })
  .catch((err) => {
    console.error('❌ 无法连接 PostgreSQL，仅以内存运行:', err.message);
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`卫生间坑位预约系统运行在 http://localhost:${PORT}（内存模式）`);
    });
  });

module.exports = { app, server, spaces, users, ACHIEVEMENT_DEFS };