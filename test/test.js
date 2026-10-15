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

  // 登录失败限流：连续错误口令达到上限后短暂锁定
  const LOCK_ACCOUNT = 'lock_' + runKey;
  await reg(LOCK_ACCOUNT, 'pw', '锁定用户');
  const wL = await createWSClient();
  await sendMsg(wL, { type: 'join', spaceId: sp.id });
  for (let i = 0; i < 5; i++) await sendMsg(wL, { type: 'login', account: LOCK_ACCOUNT, password: 'wrong' });
  const errWrong = mk(wL, 'error');
  assert(errWrong.length >= 5 && errWrong[errWrong.length - 1].message.includes('账号或密码错误'), '连续错误口令返回账号或密码错误');
  await sendMsg(wL, { type: 'login', account: LOCK_ACCOUNT, password: 'wrong' });
  const errLock = mk(wL, 'error');
  assert(errLock.length > 0 && errLock[errLock.length - 1].message.includes('登录失败次数过多'), '达到失败上限后暂时锁定登录');
  wL.close();

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
  const res0 = rooms.reservations[0];
  assert(res0.remindAt && res0.remindAt <= res0.startAt && res0.remindAt >= res0.startAt - 10 * 60000, '预约携带开始前提醒时间 remindAt');
  const rs = last(w2, 'roomStats');
  assert(rs && rs.rooms.some(r => r.todayCount === 1 || r.upcomingCount === 1) && rs.utilizationPct >= 0, 'roomStats 统计到今日会议');
  const resId = rooms.reservations[0].id;
  // 过去时间预约被拒
  await sendMsg(w2, { type: 'roomBook', roomId, startAt: Date.now() - 60000, endAt: Date.now() + 3600000 });
  const errPast = mk(w2, 'error');
  assert(errPast.length > 0 && errPast[errPast.length - 1].message.includes('不能早于'), '过去时间预约被拒');
  // 冲突检测：另一账号预约重叠时段（先建第二间用于验证冲突建议）
  await sendMsg(w1, { type: 'roomCreate', name: '小会议室', capacity: 4 });
  const wA = await createWSClient();
  await loginTo(wA, sp.id, ADMIN, 'pw');
  await sendMsg(wA, { type: 'roomBook', roomId, startAt: t0 + 20 * 60000, endAt: t0 + 50 * 60000 });
  const errsA = mk(wA, 'error');
  assert(errsA.length > 0 && errsA[errsA.length - 1].message.includes('已被预约'), '重叠时段预约被拒绝(冲突检测)');
  assert(errsA[errsA.length - 1].suggestions && errsA[errsA.length - 1].suggestions.some((r) => r.name === '小会议室'), '冲突响应附带空闲会议室建议');
  // 取消自己的预约
  await sendMsg(w2, { type: 'reservationCancel', reservationId: resId });
  rooms = last(w2, 'rooms');
  const cancelled = rooms.reservations.find(r => r.id === resId);
  assert(cancelled && cancelled.status === 'cancelled', 'member 取消自己的预约成功');
  // 参会人数超容量被拒
  await sendMsg(w2, { type: 'roomBook', roomId, startAt: t0 + 50 * 60000, endAt: t0 + 80 * 60000, participants: 99 });
  const errCap = mk(w2, 'error');
  assert(errCap.length > 0 && errCap[errCap.length - 1].message.includes('人数超过会议室容量'), '参会人数超容量被拒');
  await sendMsg(w2, { type: 'roomBook', roomId, startAt: t0 + 50 * 60000, endAt: t0 + 80 * 60000, participants: 3 });
  rooms = last(w2, 'rooms');
  const okRes = rooms.reservations.find(r => r.startAt === t0 + 50 * 60000);
  assert(okRes && okRes.participants === 3, '预约携带参会人数 participants');
  await sendMsg(w2, { type: 'reservationCancel', reservationId: okRes.id });
  // RBAC：member 不能创建会议室
  await sendMsg(w2, { type: 'roomCreate', name: '小间', capacity: 4 });
  const errsRBAC = mk(w2, 'error');
  assert(errsRBAC.length > 0 && errsRBAC[errsRBAC.length - 1].message.includes('仅管理员'), 'member 新增会议室被拒(RBAC)');

  // ========== 测试3b: 周期预约 ==========
  console.log('\n📋 测试3b: 会议室周期预约');
  const tS = Date.now() + 3600000;
  await sendMsg(w2, { type: 'roomBook', roomId, startAt: tS, endAt: tS + 30 * 60000, title: '周会', repeat: 'weekly', repeatCount: 4 });
  rooms = last(w2, 'rooms');
  const series = rooms.reservations.filter(r => r.seriesId);
  assert(series.length === 4, '每周周期预约展开 4 场');
  assert(series[0].repeat === 'weekly' && !!series[0].seriesId, '周期场次带 repeat/seriesId');
  assert(series[1].startAt - series[0].startAt === 7 * 86400000, '周期间隔 7 天');
  const seriesId = series[0].seriesId;
  await sendMsg(wA, { type: 'reservationCancelSeries', seriesId });
  const errS = mk(wA, 'error');
  assert(errS.length > 0 && errS[errS.length - 1].message.includes('只能取消自己'), '他人取消周期预约被拒');
  await sendMsg(w2, { type: 'reservationCancelSeries', seriesId });
  rooms = last(w2, 'rooms');
  const cancelledSeries = rooms.reservations.filter(r => r.seriesId === seriesId);
  assert(cancelledSeries.length === 4 && cancelledSeries.every(r => r.status === 'cancelled'), '取消整组后全部场次置为 cancelled');

  // ========== 测试3c: 会议室候补 ==========
  console.log('\n📋 测试3c: 会议室候补（加入/空闲拒绝/重复拒绝/晋升/取消）');
  {
    const tW = Date.now();
    await sendMsg(w2, { type: 'roomBook', roomId, startAt: tW + 10 * 60000, endAt: tW + 40 * 60000, title: '评审会' });
    let rw = last(w2, 'rooms');
    const wRes = rw.reservations.find(r => r.ownerAccount === MEMBER && r.title === '评审会' && r.status === 'pending');
    assert(wRes, 'member 预约候补测试时段成功');
    const wResId = wRes.id;
    await sendMsg(wA, { type: 'roomBook', roomId, startAt: tW + 20 * 60000, endAt: tW + 50 * 60000 });
    const errConflict = mk(wA, 'error').pop();
    assert(errConflict && errConflict.message.includes('已被预约') && errConflict.code === 'roomConflict', '冲突预约返回 roomConflict 错误码');
    await sendMsg(wA, { type: 'roomWaitlist', roomId, startAt: tW + 20 * 60000, endAt: tW + 50 * 60000, title: '评审会' });
    rw = last(wA, 'rooms');
    assert(rw && rw.waitlist.length === 1 && rw.waitlist[0].ownerAccount === ADMIN, 'admin 加入候补成功');
    assert(rw.waitlistTotal === 1, '候补广播携带 waitlistTotal');
    await sendMsg(wA, { type: 'roomWaitlist', roomId, startAt: tW + 3 * 3600000, endAt: tW + 4 * 3600000, title: '空会' });
    const errFree = mk(wA, 'error').pop();
    assert(errFree && errFree.message.includes('可直接预约'), '空闲时段加入候补被拒');
    await sendMsg(wA, { type: 'roomWaitlist', roomId, startAt: tW + 20 * 60000, endAt: tW + 50 * 60000, title: '评审会' });
    const errDup = mk(wA, 'error').pop();
    assert(errDup && errDup.message.includes('已在该时段'), '重复加入候补被拒');
    await sendMsg(w2, { type: 'roomWaitlistCancel', waitlistId: rw.waitlist[0].id });
    const errCancel = mk(w2, 'error').pop();
    assert(errCancel && errCancel.message.includes('只能取消自己的'), '非本人取消候补被拒');
    await sendMsg(w2, { type: 'reservationCancel', reservationId: wResId });
    const promoted = mk(wA, 'roomWaitlistPromoted');
    assert(promoted.length >= 1 && promoted[promoted.length - 1].reservationId, '预约取消后候补晋升通知送达');
    rw = last(wA, 'rooms');
    const promotedRes = (rw.reservations || []).find(r => r.ownerAccount === ADMIN && r.status === 'pending');
    assert(promotedRes && promotedRes.title === '评审会', '晋升后生成真实预约');
    assert(rw.waitlist.length === 0, '晋升后候补从队列移除');
    await sendMsg(w2, { type: 'roomBook', roomId, startAt: tW + 50 * 60000, endAt: tW + 80 * 60000, title: '周会' });
    await sendMsg(wA, { type: 'roomWaitlist', roomId, startAt: tW + 60 * 60000, endAt: tW + 90 * 60000, title: '候补A' });
    const wWaitId = last(wA, 'rooms').waitlist[0].id;
    await sendMsg(wA, { type: 'roomWaitlistCancel', waitlistId: wWaitId });
    rw = last(wA, 'rooms');
    assert(rw.waitlist.length === 0 && rw.waitlistTotal === 0, '本人取消候补后队列清空');
  }

  // ========== 测试3d: 会议室改期 ==========
  console.log('\n📋 测试3d: 会议室改期（成功/冲突/越权/时长/状态）');
  {
    const spR = (await httpJson('POST', '/api/spaces', { name: '改期办公室', squat_count: 1, urinal_count: 1 })).json;
    const aR = 'rsch_' + runKey, bR = 'rschm_' + runKey;
    await reg(aR, 'pw', '改期管理员'); await reg(bR, 'pw', '改期成员');
    const wRa = await createWSClient(); await loginTo(wRa, spR.id, aR, 'pw');
    const wRb = await createWSClient(); await loginTo(wRb, spR.id, bR, 'pw');
    await sendMsg(wRa, { type: 'roomCreate', name: '改期会议室', capacity: 6 });
    const ridR = last(wRa, 'rooms').rooms[0].id;
    const tR = Date.now() + 60 * 60000;
    await sendMsg(wRb, { type: 'roomBook', roomId: ridR, startAt: tR, endAt: tR + 30 * 60000, title: '改期会' });
    const resR = last(wRb, 'rooms').reservations[0];
    assert(resR && resR.status === 'pending', '预约待改期的会议成功');
    const resRid = resR.id;
    // 成功改期
    const tNew = Date.now() + 120 * 60000;
    await sendMsg(wRb, { type: 'reservationReschedule', reservationId: resRid, startAt: tNew, endAt: tNew + 30 * 60000 });
    const rescheduled = (last(wRb, 'rooms').reservations || []).find(r => r.id === resRid);
    assert(rescheduled && rescheduled.startAt === tNew && rescheduled.endAt === tNew + 30 * 60000, '改期成功更新时段');
    assert(mk(wRb, 'reservationRescheduled').length >= 1, '改期成功返回 reservationRescheduled 通知');
    // 冲突拒绝：另一场占用后改期到重叠时段
    const tC = Date.now() + 24 * 3600000;
    await sendMsg(wRb, { type: 'roomBook', roomId: ridR, startAt: tC, endAt: tC + 30 * 60000, title: '占位会' });
    assert(last(wRb, 'rooms').reservations.some(r => r.title === '占位会' && r.status === 'pending'), '占位会议预约成功');
    await sendMsg(wRb, { type: 'reservationReschedule', reservationId: resRid, startAt: tC + 5 * 60000, endAt: tC + 25 * 60000 });
    const errConf = mk(wRb, 'error').pop();
    assert(errConf && errConf.message.includes('已被预约'), '改期到冲突时段被拒');
    // 过去时间拒绝
    await sendMsg(wRb, { type: 'reservationReschedule', reservationId: resRid, startAt: Date.now() - 60000, endAt: Date.now() + 30 * 60000 });
    const errPast = mk(wRb, 'error').pop();
    assert(errPast && errPast.message.includes('不能早于'), '改期到过去时间被拒');
    // 时长过短拒绝
    await sendMsg(wRb, { type: 'reservationReschedule', reservationId: resRid, startAt: tNew, endAt: tNew + 60000 });
    const errShort = mk(wRb, 'error').pop();
    assert(errShort && errShort.message.includes('至少预约 5 分钟'), '改期时长过短被拒');
    // 管理员可改期他人预约
    await sendMsg(wRa, { type: 'reservationReschedule', reservationId: resRid, startAt: tNew + 60 * 60000, endAt: tNew + 90 * 60000 });
    const rescheduledAdmin = (last(wRa, 'rooms').reservations || []).find(r => r.id === resRid);
    assert(rescheduledAdmin && rescheduledAdmin.startAt === tNew + 60 * 60000, '管理员改期他人预约成功');
    // 非本人且非管理员被拒
    const cR = 'rschc_' + runKey;
    await reg(cR, 'pw', '第三方');
    const wRc = await createWSClient(); await loginTo(wRc, spR.id, cR, 'pw');
    await sendMsg(wRc, { type: 'reservationReschedule', reservationId: resRid, startAt: tNew + 120 * 60000, endAt: tNew + 150 * 60000 });
    const errRBAC = mk(wRc, 'error').pop();
    assert(errRBAC && errRBAC.message.includes('只能改期自己'), '非本人非管理员改期被拒');
    wRc.close();
    // 已取消不能改期
    await sendMsg(wRb, { type: 'reservationCancel', reservationId: resRid });
    await sendMsg(wRb, { type: 'reservationReschedule', reservationId: resRid, startAt: tNew + 120 * 60000, endAt: tNew + 150 * 60000 });
    const errDone = mk(wRb, 'error').pop();
    assert(errDone && errDone.message.includes('已不能改期'), '已取消的预约不能改期');
    wRa.close(); wRb.close();
  }

  // ========== 测试3e: 会议室实际到场时长 ==========
  console.log('\n📋 测试3e: 会议室实际到场时长（开始/结束/统计）');
  {
    const spA = (await httpJson('POST', '/api/spaces', { name: '到场办公室', squat_count: 1, urinal_count: 1 })).json;
    const aA = 'att_' + runKey;
    await reg(aA, 'pw', '到场用户');
    const wA = await createWSClient(); await loginTo(wA, spA.id, aA, 'pw');
    await sendMsg(wA, { type: 'roomCreate', name: '到场会议室', capacity: 6 });
    const ridA = last(wA, 'rooms').rooms[0].id;
    const tStart = Date.now() + 5 * 1000;
    await sendMsg(wA, { type: 'roomBook', roomId: ridA, startAt: tStart, endAt: tStart + 30 * 60000, title: '到场会' });
    let rA = last(wA, 'rooms').reservations[0];
    assert(rA && rA.actualStartAt === null && rA.actualEndAt === null, '新预约暂无实际到场时间');
    await new Promise((r) => setTimeout(r, 6000)); // 等待开始时间过去
    await sendMsg(wA, { type: 'roomStart', reservationId: rA.id });
    let started = (last(wA, 'rooms').reservations || []).find(r => r.id === rA.id);
    assert(started && started.status === 'active' && started.actualStartAt, '开始会议后记录实际开始时间');
    await sendMsg(wA, { type: 'roomEnd', reservationId: rA.id });
    let ended = (last(wA, 'rooms').reservations || []).find(r => r.id === rA.id);
    assert(ended && ended.status === 'completed' && ended.actualEndAt, '结束会议后记录实际结束时间并置为已完成');
    assert(ended && ended.actualEndAt >= ended.actualStartAt, '实际结束时间晚于实际开始时间');
    const stA = last(wA, 'stats');
    assert(stA && typeof stA.stats.meetingActualDuration === 'number' && stA.stats.meetingActualDuration >= 0, '会议实际时长计入 meetingActualDuration');
    const rsA = last(wA, 'roomStats');
    assert(rsA && rsA.totalActualMinutes >= 0 && rsA.rooms.some(r => r.actualMinutes >= 0), 'roomStats 携带实际到场分钟数');
    wA.close();
  }

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
  assert(last(w2, 'notices').notices.some(n => n.text.includes('已归还设备')), '归还设备后推送归还公告');
  const stB = last(w2, 'stats');
  assert(stB && typeof stB.stats.borrowDuration === 'number' && stB.stats.borrowDuration >= 0, '归还后统计含 borrowDuration');
  // 借用记录分页（导出 CSV 数据源）
  await sendMsg(w2, { type: 'fetchPage', module: 'borrows', offset: 0, limit: 10 });
  const bwPage = last(w2, 'page');
  assert(bwPage && bwPage.module === 'borrows' && bwPage.items.length === 1 && bwPage.items[0].toolName === '测试机', '借用记录分页返回设备名');
  assert(bwPage.items[0].status === 'returned' && bwPage.total === 1, '借用记录分页返回状态与总数');
  assert('soonReminded' in bwPage.items[0], '借用记录携带到期提醒字段 soonReminded');

  // ========== 测试4b: 工具续借 ==========
  console.log('\n📋 测试4b: 工具续借（含次数上限）');
  await sendMsg(w2, { type: 'toolBorrow', toolId, qty: 1 });
  let tools4 = last(w2, 'tools');
  const bw = tools4.tools.find(t => t.id === toolId).activeBorrows[0];
  assert(bw && bw.dueAt && bw.dueAt - bw.borrowedAt === 7 * 86400000, '借用生成 7 天归还期限');
  assert(bw.dueSoon === false, '新借用尚未进入到期提醒窗口');
  assert(bw.extensions === 0, '新借用续借次数为 0');
  await sendMsg(w2, { type: 'toolExtend', borrowId: bw.id, days: 7 });
  tools4 = last(w2, 'tools');
  const bw2 = tools4.tools.find(t => t.id === toolId).activeBorrows[0];
  assert(bw2 && bw2.dueAt - bw2.borrowedAt === 14 * 86400000, '续借 7 天后归还期限延长');
  assert(bw2.extensions === 1, '首次续借后次数为 1');
  await sendMsg(w2, { type: 'toolExtend', borrowId: bw2.id, days: 7 });
  tools4 = last(w2, 'tools');
  const bw3 = tools4.tools.find(t => t.id === toolId).activeBorrows[0];
  assert(bw3 && bw3.dueAt - bw3.borrowedAt === 21 * 86400000, '第二次续借后期限延长至 21 天');
  assert(bw3.extensions === 2, '第二次续借后次数为 2');
  await sendMsg(w2, { type: 'toolExtend', borrowId: bw3.id, days: 7 });
  const errLimit = mk(w2, 'error').pop();
  assert(errLimit && errLimit.message.includes('已达上限'), '第三次续借被拒（次数上限）');
  const MEMBER2 = 'staff2_' + runKey;
  await reg(MEMBER2, 'pw', '员工二');
  const wM2 = await createWSClient();
  await loginTo(wM2, sp.id, MEMBER2, 'pw');
  await sendMsg(wM2, { type: 'toolExtend', borrowId: bw3.id, days: 7 });
  const errExtend = mk(wM2, 'error');
  assert(errExtend.length > 0 && errExtend[errExtend.length - 1].message.includes('只能续借自己'), '非借用人续借被拒');
  await sendMsg(w2, { type: 'toolReturn', borrowId: bw3.id });
  await sendMsg(w2, { type: 'toolExtend', borrowId: bw3.id, days: 7 });
  const errReturned = mk(w2, 'error');
  assert(errReturned.length > 0 && errReturned[errReturned.length - 1].message.includes('已归还'), '已归还的借用无法续借');
  wM2.close();

  // ========== 测试4c: 逾期批量催还 ==========
  console.log('\n📋 测试4c: 逾期批量催还（序列化 + 无逾期时被拒）');
  await sendMsg(w2, { type: 'toolBorrow', toolId, qty: 1 });
  let toolsC = last(w2, 'tools');
  const bwC = toolsC.tools.find(t => t.id === toolId).activeBorrows[0];
  assert(bwC && bwC.reminded === false, '在借明细含 reminded=false 字段');
  await sendMsg(w1, { type: 'remindOverdue' });
  const errOverdue = mk(w1, 'error').pop();
  assert(errOverdue && errOverdue.message.includes('暂无逾期'), '无逾期时批量催还被拒');
  await sendMsg(w2, { type: 'toolReturn', borrowId: bwC.id });

  // ========== 测试4d: 工具排队（加入/晋升/自动借用） ==========
  console.log('\n📋 测试4d: 工具排队（加入/晋升/自动借用）');
  await sendMsg(w1, { type: 'toolCreate', name: '排队测试机', category: '测试机器', total: 2 });
  let wlt0 = last(w1, 'tools');
  const wlToolId = wlt0.tools.find(t => t.name === '排队测试机').id;
  await sendMsg(w2, { type: 'toolBorrow', toolId: wlToolId, qty: 2 });
  wlt0 = last(w2, 'tools');
  assert(wlt0.tools.find(t => t.id === wlToolId).available === 0, '库存被借光，可用为 0');
  const wlb = wlt0.tools.find(t => t.id === wlToolId).activeBorrows[0].id;
  await sendMsg(w1, { type: 'toolWaitlist', toolId: wlToolId, qty: 2 });
  assert(mk(w1, 'toolWaitlistJoined').length >= 1, '库存不足时可加入排队');
  const wlList = last(w1, 'tools').waitlist;
  assert(wlList && wlList.some(w => w.toolId === wlToolId && w.account === ADMIN), '排队记录随访播');
  await sendMsg(w1, { type: 'toolWaitlist', toolId: wlToolId, qty: 2 });
  const errDupWl = mk(w1, 'error').pop();
  assert(errDupWl && errDupWl.message.includes('已在排队'), '重复排队被拒');
  await sendMsg(w2, { type: 'toolReturn', borrowId: wlb });
  const promoted = mk(w1, 'toolWaitlistPromoted');
  assert(promoted.length >= 1 && promoted[promoted.length - 1].toolId === wlToolId, '归还后排队晋升通知送达');
  const wlt1 = last(w1, 'tools');
  const wlTool = wlt1.tools.find(t => t.id === wlToolId);
  assert(wlTool && wlTool.available === 0, '晋升后库存再次被借出');
  assert(wlTool.activeBorrows.length === 1 && wlTool.activeBorrows[0].borrowerAccount === ADMIN, '晋升后自动为排队人创建借用');
  assert(!wlt1.waitlist.some(w => w.toolId === wlToolId), '晋升后排队记录移出公开队列');
  await sendMsg(w1, { type: 'toolReturn', borrowId: wlTool.activeBorrows[0].id });

  // ========== 测试4e: 借用归还状态登记 ==========
  console.log('\n📋 测试4e: 借用归还状态登记（完好/损坏/丢失）');
  {
    const spC = (await httpJson('POST', '/api/spaces', { name: '归还状态办公室', squat_count: 1, urinal_count: 1 })).json;
    const aC = 'ret_' + runKey, bC = 'retm_' + runKey;
    await reg(aC, 'pw', '归还管理员'); await reg(bC, 'pw', '归还成员');
    const wC = await createWSClient(); await loginTo(wC, spC.id, aC, 'pw');
    const wD = await createWSClient(); await loginTo(wD, spC.id, bC, 'pw');
    await sendMsg(wC, { type: 'toolCreate', name: '归还测试机', category: '测试电脑', total: 2 });
    const tidC = last(wC, 'tools').tools[0].id;
    // 完好归还：可用数恢复
    await sendMsg(wD, { type: 'toolBorrow', toolId: tidC, qty: 1 });
    const bwC = last(wD, 'tools').tools.find(t => t.id === tidC).activeBorrows[0];
    await sendMsg(wD, { type: 'toolReturn', borrowId: bwC.id, condition: 'intact' });
    let tlC = last(wD, 'tools').tools.find(t => t.id === tidC);
    assert(tlC && tlC.available === 2, '完好归还恢复可用库存');
    // 损坏归还：可用数恢复但记录状态
    await sendMsg(wD, { type: 'toolBorrow', toolId: tidC, qty: 2 });
    const bwD = last(wD, 'tools').tools.find(t => t.id === tidC).activeBorrows[0];
    await sendMsg(wD, { type: 'toolReturn', borrowId: bwD.id, condition: 'damaged' });
    tlC = last(wD, 'tools').tools.find(t => t.id === tidC);
    assert(tlC && tlC.available === 2, '损坏归还仍恢复可用库存');
    // 丢失归还：总数与可用数均不恢复
    await sendMsg(wD, { type: 'toolBorrow', toolId: tidC, qty: 1 });
    const bwE = last(wD, 'tools').tools.find(t => t.id === tidC).activeBorrows[0];
    await sendMsg(wD, { type: 'toolReturn', borrowId: bwE.id, condition: 'missing' });
    tlC = last(wD, 'tools').tools.find(t => t.id === tidC);
    assert(tlC && tlC.total === 1 && tlC.available === 1, '丢失归还不恢复库存（总数与可用数均扣减）');
    // borrowsPublic 暴露 condition
    await sendMsg(wD, { type: 'fetchPage', module: 'borrows', offset: 0, limit: 10 });
    const bwPage = last(wD, 'page');
    const condMissing = bwPage.items.find(b => b.id === bwE.id);
    assert(condMissing && condMissing.condition === 'missing', '借用记录携带归还状态 missing');
    const condIntact = bwPage.items.find(b => b.id === bwC.id);
    assert(condIntact && condIntact.condition === 'intact', '借用记录携带归还状态 intact');
    // 归还公告带状态
    assert(last(wD, 'notices').notices.some(n => n.text.includes('完好')), '完好归还公告标注状态');
    assert(last(wD, 'notices').notices.some(n => n.text.includes('丢失')), '丢失归还公告标注状态');
    wC.close(); wD.close();
  }

  // ========== 测试5: 物资申领 ==========
  console.log('\n📋 测试5: 物资申领（提交/处理/自处理拒绝）');
  await sendMsg(w2, { type: 'materialRequest', name: '5号电池', qty: 4, unit: '节', reason: '遥控器没电' });
  let mats = last(w2, 'materials');
  assert(mats && mats.requests.length === 1 && mats.requests[0].status === 'pending', 'member 提交申领成功');
   assert(mats.requests[0].slaReminded === false, '新申领未触发 SLA 提醒');
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
  assert(mk(w2, 'materialFulfilled').length >= 1, '申领满足后申请人收到通知');
  assert(last(w1, 'stats') && last(w1, 'stats').stats.helperCount === 1, '处理申领累计 helperCount=1');

  // ========== 测试5b: 物资申领指派 ==========
  console.log('\n📋 测试5b: 物资申领指派负责人');
  const THIRD = 'third_' + runKey;
  const FOURTH = 'fourth_' + runKey;
  await reg(THIRD, 'pw', '第三人');
  await reg(FOURTH, 'pw', '第四人');
  const w3 = await createWSClient();
  await loginTo(w3, sp.id, THIRD, 'pw');
  const w4 = await createWSClient();
  await loginTo(w4, sp.id, FOURTH, 'pw');
  await sendMsg(w2, { type: 'materialRequest', name: 'A4 纸', qty: 10, unit: '包', reason: '打印' });
  let mats5 = last(w2, 'materials');
  const reqA = mats5.requests.find(r => r.name === 'A4 纸');
  await sendMsg(w2, { type: 'materialAssign', requestId: reqA.id, handlerAccount: THIRD });
  mats5 = last(w2, 'materials');
  const assignedA = mats5.requests.find(r => r.id === reqA.id);
  assert(assignedA.handlerAccount === THIRD && assignedA.handlerName, '申请人指派负责人成功');
  assert(mk(w3, 'materialAssigned').length >= 1, '申领指派后负责人收到通知');
  await sendMsg(w4, { type: 'materialFulfill', requestId: reqA.id });
  const errFulfill = mk(w4, 'error');
  assert(errFulfill.length > 0 && errFulfill[errFulfill.length - 1].message.includes('由负责人处理'), '非负责人处理已指派申领被拒');
  await sendMsg(w3, { type: 'materialFulfill', requestId: reqA.id });
  mats5 = last(w3, 'materials');
  assert(mats5.requests.find(r => r.id === reqA.id).status === 'fulfilled', '负责人处理已指派申领成功');

  // ========== 测试6: 报修 ==========
  console.log('\n📋 测试6: 报修（提交/状态流转/越权取消/优先级）');
  await sendMsg(w2, { type: 'repairCreate', category: '灯光', priority: 'high', location: '3F 走廊', description: '灯管闪烁' });
  let repairs = last(w2, 'repairs');
  assert(repairs && repairs.repairs.length === 1 && repairs.repairs[0].status === 'reported', 'member 提交报修成功');
  assert(repairs.repairs[0].priority === 'high', '报修保留优先级 high');
   assert(repairs.repairs[0].slaReminded === false, '新报修未触发 SLA 提醒');
  const repairId = repairs.repairs[0].id;
  await sendMsg(w1, { type: 'repairUpdate', repairId, status: 'in_progress' });
  repairs = last(w1, 'repairs');
  assert(repairs.repairs.find(r => r.id === repairId).status === 'in_progress', '报修进入处理中');
  assert(mk(w2, 'repairInProgress').length >= 1, '报修处理中通知上报人');
  await sendMsg(w1, { type: 'repairUpdate', repairId, status: 'resolved' });
  repairs = last(w1, 'repairs');
  assert(repairs.repairs.find(r => r.id === repairId).status === 'resolved', '报修已解决');
  assert(mk(w2, 'repairResolved').length >= 1, '报修解决后通知上报人');
  assert(last(w1, 'stats') && last(w1, 'stats').stats.helperCount === 2, '解决报修累计 helperCount=2');
  // 他人不能取消成员上报的报修
  await sendMsg(w1, { type: 'repairUpdate', repairId, status: 'cancelled' });
  const errRep = mk(w1, 'error');
  assert(errRep.length > 0 && errRep[errRep.length - 1].message.includes('仅上报人'), '非上报人取消被拒');
  // 上报人调整优先级 + 非法优先级被拒
  await sendMsg(w2, { type: 'repairUpdate', repairId, priority: 'low' });
  repairs = last(w2, 'repairs');
  assert(repairs.repairs.find(r => r.id === repairId).priority === 'low', '上报人调整优先级成功');
  await sendMsg(w2, { type: 'repairUpdate', repairId, priority: 'urgent' });
  const errPrio = mk(w2, 'error');
  assert(errPrio.length > 0 && errPrio[errPrio.length - 1].message.includes('无效的优先级'), '非法优先级被拒');

  // ========== 测试6c: 报修重复检测 ==========
  console.log('\n📋 测试6c: 报修重复检测');
  await sendMsg(w2, { type: 'repairCreate', category: '厕所', location: '三层男厕', description: '冲水坏了' });
  let rep6 = last(w2, 'repairs');
  assert(rep6.repairs[0].status === 'reported', 'member 提交新报修成功');
  const rep6Id = rep6.repairs[0].id;
  await sendMsg(w1, { type: 'repairCreate', category: '厕所', location: '三层男厕', description: '冲水又坏了' });
  const errDupRepair = mk(w1, 'error').pop();
  assert(errDupRepair && errDupRepair.code === 'duplicateRepair' && errDupRepair.repairId === rep6Id, '同位置同类未处理报修被识别为重复');
  assert(errDupRepair.message.includes('请先处理或取消'), '重复报修提示先处理旧单');
  await sendMsg(w1, { type: 'repairUpdate', repairId: rep6Id, status: 'resolved' });
  await sendMsg(w1, { type: 'repairCreate', category: '厕所', location: '三层男厕', description: '冲水又坏了' });
  const okAfterResolve = last(w1, 'repairs');
  assert(okAfterResolve.repairs.some(r => r.description === '冲水又坏了'), '旧单解决后可再次提交同位置报修');

  // ========== 测试6b: 报修指派 ==========
  console.log('\n📋 测试6b: 报修指派负责人');
  await sendMsg(w2, { type: 'repairCreate', category: '空调', location: '3F 会议室', description: '不制冷' });
  let reps5 = last(w2, 'repairs');
  const repB = reps5.repairs.find(r => r.description === '不制冷');
  await sendMsg(w2, { type: 'repairAssign', repairId: repB.id, handlerAccount: THIRD });
  reps5 = last(w2, 'repairs');
  const repAssigned = reps5.repairs.find(r => r.id === repB.id);
  assert(repAssigned.handlerAccount === THIRD && repAssigned.handlerName, '上报人指派负责人成功');
  assert(mk(w3, 'repairAssigned').length >= 1, '报修指派后负责人收到通知');
  await sendMsg(w4, { type: 'repairAssign', repairId: repB.id, handlerAccount: FOURTH });
  const errRepAssign = mk(w4, 'error');
  assert(errRepAssign.length > 0 && errRepAssign[errRepAssign.length - 1].message.includes('仅上报人或管理员'), '非上报人指派被拒');

  // ========== 测试6d: 报修工单编号 ==========
  console.log('\n📋 测试6d: 报修工单编号');
  await sendMsg(w2, { type: 'repairCreate', category: '灯光', location: '2F 工位', description: '插座无电' });
  let rep6d = last(w2, 'repairs');
  const rep6dItem = rep6d.repairs[0];
  assert(rep6dItem && rep6dItem.code && /^RP-\d{8}-[A-Z0-9]+$/.test(rep6dItem.code), '报修生成 RP-日期-编号 工单号');
  const rep6dId = rep6dItem.id;

  // ========== 测试5c: 物资常用模板 ==========
  console.log('\n📋 测试5c: 物资常用模板（管理员维护 + 快捷申领）');
  await sendMsg(w1, { type: 'materialTemplateCreate', name: '5号电池', defaultQty: 4, defaultUnit: '节', defaultReason: '遥控器备用' });
  let mats5c = last(w1, 'materials');
  assert(mats5c && mats5c.templates && mats5c.templates.length === 1 && mats5c.templates[0].name === '5号电池', '管理员创建常用模板成功');
  const tplId = mats5c.templates[0].id;
  // 成员用模板快捷申领
  await sendMsg(w2, { type: 'materialRequest', templateId: tplId });
  mats5c = last(w2, 'materials');
  const tplReq = mats5c.requests.find(r => r.name === '5号电池');
  assert(tplReq && tplReq.qty === 4 && tplReq.unit === '节' && tplReq.reason === '遥控器备用', '模板快捷申领自动填充名称/数量/单位/说明');
  // 非管理员删除模板被拒
  await sendMsg(w2, { type: 'materialTemplateDelete', templateId: tplId });
  const errTplRBAC = mk(w2, 'error').pop();
  assert(errTplRBAC && errTplRBAC.message.includes('仅管理员'), '非管理员删除模板被拒');
  await sendMsg(w1, { type: 'materialTemplateDelete', templateId: tplId });
  mats5c = last(w1, 'materials');
  assert(mats5c && mats5c.templates.length === 0, '管理员删除模板成功');

  // ========== 测试11d: 公告回应 ==========
  console.log('\n📋 测试11d: 公告回应（点赞/取消）');
  await sendMsg(w1, { type: 'announce', text: '今晚 22:00 停空调检修' });
  const annNotice = last(w1, 'notices').notices[0];
  assert(annNotice && annNotice.reactions && Array.isArray(annNotice.reactions), '公告包含 reactions 数组');
  await sendMsg(w2, { type: 'noticeReact', noticeId: annNotice.id, reaction: '👍' });
  const reacted = last(w2, 'notices').notices.find(n => n.id === annNotice.id);
  assert(reacted && reacted.reactions.some(r => r.account === MEMBER && r.reaction === '👍'), '成员对公告点赞成功');
  await sendMsg(w2, { type: 'noticeReact', noticeId: annNotice.id, reaction: '👍' });
  const unreacted = last(w2, 'notices').notices.find(n => n.id === annNotice.id);
  assert(unreacted && !unreacted.reactions.some(r => r.account === MEMBER && r.reaction === '👍'), '再次点击取消自己的点赞');
  // 无效回应被拒
  await sendMsg(w2, { type: 'noticeReact', noticeId: annNotice.id, reaction: '👍👍' });
  const errReaction = mk(w2, 'error').pop();
  assert(errReaction && errReaction.message.includes('无效的回应表情'), '无效回应表情被拒');

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
  // 存在预约时禁止重配坑位（避免重配后 currentStall 指向已删除坑位）
  await sendMsg(w2, { type: 'reserve', stallId: freeStall.id, duration: 15 });
  const resv2 = last(w2, 'reservation').reservation;
  await sendMsg(w1, { type: 'stallConfig', squat_count: 1, urinal_count: 1 });
  const errCfg = mk(w1, 'error');
  assert(errCfg.length > 0 && errCfg[errCfg.length - 1].message.includes('预约或占用'), '存在预约时禁止重配坑位');
  await sendMsg(w2, { type: 'cancel', reservationId: resv2.id });
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

  // ========== 测试10: 列表分页（广播 total + fetchPage） ==========
  console.log('\n📋 测试10: 列表分页');
  const spP = (await httpJson('POST', '/api/spaces', { name: '分页办公室', squat_count: 2, urinal_count: 1 })).json;
  const accP = 'page_' + runKey;
  await reg(accP, 'pw', '分页用户');
  const wP = await createWSClient();
  await loginTo(wP, spP.id, accP, 'pw');
  for (let i = 0; i < 7; i++) await sendMsg(wP, { type: 'materialRequest', name: '物品' + i, qty: 1, unit: '个', reason: 'r' + i });
  const matsB = last(wP, 'materials');
  assert(matsB.total === 7, '广播携带 total=7');
  assert(matsB.requests.length === 7, '数据量低于 PAGE 时全量返回');
  await sendMsg(wP, { type: 'fetchPage', module: 'materials', offset: 2, limit: 3 });
  const page = last(wP, 'page');
  assert(page && page.total === 7 && page.items.length === 3, 'fetchPage 返回正确窗口(offset2,limit3)与总数7');
  assert(page.items[0].name === '物品4', '分页按最新优先切片正确');
  wP.close();

  // ========== 测试11: 扩展功能（状态灯/公告/智能选房/催还/每日看点/每周之星/坑位段位） ==========
  console.log('\n📋 测试11: 扩展功能');
  {
    const spF = (await httpJson('POST', '/api/spaces', { name: '扩展办公室', squat_count: 2, urinal_count: 1 })).json;
    const aE = 'ext_a' + runKey, bE = 'ext_b' + runKey;
    await reg(aE, 'pw', '甲'); await reg(bE, 'pw', '乙');
    const wA = await createWSClient(); await loginTo(wA, spF.id, aE, 'pw');
    assert(last(wA, 'digest') && typeof last(wA, 'digest').digest === 'object', '登录收到每日看点 digest');
    await sendMsg(wA, { type: 'setStatus', label: '开会', emoji: '🧘' });
    const uA = last(wA, 'users').users.find(u => u.account === aE);
    assert(uA && uA.status && uA.status.label === '开会', '状态灯设置并广播');
    const wB = await createWSClient(); await loginTo(wB, spF.id, bE, 'pw');
    await sendMsg(wA, { type: 'announce', text: '周五提前下班' });
    const nt = last(wB, 'notices');
    assert(nt && nt.notices.length && nt.notices[0].text === '周五提前下班', '公告广播到其他成员');
    await sendMsg(wA, { type: 'roomCreate', name: '投影室', capacity: 8, location: '3F' });
    await sendMsg(wA, { type: 'roomCreate', name: '洽谈间', capacity: 10, location: '3F' });
    const roomsF = last(wA, 'rooms').rooms;
    const tF = Date.now();
    await sendMsg(wA, { type: 'roomBook', roomId: roomsF[0].id, startAt: tF + 10 * 60000, endAt: tF + 40 * 60000, title: '评审' });
    await sendMsg(wA, { type: 'suggestRoom', startAt: tF + 20 * 60000, endAt: tF + 50 * 60000, capacity: 6 });
    const sugg = last(wA, 'suggestRooms');
    assert(sugg && sugg.suggestions.length === 1 && sugg.suggestions[0].id === roomsF[1].id, '智能选房排除冲突且满足人数');
    await sendMsg(wA, { type: 'toolCreate', name: '测试机', category: '测试电脑', total: 2 });
    const toolF = last(wA, 'tools').tools[0];
    await sendMsg(wB, { type: 'toolBorrow', toolId: toolF.id, qty: 1 });
    const borrowF = last(wB, 'tools').tools.find(t => t.id === toolF.id).activeBorrows[0];
    await sendMsg(wA, { type: 'remindReturn', borrowId: borrowF.id });
    const remF = mk(wB, 'borrowReminder');
    assert(remF.length >= 1, '催还通知送达借用人');
    const lbF = last(wA, 'leaderboard');
    assert(lbF.rankings.some(r => r.weekly > 0), '排行榜包含本周活跃');
    const mvpF = lbF.rankings.find(r => r.mvp);
    assert(mvpF && mvpF.account === bE, 'MVP 为唯一本周活跃者(乙)');
    const stF = last(wA, 'stalls');
    assert(stF.stalls.every(s => s.tier && s.tier.name), '坑位含段位信息');
    wA.close(); wB.close();
  }

  // ========== 测试12: 访客登记 ==========
  console.log('\n📋 测试12: 访客登记');
  {
    const spV = (await httpJson('POST', '/api/spaces', { name: '访客办公室', squat_count: 1, urinal_count: 1 })).json;
    const aV = 'vhost_' + runKey, bV = 'vguest_' + runKey;
    await reg(aV, 'pw', '接待甲'); await reg(bV, 'pw', '访客乙');
    const wV1 = await createWSClient(); await loginTo(wV1, spV.id, aV, 'pw');
    const wV2 = await createWSClient(); await loginTo(wV2, spV.id, bV, 'pw');
    await sendMsg(wV1, { type: 'visitorCreate', visitorName: '客户王', purpose: '商务洽谈' });
    let vs = last(wV1, 'visitors');
    assert(vs && vs.visitors.length === 1 && vs.visitors[0].visitorName === '客户王', '登记访客成功');
    const vsId = vs.visitors[0].id;
    await sendMsg(wV1, { type: 'visitorCreate', visitorName: '', purpose: '缺姓名' });
    const errV = mk(wV1, 'error');
    assert(errV.length > 0 && errV[errV.length - 1].message.includes('请填写访客姓名'), '缺姓名登记被拒');
    await sendMsg(wV1, { type: 'visitorArrived', visitorId: vsId });
    vs = last(wV1, 'visitors');
    assert(vs.visitors[0].status === 'arrived', '推进到访状态成功');
    await sendMsg(wV1, { type: 'visitorLeft', visitorId: vsId });
    vs = last(wV1, 'visitors');
    assert(vs.visitors[0].status === 'left', '推进离开状态成功');
    // 非登记人 / 非管理员不能操作他人访客
    await sendMsg(wV2, { type: 'visitorArrived', visitorId: vsId });
    const errV2 = mk(wV2, 'error');
    assert(errV2.length > 0 && errV2[errV2.length - 1].message.includes('只能操作自己登记的访客'), '非登记人不能推进他人访客');
    // 管理员可删除任意访客
    await sendMsg(wV2, { type: 'visitorCreate', visitorName: '临时访客', purpose: '取件' });
    const vsB = last(wV2, 'visitors');
    const vsBId = vsB.visitors[0].id;
    await sendMsg(wV1, { type: 'visitorRemove', visitorId: vsBId });
    vs = last(wV1, 'visitors');
    assert(!vs.visitors.some((v) => v.id === vsBId), '管理员删除任意访客成功');
    wV1.close(); wV2.close();
  }

  // ========== 测试12c: 访客到访/离开通知接待人 ==========
  console.log('\n📋 测试12c: 访客到访/离开通知接待人');
  {
    const spVN = (await httpJson('POST', '/api/spaces', { name: '访客通知办公室', squat_count: 1, urinal_count: 1 })).json;
    const aN = 'vnotif_' + runKey, bN = 'vhostn_' + runKey;
    await reg(aN, 'pw', '操作员'); await reg(bN, 'pw', '接待员');
    const wA = await createWSClient(); await loginTo(wA, spVN.id, aN, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spVN.id, bN, 'pw');
    await sendMsg(wB, { type: 'visitorCreate', visitorName: '客户赵', purpose: '交流' });
    const vsN = last(wB, 'visitors');
    const vsNId = vsN.visitors[0].id;
    await sendMsg(wA, { type: 'visitorArrived', visitorId: vsNId });
    assert(mk(wB, 'visitorArrived').length >= 1, '访客到访通知接待人');
    await sendMsg(wA, { type: 'visitorLeft', visitorId: vsNId });
    assert(mk(wB, 'visitorLeft').length >= 1, '访客离开通知接待人');
    wA.close(); wB.close();
  }

  // ========== 测试12b: 访客签到码核销 ==========
  console.log('\n📋 测试12b: 访客签到码核销');
  {
    const spC = (await httpJson('POST', '/api/spaces', { name: '签到办公室', squat_count: 1, urinal_count: 1 })).json;
    const aC = 'ckin_' + runKey, bC = 'ckinm_' + runKey;
    await reg(aC, 'pw', '接待员'); await reg(bC, 'pw', '前台');
    const wC1 = await createWSClient(); await loginTo(wC1, spC.id, aC, 'pw');
    const wC2 = await createWSClient(); await loginTo(wC2, spC.id, bC, 'pw');
    await sendMsg(wC1, { type: 'visitorCreate', visitorName: '客户李', purpose: '拜访' });
    const created = last(wC1, 'visitorCreated');
    assert(created && created.code && created.code.length === 6, '登记访客返回 6 位签到码');
    const code = created.code;
    await sendMsg(wC2, { type: 'visitorCheckin', code: 'WRONG1' });
    const errCode = mk(wC2, 'error').pop();
    assert(errCode && errCode.message.includes('签到码不存在'), '错误签到码被拒');
    await sendMsg(wC2, { type: 'visitorCheckin', code });
    const checked = mk(wC2, 'visitorCheckedIn');
    assert(checked.length >= 1 && checked[checked.length - 1].visitorName === '客户李', '前台凭码核销成功');
    const notify = mk(wC1, 'visitorCheckinNotification');
    assert(notify.length >= 1 && notify[notify.length - 1].visitorName === '客户李', '接待人收到签到核销通知');
    await sendMsg(wC2, { type: 'visitorCheckin', code });
    const errDup = mk(wC2, 'error').pop();
    assert(errDup && errDup.message.includes('已签到'), '重复核销被拒');
    const vs = last(wC2, 'visitors');
    assert(vs.visitors.some(v => v.code === code), '签到码随访客列表广播');
    const vc = vs.visitors.find(v => v.code === code);
    assert(vc && vc.expiresAt && vc.expired === false, '签到码携带有效期且未过期');
    wC1.close(); wC2.close();
  }

  // ========== 测试12d: 访客重复登记检测 ==========
  console.log('\n📋 测试12d: 访客重复登记检测');
  {
    const spD = (await httpJson('POST', '/api/spaces', { name: '访客重复办公室', squat_count: 1, urinal_count: 1 })).json;
    const aD = 'dupd_' + runKey, bD = 'dupdb_' + runKey;
    await reg(aD, 'pw', '重复接待人'); await reg(bD, 'pw', '重复成员');
    const wD = await createWSClient(); await loginTo(wD, spD.id, aD, 'pw');
    const wE = await createWSClient(); await loginTo(wE, spD.id, bD, 'pw');
    // 第一次登记成功
    await sendMsg(wD, { type: 'visitorCreate', visitorName: '客户王', purpose: '商务洽谈' });
    assert(mk(wD, 'visitorCreated').length >= 1, '首次登记访客成功');
    // 同一天同一访客重复登记被拒
    await sendMsg(wD, { type: 'visitorCreate', visitorName: '客户王', purpose: '重复事由' });
    const errDup = mk(wD, 'error').pop();
    assert(errDup && errDup.code === 'duplicateVisitor', '同一天同访客重复登记返回 duplicateVisitor');
    assert(errDup && errDup.message.includes('请勿重复登记'), '重复登记提示语明确');
    // 不同访客名可登记
    await sendMsg(wD, { type: 'visitorCreate', visitorName: '客户赵', purpose: '面试' });
    assert(mk(wD, 'visitorCreated').length >= 2, '不同访客名可登记');
    // 他人接待的同访客名不受限制
    await sendMsg(wE, { type: 'visitorCreate', visitorName: '客户王', purpose: '他人访客' });
    assert(mk(wE, 'visitorCreated').length >= 1, '他人接待同访客名不受重复限制');
    wD.close(); wE.close();
  }

  // ========== 测试13: 个人资料 ==========
  console.log('\n📋 测试13: 个人资料');
  {
    const spP = (await httpJson('POST', '/api/spaces', { name: '资料办公室', squat_count: 1, urinal_count: 1 })).json;
    const aP = 'prof_' + runKey;
    await reg(aP, 'oldpass', '旧名');
    const wP1 = await createWSClient(); await loginTo(wP1, spP.id, aP, 'oldpass');
    await sendMsg(wP1, { type: 'profileUpdate', nickname: '新名字', avatar: '🦊' });
    const pu = last(wP1, 'profileUpdated');
    assert(pu && pu.nickname === '新名字' && pu.avatar === '🦊', '修改展示名与头像成功');
    const uP = last(wP1, 'users').users.find((u) => u.account === aP);
    assert(uP && uP.username === '新名字' && uP.avatar === '🦊', '用户列表同步新资料');
    await sendMsg(wP1, { type: 'passwordChange', oldPassword: 'wrong', newPassword: 'newpass' });
    const errPw = mk(wP1, 'error');
    assert(errPw.length > 0 && errPw[errPw.length - 1].message.includes('旧密码错误'), '旧密码错误时拒绝改密');
    await sendMsg(wP1, { type: 'passwordChange', oldPassword: 'oldpass', newPassword: 'newpass' });
    assert(last(wP1, 'passwordChanged'), '凭正确旧密码修改成功');
    const wP2 = await createWSClient();
    await sendMsg(wP2, { type: 'join', spaceId: spP.id });
    await sendMsg(wP2, { type: 'login', account: aP, password: 'newpass' });
    assert(last(wP2, 'loginSuccess'), '新密码可登录');
    wP1.close(); wP2.close();
  }

  // ========== 测试14: 空间设置（管理员改名） ==========
  console.log('\n📋 测试14: 空间设置');
  {
    const spS = (await httpJson('POST', '/api/spaces', { name: '旧空间名', squat_count: 1, urinal_count: 1 })).json;
    const aS = 'space_' + runKey;
    await reg(aS, 'pw', '空间管理员');
    const wS = await createWSClient(); await loginTo(wS, spS.id, aS, 'pw');
    await sendMsg(wS, { type: 'spaceRename', name: '新空间名' });
    const ren = last(wS, 'spaceRenamed');
    assert(ren && ren.name === '新空间名', '管理员改空间名成功');
    const spacesNow = await httpJson('GET', '/api/spaces');
    const found = (spacesNow.json || []).find((s) => s.id === spS.id);
    assert(found && found.name === '新空间名', '空间列表同步新名称');
    const bS = 'spacemem_' + runKey; await reg(bS, 'pw', '成员');
    const wM = await createWSClient(); await loginTo(wM, spS.id, bS, 'pw');
    await sendMsg(wM, { type: 'spaceRename', name: '非法改名' });
    const errR = mk(wM, 'error');
    assert(errR.length > 0 && errR[errR.length - 1].message.includes('仅管理员'), '非管理员改名被拒');
    wS.close(); wM.close();
  }

  // ========== 测试14b: 管理员成员管理 ==========
  console.log('\n📋 测试14b: 管理员成员管理');
  {
    const spM = (await httpJson('POST', '/api/spaces', { name: '管理员办公室', squat_count: 1, urinal_count: 1 })).json;
    const aM = 'mng_' + runKey, bM = 'mngb_' + runKey;
    await reg(aM, 'pw', '管理员'); await reg(bM, 'pw', '成员');
    const wA = await createWSClient(); await loginTo(wA, spM.id, aM, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spM.id, bM, 'pw');
    await sendMsg(wB, { type: 'spaceAdminSet', account: aM, admin: true });
    const errMng = mk(wB, 'error').pop();
    assert(errMng && errMng.message.includes('仅管理员'), '非管理员管理管理员被拒');
    await sendMsg(wA, { type: 'spaceAdminSet', account: bM, admin: true });
    const granted = last(wB, 'adminSet');
    assert(granted && granted.admin === true, '成员收到授予管理员通知');
    assert(last(wB, 'users').users.find(u => u.account === bM).role === 'admin', '用户列表角色更新为管理员');
    await sendMsg(wA, { type: 'spaceAdminSet', account: aM, admin: false });
    assert(last(wA, 'users').users.find(u => u.account === aM).role === 'member', '取消自己管理员后角色变为成员');
    await sendMsg(wB, { type: 'spaceAdminSet', account: bM, admin: false });
    const errLast = mk(wB, 'error').pop();
    assert(errLast && errLast.message.includes('至少保留一名管理员'), '移除最后一名管理员被拒');
    wA.close(); wB.close();
  }

  // ========== 测试14c: 成员移除 ==========
  console.log('\n📋 测试14c: 成员移除');
  {
    const spK = (await httpJson('POST', '/api/spaces', { name: '移除办公室', squat_count: 1, urinal_count: 1 })).json;
    const aK = 'kick_' + runKey, bK = 'kickm_' + runKey, cK = 'kickc_' + runKey;
    await reg(aK, 'pw', '踢人管理员'); await reg(bK, 'pw', '被踢成员'); await reg(cK, 'pw', '普通成员');
    const wA = await createWSClient(); await loginTo(wA, spK.id, aK, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spK.id, bK, 'pw');
    const wC = await createWSClient(); await loginTo(wC, spK.id, cK, 'pw');
    await sendMsg(wC, { type: 'spaceKick', account: bK });
    const errKick = mk(wC, 'error').pop();
    assert(errKick && errKick.message.includes('仅管理员'), '非管理员移除成员被拒');
    await sendMsg(wA, { type: 'spaceKick', account: aK });
    const errSelf = mk(wA, 'error').pop();
    assert(errSelf && errSelf.message.includes('不能移除自己'), '不能移除自己');
    await sendMsg(wA, { type: 'spaceKick', account: bK });
    const kicked = mk(wB, 'spaceKicked');
    assert(kicked.length >= 1, '被踢成员收到 spaceKicked');
    assert(last(wA, 'spaceKicked').account === bK, '管理员收到移除结果');
    assert(!last(wA, 'users').users.some((u) => u.account === bK), '被踢成员从在线列表移除');
    assert(last(wA, 'notices').notices.some((n) => n.text.includes('移除了成员')), '移除成员写入公告留痕');
    wA.close(); wB.close(); wC.close();
  }

  // ========== 测试15: 紧急模式 ==========
  console.log('\n📋 测试15: 紧急模式');
  {
    const spE = (await httpJson('POST', '/api/spaces', { name: '紧急办公室', squat_count: 1, urinal_count: 1 })).json;
    const aE = 'emg_' + runKey;
    await reg(aE, 'pw', '紧急用户');
    const wE = await createWSClient(); await loginTo(wE, spE.id, aE, 'pw');
    await sendMsg(wE, { type: 'toggleEmergency', enabled: true });
    const em = last(wE, 'emergencyToggled');
    assert(em && em.enabled === true, '开启紧急模式成功');
    const uE = last(wE, 'users').users.find((u) => u.account === aE);
    assert(uE && uE.emergencyMode === true, '用户广播含紧急模式');
    wE.close();
  }

  // ========== 测试16: 空间暂停 ==========
  console.log('\n📋 测试16: 空间暂停');
  {
    const spP = (await httpJson('POST', '/api/spaces', { name: '暂停办公室', squat_count: 1, urinal_count: 1 })).json;
    const aP = 'pause_' + runKey, bP = 'pausem_' + runKey;
    await reg(aP, 'pw', '暂停管理员');
    await reg(bP, 'pw', '暂停成员');
    const wA = await createWSClient(); await loginTo(wA, spP.id, aP, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spP.id, bP, 'pw');
    await sendMsg(wA, { type: 'roomCreate', name: '小会', capacity: 4 });
    const rid = last(wA, 'rooms').rooms[0].id;
    await sendMsg(wA, { type: 'toolCreate', name: '测试机', category: '测试电脑', total: 1 });
    const tid = last(wA, 'tools').tools[0].id;
    await sendMsg(wA, { type: 'spacePause', paused: true, reason: '搬迁' });
    const paused = last(wB, 'spacePaused');
    assert(paused && paused.paused === true && paused.reason === '搬迁', '暂停广播到全员');
    await sendMsg(wB, { type: 'roomBook', roomId: rid, startAt: Date.now() + 10 * 60000, endAt: Date.now() + 40 * 60000 });
    const errP = mk(wB, 'error');
    assert(errP.length > 0 && errP[errP.length - 1].message.includes('空间已暂停'), '暂停时成员预约被拒');
    await sendMsg(wB, { type: 'toolBorrow', toolId: tid, qty: 1 });
    const errB2 = mk(wB, 'error');
    assert(errB2.length > 0 && errB2[errB2.length - 1].message.includes('空间已暂停'), '暂停时成员借用被拒');
    await sendMsg(wA, { type: 'spacePause', paused: false, reason: '' });
    const resumed = last(wB, 'spacePaused');
    assert(resumed && resumed.paused === false, '恢复空间广播到全员');
    await sendMsg(wB, { type: 'roomBook', roomId: rid, startAt: Date.now() + 10 * 60000, endAt: Date.now() + 40 * 60000 });
    assert(last(wB, 'rooms') && last(wB, 'rooms').reservations.length === 1, '恢复后成员可预约');
    wA.close(); wB.close();
  }

  // ========== 测试17: 成就墙 ==========
  console.log('\n📋 测试17: 成就墙');
  {
    const spA = (await httpJson('POST', '/api/spaces', { name: '成就办公室', squat_count: 1, urinal_count: 1 })).json;
    const aA = 'ach_' + runKey;
    await reg(aA, 'pw', '成就用户');
    const wA = await createWSClient(); await loginTo(wA, spA.id, aA, 'pw');
    await sendMsg(wA, { type: 'getAchievements' });
    const ach = last(wA, 'achievements');
    assert(ach && Array.isArray(ach.achievements), '成就墙返回 achievements 数组');
    assert(ach.achievements.length === 15, '成就墙含 15 个成就');
    assert(ach.achievements.every((a) => a.id && a.name && a.desc && a.icon), '每项成就含 id/name/desc/icon');
    assert(ach.achievements.every((a) => a.current != null && a.target != null && a.pct != null && typeof a.unlocked === 'boolean'), '每项成就含进度字段');
    assert(ach.achievements.find((a) => a.id === 'punctual').target === 3, '守时达人目标值为 3');
    assert(ach.achievements.some((a) => a.id === 'borrower' && a.target === 3), '含办公向成就借阅达人');
    assert(ach.achievements.some((a) => a.id === 'logistician' && a.target === 5), '含后勤向成就后勤达人');
    wA.close();
  }

  // ========== 测试18: 公告管理（管理员删除） ==========
  console.log('\n📋 测试18: 公告管理');
  {
    const spN = (await httpJson('POST', '/api/spaces', { name: '公告办公室', squat_count: 1, urinal_count: 1 })).json;
    const aN = 'noti_' + runKey, bN = 'notim_' + runKey;
    await reg(aN, 'pw', '公告管理员'); await reg(bN, 'pw', '公告成员');
    const wN = await createWSClient(); await loginTo(wN, spN.id, aN, 'pw');
    const wM = await createWSClient(); await loginTo(wM, spN.id, bN, 'pw');
    await sendMsg(wN, { type: 'announce', text: '今晚加班' });
    let nt = last(wN, 'notices');
    assert(nt && nt.notices.length === 1 && nt.notices[0].text === '今晚加班', '公告广播成功');
    const nid = nt.notices[0].id;
    await sendMsg(wM, { type: 'removeNotice', noticeId: nid });
    const errN = mk(wM, 'error');
    assert(errN.length > 0 && errN[errN.length - 1].message.includes('仅管理员'), '非管理员删除公告被拒');
    await sendMsg(wN, { type: 'removeNotice', noticeId: nid });
    const rm = last(wN, 'noticeRemoved');
    assert(rm && rm.noticeId === nid, '管理员删除公告成功');
    nt = last(wN, 'notices');
    assert(nt && nt.notices.length === 0, '删除后公告列表清空');
    wN.close(); wM.close();
  }

  // ========== 测试19: 我的待办 ==========
  console.log('\n📋 测试19: 我的待办');
  {
    const spR = (await httpJson('POST', '/api/spaces', { name: '待办办公室', squat_count: 1, urinal_count: 1 })).json;
    const aR = 'rem_' + runKey;
    await reg(aR, 'pw', '待办用户');
    const wR = await createWSClient(); await loginTo(wR, spR.id, aR, 'pw');
    await sendMsg(wR, { type: 'getMyReminders' });
    const r = last(wR, 'myReminders').reminders;
    assert(r && 'overdueCount' in r && 'upcomingCount' in r && 'pendingVisitorCount' in r && 'assignedMaterialCount' in r && 'assignedRepairCount' in r, '我的待办返回完整聚合字段');
    assert(r.overdueCount === 0 && r.upcomingCount === 0 && r.pendingVisitorCount === 0, '无待办时各项计数为 0');
    wR.close();
  }

  // ========== 测试20: 空间趋势 ==========
  console.log('\n📋 测试20: 空间趋势');
  {
    const spT = (await httpJson('POST', '/api/spaces', { name: '趋势办公室', squat_count: 1, urinal_count: 1 })).json;
    const aT = 'trend_' + runKey;
    await reg(aT, 'pw', '趋势用户');
    const wT = await createWSClient(); await loginTo(wT, spT.id, aT, 'pw');
    await sendMsg(wT, { type: 'getSpaceTrend', days: 14 });
    const t = last(wT, 'spaceTrend');
    assert(t && Array.isArray(t.trend) && t.trend.length === 14, '趋势返回 14 天数组');
    assert(t.trend.every((b) => 'date' in b && 'meetings' in b && 'borrows' in b && 'requests' in b && 'repairs' in b && 'visitors' in b), '每项含 date 与五类计数');
    wT.close();
  }

  // ========== 测试21: 会议室开始前提醒 ==========
  console.log('\n📋 测试21: 会议室开始前提醒');
  {
    const spRem = (await httpJson('POST', '/api/spaces', { name: '提醒办公室', squat_count: 1, urinal_count: 1 })).json;
    const aRm = 'remind_' + runKey;
    await reg(aRm, 'pw', '提醒用户');
    const wRem = await createWSClient(); await loginTo(wRem, spRem.id, aRm, 'pw');
    await sendMsg(wRem, { type: 'roomCreate', name: '小会议室', capacity: 6 });
    const roomsListMsg = last(wRem, 'rooms');
    const roomId = roomsListMsg && roomsListMsg.rooms[0].id;
    assert(roomId, '提醒测试会议室创建成功');
    const startAt = Date.now() + 60000;
    await sendMsg(wRem, { type: 'roomBook', roomId, startAt, endAt: startAt + 30 * 60000, title: '提醒会' });
    // 等待 15s 定时器触发开始前提醒（提醒时间 = 预约时刻，立即满足）
    await new Promise((r) => setTimeout(r, 18000));
    const reminders = mk(wRem, 'roomReminder');
    assert(reminders.length >= 1 && reminders[reminders.length - 1].startAt === startAt, '会议室开始前提醒定时送达');
    wRem.close();
  }

  // ========== 测试22: 访客预计到访提醒 ==========
  console.log('\n📋 测试22: 访客预计到访提醒');
  {
    const spVis = (await httpJson('POST', '/api/spaces', { name: '访客提醒办公室', squat_count: 1, urinal_count: 1 })).json;
    const aVis = 'vrem_' + runKey;
    await reg(aVis, 'pw', '访客提醒用户');
    const wVis = await createWSClient(); await loginTo(wVis, spVis.id, aVis, 'pw');
    const expectedAt = Date.now() + 5 * 60000;
    await sendMsg(wVis, { type: 'visitorCreate', visitorName: '客户周', purpose: '拜访', expectedAt });
    const vList = last(wVis, 'visitors');
    const vRemind = vList && vList.visitors[0].remindAt;
    assert(vRemind && vRemind <= expectedAt && vRemind >= expectedAt - 15 * 60000, '访客携带预计到访提醒时间 remindAt');
    // 等待 15s 定时器触发到访前提醒（提醒时间 = 登记时刻，立即满足）
    await new Promise((r) => setTimeout(r, 18000));
    const vreminders = mk(wVis, 'visitorReminder');
    assert(vreminders.length >= 1 && vreminders[vreminders.length - 1].visitorName === '客户周', '访客预计到访提醒定时送达');
    wVis.close();
  }

  // ========== 测试23: 会议室评分与收藏 ==========
  console.log('\n📋 测试23: 会议室评分与收藏');
  {
    const spRate = (await httpJson('POST', '/api/spaces', { name: '评分办公室', squat_count: 1, urinal_count: 1 })).json;
    const aRate = 'rate_' + runKey;
    await reg(aRate, 'pw', '评分用户');
    const wRate = await createWSClient(); await loginTo(wRate, spRate.id, aRate, 'pw');
    await sendMsg(wRate, { type: 'roomCreate', name: '评分会议室', capacity: 6 });
    const roomsList = last(wRate, 'rooms');
    const roomId = roomsList && roomsList.rooms[0].id;
    assert(roomId, '评分测试会议室创建成功');
    // 收藏会议室
    await sendMsg(wRate, { type: 'roomFavorite', roomId });
    const fav = last(wRate, 'roomFavorites');
    assert(fav && Array.isArray(fav.favorites) && fav.favorites.includes(roomId), '收藏会议室返回收藏列表');
    // 预约一个很快就会开始的会议，等定时器自动置为进行中后结束
    const startAt = Date.now() + 2000;
    await sendMsg(wRate, { type: 'roomBook', roomId, startAt, endAt: startAt + 5 * 60000, title: '评分会' });
    await new Promise((r) => setTimeout(r, 18000));
    let resList = last(wRate, 'rooms');
    let res = resList && resList.reservations[0];
    assert(res && res.status === 'active', '预约自动开始为 active');
    await sendMsg(wRate, { type: 'roomEnd', reservationId: res.id });
    resList = last(wRate, 'rooms');
    res = resList && resList.reservations[0];
    assert(res && res.status === 'completed', '会议结束为 completed');
    // 评分 5 分
    await sendMsg(wRate, { type: 'roomRate', reservationId: res.id, score: 5, comment: '很好' });
    const rated = last(wRate, 'roomRated');
    assert(rated && rated.score === 5, '会议室评分成功返回');
    const roomsFinal = last(wRate, 'rooms');
    const room = roomsFinal && roomsFinal.rooms.find((r) => r.id === roomId);
    assert(room && room.rating && room.rating.count === 1 && room.rating.avg === 5, '会议室聚合评分 5 分');
    // 重复评分被拒
    await sendMsg(wRate, { type: 'roomRate', reservationId: res.id, score: 1 });
    const errRate = mk(wRate, 'error');
    assert(errRate.length > 0 && errRate[errRate.length - 1].message.includes('已评分'), '重复评分被拒');
    wRate.close();
  }

  // ========== 测试24: 工具借用自定义归还期限 ==========
  console.log('\n📋 测试24: 工具借用自定义归还期限');
  {
    const spB = (await httpJson('POST', '/api/spaces', { name: '自定义归还办公室', squat_count: 1, urinal_count: 1 })).json;
    const aB = 'bdue_' + runKey;
    await reg(aB, 'pw', '归还用户');
    const wB = await createWSClient(); await loginTo(wB, spB.id, aB, 'pw');
    await sendMsg(wB, { type: 'toolCreate', name: '测试手机X', category: '测试手机', total: 2 });
    const tools0 = last(wB, 'tools');
    const toolId = tools0 && tools0.tools[0].id;
    assert(toolId, '自定义归还测试设备创建成功');
    const customDue = Date.now() + 3 * 86400000;
    await sendMsg(wB, { type: 'toolBorrow', toolId, qty: 1, dueAt: customDue });
    const tools1 = last(wB, 'tools');
    const borrow = tools1 && tools1.tools[0].activeBorrows && tools1.tools[0].activeBorrows[0];
    assert(borrow && borrow.dueAt === customDue, '自定义归还期限生效');
    // 过近的自定义时间被拒
    await sendMsg(wB, { type: 'toolBorrow', toolId, qty: 1, dueAt: Date.now() + 60000 });
    const errDue = mk(wB, 'error');
    assert(errDue.length > 0 && errDue[errDue.length - 1].message.includes('至少晚于当前时间 30 分钟'), '过近的自定义归还时间被拒');
    // 归还后库存恢复
    await sendMsg(wB, { type: 'toolReturn', borrowId: borrow.id, condition: 'intact' });
    const toolsReturn = last(wB, 'tools');
    assert(toolsReturn && toolsReturn.tools[0].available === 2, '归还后库存恢复');
    wB.close();
  }

  // ========== 测试25: 报修升级序列化 ==========
  console.log('\n📋 测试25: 报修升级');
  {
    const spE = (await httpJson('POST', '/api/spaces', { name: '报修升级办公室', squat_count: 1, urinal_count: 1 })).json;
    const aE = 'esc_' + runKey;
    await reg(aE, 'pw', '升级用户');
    const wE = await createWSClient(); await loginTo(wE, spE.id, aE, 'pw');
    await sendMsg(wE, { type: 'repairCreate', category: '空调', location: '机房', description: '不制冷', priority: 'high' });
    const repList = last(wE, 'repairs');
    const rep = repList && repList.repairs[0];
    assert(rep && rep.priority === 'high' && rep.escalated === false, '高优先级报修初始 escalated=false');
    await sendMsg(wE, { type: 'repairCreate', category: '灯光', location: '走廊', description: '闪烁', priority: 'normal' });
    const repList2 = last(wE, 'repairs');
    const repNormal = repList2 && repList2.repairs.find((r) => r.priority === 'normal');
    assert(repNormal && repNormal.escalated === false, '普通优先级报修不进入升级队列');
    wE.close();
  }

  // ========== 测试26: 低库存预警 ==========
  console.log('\n📋 测试26: 低库存预警');
  {
    const spL = (await httpJson('POST', '/api/spaces', { name: '低库存办公室', squat_count: 1, urinal_count: 1 })).json;
    const aL = 'low_' + runKey;
    await reg(aL, 'pw', '低库存管理员');
    const wL = await createWSClient(); await loginTo(wL, spL.id, aL, 'pw');
    await sendMsg(wL, { type: 'toolCreate', name: '测试机X', category: '测试电脑', total: 1, minAvailable: 1 });
    const toolsL = last(wL, 'tools');
    const toolL = toolsL && toolsL.tools[0];
    assert(toolL && toolL.lowStock === true, '低库存设备返回 lowStock=true');
    assert(toolL && toolL.minAvailable === 1, '低库存设备返回 minAvailable 阈值');
    const lowMsg = mk(wL, 'toolLowStock');
    assert(lowMsg.length >= 1 && lowMsg[lowMsg.length - 1].toolName === '测试机X', '创建即触发管理员库存告急通知');
    wL.close();
  }

  // ========== 测试27: 库存阈值校验 ==========
  console.log('\n📋 测试27: 库存阈值校验');
  {
    const spM = (await httpJson('POST', '/api/spaces', { name: '阈值校验办公室', squat_count: 1, urinal_count: 1 })).json;
    const aM = 'min_' + runKey;
    await reg(aM, 'pw', '阈值管理员');
    const wM = await createWSClient(); await loginTo(wM, spM.id, aM, 'pw');
    await sendMsg(wM, { type: 'toolCreate', name: '测试机Y', category: '测试电脑', total: 2 });
    const toolsM = last(wM, 'tools');
    const toolM = toolsM && toolsM.tools[0];
    assert(toolM && toolM.minAvailable === 1, '未指定阈值时默认 1');
    // 创建时阈值超过总库存应被拒
    await sendMsg(wM, { type: 'toolCreate', name: '测试机Z', category: '测试电脑', total: 1, minAvailable: 2 });
    const errCreate = mk(wM, 'error');
    assert(errCreate.length > 0 && errCreate[errCreate.length - 1].message.includes('库存阈值需为 0 到总库存之间'), '创建阈值超过总库存被拒');
    // 调整时阈值超过总库存应被拒
    await sendMsg(wM, { type: 'toolAdjust', toolId: toolM.id, total: 2, minAvailable: 3 });
    const errAdjust = mk(wM, 'error');
    assert(errAdjust.length > 0 && errAdjust[errAdjust.length - 1].message.includes('库存阈值需为 0 到总库存之间'), '调整阈值超过总库存被拒');
    wM.close();
  }

  // ========== 测试28: 物资库存台账 ==========
  console.log('\n📋 测试28: 物资库存台账');
  {
    const spV = (await httpJson('POST', '/api/spaces', { name: '库存办公室', squat_count: 1, urinal_count: 1 })).json;
    const aV = 'inv_' + runKey, bV = 'invm_' + runKey;
    await reg(aV, 'pw', '库存管理员'); await reg(bV, 'pw', '库存成员');
    const wA = await createWSClient(); await loginTo(wA, spV.id, aV, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spV.id, bV, 'pw');
    // 创建阈值等于库存的物资，创建时即触发库存告急
    await sendMsg(wA, { type: 'inventoryCreate', name: '5号电池', category: '电池', unit: '节', total: 2, minAvailable: 2, location: '茶水间' });
    const inv0 = last(wA, 'inventory');
    const item0 = inv0 && inv0.items && inv0.items[0];
    assert(item0 && item0.lowStock === true, '库存阈值等于库存时返回 lowStock=true');
    assert(item0 && item0.minAvailable === 2, '物资库存暴露 minAvailable');
    const invLow = mk(wA, 'inventoryLowStock');
    assert(invLow.length >= 1 && invLow[invLow.length - 1].itemName === '5号电池', '创建即触发管理员库存告急通知');
    // 阈值超过总库存被拒
    await sendMsg(wA, { type: 'inventoryCreate', name: 'A4纸', category: '打印耗材', unit: '包', total: 1, minAvailable: 2 });
    const errInv = mk(wA, 'error');
    assert(errInv.length > 0 && errInv[errInv.length - 1].message.includes('库存阈值需为 0 到总库存之间'), '创建物资阈值超过库存被拒');
    // 成员领用
    await sendMsg(wB, { type: 'inventoryIssue', itemId: item0.id, qty: 1 });
    const inv1 = last(wB, 'inventory');
    const item1 = inv1 && inv1.items && inv1.items[0];
    assert(item1 && item1.available === 1, '成员领用后可用库存扣减');
    assert(item1 && item1.borrowedCount === 1, '成员领用后在领数量统计');
    // 超库存领用被拒
    await sendMsg(wB, { type: 'inventoryIssue', itemId: item0.id, qty: 2 });
    const errInvIssue = mk(wB, 'error');
    assert(errInvIssue.length > 0 && errInvIssue[errInvIssue.length - 1].message.includes('库存不足，无法领用'), '超库存领用被拒');
    // 成员归还
    await sendMsg(wB, { type: 'inventoryReturn', issueId: item1.activeIssues[0].id });
    const inv2 = last(wB, 'inventory');
    const item2 = inv2 && inv2.items && inv2.items[0];
    assert(item2 && item2.available === 2, '成员归还后可用库存恢复');
    assert(item2 && item2.borrowedCount === 0, '成员归还后在领数量清零');
    // 管理员删除无在领记录的物资
    await sendMsg(wA, { type: 'inventoryDelete', itemId: item2.id });
    const inv3 = last(wA, 'inventory');
    assert(inv3 && inv3.items && inv3.items.length === 0, '管理员删除物资成功');
    wA.close(); wB.close();
  }

  // ========== 测试29: 考勤打卡 ==========
  console.log('\n📋 测试29: 考勤打卡');
  {
    const spA = (await httpJson('POST', '/api/spaces', { name: '考勤办公室', squat_count: 1, urinal_count: 1 })).json;
    const aA = 'att_' + runKey, bA = 'attm_' + runKey;
    await reg(aA, 'pw', '考勤管理员'); await reg(bA, 'pw', '考勤成员');
    const wA = await createWSClient(); await loginTo(wA, spA.id, aA, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spA.id, bA, 'pw');
    // 管理员配置考勤规则：00:00 上班、宽限 0 分钟，任何打卡都判定迟到
    await sendMsg(wA, { type: 'attendConfig', workStart: '00:00', workEnd: '18:00', lateMinutes: 0 });
    const cfg = last(wA, 'attendance');
    assert(cfg && cfg.config && cfg.config.workStart === '00:00' && cfg.config.lateMinutes === 0, '管理员配置考勤规则并广播');
    // 成员上班打卡
    await sendMsg(wB, { type: 'attendCheckIn' });
    const attIn = last(wB, 'attendance');
    assert(attIn && attIn.records.length === 1 && attIn.records[0].status === 'checked_in', '成员上班打卡成功');
    assert(attIn && attIn.records[0].isLate === true, '超过上班时间判定迟到');
    assert(attIn && attIn.stats.checkedIn === 1 && attIn.stats.late === 1, '考勤统计反映迟到人数');
    // 重复打卡被拒
    await sendMsg(wB, { type: 'attendCheckIn' });
    const errRe = mk(wB, 'error');
    assert(errRe.length > 0 && errRe[errRe.length - 1].message.includes('已经打过上班卡'), '重复上班打卡被拒');
    // 成员下班打卡
    await sendMsg(wB, { type: 'attendCheckOut' });
    const attOut = last(wB, 'attendance');
    assert(attOut && attOut.records[0].status === 'checked_out' && attOut.records[0].checkOutAt, '成员下班打卡成功');
    assert(attOut && attOut.stats.checkedOut === 1, '考勤统计已下班人数');
    // 成员不能配置规则
    await sendMsg(wB, { type: 'attendConfig', workStart: '08:00', workEnd: '17:00', lateMinutes: 30 });
    const errCfg = mk(wB, 'error');
    assert(errCfg.length > 0 && errCfg[errCfg.length - 1].message.includes('仅管理员'), '成员配置考勤规则被拒');
    wA.close(); wB.close();
  }

  // ========== 总结 ==========
  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ 通过: ${passed}`);
  console.log(`❌ 失败: ${failed}`);
  if (errors.length > 0) { console.log(`\n失败详情:`); errors.forEach(e => console.log(`  - ${e}`)); }
  console.log(`${'='.repeat(50)}\n`);
  try { w1.close(); w2.close(); wsX.close(); wA.close(); w3.close(); w4.close(); } catch {}
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => { console.error('测试运行出错:', err); process.exit(1); });