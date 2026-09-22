'use strict';
// 工具借用模块：toolCreate / toolDelete / toolAdjust / toolBorrow / toolReturn
module.exports = function toolsModule(api) {
  const { spaceUserInfo, toolsPublic, broadcast, TOOL_CATEGORIES, isAdmin, sendTo, serError, genId, saveEntity, deleteEntity, saveProfile, recordWeekly, broadcastLeaderboard } = api;

  function toolsBroadcast(space) {
    const info = spaceUserInfo(space.id);
    broadcast(space.id, 'tools', { tools: toolsPublic(space, info) });
  }

  function handleTools(ws, user, space, msg) {
    if (msg.type === 'toolCreate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可新增设备'));
      const name = (msg.name || '').trim().slice(0, 30);
      const total = parseInt(msg.total, 10);
      if (!name) return sendTo(ws, serError('请输入设备名称'));
      if (!Number.isInteger(total) || total < 1) return sendTo(ws, serError('请输入有效库存数量'));
      const category = TOOL_CATEGORIES.includes(msg.category) ? msg.category : '其它';
      const tool = { id: genId('tl', null), name, category, total, available: total, location: (msg.location || '').trim().slice(0, 40), description: (msg.description || '').trim().slice(0, 100) };
      space.tools.push(tool);
      saveEntity(space.id, 'tool', tool.id, tool);
      toolsBroadcast(space);
    } else if (msg.type === 'toolDelete') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除设备'));
      const idx = space.tools.findIndex((t) => t.id === msg.toolId);
      if (idx < 0) return sendTo(ws, serError('设备不存在'));
      const tool = space.tools[idx];
      const hasBorrowed = [...space.borrows.values()].some((b) => b.toolId === tool.id && b.status === 'borrowed');
      if (hasBorrowed) return sendTo(ws, serError('该设备仍有未归还的借用，无法删除'));
      space.tools.splice(idx, 1);
      for (const b of [...space.borrows.values()]) if (b.toolId === tool.id) { space.borrows.delete(b.id); deleteEntity(space.id, 'borrow', b.id); }
      deleteEntity(space.id, 'tool', tool.id);
      toolsBroadcast(space);
    } else if (msg.type === 'toolAdjust') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可调整库存'));
      const tool = space.tools.find((t) => t.id === msg.toolId);
      if (!tool) return sendTo(ws, serError('设备不存在'));
      const total = parseInt(msg.total, 10);
      if (!Number.isInteger(total) || total < 1) return sendTo(ws, serError('请输入有效库存数量'));
      const diff = total - tool.total;
      if (tool.available + diff < 0) return sendTo(ws, serError('无法将库存调低到少于当前在借数量'));
      tool.total = total;
      tool.available += diff;
      saveEntity(space.id, 'tool', tool.id, tool);
      toolsBroadcast(space);
    } else if (msg.type === 'toolBorrow') {
      const tool = space.tools.find((t) => t.id === msg.toolId);
      if (!tool) return sendTo(ws, serError('设备不存在'));
      const qty = parseInt(msg.qty, 10);
      if (!Number.isInteger(qty) || qty < 1) return sendTo(ws, serError('请输入有效借用数量'));
      if (qty > tool.available) return sendTo(ws, serError('库存不足，当前可用 ' + tool.available));
      tool.available -= qty;
      const borrow = { id: genId('bw', null), toolId: tool.id, borrowerAccount: user.account, borrowerName: user.nickname, qty, borrowedAt: Date.now(), returnedAt: null, status: 'borrowed' };
      space.borrows.set(borrow.id, borrow);
      user.stats.borrowCount = (user.stats.borrowCount || 0) + 1;
      recordWeekly(user, 'borrows');
      saveProfile(user);
      saveEntity(space.id, 'tool', tool.id, tool);
      saveEntity(space.id, 'borrow', borrow.id, borrow);
      toolsBroadcast(space);
      broadcastLeaderboard(space);
    } else if (msg.type === 'toolReturn') {
      const borrow = space.borrows.get(msg.borrowId);
      if (!borrow) return sendTo(ws, serError('借用记录不存在'));
      if (borrow.status !== 'borrowed') return sendTo(ws, serError('该借用已归还'));
      if (borrow.borrowerAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能归还自己的借用'));
      const tool = space.tools.find((t) => t.id === borrow.toolId);
      if (!tool) return sendTo(ws, serError('设备不存在'));
      borrow.status = 'returned';
      borrow.returnedAt = Date.now();
      tool.available = Math.min(tool.total, tool.available + borrow.qty);
      saveEntity(space.id, 'tool', tool.id, tool);
      saveEntity(space.id, 'borrow', borrow.id, borrow);
      toolsBroadcast(space);
    }
  }

  return { toolsBroadcast, handleTools };
};