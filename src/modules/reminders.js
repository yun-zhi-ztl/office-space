'use strict';
// 备忘提醒模块：reminderCreate / reminderDelete / reminderToggle
// 创建一次性或每天/每周/每月重复的自定义提醒，到点由服务端周期任务自动推送给本人。
module.exports = function remindersModule(api) {
  const { spaceUserInfo, remindersPublic, isAdmin, sendTo, serError, genId, saveEntity, deleteEntity } = api;

  // 只给发起人刷新他自己的备忘列表（隐私：不广播给全员）
  function sendMine(userAccount, ws, space) {
    const info = spaceUserInfo(space.id);
    const list = remindersPublic(space, info).filter((r) => r.account === userAccount);
    api.sendTo(ws, { type: 'reminders', reminders: list });
  }

  function handleReminders(ws, user, space, msg) {
    if (msg.type === 'reminderCreate') {
      const text = (msg.text || '').trim().slice(0, 120);
      if (!text) return sendTo(ws, serError('请输入提醒内容'));
      const nextAt = Math.floor(+msg.nextAt || 0);
      if (!nextAt) return sendTo(ws, serError('请选择提醒时间'));
      const repeat = ['none', 'daily', 'weekly', 'monthly'].includes(msg.repeat) ? msg.repeat : 'none';
      const reminder = { id: genId('rm', null), account: user.account, text, nextAt, repeat, enabled: true, createdAt: Date.now(), lastRemindedAt: 0 };
      space.reminders.set(reminder.id, reminder);
      saveEntity(space.id, 'reminder', reminder.id, reminder);
      sendMine(user.account, ws, space);
    } else if (msg.type === 'reminderDelete') {
      const reminder = space.reminders.get(msg.id);
      if (!reminder) return sendTo(ws, serError('提醒不存在'));
      if (reminder.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能删除自己的提醒'));
      space.reminders.delete(reminder.id);
      deleteEntity(space.id, 'reminder', reminder.id);
      sendMine(user.account, ws, space);
    } else if (msg.type === 'reminderToggle') {
      const reminder = space.reminders.get(msg.id);
      if (!reminder) return sendTo(ws, serError('提醒不存在'));
      if (reminder.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能操作自己的提醒'));
      reminder.enabled = !reminder.enabled;
      saveEntity(space.id, 'reminder', reminder.id, reminder);
      sendMine(user.account, ws, space);
    }
  }

  return { handleReminders };
};