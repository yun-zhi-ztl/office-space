'use strict';
// 活动管理模块：eventCreate / eventRsvp / eventCancel / eventRemove(admin)
// 活动覆盖培训 / 分享会 / 团建 / 生日会 / 会议，支持 RSVP 与开始前提醒。
module.exports = function eventsModule(api) {
  const { EVENT_CATEGORIES, eventsBroadcast, sendTo, serError, genId, saveEntity, deleteEntity, isAdmin, pushNotice, checkAchievements, saveProfile, recordWeekly, ROOM_REMIND_WINDOW_MS } = api;

  function handleEvents(ws, user, space, msg) {
    if (msg.type === 'eventCreate') {
      const title = (msg.title || '').trim().slice(0, 50);
      const description = (msg.description || '').trim().slice(0, 200);
      const category = EVENT_CATEGORIES.includes(msg.category) ? msg.category : '会议';
      const location = (msg.location || '').trim().slice(0, 30);
      const startAt = parseInt(msg.startAt, 10);
      const endAt = parseInt(msg.endAt, 10);
      if (!title) return sendTo(ws, serError('请输入活动标题'));
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) return sendTo(ws, serError('请选择开始与结束时间'));
      if (startAt >= endAt) return sendTo(ws, serError('结束时间需晚于开始时间'));
      if (startAt < Date.now()) return sendTo(ws, serError('活动开始时间需晚于当前时间'));
      const capacity = Math.max(0, parseInt(msg.capacity, 10) || 0);
      const rec = {
        id: genId('ev', null), title, description, category, location,
        startAt, endAt,
        hostAccount: user.account, hostName: user.nickname,
        capacity, rsvps: {}, cancelled: false, reminded: false,
        remindAt: startAt - ROOM_REMIND_WINDOW_MS, createdAt: Date.now(),
      };
      space.events.set(rec.id, rec);
      user.stats.eventCount = (user.stats.eventCount || 0) + 1;
      user.stats.eventAttendCount = (user.stats.eventAttendCount || 0) + 1;
      recordWeekly(user, 'events');
      checkAchievements(user);
      saveProfile(user);
      saveEntity(space.id, 'event', rec.id, rec);
      eventsBroadcast(space);
      pushNotice(space, `🎉 ${user.nickname} 发起了「${title}」（${category}）`, user.account, user.nickname);
      sendTo(ws, { type: 'eventCreated', id: rec.id });
    } else if (msg.type === 'eventRsvp') {
      const rec = space.events.get(msg.rsvpId);
      if (!rec) return sendTo(ws, serError('活动不存在'));
      if (rec.cancelled) return sendTo(ws, serError('活动已取消'));
      if (rec.startAt <= Date.now()) return sendTo(ws, serError('活动已开始，无法再变更参与状态'));
      const v = ['going', 'maybe', 'not_going'].includes(msg.status) ? msg.status : 'going';
      const rsvps = rec.rsvps || {};
      const prev = rsvps[user.account] || null;
      if (prev === v) return sendTo(ws, { type: 'eventRsvpChanged', rsvpId: rec.id, status: v });
      let going = 0;
      for (const [acc, val] of Object.entries(rsvps)) if (val === 'going' && acc !== user.account) going++;
      if (v === 'going' && rec.capacity && going >= rec.capacity) return sendTo(ws, serError('名额已满，无法参加'));
      rsvps[user.account] = v;
      rec.rsvps = rsvps;
      if (v === 'going' && prev !== 'going') {
        user.stats.eventAttendCount = (user.stats.eventAttendCount || 0) + 1;
        checkAchievements(user);
        saveProfile(user);
      }
      saveEntity(space.id, 'event', rec.id, rec);
      eventsBroadcast(space);
      sendTo(ws, { type: 'eventRsvpChanged', rsvpId: rec.id, status: v });
    } else if (msg.type === 'eventCancel') {
      const rec = space.events.get(msg.rsvpId);
      if (!rec) return sendTo(ws, serError('活动不存在'));
      if (rec.hostAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能取消自己发起的活动'));
      if (rec.cancelled) return sendTo(ws, serError('活动已取消'));
      rec.cancelled = true;
      rec.rsvps = {};
      saveEntity(space.id, 'event', rec.id, rec);
      eventsBroadcast(space);
      pushNotice(space, `取消活动：${rec.title}`, 'system', '系统');
      sendTo(ws, { type: 'eventCancelled', rsvpId: rec.id });
    } else if (msg.type === 'eventRemove') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除活动'));
      const rec = space.events.get(msg.rsvpId);
      if (!rec) return sendTo(ws, serError('活动不存在'));
      space.events.delete(rec.id);
      deleteEntity(space.id, 'event', rec.id);
      eventsBroadcast(space);
    }
  }

  return { handleEvents };
};
