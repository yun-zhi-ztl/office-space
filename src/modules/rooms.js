'use strict';
// 会议室模块：roomCreate / roomRemove / roomBook / reservationCancel / roomStart / roomEnd
module.exports = function roomsModule(api) {
  const { spaceUserInfo, roomReservationsPublic, roomPublic, broadcast, LIST_PAGE, isAdmin, sendTo, serError, genId, saveEntity, deleteEntity, recordWeekly } = api;

  function roomsBroadcast(space) {
    const reservations = roomReservationsPublic(space);
    broadcast(space.id, 'rooms', { rooms: space.rooms.map(roomPublic), reservations: reservations.slice(0, LIST_PAGE), reservationTotal: reservations.length });
  }

  function handleRooms(ws, user, space, msg) {
    const info = spaceUserInfo(space.id);
    if (msg.type === 'roomCreate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可新增会议室'));
      const name = (msg.name || '').trim().slice(0, 30);
      const capacity = parseInt(msg.capacity, 10);
      if (!name) return sendTo(ws, serError('请输入会议室名称'));
      if (!Number.isInteger(capacity) || capacity < 1) return sendTo(ws, serError('请输入有效容纳人数'));
      const room = { id: genId('rm', null), name, capacity, location: (msg.location || '').trim().slice(0, 40), description: (msg.description || '').trim().slice(0, 100) };
      space.rooms.push(room);
      saveEntity(space.id, 'room', room.id, room);
      roomsBroadcast(space);
    } else if (msg.type === 'roomRemove') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除会议室'));
      const idx = space.rooms.findIndex((r) => r.id === msg.roomId);
      if (idx < 0) return sendTo(ws, serError('会议室不存在'));
      const room = space.rooms[idx];
      const hasActive = [...space.roomReservations.values()].some((r) => r.roomId === room.id && (r.status === 'pending' || r.status === 'active'));
      if (hasActive) return sendTo(ws, serError('该会议室仍有进行/待开始的预约，无法删除'));
      space.rooms.splice(idx, 1);
      for (const r of [...space.roomReservations.values()]) if (r.roomId === room.id) { space.roomReservations.delete(r.id); deleteEntity(space.id, 'room_reservation', r.id); }
      deleteEntity(space.id, 'room', room.id);
      roomsBroadcast(space);
    } else if (msg.type === 'roomBook') {
      const room = space.rooms.find((r) => r.id === msg.roomId);
      if (!room) return sendTo(ws, serError('会议室不存在'));
      const startAt = Math.floor(+msg.startAt || 0);
      const endAt = Math.floor(+msg.endAt || 0);
      if (!(startAt > 0) || !(endAt > startAt)) return sendTo(ws, serError('请选择有效的时间段'));
      if (endAt - startAt < 5 * 60000) return sendTo(ws, serError('至少预约 5 分钟'));
      const clash = [...space.roomReservations.values()].some((r) => r.roomId === room.id && (r.status === 'pending' || r.status === 'active') && startAt < r.endAt && endAt > r.startAt);
      if (clash) return sendTo(ws, serError('该时段已被预约，请另选时间'));
      const res = { id: genId('res', null), roomId: room.id, ownerAccount: user.account, ownerName: user.nickname, title: (msg.title || '').trim().slice(0, 40) || '会议', startAt, endAt, note: (msg.note || '').trim().slice(0, 120), status: 'pending' };
      space.roomReservations.set(res.id, res);
      saveEntity(space.id, 'room_reservation', res.id, res);
      recordWeekly(user, 'meetings');
      roomsBroadcast(space);
    } else if (msg.type === 'reservationCancel') {
      const res = space.roomReservations.get(msg.reservationId);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.ownerAccount !== user.account) return sendTo(ws, serError('只能取消自己的预约'));
      if (res.status !== 'pending') return sendTo(ws, serError('该预约已不能取消'));
      res.status = 'cancelled';
      saveEntity(space.id, 'room_reservation', res.id, res);
      roomsBroadcast(space);
    } else if (msg.type === 'roomStart' || msg.type === 'roomEnd') {
      const res = space.roomReservations.get(msg.reservationId);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.ownerAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能操作自己的预约'));
      if (msg.type === 'roomStart' && res.status === 'pending' && res.startAt <= Date.now()) res.status = 'active';
      if (msg.type === 'roomEnd' && res.status === 'active') res.status = 'completed';
      saveEntity(space.id, 'room_reservation', res.id, res);
      roomsBroadcast(space);
    }
    void info;
  }

  return { roomsBroadcast, handleRooms };
};