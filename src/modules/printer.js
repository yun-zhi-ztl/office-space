'use strict';
// 文印 / 共享打印机模块：printerCreate / printerUpdate / printerDelete /
// printSubmit / printDone / printPick / printCancel
// 管理员登记共享打印机（彩色/双面/位置/状态），成员提交打印任务进队列，
// 管理员/操作员标记「已打印待取」，本人取走闭环。
module.exports = function printerModule(api) {
  const { printBroadcast, isAdmin, sendTo, serError, genId, saveEntity, deleteEntity, PRINTER_STATUSES } = api;

  function handlePrint(ws, user, space, msg) {
    if (msg.type === 'printerCreate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可新增打印机'));
      const name = (msg.name || '').trim().slice(0, 30);
      if (!name) return sendTo(ws, serError('请输入打印机名称'));
      const printer = { id: genId('prt', null), name, location: (msg.location || '').trim().slice(0, 40), color: !!msg.color, duplex: !!msg.duplex, status: PRINTER_STATUSES.includes(msg.status) ? msg.status : 'ok', note: (msg.note || '').trim().slice(0, 120), createdAt: Date.now() };
      space.printers.push(printer);
      saveEntity(space.id, 'printer', printer.id, printer);
      printBroadcast(space);
    } else if (msg.type === 'printerUpdate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可编辑打印机'));
      const p = space.printers.find((x) => x.id === msg.id);
      if (!p) return sendTo(ws, serError('打印机不存在'));
      if (msg.name !== undefined) { const n = (msg.name || '').trim().slice(0, 30); if (n) p.name = n; }
      if (msg.location !== undefined) p.location = (msg.location || '').trim().slice(0, 40);
      if (msg.color !== undefined) p.color = !!msg.color;
      if (msg.duplex !== undefined) p.duplex = !!msg.duplex;
      if (msg.status !== undefined && PRINTER_STATUSES.includes(msg.status)) p.status = msg.status;
      if (msg.note !== undefined) p.note = (msg.note || '').trim().slice(0, 120);
      saveEntity(space.id, 'printer', p.id, p);
      printBroadcast(space);
    } else if (msg.type === 'printerDelete') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除打印机'));
      const idx = space.printers.findIndex((x) => x.id === msg.id);
      if (idx < 0) return sendTo(ws, serError('打印机不存在'));
      const p = space.printers[idx];
      const hasJobs = [...space.printJobs.values()].some((j) => j.printerId === p.id && (j.status === 'pending' || j.status === 'done'));
      if (hasJobs) return sendTo(ws, serError('该打印机仍有待打印或待取任务，无法删除'));
      space.printers.splice(idx, 1);
      deleteEntity(space.id, 'printer', p.id);
      printBroadcast(space);
    } else if (msg.type === 'printSubmit') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可提交打印'));
      const p = space.printers.find((x) => x.id === msg.printerId);
      if (!p) return sendTo(ws, serError('打印机不存在'));
      if (p.status !== 'ok') return sendTo(ws, serError('该打印机不可用（' + (p.status === 'maintenance' ? '维护中' : '离线') + '）'));
      const fileName = (msg.fileName || '').trim().slice(0, 60);
      if (!fileName) return sendTo(ws, serError('请输入文件名'));
      const pages = parseInt(msg.pages, 10);
      const copies = parseInt(msg.copies, 10);
      if (!Number.isInteger(pages) || pages < 1 || pages > 999) return sendTo(ws, serError('请输入有效页数'));
      if (!Number.isInteger(copies) || copies < 1 || copies > 99) return sendTo(ws, serError('请选择有效份数'));
      const job = { id: genId('pj', null), printerId: p.id, account: user.account, requesterName: user.nickname || user.account, fileName, pages, copies, color: !!msg.color, duplex: !!msg.duplex, note: (msg.note || '').trim().slice(0, 120), status: 'pending', createdAt: Date.now(), doneAt: 0, pickedAt: 0 };
      space.printJobs.set(job.id, job);
      saveEntity(space.id, 'print_job', job.id, job);
      printBroadcast(space);
    } else if (msg.type === 'printDone') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可标记已打印'));
      const job = space.printJobs.get(msg.id);
      if (!job) return sendTo(ws, serError('任务不存在'));
      if (job.status !== 'pending') return sendTo(ws, serError('仅待打印任务可标记已打印'));
      job.status = 'done';
      job.doneAt = Date.now();
      saveEntity(space.id, 'print_job', job.id, job);
      printBroadcast(space);
    } else if (msg.type === 'printPick') {
      const job = space.printJobs.get(msg.id);
      if (!job) return sendTo(ws, serError('任务不存在'));
      if (job.account !== user.account && !isAdmin(space, user.account)) return sendTo(ws, serError('只能取走自己的任务'));
      if (job.status !== 'done') return sendTo(ws, serError('该任务尚未就绪，待打印完成后领取'));
      job.status = 'picked';
      job.pickedAt = Date.now();
      saveEntity(space.id, 'print_job', job.id, job);
      printBroadcast(space);
    } else if (msg.type === 'printCancel') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可取消任务'));
      const job = space.printJobs.get(msg.id);
      if (!job) return sendTo(ws, serError('任务不存在'));
      if (job.status !== 'pending' && job.status !== 'done') return sendTo(ws, serError('当前状态不可取消'));
      job.status = 'cancelled';
      saveEntity(space.id, 'print_job', job.id, job);
      printBroadcast(space);
    }
  }

  return { printBroadcast, handlePrint };
};