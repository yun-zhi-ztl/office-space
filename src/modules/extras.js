'use strict';
// 扩展功能：setStatus / announce / suggestRoom / remindReturn + 公告推送
module.exports = function extrasModule(api) {
  const { users, broadcastUsers, sendTo, serError, roomPublic, noticesBroadcast, isAdmin, saveSpace, saveEntity, deleteEntity, broadcast, getUserByAccount, sendToUser, pushNotice, broadcastStalls, broadcastLeaderboard, createInvite, revokeInvite, invitesPublic, auditLog, auditLogsPublic } = api;

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
    sendTo(ws, { type: 'suggestRooms', suggestions: list.map((r) => roomPublic(space, r)) });
  }

  function handlePause(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可暂停/恢复空间'));
    const paused = !!msg.paused;
    const reason = (msg.reason || '').trim().slice(0, 40);
    space.paused = paused;
    space.pausedReason = paused ? reason : '';
    saveSpace(space);
    auditLog(space, user, paused ? '暂停空间' : '恢复空间', reason);
    broadcast(space.id, 'spacePaused', { paused, reason: space.pausedReason });
  }

  function handleRenameSpace(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可修改空间'));
    const name = (msg.name || '').trim().slice(0, 30);
    if (!name) return sendTo(ws, serError('空间名不能为空'));
    if (name === space.name) return sendTo(ws, { type: 'spaceRenamed', name });
    space.name = name;
    saveSpace(space);
    auditLog(space, user, '修改空间名', name);
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
    auditLog(space, user, makeAdmin ? '授予管理员' : '取消管理员', account);
    broadcastUsers(space);
    sendTo(ws, { type: 'adminSet', account, admin: makeAdmin, adminCount: space.admins.size });
    sendToUser(target.id, { type: 'adminSet', account, admin: makeAdmin, adminCount: space.admins.size });
  }

  // 移除成员：清理坑位占用后强制下线；管理员被移除时同步移除其管理员角色
  function handleKick(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可移除成员'));
    const account = (msg.account || '').trim().slice(0, 40);
    if (!account) return sendTo(ws, serError('请选择成员'));
    const target = getUserByAccount(account);
    if (!target || target.currentSpace !== space.id) return sendTo(ws, serError('成员必须为空间内在线成员'));
    if (target.account === user.account) return sendTo(ws, serError('不能移除自己'));
    if (isAdmin(space, target.account) && space.admins.size <= 1) return sendTo(ws, serError('至少保留一名管理员'));
    if (target.currentStall !== null) {
      const stall = space.stalls.find((s) => s.id === target.currentStall && s.reservation && s.reservation.account === target.account);
      if (stall) {
        const rr = stall.reservation.reservationId ? space.reservations.get(stall.reservation.reservationId) : null;
        stall.status = 'free'; stall.currentUser = null; stall.reservation = null;
        if (rr) space.reservations.delete(rr.id);
        space.urges.delete(stall.id);
        broadcastStalls(space);
      }
      target.currentStall = null;
    }
    for (const [rid, r] of [...space.reservations]) {
      if (r.account === target.account && r.status === 'pending') {
        const stall = space.stalls.find((s) => s.id === r.stallId);
        if (stall && stall.reservation && stall.reservation.reservationId === rid) { stall.status = 'free'; stall.reservation = null; }
        space.reservations.delete(rid);
      }
    }
    if (isAdmin(space, target.account)) space.admins.delete(target.account);
    space.clients.delete(target.ws);
    users.delete(target.id);
    saveSpace(space);
    broadcastUsers(space);
    broadcastLeaderboard(space);
    auditLog(space, user, '移除成员', target.account);
    pushNotice(space, `管理员 ${user.nickname} 移除了成员 ${target.nickname}`, user.account, user.nickname);
    if (target.ws && target.ws.readyState === 1) {
      target.ws.send(JSON.stringify({ type: 'spaceKicked', account: target.account, accountName: target.nickname, reason: '被管理员移除' }));
      target.ws.close();
    }
    sendTo(ws, { type: 'spaceKicked', account, accountName: target.nickname });
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

  function handleInviteCreate(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可创建邀请码'));
    const reusable = !!msg.reusable;
    const maxUses = Math.max(1, Math.min(100, parseInt(msg.maxUses, 10) || 1));
    const invite = createInvite(space, { reusable, maxUses, expiresAt: msg.expiresAt, createdBy: user.nickname });
    auditLog(space, user, '创建邀请码', `${invite.code}（${invite.reusable ? '可重复使用' : '一次性'}）`);
    sendTo(ws, { type: 'invites', invites: invitesPublic(space) });
  }

  function handleInviteRevoke(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可撤销邀请码'));
    const invite = revokeInvite(space, msg.inviteId);
    if (!invite) return sendTo(ws, serError('邀请码不存在'));
    auditLog(space, user, '撤销邀请码', invite.code);
    sendTo(ws, { type: 'invites', invites: invitesPublic(space) });
  }

  function handleInviteList(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可查看邀请码'));
    sendTo(ws, { type: 'invites', invites: invitesPublic(space) });
  }

  function handleInviteRequire(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可设置空间加入方式'));
    space.requireInvite = !!msg.requireInvite;
    saveSpace(space);
    sendTo(ws, { type: 'spaceInviteRequire', requireInvite: !!space.requireInvite });
    auditLog(space, user, space.requireInvite ? '开启邀请码加入' : '关闭邀请码加入', '');
  }

  function handleAuditList(ws, user, space, msg) {
    const limit = Math.min(200, Math.max(1, parseInt(msg.limit, 10) || 50));
    sendTo(ws, { type: 'auditLogs', logs: auditLogsPublic(space, limit) });
  }

  function handleAnnounceEdit(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可编辑公告'));
    const notice = space.notices.find((n) => n.id === msg.noticeId);
    if (!notice) return sendTo(ws, serError('公告不存在'));
    const text = (msg.text || '').trim().slice(0, 120);
    if (!text) return sendTo(ws, serError('公告不能为空'));
    notice.text = text;
    saveEntity(space.id, 'notice', notice.id, notice);
    noticesBroadcast(space);
    sendTo(ws, { type: 'noticeUpdated', noticeId: notice.id, text: notice.text });
    auditLog(space, user, '编辑公告', text);
  }

  function handleAnnouncePin(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可置顶公告'));
    const notice = space.notices.find((n) => n.id === msg.noticeId);
    if (!notice) return sendTo(ws, serError('公告不存在'));
    notice.pinned = !!msg.pinned;
    if (notice.pinned) {
      space.notices.sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || ((b.ts || 0) - (a.ts || 0)));
    } else {
      space.notices.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    }
    saveEntity(space.id, 'notice', notice.id, notice);
    noticesBroadcast(space);
    sendTo(ws, { type: 'noticeUpdated', noticeId: notice.id, text: notice.text, pinned: notice.pinned });
    auditLog(space, user, notice.pinned ? '置顶公告' : '取消置顶公告', notice.text);
  }

  function handleRemoveNotice(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除公告'));
    const idx = space.notices.findIndex((n) => n.id === msg.noticeId);
    if (idx === -1) return sendTo(ws, serError('公告不存在'));
    const [notice] = space.notices.splice(idx, 1);
    deleteEntity(space.id, 'notice', notice.id);
    auditLog(space, user, '删除公告', notice.text);
    noticesBroadcast(space);
    sendTo(ws, { type: 'noticeRemoved', noticeId: notice.id });
  }

  const NOTICE_REACTIONS = ['👍', '🎉', '😮', '🤝', '🔥'];
  function findNoticeReaction(notice, account, reaction) {
    return notice.reactions.findIndex((r) => r.account === account && r.reaction === reaction);
  }
  function handleNoticeReact(ws, user, space, msg) {
    const notice = space.notices.find((n) => n.id === msg.noticeId);
    if (!notice) return sendTo(ws, serError('公告不存在'));
    const reaction = String(msg.reaction || '').slice(0, 4);
    if (!NOTICE_REACTIONS.includes(reaction)) return sendTo(ws, serError('无效的回应表情'));
    const idx = findNoticeReaction(notice, user.account, reaction);
    if (idx >= 0) notice.reactions.splice(idx, 1);
    else notice.reactions.push({ account: user.account, reaction });
    saveEntity(space.id, 'notice', notice.id, notice);
    noticesBroadcast(space);
    sendTo(ws, { type: 'noticeReactionUpdated', noticeId: notice.id });
  }
  function handleNoticeUnreact(ws, user, space, msg) {
    const notice = space.notices.find((n) => n.id === msg.noticeId);
    if (!notice) return sendTo(ws, serError('公告不存在'));
    const reaction = String(msg.reaction || '').slice(0, 4);
    const idx = findNoticeReaction(notice, user.account, reaction);
    if (idx < 0) return sendTo(ws, serError('你尚未对该公告使用此回应'));
    notice.reactions.splice(idx, 1);
    saveEntity(space.id, 'notice', notice.id, notice);
    noticesBroadcast(space);
    sendTo(ws, { type: 'noticeReactionUpdated', noticeId: notice.id });
  }

  // 公告已读确认：成员标记已读 / 管理员设必读 / 管理员催未读
  function handleNoticeRead(ws, user, space, msg) {
    const notice = space.notices.find((n) => n.id === msg.noticeId);
    if (!notice) return sendTo(ws, serError('公告不存在'));
    notice.readBy = notice.readBy || [];
    if (!notice.readBy.includes(user.account)) {
      notice.readBy.push(user.account);
      saveEntity(space.id, 'notice', notice.id, notice);
      noticesBroadcast(space);
    }
    sendTo(ws, { type: 'noticeReadDone', noticeId: notice.id });
  }
  function handleNoticeRequire(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可设置必读'));
    const notice = space.notices.find((n) => n.id === msg.noticeId);
    if (!notice) return sendTo(ws, serError('公告不存在'));
    notice.requireRead = !notice.requireRead;
    notice.readBy = notice.readBy || [];
    saveEntity(space.id, 'notice', notice.id, notice);
    noticesBroadcast(space);
    auditLog(space, user, notice.requireRead ? '公告设为必读' : '取消公告必读', notice.text);
  }
  function handleNoticeRemindUnread(ws, user, space, msg) {
    if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可提醒未读'));
    const notice = space.notices.find((n) => n.id === msg.noticeId);
    if (!notice) return sendTo(ws, serError('公告不存在'));
    if (!notice.requireRead) return sendTo(ws, serError('该公告未设为必读，无法提醒'));
    const readBy = notice.readBy || [];
    const info = api.spaceUserInfo(space.id);
    let n = 0;
    for (const account of info.keys()) {
      if (readBy.includes(account)) continue;
      api.sendToAccount(account, { type: 'noticeReadReminder', noticeId: notice.id, text: notice.text });
      n++;
    }
    if (!n) return sendTo(ws, serError('无人未读'));
    sendTo(ws, { type: 'noticeRemindSent', count: n });
  }

  return { setStatus: handleSetStatus, announce: handleAnnounce, suggestRoom: handleSuggestRoom, remindReturn: handleRemindReturn, renameSpace: handleRenameSpace, adminSet: handleAdminSet, kick: handleKick, pause: handlePause, removeNotice: handleRemoveNotice, noticeReact: handleNoticeReact, noticeUnreact: handleNoticeUnreact, inviteCreate: handleInviteCreate, inviteRevoke: handleInviteRevoke, inviteList: handleInviteList, inviteRequire: handleInviteRequire, auditList: handleAuditList, announceEdit: handleAnnounceEdit, announcePin: handleAnnouncePin, noticeRead: handleNoticeRead, noticeRequire: handleNoticeRequire, noticeRemindUnread: handleNoticeRemindUnread };
};