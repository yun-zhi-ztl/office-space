'use strict';
// 用车 / 公务车辆借用管理模块：vehicleCreate / vehicleUpdate / vehicleDelete /
// vehicleReserve / vehicleCancel / vehicleCheckin / vehicleCheckout
// 管理员维护公司车辆台账（车牌 / 座位 / 类型 / 保养），成员按时间段借用，
// 同车时段冲突检测，签到登记起始里程、签退登记结束里程并卡里程合理区间。
module.exports = function vehiclesModule(api) {
  const { spaceUserInfo, vehiclesPublic, vehicleStats, vehicleReservationsPublic, vehiclesBroadcast, broadcast, VEHICLE_TYPES, isAdmin, sendTo, serError, genId, saveEntity, deleteEntity, pushNotification } = api;

  const ACTIVE = (r) => r.status === 'reserved' || r.status === 'checked_in';

  function hasConflict(space, vehicleId, date, startAt, endAt, excludeId) {
    return [...space.vehicleReservations.values()].some((r) =>
      r.vehicleId === vehicleId && r.id !== excludeId && r.date === date && ACTIVE(r) && startAt < r.endAt && endAt > r.startAt);
  }

  function handleVehicles(ws, user, space, msg) {
    if (msg.type === 'vehicleCreate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可新增车辆'));
      const name = (msg.name || '').trim().slice(0, 30);
      if (!name) return sendTo(ws, serError('请输入车辆名称'));
      const plateNumber = (msg.plateNumber || '').trim().slice(0, 20);
      if (!plateNumber) return sendTo(ws, serError('请输入车牌号'));
      const vehicle = { id: genId('vh', null), name, plateNumber, type: VEHICLE_TYPES.includes(msg.vehicleType) ? msg.vehicleType : 'sedan', seats: Math.max(0, parseInt(msg.seats, 10) || 0), location: (msg.location || '').trim().slice(0, 40), note: (msg.note || '').trim().slice(0, 120), maintenance: !!msg.maintenance, createdAt: Date.now() };
      space.vehicles.push(vehicle);
      saveEntity(space.id, 'vehicle', vehicle.id, vehicle);
      vehiclesBroadcast(space);
    } else if (msg.type === 'vehicleUpdate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可编辑车辆'));
      const vehicle = space.vehicles.find((v) => v.id === msg.id);
      if (!vehicle) return sendTo(ws, serError('车辆不存在'));
      if (msg.name !== undefined) { const name = (msg.name || '').trim().slice(0, 30); if (name) vehicle.name = name; }
      if (msg.plateNumber !== undefined) { const plate = (msg.plateNumber || '').trim().slice(0, 20); if (plate) vehicle.plateNumber = plate; }
      if (msg.vehicleType !== undefined && VEHICLE_TYPES.includes(msg.vehicleType)) vehicle.type = msg.vehicleType;
      if (msg.seats !== undefined) vehicle.seats = Math.max(0, parseInt(msg.seats, 10) || 0);
      if (msg.location !== undefined) vehicle.location = (msg.location || '').trim().slice(0, 40);
      if (msg.note !== undefined) vehicle.note = (msg.note || '').trim().slice(0, 120);
      if (msg.maintenance !== undefined) vehicle.maintenance = !!msg.maintenance;
      saveEntity(space.id, 'vehicle', vehicle.id, vehicle);
      vehiclesBroadcast(space);
    } else if (msg.type === 'vehicleDelete') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除车辆'));
      const idx = space.vehicles.findIndex((v) => v.id === msg.id);
      if (idx < 0) return sendTo(ws, serError('车辆不存在'));
      const vehicle = space.vehicles[idx];
      const hasActive = [...space.vehicleReservations.values()].some((r) => r.vehicleId === vehicle.id && ACTIVE(r));
      if (hasActive) return sendTo(ws, serError('该车辆仍有预约或已出车，无法删除'));
      space.vehicles.splice(idx, 1);
      deleteEntity(space.id, 'vehicle', vehicle.id);
      vehiclesBroadcast(space);
    } else if (msg.type === 'vehicleReserve') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可借用车辆'));
      const vehicle = space.vehicles.find((v) => v.id === msg.vehicleId);
      if (!vehicle) return sendTo(ws, serError('车辆不存在'));
      if (vehicle.maintenance) return sendTo(ws, serError('该车辆保养中，暂不可借用'));
      const date = (msg.date || '').slice(0, 20);
      if (!date) return sendTo(ws, serError('请选择日期'));
      const startAt = Math.floor(+msg.startAt || 0);
      const endAt = Math.floor(+msg.endAt || 0);
      if (!(startAt && endAt && endAt > startAt)) return sendTo(ws, serError('请选择有效的起止时间'));
      if (msg.purpose !== undefined && (msg.purpose || '').trim().length > 100) return sendTo(ws, serError('用途说明过长'));
      if (hasConflict(space, vehicle.id, date, startAt, endAt, null)) return sendTo(ws, serError('该时段车辆已被借用'));
      const res = { id: genId('vr', null), vehicleId: vehicle.id, account: user.account, date, startAt, endAt, purpose: (msg.purpose || '').trim().slice(0, 100), driver: (msg.driver || '').trim().slice(0, 30), status: 'reserved', mileageStart: 0, mileageEnd: 0, checkedInAt: null, checkedOutAt: null, createdAt: Date.now() };
      space.vehicleReservations.set(res.id, res);
      saveEntity(space.id, 'vehicle_reservation', res.id, res);
      vehiclesBroadcast(space);
    } else if (msg.type === 'vehicleCancel') {
      const res = space.vehicleReservations.get(msg.id);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能取消自己的预约'));
      if (res.status !== 'reserved') return sendTo(ws, serError('仅待出车的预约可取消'));
      res.status = 'cancelled';
      saveEntity(space.id, 'vehicle_reservation', res.id, res);
      vehiclesBroadcast(space);
    } else if (msg.type === 'vehicleCheckin') {
      const res = space.vehicleReservations.get(msg.id);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能签到自己的预约'));
      if (res.status !== 'reserved') return sendTo(ws, serError('该预约状态不可出车'));
      const mileageStart = Math.floor(+msg.mileageStart || 0);
      if (mileageStart <= 0) return sendTo(ws, serError('请登记出发里程'));
      res.status = 'checked_in';
      res.checkedInAt = Date.now();
      res.mileageStart = mileageStart;
      saveEntity(space.id, 'vehicle_reservation', res.id, res);
      vehiclesBroadcast(space);
    } else if (msg.type === 'vehicleCheckout') {
      const res = space.vehicleReservations.get(msg.id);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能签退自己的预约'));
      if (res.status !== 'checked_in') return sendTo(ws, serError('该预约状态不可还车'));
      const mileageEnd = Math.floor(+msg.mileageEnd || 0);
      if (mileageEnd <= 0) return sendTo(ws, serError('请登记返回里程'));
      if (mileageEnd < res.mileageStart) return sendTo(ws, serError('返回里程不能小于出发里程'));
      if (mileageEnd - res.mileageStart > 5000) return sendTo(ws, serError('本次里程异常（超过 5000 公里），请核对'));
      res.status = 'checked_out';
      res.checkedOutAt = Date.now();
      res.mileageEnd = mileageEnd;
      saveEntity(space.id, 'vehicle_reservation', res.id, res);
      vehiclesBroadcast(space);
    }
  }

  return { vehiclesBroadcast, handleVehicles };
};