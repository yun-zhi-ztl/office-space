'use strict';
// 待办任务模块：taskCreate / taskAssign / taskUpdate / taskStart / taskComplete / taskRemove / taskComment
// 空间级任务看板：成员可发起 / 指派 / 认领，推动闭环，支持跟进评论。
module.exports = function tasksModule(api) {
  const { TASK_PRIORITIES, accounts, sendTo, serError, genId, saveEntity, deleteEntity, isAdmin, pushNotification, tasksBroadcast, checkAchievements, saveProfile, recordWeekly } = api;

  function handleTasks(ws, user, space, msg) {
    if (msg.type === 'taskCreate') {
      const title = String(msg.title || '').trim().slice(0, 60);
      const description = String(msg.description || '').trim().slice(0, 300);
      const priority = TASK_PRIORITIES.includes(msg.priority) ? msg.priority : 'normal';
      const now = Date.now();
      let dueAt = null;
      if (msg.dueAt) {
        dueAt = parseInt(msg.dueAt, 10);
        if (!Number.isFinite(dueAt) || dueAt < now) return sendTo(ws, serError('截止时间需晚于当前时间'));
      }
      const assigneeAccount = String(msg.assigneeAccount || '').trim();
      if (assigneeAccount && !accounts.has(assigneeAccount)) return sendTo(ws, serError('指派对象不是空间成员'));
      if (!title) return sendTo(ws, serError('请输入任务标题'));
      const assignee = accounts.get(assigneeAccount);
      const rec = {
        id: genId('tk', null), title, description,
        creatorAccount: user.account, creatorName: user.nickname,
        assigneeAccount: assigneeAccount || '', assigneeName: assignee ? assignee.username : '',
        priority, status: 'pending', dueAt, completedAt: null,
        createdAt: now, updatedAt: now,
        comments: [],
      };
      space.tasks.set(rec.id, rec);
      user.stats.taskCreateCount = (user.stats.taskCreateCount || 0) + 1;
      recordWeekly(user, 'tasks');
      checkAchievements(user);
      saveProfile(user);
      saveEntity(space.id, 'task', rec.id, rec);
      tasksBroadcast(space);
      if (assigneeAccount) pushNotification(space, { type: 'taskAssigned', level: 'info', title: '新任务指派给你', body: rec.title });
      sendTo(ws, { type: 'taskCreated', id: rec.id });
    } else if (msg.type === 'taskAssign') {
      const rec = space.tasks.get(msg.taskId);
      if (!rec) return sendTo(ws, serError('任务不存在'));
      if (rec.creatorAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能指派自己创建的任务'));
      if (rec.status === 'done' || rec.status === 'cancelled') return sendTo(ws, serError('已结束的任务不可再指派'));
      const assigneeAccount = String(msg.assigneeAccount || '').trim();
      if (assigneeAccount && !accounts.has(assigneeAccount)) return sendTo(ws, serError('指派对象不是空间成员'));
      const assignee = accounts.get(assigneeAccount);
      rec.assigneeAccount = assigneeAccount;
      rec.assigneeName = assignee ? assignee.username : '';
      rec.updatedAt = Date.now();
      saveEntity(space.id, 'task', rec.id, rec);
      tasksBroadcast(space);
      if (assigneeAccount) pushNotification(space, { type: 'taskAssigned', level: 'info', title: '任务已指派给你', body: rec.title });
      sendTo(ws, { type: 'taskAssigned', taskId: rec.id });
    } else if (msg.type === 'taskUpdate') {
      const rec = space.tasks.get(msg.taskId);
      if (!rec) return sendTo(ws, serError('任务不存在'));
      if (rec.creatorAccount !== user.account && rec.assigneeAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只有创建人 / 负责人 / 管理员可修改'));
      if (rec.status === 'done' || rec.status === 'cancelled') return sendTo(ws, serError('已结束的任务不可修改'));
      if (msg.title !== undefined) rec.title = String(msg.title).trim().slice(0, 60) || rec.title;
      if (msg.description !== undefined) rec.description = String(msg.description).trim().slice(0, 300);
      if (msg.priority !== undefined && TASK_PRIORITIES.includes(msg.priority)) rec.priority = msg.priority;
      if (msg.dueAt !== undefined) {
        const dueAt = msg.dueAt ? parseInt(msg.dueAt, 10) : null;
        if (dueAt !== null && (!Number.isFinite(dueAt) || dueAt < Date.now())) return sendTo(ws, serError('截止时间需晚于当前时间'));
        rec.dueAt = dueAt;
      }
      rec.updatedAt = Date.now();
      saveEntity(space.id, 'task', rec.id, rec);
      tasksBroadcast(space);
      sendTo(ws, { type: 'taskUpdated', taskId: rec.id });
    } else if (msg.type === 'taskStart') {
      const rec = space.tasks.get(msg.taskId);
      if (!rec) return sendTo(ws, serError('任务不存在'));
      if (rec.assigneeAccount !== user.account && rec.creatorAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只有负责人 / 创建人 / 管理员可推进'));
      if (rec.status === 'done' || rec.status === 'cancelled') return sendTo(ws, serError('任务已结束'));
      rec.status = 'in_progress';
      rec.updatedAt = Date.now();
      saveEntity(space.id, 'task', rec.id, rec);
      tasksBroadcast(space);
      sendTo(ws, { type: 'taskStarted', taskId: rec.id });
    } else if (msg.type === 'taskComplete') {
      const rec = space.tasks.get(msg.taskId);
      if (!rec) return sendTo(ws, serError('任务不存在'));
      if (rec.assigneeAccount !== user.account && rec.creatorAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只有负责人 / 创建人 / 管理员可完成'));
      if (rec.status === 'done') return sendTo(ws, serError('任务已完成'));
      if (rec.status === 'cancelled') return sendTo(ws, serError('任务已取消'));
      rec.status = 'done';
      rec.completedAt = Date.now();
      rec.updatedAt = rec.completedAt;
      user.stats.taskDoneCount = (user.stats.taskDoneCount || 0) + 1;
      checkAchievements(user);
      saveProfile(user);
      saveEntity(space.id, 'task', rec.id, rec);
      tasksBroadcast(space);
      pushNotification(space, { type: 'taskCompleted', level: 'success', title: '任务已完成', body: rec.title });
      sendTo(ws, { type: 'taskCompleted', taskId: rec.id });
    } else if (msg.type === 'taskRemove') {
      const rec = space.tasks.get(msg.taskId);
      if (!rec) return sendTo(ws, serError('任务不存在'));
      if (rec.creatorAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只有创建人或管理员可删除'));
      space.tasks.delete(rec.id);
      deleteEntity(space.id, 'task', rec.id);
      tasksBroadcast(space);
      sendTo(ws, { type: 'taskRemoved', taskId: rec.id });
    } else if (msg.type === 'taskComment') {
      const rec = space.tasks.get(msg.taskId);
      if (!rec) return sendTo(ws, serError('任务不存在'));
      const allowed = rec.creatorAccount === user.account || rec.assigneeAccount === user.account || isAdmin(space, user.account);
      if (!allowed) return sendTo(ws, serError('只有创建人、负责人或管理员可评论'));
      const text = String(msg.text || '').trim().slice(0, 200);
      if (!text) return sendTo(ws, serError('请输入评论内容'));
      const comments = rec.comments || [];
      if (comments.length >= 30) return sendTo(ws, serError('任务评论已达上限（30 条）'));
      const comment = { id: genId('tc', null), account: user.account, name: user.nickname, text, createdAt: Date.now() };
      comments.push(comment);
      rec.comments = comments;
      rec.updatedAt = Date.now();
      saveEntity(space.id, 'task', rec.id, rec);
      tasksBroadcast(space);
      sendTo(ws, { type: 'taskCommented', taskId: rec.id, comment });
    }
  }

  return { handleTasks };
};
