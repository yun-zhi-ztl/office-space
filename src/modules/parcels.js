'use strict';
// 包裹 / 快递管理：parcelCreate / parcelPick / parcelReturn / parcelCancel / parcelRemind
// 管理员登记到柜包裹，成员领取自己的包裹；逾期未取可一次性提醒。
module.exports = function parcelsModule(api) {
  const { parcelsPublic, parcelStats, parcelsBroadcast, broadcast, isAdmin, sendTo, serError, genId, saveEntity, pushNotification, sendToAccount } = api;

  function handleParcels(ws, user, space, msg) {
    if (msg.type === 'parcelCreate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可登记包裹'));
      const info = api.spaceUserInfo(space.id);
      const recipient = info.get(msg.recipientAccount);
      if (!recipient) return sendTo(ws, serError('收件人不在当前空间'));
      const courier = (msg.courier || '').trim().slice(0, 30);
      if (!courier) return sendTo(ws, serError('请输入快递公司'));
      const now = Date.now();
      const parcel = { id: genId('pc', null), recipientAccount: msg.recipientAccount, courier, trackingNumber: (msg.trackingNumber || '').trim().slice(0, 40), remark: (msg.remark || '').trim().slice(0, 100), status: 'incoming', expectedAt: Math.floor(+msg.expectedAt || 0), pickedAt: 0, returnedAt: 0, createdAt: now, lastRemindedAt: 0 };
      space.parcels.set(parcel.id, parcel);
      saveEntity(space.id, 'parcel', parcel.id, parcel);
      parcelsBroadcast(space);
      pushNotification(space, { type: 'parcelArrived', level: 'info', title: '包裹已登记', body: courier + (parcel.trackingNumber ? ' · ' + parcel.trackingNumber : '') });
      sendToAccount(parcel.recipientAccount, { type: 'parcelArrived', parcelId: parcel.id, courier, trackingNumber: parcel.trackingNumber });
    } else if (msg.type === 'parcelPick') {
      const parcel = space.parcels.get(msg.id);
      if (!parcel) return sendTo(ws, serError('包裹不存在'));
      if (parcel.status !== 'incoming') return sendTo(ws, serError('该包裹已处理'));
      if (parcel.recipientAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能领取自己的包裹'));
      parcel.status = 'picked';
      parcel.pickedAt = Date.now();
      saveEntity(space.id, 'parcel', parcel.id, parcel);
      parcelsBroadcast(space);
      sendToAccount(parcel.recipientAccount, { type: 'parcelPicked', parcelId: parcel.id });
    } else if (msg.type === 'parcelReturn') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可标记退回'));
      const parcel = space.parcels.get(msg.id);
      if (!parcel) return sendTo(ws, serError('包裹不存在'));
      if (parcel.status !== 'incoming') return sendTo(ws, serError('该包裹已处理'));
      parcel.status = 'returned';
      parcel.returnedAt = Date.now();
      saveEntity(space.id, 'parcel', parcel.id, parcel);
      parcelsBroadcast(space);
      sendToAccount(parcel.recipientAccount, { type: 'parcelReturned', parcelId: parcel.id });
    } else if (msg.type === 'parcelCancel') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可取消包裹'));
      const parcel = space.parcels.get(msg.id);
      if (!parcel) return sendTo(ws, serError('包裹不存在'));
      if (parcel.status !== 'incoming') return sendTo(ws, serError('该包裹已处理'));
      parcel.status = 'cancelled';
      saveEntity(space.id, 'parcel', parcel.id, parcel);
      parcelsBroadcast(space);
    } else if (msg.type === 'parcelRemind') {
      const now = Date.now();
      const overdue = [...space.parcels.values()].filter((p) => p.status === 'incoming' && p.expectedAt && p.expectedAt < now && !p.lastRemindedAt);
      if (!overdue.length) return sendTo(ws, serError('暂无逾期未取的包裹'));
      for (const p of overdue) { p.lastRemindedAt = now; saveEntity(space.id, 'parcel', p.id, p); sendToAccount(p.recipientAccount, { type: 'parcelOverdueReminder', parcelId: p.id }); }
      parcelsBroadcast(space);
      sendTo(ws, { type: 'parcelRemindSent', count: overdue.length });
    }
  }

  return { handleParcels };
};
