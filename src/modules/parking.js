'use strict';
// 车辆 / 停车位管理模块：spotCreate / spotDelete / spotReserve / spotCancel / spotCheckin / spotCheckout
// 登记共享停车位（普通 / 无障碍 / 充电 / 固定），成员预约与签到签退，实时占用与车牌登记。
module.exports = function parkingModule(api) {
  const { spaceUserInfo, parkingSpotsPublic, parkingStats, parkingReservationsPublic, broadcast, PARKING_TYPES, isAdmin, sendTo, serError, genId, saveEntity, deleteEntity, pushNotification } = api;

  function parkingBroadcast(space) {
    const info = spaceUserInfo(space.id);
    broadcast(space.id, 'parking', { spots: parkingSpotsPublic(space, info), stats: parkingStats(space), reservations: parkingReservationsPublic(space, info) });
  }

  function handleParking(ws, user, space, msg) {
    if (msg.type === 'spotCreate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可新增车位'));
      const name = (msg.name || '').trim().slice(0, 30);
      if (!name) return sendTo(ws, serError('请输入车位名称'));
      const total = parseInt(msg.total, 10);
      if (!Number.isInteger(total) || total < 1) return sendTo(ws, serError('请输入有效车位数'));
      const type = PARKING_TYPES.includes(msg.spotType) ? msg.spotType : 'standard';
      const spot = { id: genId('pk', null), name, type, total, available: total, location: (msg.location || '').trim().slice(0, 40), note: (msg.note || '').trim().slice(0, 120) };
      space.parkingSpots.push(spot);
      saveEntity(space.id, 'parkingSpot', spot.id, spot);
      parkingBroadcast(space);
    } else if (msg.type === 'spotDelete') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除车位'));
      const idx = space.parkingSpots.findIndex((s) => s.id === msg.id);
      if (idx < 0) return sendTo(ws, serError('车位不存在'));
      const spot = space.parkingSpots[idx];
      const hasActive = [...space.parkingReservations.values()].some((r) => r.spotId === spot.id && (r.status === 'reserved' || r.status === 'checked_in'));
      if (hasActive) return sendTo(ws, serError('该车位仍有预约或已签到，无法删除'));
      space.parkingSpots.splice(idx, 1);
      deleteEntity(space.id, 'parkingSpot', spot.id);
      parkingBroadcast(space);
    } else if (msg.type === 'spotReserve') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可预约车位'));
      const spot = space.parkingSpots.find((s) => s.id === msg.spotId);
      if (!spot) return sendTo(ws, serError('车位不存在'));
      if (spot.available < 1) return sendTo(ws, serError('该车位已满'));
      const date = (msg.date || '').slice(0, 20);
      if (!date) return sendTo(ws, serError('请选择日期'));
      const startAt = Math.floor(+msg.startAt || 0);
      const endAt = Math.floor(+msg.endAt || 0);
      if (!(startAt && endAt && endAt > startAt)) return sendTo(ws, serError('请选择有效的起止时间'));
      const conflict = [...space.parkingReservations.values()].find((r) => r.spotId === spot.id && r.date === date && r.status !== 'cancelled' && r.status !== 'checked_out' && startAt < r.endAt && endAt > r.startAt);
      if (conflict) return sendTo(ws, serError('该时段已被占用'));
      spot.available -= 1;
      const res = { id: genId('pr', null), spotId: spot.id, account: user.account, plateNumber: (msg.plateNumber || '').trim().slice(0, 20), date, startAt, endAt, status: 'reserved', checkedInAt: null, checkedOutAt: null, createdAt: Date.now() };
      space.parkingReservations.set(res.id, res);
      saveEntity(space.id, 'parkingSpot', spot.id, spot);
      saveEntity(space.id, 'parkingReservation', res.id, res);
      parkingBroadcast(space);
    } else if (msg.type === 'spotCancel') {
      const res = space.parkingReservations.get(msg.id);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能取消自己的预约'));
      if (res.status !== 'reserved') return sendTo(ws, serError('仅待签到的预约可取消'));
      res.status = 'cancelled';
      const spot = space.parkingSpots.find((s) => s.id === res.spotId);
      if (spot) { spot.available += 1; saveEntity(space.id, 'parkingSpot', spot.id, spot); }
      saveEntity(space.id, 'parkingReservation', res.id, res);
      parkingBroadcast(space);
    } else if (msg.type === 'spotCheckin') {
      const res = space.parkingReservations.get(msg.id);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能签入自己的预约'));
      if (res.status !== 'reserved') return sendTo(ws, serError('该预约状态不可签入'));
      res.status = 'checked_in';
      res.checkedInAt = Date.now();
      saveEntity(space.id, 'parkingReservation', res.id, res);
      parkingBroadcast(space);
    } else if (msg.type === 'spotCheckout') {
      const res = space.parkingReservations.get(msg.id);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能签出自己的预约'));
      if (res.status !== 'checked_in') return sendTo(ws, serError('该预约状态不可签出'));
      res.status = 'checked_out';
      res.checkedOutAt = Date.now();
      const spot = space.parkingSpots.find((s) => s.id === res.spotId);
      if (spot) { spot.available += 1; saveEntity(space.id, 'parkingSpot', spot.id, spot); }
      saveEntity(space.id, 'parkingReservation', res.id, res);
      parkingBroadcast(space);
    }
  }

  return { parkingBroadcast, handleParking };
};
