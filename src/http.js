'use strict';
// HTTP 路由：/api/spaces GET/POST、/api/register
module.exports = function httpApi(api, app) {
  const { spaces, accounts, genSpaceId, createSpace, saveSpace, saveAccount, hashPassword } = api;

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
};