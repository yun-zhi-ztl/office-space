'use strict';
// 通知中心模块：notificationRead（标记单条已读）/ notificationReadAll（全部已读）
// 通知流由 pushNotification 写入，本模块只处理「已读」状态，按人隔离。
module.exports = function notificationsModule(api) {
  const { sendTo, serError, saveEntity, notificationsBroadcast } = api;

  function handleNotifications(ws, user, space, msg) {
    if (msg.type === 'notificationRead') {
      const n = space.notifications.get(msg.notificationId);
      if (!n) return sendTo(ws, serError('通知不存在'));
      n.readBy = n.readBy || {};
      n.readBy[user.account] = true;
      saveEntity(space.id, 'notification', n.id, n);
      notificationsBroadcast(space);
      sendTo(ws, { type: 'notificationRead', notificationId: n.id });
    } else if (msg.type === 'notificationReadAll') {
      const now = Date.now();
      for (const [id, n] of space.notifications) {
        n.readBy = n.readBy || {};
        if (n.readBy[user.account] !== true) {
          n.readBy[user.account] = true;
          saveEntity(space.id, 'notification', id, n);
        }
      }
      notificationsBroadcast(space);
      sendTo(ws, { type: 'notificationReadAll', ts: now });
    }
  }

  return { handleNotifications };
};
