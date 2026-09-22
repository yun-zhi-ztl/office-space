'use strict';
// 坑位看板模块（原坑位雷达）：stallConfig / reserve / cancel / grab / startUse / finish / release / urge / rate / toggleEmergency
module.exports = function stallsModule(api) {
  const {
    isAdmin, sendTo, serError, genId, buildStalls, saveSpace, activeStallCount, saveProfile, saveStallRating,
    broadcastLeaderboard, sendToUser, broadcast, checkAchievements, notifyUrge, recordWeekly, broadcastStalls,
    RESERVE_CONFIRM_WINDOW_MS,
  } = api;

  function handleStalls(ws, user, space, msg) {
    const type = msg.type;
    const stall = space.stalls.find((x) => x.id === msg.stallId);

    if (type === 'stallConfig') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可配置坑位'));
      const squat = parseInt(msg.squat_count, 10);
      const urinal = parseInt(msg.urinal_count, 10);
      const sq = Number.isInteger(squat) ? Math.max(0, Math.min(10, squat)) : space.squatCount;
      const ur = Number.isInteger(urinal) ? Math.max(0, Math.min(10, urinal)) : space.urinalCount;
      const oldRatings = {};
      for (const s of space.stalls) oldRatings[s.id] = s.ratings || [];
      space.squatCount = sq;
      space.urinalCount = ur;
      space.stalls = buildStalls(sq, ur);
      for (const s of space.stalls) if (oldRatings[s.id]) s.ratings = oldRatings[s.id].slice(-60);
      space.reservations.clear();
      saveSpace(space);
      broadcastStalls(space);
      return;
    }

    if (type === 'reserve') {
      if (!stall) return sendTo(ws, serError('坑位不存在'));
      if (stall.status !== 'free') return sendTo(ws, serError('该坑位已被占用'));
      if (activeStallCount(space, user) >= 1) return sendTo(ws, serError('你已占着一个坑位，一次只能用一个'));
      const durOpts = stall.type === 'urinal' ? [1, 2, 5] : [15, 30, 45];
      const duration = durOpts.includes(msg.duration) ? msg.duration : durOpts[0];
      const startTime = Date.now() + 60000;
      const endTime = startTime + duration * 60000;
      const reservationId = genId('r', null);
      const res = { id: reservationId, stallId: stall.id, userId: user.id, account: user.account, nickname: user.nickname, startTime, endTime, duration, status: 'pending' };
      space.reservations.set(reservationId, res);
      stall.status = 'reserved';
      stall.currentUser = null;
      stall.reservation = { userId: user.id, account: user.account, nickname: user.nickname, startTime, endTime, duration, reservationId, isGrab: false };
      sendTo(ws, { type: 'reservation', reservation: { id: reservationId, stallId: stall.id, startTime, endTime, duration, status: 'pending' } });
      broadcastStalls(space);
      return;
    }

    if (type === 'cancel') {
      const reservation = space.reservations.get(msg.reservationId);
      if (!reservation || reservation.account !== user.account) return sendTo(ws, serError('预约不存在'));
      const target = space.stalls.find((x) => x.id === reservation.stallId);
      if (!target) return sendTo(ws, serError('预约不存在'));
      if (target.status === 'occupied') return sendTo(ws, serError('正在使用中，无法取消'));
      target.status = 'free'; target.reservation = null;
      reservation.status = 'cancelled';
      space.reservations.delete(reservation.id);
      sendTo(ws, { type: 'cancelSuccess', reservationId: reservation.id });
      broadcastStalls(space);
      return;
    }

    if (type === 'grab') {
      if (!stall) return sendTo(ws, serError('坑位不存在'));
      if (stall.status !== 'free') return sendTo(ws, serError('手慢了，已被抢'));
      if (activeStallCount(space, user) >= 1) return sendTo(ws, serError('你已占着一个坑位，一次只能用一个'));
      stall.status = 'occupied';
      stall.currentUser = user.account;
      const gmin = stall.type === 'urinal' ? 1 : 5;
      const now = Date.now();
      stall.reservation = { userId: user.id, account: user.account, nickname: user.nickname, startTime: now, endTime: now + gmin * 60000, duration: gmin, reservationId: 'g' + Date.now(), isGrab: true };
      user.currentStall = stall.id;
      user.stats.grabSuccess++;
      // 不在此处累计 totalVisits：一次抢位由 finish / 自动释放各计一次，避免“抢位+结束”重复计数（issue #8）
      checkAchievements(user);
      saveProfile(user);
      broadcastStalls(space);
      broadcastLeaderboard(space);
      sendToUser(user.id, { type: 'stats', stats: user.stats });
      return;
    }

    if (type === 'startUse') {
      if (!stall || !stall.reservation) return sendTo(ws, serError('无有效预约'));
      if (stall.reservation.account !== user.account) return sendTo(ws, serError('这不是你的预约'));
      if (stall.status === 'occupied') return sendTo(ws, serError('坑位正在使用中'));
      if (Date.now() < stall.reservation.startTime) return sendTo(ws, serError('尚未到预约时间，请到点后再确认到坑'));
      if (Date.now() > stall.reservation.startTime + RESERVE_CONFIRM_WINDOW_MS) return sendTo(ws, serError('预约已过期，未在规定时间内确认到坑'));
      stall.status = 'occupied';
      stall.currentUser = user.account;
      const r = space.reservations.get(stall.reservation.reservationId);
      if (r) r.status = 'active';
      user.currentStall = stall.id;
      user.wasOnTime = true;
      broadcastStalls(space);
      return;
    }

    if (type === 'finish' || type === 'release') {
      if (!stall || !stall.reservation) return sendTo(ws, serError('无有效预约'));
      if (stall.reservation.account !== user.account) return sendTo(ws, serError('只有当前使用者可操作'));
      const wasReserve = stall.reservation.reservationId && space.reservations.get(stall.reservation.reservationId);
      if (type === 'finish') {
        const duration = Math.round((Date.now() - stall.reservation.startTime) / 60000);
        user.stats.totalDuration += duration;
        user.stats.maxDuration = Math.max(user.stats.maxDuration, duration);
        if (user.stats.favoriteStall === null) user.stats.favoriteStall = stall.id;
        user.stats.totalVisits++;
        recordWeekly(user, 'visits');
        const hour = new Date().getHours();
        if (hour < 6 || hour > 22) user.stats.nightVisits++;
        if (user.wasOnTime) user.stats.consecutiveOnTime++; else user.stats.consecutiveOnTime = 0;
        user.stats.onTimeRate = user.stats.totalVisits > 0 ? 1 : 0;
      }
      if (wasReserve) { wasReserve.status = 'completed'; space.reservations.delete(wasReserve.id); }
      stall.status = 'free'; stall.currentUser = null; stall.reservation = null;
      user.currentStall = null; user.wasOnTime = true;
      space.urges.delete(stall.id);
      checkAchievements(user);
      broadcast(space.id, 'stallReleased', { stallId: stall.id });
      broadcastStalls(space);
      broadcastLeaderboard(space);
      sendToUser(user.id, { type: 'stats', stats: user.stats });
      saveProfile(user);
      return;
    }

    if (type === 'urge') {
      if (!stall || stall.status !== 'occupied') return sendTo(ws, serError('坑位空闲，无需催促'));
      const count = (space.urges.get(stall.id) || 0) + 1;
      space.urges.set(stall.id, count);
      notifyUrge(space, stall.id, count, stall.reservation.account);
      broadcastStalls(space);
      return;
    }

    if (type === 'rate') {
      if (!stall) return sendTo(ws, serError('坑位不存在'));
      const s = (v) => { const n = Number(v); return Number.isInteger(n) ? n : NaN; };
      const cleanliness = s(msg.cleanliness);
      const signal = s(msg.signal);
      const paper = s(msg.paper);
      if (![cleanliness, signal, paper].every((n) => n >= 1 && n <= 5)) return sendTo(ws, serError('评分需为 1-5 的整数'));
      if (stall.ratings.some((r) => r.account && r.account === user.account)) return sendTo(ws, serError('你已为该坑位评过分'));
      stall.ratings.push({ account: user.account, nickname: user.nickname, cleanliness, signal, paper, timestamp: Date.now() });
      if (stall.ratings.length > 60) stall.ratings = stall.ratings.slice(-60);
      user.stats.ratingsGiven++;
      checkAchievements(user);
      saveProfile(user);
      saveStallRating(space.id, stall.id, { account: user.account, nickname: user.nickname, cleanliness, signal, paper });
      broadcastStalls(space);
      sendToUser(user.id, { type: 'stats', stats: user.stats });
      return;
    }

    if (type === 'toggleEmergency') {
      user.emergencyMode = !!msg.enabled;
      sendTo(ws, { type: 'emergencyToggled', enabled: user.emergencyMode });
      api.broadcastUsers(space);
      return;
    }
  }

  return { handleStalls };
};