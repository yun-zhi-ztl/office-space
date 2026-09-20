// 自动化测试：OfficeSpace · 办公空间管理
// 覆盖五模块：会议室 / 工具借用 / 物资申领 / 报修 / 坑位看板
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
    ws.on('message', (data) => { try { ws._messages.push(JSON.parse(data)); } catch {} });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
function sendMsg(ws, msg, wait = 220) {
  return new Promise((resolve) => { ws.send(JSON.stringify(msg)); setTimeout(resolve, wait); });
}
function httpJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ hostname: 'localhost', port: 3000, path, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const reg = (a, p, u) => httpJson('POST', '/api/register', { account: a, password: p, username: u, avatar: '🧑' });
const mk = (ws, type) => ws._messages.filter(m => m.type === type);
const last = (ws, type) => { const a = mk(ws, type); return a[a.length - 1]; };

async function loginTo(ws, spaceId, account, password) {
  await sendMsg(ws, { type: 'join', spaceId });
  await sendMsg(ws, { type: 'login', account, password });
}

async function runTests() {
  console.log('\n🧪 开始测试 OfficeSpace · 办公空间管理...\n');
  const runKey = Date.now();
  const ADMIN = 'boss_' + runKey;
  const MEMBER = 'staff_' + runKey;

  // ========== 测试0: 创建空间 + 注册账号 ==========
  console.log('📋 测试0: 创建空间并注册账号');
  const sp = (await httpJson('POST', '/api/spaces', { name: '测试办公室', squat_count: 3, urinal_count: 2 })).json;
  assert(sp.id, '创建空间成功');
  const r1 = await reg(ADMIN, 'pw', '老板');
  const r2 = await reg(MEMBER, 'pw', '员工');
  assert(r1.json.ok && r2.json.ok, '注册两个账号成功');

  // ========== 测试1: 页面可访问 ==========
  console.log('\n📋 测试1: HTTP 页面可访问');
  const httpRes = await new Promise((resolve) => {
    http.get(BASE, (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  });
  assert(httpRes.status === 200, 'HTTP 状态码 200');
  assert(httpRes.body.includes('OfficeSpace'), '页面包含 OfficeSpace 标题');

  // ========== 测试2: admin 登录 + 角色 ==========
  console.log('\n📋 测试2: 登录与角色');
  const w1 = await createWSClient();
  await loginTo(w1, sp.id, ADMIN, 'pw');
  const l1 = last(w1, 'loginSuccess');
  assert(l1 && l1.account === ADMIN, 'admin 登录成功');
  assert(l1.role === 'admin', '空间首个用户为 admin');
  const ulist = last(w1, 'users');
  assert(ulist && ulist.users.some(u => u.account === ADMIN && u.role === 'admin'), '用户列表含 admin 角色');

  // ========== 测试3: 会议室 ==========
  console.log('\n📋 测试3: 会议室（创建/预约/冲突/取消）');
  await sendMsg(w1, { type: 'roomCreate', name: '大会议室', capacity: 10, location: '3F-01', description: '投影+白板' });
  let rooms = last(w1, 'rooms');
  assert(rooms && rooms.rooms.length === 1, 'admin 创建会议室成功');
  const roomId = rooms.rooms[0].id;
  // member 预约
  const w2 = await createWSClient();
  await loginTo(w2, sp.id, MEMBER, 'pw');
  const l2 = last(w2, 'loginSuccess');
  assert(l2.role === 'member', 'member 登录成功（非 admin）');
  const t0 = Date.now();
  await sendMsg(w2, { type: 'roomBook', roomId, startAt: t0 + 10 * 60000, endAt: t0 + 40 * 60000, title: '评审会' });
  rooms = last(w2, 'rooms');
  assert(rooms && rooms.reservations.length === 1 && rooms.reservations[0].status === 'pending', 'member 预约会议室成功');
  const resId = rooms.reservations[0].id;
  // 冲突检测：另一账号预约重叠时段
  const wA = await createWSClient();
  await loginTo(wA, sp.id, ADMIN, 'pw');
  await sendMsg(wA, { type: 'roomBook', roomId, startAt: t0 + 20 * 60000, endAt: t0 + 50 * 60000 });
  const errsA = mk(wA, 'error');
  assert(errsA.length > 0 && errsA[errsA.length - 1].message.includes('已被预约'), '重叠时段预约被拒绝(冲突检测)');
  // 取消自己的预约
  await sendMsg(w2, { type: 'reservationCancel', reservationId: resId });
  rooms = last(w2, 'rooms');
  const cancelled = rooms.reservations.find(r => r.id === resId);
  assert(cancelled && cancelled.status === 'cancelled', 'member 取消自己的预约成功');
  // RBAC：member 不能创建会议室
  await sendMsg(w2, { type: 'roomCreate', name: '小间', capacity: 4 });
  const errsRBAC = mk(w2, 'error');
  assert(errsRBAC.length > 0 && errsRBAC[errsRBAC.length - 1].message.includes('仅管理员'), 'member 新增会议室被拒(RBAC)');

  // ========== 测试4: 工具借用 ==========
  console.log('\n📋 测试4: 工具借用（创建/借用/不足/归还）');
  await sendMsg(w1, { type: 'toolCreate', name: '测试机', category: '测试电脑', total: 2, location: '3F 机柜' });
  let tools = last(w1, 'tools');
  assert(tools && tools.tools.length === 1 && tools.tools[0].available === 2, 'admin 创建设备成功(库存2)');
  const toolId = tools.tools[0].id;
  await sendMsg(w2, { type: 'toolBorrow', toolId, qty: 2 });
  tools = last(w2, 'tools');
  const borrowed1 = tools.tools.find(t => t.id === toolId);
  assert(borrowed1 && borrowed1.available === 0 && borrowed1.borrowedCount === 2, 'member 借用 2 台成功');
  // 库存不足
  await sendMsg(w2, { type: 'toolBorrow', toolId, qty: 1 });
  const errB = mk(w2, 'error');
  assert(errB.length > 0 && errB[errB.length - 1].message.includes('库存不足'), '超库存借用被拒');
  // 归还
  const bwid = borrowed1.activeBorrows[0].id;
  await sendMsg(w2, { type: 'toolReturn', borrowId: bwid });
  tools = last(w2, 'tools');
  const returned1 = tools.tools.find(t => t.id === toolId);
  assert(returned1 && returned1.available === 2 && returned1.borrowedCount === 0, '归还后库存恢复');

  // ========== 测试5: 物资申领 ==========
  console.log('\n📋 测试5: 物资申领（提交/处理/自处理拒绝）');
  await sendMsg(w2, { type: 'materialRequest', name: '5号电池', qty: 4, unit: '节', reason: '遥控器没电' });
  let mats = last(w2, 'materials');
  assert(mats && mats.requests.length === 1 && mats.requests[0].status === 'pending', 'member 提交申领成功');
  const reqId = mats.requests[0].id;
  // 自己不能处理
  await sendMsg(w2, { type: 'materialFulfill', requestId: reqId });
  const errSelf = mk(w2, 'error');
  assert(errSelf.length > 0 && errSelf[errSelf.length - 1].message.includes('不能处理自己的'), '不能处理自己的申领');
  // 他人处理为 fulfilled
  await sendMsg(w1, { type: 'materialFulfill', requestId: reqId });
  mats = last(w1, 'materials');
  const fulfilled = mats.requests.find(r => r.id === reqId);
  assert(fulfilled && fulfilled.status === 'fulfilled', '他人可将申领置为已满足');

  // ========== 测试6: 报修 ==========
  console.log('\n📋 测试6: 报修（提交/状态流转/越权取消）');
  await sendMsg(w2, { type: 'repairCreate', category: '灯光', location: '3F 走廊', description: '灯管闪烁' });
  let repairs = last(w2, 'repairs');
  assert(repairs && repairs.repairs.length === 1 && repairs.repairs[0].status === 'reported', 'member 提交报修成功');
  const repairId = repairs.repairs[0].id;
  await sendMsg(w1, { type: 'repairUpdate', repairId, status: 'in_progress' });
  repairs = last(w1, 'repairs');
  assert(repairs.repairs.find(r => r.id === repairId).status === 'in_progress', '报修进入处理中');
  await sendMsg(w1, { type: 'repairUpdate', repairId, status: 'resolved' });
  repairs = last(w1, 'repairs');
  assert(repairs.repairs.find(r => r.id === repairId).status === 'resolved', '报修已解决');
  // 他人不能取消成员上报的报修
  await sendMsg(w1, { type: 'repairUpdate', repairId, status: 'cancelled' });
  const errRep = mk(w1, 'error');
  assert(errRep.length > 0 && errRep[errRep.length - 1].message.includes('仅上报人'), '非上报人取消被拒');

  // ========== 测试7: 坑位看板 ==========
  console.log('\n📋 测试7: 坑位看板（预约/提前确认被拒/评分校验）');
  const stall0 = last(w1, 'stalls');
  assert(stall0 && stall0.squat_count === 3 && stall0.stalls.length === 5, '坑位看板初始就绪(3蹲2尿)');
  const freeStall = stall0.stalls.find(s => s.status === 'free');
  // 预约后立即 startUse 应被拒（issue #1 修复）
  await sendMsg(w2, { type: 'reserve', stallId: freeStall.id, duration: 15 });
  await sendMsg(w2, { type: 'startUse', stallId: freeStall.id });
  const errEarly = mk(w2, 'error');
  assert(errEarly.length > 0 && errEarly[errEarly.length - 1].message.includes('尚未到预约时间'), '预约未到开始时间不可确认到坑(issue#1)');
  let stalls = last(w2, 'stalls');
  assert(stalls.stalls.find(s => s.id === freeStall.id).status === 'reserved', '提前确认后坑位仍为 reserved');
  // 取消预约
  const resv = last(w2, 'reservation').reservation;
  await sendMsg(w2, { type: 'cancel', reservationId: resv.id });
  // 评分越界被拒 + 同账号重复评分被拒
  await sendMsg(w2, { type: 'grab', stallId: freeStall.id });
  await sendMsg(w2, { type: 'rate', stallId: freeStall.id, cleanliness: 99, signal: 4, paper: 3 });
  const errRate = mk(w2, 'error');
  assert(errRate.length > 0 && errRate[errRate.length - 1].message.includes('1-5'), '评分越界被拒(issue#2)');
  await sendMsg(w2, { type: 'rate', stallId: freeStall.id, cleanliness: 5, signal: 4, paper: 3 });
  await sendMsg(w2, { type: 'rate', stallId: freeStall.id, cleanliness: 5, signal: 5, paper: 3 });
  const errDup = mk(w2, 'error');
  assert(errDup.length > 0 && errDup[errDup.length - 1].message.includes('评过分'), '同账号重复评分被拒');
  stalls = last(w2, 'stalls');
  const ratedStall = stalls.stalls.find(s => s.id === freeStall.id);
  assert(ratedStall.ratings.length === 1 && ratedStall.ratings[0].cleanliness === 5, '评分记录正确(1条)');
  // 催促
  await sendMsg(w1, { type: 'urge', stallId: freeStall.id });
  const urgen = mk(w2, 'urgeNotification');
  assert(urgen.length >= 1, '使用者收到催促通知');
  // 完成使用
  await sendMsg(w2, { type: 'finish', stallId: freeStall.id });
  stalls = last(w2, 'stalls');
  assert(stalls.stalls.find(s => s.id === freeStall.id).status === 'free', '结束使用后坑位释放');
  // 抢位+结束只计一次 totalVisits（issue #8）
  await sendMsg(w2, { type: 'getStats' });
  const stAfter = last(w2, 'stats').stats;
  assert(stAfter.totalVisits === 1, '抢位+结束只计一次使用次数(issue#8)');

  // ========== 测试8: 同一账号多开不能占多个坑位 ==========
  console.log('\n📋 测试8: 同账号多开只允许一个占用(issue#3)');
  const wsX = await createWSClient();
  await loginTo(wsX, sp.id, MEMBER, 'pw');
  const stallsB = last(wsX, 'stalls');
  const s1 = stallsB.stalls.find(s => s.status === 'free');
  const s2 = stallsB.stalls.find(s => s.id !== s1.id && s.status === 'free');
  await sendMsg(wsX, { type: 'grab', stallId: s1.id });
  await sendMsg(wsX, { type: 'grab', stallId: s2.id });
  const errMulti = mk(wsX, 'error');
  assert(errMulti.length > 0 && errMulti[errMulti.length - 1].message.includes('一次只能用一个'), '同账号多连接抢第二个坑位被拒(issue#3)');
  await sendMsg(wsX, { type: 'finish', stallId: s1.id });

  // ========== 测试9: 切换空间守卫 ==========
  console.log('\n📋 测试9: 占用中切换空间被拒(issue#4)');
  const spB = (await httpJson('POST', '/api/spaces', { name: '第二办公室', squat_count: 2, urinal_count: 1 })).json;
  const stallsC = last(w1, 'stalls');
  const sg = stallsC.stalls.find(s => s.status === 'free');
  await sendMsg(w1, { type: 'grab', stallId: sg.id });
  await sendMsg(w1, { type: 'join', spaceId: spB.id });
  const joinErr = mk(w1, 'error');
  assert(joinErr.length > 0 && joinErr[joinErr.length - 1].message.includes('仍占用着坑位'), '占用中切空间被拒(issue#4)');
  // 释放后可切换
  await sendMsg(w1, { type: 'finish', stallId: sg.id });
  await sendMsg(w1, { type: 'join', spaceId: spB.id });
  const joinedB = last(w1, 'joined');
  assert(joinedB && joinedB.space.id === spB.id, '释放后可切换到空间 B');

  // ========== 总结 ==========
  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ 通过: ${passed}`);
  console.log(`❌ 失败: ${failed}`);
  if (errors.length > 0) { console.log(`\n失败详情:`); errors.forEach(e => console.log(`  - ${e}`)); }
  console.log(`${'='.repeat(50)}\n`);
  try { w1.close(); w2.close(); wsX.close(); wA.close(); } catch {}
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => { console.error('测试运行出错:', err); process.exit(1); });