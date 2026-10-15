'use strict';
// 扩展功能：setStatus / announce / suggestRoom / remindReturn + 公告推送
module.exports = function extrasModule(api) {
  const { users, broadcastUsers, sendTo, serError, roomPublic, noticesBroadcast, isAdmin, saveSpace, deleteEntity, broadcast, getUserByAccount, sendToUser, pushNotice } = api;

  function handleSetStatus(ws, user, space, msg) {
    const label = (msg.label || '').trim().slice(0, 8) || '在岗';
    const emoji = (msg.emoji || '').slice(0, 4) || '';
    user.status = { label, emoji };
    broadcastUsers(space);
    sendTo(ws, { type: 'statusSet', status: user.status });
  }

  function handleAnnounce(ws, user, space, msg) {
    const text = (msg.text || '').trim().slice(0, 120);
    if (!text) return sendTo(ws, serError('公告不能为空'));
    pushNotice(space, text, user.account, user.nickname);
  }

  function suggestRooms(space, startAt, endAt, capacity) {
    const st = Math.floor(+startAt || 0), en = Math.floor(+endAt || 0);
    if (!(st > 0) || !(en > st)) return [];
    let list = space.rooms.filter((r) => ![...space.roomReservations.values()].some((x) => x.roomId === r.id && (x.status === 'pending' || x.status === 'active') && st < x.endAt && en > x.startAt));
    if (Number.isInteger(capacity) && capacity > 0) list = list.filter((r) => r.capacity >= capacity);
    return list.sort((a, b) => a.capacity - b.capacity);
  }
  function handleSuggestRoom(ws, user, space, msg) {
    const capacity = parseInt(msg.capacity, 10);
    const list = suggestRooms(space, msg.startAt, msg.endAt, capacity);
    sendTo(ws, { type: 'suggestRooms', suggestions: list.map(roomPublic) });
  }

  function handlePause(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可暂停/恢复空间'));
    const paused = !!msg.paused;
    const reason = (msg.reason || '').trim().slice(0, 40);
    space.paused = paused;
    space.pausedReason = paused ? reason : '';
    saveSpace(space);
    broadcast(space.id, 'spacePaused', { paused, reason: space.pausedReason });
  }

  function handleRenameSpace(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可修改空间'));
    const name = (msg.name || '').trim().slice(0, 30);
    if (!name) return sendTo(ws, serError('空间名不能为空'));
    if (name === space.name) return sendTo(ws, { type: 'spaceRenamed', name });
    space.name = name;
    saveSpace(space);
    broadcast(space.id, 'spaceRenamed', { name });
  }

  function handleAdminSet(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可管理管理员'));
    const account = (msg.account || '').trim().slice(0, 40);
    if (!account) return sendTo(ws, serError('请选择成员'));
    const target = getUserByAccount(account);
    if (!target || target.currentSpace !== space.id) return sendTo(ws, serError('成员必须为空间内在线成员'));
    const makeAdmin = !!msg.admin;
    if (space.admins.has(account) === makeAdmin) return sendTo(ws, serError(makeAdmin ? '该成员已是管理员' : '该成员已不是管理员'));
    if (!makeAdmin && space.admins.size === 1) return sendTo(ws, serError('至少保留一名管理员，无法移除最后一名管理员'));
    if (makeAdmin) space.admins.add(account); else space.admins.delete(account);
    saveSpace(space);
    broadcastUsers(space);
    sendTo(ws, { type: 'adminSet', account, admin: makeAdmin, adminCount: space.admins.size });
    sendToUser(target.id, { type: 'adminSet', account, admin: makeAdmin, adminCount: space.admins.size });
  }

  function handleRemindReturn(ws, user, space, msg) {
    const b = space.borrows.get(msg.borrowId);
    if (!b || b.status !== 'borrowed') return sendTo(ws, serError('借用记录不存在或已归还'));
    if (b.borrowerAccount === user.account) return sendTo(ws, serError('自己的借用无需提醒'));
    let n = 0;
    for (const [, u] of users) if (u.currentSpace === space.id && u.account === b.borrowerAccount && u.ws && u.ws.readyState === 1) { u.ws.send(JSON.stringify({ type: 'borrowReminder', borrowId: b.id, from: user.nickname })); n++; }
    if (n === 0) return sendTo(ws, serError('借用人当前离线，无法提醒'));
    pushNotice(space, `提醒 ${b.borrowerName} 归还设备`, user.account, user.nickname);
    sendTo(ws, { type: 'remindSent', count: n });
  }

  function handleRemoveNotice(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除公告'));
    const idx = space.notices.findIndex((n) => n.id === msg.noticeId);
    if (idx === -1) return sendTo(ws, serError('公告不存在'));
    const [notice] = space.notices.splice(idx, 1);
    deleteEntity(space.id, 'notice', notice.id);
    noticesBroadcast(space);
    sendTo(ws, { type: 'noticeRemoved', noticeId: notice.id });
  }

  return { setStatus: handleSetStatus, announce: handleAnnounce, suggestRoom: handleSuggestRoom, remindReturn: handleRemindReturn, renameSpace: handleRenameSpace, adminSet: handleAdminSet, pause: handlePause, removeNotice: handleRemoveNotice };
};