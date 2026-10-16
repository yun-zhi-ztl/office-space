'use strict';
// 请假审批模块：leaveCreate / leaveCancel / leaveApprove(admin) / leaveReject(admin)
module.exports = function leavesModule(api) {
  const { leavesBroadcast, LEAVE_CATEGORIES, sendTo, serError, genId, saveEntity, isAdmin, sendToAccount, pushNotification } = api;

  function handleLeaves(ws, user, space, msg) {
    if (msg.type === 'leaveCreate') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可提交请假'));
      if ([...space.leaves.values()].some((r) => r.account === user.account && r.status === 'pending')) {
        return sendTo(ws, serError('你已有待审批的请假申请，请先等待审批或取消'));
      }
      const category = LEAVE_CATEGORIES.includes(msg.category) ? msg.category : '事假';
      const reason = (msg.reason || '').trim().slice(0, 120);
      const startAt = Math.floor(+msg.startAt || 0);
      const endAt = Math.floor(+msg.endAt || 0);
      if (!(startAt > 0) || !(endAt > startAt)) return sendTo(ws, serError('请选择有效的请假时段'));
      if (startAt < Date.now()) return sendTo(ws, serError('请假开始时间不能早于当前时间'));
      const rec = { id: genId('lv', null), account: user.account, name: user.nickname, category, reason, startAt, endAt, status: 'pending', createdAt: Date.now(), decidedAt: null, decidedBy: null, decideNote: '', slaRemindedAt: null };
      space.leaves.set(rec.id, rec);
      saveEntity(space.id, 'leave', rec.id, rec);
      leavesBroadcast(space);
      pushNotification(space, { type: 'leavePending', level: 'info', title: '请假申请待审批', body: user.nickname + ' · ' + category });
      for (const acc of space.admins) sendToAccount(acc, { type: 'leaveCreated', leaveId: rec.id, category: category, name: rec.name });
    } else if (msg.type === 'leaveCancel') {
      const rec = space.leaves.get(msg.leaveId);
      if (!rec) return sendTo(ws, serError('请假记录不存在'));
      if (rec.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能取消自己的请假申请'));
      if (rec.status !== 'pending') return sendTo(ws, serError('该请假申请已不能取消'));
      rec.status = 'cancelled';
      saveEntity(space.id, 'leave', rec.id, rec);
      leavesBroadcast(space);
    } else if (msg.type === 'leaveApprove') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可审批请假申请'));
      const rec = space.leaves.get(msg.leaveId);
      if (!rec) return sendTo(ws, serError('请假记录不存在'));
      if (rec.status !== 'pending') return sendTo(ws, serError('仅待审批的请假申请可批准'));
      rec.status = 'approved';
      rec.decidedAt = Date.now();
      rec.decidedBy = user.account;
      saveEntity(space.id, 'leave', rec.id, rec);
      leavesBroadcast(space);
      sendToAccount(rec.account, { type: 'leaveApproved', leaveId: rec.id, category: rec.category, startAt: rec.startAt, endAt: rec.endAt });
    } else if (msg.type === 'leaveReject') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可审批请假申请'));
      const rec = space.leaves.get(msg.leaveId);
      if (!rec) return sendTo(ws, serError('请假记录不存在'));
      if (rec.status !== 'pending') return sendTo(ws, serError('仅待审批的请假申请可驳回'));
      rec.status = 'rejected';
      rec.decidedAt = Date.now();
      rec.decidedBy = user.account;
      rec.decideNote = (msg.decideNote || '').trim().slice(0, 120);
      saveEntity(space.id, 'leave', rec.id, rec);
      leavesBroadcast(space);
      sendToAccount(rec.account, { type: 'leaveRejected', leaveId: rec.id, category: rec.category, decideNote: rec.decideNote });
    } else if (msg.type === 'leaveBatchApprove') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可批量审批请假申请'));
      const pending = [...space.leaves.values()].filter((r) => r.status === 'pending');
      if (!pending.length) return sendTo(ws, serError('没有待审批的请假申请'));
      for (const rec of pending) {
        rec.status = 'approved';
        rec.decidedAt = Date.now();
        rec.decidedBy = user.account;
        saveEntity(space.id, 'leave', rec.id, rec);
        sendToAccount(rec.account, { type: 'leaveApproved', leaveId: rec.id, category: rec.category, startAt: rec.startAt, endAt: rec.endAt });
      }
      leavesBroadcast(space);
    } else if (msg.type === 'leaveBatchReject') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可批量审批请假申请'));
      const pending = [...space.leaves.values()].filter((r) => r.status === 'pending');
      if (!pending.length) return sendTo(ws, serError('没有待审批的请假申请'));
      const note = (msg.decideNote || '').trim().slice(0, 120);
      for (const rec of pending) {
        rec.status = 'rejected';
        rec.decidedAt = Date.now();
        rec.decidedBy = user.account;
        rec.decideNote = note;
        saveEntity(space.id, 'leave', rec.id, rec);
        sendToAccount(rec.account, { type: 'leaveRejected', leaveId: rec.id, category: rec.category, decideNote: note });
      }
      leavesBroadcast(space);
    }
  }

  return { handleLeaves, leavesBroadcast };
};
