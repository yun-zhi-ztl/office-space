'use strict';
// 会议室模块：roomCreate / roomRemove / roomBook / roomWaitlist / roomWaitlistCancel
//               / reservationCancel / reservationCancelSeries / roomStart / roomEnd
module.exports = function roomsModule(api) {
  const { roomReservationsPublic, roomPublic, roomWaitlistPublic, broadcast, LIST_PAGE, isAdmin, sendTo, serError, genId, saveEntity, deleteEntity, recordWeekly, getUserByAccount, sendToUser, sendToAccount, saveProfile, broadcastLeaderboard, expandRecurring, roomStatsBroadcast, ROOM_REMIND_WINDOW_MS } = api;

  function roomsBroadcast(space) {
    const reservations = roomReservationsPublic(space);
    const waitlist = roomWaitlistPublic(space);
    broadcast(space.id, 'rooms', { rooms: space.rooms.map(roomPublic), reservations: reservations.slice(0, LIST_PAGE), reservationTotal: reservations.length, waitlist: waitlist.slice(0, LIST_PAGE), waitlistTotal: waitlist.length });
    roomStatsBroadcast(space);
  }

  // 时段冲突检测：与现有 pending/active 预约是否重叠
  function slotClash(space, roomId, startAt, endAt) {
    return [...space.roomReservations.values()].some((r) => r.roomId === roomId && (r.status === 'pending' || r.status === 'active') && startAt < r.endAt && endAt > r.startAt);
  }

  // 晋升候补第一位：找到与释放时段对应的最早候补条目，若其时段已无冲突则转为真实预约并通知
  function promoteWaitlist(space) {
    let target = null;
    for (const w of space.roomWaitlist.values()) {
      if (w.status !== 'waiting') continue;
      if (slotClash(space, w.roomId, w.startAt, w.endAt)) continue;
      if (!target || w.createdAt < target.createdAt) target = w;
    }
    if (!target) return;
    target.status = 'promoted';
    const res = { id: genId('res', null), roomId: target.roomId, ownerAccount: target.ownerAccount, ownerName: target.ownerName, title: target.title, startAt: target.startAt, endAt: target.endAt, note: target.note, status: 'pending', repeat: null, seriesId: null, seriesIndex: 0, remindAt: Math.max(Date.now(), target.startAt - ROOM_REMIND_WINDOW_MS), reminded: false };
    space.roomReservations.set(res.id, res);
    saveEntity(space.id, 'room_reservation', res.id, res);
    const owner = getUserByAccount(target.ownerAccount);
    if (owner) {
      recordWeekly(owner, 'meetings');
      sendToAccount(target.ownerAccount, { type: 'roomWaitlistPromoted', waitlistId: target.id, reservationId: res.id, roomId: res.roomId, startAt: res.startAt, endAt: res.endAt });
    }
  }

  function handleRooms(ws, user, space, msg) {
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
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可预约'));
      const room = space.rooms.find((r) => r.id === msg.roomId);
      if (!room) return sendTo(ws, serError('会议室不存在'));
      const startAt = Math.floor(+msg.startAt || 0);
      const endAt = Math.floor(+msg.endAt || 0);
      if (!(startAt > 0) || !(endAt > startAt)) return sendTo(ws, serError('请选择有效的时间段'));
      if (startAt < Date.now()) return sendTo(ws, serError('预约开始时间不能早于当前时间'));
      if (endAt - startAt < 5 * 60000) return sendTo(ws, serError('至少预约 5 分钟'));
      const repeat = (msg.repeat === 'daily' || msg.repeat === 'weekly') ? msg.repeat : null;
      const title = (msg.title || '').trim().slice(0, 40) || '会议';
      const note = (msg.note || '').trim().slice(0, 120);
      const seriesId = repeat ? genId('ser', null) : null;
      const slots = expandRecurring(startAt, endAt, repeat, msg.repeatCount);
      const clash = slots.some((slot) => [...space.roomReservations.values()].some((r) => r.roomId === room.id && (r.status === 'pending' || r.status === 'active') && slot.startAt < r.endAt && slot.endAt > r.startAt));
      if (clash) return sendTo(ws, { type: 'error', message: '该时段已被预约，可加入候补或另选时间', code: 'roomConflict' });
      slots.forEach((slot, i) => {
        const res = { id: genId('res', null), roomId: room.id, ownerAccount: user.account, ownerName: user.nickname, title, startAt: slot.startAt, endAt: slot.endAt, note, status: 'pending', repeat: repeat || null, seriesId: seriesId || null, seriesIndex: i, remindAt: Math.max(Date.now(), slot.startAt - ROOM_REMIND_WINDOW_MS), reminded: false };
        space.roomReservations.set(res.id, res);
        saveEntity(space.id, 'room_reservation', res.id, res);
      });
      recordWeekly(user, 'meetings');
      roomsBroadcast(space);
    } else if (msg.type === 'reservationCancel') {
      const res = space.roomReservations.get(msg.reservationId);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.ownerAccount !== user.account) return sendTo(ws, serError('只能取消自己的预约'));
      if (res.status !== 'pending') return sendTo(ws, serError('该预约已不能取消'));
      res.status = 'cancelled';
      saveEntity(space.id, 'room_reservation', res.id, res);
      promoteWaitlist(space);
      roomsBroadcast(space);
    } else if (msg.type === 'reservationCancelSeries') {
      const series = [...space.roomReservations.values()].filter((r) => r.seriesId === msg.seriesId);
      if (!series.length) return sendTo(ws, serError('该周期预约不存在'));
      if (series[0].ownerAccount !== user.account) return sendTo(ws, serError('只能取消自己的周期预约'));
      const pending = series.filter((r) => r.status === 'pending');
      if (!pending.length) return sendTo(ws, serError('该周期预约已没有待开始的场次'));
      for (const r of pending) { r.status = 'cancelled'; saveEntity(space.id, 'room_reservation', r.id, r); promoteWaitlist(space); }
      roomsBroadcast(space);
    } else if (msg.type === 'roomWaitlist') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可预约'));
      const room = space.rooms.find((r) => r.id === msg.roomId);
      if (!room) return sendTo(ws, serError('会议室不存在'));
      const startAt = Math.floor(+msg.startAt || 0);
      const endAt = Math.floor(+msg.endAt || 0);
      if (!(startAt > 0) || !(endAt > startAt)) return sendTo(ws, serError('请选择有效的时间段'));
      if (startAt < Date.now()) return sendTo(ws, serError('候补开始时间不能早于当前时间'));
      if (endAt - startAt < 5 * 60000) return sendTo(ws, serError('至少预约 5 分钟'));
      const title = (msg.title || '').trim().slice(0, 40) || '会议';
      const note = (msg.note || '').trim().slice(0, 120);
      if (!slotClash(space, room.id, startAt, endAt)) return sendTo(ws, serError('该时段空闲，可直接预约'));
      const dup = [...space.roomWaitlist.values()].some((w) => w.status === 'waiting' && w.roomId === room.id && w.ownerAccount === user.account && slotClash(space, room.id, startAt, endAt) && startAt < w.endAt && endAt > w.startAt);
      if (dup) return sendTo(ws, serError('你已在该时段的候补队列中'));
      const pendingCount = [...space.roomWaitlist.values()].filter((w) => w.roomId === room.id && w.status === 'waiting').length;
      if (pendingCount >= 10) return sendTo(ws, serError('该会议室候补已满'));
      const item = { id: genId('wl', null), roomId: room.id, ownerAccount: user.account, ownerName: user.nickname, title, startAt, endAt, note, status: 'waiting', createdAt: Date.now() };
      space.roomWaitlist.set(item.id, item);
      saveEntity(space.id, 'room_waitlist', item.id, item);
      roomsBroadcast(space);
    } else if (msg.type === 'roomWaitlistCancel') {
      const w = space.roomWaitlist.get(msg.waitlistId);
      if (!w) return sendTo(ws, serError('候补记录不存在'));
      if (w.ownerAccount !== user.account) return sendTo(ws, serError('只能取消自己的候补'));
      if (w.status !== 'waiting') return sendTo(ws, serError('该候补已失效'));
      w.status = 'cancelled';
      saveEntity(space.id, 'room_waitlist', w.id, w);
      roomsBroadcast(space);
    } else if (msg.type === 'roomStart' || msg.type === 'roomEnd') {
      const res = space.roomReservations.get(msg.reservationId);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.ownerAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能操作自己的预约'));
      if (msg.type === 'roomStart' && res.status === 'pending' && res.startAt <= Date.now()) res.status = 'active';
      if (msg.type === 'roomEnd' && res.status === 'active') {
        res.status = 'completed';
        const owner = getUserByAccount(res.ownerAccount);
        if (owner) {
          owner.stats.meetingCount = (owner.stats.meetingCount || 0) + 1;
          owner.stats.meetingDuration += Math.max(0, Math.round((res.endAt - res.startAt) / 60000));
          saveProfile(owner);
          sendToUser(owner.id, { type: 'stats', stats: owner.stats, achievements: owner.achievements });
        }
      }
      saveEntity(space.id, 'room_reservation', res.id, res);
      roomsBroadcast(space);
      broadcastLeaderboard(space);
    }
  }

  return { roomsBroadcast, handleRooms };
};