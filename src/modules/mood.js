'use strict';
// 每日心情打卡模块：moodCheckIn（同一账号每天只能更新一次）
module.exports = function moodModule(api) {
  const { MOOD_EMOJIS, sendTo, serError, genId, saveEntity, todayKey, moodBroadcast } = api;

  function handleMood(ws, user, space, msg) {
    if (msg.type !== 'moodCheckIn') return;
    const emoji = MOOD_EMOJIS.includes(msg.emoji) ? msg.emoji : '😊';
    const key = todayKey();
    const existing = [...space.moods.values()].find((r) => r.account === user.account && r.date === key);
    if (existing) {
      existing.emoji = emoji;
      saveEntity(space.id, 'mood', existing.id, existing);
      moodBroadcast(space);
    } else {
      const rec = { id: genId('md', null), account: user.account, name: user.nickname, date: key, emoji, createdAt: Date.now() };
      space.moods.set(rec.id, rec);
      saveEntity(space.id, 'mood', rec.id, rec);
      moodBroadcast(space);
    }
    sendTo(ws, { type: 'moodCheckedIn', emoji });
  }

  return { handleMood };
};
