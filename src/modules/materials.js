'use strict';
// 物资申领模块：materialRequest / materialCancel / materialFulfill
module.exports = function materialsModule(api) {
  const { spaceUserInfo, materialsPublic, broadcast, LIST_PAGE, sendTo, serError, genId, saveEntity, saveProfile, recordWeekly, broadcastLeaderboard, getUserByAccount, sendToAccount, sendToUser, checkAchievements, isAdmin } = api;

  function materialsBroadcast(space) {
    const info = spaceUserInfo(space.id);
    const all = materialsPublic(space, info);
    broadcast(space.id, 'materials', { requests: all.slice(0, LIST_PAGE), total: all.length });
  }

  function handleMaterials(ws, user, space, msg) {
    if (msg.type === 'materialRequest') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可申领'));
      const name = (msg.name || '').trim().slice(0, 30);
      const qty = parseInt(msg.qty, 10);
      if (!name) return sendTo(ws, serError('请输入物资名称'));
      if (!Number.isInteger(qty) || qty < 1) return sendTo(ws, serError('请输入有效数量'));
      const req = { id: genId('mt', null), requesterAccount: user.account, requesterName: user.nickname, name, qty, unit: (msg.unit || '个').trim().slice(0, 10), reason: (msg.reason || '').trim().slice(0, 120), status: 'pending', createdAt: Date.now(), handledAt: null, slaRemindedAt: null };
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
    } else if (msg.type === 'materialAssign') {
      const req = space.materialRequests.get(msg.requestId);
      if (!req) return sendTo(ws, serError('申领记录不存在'));
      const isRequester = req.requesterAccount === user.account;
      if (!isRequester && !isAdmin(space, user.account)) return sendTo(ws, serError('仅申请人或管理员可指派负责人'));
      const account = (msg.handlerAccount || '').trim().slice(0, 40);
      if (!account) return sendTo(ws, serError('请选择负责人'));
      const target = getUserByAccount(account);
      if (!target || target.currentSpace !== space.id) return sendTo(ws, serError('负责人必须为空间内在线成员'));
      req.handlerAccount = target.account;
      req.handlerName = target.nickname;
      saveEntity(space.id, 'material', req.id, req);
      sendToAccount(target.account, { type: 'materialAssigned', requestId: req.id, name: req.name, requesterName: user.nickname });
      materialsBroadcast(space);
    } else if (msg.type === 'materialFulfill') {
      const req = space.materialRequests.get(msg.requestId);
      if (!req) return sendTo(ws, serError('申领记录不存在'));
      if (req.requesterAccount === user.account) return sendTo(ws, serError('不能处理自己的申领'));
      if (req.handlerAccount && req.handlerAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('该申领已指派，由负责人处理'));
      if (req.status !== 'pending') return sendTo(ws, serError('该申领已处理'));
      req.status = 'fulfilled';
      req.handledAt = Date.now();
      saveEntity(space.id, 'material', req.id, req);
      user.stats.helperCount = (user.stats.helperCount || 0) + 1;
      checkAchievements(user);
      saveProfile(user);
      sendToAccount(req.requesterAccount, { type: 'materialFulfilled', requestId: req.id, name: req.name });
      sendToUser(user.id, { type: 'stats', stats: user.stats, achievements: user.achievements });
      materialsBroadcast(space);
    }
  }

  return { materialsBroadcast, handleMaterials };
};