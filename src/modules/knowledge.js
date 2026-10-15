'use strict';
// 知识库模块：knowledgeCreate / knowledgeEdit / knowledgeDelete / knowledgeLike / knowledgeComment
// 办公规章制度 / 操作指引 / 设备说明 / 常见问题，支持点赞、评论与检索。
module.exports = function knowledgeModule(api) {
  const { KNOWLEDGE_CATEGORIES, knowledgeBroadcast, sendTo, serError, genId, saveEntity, deleteEntity, isAdmin, pushNotice, checkAchievements, saveProfile, getUserByAccount } = api;

  function normalizeTags(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    return arr.map((t) => String(t == null ? '' : t).trim().slice(0, 12)).filter(Boolean).slice(0, 10);
  }

  function handleKnowledge(ws, user, space, msg) {
    if (msg.type === 'knowledgeCreate') {
      const title = (msg.title || '').trim().slice(0, 50);
      const content = (msg.content || '').trim().slice(0, 2000);
      if (!title) return sendTo(ws, serError('请输入标题'));
      if (!content) return sendTo(ws, serError('请输入内容'));
      const category = KNOWLEDGE_CATEGORIES.includes(msg.category) ? msg.category : '操作指引';
      const tags = normalizeTags(msg.tags);
      const rec = {
        id: genId('kb', null), title, content, category, tags,
        authorAccount: user.account, authorName: user.nickname,
        likes: [], comments: [], createdAt: Date.now(), updatedAt: Date.now(),
      };
      space.knowledge.set(rec.id, rec);
      user.stats.knowledgeCount = (user.stats.knowledgeCount || 0) + 1;
      checkAchievements(user);
      saveProfile(user);
      saveEntity(space.id, 'knowledge', rec.id, rec);
      knowledgeBroadcast(space);
      pushNotice(space, `📘 ${user.nickname} 新增了知识「${title}」`, user.account, user.nickname);
      sendTo(ws, { type: 'knowledgeCreated', id: rec.id });
    } else if (msg.type === 'knowledgeEdit') {
      const rec = space.knowledge.get(msg.id);
      if (!rec) return sendTo(ws, serError('文章不存在'));
      if (rec.authorAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能编辑自己的文章'));
      if (msg.title != null) rec.title = String(msg.title).trim().slice(0, 50) || rec.title;
      if (msg.content != null) rec.content = String(msg.content).trim().slice(0, 2000) || rec.content;
      if (msg.category != null && KNOWLEDGE_CATEGORIES.includes(msg.category)) rec.category = msg.category;
      if (msg.tags != null) rec.tags = normalizeTags(msg.tags);
      rec.updatedAt = Date.now();
      saveEntity(space.id, 'knowledge', rec.id, rec);
      knowledgeBroadcast(space);
      sendTo(ws, { type: 'knowledgeUpdated', id: rec.id });
    } else if (msg.type === 'knowledgeDelete') {
      const rec = space.knowledge.get(msg.id);
      if (!rec) return sendTo(ws, serError('文章不存在'));
      if (rec.authorAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能删除自己的文章'));
      space.knowledge.delete(rec.id);
      deleteEntity(space.id, 'knowledge', rec.id);
      knowledgeBroadcast(space);
      pushNotice(space, `删除知识：${rec.title}`, 'system', '系统');
    } else if (msg.type === 'knowledgeLike') {
      const rec = space.knowledge.get(msg.id);
      if (!rec) return sendTo(ws, serError('文章不存在'));
      const likes = rec.likes || [];
      const liked = likes.includes(user.account);
      if (liked) {
        likes.splice(likes.indexOf(user.account), 1);
      } else {
        likes.push(user.account);
        const owner = getUserByAccount(rec.authorAccount);
        if (owner) {
          owner.stats.knowledgeLikeCount = (owner.stats.knowledgeLikeCount || 0) + 1;
          if (owner.id === user.id) checkAchievements(owner);
          saveProfile(owner);
        }
      }
      rec.likes = likes;
      rec.updatedAt = Date.now();
      saveEntity(space.id, 'knowledge', rec.id, rec);
      knowledgeBroadcast(space);
      sendTo(ws, { type: 'knowledgeLiked', id: rec.id, liked: !liked });
    } else if (msg.type === 'knowledgeComment') {
      const rec = space.knowledge.get(msg.id);
      if (!rec) return sendTo(ws, serError('文章不存在'));
      const text = (msg.text || '').trim().slice(0, 300);
      if (!text) return sendTo(ws, serError('请输入评论内容'));
      const comments = rec.comments || [];
      if (comments.length >= 50) return sendTo(ws, serError('评论已达上限，请删除旧评论'));
      const comment = { id: genId('cm', null), account: user.account, name: user.nickname, text, createdAt: Date.now() };
      comments.push(comment);
      rec.comments = comments;
      rec.updatedAt = Date.now();
      saveEntity(space.id, 'knowledge', rec.id, rec);
      knowledgeBroadcast(space);
      sendTo(ws, { type: 'knowledgeCommented', id: rec.id, comment });
    }
  }

  return { handleKnowledge };
};
