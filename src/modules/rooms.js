'use strict';
// 会议室模块：roomCreate / roomTag / roomApproval / roomRemove / roomBook / roomWaitlist
//               / roomWaitlistCancel / reservationCancel / reservationCancelSeries / reservationApprove / reservationReject
//               / roomStart / roomEnd / roomRate / roomFavorite
module.exports = function roomsModule(api) {
  const { roomReservationsPublic, roomPublic, roomWaitlistPublic, broadcast, LIST_PAGE, isAdmin, sendTo, serError, genId, saveEntity, deleteEntity, recordWeekly, getUserByAccount, sendToUser, sendToAccount, saveProfile, broadcastLeaderboard, expandRecurring, roomStatsBroadcast, checkAchievements, pushNotification, ROOM_REMIND_WINDOW_MS, MEETING_ONTIME_GRACE_MS } = api;

  function roomsBroadcast(space) {
    const reservations = roomReservationsPublic(space);
    const waitlist = roomWaitlistPublic(space);
    broadcast(space.id, 'rooms', { rooms: space.rooms.map((r) => roomPublic(space, r)), reservations: reservations.slice(0, LIST_PAGE), reservationTotal: reservations.length, waitlist: waitlist.slice(0, LIST_PAGE), waitlistTotal: waitlist.length });
    roomStatsBroadcast(space);
  }

  // 会议室标签规范化：最多 8 个，每个 ≤12 字符
  function normalizeRoomTags(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    return arr.map((t) => String(t == null ? '' : t).trim().slice(0, 12)).filter(Boolean).slice(0, 8);
  }

  // 会议室预约时长限制规范化：min 默认 5 分钟、max 默认 720 分钟，保证 min <= max
  function normalizeRoomDuration(minRaw, maxRaw) {
    const min = Math.max(1, Math.min(1440, parseInt(minRaw, 10) || 5));
    const max = Math.max(min, Math.min(24 * 60, parseInt(maxRaw, 10) || 720));
    return { minMinutes: min, maxMinutes: max };
  }

  // 参会人名单规范化：去重、过滤空值、校验在线成员，最多 50 人
  function normalizeAttendees(space, raw) {
    if (raw == null || raw === '') return { ok: true, attendees: [] };
    if (!Array.isArray(raw)) return { ok: false, message: '参会人名单格式错误' };
    const seen = new Set();
    const out = [];
    for (const acc of raw) {
      const a = String(acc == null ? '' : acc).trim();
      if (!a) continue;
      if (seen.has(a)) continue;
      seen.add(a);
      const u = getUserByAccount(a);
      if (!u || u.currentSpace !== space.id) return { ok: false, message: `参会人「${a}」不是本空间在线成员` };
      out.push(a);
    }
    if (out.length > 50) return { ok: false, message: '参会人名单最多 50 人' };
    return { ok: true, attendees: out };
  }

  // 开始会议：设置进行中、记录准时/迟到、向参会人下发会议开始通知（手动 roomStart 与定时器自动开始共用）
  function startMeeting(space, res, now) {
    if (res.status !== 'pending') return false;
    res.status = 'active';
    res.actualStartAt = now;
    const owner = getUserByAccount(res.ownerAccount);
    if (owner) {
      if (now - res.startAt <= MEETING_ONTIME_GRACE_MS) {
        owner.stats.meetingOnTime = (owner.stats.meetingOnTime || 0) + 1;
      } else {
        owner.stats.meetingLate = (owner.stats.meetingLate || 0) + 1;
      }
      saveProfile(owner);
      sendToUser(owner.id, { type: 'stats', stats: owner.stats, achievements: owner.achievements });
      broadcastLeaderboard(space);
    }
    if ((res.attendees || []).length) {
      for (const a of res.attendees) sendToAccount(a, { type: 'meetingStarted', reservationId: res.id, roomId: res.roomId, title: res.title, startAt: res.startAt });
    }
    return true;
  }

  // 时段冲突检测：与现有 pending / pending_approval / active 预约是否重叠
  function slotClash(space, roomId, startAt, endAt) {
    return [...space.roomReservations.values()].some((r) => r.roomId === roomId && (r.status === 'pending' || r.status === 'pending_approval' || r.status === 'active') && startAt < r.endAt && endAt > r.startAt);
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
    const room = space.rooms.find((r) => r.id === target.roomId);
    const requireApproval = room && room.requireApproval;
    const res = { id: genId('res', null), roomId: target.roomId, ownerAccount: target.ownerAccount, ownerName: target.ownerName, title: target.title, startAt: target.startAt, endAt: target.endAt, note: target.note, status: requireApproval ? 'pending_approval' : 'pending', repeat: null, seriesId: null, seriesIndex: 0, remindAt: Math.max(Date.now(), target.startAt - ROOM_REMIND_WINDOW_MS), reminded: false, approvalRemindedAt: null };
    space.roomReservations.set(res.id, res);
    saveEntity(space.id, 'room_reservation', res.id, res);
    const owner = getUserByAccount(target.ownerAccount);
    if (owner) {
      recordWeekly(owner, 'meetings');
      sendToAccount(target.ownerAccount, { type: 'roomWaitlistPromoted', waitlistId: target.id, reservationId: res.id, roomId: res.roomId, startAt: res.startAt, endAt: res.endAt });
    }
    if (requireApproval) pushNotification(space, { type: 'roomApprovalRequested', level: 'info', title: '会议室预约待审批', body: (room ? room.name : '') + ' · ' + res.title });
  }

  function handleRooms(ws, user, space, msg) {
    if (msg.type === 'roomCreate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可新增会议室'));
      const name = (msg.name || '').trim().slice(0, 30);
      const capacity = parseInt(msg.capacity, 10);
      if (!name) return sendTo(ws, serError('请输入会议室名称'));
      if (!Number.isInteger(capacity) || capacity < 1) return sendTo(ws, serError('请输入有效容纳人数'));
      const tags = normalizeRoomTags(msg.tags);
      const duration = normalizeRoomDuration(msg.minMinutes, msg.maxMinutes);
      const room = { id: genId('rm', null), name, capacity, location: (msg.location || '').trim().slice(0, 40), description: (msg.description || '').trim().slice(0, 100), tags, minMinutes: duration.minMinutes, maxMinutes: duration.maxMinutes };
      space.rooms.push(room);
      saveEntity(space.id, 'room', room.id, room);
      roomsBroadcast(space);
    } else if (msg.type === 'roomTag') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可管理会议室标签'));
      const room = space.rooms.find((r) => r.id === msg.roomId);
      if (!room) return sendTo(ws, serError('会议室不存在'));
      const tags = normalizeRoomTags(msg.tags);
      room.tags = tags;
      saveEntity(space.id, 'room', room.id, room);
      roomsBroadcast(space);
    } else if (msg.type === 'roomApproval') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可设置会议室审批'));
      const room = space.rooms.find((r) => r.id === msg.roomId);
      if (!room) return sendTo(ws, serError('会议室不存在'));
      room.requireApproval = !!msg.requireApproval;
      saveEntity(space.id, 'room', room.id, room);
      roomsBroadcast(space);
    } else if (msg.type === 'roomRemove') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除会议室'));
      const idx = space.rooms.findIndex((r) => r.id === msg.roomId);
      if (idx < 0) return sendTo(ws, serError('会议室不存在'));
      const room = space.rooms[idx];
      const hasActive = [...space.roomReservations.values()].some((r) => r.roomId === room.id && (r.status === 'pending' || r.status === 'pending_approval' || r.status === 'active'));
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
      const durationMs = endAt - startAt;
      if (durationMs < (room.minMinutes || 5) * 60000) return sendTo(ws, { type: 'error', message: `预约时长至少 ${room.minMinutes || 5} 分钟`, code: 'roomDuration' });
      if (durationMs > (room.maxMinutes || 720) * 60000) return sendTo(ws, { type: 'error', message: `预约时长最多 ${room.maxMinutes || 720} 分钟`, code: 'roomDuration' });
      const repeat = (msg.repeat === 'daily' || msg.repeat === 'weekly') ? msg.repeat : null;
      const title = (msg.title || '').trim().slice(0, 40) || '会议';
      const note = (msg.note || '').trim().slice(0, 120);
      const participants = Math.max(1, parseInt(msg.participants, 10) || 1);
      if (participants > room.capacity) return sendTo(ws, serError(`人数超过会议室容量（最多 ${room.capacity} 人）`));
      const attendeesNorm = normalizeAttendees(space, msg.attendees);
      if (!attendeesNorm.ok) return sendTo(ws, serError(attendeesNorm.message));
      const seriesId = repeat ? genId('ser', null) : null;
      const slots = expandRecurring(startAt, endAt, repeat, msg.repeatCount);
      const clash = slots.some((slot) => slotClash(space, room.id, slot.startAt, slot.endAt));
      if (clash) {
        const first = slots[0];
        const free = space.rooms.filter((r) => r.id !== room.id && !slotClash(space, r.id, first.startAt, first.endAt));
        const suggest = free.slice(0, 5).map((r) => roomPublic(space, r));
        return sendTo(ws, { type: 'error', message: '该时段已被预约，可加入候补或另选时间' + (suggest.length ? '；空闲：' + suggest.map((r) => r.name).join('、') : ''), code: 'roomConflict', suggestions: suggest });
      }
      slots.forEach((slot, i) => {
        const res = { id: genId('res', null), roomId: room.id, ownerAccount: user.account, ownerName: user.nickname, title, startAt: slot.startAt, endAt: slot.endAt, note, participants, attendees: attendeesNorm.attendees, attendedAccounts: [], status: room.requireApproval ? 'pending_approval' : 'pending', repeat: repeat || null, seriesId: seriesId || null, seriesIndex: i, remindAt: Math.max(Date.now(), slot.startAt - ROOM_REMIND_WINDOW_MS), reminded: false, approvalRemindedAt: null };
        space.roomReservations.set(res.id, res);
        saveEntity(space.id, 'room_reservation', res.id, res);
      });
      recordWeekly(user, 'meetings');
      roomsBroadcast(space);
      if (room.requireApproval) pushNotification(space, { type: 'roomApprovalRequested', level: 'info', title: '会议室预约待审批', body: room.name + ' · ' + title });
    } else if (msg.type === 'reservationCancel') {
      const res = space.roomReservations.get(msg.reservationId);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.ownerAccount !== user.account) return sendTo(ws, serError('只能取消自己的预约'));
      if (res.status !== 'pending' && res.status !== 'pending_approval') return sendTo(ws, serError('该预约已不能取消'));
      res.status = 'cancelled';
      saveEntity(space.id, 'room_reservation', res.id, res);
      promoteWaitlist(space);
      roomsBroadcast(space);
    } else if (msg.type === 'reservationCancelSeries') {
      const series = [...space.roomReservations.values()].filter((r) => r.seriesId === msg.seriesId);
      if (!series.length) return sendTo(ws, serError('该周期预约不存在'));
      if (series[0].ownerAccount !== user.account) return sendTo(ws, serError('只能取消自己的周期预约'));
      const pending = series.filter((r) => r.status === 'pending' || r.status === 'pending_approval');
      if (!pending.length) return sendTo(ws, serError('该周期预约已没有待开始的场次'));
      for (const r of pending) { r.status = 'cancelled'; saveEntity(space.id, 'room_reservation', r.id, r); promoteWaitlist(space); }
      roomsBroadcast(space);
    } else if (msg.type === 'reservationApprove') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可审批会议室预约'));
      const res = space.roomReservations.get(msg.reservationId);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.status !== 'pending_approval') return sendTo(ws, serError('仅待审批预约可批准'));
      res.status = 'pending';
      saveEntity(space.id, 'room_reservation', res.id, res);
      roomsBroadcast(space);
      sendToAccount(res.ownerAccount, { type: 'reservationApproved', reservationId: res.id, roomId: res.roomId, title: res.title, startAt: res.startAt, endAt: res.endAt });
    } else if (msg.type === 'reservationReject') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可审批会议室预约'));
      const res = space.roomReservations.get(msg.reservationId);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.status !== 'pending_approval') return sendTo(ws, serError('仅待审批预约可驳回'));
      res.status = 'cancelled';
      saveEntity(space.id, 'room_reservation', res.id, res);
      roomsBroadcast(space);
      sendToAccount(res.ownerAccount, { type: 'reservationRejected', reservationId: res.id, roomId: res.roomId, title: res.title });
    } else if (msg.type === 'reservationReschedule') {
      const res = space.roomReservations.get(msg.reservationId);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.ownerAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能改期自己的预约'));
      if (res.status !== 'pending') return sendTo(ws, serError('该预约已不能改期'));
      const room = space.rooms.find((r) => r.id === res.roomId);
      if (!room) return sendTo(ws, serError('会议室不存在'));
      const startAt = Math.floor(+msg.startAt || 0);
      const endAt = Math.floor(+msg.endAt || 0);
      if (!(startAt > 0) || !(endAt > startAt)) return sendTo(ws, serError('请选择有效的时间段'));
      if (startAt < Date.now()) return sendTo(ws, serError('改期开始时间不能早于当前时间'));
      if (endAt - startAt < 5 * 60000) return sendTo(ws, serError('至少预约 5 分钟'));
      const clash = [...space.roomReservations.values()].some((r) => r.id !== res.id && r.roomId === room.id && (r.status === 'pending' || r.status === 'pending_approval' || r.status === 'active') && startAt < r.endAt && endAt > r.startAt);
      if (clash) {
        const free = space.rooms.filter((r) => r.id !== room.id && !slotClash(space, r.id, startAt, endAt));
        const suggest = free.slice(0, 5).map((r) => roomPublic(space, r));
        return sendTo(ws, { type: 'error', message: '该时段已被预约，可另选时间' + (suggest.length ? '；空闲：' + suggest.map((r) => r.name).join('、') : ''), code: 'roomConflict', suggestions: suggest });
      }
      res.startAt = startAt;
      res.endAt = endAt;
      res.remindAt = Math.max(Date.now(), startAt - ROOM_REMIND_WINDOW_MS);
      res.reminded = false;
      saveEntity(space.id, 'room_reservation', res.id, res);
      sendToAccount(res.ownerAccount, { type: 'reservationRescheduled', reservationId: res.id, roomId: res.roomId, startAt: res.startAt, endAt: res.endAt });
      roomsBroadcast(space);
      broadcastLeaderboard(space);
    } else if (msg.type === 'reservationAttendees') {
      const res = space.roomReservations.get(msg.reservationId);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.ownerAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能修改自己的会议参会人'));
      if (res.status !== 'pending' && res.status !== 'pending_approval') return sendTo(ws, serError('会议已开始或结束，不能再修改参会人'));
      const norm = normalizeAttendees(space, msg.attendees);
      if (!norm.ok) return sendTo(ws, serError(norm.message));
      res.attendees = norm.attendees;
      res.attendedAccounts = (res.attendedAccounts || []).filter((a) => norm.attendees.includes(a));
      saveEntity(space.id, 'room_reservation', res.id, res);
      roomsBroadcast(space);
      sendTo(ws, { type: 'reservationAttendees', reservationId: res.id, attendees: res.attendees });
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
      if (msg.type === 'roomStart' && res.status === 'pending' && res.startAt <= Date.now()) {
        startMeeting(space, res, Date.now());
      }
      if (msg.type === 'roomEnd' && res.status === 'active') {
        res.status = 'completed';
        res.actualEndAt = Date.now();
        const owner = getUserByAccount(res.ownerAccount);
        if (owner) {
          owner.stats.meetingCount = (owner.stats.meetingCount || 0) + 1;
          owner.stats.meetingDuration += Math.max(0, Math.round((res.endAt - res.startAt) / 60000));
          const actualMin = res.actualStartAt ? Math.max(0, Math.round((res.actualEndAt - res.actualStartAt) / 60000)) : 0;
          owner.stats.meetingActualDuration = (owner.stats.meetingActualDuration || 0) + actualMin;
          saveProfile(owner);
          sendToUser(owner.id, { type: 'stats', stats: owner.stats, achievements: owner.achievements });
        }
      }
      saveEntity(space.id, 'room_reservation', res.id, res);
      roomsBroadcast(space);
      broadcastLeaderboard(space);
    } else if (msg.type === 'meetingAttend') {
      const res = space.roomReservations.get(msg.reservationId);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.status !== 'active') return sendTo(ws, serError('会议进行中才可确认到场'));
      if (!(res.attendees || []).includes(user.account)) return sendTo(ws, serError('你不是该会议的参会人'));
      if (!(res.attendedAccounts || []).includes(user.account)) res.attendedAccounts = (res.attendedAccounts || []).concat(user.account);
      saveEntity(space.id, 'room_reservation', res.id, res);
      roomsBroadcast(space);
      sendTo(ws, { type: 'meetingAttended', reservationId: res.id });
    } else if (msg.type === 'roomRate') {
      const res = space.roomReservations.get(msg.reservationId);
      if (!res) return sendTo(ws, serError('预约不存在'));
      if (res.ownerAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能给结束的会议评分'));
      if (res.status !== 'completed') return sendTo(ws, serError('只有已结束的会议可以评分'));
      if (res.rating) return sendTo(ws, serError('该会议已评分'));
      const dims = { environment: '环境', equipment: '设备', service: '服务' };
      let scores;
      if (msg.scores && typeof msg.scores === 'object') {
        scores = {};
        for (const k of Object.keys(dims)) {
          const v = parseInt(msg.scores[k], 10);
          if (!Number.isInteger(v) || v < 1 || v > 5) return sendTo(ws, serError(`${dims[k]}评分需为 1-5 分`));
          scores[k] = v;
        }
      } else {
        const score = parseInt(msg.score, 10);
        if (!Number.isInteger(score) || score < 1 || score > 5) return sendTo(ws, serError('评分需为 1-5 分'));
        scores = { environment: score, equipment: score, service: score };
      }
      const avg = Math.round((scores.environment + scores.equipment + scores.service) / 3);
      const comment = (msg.comment || '').trim().slice(0, 60);
      res.rating = avg;
      res.ratings = scores;
      res.ratedAt = Date.now();
      res.ratingComment = comment;
      user.stats.roomRatesGiven = (user.stats.roomRatesGiven || 0) + 1;
      checkAchievements(user);
      saveProfile(user);
      sendToUser(user.id, { type: 'stats', stats: user.stats, achievements: user.achievements });
      saveEntity(space.id, 'room_reservation', res.id, res);
      roomsBroadcast(space);
      sendTo(ws, { type: 'roomRated', reservationId: res.id, roomId: res.roomId, score: avg, scores });
    } else if (msg.type === 'roomFavorite') {
      const room = space.rooms.find((r) => r.id === msg.roomId);
      if (!room) return sendTo(ws, serError('会议室不存在'));
      if (!Array.isArray(user.stats.favoriteRooms)) user.stats.favoriteRooms = [];
      const idx = user.stats.favoriteRooms.indexOf(room.id);
      const add = idx < 0;
      if (add) user.stats.favoriteRooms.push(room.id); else user.stats.favoriteRooms.splice(idx, 1);
      user.stats.favoriteCount = user.stats.favoriteRooms.length;
      checkAchievements(user);
      saveProfile(user);
      sendToUser(user.id, { type: 'stats', stats: user.stats, achievements: user.achievements });
      sendTo(ws, { type: 'roomFavorites', favorites: user.stats.favoriteRooms || [] });
      roomsBroadcast(space);
    }
  }

  return { roomsBroadcast, startMeeting, handleRooms };
};