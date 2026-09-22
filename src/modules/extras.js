'use strict';
// 扩展功能：setStatus / announce / suggestRoom / remindReturn + 公告推送
module.exports = function extrasModule(api) {
  const { users, broadcastUsers, sendTo, serError, genId, roomPublic, noticesBroadcast, roomReservationsPublic } = api;

  function pushNotice(space, text, fromAccount, fromName) {
    space.notices.unshift({ id: genId('n', null), text, from: fromName || fromAccount || '系统', ts: Date.now() });
    if (space.notices.length > 50) space.notices.length = 50;
    noticesBroadcast(space);
  }

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

  void roomReservationsPublic; //（备用：后续扩展需要时）
  return { setStatus: handleSetStatus, announce: handleAnnounce, suggestRoom: handleSuggestRoom, remindReturn: handleRemindReturn };
};