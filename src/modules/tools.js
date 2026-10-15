'use strict';
// 工具借用模块：toolCreate / toolDelete / toolAdjust / toolBorrow / toolReturn
module.exports = function toolsModule(api) {
  const { spaceUserInfo, toolsPublic, toolWaitlistPublic, broadcast, TOOL_CATEGORIES, isAdmin, sendTo, serError, genId, saveEntity, deleteEntity, saveProfile, recordWeekly, broadcastLeaderboard, getUserByAccount, sendToUser, sendToAccount, checkAchievements, dueBorrowReminders } = api;

  function toolsBroadcast(space) {
    const info = spaceUserInfo(space.id);
    broadcast(space.id, 'tools', { tools: toolsPublic(space, info), waitlist: toolWaitlistPublic(space, info) });
  }

  // 借用归还/库存调整后，按排队顺序晋升「在借已归还」的第一位
  function promoteToolWaitlist(space) {
    let changed = false;
    const now = Date.now();
    for (const entry of [...space.toolWaitlist.values()]) {
      if (entry.status !== 'waiting') continue;
      const tool = space.tools.find((t) => t.id === entry.toolId);
      if (!tool || tool.available < entry.qty) continue;
      tool.available -= entry.qty;
      const borrow = { id: genId('bw', null), toolId: tool.id, borrowerAccount: entry.account, borrowerName: entry.name, qty: entry.qty, borrowedAt: now, dueAt: now + 7 * 86400000, returnedAt: null, status: 'borrowed', lastRemindedAt: null, soonRemindedAt: null, extensions: 0 };
      space.borrows.set(borrow.id, borrow);
      entry.status = 'promoted';
      entry.promotedAt = now;
      entry.borrowId = borrow.id;
      saveEntity(space.id, 'tool', tool.id, tool);
      saveEntity(space.id, 'borrow', borrow.id, borrow);
      saveEntity(space.id, 'toolWaitlist', entry.id, entry);
      const user = getUserByAccount(entry.account);
      if (user) {
        user.stats.borrowCount = (user.stats.borrowCount || 0) + 1;
        recordWeekly(user, 'borrows');
        checkAchievements(user);
        saveProfile(user);
        sendToUser(user.id, { type: 'toolWaitlistPromoted', toolId: tool.id, toolName: tool.name, borrowId: borrow.id });
      }
      changed = true;
    }
    return changed;
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
      promoteToolWaitlist(space);
      saveEntity(space.id, 'tool', tool.id, tool);
      toolsBroadcast(space);
    } else if (msg.type === 'toolWaitlist') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可排队'));
      const tool = space.tools.find((t) => t.id === msg.toolId);
      if (!tool) return sendTo(ws, serError('设备不存在'));
      const qty = parseInt(msg.qty, 10);
      if (!Number.isInteger(qty) || qty < 1) return sendTo(ws, serError('请输入有效数量'));
      if (qty > tool.total) return sendTo(ws, serError('所需数量超过库存'));
      if (tool.available >= qty) return sendTo(ws, serError('当前库存充足，请直接借用'));
      const exists = [...space.toolWaitlist.values()].find((w) => w.toolId === tool.id && w.account === user.account && w.status === 'waiting');
      if (exists) return sendTo(ws, serError('你已在排队中'));
      const entry = { id: genId('wl', null), toolId: tool.id, account: user.account, name: user.nickname, qty, status: 'waiting', createdAt: Date.now(), promotedAt: null, borrowId: null };
      space.toolWaitlist.set(entry.id, entry);
      saveEntity(space.id, 'toolWaitlist', entry.id, entry);
      toolsBroadcast(space);
      sendTo(ws, { type: 'toolWaitlistJoined', toolId: tool.id });
    } else if (msg.type === 'toolBorrow') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可借用'));
      const tool = space.tools.find((t) => t.id === msg.toolId);
      if (!tool) return sendTo(ws, serError('设备不存在'));
      const qty = parseInt(msg.qty, 10);
      if (!Number.isInteger(qty) || qty < 1) return sendTo(ws, serError('请输入有效借用数量'));
      if (qty > tool.available) return sendTo(ws, serError('库存不足，当前可用 ' + tool.available));
      tool.available -= qty;
      const borrow = { id: genId('bw', null), toolId: tool.id, borrowerAccount: user.account, borrowerName: user.nickname, qty, borrowedAt: Date.now(), dueAt: Date.now() + 7 * 86400000, returnedAt: null, status: 'borrowed', lastRemindedAt: null, soonRemindedAt: null, extensions: 0 };
      space.borrows.set(borrow.id, borrow);
      user.stats.borrowCount = (user.stats.borrowCount || 0) + 1;
      recordWeekly(user, 'borrows');
      saveProfile(user);
      saveEntity(space.id, 'tool', tool.id, tool);
      saveEntity(space.id, 'borrow', borrow.id, borrow);
      toolsBroadcast(space);
      broadcastLeaderboard(space);
    } else if (msg.type === 'toolExtend') {
      const borrow = space.borrows.get(msg.borrowId);
      if (!borrow) return sendTo(ws, serError('借用记录不存在'));
      if (borrow.status !== 'borrowed') return sendTo(ws, serError('该借用已归还，无法续借'));
      if (borrow.borrowerAccount !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能续借自己的借用'));
      if ((borrow.extensions || 0) >= 2) return sendTo(ws, serError('续借次数已达上限（最多 2 次）'));
      const days = parseInt(msg.days, 10);
      if (!Number.isInteger(days) || days < 1 || days > 30) return sendTo(ws, serError('续借天数需为 1-30 天'));
      borrow.extensions = (borrow.extensions || 0) + 1;
      borrow.dueAt = (borrow.dueAt || borrow.borrowedAt + 7 * 86400000) + days * 86400000;
      saveEntity(space.id, 'borrow', borrow.id, borrow);
      toolsBroadcast(space);
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
      promoteToolWaitlist(space);
      const borrower = getUserByAccount(borrow.borrowerAccount);
      if (borrower) {
        borrower.stats.borrowDuration += Math.max(0, Math.round((borrow.returnedAt - borrow.borrowedAt) / 60000));
        saveProfile(borrower);
        sendToUser(borrower.id, { type: 'stats', stats: borrower.stats, achievements: borrower.achievements });
      }
      saveEntity(space.id, 'tool', tool.id, tool);
      saveEntity(space.id, 'borrow', borrow.id, borrow);
      toolsBroadcast(space);
    } else if (msg.type === 'remindOverdue') {
      const now = Date.now();
      const reminders = dueBorrowReminders(space, now);
      if (!reminders.length) return sendTo(ws, serError('暂无逾期未还的借用'));
      for (const b of reminders) {
        b.lastRemindedAt = now;
        saveEntity(space.id, 'borrow', b.id, b);
        sendToAccount(b.borrowerAccount, { type: 'overdueReminder', borrowId: b.id });
      }
      toolsBroadcast(space);
      sendTo(ws, { type: 'remindOverdueSent', count: reminders.length });
    }
  }

  return { toolsBroadcast, handleTools };
};