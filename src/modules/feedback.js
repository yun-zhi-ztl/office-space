'use strict';
// 意见反馈模块：feedbackCreate / feedbackReply(admin) / feedbackClose(admin) / feedbackRemove(admin)
module.exports = function feedbackModule(api) {
  const { FEEDBACK_CATEGORIES, sendTo, serError, genId, saveEntity, deleteEntity, isAdmin, checkAchievements, saveProfile, feedbackBroadcast } = api;

  function handleFeedback(ws, user, space, msg) {
    if (msg.type === 'feedbackCreate') {
      const content = (msg.content || '').trim().slice(0, 500);
      if (!content) return sendTo(ws, serError('请填写反馈内容'));
      const category = FEEDBACK_CATEGORIES.includes(msg.category) ? msg.category : '建议';
      const rec = { id: genId('fb', null), account: user.account, name: user.nickname, anonymous: !!msg.anonymous, category, content, status: 'open', replies: [], createdAt: Date.now(), handledAt: null };
      space.feedbacks.set(rec.id, rec);
      saveEntity(space.id, 'feedback', rec.id, rec);
      feedbackBroadcast(space);
    } else if (msg.type === 'feedbackReply') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可回复意见反馈'));
      const rec = space.feedbacks.get(msg.feedbackId);
      if (!rec) return sendTo(ws, serError('反馈不存在'));
      if (rec.status === 'closed') return sendTo(ws, serError('该反馈已关闭，无法继续回复'));
      const content = (msg.content || '').trim().slice(0, 500);
      if (!content) return sendTo(ws, serError('请填写回复内容'));
      rec.replies = rec.replies || [];
      rec.replies.push({ id: genId('fbrp', null), account: user.account, name: user.nickname, content, createdAt: Date.now() });
      rec.status = 'answered';
      rec.handledAt = Date.now();
      user.stats.feedbackReplyCount = (user.stats.feedbackReplyCount || 0) + 1;
      checkAchievements(user);
      saveProfile(user);
      saveEntity(space.id, 'feedback', rec.id, rec);
      feedbackBroadcast(space);
    } else if (msg.type === 'feedbackClose') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可关闭意见反馈'));
      const rec = space.feedbacks.get(msg.feedbackId);
      if (!rec) return sendTo(ws, serError('反馈不存在'));
      if (rec.status === 'closed') return sendTo(ws, serError('该反馈已关闭'));
      rec.status = 'closed';
      saveEntity(space.id, 'feedback', rec.id, rec);
      feedbackBroadcast(space);
    } else if (msg.type === 'feedbackRemove') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除意见反馈'));
      const rec = space.feedbacks.get(msg.feedbackId);
      if (!rec) return sendTo(ws, serError('反馈不存在'));
      space.feedbacks.delete(rec.id);
      deleteEntity(space.id, 'feedback', rec.id);
      feedbackBroadcast(space);
    }
  }

  return { handleFeedback };
};
