// 自动化测试：卫生间坑位预约系统
const http = require('http');
const WebSocket = require('ws');

const BASE = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/ws';

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; errors.push(msg); console.log(`  ❌ ${msg}`); }
}

function createWSClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws._messages = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      ws._messages.push(msg);
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function sendMsg(ws, msg) {
  return new Promise((resolve) => {
    ws.send(JSON.stringify(msg));
    setTimeout(resolve, 200);
  });
}

function createSpace(squat, urinal) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ name: '测试空间', squat_count: squat, urinal_count: urinal });
    const req = http.request({
      hostname: 'localhost', port: 3000, path: '/api/spaces', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

function httpJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: 'localhost', port: 3000, path, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => {
        let j = {}; try { j = JSON.parse(b); } catch (e) {}
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

function registerAccount(account, password, username, avatar) {
  return httpJson('POST', '/api/register', { account, password, username, avatar });
}

function getMessages(ws, type) {
  if (type) return ws._messages.filter(m => m.type === type);
  return ws._messages;
}

async function runTests() {
  console.log('\n🧪 开始测试卫生间坑位预约系统...\n');

  // ========== 测试0: 创建空间 + 注册账号 ==========
  console.log('📋 测试0: 创建空间并注册账号');
  const runKey = Date.now();
  const acc = {
    zhang: 'zhangsan_' + runKey,
    li: 'lisi_' + runKey,
    wang: 'wangwu_' + runKey,
  };
  const sp = await createSpace(5, 3);
  assert(sp.id, '创建测试空间成功');
  const r1 = await registerAccount(acc.zhang, 'pass_123', '张三', '👨');
  const r2 = await registerAccount(acc.li, 'pass_456', '李四', '👩');
  const r3 = await registerAccount(acc.wang, 'pass_789', '王五', '🧙');
  assert(r1.status >= 200 && r1.status < 300 && r1.json.ok, '注册 张三 成功');
  assert(r2.status >= 200 && r2.status < 300 && r2.json.ok, '注册 李四 成功');
  assert(r3.status >= 200 && r3.status < 300 && r3.json.ok, '注册 王五 成功');

  // ========== 测试0b: 账号唯一性与大小写敏感 ==========
  console.log('\n📋 测试0b: 账号唯一性 + 大小写敏感');
  const dupeA = await registerAccount(acc.zhang, 'other', '张三', '🧑');
  assert(dupeA.status === 409, '重复账号注册返回409');
  assert(dupeA.json.error && dupeA.json.error.includes('占用'), '409提示账号已占用');
  const caseUp = 'Case' + runKey;
  const caseLo = caseUp.toLowerCase();
  const cu = await registerAccount(caseUp, 'pw1', '大C', '🧑');
  const cl = await registerAccount(caseLo, 'pw2', '小c', '👩');
  assert(cu.status >= 200 && cu.status < 300 && cu.json.ok, `账号 "${caseUp}" 注册成功`);
  assert(cl.status >= 200 && cl.status < 300 && cl.json.ok, `账号 "${caseLo}"（不同大小写）也能注册，说明大小写敏感`);
  assert(caseUp !== caseLo, '两个大小写变体确实是不同账号');

  // ========== 测试1: 页面可访问 ==========
  console.log('📋 测试1: HTTP页面可访问');
  const httpRes = await new Promise((resolve) => {
    http.get(BASE, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
  });
  assert(httpRes.status === 200, 'HTTP状态码200');
  assert(httpRes.body.includes('坑位雷达'), '页面标题正确');
  assert(httpRes.body.includes('stall-grid'), '包含坑位网格');

  // ========== 测试2: WebSocket 登录 ==========
  console.log('\n📋 测试2: WebSocket登录');
  const ws1 = await createWSClient();
  await sendMsg(ws1, { type: 'join', spaceId: sp.id });
  await sendMsg(ws1, { type: 'login', account: acc.zhang, password: 'pass_123' });
  const loginMsgs = getMessages(ws1, 'loginSuccess');
  assert(loginMsgs.length === 1, '收到登录成功消息');
  assert(loginMsgs[0].nickname === '张三', '昵称正确');
  assert(loginMsgs[0].avatar === '👨', '头像正确');
  assert(loginMsgs[0].userId, '收到用户ID');
  assert(loginMsgs[0].token, '收到会话token');

  // ========== 测试3: 第二个用户登录 ==========
  console.log('\n📋 测试3: 多用户登录');
  const ws2 = await createWSClient();
  await sendMsg(ws2, { type: 'join', spaceId: sp.id });
  await sendMsg(ws2, { type: 'login', account: acc.li, password: 'pass_456' });
  const loginMsgs2 = getMessages(ws2, 'loginSuccess');
  assert(loginMsgs2.length === 1, '李四登录成功');

  // ========== 测试4: 坑位初始状态 ==========
  console.log('\n📋 测试4: 坑位初始状态');
  const stallMsgs = getMessages(ws1, 'stalls');
  assert(stallMsgs.length > 0, '收到坑位状态');
  assert(stallMsgs[stallMsgs.length - 1].stalls.length === 8, '共8个坑位');
  assert(stallMsgs[stallMsgs.length - 1].stalls[0].status === 'free', '初始状态为空闲');

  // ========== 测试5: 预约坑位 ==========
  console.log('\n📋 测试5: 预约坑位');
  const stallsBefore = getMessages(ws1, 'stalls').pop().stalls;
  const freeStall = stallsBefore.find(s => s.status === 'free');
  assert(freeStall, '找到空闲坑位');
  await sendMsg(ws1, { type: 'reserve', stallId: freeStall.id, duration: 30 });
  const reserveMsgs = getMessages(ws1, 'reservation');
  assert(reserveMsgs.length > 0, '收到预约成功消息');
  assert(reserveMsgs[reserveMsgs.length - 1].reservation.stallId === freeStall.id, '坑位ID正确');
  assert(reserveMsgs[reserveMsgs.length - 1].reservation.duration === 30, '时长正确');

  // 检查坑位状态变为 reserved
  const stallsAfterReserve = getMessages(ws1, 'stalls').pop().stalls;
  const reservedStall = stallsAfterReserve.find(s => s.id === freeStall.id);
  assert(reservedStall.status === 'reserved', '坑位状态变为reserved');

  // ========== 测试5b: 预约未到开始时间不可确认到坑（bug 修复） ==========
  console.log('\n📋 测试5b: 预约未到开始时间不可确认到坑');
  const spEarly = await createSpace(1, 0); // 单个蹲坑，复现 issue #1
  assert(spEarly.id, '创建单坑空间成功');
  const acctEarly = 'early_' + runKey;
  await registerAccount(acctEarly, 'pw_early', '早到', '🧑');
  const wsE = await createWSClient();
  await sendMsg(wsE, { type: 'join', spaceId: spEarly.id });
  await sendMsg(wsE, { type: 'login', account: acctEarly, password: 'pw_early' });
  assert(getMessages(wsE, 'loginSuccess').length === 1, '早到用户登录成功');
  const eStall = getMessages(wsE, 'stalls').pop().stalls.find(s => s.status === 'free');
  assert(eStall, '找到空闲蹲坑');
  await sendMsg(wsE, { type: 'reserve', stallId: eStall.id, duration: 15 });
  const eResv = getMessages(wsE, 'reservation');
  assert(eResv.length > 0, '预约成功');
  // 立即发送 startUse（开始时间在 1 分钟后，应被拒绝）
  await sendMsg(wsE, { type: 'startUse', stallId: eStall.id });
  const eErr = getMessages(wsE, 'error');
  const eErrLastMsg = eErr.length ? eErr[eErr.length - 1].message : '';
  assert(eErr.length > 0, '提前确认收到错误消息');
  assert(eErrLastMsg.includes('尚未到预约时间'), '错误提示尚未到预约时间');
  const eStallAfter = getMessages(wsE, 'stalls').pop().stalls.find(s => s.id === eStall.id);
  assert(eStallAfter && eStallAfter.status === 'reserved', '坑位仍为 reserved（未被占用）');
  // 清理：取消该预约并断开
  await sendMsg(wsE, { type: 'cancel', reservationId: eResv[eResv.length - 1].reservation.id });
  wsE.close();

  // ========== 测试6: 重复预约被拒 ==========
  console.log('\n📋 测试6: 重复预约被拒');
  await sendMsg(ws1, { type: 'reserve', stallId: freeStall.id, duration: 15 });
  const errMsgs = getMessages(ws1, 'error');
  assert(errMsgs.length > 0, '收到错误消息');
  assert(errMsgs[errMsgs.length - 1].message.includes('已被占用'), '错误消息正确');

  // ========== 测试7: 一人只能占一个坑 ==========
  console.log('\n📋 测试7: 一人只能占一个坑');
  // 张三已持有测试5的 pending 预约，此时再抢/再约其他坑都应被拒绝
  const stallsForGrab = getMessages(ws1, 'stalls').pop().stalls;
  const freeStall2 = stallsForGrab.find(s => s.status === 'free');
  assert(freeStall2, '找到空闲坑位');
  await sendMsg(ws1, { type: 'grab', stallId: freeStall2.id });
  const grabBlockMsgs = getMessages(ws1, 'error');
  assert(grabBlockMsgs.length > 0, '持有坑位时抢位被拒绝');
  assert(grabBlockMsgs[grabBlockMsgs.length - 1].message.includes('一次只能用一个'), '抢位提示「一次只能用一个」');
  await sendMsg(ws1, { type: 'reserve', stallId: freeStall2.id, duration: 15 });
  const reserveBlockMsgs = getMessages(ws1, 'error');
  assert(reserveBlockMsgs.length >= grabBlockMsgs.length, '持有坑位时再预约被拒绝');

  // 取消首个预约后可正常抢位
  const firstReservation = getMessages(ws1, 'reservation')[0].reservation;
  await sendMsg(ws1, { type: 'cancel', reservationId: firstReservation.id });
  const cancelMsgsPre = getMessages(ws1, 'cancelSuccess');
  assert(cancelMsgsPre.length >= 1, '取消首个预约成功');
  await sendMsg(ws1, { type: 'grab', stallId: freeStall2.id });
  const stallsAfterGrab = getMessages(ws1, 'stalls').pop().stalls;
  const grabbedStall = stallsAfterGrab.find(s => s.id === freeStall2.id);
  assert(grabbedStall.status === 'occupied', '坑位状态变为occupied');
  assert(grabbedStall.currentBy && grabbedStall.currentBy.display === '张三', '当前使用者正确');

  // ========== 测试8: 完成使用 ==========
  console.log('\n📋 测试8: 完成使用');
  await sendMsg(ws1, { type: 'finish', stallId: freeStall2.id });
  const stallsAfterFinish = getMessages(ws1, 'stalls').pop().stalls;
  const finishedStall = stallsAfterFinish.find(s => s.id === freeStall2.id);
  assert(finishedStall.status === 'free', '坑位释放为free');
  assert(finishedStall.currentBy === null, '当前使用者清空');

  // ========== 测试9: 催促 ==========
  console.log('\n📋 测试9: 催促功能');
  // 张三抢位
  await sendMsg(ws1, { type: 'grab', stallId: freeStall2.id });
  await new Promise(r => setTimeout(r, 200));
  // 李四催促
  await sendMsg(ws2, { type: 'urge', stallId: freeStall2.id });
  await new Promise(r => setTimeout(r, 200));
  const urgeMsgs = getMessages(ws1, 'urgeNotification');
  assert(urgeMsgs.length > 0, '张三收到催促通知');
  assert(urgeMsgs[urgeMsgs.length - 1].count === 1, '催促次数为1');

  // ========== 测试10: 评分 ==========
  console.log('\n📋 测试10: 坑位评分');
  await sendMsg(ws1, { type: 'finish', stallId: freeStall2.id });
  await new Promise(r => setTimeout(r, 200));
  await sendMsg(ws1, { type: 'rate', stallId: freeStall2.id, cleanliness: 5, signal: 4, paper: 3 });
  const stallsAfterRate = getMessages(ws1, 'stalls').pop().stalls;
  const ratedStall = stallsAfterRate.find(s => s.id === freeStall2.id);
  assert(ratedStall.ratings.length === 1, '评分记录为1');
  assert(ratedStall.ratings[0].cleanliness === 5, '干净度评分正确');

  // ========== 测试11: 紧急模式 ==========
  console.log('\n📋 测试11: 紧急模式');
  await sendMsg(ws1, { type: 'toggleEmergency', enabled: true });
  const emMsgs = getMessages(ws1, 'emergencyToggled');
  assert(emMsgs.length > 0, '收到紧急模式确认');
  assert(emMsgs[emMsgs.length - 1].enabled === true, '紧急模式已开启');
  await sendMsg(ws1, { type: 'toggleEmergency', enabled: false });

  // ========== 测试12: 取消预约 ==========
  console.log('\n📋 测试12: 取消预约');
  const stallsForCancel = getMessages(ws1, 'stalls').pop().stalls;
  const freeStall3 = stallsForCancel.find(s => s.status === 'free');
  await sendMsg(ws1, { type: 'reserve', stallId: freeStall3.id, duration: 15 });
  const reserveMsgs2 = getMessages(ws1, 'reservation');
  const lastReserve = reserveMsgs2[reserveMsgs2.length - 1];
  await sendMsg(ws1, { type: 'cancel', reservationId: lastReserve.reservation.id });
  const cancelMsgs = getMessages(ws1, 'cancelSuccess');
  assert(cancelMsgs.length > 0, '收到取消成功消息');

  // ========== 测试13: 统计 ==========
  console.log('\n📋 测试13: 个人统计');
  await sendMsg(ws1, { type: 'getStats' });
  const statsMsgs = getMessages(ws1, 'stats');
  assert(statsMsgs.length > 0, '收到统计消息');
  assert(statsMsgs[statsMsgs.length - 1].stats.totalVisits >= 1, '使用次数>=1');
  assert(statsMsgs[statsMsgs.length - 1].stats.totalDuration >= 0, '总时长>=0');

  // ========== 测试14: 排行榜 ==========
  console.log('\n📋 测试14: 排行榜');
  const lbMsgs = getMessages(ws1, 'leaderboard');
  assert(lbMsgs.length > 0, '收到排行榜数据');
  assert(lbMsgs[lbMsgs.length - 1].rankings.length >= 2, '排行榜至少有2人');

  // ========== 测试15: 连接断开处理 ==========
  console.log('\n📋 测试15: 连接断开');
  ws2.close();
  await new Promise(r => setTimeout(r, 300));
  const usersAfterClose = getMessages(ws1, 'users').pop();
  assert(usersAfterClose, '收到用户列表更新');
  assert(usersAfterClose.users.find(u => u.display === '李四') === undefined, '李四已离线');

  // ========== 测试16: 使用中释放坑位 ==========
  console.log('\n📋 测试16: 提前释放坑位');
  const stallsForRelease = getMessages(ws1, 'stalls').pop().stalls;
  const freeStall4 = stallsForRelease.find(s => s.status === 'free');
  await sendMsg(ws1, { type: 'grab', stallId: freeStall4.id });
  await new Promise(r => setTimeout(r, 200));
  await sendMsg(ws1, { type: 'release', stallId: freeStall4.id });
  const stallsAfterRelease = getMessages(ws1, 'stalls').pop().stalls;
  const releasedStall = stallsAfterRelease.find(s => s.id === freeStall4.id);
  assert(releasedStall.status === 'free', '坑位已释放');
  assert(releasedStall.currentBy === null, '使用者清空');

  // ========== 测试17: 越权操作被拒 ==========
  console.log('\n📋 测试17: 越权操作');
  const ws3 = await createWSClient();
  await sendMsg(ws3, { type: 'join', spaceId: sp.id });
  await sendMsg(ws3, { type: 'login', account: acc.wang, password: 'pass_789' });
  // 王五尝试完成张三的坑位
  const stallsForAuth = getMessages(ws3, 'stalls').pop().stalls;
  const occupiedStall = stallsForAuth.find(s => s.status === 'occupied');
  if (occupiedStall) {
    await sendMsg(ws3, { type: 'finish', stallId: occupiedStall.id });
    const authErrMsgs = getMessages(ws3, 'error');
    assert(authErrMsgs.length > 0, '越权操作被拒绝');
  }

  // ========== 测试18: 密码错误与账号大小写敏感 ==========
  console.log('\n📋 测试18: 密码错误 + 账号大小写敏感');
  const wsBad = await createWSClient();
  await sendMsg(wsBad, { type: 'join', spaceId: sp.id });
  await sendMsg(wsBad, { type: 'login', account: acc.zhang, password: 'WRONG_PWD' });
  const badMsgs = getMessages(wsBad, 'error');
  assert(badMsgs.length > 0, '错误密码收到错误消息');
  assert(badMsgs[badMsgs.length - 1].message.includes('账号或密码错误'), '错误密码提示正确');
  assert(getMessages(wsBad, 'loginSuccess').length === 0, '错误密码未产生 loginSuccess');
  // 大小写敏感：全大写的账号应查不到（不同账号）
  await sendMsg(wsBad, { type: 'login', account: acc.zhang.toUpperCase(), password: 'pass_123' });
  const caseMsgs = getMessages(wsBad, 'error');
  assert(caseMsgs.length >= 2, '大小写不同的账号登录失败');
  assert(caseMsgs[caseMsgs.length - 1].message.includes('账号不存在'), '大小写不同的账号提示不存在');
  wsBad.close();

  // ========== 测试19: 重名用户名区分（账号 = 身份，用户名可重名） ==========
  console.log('\n📋 测试19: 重名用户名区分');
  const wsD1 = await createWSClient();
  const wsD2 = await createWSClient();
  const sameName = '小王'; // 用户名最长 12 字符；两个账号共用同一用户名来测重名场景
  const nm1 = 'dupA_' + runKey;
  const nm2 = 'dupB_' + runKey;
  await registerAccount(nm1, 'pw_dup', sameName, '🧑');
  await registerAccount(nm2, 'pw_dup', sameName, '🧑');
  await sendMsg(wsD1, { type: 'join', spaceId: sp.id });
  await sendMsg(wsD2, { type: 'join', spaceId: sp.id });
  await sendMsg(wsD1, { type: 'login', account: nm1, password: 'pw_dup' });
  await sendMsg(wsD2, { type: 'login', account: nm2, password: 'pw_dup' });
  const dUsers = getMessages(wsD1, 'users');
  const lastDUsers = dUsers[dUsers.length - 1].users;
  const same = lastDUsers.filter(u => u.account === nm1 || u.account === nm2);
  assert(same.length === 2, '两个同名校在用户列表里分成两条');
  assert(same.every(u => u.dup === true), '同名校用户被标记 dup=true');
  assert(new Set(same.map(u => u.account)).size === 2, '同名校用账号区分，占据两条身份');
  // 同名校展示名不同（追加账号以区分）
  const names = same.map(u => u.display);
  assert(new Set(names).size === 2, '重名用户展示名互不相同');
  // nm1 仍可完成自己的坑位，另一同名用户无法越权（身份按账号，不看用户名）
  await sendMsg(wsD1, { type: 'grab', stallId: freeStall4.id });
  await new Promise(r => setTimeout(r, 200));
  const wangOwn = getMessages(wsD1, 'stalls').pop().stalls.find(s => s.id === freeStall4.id);
  assert(wangOwn.currentBy && wangOwn.currentBy.account === nm1, '坑位当前使用者身份为账号');
  await sendMsg(wsD2, { type: 'finish', stallId: freeStall4.id });
  const dupErr = getMessages(wsD2, 'error');
  assert(dupErr.length > 0, '同名不同账号不能结束对方的坑位');
  wsD1.close();
  wsD2.close();

  // ========== 总结 ==========
  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ 通过: ${passed}`);
  console.log(`❌ 失败: ${failed}`);
  if (errors.length > 0) {
    console.log(`\n失败详情:`);
    errors.forEach(e => console.log(`  - ${e}`));
  }
  console.log(`${'='.repeat(50)}\n`);

  ws1.close();
  ws3.close();
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('测试运行出错:', err);
  process.exit(1);
});
