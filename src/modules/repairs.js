'use strict';
// 报修模块：repairCreate / repairUpdate
module.exports = function repairsModule(api) {
  const { spaceUserInfo, repairsPublic, broadcast, LIST_PAGE, REPAIR_CATEGORIES, sendTo, serError, genId, saveEntity, saveProfile, recordWeekly, broadcastLeaderboard } = api;

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

  return { repairsBroadcast, handleRepairs };
};