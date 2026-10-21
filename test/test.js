// 自动化测试：OfficeSpace · 办公空间管理
// 覆盖全模块：会议室 / 工具借用 / 物资申领 / 报修 / 坑位看板 / 访客 / 考勤 / 工位 / 外出 / 反馈 / 活动 / 投票 / 知识库 / 待办任务 / 通知中心 / 扩展功能
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
async function waitFor(ws, type, predicate, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const a = mk(ws, type);
    if (a.length && predicate(a[a.length - 1])) return a[a.length - 1];
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

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

  // ========== 测试3f: 会议室准时率（准时/迟到统计） ==========
  console.log('\n📋 测试3f: 会议室准时率（准时/迟到统计）');
  {
    const spF = (await httpJson('POST', '/api/spaces', { name: '准时办公室', squat_count: 1, urinal_count: 1 })).json;
    const aF = 'punc_' + runKey;
    await reg(aF, 'pw', '准时用户');
    const wF = await createWSClient(); await loginTo(wF, spF.id, aF, 'pw');
    await sendMsg(wF, { type: 'roomCreate', name: '准时会议室', capacity: 6 });
    const ridF = last(wF, 'rooms').rooms[0].id;
    const tF = Date.now() + 5 * 1000;
    await sendMsg(wF, { type: 'roomBook', roomId: ridF, startAt: tF, endAt: tF + 30 * 60000, title: '准时会' });
    const rF = last(wF, 'rooms').reservations[0];
    await new Promise((r) => setTimeout(r, 6000)); // 等待开始时间过去
    await sendMsg(wF, { type: 'roomStart', reservationId: rF.id });
    const startedF = (last(wF, 'rooms').reservations || []).find(r => r.id === rF.id);
    assert(startedF && startedF.status === 'active' && startedF.actualStartAt, '准时测试会议开始');
    const stF = last(wF, 'stats');
    assert(stF && stF.stats.meetingOnTime === 1, '准时开始会议 meetingOnTime +1');
    assert(stF && stF.stats.meetingLate === 0, '准时开始会议 meetingLate 为 0');
    await sendMsg(wF, { type: 'roomEnd', reservationId: rF.id });
    const lbF = await waitFor(wF, 'leaderboard', (m) => (m.rankings || []).some(r => r.account === aF && r.stats.meetingOnTime === 1), 3000);
    assert(lbF, '排行榜携带会议室准时率');
    wF.close();
  }

  // ========== 测试3g: 会议室参会人名单与到场确认 ==========
  console.log('\n📋 测试3g: 会议室参会人名单与到场确认');
  {
    const spG = (await httpJson('POST', '/api/spaces', { name: '参会人办公室', squat_count: 1, urinal_count: 1 })).json;
    const aG = 'org_' + runKey, bG = 'atte_' + runKey, ghostG = 'ghost_' + runKey;
    await reg(aG, 'pw', '组织者'); await reg(bG, 'pw', '参会者');
    const wOrg = await createWSClient(); await loginTo(wOrg, spG.id, aG, 'pw');
    const wAte = await createWSClient(); await loginTo(wAte, spG.id, bG, 'pw');
    await sendMsg(wOrg, { type: 'roomCreate', name: '参会会议室', capacity: 8 });
    const ridG = last(wOrg, 'rooms').rooms[0].id;
    const tG = Date.now() + 5 * 1000;
    await sendMsg(wOrg, { type: 'roomBook', roomId: ridG, startAt: tG, endAt: tG + 30 * 60000, title: '周会', attendees: [bG] });
    const rG = last(wOrg, 'rooms').reservations[0];
    assert(rG && rG.attendees && rG.attendees.length === 1 && rG.attendees[0] === bG, '预约携带参会人名单');
    assert(rG && rG.attendedAccounts && rG.attendedAccounts.length === 0, '初始已到场名单为空');
    // 非在线成员的参会人被拒
    await sendMsg(wOrg, { type: 'roomBook', roomId: ridG, startAt: tG + 10 * 60000, endAt: tG + 40 * 60000, title: '非法会', attendees: [ghostG] });
    const errG = mk(wOrg, 'error').pop();
    assert(errG && errG.message.includes('不是本空间在线成员'), '非在线成员的参会人被拒');
    await new Promise((r) => setTimeout(r, 6000)); // 等待开始时间过去
    await sendMsg(wOrg, { type: 'roomStart', reservationId: rG.id });
    const startedG = (last(wOrg, 'rooms').reservations || []).find(r => r.id === rG.id);
    assert(startedG && startedG.status === 'active', '会议开始');
    const startedNotice = await waitFor(wAte, 'meetingStarted', (m) => m.reservationId === rG.id, 3000);
    assert(startedNotice, '参会者收到会议开始通知');
    await sendMsg(wAte, { type: 'meetingAttend', reservationId: rG.id });
    const rnG = last(wAte, 'rooms').reservations.find(r => r.id === rG.id);
    assert(rnG && (rnG.attendedAccounts || []).includes(bG), '参会者到场确认写入 attendedAccounts');
    assert(rnG && rnG.attendanceRate === 100, '到场率计算正确');
    wOrg.close(); wAte.close();
  }

  // ========== 测试3h: 会议室预约时长限制 ==========
  console.log('\n📋 测试3h: 会议室预约时长限制');
  {
    const spH = (await httpJson('POST', '/api/spaces', { name: '时长办公室', squat_count: 1, urinal_count: 1 })).json;
    const aH = 'dur_' + runKey;
    await reg(aH, 'pw', '时长用户');
    const wH = await createWSClient(); await loginTo(wH, spH.id, aH, 'pw');
    await sendMsg(wH, { type: 'roomCreate', name: '时长会议室', capacity: 6, minMinutes: 15, maxMinutes: 60 });
    const roomH = last(wH, 'rooms').rooms[0];
    assert(roomH && roomH.minMinutes === 15 && roomH.maxMinutes === 60, 'roomCreate 存储最短/最长预约时长');
    const tH = Date.now() + 10 * 60000;
    // 短于最短时长被拒
    await sendMsg(wH, { type: 'roomBook', roomId: roomH.id, startAt: tH, endAt: tH + 10 * 60000, title: '短会' });
    const errShort = mk(wH, 'error').pop();
    assert(errShort && errShort.code === 'roomDuration' && /至少 15 分钟/.test(errShort.message), '短于最短时长被拒');
    // 长于最长时长被拒
    await sendMsg(wH, { type: 'roomBook', roomId: roomH.id, startAt: tH, endAt: tH + 120 * 60000, title: '长会' });
    const errLong = mk(wH, 'error').pop();
    assert(errLong && errLong.code === 'roomDuration' && /最多 60 分钟/.test(errLong.message), '长于最长时长被拒');
    // 合法时长成功
    await sendMsg(wH, { type: 'roomBook', roomId: roomH.id, startAt: tH, endAt: tH + 30 * 60000, title: '正常会' });
    const okBook = (last(wH, 'rooms').reservations || []).some(r => r.title === '正常会');
    assert(okBook, '区间内时长预约成功');
    wH.close();
  }

  // ========== 测试3i: 会议室洞察 ==========
  console.log('\n📋 测试3i: 会议室洞察（评分口碑榜 + 使用率排行）');
  {
    const spI = (await httpJson('POST', '/api/spaces', { name: '洞察办公室', squat_count: 1, urinal_count: 1 })).json;
    const aI = 'insight_' + runKey;
    await reg(aI, 'pw', '洞察用户');
    const wI = await createWSClient(); await loginTo(wI, spI.id, aI, 'pw');
    await sendMsg(wI, { type: 'roomCreate', name: '口碑会议室', capacity: 4 });
    await sendMsg(wI, { type: 'roomCreate', name: '冷门会议室', capacity: 4 });
    const roomsI = last(wI, 'rooms').rooms;
    const tI = Date.now() + 5 * 1000;
    await sendMsg(wI, { type: 'roomBook', roomId: roomsI[0].id, startAt: tI, endAt: tI + 60 * 60000, title: '口碑会' });
    const resI = (last(wI, 'rooms').reservations || []).find(r => r.title === '口碑会');
    await new Promise((r) => setTimeout(r, 6000));
    await sendMsg(wI, { type: 'roomStart', reservationId: resI.id });
    await sendMsg(wI, { type: 'roomEnd', reservationId: resI.id });
    await sendMsg(wI, { type: 'roomRate', reservationId: resI.id, score: 5 });
    const roomsAfter = last(wI, 'rooms');
    assert(roomsAfter && roomsAfter.insights && Array.isArray(roomsAfter.insights.ratingRanking), 'rooms 广播携带洞察统计');
    assert(roomsAfter.insights.ratingRanking.some(r => r.name === '口碑会议室' && r.avg === 5), 'roomInsights 口碑榜包含评分会议室');
    assert(roomsAfter.insights.usageRanking.some(r => r.name === '口碑会议室' && r.todayCount === 1), 'roomInsights 使用率排行统计场次');
    wI.close();
  }

  // ========== 测试3j: 会议室设备与维护 ==========
  console.log('\n📋 测试3j: 会议室设备与维护（设备清单/维护期/设备过滤）');
  {
    const spM = (await httpJson('POST', '/api/spaces', { name: '设备维护办公室', squat_count: 1, urinal_count: 1 })).json;
    const aM = 'equip_' + runKey;
    await reg(aM, 'pw', '设备管理员');
    const wM = await createWSClient(); await loginTo(wM, spM.id, aM, 'pw');
    await sendMsg(wM, { type: 'roomCreate', name: '设备间', capacity: 8, equipment: ['投影', '投影', '白板', '电视'] });
    let roomM = last(wM, 'rooms').rooms[0];
    assert(roomM && roomM.equipment.join(',') === '投影,白板,电视', 'roomCreate 设备清单去重');
    await sendMsg(wM, { type: 'roomEquipment', roomId: roomM.id, equipment: ['投影', '白板', '新设备'] });
    roomM = last(wM, 'rooms').rooms.find(r => r.id === roomM.id);
    assert(roomM.equipment.join(',') === '投影,白板,新设备', 'roomEquipment 更新设备清单');
    const untilM = Date.now() + 3600000;
    await sendMsg(wM, { type: 'roomMaintenance', roomId: roomM.id, until: untilM });
    roomM = last(wM, 'rooms').rooms.find(r => r.id === roomM.id);
    assert(roomM.maintenance === true && roomM.maintenanceUntil === untilM, 'roomMaintenance 进入维护状态');
    const tM = Date.now() + 10 * 60000;
    await sendMsg(wM, { type: 'roomBook', roomId: roomM.id, startAt: tM, endAt: tM + 60 * 60000, equipment: ['投影'] });
    const errM = mk(wM, 'error').pop();
    assert(errM && errM.message.includes('维护中'), '维护期间预约被拒');
    await sendMsg(wM, { type: 'roomMaintenance', roomId: roomM.id, clear: true });
    roomM = last(wM, 'rooms').rooms.find(r => r.id === roomM.id);
    assert(roomM.maintenance === false, '解除维护后 maintenance=false');
    const tM2 = Date.now() + 20 * 60000;
    await sendMsg(wM, { type: 'roomBook', roomId: roomM.id, startAt: tM2, endAt: tM2 + 60 * 60000, title: '设备会', equipment: ['投影', '不存在设备'] });
    const resM = (last(wM, 'rooms').reservations || []).find(r => r.title === '设备会');
    assert(resM && resM.equipment.join(',') === '投影', '预约仅保留会议室已有设备');
    wM.close();
  }

  // ========== 测试3k: 我的日程 ==========
  console.log('\n📋 测试3k: 我的日程（聚合未来会议）');
  {
    const spS = (await httpJson('POST', '/api/spaces', { name: '日程办公室', squat_count: 1, urinal_count: 1 })).json;
    const aS = 'sched_' + runKey;
    await reg(aS, 'pw', '日程用户');
    const wS = await createWSClient(); await loginTo(wS, spS.id, aS, 'pw');
    await sendMsg(wS, { type: 'roomCreate', name: '日程室', capacity: 6 });
    const roomS = last(wS, 'rooms').rooms[0];
    await sendMsg(wS, { type: 'roomBook', roomId: roomS.id, startAt: Date.now() + 3600000, endAt: Date.now() + 4200000, title: '未来会' });
    await sendMsg(wS, { type: 'getMySchedule', days: 7 });
    const sch = last(wS, 'mySchedule');
    assert(sch && sch.schedule.days === 7, 'mySchedule 返回天数 7');
    assert(sch && sch.schedule.items.some(i => i.title === '未来会' && i.type === 'meeting'), 'mySchedule 聚合未来会议');
    wS.close();
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

  // ========== 测试4f: 设备洞察 ==========
  console.log('\n📋 测试4f: 设备洞察（借用热度 + 归还状态 + 逾期概览）');
  {
    const spI = (await httpJson('POST', '/api/spaces', { name: '设备洞察办公室', squat_count: 1, urinal_count: 1 })).json;
    const aI = 'inso_' + runKey, bI = 'insm_' + runKey;
    await reg(aI, 'pw', '洞察管理员'); await reg(bI, 'pw', '洞察成员');
    const wI = await createWSClient(); await loginTo(wI, spI.id, aI, 'pw');
    const wJ = await createWSClient(); await loginTo(wJ, spI.id, bI, 'pw');
    await sendMsg(wI, { type: 'toolCreate', name: '洞察机', category: '测试电脑', total: 2 });
    const tidI = last(wI, 'tools').tools[0].id;
    await sendMsg(wJ, { type: 'toolBorrow', toolId: tidI, qty: 1 });
    const bwI = last(wJ, 'tools').tools.find(t => t.id === tidI).activeBorrows[0];
    await sendMsg(wJ, { type: 'toolReturn', borrowId: bwI.id, condition: 'damaged' });
    const insI = last(wJ, 'tools').insights;
    assert(insI && insI.totalBorrows === 1, '设备洞察统计累计借用 1 次');
    assert(insI.returnConditions.damaged === 1, '设备洞察统计损坏归还 1 次');
    assert(insI.damagedRate === 100, '设备洞察损坏率 100%');
    assert(insI.borrowHeat.some(t => t.name === '洞察机' && t.borrowCount === 1), '设备洞察热度榜包含设备借用次数');
    wI.close(); wJ.close();
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

  // ========== 测试5c: 物资申领优先级 ==========
  console.log('\n📋 测试5c: 物资申领优先级');
  await sendMsg(w2, { type: 'materialRequest', name: '高优先电池', qty: 2, unit: '节', reason: '急需', priority: 'high' });
  await sendMsg(w2, { type: 'materialRequest', name: '普通纸', qty: 1, unit: '包', reason: '常规', priority: 'low' });
  mats5 = last(w2, 'materials');
  assert(mats5.requests.some(r => r.name === '高优先电池' && r.priority === 'high'), '高优先级申领保留 priority');
  const highReq = mats5.requests.find(r => r.name === '高优先电池');
  await sendMsg(w2, { type: 'materialUpdate', requestId: highReq.id, priority: 'low' });
  mats5 = last(w2, 'materials');
  assert(mats5.requests.find(r => r.id === highReq.id).priority === 'low', '申请人可调整物资优先级');
  const lowReq = mats5.requests.find(r => r.name === '普通纸');
  await sendMsg(w4, { type: 'materialUpdate', requestId: lowReq.id, priority: 'high' });
  const errUpd = mk(w4, 'error');
  assert(errUpd.length > 0 && errUpd[errUpd.length - 1].message.includes('仅申请人或管理员'), '非申请人调整优先级被拒');

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

  // ========== 测试6e: 报修跟进评论 ==========
  console.log('\n📋 测试6e: 报修跟进评论');
  await sendMsg(w2, { type: 'repairCreate', category: '灯光', location: '2F 茶水间', description: '灯不亮' });
  let rep6e = last(w2, 'repairs');
  const rep6eItem = rep6e.repairs.find(r => r.description === '灯不亮');
  const rep6eId = rep6eItem.id;
  // 上报人跟进评论
  await sendMsg(w2, { type: 'repairComment', repairId: rep6eId, text: '物业已确认上门时间' });
  let rep6e1 = last(w2, 'repairs');
  let item6e1 = rep6e1.repairs.find(r => r.id === rep6eId);
  assert(item6e1.commentCount === 1, '上报人跟进评论成功');
  assert(item6e1.comments[0].text === '物业已确认上门时间', '跟进评论内容正确');
  // 指派负责人后，负责人也可跟进
  await sendMsg(w2, { type: 'repairAssign', repairId: rep6eId, handlerAccount: THIRD });
  await sendMsg(w3, { type: 'repairComment', repairId: rep6eId, text: '已下单配件' });
  let rep6e2 = last(w3, 'repairs');
  let item6e2 = rep6e2.repairs.find(r => r.id === rep6eId);
  assert(item6e2.commentCount === 2, '负责人跟进评论成功');
  // 无关成员评论被拒
  await sendMsg(w4, { type: 'repairComment', repairId: rep6eId, text: '我也来说一句' });
  const err6e = mk(w4, 'error');
  assert(err6e.length > 0 && err6e[err6e.length - 1].message.includes('仅上报人、负责人或管理员'), '无关成员评论被拒');
  // 空评论被拒
  await sendMsg(w2, { type: 'repairComment', repairId: rep6eId, text: '   ' });
  const err6eEmpty = mk(w2, 'error');
  assert(err6eEmpty.length > 0 && err6eEmpty[err6eEmpty.length - 1].message.includes('请输入跟进内容'), '空跟进评论被拒');

  // ========== 测试6f: 报修满意度评分 ==========
  console.log('\n📋 测试6f: 报修满意度评分');
  // 上报 → 处理中 → 已解决 → 上报人评价 4 星
  await sendMsg(w2, { type: 'repairCreate', category: '灯光', location: '2F 满意度评分测试', description: '评分用灯' });
  let rep6f = last(w2, 'repairs');
  const rep6fId = rep6f.repairs.find(r => r.description === '评分用灯').id;
  await sendMsg(w1, { type: 'repairUpdate', repairId: rep6fId, status: 'in_progress' });
  await sendMsg(w1, { type: 'repairUpdate', repairId: rep6fId, status: 'resolved' });
  await sendMsg(w2, { type: 'repairRate', repairId: rep6fId, satisfaction: 4, satisfactionComment: '修得很快' });
  rep6f = last(w2, 'repairs');
  const item6f = rep6f.repairs.find(r => r.id === rep6fId);
  assert(item6f.satisfaction === 4, '上报人对已解决报修评价 4 星成功');
  assert(item6f.satisfactionComment === '修得很快', '满意度评价文本正确');
  assert(mk(w2, 'repairRated').length >= 1, '评价后下发 repairRated 通知');
  // 未解决时评价被拒
  await sendMsg(w2, { type: 'repairCreate', category: '灯光', location: '2F 未解决评分', description: '未解决' });
  const rep6f2Id = last(w2, 'repairs').repairs.find(r => r.description === '未解决').id;
  await sendMsg(w2, { type: 'repairRate', repairId: rep6f2Id, satisfaction: 5 });
  const err6f2 = mk(w2, 'error');
  assert(err6f2.length > 0 && err6f2[err6f2.length - 1].message.includes('已解决'), '未解决报修评价被拒');
  // 非上报人评价被拒
  await sendMsg(w3, { type: 'repairRate', repairId: rep6fId, satisfaction: 3 });
  const err6f3 = mk(w3, 'error');
  assert(err6f3.length > 0 && err6f3[err6f3.length - 1].message.includes('仅上报人或管理员'), '非上报人评价被拒');
  // 重复评价被拒
  await sendMsg(w2, { type: 'repairRate', repairId: rep6fId, satisfaction: 5 });
  const err6f4 = mk(w2, 'error');
  assert(err6f4.length > 0 && err6f4[err6f4.length - 1].message.includes('已评价'), '重复评价被拒');
  // satisfaction 越界被拒（0 / 6）
  await sendMsg(w2, { type: 'repairCreate', category: '灯光', location: '2F 越界评分', description: '越界' });
  const rep6f5Id = last(w2, 'repairs').repairs.find(r => r.description === '越界').id;
  await sendMsg(w1, { type: 'repairUpdate', repairId: rep6f5Id, status: 'resolved' });
  await sendMsg(w2, { type: 'repairRate', repairId: rep6f5Id, satisfaction: 0 });
  const err6f5 = mk(w2, 'error');
  assert(err6f5.length > 0 && err6f5[err6f5.length - 1].message.includes('1-5'), '满意度 0 分被拒');
  await sendMsg(w2, { type: 'repairRate', repairId: rep6f5Id, satisfaction: 6 });
  const err6f6 = mk(w2, 'error');
  assert(err6f6.length > 0 && err6f6[err6f6.length - 1].message.includes('1-5'), '满意度 6 分被拒');

  // ========== 测试6g: 报修满意度统计 ==========
  console.log('\n📋 测试6g: 报修满意度统计');
  // 同位置两次已解决报修（触发高频故障），加一条低分工单
  await sendMsg(w2, { type: 'repairCreate', category: '灯光', location: '2F 统计热点', description: '热点1' });
  let rep6g = last(w2, 'repairs');
  const rep6g1 = rep6g.repairs.find(r => r.description === '热点1').id;
  await sendMsg(w1, { type: 'repairUpdate', repairId: rep6g1, status: 'resolved' });
  await sendMsg(w2, { type: 'repairCreate', category: '灯光', location: '2F 统计热点', description: '热点2' });
  rep6g = last(w2, 'repairs');
  const rep6g2 = rep6g.repairs.find(r => r.description === '热点2').id;
  await sendMsg(w1, { type: 'repairUpdate', repairId: rep6g2, status: 'resolved' });
  await sendMsg(w2, { type: 'repairRate', repairId: rep6g1, satisfaction: 5 });
  await sendMsg(w2, { type: 'repairRate', repairId: rep6g2, satisfaction: 2 });
  const rep6gList = last(w2, 'repairs');
  assert(rep6gList && rep6gList.stats && typeof rep6gList.stats.avgSatisfaction === 'number', 'repairs 广播携带满意度统计');
  assert(rep6gList.stats.rated >= 2, 'repairs 统计已评价数');
  assert(rep6gList.stats.lowSatisfaction >= 1, 'repairs 统计低分工单（≤2星）');
  assert(rep6gList.stats.hotspots && rep6gList.stats.hotspots.some(h => h.location === '2F 统计热点' && h.count >= 2), 'repairs 统计识别高频故障位置');

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
    assert(nt && nt.notices.some((x) => x.text === '周五提前下班'), '公告广播到其他成员');
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
    assert(ach.achievements.length === 29, '成就墙含 29 个成就');
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
    let nt = await waitFor(wN, 'notices', (n) => n.notices.some((x) => x.text === '今晚加班'), 5000);
    assert(nt && nt.notices.some((x) => x.text === '今晚加班'), '公告广播成功');
    const nid = nt.notices.find((x) => x.text === '今晚加班').id;
    await sendMsg(wM, { type: 'removeNotice', noticeId: nid });
    const errN = mk(wM, 'error');
    assert(errN.length > 0 && errN[errN.length - 1].message.includes('仅管理员'), '非管理员删除公告被拒');
    await sendMsg(wN, { type: 'removeNotice', noticeId: nid });
    const rm = last(wN, 'noticeRemoved');
    assert(rm && rm.noticeId === nid, '管理员删除公告成功');
    nt = await waitFor(wN, 'notices', (n) => !n.notices.some((x) => x.id === nid), 5000);
    assert(nt && !nt.notices.some((x) => x.id === nid), '删除后公告列表清空');
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
    assert(t.trend.every((b) => 'date' in b && 'meetings' in b && 'borrows' in b && 'requests' in b && 'repairs' in b && 'visitors' in b && 'attends' in b && 'desks' in b && 'ooo' in b), '每项含 date 与七类计数');
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
    // 评分：多维度（环境/设备/服务），总体分自动取平均并取整
    await sendMsg(wRate, { type: 'roomRate', reservationId: res.id, scores: { environment: 5, equipment: 4, service: 3 }, comment: '环境好，投影偏暗' });
    const rated = last(wRate, 'roomRated');
    assert(rated && rated.score === 4 && rated.scores && rated.scores.environment === 5, '会议室多维度评分成功返回，总体分取平均');
    const roomsFinal = last(wRate, 'rooms');
    const room = roomsFinal && roomsFinal.rooms.find((r) => r.id === roomId);
    assert(room && room.rating && room.rating.count === 1 && room.rating.avg === 4, '会议室聚合总体评分 4 分');
    assert(room && room.rating.dimensions && room.rating.dimensions.environment.avg === 5 && room.rating.dimensions.equipment.avg === 4 && room.rating.dimensions.service.avg === 3, '会议室聚合维度评分正确');
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

  // ========== 测试30: 工位预约与外出登记 ==========
  console.log('\n📋 测试30: 工位预约与外出登记');
  {
    const spD = (await httpJson('POST', '/api/spaces', { name: '工位外出办公室', squat_count: 1, urinal_count: 1 })).json;
    const aD = 'desk_' + runKey, bD = 'deskm_' + runKey;
    await reg(aD, 'pw', '工位管理员'); await reg(bD, 'pw', '工位成员');
    const wA = await createWSClient(); await loginTo(wA, spD.id, aD, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spD.id, bD, 'pw');
    // 工位创建与预约
    await sendMsg(wA, { type: 'deskCreate', name: '3F工位A', location: '3F' });
    const desks0 = await waitFor(wA, 'desks', (d) => d.desks && d.desks.length === 1, 3000);
    const deskId = desks0 && desks0.desks[0].id;
    assert(deskId, '管理员创建工位成功');
    const startAt = Date.now() + 20 * 60000;
    await sendMsg(wB, { type: 'deskReserve', deskId, startAt, endAt: startAt + 60 * 60000, note: '专注' });
    const desks1 = await waitFor(wA, 'desks', (d) => d.reservations && d.reservations.length === 1, 3000);
    assert(desks1 && desks1.reservations[0].status === 'pending', '成员预约工位成功');
    const deskStats = await waitFor(wA, 'deskStats', (s) => s && s.desks && s.desks.length === 1, 3000);
    assert(deskStats && deskStats.utilizationPct >= 0, '工位统计广播包含利用率');
    // 工位签到 / 签退
    const resId = desks1.reservations[0].id;
    await sendMsg(wB, { type: 'deskStart', reservationId: resId });
    const deskActive = await waitFor(wA, 'desks', (d) => d.reservations && d.reservations.some((r) => r.id === resId && r.status === 'active'), 3000);
    assert(deskActive, '工位签到后状态流转为进行中');
    const deskActive2 = await waitFor(wA, 'desks', (d) => d.reservations && d.reservations.some((r) => r.id === resId && r.actualStartAt), 3000);
    assert(deskActive2, '工位签到记录实际到场时间');
    await sendMsg(wB, { type: 'deskEnd', reservationId: resId });
    const deskDone = await waitFor(wA, 'desks', (d) => d.reservations && d.reservations.some((r) => r.id === resId && r.status === 'completed'), 3000);
    assert(deskDone, '工位签退后状态流转为已完成');
    // 外出登记与状态同步
    await sendMsg(wB, { type: 'oooCreate', category: '出差', reason: '客户现场', expectedReturnAt: Date.now() + 2 * 3600000 });
    const oooMsg = await waitFor(wB, 'ooo', (o) => o.records && o.records.length === 1, 3000);
    assert(oooMsg && oooMsg.stats.activeCount === 1, '外出登记后统计 activeCount=1');
    const usersMsg = await waitFor(wB, 'users', (u) => u.users && u.users.some((x) => x.account === bD && x.status && x.status.label === '出差'), 3000);
    assert(usersMsg && usersMsg.users.find((x) => x.account === bD).status.label === '出差', '外出登记同步在线状态');
    await sendMsg(wB, { type: 'getMyReminders' });
    const myRem = await waitFor(wB, 'myReminders', (r) => r.reminders && r.reminders.activeOooCount === 1, 3000);
    assert(myRem && myRem.reminders.activeOooCount === 1, '我的待办聚合外出中');
    // 返回外出
    const oooId = oooMsg.records[0].id;
    await sendMsg(wB, { type: 'oooBack', oooId });
    const oooBackMsg = await waitFor(wB, 'oooBacked', (m) => m.category === '出差', 3000);
    assert(oooBackMsg, '外出返回通知送达');
    const oooAfter = await waitFor(wB, 'ooo', (o) => o.records && o.records.length === 0, 3000);
    assert(oooAfter && oooAfter.stats.activeCount === 0, '外出返回后 activeCount 归零');
    wA.close(); wB.close();
  }

  // ========== 测试31: 意见反馈 ==========
  console.log('\n📋 测试31: 意见反馈');
  {
    const spF = (await httpJson('POST', '/api/spaces', { name: '反馈办公室', squat_count: 1, urinal_count: 1 })).json;
    const aF = 'fb_' + runKey, bF = 'fbm_' + runKey;
    await reg(aF, 'pw', '反馈管理员'); await reg(bF, 'pw', '反馈成员');
    const wA = await createWSClient(); await loginTo(wA, spF.id, aF, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spF.id, bF, 'pw');
    // 成员匿名提交反馈
    await sendMsg(wB, { type: 'feedbackCreate', category: '建议', content: '希望增加意见反馈模块', anonymous: true });
    const fb0 = await waitFor(wB, 'feedback', (f) => f.records && f.records.length === 1, 3000);
    assert(fb0 && fb0.records[0].author === '匿名成员', '匿名反馈隐藏作者');
    assert(fb0 && fb0.records[0].status === 'open', '新反馈初始为待处理');
    assert(fb0 && fb0.stats.open === 1, '反馈统计待处理为 1');
    // 成员不能回复
    await sendMsg(wB, { type: 'feedbackReply', feedbackId: fb0.records[0].id, content: '我自己回复' });
    const fbErr = mk(wB, 'error');
    assert(fbErr.length > 0 && fbErr[fbErr.length - 1].message.includes('仅管理员'), '成员回复反馈被拒');
    // 管理员回复后闭环
    const fbId = fb0.records[0].id;
    await sendMsg(wA, { type: 'feedbackReply', feedbackId: fbId, content: '已收到，加入排期' });
    const fb1 = await waitFor(wA, 'feedback', (f) => f.records && f.records.some((r) => r.id === fbId && r.status === 'answered'), 3000);
    assert(fb1 && fb1.stats.answered === 1, '管理员回复后反馈已回复');
    // 管理员关闭反馈
    await sendMsg(wA, { type: 'feedbackClose', feedbackId: fbId });
    const fb2 = await waitFor(wA, 'feedback', (f) => f.records && f.records.some((r) => r.id === fbId && r.status === 'closed'), 3000);
    assert(fb2 && fb2.stats.closed === 1, '管理员关闭反馈成功');
    wA.close(); wB.close();
  }

  // ========== 总结 ==========

  // ========== 测试32: 心情打卡 ==========
  console.log('\n📋 测试32: 心情打卡');
  {
    const spM = (await httpJson('POST', '/api/spaces', { name: '心情办公室', squat_count: 1, urinal_count: 1 })).json;
    const aM = 'mood_' + runKey, bM = 'moody_' + runKey;
    await reg(aM, 'pw', '心情管理员'); await reg(bM, 'pw', '心情成员');
    const wA = await createWSClient(); await loginTo(wA, spM.id, aM, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spM.id, bM, 'pw');
    // 成员选择心情
    await sendMsg(wB, { type: 'moodCheckIn', emoji: '😊' });
    const mood0 = await waitFor(wB, 'mood', (m) => m.records && m.records.length === 1, 3000);
    assert(mood0 && mood0.records[0].emoji === '😊', '成员提交心情成功');
    assert(mood0 && mood0.stats.total === 1, '心情统计今日人数为 1');
    assert(mood0 && mood0.stats.counts['😊'] === 1, '心情统计计数正确');
    // 同一账号再次打卡应更新而非新增
    await sendMsg(wB, { type: 'moodCheckIn', emoji: '😡' });
    const mood1 = await waitFor(wB, 'mood', (m) => m.records && m.records.length === 1 && m.records[0].emoji === '😡', 3000);
    assert(mood1 && mood1.stats.total === 1, '同一账号每天只保留一条心情');
    // 管理员也打卡，统计为 2
    await sendMsg(wA, { type: 'moodCheckIn', emoji: '🤩' });
    const mood2 = await waitFor(wA, 'mood', (m) => m.records && m.records.length === 2, 3000);
    assert(mood2 && mood2.stats.total === 2, '多人心情统计累计');
    wA.close(); wB.close();
  }

  // ========== 测试33: 活动管理 ==========
  console.log('\n📋 测试33: 活动管理');
  {
    const spE = (await httpJson('POST', '/api/spaces', { name: '活动办公室', squat_count: 1, urinal_count: 1 })).json;
    const aE = 'evt_' + runKey, bE = 'evtm_' + runKey;
    await reg(aE, 'pw', '活动管理员'); await reg(bE, 'pw', '活动成员');
    const wA = await createWSClient(); await loginTo(wA, spE.id, aE, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spE.id, bE, 'pw');
    const startAt = Date.now() + 60 * 60000, endAt = Date.now() + 120 * 60000;
    // 管理员发起活动
    await sendMsg(wA, { type: 'eventCreate', title: 'Q4 分享会', description: '技术分享', category: '分享会', location: '3F', startAt, endAt, capacity: 5 });
    const ev0 = await waitFor(wA, 'events', (e) => e.events && e.events.length === 1, 3000);
    assert(ev0 && ev0.events[0].title === 'Q4 分享会', '管理员发起活动成功');
    assert(ev0 && ev0.stats.total === 1, '活动统计总数为 1');
    assert(ev0 && ev0.events[0].status === 'upcoming', '新活动状态为即将开始');
    // 成员 RSVP 参加
    const evId = ev0.events[0].id;
    await sendMsg(wB, { type: 'eventRsvp', rsvpId: evId, status: 'going' });
    const ev1 = await waitFor(wB, 'events', (e) => e.events && e.events.some((x) => x.id === evId && x.goingCount === 1), 3000);
    assert(ev1 && ev1.events.find((x) => x.id === evId).goingCount === 1, '成员 RSVP 参加成功');
    // 管理员也参与（maybe）
    await sendMsg(wA, { type: 'eventRsvp', rsvpId: evId, status: 'maybe' });
    const ev2 = await waitFor(wA, 'events', (e) => e.events && e.events.some((x) => x.id === evId && x.maybeCount === 1), 3000);
    assert(ev2 && ev2.events.find((x) => x.id === evId).maybeCount === 1, '管理员 RSVP 可能参加成功');
    // 成员不能取消他人活动
    await sendMsg(wB, { type: 'eventCancel', rsvpId: evId });
    const evErr = mk(wB, 'error');
    assert(evErr.length > 0 && evErr[evErr.length - 1].message.includes('只能取消自己'), '成员取消他人活动被拒');
    // 管理员取消活动
    await sendMsg(wA, { type: 'eventCancel', rsvpId: evId });
    const ev3 = await waitFor(wA, 'events', (e) => e.events && e.events.some((x) => x.id === evId && x.status === 'cancelled'), 3000);
    assert(ev3 && ev3.events.find((x) => x.id === evId).status === 'cancelled', '管理员取消活动成功');
    wA.close(); wB.close();
  }

  // ========== 测试34: 投票 ==========
  console.log('\n📋 测试34: 投票');
  {
    const spP = (await httpJson('POST', '/api/spaces', { name: '投票办公室', squat_count: 1, urinal_count: 1 })).json;
    const aP = 'poll_' + runKey, bP = 'pollm_' + runKey;
    await reg(aP, 'pw', '投票管理员'); await reg(bP, 'pw', '投票成员');
    const wA = await createWSClient(); await loginTo(wA, spP.id, aP, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spP.id, bP, 'pw');
    // 管理员发起匿名投票
    await sendMsg(wA, { type: 'pollCreate', question: '午饭吃什么', options: ['面', '饭'], anonymous: true });
    const pl0 = await waitFor(wA, 'polls', (p) => p.polls && p.polls.length === 1, 3000);
    assert(pl0 && pl0.polls[0].question === '午饭吃什么', '管理员发起投票成功');
    assert(pl0 && pl0.polls[0].options.length === 2, '投票包含两个选项');
    assert(pl0 && pl0.polls[0].anonymous === true, '投票匿名标记正确');
    // 成员投票
    const plId = pl0.polls[0].id, optId = pl0.polls[0].options[0].id;
    await sendMsg(wB, { type: 'pollVote', pollId: plId, optionId: optId });
    const pl1 = await waitFor(wB, 'polls', (p) => p.polls && p.polls.some((x) => x.id === plId && x.totalVotes === 1), 3000);
    assert(pl1 && pl1.polls.find((x) => x.id === plId).options[0].count === 1, '成员投票后票数正确');
    const votedMsg = await waitFor(wB, 'pollVoted', (m) => m.pollId === plId && m.optionId === optId, 3000);
    assert(votedMsg, '成员收到投票确认消息');
    // 管理员关闭投票
    await sendMsg(wA, { type: 'pollClose', pollId: plId });
    const pl2 = await waitFor(wA, 'polls', (p) => p.polls && p.polls.some((x) => x.id === plId && x.status === 'closed'), 3000);
    assert(pl2 && pl2.polls.find((x) => x.id === plId).status === 'closed', '管理员关闭投票成功');
    wA.close(); wB.close();
  }

  // ========== 测试35: 知识库 ==========
  console.log('\n📋 测试35: 知识库');
  {
    const spK = (await httpJson('POST', '/api/spaces', { name: '知识办公室', squat_count: 1, urinal_count: 1 })).json;
    const aK = 'kb_' + runKey, bK = 'kbm_' + runKey;
    await reg(aK, 'pw', '知识管理员'); await reg(bK, 'pw', '知识成员');
    const wA = await createWSClient(); await loginTo(wA, spK.id, aK, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spK.id, bK, 'pw');
    // 管理员发布文章
    await sendMsg(wA, { type: 'knowledgeCreate', title: '会议室规则', content: '用完关灯关空调', category: '规章制度', tags: ['会议室'] });
    const kb0 = await waitFor(wA, 'knowledge', (k) => k.knowledge && k.knowledge.length === 1, 3000);
    assert(kb0 && kb0.knowledge[0].title === '会议室规则', '管理员发布文章成功');
    assert(kb0 && kb0.knowledge[0].likeCount === 0, '新文章点赞为 0');
    // 成员点赞管理员文章
    const kbId = kb0.knowledge[0].id;
    await sendMsg(wB, { type: 'knowledgeLike', id: kbId });
    const kb1 = await waitFor(wB, 'knowledge', (k) => k.knowledge && k.knowledge.some((x) => x.id === kbId && x.likeCount === 1), 3000);
    assert(kb1 && kb1.knowledge.find((x) => x.id === kbId).likeCount === 1, '成员点赞成功，点赞数增加');
    const likedMsg = await waitFor(wB, 'knowledgeLiked', (m) => m.id === kbId && m.liked === true, 3000);
    assert(likedMsg, '成员收到点赞确认消息');
    // 成员不能删除他人文章
    await sendMsg(wB, { type: 'knowledgeDelete', id: kbId });
    const kbErr = mk(wB, 'error');
    assert(kbErr.length > 0 && kbErr[kbErr.length - 1].message.includes('只能删除自己的'), '成员删除他人文章被拒');
    // 成员发布并删除自己的文章
    await sendMsg(wB, { type: 'knowledgeCreate', title: '打印纸', content: 'A4 在打印区', category: '操作指引', tags: [] });
    const kb2 = await waitFor(wB, 'knowledge', (k) => k.knowledge && k.knowledge.length === 2, 3000);
    assert(kb2 && kb2.knowledge.length === 2, '成员发布自己的文章成功');
    const ownId = kb2.knowledge.find((x) => x.authorAccount === bK).id;
    await sendMsg(wB, { type: 'knowledgeDelete', id: ownId });
    const kb3 = await waitFor(wB, 'knowledge', (k) => k.knowledge && k.knowledge.length === 1, 3000);
    assert(kb3 && kb3.knowledge.length === 1, '成员删除自己的文章成功');
    wA.close(); wB.close();
  }
  // ========== 测试36: 待办任务 ==========
  console.log('\n📋 测试36: 待办任务');
  {
    const spT = (await httpJson('POST', '/api/spaces', { name: '任务办公室', squat_count: 1, urinal_count: 1 })).json;
    const aT = 'task_' + runKey, bT = 'taskm_' + runKey;
    await reg(aT, 'pw', '任务管理员'); await reg(bT, 'pw', '任务成员');
    const wA = await createWSClient(); await loginTo(wA, spT.id, aT, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spT.id, bT, 'pw');
    // 管理员创建任务并指派给成员
    await sendMsg(wA, { type: 'taskCreate', title: '修复会议室投影', description: '投影仪无信号', priority: 'high', assigneeAccount: bT });
    const tk0 = await waitFor(wA, 'tasks', (t) => t.tasks && t.tasks.length === 1, 3000);
    assert(tk0 && tk0.tasks[0].title === '修复会议室投影', '管理员创建任务成功');
    assert(tk0 && tk0.tasks[0].status === 'pending' && tk0.tasks[0].assigneeAccount === bT, '任务初始 pending 且带指派对象');
    assert(tk0 && tk0.tasks[0].priority === 'high' && tk0.tasks[0].assigneeAccount === bT, '任务保留优先级并带指派对象');
    const tkId = tk0.tasks[0].id;
    // 成员收到指派通知
    const assigned = await waitFor(wB, 'notifications', (n) => n.notifications && n.notifications.some((x) => x.type === 'taskAssigned'), 3000);
    assert(assigned && assigned.notifications.some((x) => x.type === 'taskAssigned'), '指派后成员收到通知');
    // 成员任务列表包含指派给自己的任务
    const tkB = await waitFor(wB, 'tasks', (t) => t.tasks && t.tasks.some((x) => x.id === tkId && x.assigneeAccount === bT), 3000);
    assert(tkB && tkB.tasks.find((x) => x.id === tkId).assigneeAccount === bT, '成员任务列表包含指派给自己的任务');
    // 负责人推进：开始 + 完成
    await sendMsg(wB, { type: 'taskStart', taskId: tkId });
    const tk1 = await waitFor(wB, 'tasks', (t) => t.tasks && t.tasks.some((x) => x.id === tkId && x.status === 'in_progress'), 3000);
    assert(tk1 && tk1.tasks.find((x) => x.id === tkId).status === 'in_progress', '负责人开始任务成功');
    await sendMsg(wB, { type: 'taskComplete', taskId: tkId });
    const tk2 = await waitFor(wB, 'tasks', (t) => t.tasks && t.tasks.some((x) => x.id === tkId && x.status === 'done'), 3000);
    assert(tk2 && tk2.tasks.find((x) => x.id === tkId).status === 'done', '负责人完成任务成功');
    const doneNotif = await waitFor(wA, 'notifications', (n) => n.notifications && n.notifications.some((x) => x.type === 'taskCompleted'), 3000);
    assert(doneNotif && doneNotif.notifications.some((x) => x.type === 'taskCompleted'), '任务完成后创建人收到通知');
    await sendMsg(wB, { type: 'getStats' });
    const stT = last(wB, 'stats');
    assert(stT && stT.stats.taskDoneCount === 1, '完成任务累计 taskDoneCount=1');
    // 负责人评论
    await sendMsg(wB, { type: 'taskComment', taskId: tkId, text: '投影已连接好' });
    const tkC = await waitFor(wB, 'tasks', (t) => t.tasks && t.tasks.some((x) => x.id === tkId && x.commentCount === 1), 3000);
    assert(tkC && tkC.tasks.find((x) => x.id === tkId).commentCount === 1, '负责人评论任务成功');
    assert(tkC && tkC.tasks.find((x) => x.id === tkId).comments[0].text === '投影已连接好', '任务评论内容正确');
    // 创建人评论
    await sendMsg(wA, { type: 'taskComment', taskId: tkId, text: '辛苦了，我来验收' });
    const tkD = await waitFor(wA, 'tasks', (t) => t.tasks && t.tasks.some((x) => x.id === tkId && x.commentCount === 2), 3000);
    assert(tkD && tkD.tasks.find((x) => x.id === tkId).commentCount === 2, '创建人评论任务成功');
    // 空评论被拒
    await sendMsg(wB, { type: 'taskComment', taskId: tkId, text: '   ' });
    const errTkC = mk(wB, 'error').pop();
    assert(errTkC && errTkC.message.includes('请输入评论内容'), '空任务评论被拒');
    // 非创建人删除被拒
    await sendMsg(wB, { type: 'taskRemove', taskId: tkId });
    const errRm = mk(wB, 'error').pop();
    assert(errRm && errRm.message.includes('只有创建人或管理员可删除'), '非创建人删除任务被拒');
    // 管理员删除
    await sendMsg(wA, { type: 'taskRemove', taskId: tkId });
    const tk3 = await waitFor(wA, 'tasks', (t) => t.tasks && t.tasks.length === 0, 3000);
    assert(tk3 && tk3.tasks.length === 0, '管理员删除任务成功');
    wA.close(); wB.close();
  }

  // ========== 测试37: 通知中心 ==========
  console.log('\n📋 测试37: 通知中心');
  {
    const spN = (await httpJson('POST', '/api/spaces', { name: '通知办公室', squat_count: 1, urinal_count: 1 })).json;
    const aN = 'notif_' + runKey, bN = 'notifm_' + runKey;
    await reg(aN, 'pw', '通知管理员'); await reg(bN, 'pw', '通知成员');
    const wA = await createWSClient(); await loginTo(wA, spN.id, aN, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spN.id, bN, 'pw');
    // 通过物资满足触发系统通知
    await sendMsg(wB, { type: 'materialRequest', name: '电池', qty: 4, unit: '节', reason: '遥控器' });
    const reqN = last(wB, 'materials').requests[0];
    await sendMsg(wA, { type: 'materialFulfill', requestId: reqN.id });
    // 成员收到通知且未读
    const nt0 = await waitFor(wB, 'notifications', (n) => n.notifications && n.notifications.some((x) => x.type === 'materialFulfilled'), 3000);
    assert(nt0 && nt0.notifications.some((x) => x.type === 'materialFulfilled'), '成员收到物资满足通知');
    assert(nt0 && nt0.unreadCount >= 1, '通知列表携带未读数≥1');
    assert(nt0 && nt0.notifications.some((x) => x.read === false), '未读通知 read=false');
    // 标记单条已读
    const ntId = nt0.notifications.find((x) => x.type === 'materialFulfilled').id;
    await sendMsg(wB, { type: 'notificationRead', notificationId: ntId });
    const nt1 = await waitFor(wB, 'notifications', (n) => n.notifications && n.notifications.some((x) => x.id === ntId && x.read === true), 3000);
    assert(nt1 && nt1.notifications.find((x) => x.id === ntId).read === true, '单条通知标记已读成功');
    // 全部已读
    await sendMsg(wB, { type: 'notificationReadAll' });
    const nt2 = await waitFor(wB, 'notifications', (n) => n.unreadCount === 0, 3000);
    assert(nt2 && nt2.unreadCount === 0, '全部已读后未读数为 0');
    wA.close(); wB.close();
  }

  // ========== 测试38: 考勤连续打卡与出勤日历 ==========
  console.log('\n📋 测试38: 考勤连续打卡与出勤日历');
  {
    const spC = (await httpJson('POST', '/api/spaces', { name: '打卡办公室', squat_count: 1, urinal_count: 1 })).json;
    const aC = 'cal_' + runKey, bC = 'calm_' + runKey;
    await reg(aC, 'pw', '日历管理员'); await reg(bC, 'pw', '日历成员');
    const wA = await createWSClient(); await loginTo(wA, spC.id, aC, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spC.id, bC, 'pw');
    await sendMsg(wA, { type: 'attendConfig', workStart: '00:00', workEnd: '18:00', lateMinutes: 0 });
    // 成员打卡（今日）
    await sendMsg(wB, { type: 'attendCheckIn' });
    const attIn = last(wB, 'attendance');
    assert(attIn && attIn.records.length === 1, '成员打卡成功');
    await sendMsg(wB, { type: 'getStats' });
    const stB = last(wB, 'stats');
    assert(stB && stB.stats.attendanceStreak >= 1, '今日打卡后连续打卡数≥1');
    assert(typeof stB.stats.attendancePerfectMonths === 'number', '打卡后统计含全勤月数');
    // 获取出勤日历
    const d = new Date();
    const yyyy = d.getFullYear(), mm = d.getMonth() + 1;
    await sendMsg(wB, { type: 'getAttendanceCalendar', year: yyyy, month: mm });
    const cal = last(wB, 'attendanceCalendar');
    assert(cal && cal.calendar && Array.isArray(cal.calendar.cells), '返回出勤日历单元格数组');
    const todayStr = `${yyyy}-${String(mm).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const todayCell = cal.calendar.cells.find((c) => c && c.date === todayStr);
    assert(todayCell && todayCell.checkedIn, '今日单元格包含打卡时间');
    assert(cal.calendar.streak >= 1, '日历返回连续打卡数≥1');
    assert(typeof cal.calendar.perfectMonthCount === 'number', '日历返回全勤月数');
    wA.close(); wB.close();
  }

  // ========== 测试39: 知识库评论 ==========
  console.log('\n📋 测试39: 知识库评论');
  {
    const spK = (await httpJson('POST', '/api/spaces', { name: '评论办公室', squat_count: 1, urinal_count: 1 })).json;
    const aK = 'kbc_' + runKey, bK = 'kbcm_' + runKey;
    await reg(aK, 'pw', '评论管理员'); await reg(bK, 'pw', '评论成员');
    const wA = await createWSClient(); await loginTo(wA, spK.id, aK, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spK.id, bK, 'pw');
    await sendMsg(wA, { type: 'knowledgeCreate', title: '报销流程', content: '每月 10 日前提交', category: '操作指引', tags: ['财务'] });
    const kb0 = await waitFor(wA, 'knowledge', (k) => k.knowledge && k.knowledge.length === 1, 3000);
    const kbId = kb0.knowledge[0].id;
    // 成员发表评论
    await sendMsg(wB, { type: 'knowledgeComment', id: kbId, text: '已提交，谢谢' });
    const kb1 = await waitFor(wB, 'knowledge', (k) => k.knowledge && k.knowledge.some((x) => x.id === kbId && x.commentCount === 1), 3000);
    assert(kb1 && kb1.knowledge.find((x) => x.id === kbId).commentCount === 1, '成员发表评论成功');
    assert(kb1 && kb1.knowledge.find((x) => x.id === kbId).comments[0].account === bK, '评论记录归属正确');
    const cmId = kb1.knowledge.find((x) => x.id === kbId).comments[0].id;
    // 作者回复该评论
    await sendMsg(wA, { type: 'knowledgeComment', id: kbId, text: '不客气，有问题随时找我', parentId: cmId });
    const kbReply = await waitFor(wB, 'knowledge', (k) => k.knowledge && k.knowledge.some((x) => x.id === kbId && x.commentCount === 2 && x.comments.some((c) => c.parentId === cmId)), 3000);
    assert(kbReply && kbReply.knowledge.find((x) => x.id === kbId).commentCount === 2, '作者回复评论成功');
    const replyItem = kbReply && kbReply.knowledge.find((x) => x.id === kbId).comments.find((c) => c.parentId === cmId);
    assert(replyItem && replyItem.parentName === '评论成员', '回复记录父级评论信息');
    // 二级回复被拒
    await sendMsg(wB, { type: 'knowledgeComment', id: kbId, text: '再回一层', parentId: replyItem.id });
    const errNested = mk(wB, 'error').pop();
    assert(errNested && errNested.message.includes('回复不能继续嵌套'), '二级回复被拒');
    // 回复不存在的评论被拒
    await sendMsg(wA, { type: 'knowledgeComment', id: kbId, text: '回复不存在的评论', parentId: 'cm_not_exist' });
    const errNotFound = mk(wA, 'error').pop();
    assert(errNotFound && errNotFound.message.includes('回复的评论不存在'), '回复不存在的评论被拒');
    // 空评论被拒
    await sendMsg(wB, { type: 'knowledgeComment', id: kbId, text: '   ' });
    const errEmpty = mk(wB, 'error').pop();
    assert(errEmpty && errEmpty.message.includes('请输入评论内容'), '空评论被拒');
    // 文章作者收到通知（broadcast 广播）
    const kb2 = await waitFor(wA, 'knowledge', (k) => k.knowledge && k.knowledge.some((x) => x.id === kbId && x.commentCount === 2), 3000);
    assert(kb2 && kb2.knowledge.find((x) => x.id === kbId).commentCount === 2, '作者端收到评论广播');
    wA.close(); wB.close();
  }

  // ========== 测试40: 会议室标签 ==========
  console.log('\n📋 测试40: 会议室标签');
  {
    const spT = (await httpJson('POST', '/api/spaces', { name: '标签办公室', squat_count: 1, urinal_count: 1 })).json;
    const aT = 'rmt_' + runKey, bT = 'rmtm_' + runKey;
    await reg(aT, 'pw', '标签管理员'); await reg(bT, 'pw', '标签成员');
    const wA = await createWSClient(); await loginTo(wA, spT.id, aT, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spT.id, bT, 'pw');
    // 管理员创建带标签的会议室
    await sendMsg(wA, { type: 'roomCreate', name: '标签会议室', capacity: 6, tags: ['投影', '白板'] });
    const rooms0 = await waitFor(wA, 'rooms', (r) => r.rooms && r.rooms.length === 1, 3000);
    const roomId = rooms0.rooms[0].id;
    assert(rooms0 && rooms0.rooms[0].tags.length === 2, '管理员创建带标签会议室成功');
    // 成员不能改标签
    await sendMsg(wB, { type: 'roomTag', roomId, tags: ['小'] });
    const errTag = mk(wB, 'error').pop();
    assert(errTag && errTag.message.includes('仅管理员'), '成员改标签被拒');
    // 管理员改标签
    await sendMsg(wA, { type: 'roomTag', roomId, tags: ['投影', '白板', '远程'] });
    const rooms1 = await waitFor(wA, 'rooms', (r) => r.rooms && r.rooms.some((x) => x.id === roomId && x.tags.length === 3), 3000);
    assert(rooms1 && rooms1.rooms.find((x) => x.id === roomId).tags.length === 3, '管理员改标签成功');
    wA.close(); wB.close();
  }

  // ========== 测试41: 会议室预约审批流 ==========
  console.log('\n📋 测试41: 会议室预约审批流');
  {
    const spP = (await httpJson('POST', '/api/spaces', { name: '审批办公室', squat_count: 1, urinal_count: 1 })).json;
    const aP = 'apv_' + runKey, bP = 'apvm_' + runKey;
    await reg(aP, 'pw', '审批管理员'); await reg(bP, 'pw', '审批成员');
    const wA = await createWSClient(); await loginTo(wA, spP.id, aP, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spP.id, bP, 'pw');
    const findRes = (msg, id) => (msg.reservations || []).find((r) => r.id === id);
    const findRoom = (msg, id) => (msg.rooms || []).find((r) => r.id === id);
    const base = Date.now();
    // 管理员创建会议室
    await sendMsg(wA, { type: 'roomCreate', name: '审批会议室', capacity: 6 });
    const rooms0 = await waitFor(wA, 'rooms', (r) => r.rooms && r.rooms.length === 1, 3000);
    const roomId = rooms0.rooms[0].id;
    assert(rooms0 && rooms0.rooms[0].requireApproval === false, '默认会议室无需审批');
    // 成员预约 → pending
    await sendMsg(wB, { type: 'roomBook', roomId, startAt: base + 10 * 60000, endAt: base + 40 * 60000, title: '普通会' });
    const rNormal = await waitFor(wB, 'rooms', (r) => r.reservations && r.reservations.some((x) => x.title === '普通会'), 3000);
    assert(rNormal && rNormal.reservations[0].status === 'pending', '未开启审批时预约为 pending');
    await sendMsg(wB, { type: 'reservationCancel', reservationId: rNormal.reservations[0].id });
    // 管理员开启审批
    await sendMsg(wA, { type: 'roomApproval', roomId, requireApproval: true });
    const roomsApproval = await waitFor(wA, 'rooms', (r) => r.rooms && r.rooms.some((x) => x.id === roomId && x.requireApproval === true), 3000);
    assert(roomsApproval && findRoom(roomsApproval, roomId).requireApproval === true, '管理员开启审批成功');
    // 成员预约 → pending_approval
    await sendMsg(wB, { type: 'roomBook', roomId, startAt: base + 50 * 60000, endAt: base + 80 * 60000, title: '需审批会' });
    const rNeed = await waitFor(wB, 'rooms', (r) => r.reservations && r.reservations.some((x) => x.title === '需审批会' && x.status === 'pending_approval'), 3000);
    assert(rNeed, '开启审批后预约进入 pending_approval');
    const resNeed = findRes(rNeed, rNeed.reservations.find((x) => x.title === '需审批会').id);
    // 成员不能审批
    await sendMsg(wB, { type: 'reservationApprove', reservationId: resNeed.id });
    const errApprove = mk(wB, 'error').pop();
    assert(errApprove && errApprove.message.includes('仅管理员'), '成员审批被拒');
    // 审批通知已产生
    const notif = await waitFor(wB, 'notifications', (n) => n.notifications && n.notifications.some((x) => x.type === 'roomApprovalRequested'), 3000);
    assert(notif, '待审批预约产生通知');
    // 管理员批准 → pending
    await sendMsg(wA, { type: 'reservationApprove', reservationId: resNeed.id });
    const rApproved = await waitFor(wA, 'rooms', (r) => r.reservations && r.reservations.some((x) => x.id === resNeed.id && x.status === 'pending'), 3000);
    assert(rApproved, '管理员批准后状态变为 pending');
    // 取消已批准的预约，再预约一次用于测试驳回
    await sendMsg(wB, { type: 'reservationCancel', reservationId: resNeed.id });
    await sendMsg(wB, { type: 'roomBook', roomId, startAt: base + 90 * 60000, endAt: base + 120 * 60000, title: '再审批会' });
    const rAgain = await waitFor(wB, 'rooms', (r) => r.reservations && r.reservations.some((x) => x.title === '再审批会' && x.status === 'pending_approval'), 3000);
    assert(rAgain, '再次预约进入 pending_approval');
    const resAgain = findRes(rAgain, rAgain.reservations.find((x) => x.title === '再审批会').id);
    // 管理员驳回 → cancelled
    await sendMsg(wA, { type: 'reservationReject', reservationId: resAgain.id });
    const rRejected = await waitFor(wA, 'rooms', (r) => r.reservations && r.reservations.some((x) => x.id === resAgain.id && x.status === 'cancelled'), 3000);
    assert(rRejected, '管理员驳回后状态变为 cancelled');
    // 管理员关闭审批
    await sendMsg(wA, { type: 'roomApproval', roomId, requireApproval: false });
    const roomsOff = await waitFor(wA, 'rooms', (r) => r.rooms && r.rooms.some((x) => x.id === roomId && x.requireApproval === false), 3000);
    assert(roomsOff && findRoom(roomsOff, roomId).requireApproval === false, '管理员关闭审批成功');
    // 候补晋升也必须遵守审批：开启审批后晋升的预约应为 pending_approval
    const cP = 'apvw_' + runKey;
    await reg(cP, 'pw', '候补成员');
    const wC = await createWSClient(); await loginTo(wC, spP.id, cP, 'pw');
    await sendMsg(wA, { type: 'roomApproval', roomId, requireApproval: true });
    const roomsWl = await waitFor(wA, 'rooms', (r) => r.rooms && r.rooms.some((x) => x.id === roomId && x.requireApproval === true), 3000);
    assert(roomsWl && findRoom(roomsWl, roomId).requireApproval === true, '候补测试重新开启审批');
    const tW = base + 200 * 60000;
    await sendMsg(wB, { type: 'roomBook', roomId, startAt: tW, endAt: tW + 30 * 60000, title: '占位会' });
    const rW1 = await waitFor(wB, 'rooms', (r) => r.reservations && r.reservations.some((x) => x.title === '占位会' && x.status === 'pending_approval'), 3000);
    assert(rW1, '成员占位预约进入 pending_approval');
    const resW = findRes(rW1, rW1.reservations.find((x) => x.title === '占位会').id);
    // 成员尝试重复预约同一时段应被拒（pending_approval 也占用时段）
    await sendMsg(wC, { type: 'roomBook', roomId, startAt: tW, endAt: tW + 30 * 60000, title: '插队会' });
    const errWl = mk(wC, 'error').pop();
    assert(errWl && errWl.message.includes('已被预约'), '待审批时段不可重复预约');
    // 加入候补
    await sendMsg(wC, { type: 'roomWaitlist', roomId, startAt: tW, endAt: tW + 30 * 60000, title: '候补会' });
    const wl = await waitFor(wC, 'rooms', (r) => r.waitlist && r.waitlist.some((w) => w.ownerAccount === cP && w.title === '候补会'), 3000);
    assert(wl, '成员加入候补成功');
    // 取消占位预约，候补晋升后应仍为 pending_approval
    await sendMsg(wB, { type: 'reservationCancel', reservationId: resW.id });
    const rPromoted = await waitFor(wC, 'rooms', (r) => r.reservations && r.reservations.some((x) => x.title === '候补会' && x.status === 'pending_approval'), 3000);
    assert(rPromoted, '候补晋升后预约仍为 pending_approval（遵守审批）');
    const resPromoted = findRes(rPromoted, rPromoted.reservations.find((x) => x.title === '候补会').id);
    // 管理员批准候补晋升的预约
    await sendMsg(wA, { type: 'reservationApprove', reservationId: resPromoted.id });
    const rApprovedWl = await waitFor(wA, 'rooms', (r) => r.reservations && r.reservations.some((x) => x.id === resPromoted.id && x.status === 'pending'), 3000);
    assert(rApprovedWl, '候补晋升审批批准成功');
    wA.close(); wB.close(); wC.close();
  }

  // ========== 测试42: 请假审批 ==========
  console.log('\n📋 测试42: 请假审批');
  {
    const spL = (await httpJson('POST', '/api/spaces', { name: '请假办公室', squat_count: 1, urinal_count: 1 })).json;
    const aL = 'lva_' + runKey, bL = 'lvm_' + runKey;
    await reg(aL, 'pw', '请假管理员'); await reg(bL, 'pw', '请假成员');
    const wA = await createWSClient(); await loginTo(wA, spL.id, aL, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spL.id, bL, 'pw');
    const base = Date.now();
    const findLeave = (msg, id) => (msg.leaves || []).find((r) => r.id === id);
    // 成员提交请假申请
    await sendMsg(wB, { type: 'leaveCreate', category: '事假', reason: '家里有事', startAt: base + 2 * 3600000, endAt: base + 4 * 3600000 });
    const leaves0 = await waitFor(wB, 'leaves', (r) => r.leaves && r.leaves.some((x) => x.category === '事假' && x.status === 'pending'), 3000);
    assert(leaves0 && leaves0.leaves[0].status === 'pending', '成员提交请假申请成功（pending）');
    assert(leaves0 && leaves0.leaves[0].account === bL, '请假记录关联提交账号');
    assert(leaves0 && leaves0.stats.pendingCount === 1, '请假统计 pendingCount=1');
    const leaveId = leaves0.leaves[0].id;
    // 重复提交被拒
    await sendMsg(wB, { type: 'leaveCreate', category: '病假', reason: '重复', startAt: base + 5 * 3600000, endAt: base + 7 * 3600000 });
    const errDup = mk(wB, 'error').pop();
    assert(errDup && errDup.message.includes('待审批'), '重复提交请假被拒');
    // 成员不能审批他人
    await sendMsg(wB, { type: 'leaveApprove', leaveId });
    const errMember = mk(wB, 'error').pop();
    assert(errMember && errMember.message.includes('仅管理员'), '成员审批被拒');
    // 成员不能取消他人（这里仅提交人是本人可取消，取消他人场景由管理员代测）
    await sendMsg(wB, { type: 'leaveCancel', leaveId });
    const leavesCancel = await waitFor(wB, 'leaves', (r) => r.leaves && r.leaves.some((x) => x.id === leaveId && x.status === 'cancelled'), 3000);
    assert(leavesCancel, '成员取消自己的请假申请成功');
    // 管理员审批：提交人申请，管理员批准
    await sendMsg(wB, { type: 'leaveCreate', category: '年假', reason: '回老家', startAt: base + 8 * 3600000, endAt: base + 10 * 3600000 });
    const leaves1 = await waitFor(wB, 'leaves', (r) => r.leaves && r.leaves.some((x) => x.category === '年假' && x.status === 'pending'), 3000);
    assert(leaves1, '再次提交请假申请成功');
    const leaveId2 = leaves1.leaves[0].id;
    await sendMsg(wA, { type: 'leaveApprove', leaveId: leaveId2 });
    const leavesApproved = await waitFor(wA, 'leaves', (r) => r.leaves && r.leaves.some((x) => x.id === leaveId2 && x.status === 'approved'), 3000);
    assert(leavesApproved && findLeave(leavesApproved, leaveId2).decidedBy === aL, '管理员批准后状态变为 approved 并记录审批人');
    // 申请人收到单发通知
    const notifyApproved = await waitFor(wB, 'leaveApproved', (m) => m.leaveId === leaveId2, 3000);
    assert(notifyApproved, '申请人收到 leaveApproved 单发通知');
    // 提交新申请用于驳回
    await sendMsg(wB, { type: 'leaveCreate', category: '调休', reason: '补休', startAt: base + 12 * 3600000, endAt: base + 14 * 3600000 });
    const leaves2 = await waitFor(wB, 'leaves', (r) => r.leaves && r.leaves.some((x) => x.category === '调休' && x.status === 'pending'), 3000);
    assert(leaves2, '提交用于驳回的请假申请');
    const leaveId3 = leaves2.leaves[0].id;
    await sendMsg(wA, { type: 'leaveReject', leaveId: leaveId3, decideNote: '人手不足' });
    const leavesRejected = await waitFor(wA, 'leaves', (r) => r.leaves && r.leaves.some((x) => x.id === leaveId3 && x.status === 'rejected'), 3000);
    assert(leavesRejected && findLeave(leavesRejected, leaveId3).decideNote === '人手不足', '管理员驳回并记录原因');
    const notifyRejected = await waitFor(wB, 'leaveRejected', (m) => m.leaveId === leaveId3, 3000);
    assert(notifyRejected && notifyRejected.decideNote === '人手不足', '申请人收到 leaveRejected 单发通知');
    // 批量审批：两个成员各提交一条，管理员一键批准全部
    const cL = 'lvc_' + runKey;
    await reg(cL, 'pw', '请假成员C');
    const wC = await createWSClient(); await loginTo(wC, spL.id, cL, 'pw');
    await sendMsg(wB, { type: 'leaveCreate', category: '事假', reason: '批量A', startAt: base + 20 * 3600000, endAt: base + 22 * 3600000 });
    await sendMsg(wC, { type: 'leaveCreate', category: '病假', reason: '批量B', startAt: base + 20 * 3600000, endAt: base + 22 * 3600000 });
    const leavesBatch = await waitFor(wB, 'leaves', (r) => r.stats && r.stats.pendingCount === 2, 3000);
    assert(leavesBatch, '两个成员各提交一条待审批请假');
    await sendMsg(wA, { type: 'leaveBatchApprove' });
    const leavesBatchApproved = await waitFor(wA, 'leaves', (r) => r.leaves && r.leaves.every((x) => x.status !== 'pending'), 3000);
    assert(leavesBatchApproved && leavesBatchApproved.stats.pendingCount === 0, '一键批准全部后待审批归零');
    assert(leavesBatchApproved && leavesBatchApproved.leaves.some((x) => x.category === '事假' && x.status === 'approved' && x.reason === '批量A'), '批量A 请假已批准');
    assert(leavesBatchApproved && leavesBatchApproved.leaves.some((x) => x.category === '病假' && x.status === 'approved' && x.reason === '批量B'), '批量B 请假已批准');
    assert(leavesBatchApproved && leavesBatchApproved.leaves.filter((x) => x.status === 'approved').every((x) => x.decidedBy === aL), '批量批准记录审批人');
    const notifyBatchA = await waitFor(wB, 'leaveApproved', (m) => m.category === '事假', 3000);
    const notifyBatchB = await waitFor(wC, 'leaveApproved', (m) => m.category === '病假', 3000);
    assert(notifyBatchA && notifyBatchB, '批量批准后两位申请人均收到单发通知');
    wA.close(); wB.close(); wC.close();
  }

  // ========== 测试43: 会议纪要 ==========
  console.log('\n📋 测试43: 会议纪要');
  {
    const spN = (await httpJson('POST', '/api/spaces', { name: '纪要办公室', squat_count: 1, urinal_count: 1 })).json;
    const aN = 'mna_' + runKey, bN = 'mnm_' + runKey;
    await reg(aN, 'pw', '纪要管理员'); await reg(bN, 'pw', '纪要成员');
    const wA = await createWSClient(); await loginTo(wA, spN.id, aN, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spN.id, bN, 'pw');
    const base = Date.now();
    // 管理员创建会议室，成员预约
    await sendMsg(wA, { type: 'roomCreate', name: '纪要会议室', capacity: 6 });
    const rooms0 = await waitFor(wA, 'rooms', (r) => r.rooms && r.rooms.length === 1, 3000);
    const roomId = rooms0.rooms[0].id;
    await sendMsg(wB, { type: 'roomBook', roomId, startAt: base + 10 * 60000, endAt: base + 40 * 60000, title: '周会' });
    const rooms1 = await waitFor(wB, 'rooms', (r) => r.reservations && r.reservations.some((x) => x.title === '周会'), 3000);
    const resId = rooms1.reservations.find((x) => x.title === '周会').id;
    // 成员提交会议纪要
    await sendMsg(wB, { type: 'meetingNoteCreate', reservationId: resId, title: '周会议纪要', content: '同步需求' });
    const notes0 = await waitFor(wB, 'meetingNotes', (r) => r.notes && r.notes.some((x) => x.reservationId === resId), 3000);
    const noteId = notes0.notes[0].id;
    assert(notes0 && notes0.notes[0].reservationTitle === '周会', '会议纪要关联会议标题');
    assert(notes0 && notes0.notes[0].roomName === '纪要会议室', '会议纪要关联会议室');
    assert(notes0 && notes0.stats.total === 1, '会议纪要统计 total=1');
    // 重复创建转为更新
    await sendMsg(wB, { type: 'meetingNoteCreate', reservationId: resId, title: '周会议纪要', content: '更新后的内容' });
    const noteUpd = await waitFor(wB, 'meetingNoteUpdated', (m) => m.noteId === noteId, 3000);
    assert(noteUpd, '重复提交纪要转为更新');
    const notesUpd = await waitFor(wB, 'meetingNotes', (r) => r.notes && r.notes.some((x) => x.id === noteId && x.content === '更新后的内容'), 3000);
    assert(notesUpd, '纪要内容已更新');
    // 成员编辑自己的纪要
    await sendMsg(wB, { type: 'meetingNoteEdit', noteId, title: '周会议纪要', content: '最终纪要' });
    const noteEdited = await waitFor(wB, 'meetingNoteUpdated', (m) => m.noteId === noteId, 3000);
    assert(noteEdited, '成员编辑自己的纪要成功');
    // 成员删除自己的纪要
    await sendMsg(wB, { type: 'meetingNoteRemove', noteId });
    const notesAfterDel = await waitFor(wB, 'meetingNotes', (r) => r.notes && r.notes.length === 0, 3000);
    assert(notesAfterDel, '成员删除自己的纪要成功');
    // 管理员创建纪要
    await sendMsg(wA, { type: 'meetingNoteCreate', reservationId: resId, title: '管理会议纪要', content: '管理内容' });
    const notesAdmin = await waitFor(wA, 'meetingNotes', (r) => r.notes && r.notes.some((x) => x.title === '管理会议纪要'), 3000);
    assert(notesAdmin, '管理员创建纪要成功');
    const adminNoteId = notesAdmin.notes.find((x) => x.title === '管理会议纪要').id;
    // 成员不能编辑管理员的纪要
    await sendMsg(wB, { type: 'meetingNoteEdit', noteId: adminNoteId, title: 'x', content: 'y' });
    const errEdit = mk(wB, 'error').pop();
    assert(errEdit && errEdit.message.includes('只能编辑自己'), '成员编辑他人纪要被拒');
    wA.close(); wB.close();
  }

  // ========== 测试44: 值班排班 ==========
  console.log('\n📋 测试44: 值班排班（安排/完成/调换/取消）');
  {
    const spD = (await httpJson('POST', '/api/spaces', { name: '值班排班办公室', squat_count: 1, urinal_count: 1 })).json;
    const aD = 'duty_' + runKey, bD = 'dutm_' + runKey, cD = 'dutc_' + runKey;
    await reg(aD, 'pw', '值班管理员'); await reg(bD, 'pw', '值班甲'); await reg(cD, 'pw', '值班乙');
    const wD1 = await createWSClient(); await loginTo(wD1, spD.id, aD, 'pw');
    const wD2 = await createWSClient(); await loginTo(wD2, spD.id, bD, 'pw');
    const wD3 = await createWSClient(); await loginTo(wD3, spD.id, cD, 'pw');
    const dd = new Date();
    const today = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;
    // 管理员安排值班
    await sendMsg(wD1, { type: 'dutyAssign', date: today, account: bD, category: '环境', note: '倒垃圾' });
    let duties = last(wD1, 'duties');
    assert(duties && duties.records.length === 1 && duties.records[0].account === bD, 'admin 安排值班成功');
    const dutyId = duties.records[0].id;
    assert(mk(wD2, 'dutyAssigned').length >= 1, '值班人收到 dutyAssigned 单发通知');
    // 重复安排同人当天值班被拒
    await sendMsg(wD1, { type: 'dutyAssign', date: today, account: bD, category: '接待' });
    assert(mk(wD1, 'error').some(e => e.message.includes('已有值班')), '同人当天重复安排被拒');
    // 成员不能安排值班
    await sendMsg(wD2, { type: 'dutyAssign', date: today, account: cD, category: '值班' });
    assert(mk(wD2, 'error').some(e => e.message.includes('仅管理员')), '非管理员安排值班被拒');
    // 成员不能完成他人值班
    await sendMsg(wD3, { type: 'dutyComplete', dutyId });
    assert(mk(wD3, 'error').some(e => e.message.includes('只能完成自己的')), '非值班人完成他人值班被拒');
    // 调换给第三人
    await sendMsg(wD2, { type: 'dutySwap', dutyId, account: cD });
    duties = last(wD2, 'duties');
    assert(duties.records[0].account === cD, '值班调换后归属第三人');
    assert(mk(wD3, 'dutySwapped').length >= 1, '被调换人收到 dutySwapped 单发通知');
    // 第三人完成值班
    await sendMsg(wD3, { type: 'dutyComplete', dutyId });
    duties = last(wD3, 'duties');
    assert(duties.records[0].status === 'completed', '值班完成后状态为 completed');
    const stD = last(wD3, 'stats');
    assert(stD && stD.stats.dutyCount === 1 && stD.stats.helperCount === 1, '完成值班累计 dutyCount 与 helperCount');
    assert(duties.stats && duties.stats.todayCount === 1, 'duties 广播携带今日值班统计');
    wD1.close(); wD2.close(); wD3.close();
  }

  // ========== 测试45: 会议室门禁码 ==========
  console.log('\n📋 测试45: 会议室门禁码（开始自动生成 / 可见范围 / 结束后失效）');
  {
    const spDc = (await httpJson('POST', '/api/spaces', { name: '门禁码办公室', squat_count: 1, urinal_count: 1 })).json;
    const aDc = 'door_' + runKey, bDc = 'doorm_' + runKey, cDc = 'doorg_' + runKey;
    await reg(aDc, 'pw', '门禁管理员'); await reg(bDc, 'pw', '会议主'); await reg(cDc, 'pw', '无关成员');
    const wA = await createWSClient(); await loginTo(wA, spDc.id, aDc, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spDc.id, bDc, 'pw');
    const wC = await createWSClient(); await loginTo(wC, spDc.id, cDc, 'pw');
    await sendMsg(wA, { type: 'roomCreate', name: '门禁会议室', capacity: 6 });
    const rid = last(wA, 'rooms').rooms[0].id;
    const tStart = Date.now() + 5 * 1000;
    await sendMsg(wB, { type: 'roomBook', roomId: rid, startAt: tStart, endAt: tStart + 30 * 60000, title: '门禁会' });
    await new Promise((r) => setTimeout(r, 6000));
    await sendMsg(wB, { type: 'roomStart', reservationId: last(wB, 'rooms').reservations[0].id });
    const codeMsg = await waitFor(wB, 'roomDoorCode', (m) => m.doorCode && String(m.doorCode).length === 6, 3000);
    assert(codeMsg && /^\d{6}$/.test(String(codeMsg.doorCode)), '会议开始后预约人收到 6 位门禁码');
    const denied = await sendMsg(wC, { type: 'roomDoorCodeRequest', reservationId: last(wB, 'rooms').reservations[0].id });
    assert(mk(wC, 'error').some(e => e.message.includes('只有预约人、管理员或参会人')), '非相关人员获取门禁码被拒');
    await sendMsg(wB, { type: 'roomEnd', reservationId: last(wB, 'rooms').reservations[0].id });
    await sendMsg(wB, { type: 'roomDoorCodeRequest', reservationId: last(wB, 'rooms').reservations[0].id });
    assert(mk(wB, 'error').some(e => e.message.includes('会议进行中')), '会议结束后门禁码请求被拒');
    wA.close(); wB.close(); wC.close();
  }

  // ========== 测试46: 报修/申领批量处理 ==========
  console.log('\n📋 测试46: 报修/申领批量处理');
  {
    const spB = (await httpJson('POST', '/api/spaces', { name: '批量处理办公室', squat_count: 1, urinal_count: 1 })).json;
    const aB = 'batch_' + runKey, bB = 'batm_' + runKey;
    await reg(aB, 'pw', '批量管理员'); await reg(bB, 'pw', '批量成员');
    const wA = await createWSClient(); await loginTo(wA, spB.id, aB, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spB.id, bB, 'pw');
    // 物资申领批量满足
    await sendMsg(wB, { type: 'materialRequest', name: '电池A', qty: 2, unit: '节', reason: '批量1' });
    await sendMsg(wB, { type: 'materialRequest', name: '电池B', qty: 3, unit: '节', reason: '批量2' });
    const mats = await waitFor(wA, 'materials', (r) => r.requests && r.requests.filter(x => x.status === 'pending').length >= 2, 3000);
    assert(mats, '两个物资申领待处理');
    const matIds = mats.requests.filter(x => x.status === 'pending').map(x => x.id);
    await sendMsg(wA, { type: 'materialBatchFulfill', ids: matIds });
    const matBatch = await waitFor(wA, 'materialBatchFulfilled', (m) => m.count === 2, 3000);
    assert(matBatch && matBatch.count === 2, '批量满足申领返回 2 条');
    const matFulfilled = await waitFor(wA, 'materials', (r) => r.requests && r.requests.every(x => x.status !== 'pending'), 3000);
    assert(matFulfilled, '批量满足后申领列表不再有待处理');
    // 报修批量解决
    await sendMsg(wB, { type: 'repairCreate', category: '灯光', location: '批量灯A', description: '批量修1' });
    await sendMsg(wB, { type: 'repairCreate', category: '空调', location: '批量空调A', description: '批量修2' });
    const reps = await waitFor(wA, 'repairs', (r) => r.repairs && r.repairs.filter(x => x.status === 'reported').length >= 2, 3000);
    assert(reps, '两个报修待处理');
    const repIds = reps.repairs.filter(x => x.status === 'reported').map(x => x.id);
    await sendMsg(wA, { type: 'repairBatchResolve', ids: repIds });
    const repBatch = await waitFor(wA, 'repairBatchResolved', (m) => m.count === 2, 3000);
    assert(repBatch && repBatch.count === 2, '批量解决报修返回 2 条');
    const repResolved = await waitFor(wA, 'repairs', (r) => r.repairs && r.repairs.every(x => x.status !== 'reported'), 3000);
    assert(repResolved, '批量解决后报修列表不再有未处理');
    wA.close(); wB.close();
  }

  // ========== 测试47: 会议室延长 ==========
  console.log('\n📋 测试47: 会议室延长（进行中可延长 / 冲突拒绝）');
  {
    const spX = (await httpJson('POST', '/api/spaces', { name: '会议延长办公室', squat_count: 1, urinal_count: 1 })).json;
    const aX = 'rmx_' + runKey, bX = 'rmxm_' + runKey;
    await reg(aX, 'pw', '会议延长管理员'); await reg(bX, 'pw', '会议延长成员');
    const wA = await createWSClient(); await loginTo(wA, spX.id, aX, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spX.id, bX, 'pw');
    await sendMsg(wA, { type: 'roomCreate', name: '延长会议室', capacity: 6 });
    const ridX = last(wA, 'rooms').rooms[0].id;
    const tStart = Date.now() + 3 * 1000;
    await sendMsg(wB, { type: 'roomBook', roomId: ridX, startAt: tStart, endAt: tStart + 30 * 60000, title: '延长会' });
    let rX = last(wB, 'rooms').reservations[0];
    assert(rX && rX.status === 'pending', '成员预约待延长会议成功');
    await new Promise((r) => setTimeout(r, 6000));
    await sendMsg(wB, { type: 'roomStart', reservationId: rX.id });
    rX = (last(wB, 'rooms').reservations || []).find((r) => r.id === rX.id);
    assert(rX && rX.status === 'active', '会议开始后状态为 active');
    await sendMsg(wB, { type: 'roomExtend', reservationId: rX.id, minutes: 15 });
    const extMsg = await waitFor(wB, 'roomExtended', (m) => m.reservationId === rX.id, 3000);
    assert(extMsg && extMsg.endAt > rX.endAt, '会议延长成功并更新结束时间');
    rX = (last(wB, 'rooms').reservations || []).find((r) => r.id === rX.id);
    assert(rX && rX.endAt === extMsg.endAt, '延长后的预约广播同步');
    wA.close(); wB.close();
  }

  // ========== 测试48: 工位延长 ==========
  console.log('\n📋 测试48: 工位延长（进行中可延长）');
  {
    const spY = (await httpJson('POST', '/api/spaces', { name: '工位延长办公室', squat_count: 1, urinal_count: 1 })).json;
    const aY = 'dskx_' + runKey, bY = 'dskxm_' + runKey;
    await reg(aY, 'pw', '工位延长管理员'); await reg(bY, 'pw', '工位延长成员');
    const wA = await createWSClient(); await loginTo(wA, spY.id, aY, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spY.id, bY, 'pw');
    await sendMsg(wA, { type: 'deskCreate', name: '延长工位' });
    const didY = last(wA, 'desks').desks[0].id;
    const tStartY = Date.now() + 3 * 1000;
    await sendMsg(wB, { type: 'deskReserve', deskId: didY, startAt: tStartY, endAt: tStartY + 30 * 60000, name: '延长工位预约' });
    let rsY = last(wB, 'desks').reservations[0];
    assert(rsY && rsY.status === 'pending', '成员预约待延长工位成功');
    await new Promise((r) => setTimeout(r, 6000));
    await sendMsg(wB, { type: 'deskStart', reservationId: rsY.id });
    rsY = (last(wB, 'desks').reservations || []).find((r) => r.id === rsY.id);
    assert(rsY && rsY.status === 'active', '工位签到后状态为 active');
    await sendMsg(wB, { type: 'deskExtend', reservationId: rsY.id, minutes: 20 });
    const extMsgY = await waitFor(wB, 'deskExtended', (m) => m.reservationId === rsY.id, 3000);
    assert(extMsgY && extMsgY.endAt > rsY.endAt, '工位延长成功并更新结束时间');
    rsY = (last(wB, 'desks').reservations || []).find((r) => r.id === rsY.id);
    assert(rsY && rsY.endAt === extMsgY.endAt, '延长后的工位广播同步');
    wA.close(); wB.close();
  }

  // ========== 测试49: 空间邀请码 ==========
  console.log('\n📋 测试49: 空间邀请码（开启加入 / 有效码登录 / 无效码拒绝）');
  {
    const spInv = (await httpJson('POST', '/api/spaces', { name: '邀请码办公室', squat_count: 1, urinal_count: 1 })).json;
    const aInv = 'inva_' + runKey, bInv = 'invm_' + runKey;
    await reg(aInv, 'pw', '邀请管理员'); await reg(bInv, 'pw', '邀请成员');
    const wA = await createWSClient(); await loginTo(wA, spInv.id, aInv, 'pw');
    await sendMsg(wA, { type: 'spaceInviteRequire', requireInvite: true });
    const reqOk = await waitFor(wA, 'spaceInviteRequire', (m) => m.requireInvite === true, 3000);
    assert(reqOk, '管理员开启邀请码加入成功');
    await sendMsg(wA, { type: 'spaceInviteCreate', maxUses: 1 });
    const invites = await waitFor(wA, 'invites', (r) => r.invites && r.invites.length === 1, 3000);
    assert(invites && invites.invites[0].code && invites.invites[0].status === 'active', '管理员生成可用邀请码');
    const code = invites.invites[0].code;
    const wB = await createWSClient();
    await sendMsg(wB, { type: 'join', spaceId: spInv.id, inviteCode: code });
    const joined = await waitFor(wB, 'joined', (m) => m.space && m.space.id === spInv.id, 3000);
    assert(joined, '成员凭有效邀请码进入空间成功');
    await sendMsg(wB, { type: 'login', account: bInv, password: 'pw' });
    const loginOk = await waitFor(wB, 'loginSuccess', (m) => m.account === bInv, 3000);
    assert(loginOk, '邀请成员登录成功');
    const wC = await createWSClient();
    await sendMsg(wC, { type: 'join', spaceId: spInv.id, inviteCode: 'ZZZZZZ' });
    const errInvite = mk(wC, 'error').pop();
    assert(errInvite && errInvite.message.includes('邀请码不存在'), '无效邀请码进入被拒');
    wA.close(); wB.close(); wC.close();
  }

  // ========== 测试50: 公告编辑与置顶 ==========
  console.log('\n📋 测试50: 公告编辑与置顶');
  {
    const spN = (await httpJson('POST', '/api/spaces', { name: '公告办公室', squat_count: 1, urinal_count: 1 })).json;
    const aN = 'ntc_' + runKey;
    await reg(aN, 'pw', '公告管理员');
    const wA = await createWSClient(); await loginTo(wA, spN.id, aN, 'pw');
    await sendMsg(wA, { type: 'announce', text: '旧公告内容' });
    const notices0 = await waitFor(wA, 'notices', (r) => r.notices && r.notices.some((n) => n.text === '旧公告内容'), 3000);
    assert(notices0, '管理员发布公告成功');
    const noticeId = notices0.notices.find((n) => n.text === '旧公告内容').id;
    await sendMsg(wA, { type: 'announceEdit', noticeId, text: '新公告内容' });
    const edited = await waitFor(wA, 'noticeUpdated', (m) => m.noticeId === noticeId && m.text === '新公告内容', 3000);
    assert(edited, '管理员编辑公告成功');
    await sendMsg(wA, { type: 'announcePin', noticeId, pinned: true });
    const pinned = await waitFor(wA, 'notices', (r) => r.notices && r.notices.some((n) => n.id === noticeId && n.pinned === true), 3000);
    assert(pinned, '管理员置顶公告成功');
    wA.close();
  }

  // ========== 测试51: 管理日志 ==========
  console.log('\n📋 测试51: 管理日志');
  {
    const spAudit = (await httpJson('POST', '/api/spaces', { name: '审计办公室', squat_count: 1, urinal_count: 1 })).json;
    const aAudit = 'aud_' + runKey, bAudit = 'audm_' + runKey;
    await reg(aAudit, 'pw', '审计管理员'); await reg(bAudit, 'pw', '审计成员');
    const wA = await createWSClient(); await loginTo(wA, spAudit.id, aAudit, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spAudit.id, bAudit, 'pw');
    await sendMsg(wA, { type: 'spaceKick', account: bAudit });
    const kicked = await waitFor(wB, 'spaceKicked', (m) => m.account === bAudit, 3000);
    assert(kicked, '成员被踢下线');
    const logs = await waitFor(wA, 'auditLogs', (r) => r.logs && r.logs.some((l) => l.action === '移除成员'), 3000);
    await sendMsg(wA, { type: 'spaceAuditList' });
    const logs2 = await waitFor(wA, 'auditLogs', (r) => r.logs && r.logs.some((l) => l.action === '移除成员'), 3000);
    assert(logs2, '审计日志记录移除成员操作');
    wA.close(); wB.close();
  }

  // ========== 测试52: 钥匙门禁借用 ==========
  console.log('\n📋 测试52: 钥匙门禁借用（高安全审批/低安全直借/归还丢失）');
  {
    const spKey = (await httpJson('POST', '/api/spaces', { name: '钥匙办公室', squat_count: 1, urinal_count: 1 })).json;
    const aKey = 'keya_' + runKey, bKey = 'keyb_' + runKey;
    await reg(aKey, 'pw', '钥匙管理员'); await reg(bKey, 'pw', '钥匙成员');
    const wK1 = await createWSClient(); await loginTo(wK1, spKey.id, aKey, 'pw');
    const wK2 = await createWSClient(); await loginTo(wK2, spKey.id, bKey, 'pw');
    await sendMsg(wK1, { type: 'keyCreate', name: '机房钥匙', category: '钥匙', security: 'high', total: 1 });
    let keys0 = last(wK1, 'keys');
    assert(keys0 && keys0.keys.length === 1 && keys0.keys[0].security === 'high', 'admin 创建高安全钥匙');
    const keyId = keys0.keys[0].id;
    await sendMsg(wK2, { type: 'keyRequest', keyId, qty: 1 });
    let keysK = last(wK2, 'keys');
    const kr0 = keysK.requests.find(r => r.keyId === keyId);
    assert(kr0 && kr0.status === 'pending', '高安全钥匙申请进入待审批');
    await sendMsg(wK1, { type: 'keyApprove', id: kr0.id });
    keysK = last(wK1, 'keys');
    assert(keysK.requests.find(r => r.id === kr0.id).status === 'borrowed', '批准后变为在借');
    await sendMsg(wK2, { type: 'keyReturn', id: kr0.id, condition: 'missing' });
    keysK = last(wK2, 'keys');
    assert(keysK.requests.find(r => r.id === kr0.id).condition === 'missing', '归还登记丢失');
    assert(keysK.keys[0].total === 0, '丢失后库存总数扣减');
    // 低安全级直接借用
    await sendMsg(wK1, { type: 'keyCreate', name: '门禁卡', category: '门禁卡', security: 'low', total: 2 });
    const lowKey = last(wK1, 'keys').keys.find(k => k.name === '门禁卡');
    await sendMsg(wK2, { type: 'keyRequest', keyId: lowKey.id, qty: 1 });
    const lowKeyReq = last(wK2, 'keys').requests.find(r => r.keyId === lowKey.id);
    assert(lowKeyReq && lowKeyReq.status === 'borrowed', '低安全级直接借用无需审批');
    await sendMsg(wK2, { type: 'keyReturn', id: lowKeyReq.id, condition: 'intact' });
    keysK = last(wK2, 'keys');
    assert(keysK.keys.find(k => k.id === lowKey.id).available === 2, '完好归还后可用恢复');
    wK1.close(); wK2.close();
  }

  // ========== 测试53: 冰箱食品管理 ==========
  console.log('\n📋 测试53: 冰箱食品管理（登记/取用/告急/补货）');
  {
    const spFridge = (await httpJson('POST', '/api/spaces', { name: '冰箱办公室', squat_count: 1, urinal_count: 1 })).json;
    const aFridge = 'frdga_' + runKey, bFridge = 'frdgb_' + runKey;
    await reg(aFridge, 'pw', '冰箱管理员'); await reg(bFridge, 'pw', '冰箱成员');
    const wF1 = await createWSClient(); await loginTo(wF1, spFridge.id, aFridge, 'pw');
    const wF2 = await createWSClient(); await loginTo(wF2, spFridge.id, bFridge, 'pw');
    await sendMsg(wF1, { type: 'fridgeItemCreate', name: '矿泉水', category: '饮料', total: 6, unit: '瓶', minAvailable: 2 });
    let fridge0 = last(wF1, 'fridge');
    assert(fridge0 && fridge0.items.length === 1 && fridge0.items[0].available === 6, 'admin 登记冰箱物品');
    const fdId = fridge0.items[0].id;
    await sendMsg(wF2, { type: 'fridgeTake', id: fdId, qty: 4 });
    fridge0 = last(wF2, 'fridge');
    assert(fridge0.items[0].available === 2 && fridge0.items[0].lowStock === true, '取用后跌破阈值标记告急');
    await sendMsg(wF2, { type: 'fridgeTake', id: fdId, qty: 3 });
    const errFd = mk(wF2, 'error').pop();
    assert(errFd && errFd.message.includes('不足'), '超量取用被拒');
    await sendMsg(wF1, { type: 'fridgeRestock', id: fdId, qty: 6 });
    fridge0 = last(wF1, 'fridge');
    assert(fridge0.items[0].total === 12 && fridge0.items[0].available === 8 && fridge0.items[0].lowStock === false, '补货后恢复并解除告急');
    wF1.close(); wF2.close();
  }

  // ========== 测试54: 车辆停车位管理 ==========
  console.log('\n📋 测试54: 车辆停车位（新增/预约/签到/签出/冲突）');
  {
    const spPk = (await httpJson('POST', '/api/spaces', { name: '停车办公室', squat_count: 1, urinal_count: 1 })).json;
    const aPk = 'pka_' + runKey, bPk = 'pkb_' + runKey;
    await reg(aPk, 'pw', '停车管理员'); await reg(bPk, 'pw', '停车成员');
    const wP1 = await createWSClient(); await loginTo(wP1, spPk.id, aPk, 'pw');
    const wP2 = await createWSClient(); await loginTo(wP2, spPk.id, bPk, 'pw');
    await sendMsg(wP1, { type: 'spotCreate', name: 'B2 充电位', spotType: 'ev', total: 2 });
    let pk0 = last(wP1, 'parking');
    assert(pk0 && pk0.spots.length === 1 && pk0.spots[0].type === 'ev', 'admin 新增车位');
    const spotId = pk0.spots[0].id;
    const nowMs = Date.now();
    await sendMsg(wP2, { type: 'spotReserve', spotId, date: '2026-10-16', startAt: nowMs + 86400000, endAt: nowMs + 86400000 + 3600000, plateNumber: '京A12345' });
    pk0 = last(wP2, 'parking');
    const parkingRes0 = pk0.reservations[0];
    assert(parkingRes0 && parkingRes0.status === 'reserved', 'member 预约车位成功');
    assert(pk0.spots[0].available === 1, '预约后可用减 1');
    await sendMsg(wP2, { type: 'spotCheckin', id: parkingRes0.id });
    pk0 = last(wP2, 'parking');
    assert(pk0.reservations[0].status === 'checked_in', '签到后状态为已停放');
    await sendMsg(wP2, { type: 'spotCheckout', id: parkingRes0.id });
    pk0 = last(wP2, 'parking');
    assert(pk0.reservations[0].status === 'checked_out', '签出后状态为已驶离');
    assert(pk0.spots[0].available === 2, '签出后可用恢复');
    // 冲突预约被拒
    await sendMsg(wP2, { type: 'spotReserve', spotId, date: '2026-10-16', startAt: nowMs + 86400000, endAt: nowMs + 86400000 + 3600000 });
    await sendMsg(wP2, { type: 'spotReserve', spotId, date: '2026-10-16', startAt: nowMs + 86400000 + 60000, endAt: nowMs + 86400000 + 3600000 + 60000 });
    const errPk = mk(wP2, 'error').pop();
    assert(errPk && errPk.message.includes('占用'), '冲突时段预约被拒');
    wP1.close(); wP2.close();
  }

  // ========== 测试55: 包裹 / 快递管理 ==========
  console.log('\n📋 测试55: 包裹 / 快递管理（登记/领取/退回/取消）');
  {
    const spPa = (await httpJson('POST', '/api/spaces', { name: '包裹办公室', squat_count: 1, urinal_count: 1 })).json;
    const aPa = 'paa_' + runKey, bPa = 'pab_' + runKey;
    await reg(aPa, 'pw', '包裹管理员'); await reg(bPa, 'pw', '包裹成员');
    const wQ1 = await createWSClient(); await loginTo(wQ1, spPa.id, aPa, 'pw');
    const wQ2 = await createWSClient(); await loginTo(wQ2, spPa.id, bPa, 'pw');
    await sendMsg(wQ1, { type: 'parcelCreate', recipientAccount: bPa, courier: '顺丰', trackingNumber: 'SF' + runKey, expectedAt: Date.now() + 86400000 });
    let pc0 = last(wQ2, 'parcels');
    assert(pc0 && pc0.parcels.length === 1 && pc0.parcels[0].status === 'incoming', 'admin 登记包裹为待取');
    const parcelId = pc0.parcels[0].id;
    await sendMsg(wQ2, { type: 'parcelPick', id: parcelId });
    pc0 = last(wQ2, 'parcels');
    const pSelf0 = pc0.parcels.find(p => p.id === parcelId);
    assert(pSelf0 && pSelf0.status === 'picked', '成员领取自己的包裹');
    // 非管理员不能领取他人包裹
    await sendMsg(wQ1, { type: 'parcelCreate', recipientAccount: aPa, courier: '韵达' });
    pc0 = last(wQ1, 'parcels');
    const pidOwn = pc0.parcels.find(p => p.status === 'incoming' && p.recipientAccount === aPa).id;
    await sendMsg(wQ2, { type: 'parcelPick', id: pidOwn });
    const errPa = mk(wQ2, 'error').pop();
    assert(errPa && errPa.message.includes('只能领取自己的'), '成员不能领取他人包裹');
    // 管理员退回与取消
    await sendMsg(wQ1, { type: 'parcelCreate', recipientAccount: bPa, courier: '圆通' });
    pc0 = last(wQ1, 'parcels');
    const pid2 = pc0.parcels.find(p => p.status === 'incoming').id;
    await sendMsg(wQ1, { type: 'parcelReturn', id: pid2 });
    pc0 = last(wQ1, 'parcels');
    assert(pc0.parcels.find(p => p.id === pid2).status === 'returned', '管理员标记退回');
    await sendMsg(wQ1, { type: 'parcelCreate', recipientAccount: bPa, courier: '中通' });
    pc0 = last(wQ1, 'parcels');
    const pid3 = pc0.parcels.find(p => p.status === 'incoming').id;
    await sendMsg(wQ1, { type: 'parcelCancel', id: pid3 });
    pc0 = last(wQ1, 'parcels');
    assert(pc0.parcels.find(p => p.id === pid3).status === 'cancelled', '管理员取消包裹');
    assert(pc0.stats.picked >= 1 && pc0.stats.cancelled >= 1, 'parcelStats 统计已取/取消');
    wQ1.close(); wQ2.close();
  }

  // ========== 测试56: 储物柜 / 寄存管理 ==========
  console.log('\n📋 测试56: 储物柜 / 寄存（新增/预约/签到/签退/删除）');
  {
    const spLk = (await httpJson('POST', '/api/spaces', { name: '寄存办公室', squat_count: 1, urinal_count: 1 })).json;
    const aLk = 'lka_' + runKey, bLk = 'lkb_' + runKey;
    await reg(aLk, 'pw', '寄存管理员'); await reg(bLk, 'pw', '寄存成员');
    const wL1 = await createWSClient(); await loginTo(wL1, spLk.id, aLk, 'pw');
    const wL2 = await createWSClient(); await loginTo(wL2, spLk.id, bLk, 'pw');
    await sendMsg(wL1, { type: 'lockerCreate', name: '3F 寄存柜', lockerType: 'valuable', total: 2 });
    let lk0 = last(wL2, 'lockers');
    assert(lk0 && lk0.lockers.length === 1 && lk0.lockers[0].available === 2, 'admin 新增储物柜');
    const lockerId = lk0.lockers[0].id;
    await sendMsg(wL2, { type: 'lockerReserve', lockerId });
    lk0 = last(wL2, 'lockers');
    assert(lk0.reservations[0] && lk0.reservations[0].status === 'reserved', '成员预约储物柜');
    assert(lk0.lockers[0].available === 1, '预约后可用减 1');
    const lkResId = lk0.reservations[0].id;
    await sendMsg(wL2, { type: 'lockerCheckin', id: lkResId });
    lk0 = last(wL2, 'lockers');
    assert(lk0.reservations.find(r => r.id === lkResId).status === 'checked_in', '签到后已使用');
    await sendMsg(wL2, { type: 'lockerCheckout', id: lkResId });
    lk0 = last(wL2, 'lockers');
    assert(lk0.reservations.find(r => r.id === lkResId).status === 'checked_out', '签退后已归还');
    assert(lk0.lockers[0].available === 2, '签退后可用恢复');
    await sendMsg(wL1, { type: 'lockerDelete', id: lockerId });
    lk0 = last(wL1, 'lockers');
    assert(lk0.lockers.length === 0, '管理员删除储物柜');
    wL1.close(); wL2.close();
  }

  // ========== 测试57: 用车 / 公务车辆 ==========
  console.log('\n📋 测试57: 用车申请 / 公务车辆（新增/预约/冲突/出车/还车）');
  {
    const spVh = (await httpJson('POST', '/api/spaces', { name: '用车办公室', squat_count: 1, urinal_count: 1 })).json;
    const aVh = 'vha_' + runKey, bVh = 'vhb_' + runKey;
    await reg(aVh, 'pw', '用车管理员'); await reg(bVh, 'pw', '用车成员');
    const wV1 = await createWSClient(); await loginTo(wV1, spVh.id, aVh, 'pw');
    const wV2 = await createWSClient(); await loginTo(wV2, spVh.id, bVh, 'pw');
    const vhNow = Date.now();
    await sendMsg(wV1, { type: 'vehicleCreate', name: '商务轿车', plateNumber: '京A·88888', vehicleType: 'van', seats: 5 });
    let vh0 = last(wV2, 'vehicles');
    assert(vh0 && vh0.vehicles.length === 1 && vh0.vehicles[0].plateNumber === '京A·88888', 'admin 新增车辆');
    const vhId = vh0.vehicles[0].id;
    await sendMsg(wV2, { type: 'vehicleReserve', vehicleId: vhId, date: '2026-10-20', startAt: vhNow + 86400000, endAt: vhNow + 86400000 + 3600000, purpose: '接送客户', driver: '乙' });
    vh0 = last(wV2, 'vehicles');
    assert(vh0.reservations[0] && vh0.reservations[0].status === 'reserved', '成员预约车辆');
    // 同车冲突时段被拒
    await sendMsg(wV2, { type: 'vehicleReserve', vehicleId: vhId, date: '2026-10-20', startAt: vhNow + 86400000 + 60000, endAt: vhNow + 86400000 + 3600000 + 60000 });
    const errVh = mk(wV2, 'error').pop();
    assert(errVh && errVh.message.includes('已被借用'), '冲突时段预借被拒');
    // 出车需登记里程
    await sendMsg(wV2, { type: 'vehicleCheckin', id: vh0.reservations[0].id });
    const errVh2 = mk(wV2, 'error').pop();
    assert(errVh2 && errVh2.message.includes('出发里程'), '未登记里程不能出车');
    await sendMsg(wV2, { type: 'vehicleCheckin', id: vh0.reservations[0].id, mileageStart: 1000 });
    vh0 = last(wV2, 'vehicles');
    assert(vh0.reservations.find(r => r.id === vh0.reservations[0].id).status === 'checked_in', '出车后行驶中');
    // 还车登记里程
    await sendMsg(wV2, { type: 'vehicleCheckout', id: vh0.reservations[0].id, mileageEnd: 950 });
    const errVh3 = mk(wV2, 'error').pop();
    assert(errVh3 && errVh3.message.includes('不能小于'), '返回里程小于出发被拒');
    await sendMsg(wV2, { type: 'vehicleCheckout', id: vh0.reservations[0].id, mileageEnd: 1120 });
    vh0 = last(wV2, 'vehicles');
    assert(vh0.reservations.find(r => r.id === vh0.reservations[0].id).status === 'checked_out', '还车后已归还');
    // 保养车不可借
    await sendMsg(wV1, { type: 'vehicleUpdate', id: vhId, maintenance: true });
    vh0 = last(wV1, 'vehicles');
    assert(vh0.vehicles[0].maintenance === true, '标记车辆保养中');
    await sendMsg(wV2, { type: 'vehicleReserve', vehicleId: vhId, date: '2026-10-21', startAt: vhNow + 86400000, endAt: vhNow + 86400000 + 3600000 });
    const errVh4 = mk(wV2, 'error').pop();
    assert(errVh4 && errVh4.message.includes('保养中'), '保养中车辆不可借用');
    wV1.close(); wV2.close();
  }

  // ========== 测试58: 统一空间搜索 ==========
  console.log('\n📋 测试58: 统一空间搜索');
  {
    const spS = (await httpJson('POST', '/api/spaces', { name: '搜索办公室', squat_count: 1, urinal_count: 1 })).json;
    const aS = 'sf_a_' + runKey;
    await reg(aS, 'pw', '搜管理员');
    const wS1 = await createWSClient(); await loginTo(wS1, spS.id, aS, 'pw');
    await sendMsg(wS1, { type: 'roomCreate', name: '北极星会议室', capacity: 6 });
    let lastRooms = last(wS1, 'rooms');
    assert(lastRooms && lastRooms.rooms && lastRooms.rooms.some((r) => r.name === '北极星会议室'), 'admin 新增会议室供搜索');
    await sendMsg(wS1, { type: 'spaceSearch', q: '北极星' });
    let sr = last(wS1, 'searchResults');
    assert(sr && sr.hits && sr.hits.some((h) => h.type === 'rooms' && h.title.includes('北极星')), '搜索命中会议室');
    await sendMsg(wS1, { type: 'spaceSearch', q: '不存在的词xyz' });
    sr = last(wS1, 'searchResults');
    assert(sr && Array.isArray(sr.hits) && sr.hits.length === 0, '无匹配返回空');
    await sendMsg(wS1, { type: 'spaceSearch', q: '' });
    sr = last(wS1, 'searchResults');
    assert(sr && sr.hits.length === 0, '空关键词返回空');
    // 新模块纳入搜索：登记一个包裹后可按快递公司检索到
    await sendMsg(wS1, { type: 'parcelCreate', recipientAccount: aS, courier: '韵达' });
    await sendMsg(wS1, { type: 'spaceSearch', q: '韵达' });
    sr = last(wS1, 'searchResults');
    assert(sr && sr.hits.some((h) => h.type === 'parcels'), '搜索命中包裹');
    wS1.close();
  }

  // ========== 测试59: 概览运营看板（新模块指标） ==========
  console.log('\n📋 测试59: 概览运营看板（包裹/储物柜/车辆/停车指标）');
  {
    const spD = (await httpJson('POST', '/api/spaces', { name: '运营办公室', squat_count: 1, urinal_count: 1 })).json;
    const aD = 'op_a_' + runKey, bD = 'op_b_' + runKey;
    await reg(aD, 'pw', '运营管理员'); await reg(bD, 'pw', '运营成员');
    const wD1 = await createWSClient(); await loginTo(wD1, spD.id, aD, 'pw');
    const dBase = last(wD1, 'digest').digest;
    assert(dBase && typeof dBase.incomingParcelsCount === 'number', '登录收到包含新模块指标的 digest');
    const opNow = Date.now();
    // 包裹
    await sendMsg(wD1, { type: 'parcelCreate', recipientAccount: aD, courier: '顺丰' });
    // 储物柜：新增 + 预借 + 签到
    await sendMsg(wD1, { type: 'lockerCreate', name: '运营柜', lockerType: 'regular', total: 2 });
    const lk0 = last(wD1, 'lockers');
    await sendMsg(wD1, { type: 'lockerReserve', lockerId: lk0.lockers[0].id });
    const lkr = last(wD1, 'lockers').reservations[0];
    await sendMsg(wD1, { type: 'lockerCheckin', id: lkr.id });
    // 车辆：新增 + 预借 + 出车
    await sendMsg(wD1, { type: 'vehicleCreate', name: '运营轿车', plateNumber: '京A·1', vehicleType: 'sedan' });
    const vh0 = last(wD1, 'vehicles');
    await sendMsg(wD1, { type: 'vehicleReserve', vehicleId: vh0.vehicles[0].id, date: '2026-10-20', startAt: opNow + 86400000, endAt: opNow + 2 * 86400000 });
    const vhRes = last(wD1, 'vehicles').reservations[0];
    await sendMsg(wD1, { type: 'vehicleCheckin', id: vhRes.id, mileageStart: 100 });
    // 停车：新增 + 预约 + 签到
    await sendMsg(wD1, { type: 'spotCreate', name: '运营位', spotType: 'standard', total: 1 });
    const pk0 = last(wD1, 'parking');
    await sendMsg(wD1, { type: 'spotReserve', spotId: pk0.spots[0].id, date: '2026-10-20', startAt: opNow + 86400000, endAt: opNow + 2 * 86400000 });
    const pkRes = last(wD1, 'parking').reservations[0];
    await sendMsg(wD1, { type: 'spotCheckin', id: pkRes.id });
    // 再登录一个新用户，其 digest 应反映已播种的数据
    const wD2 = await createWSClient(); await loginTo(wD2, spD.id, bD, 'pw');
    const dg2 = last(wD2, 'digest').digest;
    assert(dg2.incomingParcelsCount >= 1, 'digest 反映待取包裹');
    assert(dg2.activeLockersCount >= 1, 'digest 反映占用储物柜');
    assert(dg2.vehiclesInUseCount >= 1, 'digest 反映行驶车辆');
    assert(dg2.parkingOccupiedCount >= 1, 'digest 反映停车占用');
    wD1.close(); wD2.close();
  }

  // ========== 测试60: 失物招领 ==========
  console.log('\n📋 测试60: 失物招领（上报/解决/重开/删除）');
  {
    const spLf = (await httpJson('POST', '/api/spaces', { name: '失物办公室', squat_count: 1, urinal_count: 1 })).json;
    const aLf = 'lf_a_' + runKey, bLf = 'lf_b_' + runKey;
    await reg(aLf, 'pw', '失物管理员'); await reg(bLf, 'pw', '失物成员');
    const wL1 = await createWSClient(); await loginTo(wL1, spLf.id, aLf, 'pw');
    const wL2 = await createWSClient(); await loginTo(wL2, spLf.id, bLf, 'pw');
    await sendMsg(wL2, { type: 'lostReport', lostType: 'lost', name: '黑色钱包', category: '证件', location: '3F 食堂' });
    let lf0 = last(wL2, 'lostFound');
    assert(lf0 && lf0.items.length === 1 && lf0.items[0].type === 'lost' && lf0.items[0].status === 'open', '成员上报丢失物品');
    const lfId = lf0.items[0].id;
    // 管理员上报一条，供普通成员做越权校验
    await sendMsg(wL1, { type: 'lostReport', lostType: 'found', name: '苹果耳机', category: '电子设备' });
    const lf2 = last(wL1, 'lostFound').items.find(x => x.type === 'found').id;
    await sendMsg(wL2, { type: 'lostResolve', id: lf2 });
    const errLf = mk(wL2, 'error').pop();
    assert(errLf && errLf.message.includes('只能处理自己'), '非上报人不能处理他人记录');
    await sendMsg(wL2, { type: 'lostResolve', id: lfId });
    lf0 = last(wL2, 'lostFound');
    assert(lf0.items.find(x => x.id === lfId).status === 'resolved', '上报人可标记已解决');
    await sendMsg(wL2, { type: 'lostReopen', id: lfId });
    lf0 = last(wL2, 'lostFound');
    assert(lf0.items.find(x => x.id === lfId).status === 'open', '可重新开启');
    await sendMsg(wL1, { type: 'lostDelete', id: lfId });
    lf0 = last(wL1, 'lostFound');
    assert(!lf0.items.some(x => x.id === lfId), '管理员可删除记录');
    wL1.close(); wL2.close();
  }

  // ========== 测试61: 文印服务 ==========
  console.log('\n📋 测试61: 文印服务（打印机/提交/已打印/取走/维护）');
  {
    const spPr = (await httpJson('POST', '/api/spaces', { name: '文印办公室', squat_count: 1, urinal_count: 1 })).json;
    const aPr = 'pr_a_' + runKey, bPr = 'pr_b_' + runKey;
    await reg(aPr, 'pw', '文印管理员'); await reg(bPr, 'pw', '文印成员');
    const wP1 = await createWSClient(); await loginTo(wP1, spPr.id, aPr, 'pw');
    const wP2 = await createWSClient(); await loginTo(wP2, spPr.id, bPr, 'pw');
    await sendMsg(wP1, { type: 'printerCreate', name: '3F 激光机', location: '茶水间', color: true, duplex: true });
    let pr0 = last(wP2, 'print');
    assert(pr0 && pr0.printers.length === 1 && pr0.printers[0].status === 'ok', 'admin 新增打印机');
    const prId = pr0.printers[0].id;
    await sendMsg(wP2, { type: 'printSubmit', printerId: prId, fileName: '周报.pdf', pages: 3, copies: 2 });
    pr0 = last(wP2, 'print');
    const jobId = pr0.jobs.find(j => j.fileName === '周报.pdf').id;
    assert(pr0.jobs.some(j => j.id === jobId && j.status === 'pending'), '成员提交打印任务');
    await sendMsg(wP2, { type: 'printPick', id: jobId });
    const errPk = mk(wP2, 'error').pop();
    assert(errPk && errPk.message.includes('待打印完成'), '未打印完成不能取走');
    await sendMsg(wP1, { type: 'printDone', id: jobId });
    pr0 = last(wP1, 'print');
    assert(pr0.jobs.find(j => j.id === jobId).status === 'done', '管理员标记已打印');
    await sendMsg(wP1, { type: 'printerUpdate', id: prId, status: 'maintenance' });
    pr0 = last(wP1, 'print');
    assert(pr0.printers[0].status === 'maintenance', '标记打印机维护中');
    await sendMsg(wP1, { type: 'printSubmit', printerId: prId, fileName: 'x.pdf', pages: 1, copies: 1 });
    const errMaint = mk(wP1, 'error').pop();
    assert(errMaint && errMaint.message.includes('不可用'), '维护中打印机不可提交');
    wP1.close(); wP2.close();
  }

  // ========== 测试62: 资产巡检 ==========
  console.log('\n📋 测试62: 资产巡检（周期/巡检/迟检统计）');
  {
    const spIn = (await httpJson('POST', '/api/spaces', { name: '巡检办公室', squat_count: 1, urinal_count: 1 })).json;
    const aIn = 'in_a_' + runKey, bIn = 'in_b_' + runKey;
    await reg(aIn, 'pw', '巡检管理员'); await reg(bIn, 'pw', '巡检成员');
    const wI1 = await createWSClient(); await loginTo(wI1, spIn.id, aIn, 'pw');
    const wI2 = await createWSClient(); await loginTo(wI2, spIn.id, bIn, 'pw');
    await sendMsg(wI1, { type: 'assetCreate', name: 'A 灭火器', inspectIntervalDays: 30 });
    await sendMsg(wI1, { type: 'assetCreate', name: 'B 电箱', inspectIntervalDays: 30 });
    let ia0 = last(wI2, 'assets');
    assert(ia0 && ia0.assets.length === 2 && ia0.assets.every(a => a.inspectOverdue === true), '未巡检的纳入巡检资产判为迟检');
    assert(ia0.stats.inspectOverdue === 2, 'assetsStats 统计迟检资产');
    const aId = ia0.assets.find(a => a.name === 'A 灭火器').id;
    await sendMsg(wI2, { type: 'assetInspect', id: aId, result: 'pass' });
    ia0 = last(wI2, 'assets');
    assert(ia0.assets.find(a => a.id === aId).inspectOverdue === false, '巡检通过后不再迟检');
    assert(ia0.assets.find(a => a.id === aId).lastInspect && ia0.assets.find(a => a.id === aId).lastInspect.result === 'pass', '记录最近巡检结果');
    assert(ia0.stats.inspectOverdue === 1, '迟检数减少为 1');
    const bId = ia0.assets.find(a => a.name === 'B 电箱').id;
    await sendMsg(wI2, { type: 'assetInspect', id: bId, result: 'fail', note: '接线老化' });
    ia0 = last(wI2, 'assets');
    const bAsset = ia0.assets.find(a => a.id === bId);
    assert(bAsset.condition === 'damaged' && bAsset.status === 'maintenance', '巡检不通过自动标记损坏/维护中');
    assert(ia0.stats.inspectOverdue === 0, '全部巡检后迟检归零');
    wI1.close(); wI2.close();
  }

  // ========== 测试63: 会议室忙闲热图 ==========
  console.log('\n📋 测试63: 会议室忙闲热图');
  {
    const spH = (await httpJson('POST', '/api/spaces', { name: '热图办公室', squat_count: 1, urinal_count: 1 })).json;
    const aH = 'hm_a_' + runKey;
    await reg(aH, 'pw', '热图管理员');
    const wH = await createWSClient(); await loginTo(wH, spH.id, aH, 'pw');
    await sendMsg(wH, { type: 'roomCreate', name: '热图A', capacity: 4 });
    await sendMsg(wH, { type: 'roomCreate', name: '热图B', capacity: 6 });
    await sendMsg(wH, { type: 'getBookingHeatmap' });
    const hmMsg = last(wH, 'bookingHeatmap');
    assert(hmMsg && hmMsg.heatmap, '收到忙闲热图数据');
    assert(hmMsg.heatmap.hours && hmMsg.heatmap.hours.length === 13, '热图覆盖 8:00-20:00 13 小时');
    assert(hmMsg.heatmap.totalRooms === 2, '热图统计会议室总数');
    assert(typeof hmMsg.heatmap.busiest.hour === 'number' && hmMsg.heatmap.busiest.hour >= 8 && hmMsg.heatmap.busiest.hour <= 20, '热图含峰值时段');
    assert(hmMsg.heatmap.hours.every(x => typeof x.occupied === 'number'), '每小时占用为数值');
    await sendMsg(wH, { type: 'deskCreate', name: '共享工位' });
    await sendMsg(wH, { type: 'getBookingHeatmap' });
    const hm2 = last(wH, 'bookingHeatmap').heatmap;
    assert(hm2.deskTotal >= 1, '热图含工位数据');
    assert(hm2.deskHours && hm2.deskHours.length === 13 && typeof hm2.desksBusiest.hour === 'number', '工位热图覆盖 13 小时并含峰值');
    wH.close();
  }

  // ========== 测试64: 风险台账 ==========
  console.log('\n📋 测试64: 风险台账（迟检/待处理聚合）');
  {
    const spRk = (await httpJson('POST', '/api/spaces', { name: '风险办公室', squat_count: 1, urinal_count: 1 })).json;
    const aRk = 'rk_a_' + runKey, bRk = 'rk_b_' + runKey;
    await reg(aRk, 'pw', '风险管理员'); await reg(bRk, 'pw', '风险成员');
    const wA = await createWSClient(); await loginTo(wA, spRk.id, aRk, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spRk.id, bRk, 'pw');
    await sendMsg(wA, { type: 'assetCreate', name: '灭火器', inspectIntervalDays: 30 });
    await sendMsg(wB, { type: 'repairCreate', category: '灯光', location: '走廊', description: '灯不亮' });
    await sendMsg(wB, { type: 'materialRequest', name: '5号电池', qty: 1 });
    await sendMsg(wA, { type: 'getRisk' });
    const rb = last(wA, 'riskBoard').board;
    assert(rb && Array.isArray(rb.items) && rb.total >= 3, '风险台账返回待办聚合');
    const types = rb.items.map(i => i.type);
    assert(types.includes('inspection'), '含迟检资产');
    assert(types.includes('repairs'), '含未办结报修');
    assert(types.includes('materials'), '含待处理申领');
    assert(rb.items.every(i => i.priority === 'high' || i.priority === 'normal'), '每项带优先级');
    wA.close(); wB.close();
  }

  // ========== 测试65: 空间数据导出 ==========
  console.log('\n📋 测试65: 空间数据导出（JSON 备份，管理员限定）');
  {
    const spX = (await httpJson('POST', '/api/spaces', { name: '导出办公室', squat_count: 1, urinal_count: 1 })).json;
    const aX = 'ex_a_' + runKey, bX = 'ex_b_' + runKey;
    await reg(aX, 'pw', '导出管理员'); await reg(bX, 'pw', '导出成员');
    const wA = await createWSClient(); await loginTo(wA, spX.id, aX, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spX.id, bX, 'pw');
    await sendMsg(wA, { type: 'roomCreate', name: '导出A', capacity: 4 });
    await sendMsg(wB, { type: 'spaceExport' });
    const errX = mk(wB, 'error').pop();
    assert(errX && errX.message.includes('仅管理员'), '非管理员导出被拒');
    await sendMsg(wA, { type: 'spaceExport' });
    const exMsg = last(wA, 'spaceExport');
    assert(exMsg && exMsg.export && exMsg.export.meta && exMsg.export.meta.id === spX.id, '管理员可导出空间 JSON');
    assert(Array.isArray(exMsg.export.data.rooms) && exMsg.export.data.rooms.some(r => r.name === '导出A'), '导出含会议室数据');
    assert(typeof exMsg.export.meta.exportedAt === 'number', '导出含时间戳');
    wA.close(); wB.close();
  }

  // ========== 测试66: 备忘提醒 ==========
  console.log('\n📋 测试66: 备忘提醒（创建/停用/删除）');
  {
    const spMm = (await httpJson('POST', '/api/spaces', { name: '备忘办公室', squat_count: 1, urinal_count: 1 })).json;
    const aMm = 'mm_a_' + runKey, bMm = 'mm_b_' + runKey;
    await reg(aMm, 'pw', '备忘管理员'); await reg(bMm, 'pw', '备忘成员');
    const wA = await createWSClient(); await loginTo(wA, spMm.id, aMm, 'pw');
    const wB = await createWSClient(); await loginTo(wB, spMm.id, bMm, 'pw');
    await sendMsg(wB, { type: 'reminderCreate', text: '清冰箱', nextAt: Date.now() + 3600000, repeat: 'weekly' });
    let mm = last(wB, 'reminders');
    assert(mm && mm.reminders.length === 1 && mm.reminders[0].text === '清冰箱' && mm.reminders[0].repeat === 'weekly', '成员创建重复提醒');
    const memoId = mm.reminders[0].id;
    await sendMsg(wB, { type: 'getMyReminders' });
    const myr = last(wB, 'myReminders');
    assert(myr && myr.reminders && myr.reminders.remindersCount === 1 && myr.reminders.reminders[0].text === '清冰箱', '我的待办聚合本人备忘');
    await sendMsg(wB, { type: 'reminderToggle', id: memoId });
    mm = last(wB, 'reminders');
    assert(mm.reminders.find(r => r.id === memoId).enabled === false, '可停用提醒');
    await sendMsg(wB, { type: 'reminderCreate', text: '一次性备忘', nextAt: Date.now() + 1000 });
    mm = last(wB, 'reminders');
    assert(mm.reminders.length === 2 && mm.reminders.some(r => r.repeat === 'none'), '可再建一次性提醒');
    await sendMsg(wB, { type: 'reminderDelete', id: memoId });
    mm = last(wB, 'reminders');
    assert(mm.reminders.length === 1, '可删除提醒');
    wA.close(); wB.close();
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ 通过: ${passed}`);
  console.log(`❌ 失败: ${failed}`);
  if (errors.length > 0) { console.log(`\n失败详情:`); errors.forEach(e => console.log(`  - ${e}`)); }
  console.log(`${'='.repeat(50)}\n`);
  try { w1.close(); w2.close(); wsX.close(); wA.close(); w3.close(); w4.close(); } catch {}
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => { console.error('测试运行出错:', err); process.exit(1); });