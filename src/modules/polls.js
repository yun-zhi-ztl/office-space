'use strict';
// 投票模块：pollCreate / pollVote / pollClose / pollRemove(admin)
// 空间内快速决策（午饭 / 办公改进 / 时间安排），单账号单票，可匿名，可设截止时间。
module.exports = function pollsModule(api) {
  const { POLL_MAX_OPTIONS, pollsBroadcast, sendTo, serError, genId, saveEntity, deleteEntity, isAdmin, pushNotice, checkAchievements, saveProfile, recordWeekly } = api;

  function handlePolls(ws, user, space, msg) {
    if (msg.type === 'pollCreate') {
      const question = (msg.question || '').trim().slice(0, 50);
      if (!question) return sendTo(ws, serError('请输入投票问题'));
      const raw = Array.isArray(msg.options) ? msg.options : [];
      const options = [];
      for (const t of raw) {
        const text = String(t == null ? '' : t).trim().slice(0, 20);
        if (text) options.push({ id: genId('op', null), text });
        if (options.length >= POLL_MAX_OPTIONS) break;
      }
      if (options.length < 2) return sendTo(ws, serError('至少需要 2 个选项'));
      const deadline = msg.deadline ? parseInt(msg.deadline, 10) : null;
      if (deadline && deadline < Date.now()) return sendTo(ws, serError('截止时间需晚于当前时间'));
      const rec = {
        id: genId('pl', null), question, options,
        anonymous: !!msg.anonymous,
        creatorAccount: user.account, creatorName: user.nickname,
        status: 'open', createdAt: Date.now(), deadline: deadline || null, votes: {},
      };
      space.polls.set(rec.id, rec);
      user.stats.pollCreateCount = (user.stats.pollCreateCount || 0) + 1;
      recordWeekly(user, 'polls');
      checkAchievements(user);
      saveProfile(user);
      saveEntity(space.id, 'poll', rec.id, rec);
      pollsBroadcast(space);
      pushNotice(space, `🗳️ ${user.nickname} 发起了投票「${question}」`, user.account, user.nickname);
      sendTo(ws, { type: 'pollCreated', id: rec.id });
    } else if (msg.type === 'pollVote') {
      const rec = space.polls.get(msg.pollId);
      if (!rec) return sendTo(ws, serError('投票不存在'));
      if (rec.status === 'closed') return sendTo(ws, serError('投票已关闭'));
      if (rec.deadline && Date.now() >= rec.deadline) return sendTo(ws, serError('投票已截止'));
      const opt = (rec.options || []).find((o) => o.id === msg.optionId);
      if (!opt) return sendTo(ws, serError('选项不存在'));
      const votes = rec.votes || {};
      const prev = votes[user.account] || null;
      if (prev === opt.id) return sendTo(ws, { type: 'pollVoted', pollId: rec.id, optionId: opt.id });
      votes[user.account] = opt.id;
      rec.votes = votes;
      if (prev === null) {
        user.stats.pollVoteCount = (user.stats.pollVoteCount || 0) + 1;
        checkAchievements(user);
        saveProfile(user);
      }
      saveEntity(space.id, 'poll', rec.id, rec);
      pollsBroadcast(space);
      sendTo(ws, { type: 'pollVoted', pollId: rec.id, optionId: opt.id });
    } else if (msg.type === 'pollClose') {
      const rec = space.polls.get(msg.pollId);
      if (!rec) return sendTo(ws, serError('投票不存在'));
      if (rec.creatorAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能关闭自己发起的投票'));
      if (rec.status === 'closed') return sendTo(ws, serError('投票已关闭'));
      rec.status = 'closed';
      saveEntity(space.id, 'poll', rec.id, rec);
      pollsBroadcast(space);
      pushNotice(space, `投票已关闭：${rec.question}`, 'system', '系统');
      sendTo(ws, { type: 'pollClosed', pollId: rec.id });
    } else if (msg.type === 'pollRemove') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除投票'));
      const rec = space.polls.get(msg.pollId);
      if (!rec) return sendTo(ws, serError('投票不存在'));
      space.polls.delete(rec.id);
      deleteEntity(space.id, 'poll', rec.id);
      pollsBroadcast(space);
    }
  }

  return { handlePolls };
};
