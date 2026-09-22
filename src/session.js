'use strict';
// 会话：joinSpace（进入/切换空间） + handleLogin（登录/恢复）
module.exports = function sessionApi(api) {
  const {
    spaces, users, accounts, tokens, sendTo, serError, sendToUser, isAdmin, saveSpace, saveStatsToSpace,
    applyProfileToUser, broadcastAll, accountByLogin, verifyPassword, issueToken, newStats, buildDigest,
  } = api;

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
    if (u && sp.admins.size === 0) { sp.admins.add(u.account); saveSpace(sp); }
    broadcastAll(sp);
  }

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
    const user = { id: userId, account, token, nickname: acct.username, avatar: acct.avatar || '🧑', currentSpace: space.id, ws, stats: newStats(), achievements: [], currentStall: null, emergencyMode: false, wasOnTime: true };
    applyProfileToUser(user, space.id);
    users.set(userId, user);
    ws._userId = userId;
    sendTo(ws, { type: 'loginSuccess', userId, account, nickname: user.nickname, avatar: user.avatar, token, role: isAdmin(space, account) ? 'admin' : 'member', spaceId: space.id });
    broadcastAll(space);
    sendToUser(userId, { type: 'digest', digest: buildDigest(space, user) });
  }

  return { joinSpace, handleLogin };
};