'use strict';
// 物资库存台账模块：inventoryCreate / inventoryDelete / inventoryAdjust / inventoryIssue / inventoryReturn
module.exports = function inventoryModule(api) {
  const { spaceUserInfo, inventoryPublic, inventoryIssuesPublic, INVENTORY_CATEGORIES, broadcast, sendTo, serError, genId, saveEntity, deleteEntity, isAdmin, pushNotice, sendToAccount, isStockLow } = api;

  function inventoryBroadcast(space) {
    const info = spaceUserInfo(space.id);
    broadcast(space.id, 'inventory', { items: inventoryPublic(space, info), issues: inventoryIssuesPublic(space, info) });
  }

  // 库存告急：可用数跌破阈值时首次通知管理员并写入公告，恢复后重置提醒标记
  function notifyLowStock(space, item) {
    if (!item || !isStockLow(item)) return;
    if (item.lowNotifiedAt) return;
    item.lowNotifiedAt = Date.now();
    const min = item.minAvailable || 1;
    saveEntity(space.id, 'inventory', item.id, item);
    pushNotice(space, `⚠️ 物资库存告急：${item.name} 可用 ${item.available}/${item.total}（阈值 ${min}）`, 'system', '系统');
    for (const acc of space.admins) sendToAccount(acc, { type: 'inventoryLowStock', itemId: item.id, itemName: item.name, available: item.available, minAvailable: min });
  }
  function syncLowStock(space, item) {
    if (!item) return;
    if (isStockLow(item)) notifyLowStock(space, item);
    else if (item.lowNotifiedAt) { item.lowNotifiedAt = null; saveEntity(space.id, 'inventory', item.id, item); }
  }

  function handleInventory(ws, user, space, msg) {
    if (msg.type === 'inventoryCreate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可维护物资库存'));
      const name = (msg.name || '').trim().slice(0, 30);
      const unit = (msg.unit || '个').trim().slice(0, 10);
      if (!name) return sendTo(ws, serError('请输入物资名称'));
      const total = parseInt(msg.total, 10);
      if (!Number.isInteger(total) || total < 1) return sendTo(ws, serError('请输入有效库存数量'));
      const minAvailable = msg.minAvailable === undefined || msg.minAvailable === '' ? 1 : parseInt(msg.minAvailable, 10);
      if (!Number.isInteger(minAvailable) || minAvailable < 0 || minAvailable > total) return sendTo(ws, serError('库存阈值需为 0 到总库存之间'));
      const category = INVENTORY_CATEGORIES.includes(msg.category) ? msg.category : '其它';
      const item = { id: genId('iv', null), name, category, unit, total, available: total, minAvailable, location: (msg.location || '').trim().slice(0, 40), description: (msg.description || '').trim().slice(0, 100) };
      space.inventory.push(item);
      saveEntity(space.id, 'inventory', item.id, item);
      syncLowStock(space, item);
      inventoryBroadcast(space);
    } else if (msg.type === 'inventoryDelete') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除物资'));
      const item = space.inventory.find((it) => it.id === msg.itemId);
      if (!item) return sendTo(ws, serError('物资不存在'));
      if (item.available < item.total) return sendTo(ws, serError('该物资仍有未归还的领用记录，无法删除'));
      const idx = space.inventory.indexOf(item);
      space.inventory.splice(idx, 1);
      deleteEntity(space.id, 'inventory', item.id);
      inventoryBroadcast(space);
    } else if (msg.type === 'inventoryAdjust') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可调整库存'));
      const item = space.inventory.find((it) => it.id === msg.itemId);
      if (!item) return sendTo(ws, serError('物资不存在'));
      const total = parseInt(msg.total, 10);
      if (!Number.isInteger(total) || total < 1) return sendTo(ws, serError('请输入有效库存数量'));
      const minAvailable = msg.minAvailable === undefined || msg.minAvailable === '' ? item.minAvailable : parseInt(msg.minAvailable, 10);
      if (!Number.isInteger(minAvailable) || minAvailable < 0 || minAvailable > total) return sendTo(ws, serError('库存阈值需为 0 到总库存之间'));
      const diff = total - item.total;
      if (item.available + diff < 0) return sendTo(ws, serError('无法将库存调低到少于当前领用数量'));
      item.total = total;
      item.available += diff;
      item.minAvailable = minAvailable;
      syncLowStock(space, item);
      saveEntity(space.id, 'inventory', item.id, item);
      inventoryBroadcast(space);
    } else if (msg.type === 'inventoryIssue') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可领用'));
      const item = space.inventory.find((it) => it.id === msg.itemId);
      if (!item) return sendTo(ws, serError('物资不存在'));
      const qty = parseInt(msg.qty, 10);
      if (!Number.isInteger(qty) || qty < 1) return sendTo(ws, serError('请输入有效数量'));
      if (qty > item.available) return sendTo(ws, serError('库存不足，无法领用'));
      item.available -= qty;
      const issue = { id: genId('ivs', null), itemId: item.id, itemName: item.name, issuerAccount: user.account, issuerName: user.nickname, qty, status: 'issued', createdAt: Date.now(), returnedAt: null, dueAt: Date.now() + 3 * 86400000 };
      space.inventoryIssues.set(issue.id, issue);
      saveEntity(space.id, 'inventory_issue', issue.id, issue);
      syncLowStock(space, item);
      inventoryBroadcast(space);
    } else if (msg.type === 'inventoryReturn') {
      const issue = space.inventoryIssues.get(msg.issueId);
      if (!issue) return sendTo(ws, serError('领用记录不存在'));
      if (issue.status !== 'issued') return sendTo(ws, serError('该领用记录已归还'));
      if (issue.issuerAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能归还自己领用的物资'));
      const item = space.inventory.find((it) => it.id === issue.itemId);
      if (item) {
        item.available = Math.min(item.total, item.available + issue.qty);
        saveEntity(space.id, 'inventory', item.id, item);
        syncLowStock(space, item);
      }
      issue.status = 'returned';
      issue.returnedAt = Date.now();
      saveEntity(space.id, 'inventory_issue', issue.id, issue);
      inventoryBroadcast(space);
    }
  }

  return { inventoryBroadcast, handleInventory };
};
