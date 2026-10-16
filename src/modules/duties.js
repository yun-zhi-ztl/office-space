'use strict';
// 值班/值日排班模块：dutyAssign(管理员) / dutyComplete(值班人或管理员) / dutySwap(值班人) / dutyCancel(值班人或管理员)
// 值班按日期排班，支持环境/接待/值班等类别，完成后累计「值日达人」成就与后勤统计。
module.exports = function dutiesModule(api) {
  const { DUTY_CATEGORIES, spaceUserInfo, sendTo, serError, genId, saveEntity, deleteEntity, isAdmin, getUserByAccount, sendToUser, sendToAccount, dutyBroadcast, todayKey, checkAchievements, recordWeekly, pushNotice } = api;

  function dutiesBroadcast(space) { dutyBroadcast(space); }

  function validDate(date) {
    return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(date + 'T00:00:00').getTime());
  }
  function handleDuties(ws, user, space, msg) {
    const info = spaceUserInfo(space.id);
    if (msg.type === 'dutyAssign') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可安排值班'));
      const date = (msg.date || '').trim();
      const account = (msg.account || '').trim();
      const category = DUTY_CATEGORIES.includes(msg.category) ? msg.category : '其它';
      const note = (msg.note || '').trim().slice(0, 80);
      if (!validDate(date)) return sendTo(ws, serError('请选择合法日期'));
      if (!info.has(account)) return sendTo(ws, serError('成员不存在'));
      const exists = [...space.duties.values()].find((r) => r.date === date && r.account === account);
      if (exists) return sendTo(ws, serError('该成员当日已有值班'));
      const target = getUserByAccount(account);
      const duty = { id: genId('du', null), date, account, name: target ? target.nickname : '', category, note, status: 'assigned', createdAt: Date.now(), completedAt: null, reminderAt: null };
      space.duties.set(duty.id, duty);
      saveEntity(space.id, 'duty', duty.id, duty);
      dutyBroadcast(space);
      sendToUser(target ? target.id : null, { type: 'dutyAssigned', dutyId: duty.id, date, category });
      pushNotice(space, `🛎️ 值班安排：${duty.name || account} · ${date} · ${category}`, 'system', '系统');
      sendTo(ws, { type: 'dutyAssigned', dutyId: duty.id, date, category });
    } else if (msg.type === 'dutyComplete') {
      const duty = space.duties.get(msg.dutyId);
      if (!duty) return sendTo(ws, serError('值班记录不存在'));
      if (duty.status !== 'assigned') return sendTo(ws, serError('该值班已处理'));
      if (duty.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能完成自己的值班'));
      duty.status = 'completed';
      duty.completedAt = Date.now();
      saveEntity(space.id, 'duty', duty.id, duty);
      const who = getUserByAccount(duty.account);
      if (who) {
        who.stats.dutyCount = (who.stats.dutyCount || 0) + 1;
        who.stats.helperCount = (who.stats.helperCount || 0) + 1;
        recordWeekly(who, 'duties');
        checkAchievements(who);
        api.saveProfile(who);
        sendToUser(who.id, { type: 'stats', stats: who.stats, achievements: who.achievements });
      }
      dutyBroadcast(space);
      pushNotice(space, `✅ 值班已完成：${duty.name || duty.account} · ${duty.date} · ${duty.category}`, duty.account, '');
      sendTo(ws, { type: 'dutyCompleted', dutyId: duty.id });
    } else if (msg.type === 'dutySwap') {
      const duty = space.duties.get(msg.dutyId);
      if (!duty) return sendTo(ws, serError('值班记录不存在'));
      if (duty.status !== 'assigned') return sendTo(ws, serError('该值班已处理，无法调换'));
      if (duty.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能调换自己的值班'));
      const target = (msg.account || '').trim();
      if (!info.has(target)) return sendTo(ws, serError('目标成员不存在'));
      if (target === duty.account) return sendTo(ws, serError('不能调换给自己'));
      const swappedName = target === user.account ? (user.nickname || user.account) : (info.get(target) ? info.get(target).display : target);
      duty.account = target;
      duty.name = swappedName;
      saveEntity(space.id, 'duty', duty.id, duty);
      dutyBroadcast(space);
      sendToUser(getUserByAccount(target) ? getUserByAccount(target).id : null, { type: 'dutySwapped', dutyId: duty.id, date: duty.date, category: duty.category });
      sendTo(ws, { type: 'dutySwapped', dutyId: duty.id });
    } else if (msg.type === 'dutyCancel') {
      const duty = space.duties.get(msg.dutyId);
      if (!duty) return sendTo(ws, serError('值班记录不存在'));
      if (duty.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能取消自己的值班'));
      space.duties.delete(duty.id);
      deleteEntity(space.id, 'duty', duty.id);
      dutyBroadcast(space);
      sendTo(ws, { type: 'dutyCancelled', dutyId: duty.id });
    }
  }

  return { handleDuties, dutiesBroadcast };
};
