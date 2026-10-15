'use strict';
// 单元测试：直接对 createContext 暴露的纯函数做断言，无需启动服务、不依赖数据库。
// 覆盖 ID 生成、周统计、坑位段位、成就解锁、口令哈希等核心逻辑。
const { createContext } = require('../src/context');
const roomsModule = require('../src/modules/rooms');
const extrasModule = require('../src/modules/extras');

let passed = 0;
let failed = 0;
const errors = [];
function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; errors.push(msg); console.log(`  ❌ ${msg}`); }
}
function assertEq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, `${msg}${ok ? '' : `（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`}`);
}

const api = createContext();

// ---------- ID 生成 ----------
console.log('\n🧮 单元测试：createContext 纯函数\n');
console.log('📋 1. ID 生成');
const id1 = api.genId('rm', null);
const id2 = api.genId('rm', null);
assert(String(id1).startsWith('rm'), 'genId 带前缀');
assert(String(id1) !== String(id2), 'genId 两次不同（随机）');
assertEq(new Set([id1, id2]).size, 2, 'genId 生成的 id 集合唯一');

const spaceId = api.genSpaceId();
assert(/^[abcdefghjkmnpqrstuvwxyz23456789]{4}$/.test(spaceId), 'genSpaceId 为 4 位合法字符');

// ---------- 周统计 ----------
console.log('\n📋 2. 周统计');
const weekKey = api.weekKey(new Date('2026-10-14T12:00:00+08:00').getTime());
assert(/^\d{4}-\d{2}-\d{2}$/.test(weekKey), 'weekKey 返回 YYYY-MM-DD');
const stats = api.newStats();
assertEq(stats.totalVisits, 0, 'newStats 初始 totalVisits=0');
assertEq(stats.borrowDuration, 0, 'newStats 初始 borrowDuration=0');
assertEq(stats.meetingDuration, 0, 'newStats 初始 meetingDuration=0');
assertEq(stats.helperCount, 0, 'newStats 初始 helperCount=0');
const weekUser = { stats };
api.recordWeekly(weekUser, 'visits');
api.recordWeekly(weekUser, 'borrows');
assertEq(stats.weekly.visits, 1, 'recordWeekly 累加 visits');
assertEq(stats.weekly.borrows, 1, 'recordWeekly 累加 borrows');
assertEq(api.weeklyScore(stats), 2, 'weeklyScore 计算周活跃总分');

// ---------- 坑位段位 ----------
console.log('\n📋 3. 坑位段位');
assertEq(api.stallTier({ ratings: [] }).name, '新坑', '无评分时为新坑');
const goodRatings = Array.from({ length: 12 }, () => ({ cleanliness: 5, signal: 5, paper: 5 }));
assertEq(api.stallTier({ ratings: goodRatings }).name, '王者', '满分评分为王者');

// ---------- 成就解锁 ----------
console.log('\n📋 4. 成就解锁');
const user = { stats: api.newStats(), achievements: [] };
user.stats.consecutiveOnTime = 3;
api.checkAchievements(user);
assert(user.achievements.includes('punctual'), '连续 3 次准时解锁守时达人');
assert(!user.achievements.includes('king'), '未达成蹲坑之王');

// ---------- 成就进度 ----------
console.log('\n📋 4b. 成就进度');
const p1 = api.achievementProgress(user, api.ACHIEVEMENT_DEFS.find((d) => d.id === 'punctual'));
assertEq(p1.current, 3, '守时进度当前值 3');
assertEq(p1.target, 3, '守时进度目标 3');
assertEq(p1.pct, 100, '守时进度百分比 100');
assert(p1.unlocked === true, '守时已解锁');
const p2 = api.achievementProgress(user, api.ACHIEVEMENT_DEFS.find((d) => d.id === 'king'));
assertEq(p2.current, 0, '蹲坑之王当前值 0');
assertEq(p2.target, 10, '蹲坑之王目标 10');
assertEq(p2.pct, 0, '蹲坑之王百分比 0');
assert(p2.unlocked === false, '蹲坑之王未解锁');
user.stats.totalVisits = 10;
const p3 = api.achievementProgress(user, api.ACHIEVEMENT_DEFS.find((d) => d.id === 'king'));
assert(p3.unlocked === true, '累计 10 次解锁蹲坑之王');
assertEq(p3.pct, 100, '蹲坑之王达成后进度 100');
const pub = api.achievementDefsPublic(user);
assertEq(pub.length, 11, '成就公开列表含 11 项');
assert(pub.every((a) => a.id && a.name && a.desc && a.icon), '公开成就含 id/name/desc/icon');
user.stats.borrowCount = 3;
assert(api.achievementProgress(user, api.ACHIEVEMENT_DEFS.find((d) => d.id === 'borrower')).unlocked === true, '借用 3 次解锁借阅达人');
user.stats.meetingDuration = 60;
assert(api.achievementProgress(user, api.ACHIEVEMENT_DEFS.find((d) => d.id === 'meeter')).unlocked === true, '会议时长 60 分钟解锁会议达人');
user.stats.helperCount = 5;
assert(api.achievementProgress(user, api.ACHIEVEMENT_DEFS.find((d) => d.id === 'logistician')).unlocked === true, '处理 5 次解锁后勤达人');
assert(api.achievementProgress(user, api.ACHIEVEMENT_DEFS.find((d) => d.id === 'logistician')).pct === 100, '后勤达人达成后进度 100');

// ---------- 口令哈希 ----------
console.log('\n📋 5. 口令哈希');
const hash = api.hashPassword('secret123');
assert(hash.includes(':'), 'hashPassword 输出 salt:hash');
assert(api.verifyPassword('secret123', hash), 'verifyPassword 正确校验');
assert(!api.verifyPassword('wrong', hash), 'verifyPassword 拒绝错误口令');

// ---------- 管理员判定 ----------
console.log('\n📋 6. 管理员判定');
const sp = api.createSpace('s1', '测试空间', 2, 1);
sp.admins.add('alice');
assert(api.isAdmin(sp, 'alice'), '管理员账号判定为 admin');
assert(!api.isAdmin(sp, 'bob'), '非管理员账号判定为非 admin');

// ---------- 历史预约清理 ----------
console.log('\n📋 7. 历史预约清理');
const sp2 = api.createSpace('s2', '清理空间', 1, 0);
const old = Date.now() - 8 * 86400000;
sp2.roomReservations.set('old-res', { id: 'old-res', roomId: 'rm1', ownerAccount: 'alice', startAt: old, endAt: old + 60000, status: 'completed' });
sp2.roomReservations.set('new-res', { id: 'new-res', roomId: 'rm1', ownerAccount: 'bob', startAt: Date.now() + 60000, endAt: Date.now() + 120000, status: 'pending' });
const pruned = api.pruneRoomReservations(sp2, Date.now() - 7 * 86400000);
assertEq(pruned, 1, '清理超过 7 天的历史预约返回数量');
assert(!sp2.roomReservations.has('old-res'), '旧预约已从内存移除');
assert(sp2.roomReservations.has('new-res'), '未到期的预约保留');

// ---------- 坑位段位缓存 ----------
console.log('\n📋 8. 坑位段位缓存');
const ratedStall = { ratings: [{ cleanliness: 5, signal: 5, paper: 5 }] };
const tier1 = api.stallTier(ratedStall);
const tier2 = api.stallTier(ratedStall);
assert(tier1 === tier2, '评分不变时复用缓存段位');
assert(ratedStall.__tier === tier1, '缓存字段已写入');

// ---------- 访客序列化 ----------
console.log('\n📋 9. 访客序列化');
const spV = api.createSpace('s3', '访客空间', 1, 0);
spV.visitors.set('v1', { id: 'v1', hostAccount: 'alice', hostName: '甲', visitorName: '客户王', purpose: '商务洽谈', contact: '123', expectedAt: 123, arrivedAt: null, leftAt: null, status: 'pending', createdAt: Date.now() });
const vp = api.visitorsPublic(spV, new Map());
assertEq(vp.length, 1, 'visitorsPublic 返回访客列表');
assertEq(vp[0].visitorName, '客户王', 'visitorsPublic 保留访客姓名');
assertEq(vp[0].status, 'pending', 'visitorsPublic 保留访客状态');

// ---------- 每日看点 ----------
console.log('\n📋 10. 每日看点');
const dv = api.createSpace('s4', '看点空间', 1, 0);
const du = { account: 'alice', stats: api.newStats(), achievements: [] };
dv.visitors.set('pv', { id: 'pv', hostAccount: 'bob', hostName: '乙', visitorName: '李四', purpose: '面谈', status: 'pending', createdAt: Date.now(), expectedAt: null, arrivedAt: null, leftAt: null, contact: '' });
const digest = api.buildDigest(dv, du);
assertEq(digest.pendingVisitorsCount, 1, 'digest 统计待接待访客');
assertEq(digest.pendingVisitors[0].visitorName, '李四', 'digest 含访客姓名');
assertEq(digest.todayMeetingMinutes, 0, 'digest 初始今日会议时长为 0');
assertEq(digest.todayBorrowMinutes, 0, 'digest 初始今日借用时长为 0');
dv.borrows.set('bw', { id: 'bw', toolId: 't1', borrowerAccount: 'alice', qty: 1, borrowedAt: Date.now() - 10 * 60000, returnedAt: Date.now() - 5 * 60000, status: 'returned' });
dv.roomReservations.set('rm', { id: 'rm', roomId: 'r1', ownerAccount: 'bob', startAt: Date.now() - 30 * 60000, endAt: Date.now() - 10 * 60000, status: 'completed' });
const digest2 = api.buildDigest(dv, du);
assertEq(digest2.todayBorrowMinutes, 5, 'digest 统计今日归还借用时长');
assertEq(digest2.todayMeetingMinutes, 20, 'digest 统计今日会议时长');

// ---------- 用户广播 ----------
console.log('\n📋 11. 用户广播');
const spB = api.createSpace('s5', '广播空间', 1, 0);
const sent = [];
const fakeWs = { readyState: 1, send: (d) => { sent.push(JSON.parse(d)); } };
api.users.set('bu1', { id: 'bu1', account: 'alice', nickname: '甲', avatar: '🧑', currentSpace: spB.id, ws: fakeWs, emergencyMode: true });
spB.clients.add(fakeWs);
api.broadcastUsers(spB);
const lastUser = sent.filter((m) => m.type === 'users').pop();
assert(lastUser && lastUser.users.some((u) => u.account === 'alice' && u.emergencyMode === true), '用户广播含紧急模式字段');
assert(api.getUserByAccount('alice') && api.getUserByAccount('alice').emergencyMode === true, 'getUserByAccount 按账号查找用户');
api.users.delete('bu1'); spB.clients.delete(fakeWs);

// ---------- 会议室时长累计 ----------
console.log('\n📋 12. 会议室时长累计');
const ownerUser = { id: 'ru1', account: 'alice', nickname: '甲', stats: { meetingDuration: 0 }, achievements: [] };
const fakeApi = {
  roomReservationsPublic: () => [],
  roomWaitlistPublic: () => [],
  roomPublic: (r) => r,
  broadcast: () => {},
  LIST_PAGE: 30,
  isAdmin: () => false,
  sendTo: () => {},
  serError: (m) => ({ type: 'error', message: m }),
  genId: () => 'x',
  saveEntity: () => {},
  deleteEntity: () => {},
  recordWeekly: () => {},
  getUserByAccount: (a) => (a === 'alice' ? ownerUser : null),
  sendToUser: () => {},
  saveProfile: () => {},
  broadcastLeaderboard: () => {},
  roomStatsBroadcast: () => {},
};
const rooms = roomsModule(fakeApi);
const rsvSpace = { id: 's6', roomReservations: new Map(), rooms: [] };
rsvSpace.roomReservations.set('r1', { id: 'r1', roomId: 'rm1', ownerAccount: 'alice', startAt: Date.now() - 60 * 60000, endAt: Date.now() - 10 * 60000, status: 'active' });
rooms.handleRooms({}, ownerUser, rsvSpace, { type: 'roomEnd', reservationId: 'r1' });
assertEq(ownerUser.stats.meetingDuration, 50, 'roomEnd 累计会议时长 50 分钟');

// ---------- 周期预约展开 ----------
console.log('\n📋 13. 周期预约展开');
const t0 = Date.now() + 3600000;
const span = 30 * 60000;
const daily = api.expandRecurring(t0, t0 + span, 'daily', 3);
assertEq(daily.length, 3, '每天展开 3 场');
assertEq(daily[1].startAt - daily[0].startAt, 86400000, '每天间隔 24 小时');
assertEq(daily[2].endAt - daily[2].startAt, span, '周期场次时长保持');
const weekly = api.expandRecurring(t0, t0 + span, 'weekly', 2);
assertEq(weekly.length, 2, '每周展开 2 场');
assertEq(weekly[1].startAt - weekly[0].startAt, 7 * 86400000, '每周间隔 7 天');
const once = api.expandRecurring(t0, t0 + span, null, 5);
assertEq(once.length, 1, '不重复只展开 1 场');
assertEq(api.expandRecurring(t0, t0 + span, 'weekly', 999).length, 52, '每周次数上限 52');
assertEq(api.expandRecurring(t0, t0 + span, 'daily', 0).length, 1, '次数下限为 1');

// ---------- 借用逾期判定 ----------
console.log('\n📋 14. 借用逾期判定');
assertEq(api.borrowOverdue({ status: 'borrowed', borrowedAt: 0, dueAt: 1000 }, 2000), true, '超过 dueAt 判定逾期');
assertEq(api.borrowOverdue({ status: 'borrowed', borrowedAt: 0, dueAt: 3000 }, 2000), false, '未到 dueAt 未逾期');
assertEq(api.borrowOverdue({ status: 'borrowed', borrowedAt: 0 }, 8 * 86400000), true, '默认 7 天到期后逾期');
assertEq(api.borrowOverdue({ status: 'returned', borrowedAt: 0, dueAt: 1000 }, 2000), false, '已归还不计逾期');

// ---------- 会议室占用率 ----------
console.log('\n📋 15. 会议室占用率统计');
const us = api.createSpace('s7', '占用空间', 1, 0);
us.rooms.push({ id: 'r7', name: '小间', capacity: 4 });
const now7 = new Date(); now7.setHours(12, 0, 0, 0);
const now7ms = now7.getTime();
us.roomReservations.set('u7', { id: 'u7', roomId: 'r7', ownerAccount: 'alice', startAt: now7ms, endAt: now7ms + 60 * 60000, status: 'active' });
us.roomReservations.set('u8', { id: 'u8', roomId: 'r7', ownerAccount: 'bob', startAt: now7ms + 86400000, endAt: now7ms + 86400000 + 30 * 60000, status: 'pending' });
const usage = api.roomUsageStats(us, now7ms);
assertEq(usage.rooms[0].todayCount, 1, '今日场次统计为 1');
assertEq(usage.rooms[0].todayMinutes, 60, '今日时长统计 60 分钟');
assertEq(usage.rooms[0].upcomingCount, 1, '待开始场次统计为 1');
assert(usage.utilizationPct >= 0 && usage.utilizationPct <= 100, '占用率在 0-100 区间');

console.log('\n📋 16. 报修优先级序列化');
const spR = api.createSpace('s8', '报修空间', 1, 0);
spR.repairs.set('r8', { id: 'r8', reporterAccount: 'alice', reporterName: '甲', category: '灯光', priority: 'high', location: '走廊', description: '闪烁', status: 'reported', createdAt: Date.now(), updatedAt: Date.now() });
const rp = api.repairsPublic(spR, new Map());
assertEq(rp[0].priority, 'high', 'repairsPublic 保留优先级');
assertEq(rp[0].location, '走廊', 'repairsPublic 保留位置');

// ---------- 借用记录序列化 ----------
console.log('\n📋 17. 借用记录序列化');
const spBw = api.createSpace('s9', '借用空间', 1, 0);
spBw.tools.push({ id: 't9', name: '测试手机', category: '测试手机', total: 2, available: 0, location: '机柜', description: '' });
spBw.borrows.set('bw9', { id: 'bw9', toolId: 't9', borrowerAccount: 'alice', borrowerName: '甲', qty: 2, borrowedAt: Date.now() - 3 * 86400000, dueAt: Date.now() - 2 * 86400000, returnedAt: null, status: 'borrowed', extensions: 1 });
const bwp = api.borrowsPublic(spBw, new Map());
assertEq(bwp.length, 1, 'borrowsPublic 返回借用记录');
assertEq(bwp[0].toolName, '测试手机', 'borrowsPublic 关联设备名称');
assertEq(bwp[0].status, 'borrowed', 'borrowsPublic 保留状态');
assertEq(bwp[0].overdue, true, 'borrowsPublic 标记逾期');
assertEq(bwp[0].extensions, 1, 'borrowsPublic 暴露续借次数');

// ---------- 工具在借明细序列化 ----------
console.log('\n📋 17b. 工具在借明细序列化');
const spBwT = api.createSpace('s10b', '在借明细空间', 1, 0);
spBwT.tools.push({ id: 'tT', name: '测试机', category: '测试电脑', total: 1, available: 0, location: '', description: '' });
spBwT.borrows.set('bwT', { id: 'bwT', toolId: 'tT', borrowerAccount: 'alice', borrowerName: '甲', qty: 1, borrowedAt: Date.now(), dueAt: Date.now() + 7 * 86400000, returnedAt: null, status: 'borrowed', extensions: 2 });
const tp = api.toolsPublic(spBwT, new Map());
assertEq(tp[0].activeBorrows[0].extensions, 2, 'toolsPublic 在借明细暴露续借次数');

// ---------- 工具排队序列化 ----------
console.log('\n📋 17c. 工具排队序列化');
const spWl = api.createSpace('s10c', '排队空间', 1, 0);
spWl.tools.push({ id: 'tW', name: '测试机', category: '测试电脑', total: 2, available: 0, location: '', description: '' });
spWl.toolWaitlist.set('wlW', { id: 'wlW', toolId: 'tW', account: 'alice', name: '甲', qty: 2, status: 'waiting', createdAt: Date.now() });
spWl.toolWaitlist.set('wlW2', { id: 'wlW2', toolId: 'tW', account: 'bob', name: '乙', qty: 1, status: 'promoted', createdAt: Date.now() - 1000, promotedAt: Date.now(), borrowId: 'bwW2' });
const wlPub = api.toolWaitlistPublic(spWl, new Map());
assertEq(wlPub.length, 1, 'toolWaitlistPublic 仅返回在排队记录');
assertEq(wlPub[0].toolName, '测试机', 'toolWaitlistPublic 关联设备名称');
assertEq(wlPub[0].status, 'waiting', 'toolWaitlistPublic 保留排队状态');
assertEq(wlPub[0].qty, 2, 'toolWaitlistPublic 保留数量');

// ---------- 会议室候补序列化 ----------
console.log('\n📋 18. 会议室候补序列化');
const spW = api.createSpace('s10', '候补空间', 1, 0);
spW.rooms.push({ id: 'rw1', name: '小会', capacity: 4 });
spW.roomWaitlist.set('wl1', { id: 'wl1', roomId: 'rw1', ownerAccount: 'alice', ownerName: '甲', title: '评审', startAt: Date.now() + 3600000, endAt: Date.now() + 3780000, note: '', status: 'waiting', createdAt: Date.now() });
spW.roomWaitlist.set('wl2', { id: 'wl2', roomId: 'rw1', ownerAccount: 'bob', ownerName: '乙', title: '周会', startAt: Date.now() + 3600000, endAt: Date.now() + 3780000, note: '', status: 'cancelled', createdAt: Date.now() });
const wlp = api.roomWaitlistPublic(spW, new Map());
assertEq(wlp.length, 1, 'roomWaitlistPublic 仅返回 waiting 候补');
assertEq(wlp[0].ownerName, '甲', 'roomWaitlistPublic 保留候补人');
assertEq(wlp[0].roomId, 'rw1', 'roomWaitlistPublic 保留会议室');

// ---------- 访客签到码 ----------
console.log('\n📋 19. 访客签到码');
const spC = api.createSpace('s11', '签到空间', 1, 0);
const code1 = api.genCheckinCode(spC);
const code2 = api.genCheckinCode(spC);
assert(/^[A-Z2-9]{6}$/.test(code1), '签到码为 6 位合法字符');
assert(code1 !== code2, '签到码同空间两次生成不同');
spC.visitors.set('vc1', { id: 'vc1', hostAccount: 'alice', hostName: '甲', visitorName: '客户王', purpose: '商务洽谈', contact: '', expectedAt: null, arrivedAt: null, leftAt: null, status: 'pending', createdAt: Date.now(), code: 'ABC123' });
const vcp = api.visitorsPublic(spC, new Map());
assertEq(vcp[0].code, 'ABC123', 'visitorsPublic 保留签到码');

// ---------- 访客签到码有效期 ----------
console.log('\n📋 19b. 访客签到码有效期');
const nowV = 1000000000;
assert(api.visitorCodeExpired({ expiresAt: nowV + 3600000 }, nowV) === false, '未到期时未过期');
assert(api.visitorCodeExpired({ expiresAt: nowV - 1 }, nowV) === true, '到期后已过期');
assert(api.visitorCodeExpired({ expiresAt: null }, nowV) === false, '无过期时间时不判过期');
assertEq(api.VISIT_TOKEN_TTL_MS, 24 * 3600 * 1000, '签到码有效期 24 小时');

// ---------- 借用逾期自动提醒 ----------
console.log('\n📋 20. 借用逾期自动提醒');
const spRem = api.createSpace('s12', '提醒空间', 1, 0);
const nowR = 1000000000;
spRem.borrows.set('r1', { id: 'r1', toolId: 't1', borrowerAccount: 'alice', qty: 1, borrowedAt: nowR - 10 * 86400000, dueAt: nowR - 2 * 86400000, returnedAt: null, status: 'borrowed', lastRemindedAt: null });
spRem.borrows.set('r2', { id: 'r2', toolId: 't1', borrowerAccount: 'bob', qty: 1, borrowedAt: nowR - 10 * 86400000, dueAt: nowR - 2 * 86400000, returnedAt: null, status: 'borrowed', lastRemindedAt: nowR - 1000 });
spRem.borrows.set('r3', { id: 'r3', toolId: 't1', borrowerAccount: 'carol', qty: 1, borrowedAt: nowR - 10 * 86400000, dueAt: nowR + 86400000, returnedAt: null, status: 'borrowed', lastRemindedAt: null });
spRem.borrows.set('r4', { id: 'r4', toolId: 't1', borrowerAccount: 'dave', qty: 1, borrowedAt: nowR - 10 * 86400000, dueAt: nowR - 2 * 86400000, returnedAt: nowR - 86400000, status: 'returned', lastRemindedAt: null });
const rem = api.dueBorrowReminders(spRem, nowR);
assertEq(rem.map((b) => b.id), ['r1'], '仅返回逾期且未在静默期内的借用');

// ---------- 我的待办 ----------
console.log('\n📋 21. 我的待办');
const spRem2 = api.createSpace('s13', '待办空间', 1, 0);
const nowR2 = 1000000000;
const remUser = { account: 'alice', stats: api.newStats(), achievements: [] };
spRem2.borrows.set('rb1', { id: 'rb1', toolId: 't1', borrowerAccount: 'alice', qty: 1, borrowedAt: nowR2 - 10 * 86400000, dueAt: nowR2 - 2 * 86400000, returnedAt: null, status: 'borrowed' });
spRem2.roomReservations.set('rr1', { id: 'rr1', roomId: 'rm1', ownerAccount: 'alice', startAt: nowR2 + 30 * 60000, endAt: nowR2 + 60 * 60000, status: 'pending', title: '评审' });
spRem2.visitors.set('rv1', { id: 'rv1', hostAccount: 'alice', visitorName: '客户王', status: 'pending', purpose: '', createdAt: nowR2, code: '' });
spRem2.materialRequests.set('rm1', { id: 'rm1', name: '电池', handlerAccount: 'alice', status: 'pending', requesterAccount: 'bob', requesterName: '乙', qty: 1, unit: '节', reason: '' });
spRem2.repairs.set('rrp1', { id: 'rrp1', handlerAccount: 'alice', category: '灯光', location: '走廊', status: 'reported', reporterAccount: 'bob', reporterName: '乙', priority: 'normal', description: '', createdAt: nowR2, updatedAt: nowR2 });
const myRem = api.buildMyReminders(spRem2, remUser, nowR2);
assertEq(myRem.overdueCount, 1, '我的待办统计逾期借用');
assertEq(myRem.overdue[0].toolId, 't1', '逾期借用关联设备');
assertEq(myRem.upcomingCount, 1, '我的待办统计临近会议');
assertEq(myRem.pendingVisitorCount, 1, '我的待办统计待接待访客');
assertEq(myRem.assignedMaterialCount, 1, '我的待办统计指派申领');
assertEq(myRem.assignedRepairCount, 1, '我的待办统计指派报修');
assertEq(api.buildMyReminders(spRem2, { account: 'bob' }, nowR2).overdueCount, 0, '他人不统计我的逾期');

// ---------- 空间活跃趋势 ----------
console.log('\n📋 22. 空间活跃趋势');
const spT = api.createSpace('s14', '趋势空间', 1, 0);
const nowT = Date.now();
spT.roomReservations.set('rt1', { id: 'rt1', roomId: 'rm1', ownerAccount: 'alice', startAt: nowT, endAt: nowT + 60000, status: 'completed', title: '会' });
spT.borrows.set('rbt1', { id: 'rbt1', toolId: 't1', borrowerAccount: 'alice', qty: 1, borrowedAt: nowT, returnedAt: null, status: 'borrowed' });
spT.materialRequests.set('rmat', { id: 'rmat', name: '电池', createdAt: nowT, handlerAccount: '', requesterAccount: 'bob', requesterName: '乙', status: 'pending', qty: 1, unit: '节', reason: '' });
spT.repairs.set('rrep', { id: 'rrep', category: '灯光', location: '走廊', createdAt: nowT, reporterAccount: 'bob', reporterName: '乙', priority: 'normal', description: '', status: 'reported', handlerAccount: '' });
spT.visitors.set('rvis', { id: 'rvis', hostAccount: 'bob', hostName: '乙', visitorName: '客户', createdAt: nowT, status: 'pending', purpose: '', code: '' });
const trend = api.buildSpaceTrend(spT, 7);
assertEq(trend.length, 7, '趋势返回 7 天');
const today = trend[trend.length - 1];
assertEq(today.meetings, 1, '今日会议计数');
assertEq(today.borrows, 1, '今日借用计数');
assertEq(today.requests, 1, '今日申领计数');
assertEq(today.repairs, 1, '今日报修计数');
assertEq(today.visitors, 1, '今日访客计数');
assertEq(api.buildSpaceTrend(spT, 30).length, 30, '30 天上限返回 30 天');
assertEq(api.buildSpaceTrend(spT, 999).length, 30, '超出上限截断为 30 天');

// ---------- 会议室开始前提醒 ----------
console.log('\n📋 23. 会议室开始前提醒');
const spRoom = api.createSpace('s15', '会议提醒空间', 1, 0);
const nowRoom = 1000000000;
spRoom.roomReservations.set('rr1', { id: 'rr1', roomId: 'rm1', ownerAccount: 'alice', startAt: nowRoom + 3 * 60000, endAt: nowRoom + 9 * 60000, status: 'pending', remindAt: nowRoom - 1, reminded: false, title: '评审' });
spRoom.roomReservations.set('rr2', { id: 'rr2', roomId: 'rm1', ownerAccount: 'bob', startAt: nowRoom + 20 * 60000, endAt: nowRoom + 30 * 60000, status: 'pending', remindAt: nowRoom + 100000, reminded: false, title: '周会' });
spRoom.roomReservations.set('rr3', { id: 'rr3', roomId: 'rm1', ownerAccount: 'carol', startAt: nowRoom + 3 * 60000, endAt: nowRoom + 9 * 60000, status: 'pending', remindAt: nowRoom - 1, reminded: true, title: '评审' });
spRoom.roomReservations.set('rr4', { id: 'rr4', roomId: 'rm1', ownerAccount: 'dave', startAt: nowRoom + 3 * 60000, endAt: nowRoom + 9 * 60000, status: 'cancelled', remindAt: nowRoom - 1, reminded: false, title: '评审' });
spRoom.roomReservations.set('rr5', { id: 'rr5', roomId: 'rm1', ownerAccount: 'eve', startAt: nowRoom + 3 * 60000, endAt: nowRoom + 9 * 60000, status: 'pending', remindAt: null, reminded: false, title: '评审' });
spRoom.roomReservations.set('rr6', { id: 'rr6', roomId: 'rm1', ownerAccount: 'frank', startAt: nowRoom + 3 * 60000, endAt: nowRoom + 9 * 60000, status: 'active', remindAt: nowRoom - 1, reminded: false, title: '评审' });
const roomRem = api.dueRoomReminders(spRoom, nowRoom);
assertEq(roomRem.map((r) => r.id), ['rr1'], '仅返回已到提醒时间且未提醒过的待开始预约');
assertEq(api.ROOM_REMIND_WINDOW_MS, 10 * 60000, '会议提醒窗口为开始前 10 分钟');
const resPub = api.reservationPublic(spRoom.roomReservations.get('rr1'), new Map());
assertEq(resPub.remindAt, nowRoom - 1, 'reservationPublic 保留 remindAt');

// ---------- 借用到期前提醒 ----------
console.log('\n📋 24. 借用到期前提醒');
const spBorrow = api.createSpace('s16', '到期提醒空间', 1, 0);
const nowB = 1000000000;
const SOON = api.BORROW_SOON_WINDOW_MS;
spBorrow.borrows.set('bb1', { id: 'bb1', toolId: 't1', borrowerAccount: 'alice', qty: 1, borrowedAt: nowB - 6 * 86400000, dueAt: nowB + 12 * 3600000, returnedAt: null, status: 'borrowed', lastRemindedAt: null, soonRemindedAt: null });
spBorrow.borrows.set('bb2', { id: 'bb2', toolId: 't1', borrowerAccount: 'bob', qty: 1, borrowedAt: nowB - 6 * 86400000, dueAt: nowB + 2 * 86400000, returnedAt: null, status: 'borrowed', lastRemindedAt: null, soonRemindedAt: null });
spBorrow.borrows.set('bb3', { id: 'bb3', toolId: 't1', borrowerAccount: 'carol', qty: 1, borrowedAt: nowB - 6 * 86400000, dueAt: nowB - 1 * 86400000, returnedAt: null, status: 'borrowed', lastRemindedAt: null, soonRemindedAt: null });
spBorrow.borrows.set('bb4', { id: 'bb4', toolId: 't1', borrowerAccount: 'dave', qty: 1, borrowedAt: nowB - 6 * 86400000, dueAt: nowB + 12 * 3600000, returnedAt: null, status: 'borrowed', lastRemindedAt: null, soonRemindedAt: nowB - 1000 });
spBorrow.borrows.set('bb5', { id: 'bb5', toolId: 't1', borrowerAccount: 'eve', qty: 1, borrowedAt: nowB - 6 * 86400000, dueAt: nowB + 12 * 3600000, returnedAt: nowB, status: 'returned', lastRemindedAt: null, soonRemindedAt: null });
const soonRem = api.dueBorrowSoonReminders(spBorrow, nowB);
assertEq(soonRem.map((b) => b.id), ['bb1'], '仅返回临近到期且未提醒过的在借用');
assertEq(api.BORROW_SOON_WINDOW_MS, 24 * 3600 * 1000, '到期提醒窗口为到期前 24 小时');

// ---------- 访客预计到访提醒 ----------
console.log('\n📋 25. 访客预计到访提醒');
const spVis = api.createSpace('s17', '访客提醒空间', 1, 0);
const nowVis = 1000000000;
spVis.visitors.set('vv1', { id: 'vv1', hostAccount: 'alice', hostName: '甲', visitorName: '王', purpose: '洽谈', expectedAt: nowVis + 10 * 60000, status: 'pending', createdAt: nowVis, code: '', remindAt: nowVis - 1, reminded: false });
spVis.visitors.set('vv2', { id: 'vv2', hostAccount: 'bob', hostName: '乙', visitorName: '李', purpose: '拜访', expectedAt: nowVis + 20 * 60000, status: 'pending', createdAt: nowVis, code: '', remindAt: nowVis + 100000, reminded: false });
spVis.visitors.set('vv3', { id: 'vv3', hostAccount: 'carol', hostName: '丙', visitorName: '赵', purpose: '拜访', expectedAt: nowVis + 10 * 60000, status: 'pending', createdAt: nowVis, code: '', remindAt: nowVis - 1, reminded: true });
spVis.visitors.set('vv4', { id: 'vv4', hostAccount: 'dave', hostName: '丁', visitorName: '钱', purpose: '拜访', expectedAt: nowVis + 10 * 60000, status: 'arrived', createdAt: nowVis, code: '', remindAt: nowVis - 1, reminded: false });
const visRem = api.dueVisitorReminders(spVis, nowVis);
assertEq(visRem.map((v) => v.id), ['vv1'], '仅返回临近到访且未提醒过的待到访访客');
assertEq(api.VISIT_REMIND_WINDOW_MS, 15 * 60000, '访客提醒窗口为到访前 15 分钟');
const visPub = api.visitorsPublic(spVis, new Map());
assertEq(visPub[0].remindAt, nowVis - 1, 'visitorsPublic 保留 remindAt');

// ---------- 报修 SLA 超时提醒 ----------
console.log('\n📋 26. 报修 SLA 超时提醒');
const spRepair = api.createSpace('s18', '报修 SLA 空间', 1, 0);
const nowSla = 1000000000;
const sla = api.REPAIR_SLA_MS;
spRepair.repairs.set('rp1', { id: 'rp1', category: '灯光', location: '走廊', status: 'reported', reporterAccount: 'alice', createdAt: nowSla - sla, updatedAt: nowSla - sla, priority: 'high', slaRemindedAt: null });
spRepair.repairs.set('rp2', { id: 'rp2', category: '空调', location: '会议室', status: 'reported', reporterAccount: 'bob', createdAt: nowSla - sla + 1, updatedAt: nowSla - sla + 1, priority: 'low', slaRemindedAt: null });
spRepair.repairs.set('rp3', { id: 'rp3', category: '厕所', location: '卫生间', status: 'reported', reporterAccount: 'carol', createdAt: nowSla - sla, updatedAt: nowSla - sla, slaRemindedAt: nowSla - 1000 });
spRepair.repairs.set('rp4', { id: 'rp4', category: '其它', location: '茶水间', status: 'in_progress', reporterAccount: 'dave', createdAt: nowSla - sla, updatedAt: nowSla - sla, slaRemindedAt: null });
const slaRem = api.dueRepairSlaReminders(spRepair, nowSla);
assertEq(slaRem.map((r) => r.id), ['rp1'], '仅返回超时且未提醒过的未处理报修');
assertEq(api.REPAIR_SLA_MS, 4 * 3600 * 1000, '报修 SLA 为 4 小时');
const repPub = api.repairsPublic(spRepair, new Map());
assertEq(repPub[0].slaReminded, false, 'repairsPublic 暴露 slaReminded');

// ---------- 申领 SLA 超时提醒 ----------
console.log('\n📋 27. 申领 SLA 超时提醒');
const spMat = api.createSpace('s19', '申领 SLA 空间', 1, 0);
const nowMat = 1000000000;
const mSla = api.MATERIAL_SLA_MS;
spMat.materialRequests.set('mm1', { id: 'mm1', name: '电池', qty: 4, unit: '节', reason: '遥控器', status: 'pending', requesterAccount: 'alice', requesterName: '甲', createdAt: nowMat - mSla, handledAt: null, slaRemindedAt: null });
spMat.materialRequests.set('mm2', { id: 'mm2', name: '纸', qty: 2, unit: '包', reason: '打印', status: 'pending', requesterAccount: 'bob', requesterName: '乙', createdAt: nowMat - mSla + 1, handledAt: null, slaRemindedAt: null });
spMat.materialRequests.set('mm3', { id: 'mm3', name: '订书机', qty: 1, unit: '个', reason: '文书', status: 'pending', requesterAccount: 'carol', requesterName: '丙', createdAt: nowMat - mSla, handledAt: null, slaRemindedAt: nowMat - 1000 });
spMat.materialRequests.set('mm4', { id: 'mm4', name: '笔', qty: 3, unit: '支', reason: '文具', status: 'fulfilled', requesterAccount: 'dave', requesterName: '丁', createdAt: nowMat - mSla, handledAt: nowMat, slaRemindedAt: null });
const matSlaRem = api.dueMaterialSlaReminders(spMat, nowMat);
assertEq(matSlaRem.map((m) => m.id), ['mm1'], '仅返回超时且未提醒过的未处理申领');
assertEq(api.MATERIAL_SLA_MS, 2 * 24 * 3600 * 1000, '申领 SLA 为 48 小时');
const matPub = api.materialsPublic(spMat, new Map());
assertEq(matPub[0].slaReminded, false, 'materialsPublic 暴露 slaReminded');

// ---------- 报修重复检测 ----------
console.log('\n📋 28. 报修重复检测');
const spDup = api.createSpace('s20', '报修重复空间', 1, 0);
const nowDup = 1000000000;
spDup.repairs.set('d1', { id: 'd1', category: '灯光', location: '三层走廊', reporterAccount: 'alice', reporterName: '甲', priority: 'normal', description: '闪烁', status: 'reported', createdAt: nowDup, updatedAt: nowDup });
spDup.repairs.set('d2', { id: 'd2', category: '灯光', location: '三层走廊', reporterAccount: 'bob', reporterName: '乙', priority: 'low', description: '不亮', status: 'in_progress', createdAt: nowDup + 1, updatedAt: nowDup + 1 });
spDup.repairs.set('d3', { id: 'd3', category: '空调', location: '三层走廊', reporterAccount: 'carol', reporterName: '丙', priority: 'normal', description: '不制冷', status: 'reported', createdAt: nowDup + 2, updatedAt: nowDup + 2 });
spDup.repairs.set('d4', { id: 'd4', category: '灯光', location: '三层走廊', reporterAccount: 'dave', reporterName: '丁', priority: 'normal', description: '已修', status: 'resolved', createdAt: nowDup + 3, updatedAt: nowDup + 3 });
spDup.repairs.set('d5', { id: 'd5', category: '灯光', location: '三层走廊', reporterAccount: 'eve', reporterName: '戊', priority: 'normal', description: '取消', status: 'cancelled', createdAt: nowDup + 4, updatedAt: nowDup + 4 });
const dupRepair = api.findDuplicateRepair(spDup, '灯光', '三层走廊');
assertEq(dupRepair && dupRepair.id, 'd2', '重复检测返回最近一条未处理同位置同类报修');
assertEq(api.findDuplicateRepair(spDup, '灯光', '二层走廊'), null, '不同位置不视为重复');
assertEq(api.findDuplicateRepair(spDup, '空调', '三层走廊').id, 'd3', '同位置不同类型不视为重复');
assertEq(api.findDuplicateRepair(spDup, '灯光', '三层走廊 ').id, 'd2', '位置去空格后匹配');
assertEq(api.findDuplicateRepair(spDup, '灯光', ''), null, '位置为空不返回重复');

// ---------- 管理员成员管理 ----------
console.log('\n📋 29. 管理员成员管理');
let lastAdminErr = null;
const fakeAdminApi = {
  users: new Map(),
  broadcastUsers: () => {},
  sendTo: (ws, m) => { if (m.type === 'error') lastAdminErr = m.message; },
  serError: (m) => ({ type: 'error', message: m }),
  genId: () => 'x',
  roomPublic: (r) => r,
  noticesBroadcast: () => {},
  isAdmin: (sp, acc) => sp.admins.has(acc),
  saveSpace: () => {},
  saveEntity: () => {},
  deleteEntity: () => {},
  broadcast: () => {},
  getUserByAccount: (a) => ({ id: 'u_' + a, account: a, nickname: a, currentSpace: 's21' }),
  sendToUser: () => {},
};
const fakeAdminWs = { readyState: 1, send: () => {} };
const extras = extrasModule(fakeAdminApi);
const spAdmin = api.createSpace('s21', '管理员空间', 1, 0);
spAdmin.admins.add('alice');
extras.adminSet(fakeAdminWs, { account: 'alice' }, spAdmin, { account: 'bob', admin: true });
assert(spAdmin.admins.has('bob'), '管理员可授予其他成员管理员');
extras.adminSet(fakeAdminWs, { account: 'alice' }, spAdmin, { account: 'bob', admin: false });
assert(!spAdmin.admins.has('bob'), '管理员可取消其他成员管理员');
extras.adminSet(fakeAdminWs, { account: 'alice' }, spAdmin, { account: 'alice', admin: false });
assert(spAdmin.admins.has('alice'), '移除最后一名管理员被拒绝');
assert(lastAdminErr && lastAdminErr.includes('至少保留一名管理员'), '最后一名管理员被拒绝并返回提示');
extras.adminSet(fakeAdminWs, { account: 'alice' }, spAdmin, { account: 'carol', admin: true });
assert(spAdmin.admins.has('carol'), '管理员可授予在线成员');
lastAdminErr = null;
extras.adminSet(fakeAdminWs, { account: 'alice' }, spAdmin, { account: 'carol', admin: true });
assert(lastAdminErr && lastAdminErr.includes('已是管理员'), '重复授予管理员被拒绝');
lastAdminErr = null;
extras.adminSet(fakeAdminWs, { account: 'dave' }, spAdmin, { account: 'carol', admin: false });
assert(lastAdminErr && lastAdminErr.includes('仅管理员'), '非管理员管理被拒绝');

console.log('\n==================================================');
console.log(`✅ 单元通过: ${passed}`);
console.log(`❌ 单元失败: ${failed}`);
console.log('==================================================');
process.exit(failed > 0 ? 1 : 0);
