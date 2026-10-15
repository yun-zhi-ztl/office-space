'use strict';
// 访客登记模块：visitorCreate / visitorArrived / visitorLeft / visitorCancel / visitorRemove / visitorCheckin
module.exports = function visitorsModule(api) {
  const { spaceUserInfo, visitorsPublic, broadcast, LIST_PAGE, isAdmin, sendTo, serError, genId, genCheckinCode, saveEntity, deleteEntity, sendToAccount } = api;

  function visitorsBroadcast(space) {
    const info = spaceUserInfo(space.id);
    const all = visitorsPublic(space, info);
    broadcast(space.id, 'visitors', { visitors: all.slice(0, LIST_PAGE), total: all.length });
  }

  function canManage(visitor, user, space) {
    return isAdmin(space, user.account) || visitor.hostAccount === user.account;
  }

  function handleVisitors(ws, user, space, msg) {
    if (msg.type === 'visitorCreate') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可登记访客'));
      const visitorName = (msg.visitorName || '').trim().slice(0, 20);
      const purpose = (msg.purpose || '').trim().slice(0, 30);
      const contact = (msg.contact || '').trim().slice(0, 30);
      const expectedAt = Math.floor(+msg.expectedAt || 0) || null;
      if (!visitorName || !purpose) return sendTo(ws, serError('请填写访客姓名和来访事由'));
      const visitor = {
        id: genId('vs', null),
        hostAccount: user.account,
        hostName: user.nickname,
        visitorName, purpose, contact, expectedAt,
        arrivedAt: null, leftAt: null, status: 'pending', createdAt: Date.now(),
        code: genCheckinCode(space),
      };
      space.visitors.set(visitor.id, visitor);
      saveEntity(space.id, 'visitor', visitor.id, visitor);
      visitorsBroadcast(space);
      sendTo(ws, { type: 'visitorCreated', visitorId: visitor.id, code: visitor.code });
    } else if (msg.type === 'visitorCheckin') {
      const code = (msg.code || '').trim().toUpperCase();
      if (!code) return sendTo(ws, serError('请输入签到码'));
      const visitor = [...space.visitors.values()].find((v) => v.code && v.code.toUpperCase() === code);
      if (!visitor) return sendTo(ws, serError('签到码不存在'));
      if (visitor.status !== 'pending') return sendTo(ws, serError('该访客已签到或状态已变更'));
      visitor.status = 'arrived';
      visitor.arrivedAt = Date.now();
      saveEntity(space.id, 'visitor', visitor.id, visitor);
      visitorsBroadcast(space);
      sendToAccount(visitor.hostAccount, { type: 'visitorCheckinNotification', visitorId: visitor.id, visitorName: visitor.visitorName, code: visitor.code });
      sendTo(ws, { type: 'visitorCheckedIn', visitorId: visitor.id, visitorName: visitor.visitorName });
    } else if (msg.type === 'visitorArrived') {
      const visitor = space.visitors.get(msg.visitorId);
      if (!visitor) return sendTo(ws, serError('访客记录不存在'));
      if (!canManage(visitor, user, space)) return sendTo(ws, serError('只能操作自己登记的访客'));
      if (visitor.status !== 'pending') return sendTo(ws, serError('该访客状态已变更'));
      visitor.status = 'arrived';
      visitor.arrivedAt = Date.now();
      saveEntity(space.id, 'visitor', visitor.id, visitor);
      visitorsBroadcast(space);
    } else if (msg.type === 'visitorLeft') {
      const visitor = space.visitors.get(msg.visitorId);
      if (!visitor) return sendTo(ws, serError('访客记录不存在'));
      if (!canManage(visitor, user, space)) return sendTo(ws, serError('只能操作自己登记的访客'));
      if (visitor.status !== 'arrived') return sendTo(ws, serError('该访客尚未到访'));
      visitor.status = 'left';
      visitor.leftAt = Date.now();
      saveEntity(space.id, 'visitor', visitor.id, visitor);
      visitorsBroadcast(space);
    } else if (msg.type === 'visitorCancel') {
      const visitor = space.visitors.get(msg.visitorId);
      if (!visitor) return sendTo(ws, serError('访客记录不存在'));
      if (!canManage(visitor, user, space)) return sendTo(ws, serError('只能取消自己登记的访客'));
      if (visitor.status !== 'pending') return sendTo(ws, serError('只有待到访的访客可以取消'));
      visitor.status = 'cancelled';
      saveEntity(space.id, 'visitor', visitor.id, visitor);
      visitorsBroadcast(space);
    } else if (msg.type === 'visitorRemove') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除访客记录'));
      const visitor = space.visitors.get(msg.visitorId);
      if (!visitor) return sendTo(ws, serError('访客记录不存在'));
      space.visitors.delete(visitor.id);
      deleteEntity(space.id, 'visitor', visitor.id);
      visitorsBroadcast(space);
    }
  }

  return { visitorsBroadcast, handleVisitors };
};
