'use strict';
// 报修模块：repairCreate / repairUpdate
module.exports = function repairsModule(api) {
  const { spaceUserInfo, repairsPublic, broadcast, LIST_PAGE, REPAIR_CATEGORIES, REPAIR_PRIORITIES, sendTo, serError, genId, saveEntity, saveProfile, recordWeekly, broadcastLeaderboard, getUserByAccount, sendToAccount, isAdmin } = api;

  function repairsBroadcast(space) {
    const info = spaceUserInfo(space.id);
    const all = repairsPublic(space, info);
    broadcast(space.id, 'repairs', { repairs: all.slice(0, LIST_PAGE), total: all.length });
  }

  function handleRepairs(ws, user, space, msg) {
    if (msg.type === 'repairCreate') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可报修'));
      const category = REPAIR_CATEGORIES.includes(msg.category) ? msg.category : '其它';
      const location = (msg.location || '').trim().slice(0, 40);
      const description = (msg.description || '').trim().slice(0, 160);
      const priority = REPAIR_PRIORITIES.includes(msg.priority) ? msg.priority : 'normal';
      if (!location || !description) return sendTo(ws, serError('请填写故障位置与描述'));
      const rep = { id: genId('rp', null), reporterAccount: user.account, reporterName: user.nickname, category, location, description, priority, status: 'reported', createdAt: Date.now(), updatedAt: Date.now() };
      space.repairs.set(rep.id, rep);
      user.stats.repairCount = (user.stats.repairCount || 0) + 1;
      recordWeekly(user, 'repairs');
      saveProfile(user);
      saveEntity(space.id, 'repair', rep.id, rep);
      repairsBroadcast(space);
      broadcastLeaderboard(space);
    } else if (msg.type === 'repairAssign') {
      const rep = space.repairs.get(msg.repairId);
      if (!rep) return sendTo(ws, serError('报修记录不存在'));
      const isReporter = rep.reporterAccount === user.account;
      if (!isReporter && !isAdmin(space, user.account)) return sendTo(ws, serError('仅上报人或管理员可指派负责人'));
      const account = (msg.handlerAccount || '').trim().slice(0, 40);
      if (!account) return sendTo(ws, serError('请选择负责人'));
      const target = getUserByAccount(account);
      if (!target || target.currentSpace !== space.id) return sendTo(ws, serError('负责人必须为空间内在线成员'));
      rep.handlerAccount = target.account;
      rep.handlerName = target.nickname;
      rep.updatedAt = Date.now();
      saveEntity(space.id, 'repair', rep.id, rep);
      sendToAccount(target.account, { type: 'repairAssigned', repairId: rep.id, category: rep.category, location: rep.location, reporterName: rep.reporterName });
      repairsBroadcast(space);
    } else if (msg.type === 'repairUpdate') {
      const rep = space.repairs.get(msg.repairId);
      if (!rep) return sendTo(ws, serError('报修记录不存在'));
      const to = msg.status;
      const from = rep.status;
      const isReporter = rep.reporterAccount === user.account;
      const isAdminUser = isAdmin(space, user.account);
      if (msg.priority !== undefined) {
        if (!REPAIR_PRIORITIES.includes(msg.priority)) return sendTo(ws, serError('无效的优先级'));
        if (!isReporter && !isAdminUser) return sendTo(ws, serError('仅上报人或管理员可调整优先级'));
        rep.priority = msg.priority;
      }
      if (to === undefined) {
        rep.updatedAt = Date.now();
        saveEntity(space.id, 'repair', rep.id, rep);
        repairsBroadcast(space);
        return;
      }
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
      if (to === 'in_progress') sendToAccount(rep.reporterAccount, { type: 'repairInProgress', repairId: rep.id, category: rep.category, location: rep.location });
      if (to === 'resolved') sendToAccount(rep.reporterAccount, { type: 'repairResolved', repairId: rep.id, category: rep.category, location: rep.location });
      repairsBroadcast(space);
    }
  }

  return { repairsBroadcast, handleRepairs };
};