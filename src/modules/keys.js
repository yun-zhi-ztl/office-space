'use strict';
// 钥匙 / 门禁卡借用模块：keyCreate / keyDelete / keyUpdate / keyRequest / keyApprove / keyReject / keyReturn
// 与工具借用的区别：敏感钥匙（高安全级）需管理员审批后才能借用，
// 归还登记完好 / 损坏 / 丢失，丢失自动扣减库存并通知管理员。
module.exports = function keysModule(api) {
  const { spaceUserInfo, keysPublic, keysStats, keyRequestsPublic, broadcast, KEY_CATEGORIES, isAdmin, sendTo, serError, genId, saveEntity, deleteEntity, pushNotification, sendToAccount, getUserByAccount, sendToUser, checkAchievements, saveProfile, broadcastLeaderboard } = api;

  function keysBroadcast(space) {
    const info = spaceUserInfo(space.id);
    broadcast(space.id, 'keys', { keys: keysPublic(space, info), stats: keysStats(space), requests: keyRequestsPublic(space, info) });
  }

  function handleKeys(ws, user, space, msg) {
    if (msg.type === 'keyCreate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可新增钥匙'));
      const name = (msg.name || '').trim().slice(0, 30);
      if (!name) return sendTo(ws, serError('请输入钥匙名称'));
      const total = parseInt(msg.total, 10);
      if (!Number.isInteger(total) || total < 1) return sendTo(ws, serError('请输入有效数量'));
      const security = ['low', 'high'].includes(msg.security) ? msg.security : 'low';
      const category = KEY_CATEGORIES.includes(msg.category) ? msg.category : '其它';
      const key = { id: genId('k', null), name, category, security, total, available: total, location: (msg.location || '').trim().slice(0, 40), description: (msg.description || '').trim().slice(0, 100) };
      space.keys.push(key);
      saveEntity(space.id, 'key', key.id, key);
      keysBroadcast(space);
    } else if (msg.type === 'keyUpdate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可修改钥匙'));
      const key = space.keys.find((k) => k.id === msg.id);
      if (!key) return sendTo(ws, serError('钥匙不存在'));
      if (msg.name !== undefined) { const name = (msg.name || '').trim().slice(0, 30); if (name) key.name = name; }
      if (msg.security !== undefined && ['low', 'high'].includes(msg.security)) key.security = msg.security;
      if (msg.category !== undefined && KEY_CATEGORIES.includes(msg.category)) key.category = msg.category;
      if (msg.location !== undefined) key.location = (msg.location || '').trim().slice(0, 40);
      if (msg.description !== undefined) key.description = (msg.description || '').trim().slice(0, 100);
      saveEntity(space.id, 'key', key.id, key);
      keysBroadcast(space);
    } else if (msg.type === 'keyDelete') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除钥匙'));
      const idx = space.keys.findIndex((k) => k.id === msg.id);
      if (idx < 0) return sendTo(ws, serError('钥匙不存在'));
      const key = space.keys[idx];
      const hasActive = [...space.keyRequests.values()].some((r) => r.keyId === key.id && (r.status === 'borrowed' || r.status === 'pending'));
      if (hasActive) return sendTo(ws, serError('该钥匙仍有借用或待审批记录，无法删除'));
      space.keys.splice(idx, 1);
      deleteEntity(space.id, 'key', key.id);
      keysBroadcast(space);
    } else if (msg.type === 'keyRequest') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可借用钥匙'));
      const key = space.keys.find((k) => k.id === msg.keyId);
      if (!key) return sendTo(ws, serError('钥匙不存在'));
      const qty = parseInt(msg.qty, 10);
      if (!Number.isInteger(qty) || qty < 1) return sendTo(ws, serError('请输入有效数量'));
      if (qty > key.available) return sendTo(ws, serError('当前可用数量不足'));
      const needsApproval = key.security === 'high';
      if (!needsApproval) {
        // 低安全级直接借用
        key.available -= qty;
        const now = Date.now();
        const req = { id: genId('kr', null), keyId: key.id, account: user.account, qty, status: 'borrowed', securityCode: (msg.securityCode || '').trim().slice(0, 20), borrowedAt: now, dueAt: now + 3 * 86400000, returnedAt: null, condition: 'intact', approvedBy: null, approvedAt: null, createdAt: now };
        space.keyRequests.set(req.id, req);
        saveEntity(space.id, 'key', key.id, key);
        saveEntity(space.id, 'keyRequest', req.id, req);
        keysBroadcast(space);
        broadcastLeaderboard(space);
      } else {
        // 高安全级进入待审批
        const exists = [...space.keyRequests.values()].find((r) => r.keyId === key.id && r.account === user.account && r.status === 'pending');
        if (exists) return sendTo(ws, serError('该钥匙已提交申请，等待审批'));
        const req = { id: genId('kr', null), keyId: key.id, account: user.account, qty, status: 'pending', securityCode: (msg.securityCode || '').trim().slice(0, 20), borrowedAt: null, dueAt: null, returnedAt: null, condition: null, approvedBy: null, approvedAt: null, createdAt: Date.now() };
        space.keyRequests.set(req.id, req);
        saveEntity(space.id, 'keyRequest', req.id, req);
        keysBroadcast(space);
        for (const acc of space.admins) sendToAccount(acc, { type: 'keyRequest', keyId: key.id, keyName: key.name, account: user.account, qty });
      }
    } else if (msg.type === 'keyApprove') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可审批钥匙借用'));
      const req = space.keyRequests.get(msg.id);
      if (!req) return sendTo(ws, serError('申请不存在'));
      if (req.status !== 'pending') return sendTo(ws, serError('该申请已处理，无法重复审批'));
      const key = space.keys.find((k) => k.id === req.keyId);
      if (!key) return sendTo(ws, serError('钥匙不存在'));
      if (req.qty > key.available) return sendTo(ws, serError('当前可用数量不足，无法批准'));
      req.status = 'borrowed';
      req.approvedBy = user.account;
      req.approvedAt = Date.now();
      req.borrowedAt = Date.now();
      req.dueAt = Date.now() + 3 * 86400000;
      key.available -= req.qty;
      saveEntity(space.id, 'key', key.id, key);
      saveEntity(space.id, 'keyRequest', req.id, req);
      keysBroadcast(space);
      broadcastLeaderboard(space);
      const u = getUserByAccount(req.account);
      if (u) sendToUser(u.id, { type: 'keyApproved', keyId: key.id, keyName: key.name });
    } else if (msg.type === 'keyReject') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可驳回钥匙借用'));
      const req = space.keyRequests.get(msg.id);
      if (!req) return sendTo(ws, serError('申请不存在'));
      if (req.status !== 'pending') return sendTo(ws, serError('该申请已处理，无法驳回'));
      req.status = 'rejected';
      req.approvedBy = user.account;
      req.approvedAt = Date.now();
      saveEntity(space.id, 'keyRequest', req.id, req);
      keysBroadcast(space);
      const u = getUserByAccount(req.account);
      if (u) sendToUser(u.id, { type: 'keyRejected', keyId: req.keyId });
    } else if (msg.type === 'keyReturn') {
      const req = space.keyRequests.get(msg.id);
      if (!req) return sendTo(ws, serError('借用记录不存在'));
      if (req.status !== 'borrowed') return sendTo(ws, serError('该钥匙已归还'));
      if (req.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能归还自己的借用'));
      const key = space.keys.find((k) => k.id === req.keyId);
      if (!key) return sendTo(ws, serError('钥匙不存在'));
      const condition = ['intact', 'damaged', 'missing'].includes(msg.condition) ? msg.condition : 'intact';
      req.status = 'returned';
      req.returnedAt = Date.now();
      req.condition = condition;
      if (condition === 'missing') {
        key.total = Math.max(0, key.total - req.qty);
        pushNotification(space, { type: 'keyMissing', level: 'warn', title: '钥匙丢失', body: key.name + ' ×' + req.qty });
      } else {
        key.available = Math.min(key.total, key.available + req.qty);
      }
      saveEntity(space.id, 'key', key.id, key);
      saveEntity(space.id, 'keyRequest', req.id, req);
      keysBroadcast(space);
    } else if (msg.type === 'remindKeyOverdue') {
      const now = Date.now();
      const overdue = [...space.keyRequests.values()].filter((r) => r.status === 'borrowed' && r.dueAt && r.dueAt < now && !r.lastRemindedAt);
      if (!overdue.length) return sendTo(ws, serError('暂无逾期未还的钥匙'));
      for (const r of overdue) { r.lastRemindedAt = now; saveEntity(space.id, 'keyRequest', r.id, r); sendToAccount(r.account, { type: 'keyOverdueReminder', keyRequestId: r.id }); }
      keysBroadcast(space);
      sendTo(ws, { type: 'remindKeyOverdueSent', count: overdue.length });
    }
  }

  return { keysBroadcast, handleKeys };
};
