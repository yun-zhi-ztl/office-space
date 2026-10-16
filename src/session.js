'use strict';
// 会话：joinSpace（进入/切换空间） + handleLogin（登录/恢复）
module.exports = function sessionApi(api) {
  const {
    spaces, users, accounts, tokens, sendTo, serError, sendToUser, isAdmin, saveSpace, saveStatsToSpace,
    applyProfileToUser, broadcastAll, accountByLogin, verifyPassword, issueToken, newStats, buildDigest,
    useInvite, ensureInvites,
  } = api;

  const loginFailures = new Map();
  const LOGIN_WINDOW_MS = 60 * 1000;
  const LOGIN_MAX_FAILURES = 5;
  function failureRecords(account) {
    const now = Date.now();
    const key = String(account || '').toLowerCase();
    const rows = (loginFailures.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    if (rows.length === 0) loginFailures.delete(key); else loginFailures.set(key, rows);
    return rows;
  }
  function loginAllowed(account) { return failureRecords(account).length < LOGIN_MAX_FAILURES; }
  function recordLoginFailure(account) {
    const key = String(account || '').toLowerCase();
    const rows = failureRecords(key);
    rows.push(Date.now());
    loginFailures.set(key, rows);
  }
  function clearLoginFailures(account) { loginFailures.delete(String(account || '').toLowerCase()); }

  function joinSpace(ws, spaceId, inviteCode) {
    const sp = spaces.get(String(spaceId));
    if (!sp) return sendTo(ws, serError('空间不存在'));
    if (!ensureInvites(sp)) ensureInvites(sp);
    if (sp.requireInvite) {
      const code = String(inviteCode || '').trim();
      if (!code) return sendTo(ws, serError('该空间需要邀请码'));
      const result = useInvite(sp, code, null);
      if (!result.ok) return sendTo(ws, serError(result.message || '邀请码无效'));
    } else if (String(inviteCode || '').trim()) {
      const result = useInvite(sp, String(inviteCode).trim(), null);
      if (!result.ok) return sendTo(ws, serError(result.message || '邀请码无效'));
    }
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
    sendTo(ws, { type: 'joined', space: { id: sp.id, name: sp.name, squat_count: sp.squatCount, urinal_count: sp.urinalCount, paused: sp.paused, pausedReason: sp.pausedReason || '', isAdmin: u ? isAdmin(sp, u.account) : false } });
    if (u && sp.admins.size === 0) { sp.admins.add(u.account); saveSpace(sp); }
    broadcastAll(sp);
  }

  function handleLogin(ws, msg, space) {
    let account = null;
    if (msg.token) {
      const tok = tokens.get(msg.token);
      if (tok && tok.expiresAt > Date.now()) { account = tok.account; clearLoginFailures(account); }
      if (!account) return sendTo(ws, serError('登录已过期，请重新登录'));
    } else {
      account = (msg.account || '').trim();
      const password = (msg.password || '');
      if (!account || !password) return sendTo(ws, serError('请输入账号和密码'));
      if (!loginAllowed(account)) return sendTo(ws, serError('登录失败次数过多，请稍后再试'));
      const acct = accountByLogin(account);
      if (!acct) { recordLoginFailure(account); return sendTo(ws, serError('账号不存在，请先注册')); }
      if (!verifyPassword(password, acct.passwordHash)) { recordLoginFailure(account); return sendTo(ws, serError('账号或密码错误')); }
      clearLoginFailures(account);
      account = acct.account;
    }
    const acct = accounts.get(account);
    if (!acct) return sendTo(ws, serError('账号不存在，请先注册'));
    const userId = 'u' + Date.now() + Math.random().toString(36).slice(2, 6);
    const token = issueToken(account);
    if (space.admins.size === 0) { space.admins.add(account); saveSpace(space); }
    const user = { id: userId, account, token, nickname: acct.username, avatar: acct.avatar || '🧑', currentSpace: space.id, ws, stats: newStats(), achievements: [], currentStall: null, emergencyMode: false, wasOnTime: true };
    applyProfileToUser(user, space.id);
    users.set(userId, user);
    ws._userId = userId;
    sendTo(ws, { type: 'loginSuccess', userId, account, nickname: user.nickname, avatar: user.avatar, token, role: isAdmin(space, account) ? 'admin' : 'member', spaceId: space.id, stats: user.stats, achievements: user.achievements });
    broadcastAll(space);
    sendToUser(userId, { type: 'digest', digest: buildDigest(space, user) });
  }

  return { joinSpace, handleLogin };
};