'use strict';
// 工位预约模块：deskCreate / deskDelete(admin) / deskReserve / deskCancel(owner)
module.exports = function desksModule(api) {
  const { desksBroadcast, deskStatsBroadcast, sendTo, serError, genId, saveEntity, deleteEntity, isAdmin, broadcastLeaderboard, checkAchievements, saveProfile, recordWeekly } = api;

  function handleDesks(ws, user, space, msg) {
    if (msg.type === 'deskCreate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可新增工位'));
      const name = (msg.name || '').trim().slice(0, 30);
      if (!name) return sendTo(ws, serError('请输入工位名称'));
      const desk = { id: genId('ds', null), name, location: (msg.location || '').trim().slice(0, 40), description: (msg.description || '').trim().slice(0, 100) };
      space.desks.push(desk);
      saveEntity(space.id, 'desk', desk.id, desk);
      desksBroadcast(space);
      deskStatsBroadcast(space);
    } else if (msg.type === 'deskDelete') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除工位'));
      const desk = space.desks.find((d) => d.id === msg.deskId);
      if (!desk) return sendTo(ws, serError('工位不存在'));
      const hasActive = [...space.deskReservations.values()].some((r) => r.deskId === desk.id && (r.status === 'pending' || r.status === 'active'));
      if (hasActive) return sendTo(ws, serError('该工位仍有进行中或待开始的预约，无法删除'));
      const idx = space.desks.indexOf(desk);
      space.desks.splice(idx, 1);
      deleteEntity(space.id, 'desk', desk.id);
      desksBroadcast(space);
      deskStatsBroadcast(space);
    } else if (msg.type === 'deskReserve') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可预约工位'));
      const desk = space.desks.find((d) => d.id === msg.deskId);
      if (!desk) return sendTo(ws, serError('工位不存在'));
      const startAt = parseInt(msg.startAt, 10);
      const endAt = parseInt(msg.endAt, 10);
      const now = Date.now();
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) return sendTo(ws, serError('时间无效'));
      if (startAt <= now) return sendTo(ws, serError('预约开始时间需晚于当前时间'));
      if (endAt - startAt < 10 * 60000) return sendTo(ws, serError('预约时长至少 10 分钟'));
      // 冲突检测：同一工位时段重叠（排除已完成 / 已取消 / 已过期）
      const conflict = [...space.deskReservations.values()].some((r) => r.deskId === desk.id && (r.status === 'pending' || r.status === 'active') && startAt < r.endAt && r.startAt < endAt);
      if (conflict) return sendTo(ws, serError('该工位在该时段已被预约'));
      const res = { id: genId('drv', null), deskId: desk.id, account: user.account, name: user.nickname, startAt, endAt, note: (msg.note || '').trim().slice(0, 80), status: 'pending' };
      space.deskReservations.set(res.id, res);
      user.stats.meetingCount = (user.stats.meetingCount || 0) + 1; // 工位预约复用「会议/办公」类计数
      user.stats.deskCount = (user.stats.deskCount || 0) + 1;
      recordWeekly(user, 'meetings');
      recordWeekly(user, 'desks');
      checkAchievements(user);
      saveProfile(user);
      saveEntity(space.id, 'desk_reservation', res.id, res);
      desksBroadcast(space);
      deskStatsBroadcast(space);
      broadcastLeaderboard(space);
    } else if (msg.type === 'deskStart' || msg.type === 'deskEnd') {
      const res = space.deskReservations.get(msg.reservationId);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能操作自己的工位预约'));
      if (msg.type === 'deskStart' && res.status === 'pending') {
        res.status = 'active';
        res.actualStartAt = Date.now();
      }
      if (msg.type === 'deskEnd' && res.status === 'active') {
        res.status = 'completed';
        res.actualEndAt = Date.now();
      }
      saveEntity(space.id, 'desk_reservation', res.id, res);
      desksBroadcast(space);
      deskStatsBroadcast(space);
    } else if (msg.type === 'deskCancel') {
      const res = space.deskReservations.get(msg.reservationId);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能取消自己的工位预约'));
      if (res.status !== 'pending') return sendTo(ws, serError('该预约已结束或已取消'));
      res.status = 'cancelled';
      saveEntity(space.id, 'desk_reservation', res.id, res);
      desksBroadcast(space);
      deskStatsBroadcast(space);
    }
  }

  return { handleDesks, desksBroadcast };
};
