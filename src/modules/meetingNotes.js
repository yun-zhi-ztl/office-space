'use strict';
// 会议纪要模块：meetingNoteCreate / meetingNoteEdit / meetingNoteRemove
// 挂在会议室预约下，会议结束后由组织者或管理员填写/更新，便于复盘与分享。
module.exports = function meetingNotesModule(api) {
  const { meetingNotesBroadcast, MEETING_NOTE_MAX_LEN, sendTo, serError, genId, saveEntity, deleteEntity, isAdmin, sendToAccount, pushNotification } = api;

  function handleMeetingNotes(ws, user, space, msg) {
    if (msg.type === 'meetingNoteCreate') {
      const res = space.roomReservations.get(msg.reservationId);
      if (!res) return sendTo(ws, serError('会议室预约不存在'));
      const title = (msg.title || '').trim().slice(0, 80);
      const content = (msg.content || '').trim().slice(0, MEETING_NOTE_MAX_LEN);
      if (!content) return sendTo(ws, serError('请填写会议纪要内容'));
      // 同一预约最多保留一条纪要，重复创建转为更新
      const existing = [...space.meetingNotes.values()].find((n) => n.reservationId === res.id);
      if (existing) {
        existing.title = title;
        existing.content = content;
        existing.updatedAt = Date.now();
        saveEntity(space.id, 'meeting_note', existing.id, existing);
        meetingNotesBroadcast(space);
        return sendTo(ws, { type: 'meetingNoteUpdated', noteId: existing.id });
      }
      const note = { id: genId('mn', null), reservationId: res.id, title, content, account: user.account, name: user.nickname, createdAt: Date.now(), updatedAt: Date.now() };
      space.meetingNotes.set(note.id, note);
      saveEntity(space.id, 'meeting_note', note.id, note);
      meetingNotesBroadcast(space);
      pushNotification(space, { type: 'meetingNoteCreated', level: 'info', title: '会议纪要已更新', body: title || res.title || '会议纪要' });
      for (const acc of space.admins) sendToAccount(acc, { type: 'meetingNoteCreated', noteId: note.id, reservationId: res.id });
    } else if (msg.type === 'meetingNoteEdit') {
      const note = space.meetingNotes.get(msg.noteId);
      if (!note) return sendTo(ws, serError('会议纪要不存在'));
      if (note.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能编辑自己创建的会议纪要'));
      const title = (msg.title || '').trim().slice(0, 80);
      const content = (msg.content || '').trim().slice(0, MEETING_NOTE_MAX_LEN);
      if (!content) return sendTo(ws, serError('请填写会议纪要内容'));
      note.title = title;
      note.content = content;
      note.updatedAt = Date.now();
      saveEntity(space.id, 'meeting_note', note.id, note);
      meetingNotesBroadcast(space);
      sendTo(ws, { type: 'meetingNoteUpdated', noteId: note.id });
    } else if (msg.type === 'meetingNoteRemove') {
      const note = space.meetingNotes.get(msg.noteId);
      if (!note) return sendTo(ws, serError('会议纪要不存在'));
      if (note.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能删除自己创建的会议纪要'));
      space.meetingNotes.delete(note.id);
      deleteEntity(space.id, 'meeting_note', note.id);
      meetingNotesBroadcast(space);
    } else if (msg.type === 'meetingNoteToTask') {
      // 会议纪要一键转待办：落到空间任务看板
      const note = space.meetingNotes.get(msg.noteId);
      if (!note) return sendTo(ws, serError('会议纪要不存在'));
      if (note.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能把自己创建的纪要转为任务'));
      const res = space.roomReservations.get(note.reservationId);
      const title = String(msg.title && String(msg.title).trim() || (note.title || (res && res.title) || '会议待办')).slice(0, 60);
      const priority = ['high', 'normal', 'low'].includes(msg.priority) ? msg.priority : 'high';
      const now = Date.now();
      const rec = { id: genId('tk', null), title, description: '来自会议纪要[' + ((res && res.title) || note.title || '会议') + ']：' + (note.content || ''), creatorAccount: user.account, creatorName: user.nickname, assigneeAccount: note.account, assigneeName: '', priority, status: 'pending', dueAt: null, completedAt: null, createdAt: now, updatedAt: now, comments: [] };
      space.tasks.set(rec.id, rec);
      saveEntity(space.id, 'task', rec.id, rec);
      api.tasksBroadcast(space);
      api.recordWeekly(user, 'tasks');
      api.checkAchievements(user);
      api.saveProfile(user);
      sendTo(ws, { type: 'taskCreated', taskId: rec.id, title: rec.title });
    }
  }

  return { handleMeetingNotes };
};
