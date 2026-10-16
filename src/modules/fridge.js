'use strict';
// 冰箱 / 食品管理模块：fridgeItemCreate / fridgeItemDelete / fridgeTake / fridgeRestock / fridgeReturn
// 登记共享冰箱内的食物饮料，成员取用 / 归还，自动扣减与恢复，支持保质期与库存预警。
module.exports = function fridgeModule(api) {
  const { spaceUserInfo, fridgeItemsPublic, fridgeStats, fridgeLogsPublic, broadcast, isAdmin, sendTo, serError, genId, saveEntity, deleteEntity, pushNotification, broadcastLeaderboard } = api;

  function fridgeBroadcast(space) {
    const info = spaceUserInfo(space.id);
    broadcast(space.id, 'fridge', { items: fridgeItemsPublic(space, info), stats: fridgeStats(space), logs: fridgeLogsPublic(space, info) });
  }

  function handleFridge(ws, user, space, msg) {
    if (msg.type === 'fridgeItemCreate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可登记冰箱物品'));
      const name = (msg.name || '').trim().slice(0, 30);
      if (!name) return sendTo(ws, serError('请输入物品名称'));
      const total = parseInt(msg.total, 10);
      if (!Number.isInteger(total) || total < 1) return sendTo(ws, serError('请输入有效数量'));
      const minAvailable = msg.minAvailable === undefined || msg.minAvailable === '' ? 1 : parseInt(msg.minAvailable, 10);
      if (!Number.isInteger(minAvailable) || minAvailable < 0 || minAvailable > total) return sendTo(ws, serError('库存阈值需为 0 到总库存之间'));
      const item = { id: genId('fd', null), name, category: (msg.category || '其它').slice(0, 20), total, available: total, minAvailable, unit: (msg.unit || '个').slice(0, 10), expiryDate: (msg.expiryDate || '').slice(0, 20), location: (msg.location || '').trim().slice(0, 40), note: (msg.note || '').trim().slice(0, 120) };
      space.fridgeItems.push(item);
      saveEntity(space.id, 'fridgeItem', item.id, item);
      if (item.available <= item.minAvailable) {
        pushNotification(space, { type: 'fridgeLowStock', level: 'warn', title: '冰箱库存告急', body: item.name + ' 可用 ' + item.available + '/' + item.total });
      }
      fridgeBroadcast(space);
    } else if (msg.type === 'fridgeItemDelete') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除冰箱物品'));
      const idx = space.fridgeItems.findIndex((i) => i.id === msg.id);
      if (idx < 0) return sendTo(ws, serError('物品不存在'));
      const item = space.fridgeItems[idx];
      space.fridgeItems.splice(idx, 1);
      deleteEntity(space.id, 'fridgeItem', item.id);
      fridgeBroadcast(space);
    } else if (msg.type === 'fridgeTake') {
      const item = space.fridgeItems.find((i) => i.id === msg.id);
      if (!item) return sendTo(ws, serError('物品不存在'));
      const qty = parseInt(msg.qty, 10);
      if (!Number.isInteger(qty) || qty < 1) return sendTo(ws, serError('请输入有效数量'));
      if (qty > item.available) return sendTo(ws, serError('可用数量不足'));
      item.available -= qty;
      saveEntity(space.id, 'fridgeItem', item.id, item);
      const log = { id: genId('fg', null), itemId: item.id, account: user.account, qty, type: 'take', at: Date.now() };
      space.fridgeLogs.set(log.id, log);
      saveEntity(space.id, 'fridgeLog', log.id, log);
      fridgeBroadcast(space);
      if (item.available <= item.minAvailable) {
        pushNotification(space, { type: 'fridgeLowStock', level: 'warn', title: '冰箱库存告急', body: item.name + ' 可用 ' + item.available + '/' + item.total });
      }
    } else if (msg.type === 'fridgeRestock') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可补货'));
      const item = space.fridgeItems.find((i) => i.id === msg.id);
      if (!item) return sendTo(ws, serError('物品不存在'));
      const qty = parseInt(msg.qty, 10);
      if (!Number.isInteger(qty) || qty < 1) return sendTo(ws, serError('请输入有效数量'));
      item.total += qty;
      item.available += qty;
      saveEntity(space.id, 'fridgeItem', item.id, item);
      const log = { id: genId('fg', null), itemId: item.id, account: user.account, qty, type: 'restock', at: Date.now() };
      space.fridgeLogs.set(log.id, log);
      saveEntity(space.id, 'fridgeLog', log.id, log);
      fridgeBroadcast(space);
    } else if (msg.type === 'fridgeReturn') {
      const item = space.fridgeItems.find((i) => i.id === msg.id);
      if (!item) return sendTo(ws, serError('物品不存在'));
      const qty = parseInt(msg.qty, 10);
      if (!Number.isInteger(qty) || qty < 1) return sendTo(ws, serError('请输入有效数量'));
      item.available = Math.min(item.total, item.available + qty);
      saveEntity(space.id, 'fridgeItem', item.id, item);
      const log = { id: genId('fg', null), itemId: item.id, account: user.account, qty, type: 'return', at: Date.now() };
      space.fridgeLogs.set(log.id, log);
      saveEntity(space.id, 'fridgeLog', log.id, log);
      fridgeBroadcast(space);
    }
  }

  return { fridgeBroadcast, handleFridge };
};
