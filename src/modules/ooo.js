'use strict';
// 外出登记模块：oooCreate / oooBack / oooCancel / oooRemove(admin)
module.exports = function oooModule(api) {
  const { oooBroadcast, OOO_CATEGORIES, sendTo, serError, genId, saveEntity, deleteEntity, isAdmin, sendToAccount, pushNotice, checkAchievements, saveProfile, recordWeekly } = api;

  function handleOoo(ws, user, space, msg) {
    if (msg.type === 'oooCreate') {
      // 外出登记不受暂停影响（个人状态），但避免已有外出中重复登记
      const existing = [...space.ooo.values()].find((r) => r.account === user.account && r.status === 'active');
      if (existing) return sendTo(ws, serError('你已有进行中的外出登记，请先返回或取消'));
      const category = OOO_CATEGORIES.includes(msg.category) ? msg.category : '外出';
      const reason = (msg.reason || '').trim().slice(0, 80);
      const expectedReturnAt = msg.expectedReturnAt ? parseInt(msg.expectedReturnAt, 10) : null;
      if (expectedReturnAt && expectedReturnAt < Date.now()) return sendTo(ws, serError('预计返回时间需晚于当前时间'));
      const rec = { id: genId('ooo', null), account: user.account, name: user.nickname, category, reason, startAt: Date.now(), expectedReturnAt, endAt: null, status: 'active', returnRemindedAt: 0 };
      space.ooo.set(rec.id, rec);
      user.stats.oooCount = (user.stats.oooCount || 0) + 1;
      user.prevStatus = user.status || { label: '在岗', emoji: '' };
      user.status = { label: category, emoji: category === '出差' ? '✈️' : category === '请假' ? '📅' : '🚶' };
      recordWeekly(user, 'ooo');
      checkAchievements(user);
      saveProfile(user);
      saveEntity(space.id, 'ooo', rec.id, rec);
      oooBroadcast(space);
      api.broadcastUsers(space);
      pushNotice(space, `🚶 ${user.nickname} 已登记${category}${reason ? '：' + reason : ''}${expectedReturnAt ? '，预计返回 ' + new Date(expectedReturnAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}`, user.account, user.nickname);
    } else if (msg.type === 'oooBack') {
      const rec = space.ooo.get(msg.oooId);
      if (!rec) return sendTo(ws, serError('外出记录不存在'));
      if (rec.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能确认自己的外出返回'));
      if (rec.status !== 'active') return sendTo(ws, serError('该外出记录已返回或已取消'));
      rec.status = 'back';
      rec.endAt = Date.now();
      saveEntity(space.id, 'ooo', rec.id, rec);
      if (user.prevStatus) { user.status = user.prevStatus; user.prevStatus = null; }
      api.broadcastUsers(space);
      oooBroadcast(space);
      sendToAccount(rec.account, { type: 'oooBacked', category: rec.category });
    } else if (msg.type === 'oooCancel') {
      const rec = space.ooo.get(msg.oooId);
      if (!rec) return sendTo(ws, serError('外出记录不存在'));
      if (rec.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能取消自己的外出登记'));
      if (rec.status !== 'active') return sendTo(ws, serError('该外出记录已返回或已取消'));
      rec.status = 'cancelled';
      saveEntity(space.id, 'ooo', rec.id, rec);
      if (user.prevStatus) { user.status = user.prevStatus; user.prevStatus = null; }
      api.broadcastUsers(space);
      oooBroadcast(space);
    } else if (msg.type === 'oooRemove') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除外出记录'));
      const rec = space.ooo.get(msg.oooId);
      if (!rec) return sendTo(ws, serError('外出记录不存在'));
      space.ooo.delete(rec.id);
      deleteEntity(space.id, 'ooo', rec.id);
      const owner = api.getUserByAccount(rec.account);
      if (owner && owner.status && owner.status.label === rec.category) { owner.status = owner.prevStatus || { label: '在岗', emoji: '' }; owner.prevStatus = null; }
      api.broadcastUsers(space);
      oooBroadcast(space);
    }
  }

  return { handleOoo, oooBroadcast };
};
