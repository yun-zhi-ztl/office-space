'use strict';
// 储物柜 / 寄存：lockerCreate / lockerDelete / lockerReserve / lockerCancel /
// lockerCheckin / lockerCheckout / lockerRemind
// 管理员维护柜位，成员预约 / 签到 / 签退，逾期可一次性提醒。
module.exports = function lockersModule(api) {
  const { lockersPublic, lockerStats, lockersBroadcast, broadcast, isAdmin, sendTo, serError, genId, saveEntity, deleteEntity, pushNotification, sendToAccount, LOCKER_TYPES } = api;

  function handleLockers(ws, user, space, msg) {
    if (msg.type === 'lockerCreate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可新增储物柜'));
      const name = (msg.name || '').trim().slice(0, 30);
      if (!name) return sendTo(ws, serError('请输入柜位名称'));
      const total = parseInt(msg.total, 10);
      if (!Number.isInteger(total) || total < 1) return sendTo(ws, serError('请输入有效数量'));
      const locker = { id: genId('lk', null), name, type: LOCKER_TYPES.includes(msg.lockerType) ? msg.lockerType : 'regular', total, available: total, location: (msg.location || '').trim().slice(0, 40), note: (msg.note || '').trim().slice(0, 120) };
      space.lockers.push(locker);
      saveEntity(space.id, 'locker', locker.id, locker);
      lockersBroadcast(space);
    } else if (msg.type === 'lockerDelete') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除储物柜'));
      const idx = space.lockers.findIndex((l) => l.id === msg.id);
      if (idx < 0) return sendTo(ws, serError('储物柜不存在'));
      const locker = space.lockers[idx];
      const hasActive = [...space.lockerReservations.values()].some((r) => r.lockerId === locker.id && (r.status === 'reserved' || r.status === 'checked_in'));
      if (hasActive) return sendTo(ws, serError('该储物柜仍有预约或已签到，无法删除'));
      space.lockers.splice(idx, 1);
      deleteEntity(space.id, 'locker', locker.id);
      lockersBroadcast(space);
    } else if (msg.type === 'lockerReserve') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可预约储物柜'));
      const locker = space.lockers.find((l) => l.id === msg.lockerId);
      if (!locker) return sendTo(ws, serError('储物柜不存在'));
      if (locker.available < 1) return sendTo(ws, serError('该储物柜已满'));
      const dueAt = Math.floor(+msg.dueAt || 0);
      const res = { id: genId('lr', null), lockerId: locker.id, account: user.account, status: 'reserved', createdAt: Date.now(), checkedInAt: 0, checkedOutAt: 0, dueAt, returnedAt: 0, lastRemindedAt: 0 };
      locker.available -= 1;
      space.lockerReservations.set(res.id, res);
      saveEntity(space.id, 'locker', locker.id, locker);
      saveEntity(space.id, 'locker_reservation', res.id, res);
      lockersBroadcast(space);
    } else if (msg.type === 'lockerCancel') {
      const res = space.lockerReservations.get(msg.id);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能取消自己的预约'));
      if (res.status !== 'reserved') return sendTo(ws, serError('仅待签到的预约可取消'));
      res.status = 'cancelled';
      const locker = space.lockers.find((l) => l.id === res.lockerId);
      if (locker) { locker.available += 1; saveEntity(space.id, 'locker', locker.id, locker); }
      saveEntity(space.id, 'locker_reservation', res.id, res);
      lockersBroadcast(space);
    } else if (msg.type === 'lockerCheckin') {
      const res = space.lockerReservations.get(msg.id);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能签到自己的预约'));
      if (res.status !== 'reserved') return sendTo(ws, serError('该预约状态不可签到'));
      res.status = 'checked_in';
      res.checkedInAt = Date.now();
      saveEntity(space.id, 'locker_reservation', res.id, res);
      lockersBroadcast(space);
    } else if (msg.type === 'lockerCheckout') {
      const res = space.lockerReservations.get(msg.id);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能签退自己的预约'));
      if (res.status !== 'checked_in') return sendTo(ws, serError('该预约状态不可签退'));
      res.status = 'checked_out';
      res.checkedOutAt = Date.now();
      const locker = space.lockers.find((l) => l.id === res.lockerId);
      if (locker) { locker.available += 1; saveEntity(space.id, 'locker', locker.id, locker); }
      saveEntity(space.id, 'locker_reservation', res.id, res);
      lockersBroadcast(space);
    } else if (msg.type === 'lockerRemind') {
      const now = Date.now();
      const overdue = [...space.lockerReservations.values()].filter((r) => (r.status === 'reserved' || r.status === 'checked_in') && r.dueAt && r.dueAt < now && !r.lastRemindedAt);
      if (!overdue.length) return sendTo(ws, serError('暂无逾期未处理的储物柜预约'));
      for (const r of overdue) { r.lastRemindedAt = now; saveEntity(space.id, 'locker_reservation', r.id, r); sendToAccount(r.account, { type: 'lockerOverdueReminder', reservationId: r.id }); }
      lockersBroadcast(space);
      sendTo(ws, { type: 'lockerRemindSent', count: overdue.length });
    }
  }

  return { handleLockers };
};
