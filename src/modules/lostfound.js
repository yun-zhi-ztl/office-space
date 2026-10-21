'use strict';
// 失物招领模块：lostReport / lostResolve / lostReopen / lostDelete
// 成员上报丢失 / 捡到物品并公示，方便主人认领；上报人或管理员可标记已解决 / 重新开启，管理员可删除。
module.exports = function lostFoundModule(api) {
  const { lostBroadcast, isAdmin, sendTo, serError, genId, saveEntity, deleteEntity, LOST_CATEGORIES } = api;

  function handleLostFound(ws, user, space, msg) {
    if (msg.type === 'lostReport') {
      const type = msg.lostType === 'found' ? 'found' : 'lost';
      const name = (msg.name || '').trim().slice(0, 30);
      if (!name) return sendTo(ws, serError('请输入物品名称'));
      const item = { id: genId('lf', null), type, category: LOST_CATEGORIES.includes(msg.category) ? msg.category : '其它', name, location: (msg.location || '').trim().slice(0, 40), description: (msg.description || '').trim().slice(0, 120), contact: (msg.contact || '').trim().slice(0, 60), status: 'open', reportedByAccount: user.account, reportedByName: user.nickname || user.account, createdAt: Date.now(), resolvedAt: 0 };
      space.lostFound.push(item);
      saveEntity(space.id, 'lost_found', item.id, item);
      lostBroadcast(space);
    } else if (msg.type === 'lostResolve') {
      const item = space.lostFound.find((x) => x.id === msg.id);
      if (!item) return sendTo(ws, serError('记录不存在'));
      if (item.reportedByAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能处理自己上报的记录'));
      if (item.status !== 'open') return sendTo(ws, serError('该记录已处理'));
      item.status = 'resolved';
      item.resolvedAt = Date.now();
      saveEntity(space.id, 'lost_found', item.id, item);
      lostBroadcast(space);
    } else if (msg.type === 'lostReopen') {
      const item = space.lostFound.find((x) => x.id === msg.id);
      if (!item) return sendTo(ws, serError('记录不存在'));
      if (item.reportedByAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能处理自己上报的记录'));
      if (item.status !== 'resolved') return sendTo(ws, serError('仅已解决的记录可重新开启'));
      item.status = 'open';
      item.resolvedAt = 0;
      saveEntity(space.id, 'lost_found', item.id, item);
      lostBroadcast(space);
    } else if (msg.type === 'lostDelete') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除记录'));
      const idx = space.lostFound.findIndex((x) => x.id === msg.id);
      if (idx < 0) return sendTo(ws, serError('记录不存在'));
      const item = space.lostFound[idx];
      space.lostFound.splice(idx, 1);
      deleteEntity(space.id, 'lost_found', item.id);
      lostBroadcast(space);
    }
  }

  return { lostBroadcast, handleLostFound };
};