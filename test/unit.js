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
assertEq(stats.meetingActualDuration, 0, 'newStats 初始 meetingActualDuration=0');
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
assertEq(pub.length, 24, '成就公开列表含 24 项');
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
const today0ForDigest = new Date(); today0ForDigest.setHours(12, 0, 0, 0);
const digestNow = today0ForDigest.getTime();
dv.borrows.set('bw', { id: 'bw', toolId: 't1', borrowerAccount: 'alice', qty: 1, borrowedAt: digestNow - 10 * 60000, returnedAt: digestNow - 5 * 60000, status: 'returned' });
dv.roomReservations.set('rm', { id: 'rm', roomId: 'r1', ownerAccount: 'bob', startAt: digestNow - 30 * 60000, endAt: digestNow - 10 * 60000, status: 'completed' });
const digest2 = api.buildDigest(dv, du, digestNow);
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
const ownerUser = { id: 'ru1', account: 'alice', nickname: '甲', stats: { meetingDuration: 0, meetingActualDuration: 0 }, achievements: [] };
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
rsvSpace.roomReservations.set('r1', { id: 'r1', roomId: 'rm1', ownerAccount: 'alice', startAt: Date.now() - 60 * 60000, endAt: Date.now() - 10 * 60000, status: 'active', actualStartAt: Date.now() - 30 * 60000 });
rooms.handleRooms({}, ownerUser, rsvSpace, { type: 'roomEnd', reservationId: 'r1' });
assertEq(ownerUser.stats.meetingDuration, 50, 'roomEnd 累计会议时长 50 分钟');
assertEq(ownerUser.stats.meetingActualDuration, 30, 'roomEnd 累计实际到场时长 30 分钟');

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
us.roomReservations.set('u7', { id: 'u7', roomId: 'r7', ownerAccount: 'alice', startAt: now7ms, endAt: now7ms + 60 * 60000, status: 'completed', actualStartAt: now7ms + 10 * 60000, actualEndAt: now7ms + 40 * 60000 });
us.roomReservations.set('u8', { id: 'u8', roomId: 'r7', ownerAccount: 'bob', startAt: now7ms + 86400000, endAt: now7ms + 86400000 + 30 * 60000, status: 'pending' });
const usage = api.roomUsageStats(us, now7ms);
assertEq(usage.rooms[0].todayCount, 1, '今日场次统计为 1');
assertEq(usage.rooms[0].todayMinutes, 60, '今日时长统计 60 分钟');
assertEq(usage.rooms[0].actualMinutes, 30, '实际到场时长统计 30 分钟');
assertEq(usage.totalActualMinutes, 30, '总实际到场时长统计 30 分钟');
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
assertEq(bwp[0].condition, 'intact', 'borrowsPublic 默认归还状态为 intact');

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

// ---------- 通知统一入口 ----------
console.log('\n📋 30. 通知统一入口');
const spN = api.createSpace('s22', '通知空间', 1, 0);
const n1 = api.pushNotice(spN, '测试公告', 'alice', '甲');
assertEq(spN.notices.length, 1, 'pushNotice 写入公告');
assertEq(n1.text, '测试公告', 'pushNotice 保留公告文本');
assertEq(n1.from, '甲', 'pushNotice 使用展示名作为来源');
assertEq(spN.notices[0].id, n1.id, 'pushNotice 公告置顶');
api.pushNotice(spN, '第二条', 'bob', '乙');
assertEq(spN.notices.length, 2, 'pushNotice 第二条公告');
assertEq(spN.notices[0].text, '第二条', 'pushNotice 新公告置顶');

// ---------- 报修处理时长统计 ----------
console.log('\n📋 31. 报修处理时长统计');
const nowH = (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime() - 30 * 60000; })();
const spHandle = api.createSpace('s23', '处理时长空间', 1, 0);
spHandle.repairs.set('h1', { id: 'h1', category: '灯光', location: '走廊', reporterAccount: 'alice', reporterName: '甲', priority: 'normal', description: '闪烁', status: 'resolved', createdAt: nowH, updatedAt: nowH, handledAt: nowH + 60 * 60000 });
spHandle.repairs.set('h2', { id: 'h2', category: '空调', location: '会议室', reporterAccount: 'bob', reporterName: '乙', priority: 'normal', description: '不制冷', status: 'reported', createdAt: nowH, updatedAt: nowH });
const repHandle = api.repairsPublic(spHandle, new Map());
assertEq(repHandle.find((r) => r.id === 'h1').handledAt, nowH + 60 * 60000, 'resolved 报修暴露 handledAt');
assertEq(repHandle.find((r) => r.id === 'h1').handleDurationMinutes, 60, 'resolved 报修处理时长 60 分钟');
assertEq(repHandle.find((r) => r.id === 'h2').handledAt, null, '未解决报修 handledAt 为 null');
assertEq(repHandle.find((r) => r.id === 'h2').handleDurationMinutes, null, '未解决报修处理时长为 null');
spHandle.materialRequests.set('mh1', { id: 'mh1', name: '电池', qty: 4, unit: '节', reason: 'r', status: 'fulfilled', requesterAccount: 'alice', requesterName: '甲', createdAt: nowH, handledAt: nowH + 60000, slaRemindedAt: null });
const matHandle = api.materialsPublic(spHandle, new Map());
assertEq(matHandle.find((m) => m.id === 'mh1').handleDurationMinutes, 1, '已满足申领暴露处理时长');
const duHandle = { account: 'alice', stats: api.newStats(), achievements: [] };
const nowDigest = nowH + 30 * 60000;
const dig = api.buildDigest(spHandle, duHandle, nowDigest);
assertEq(dig.resolvedRepairsCount, 1, 'digest 统计今日已解决报修');
assertEq(dig.resolvedMaterialsCount, 1, 'digest 统计今日已满足申领');

// ---------- 会议室评分聚合 ----------
console.log('\n📋 32. 会议室评分聚合');
const spRoomRate = api.createSpace('s24', '评分空间', 1, 0);
spRoomRate.rooms.push({ id: 'rm1', name: '会议室A', capacity: 8, location: '3F', description: '' });
const nowRate = 1000000000;
spRoomRate.roomReservations.set('rr1', { id: 'rr1', roomId: 'rm1', ownerAccount: 'alice', ownerName: '甲', title: '评审', startAt: nowRate - 120000, endAt: nowRate - 60000, status: 'completed', rating: 5, ratingComment: '很好', ratedAt: nowRate - 50000 });
spRoomRate.roomReservations.set('rr2', { id: 'rr2', roomId: 'rm1', ownerAccount: 'bob', ownerName: '乙', title: '周会', startAt: nowRate - 240000, endAt: nowRate - 180000, status: 'completed', rating: 3, ratingComment: '', ratedAt: nowRate - 170000 });
spRoomRate.roomReservations.set('rr3', { id: 'rr3', roomId: 'rm1', ownerAccount: 'carol', ownerName: '丙', title: '讨论', startAt: nowRate - 300000, endAt: nowRate - 240000, status: 'completed', rating: 0, ratingComment: '', ratedAt: 0 });
spRoomRate.roomReservations.set('rr4', { id: 'rr4', roomId: 'rm1', ownerAccount: 'dave', ownerName: '丁', title: '未评', startAt: nowRate, endAt: nowRate + 60000, status: 'active', rating: 0, ratingComment: '', ratedAt: 0 });
const roomRateSum = api.roomRatingSummary(spRoomRate, 'rm1');
assertEq(roomRateSum.count, 2, '仅统计已评分的已完成会议');
assertEq(roomRateSum.avg, 4, '会议室平均评分 4 分');
assertEq(roomRateSum.ratings.length, 2, '评分明细返回 2 条');
assertEq(api.roomPublic(spRoomRate, spRoomRate.rooms[0]).rating.avg, 4, 'roomPublic 暴露会议室平均评分');
const resRatePub = api.reservationPublic(spRoomRate.roomReservations.get('rr1'), new Map());
assertEq(resRatePub.rating, 5, 'reservationPublic 暴露评分');
assertEq(resRatePub.ratedAt, nowRate - 50000, 'reservationPublic 暴露评分时间');

// ---------- 报修升级 ----------
console.log('\n📋 33. 报修升级');
const spEsc = api.createSpace('s25', '升级空间', 1, 0);
const nowEsc = 1000000000;
const esc = api.REPAIR_ESCALATE_MS;
spEsc.repairs.set('e1', { id: 'e1', category: '厕所', location: '男厕', reporterAccount: 'alice', reporterName: '甲', priority: 'high', status: 'reported', createdAt: nowEsc - esc, updatedAt: nowEsc - esc, slaRemindedAt: null, escalatedAt: null });
spEsc.repairs.set('e2', { id: 'e2', category: '灯光', location: '走廊', reporterAccount: 'bob', reporterName: '乙', priority: 'normal', status: 'reported', createdAt: nowEsc - esc, updatedAt: nowEsc - esc, slaRemindedAt: null, escalatedAt: null });
spEsc.repairs.set('e3', { id: 'e3', category: '空调', location: '会议室', reporterAccount: 'carol', reporterName: '丙', priority: 'high', status: 'reported', createdAt: nowEsc - esc, updatedAt: nowEsc - esc, slaRemindedAt: null, escalatedAt: nowEsc - 1000 });
spEsc.repairs.set('e4', { id: 'e4', category: '其它', location: '茶水间', reporterAccount: 'dave', reporterName: '丁', priority: 'high', status: 'resolved', createdAt: nowEsc - esc, updatedAt: nowEsc - esc, slaRemindedAt: null, escalatedAt: null });
const escList = api.dueRepairEscalations(spEsc, nowEsc);
assertEq(escList.map((r) => r.id), ['e1'], '仅高优先级且未解决、未升级的报修进入升级队列');
assertEq(api.REPAIR_ESCALATE_MS, 8 * 3600 * 1000, '报修升级阈值为 8 小时');
const repEscPub = api.repairsPublic(spEsc, new Map());
assertEq(repEscPub.find((r) => r.id === 'e1').escalated, false, '未升级报修 escalated=false');
spEsc.repairs.get('e1').escalatedAt = nowEsc;
assertEq(api.repairsPublic(spEsc, new Map()).find((r) => r.id === 'e1').escalated, true, '升级后 escalated=true');

// ---------- 收藏会议室 ----------
console.log('\n📋 34. 收藏会议室');
const favStats = api.newStats();
assert(Array.isArray(favStats.favoriteRooms), 'newStats 初始化 favoriteRooms 数组');
assertEq(favStats.favoriteRooms.length, 0, '默认无收藏会议室');

// ---------- 低库存预警 ----------
console.log('\n📋 35. 低库存预警');
assert(api.isToolLowStock({ available: 1, total: 3, minAvailable: 1 }), '可用数等于阈值判定为低库存');
assert(!api.isToolLowStock({ available: 2, total: 3, minAvailable: 1 }), '可用数高于阈值不判定为低库存');
assert(api.isToolLowStock({ available: 0, total: 1 }), '默认阈值 1 时可用 0 判定为低库存');
const spLow = api.createSpace('s26', '低库存空间', 1, 0);
spLow.tools.push({ id: 'low1', name: '测试机', category: '测试机器', total: 3, available: 2, minAvailable: 1, location: '', description: '' });
spLow.tools.push({ id: 'low2', name: '测试机2', category: '测试机器', total: 3, available: 0, minAvailable: 2, location: '', description: '' });
const lowPub = api.toolsPublic(spLow, new Map());
assertEq(lowPub.find((t) => t.id === 'low1').lowStock, false, '高于阈值的 lowStock=false');
assertEq(lowPub.find((t) => t.id === 'low2').lowStock, true, '跌破阈值的 lowStock=true');
assertEq(lowPub.find((t) => t.id === 'low2').minAvailable, 2, 'toolsPublic 暴露 minAvailable');

// ---------- 空间周报 ----------
console.log('\n📋 36. 空间周报');
const spWeek = api.createSpace('s27', '周报空间', 1, 0);
const nowW = 1000000000;
spWeek.roomReservations.set('w1', { id: 'w1', roomId: 'rm1', ownerAccount: 'alice', ownerName: '甲', startAt: nowW - 60000, endAt: nowW, status: 'completed', title: '会' });
spWeek.borrows.set('wb', { id: 'wb', toolId: 't1', borrowerAccount: 'alice', qty: 1, borrowedAt: nowW, returnedAt: null, status: 'borrowed' });
spWeek.materialRequests.set('wm', { id: 'wm', name: '电池', qty: 2, unit: '节', reason: '', status: 'fulfilled', requesterAccount: 'alice', requesterName: '甲', createdAt: nowW, handledAt: nowW, slaRemindedAt: null });
spWeek.repairs.set('wp', { id: 'wp', category: '灯光', location: '走廊', reporterAccount: 'alice', reporterName: '甲', priority: 'normal', description: '', status: 'reported', createdAt: nowW, updatedAt: nowW, slaRemindedAt: null, escalatedAt: null });
spWeek.visitors.set('wv', { id: 'wv', hostAccount: 'alice', hostName: '甲', visitorName: '王', purpose: '', status: 'pending', createdAt: nowW, code: '' });
spWeek.tools.push({ id: 'lowtool', name: '测试手机', category: '测试手机', total: 1, available: 0, minAvailable: 1, location: '', description: '' });
const report = api.buildWeeklyReport(spWeek, nowW);
assertEq(report.meetings, 1, '周报统计会议数');
assertEq(report.borrows, 1, '周报统计借用数');
assertEq(report.requests, 1, '周报统计申领数');
assertEq(report.repairs, 1, '周报统计报修数');
assertEq(report.visitors, 1, '周报统计访客数');
assertEq(report.fulfilledMaterials, 1, '周报统计已满足申领');
assertEq(report.lowStockTools.length, 1, '周报统计低库存设备');
assertEq(api.buildWeeklyReport(spWeek, nowW).meetingMinutes, 1, '周报统计会议分钟数');

// ---------- 成就扩展 ----------
console.log('\n📋 37. 成就扩展（会议室向导 / 收藏家）');
const achUser = { stats: api.newStats(), achievements: [] };
achUser.stats.roomRatesGiven = 3;
api.checkAchievements(achUser);
assert(achUser.achievements.includes('roomGuide'), '评分 3 次解锁会议室向导');
achUser.stats.favoriteCount = 3;
api.checkAchievements(achUser);
assert(achUser.achievements.includes('collector'), '收藏 3 个会议室解锁收藏家');
const achGuide = api.achievementDefsPublic(achUser).find((a) => a.id === 'roomGuide');
assertEq(achGuide.unlocked, true, '会议室向导已解锁');
assertEq(achGuide.target, 3, '会议室向导目标值 3');

// ---------- 物资库存台账 ----------
console.log('\n📋 38. 物资库存台账');
assert(api.isStockLow({ available: 1, total: 3, minAvailable: 1 }), '可用数等于阈值判定为库存告急');
assert(!api.isStockLow({ available: 2, total: 3, minAvailable: 1 }), '可用数高于阈值不判定为库存告急');
assert(api.isStockLow({ available: 0, total: 1 }), '默认阈值 1 时可用 0 判定为库存告急');
const spInv = api.createSpace('s28', '库存空间', 1, 0);
spInv.inventory.push({ id: 'inv1', name: '5号电池', category: '电池', unit: '节', total: 3, available: 1, minAvailable: 1, location: '茶水间', description: '' });
spInv.inventory.push({ id: 'inv2', name: 'A4纸', category: '打印耗材', unit: '包', total: 2, available: 2, minAvailable: 1, location: '前台', description: '' });
spInv.inventoryIssues.set('ivs1', { id: 'ivs1', itemId: 'inv1', itemName: '5号电池', issuerAccount: 'alice', issuerName: '甲', qty: 1, status: 'issued', createdAt: Date.now(), returnedAt: null, dueAt: Date.now() + 3 * 86400000 });
const invPub = api.inventoryPublic(spInv, new Map());
assertEq(invPub.find((i) => i.id === 'inv1').lowStock, true, '库存告急物资 lowStock=true');
assertEq(invPub.find((i) => i.id === 'inv1').borrowedCount, 1, '物资在领数量统计');
assertEq(invPub.find((i) => i.id === 'inv1').activeIssues.length, 1, '物资在领明细序列化');
assertEq(invPub.find((i) => i.id === 'inv2').lowStock, false, '库存充足物资 lowStock=false');
const invIssues = api.inventoryIssuesPublic(spInv, new Map());
assertEq(invIssues.length, 1, '库存领用记录仅返回在领状态');
assertEq(invIssues[0].itemName, '5号电池', '库存领用记录关联物资名称');

// ---------- 考勤打卡 ----------
console.log('\n📋 39. 考勤打卡');
const todayD = new Date('2026-10-16T09:05:00+08:00');
assertEq(api.todayKey(todayD.getTime()), '2026-10-16', 'todayKey 返回 YYYY-MM-DD');
const cfgA = api.newAttendanceConfig();
assertEq(cfgA.workStart, '09:00', '考勤默认上班时间 09:00');
assertEq(cfgA.workEnd, '18:00', '考勤默认下班时间 18:00');
assertEq(cfgA.lateMinutes, 15, '考勤默认迟到宽限 15 分钟');
assertEq(api.parseTime('09:05'), 545, 'parseTime 解析 HH:MM 为分钟');
assertEq(api.parseTime('bad'), null, 'parseTime 非法格式返回 null');
// 09:00 上班、宽限 15 分钟：09:15 已迟到（>= 宽限）
const nine = new Date('2026-10-16T09:00:00+08:00').getTime();
const at9 = new Date('2026-10-16T09:00:00+08:00').getTime();
const at915 = new Date('2026-10-16T09:15:00+08:00').getTime();
const at916 = new Date('2026-10-16T09:16:00+08:00').getTime();
assertEq(api.isLateAt(at9, cfgA), false, '09:00 打卡不迟到');
assertEq(api.isLateAt(at915, cfgA), true, '09:15 打卡已迟到（宽限 15 分钟）');
assertEq(api.isLateAt(at916, cfgA), true, '09:16 打卡已迟到');
const spA = api.createSpace('s29', '考勤空间', 1, 0);
const nowA = new Date('2026-10-16T12:00:00+08:00').getTime();
spA.attendance.set('alice::2026-10-16', { id: 'a1', account: 'alice', name: '甲', date: '2026-10-16', checkInAt: nine, checkOutAt: nine + 3 * 60 * 60000, isLate: false, status: 'checked_out', workedMinutes: 180 });
spA.attendance.set('bob::2026-10-16', { id: 'a2', account: 'bob', name: '乙', date: '2026-10-16', checkInAt: at915, checkOutAt: null, isLate: true, status: 'checked_in', workedMinutes: 0 });
spA.attendance.set('carol::2026-10-15', { id: 'a3', account: 'carol', name: '丙', date: '2026-10-15', checkInAt: nine, checkOutAt: null, isLate: false, status: 'checked_in', workedMinutes: 0 });
const ap = api.attendancePublic(spA, nowA);
assertEq(ap.length, 2, 'attendancePublic 仅返回今日记录');
assertEq(ap[0].account, 'alice', 'attendancePublic 按打卡时间升序');
assertEq(ap[1].isLate, true, 'attendancePublic 保留迟到标记');
const as = api.attendanceStats(spA, nowA);
assertEq(as.checkedIn, 2, '考勤统计今日打卡人数');
assertEq(as.late, 1, '考勤统计迟到人数');
assertEq(as.checkedOut, 1, '考勤统计已下班人数');
assertEq(as.completeRate, 50, '考勤统计下班完成率 50%');
assertEq(as.earliestCheckIn, nine, '考勤统计最早打卡时间');
assertEq(as.latestCheckOut, nine + 3 * 60 * 60000, '考勤统计最晚下班时间');
// 空空间不崩溃
assertEq(api.attendanceStats(api.createSpace('s30', '空考勤空间', 1, 0), nowA).checkedIn, 0, '无记录时考勤统计为 0');

// ---------- 成就扩展（早鸟/打卡达人） ----------
console.log('\n📋 40. 成就扩展（早到达人 / 打卡达人）');
const achUser2 = { stats: api.newStats(), achievements: [] };
achUser2.stats.earlyCount = 3;
api.checkAchievements(achUser2);
assert(achUser2.achievements.includes('earlyBird'), '9 点前打卡 3 天解锁早到达人');
achUser2.stats.attendanceCount = 10;
api.checkAchievements(achUser2);
assert(achUser2.achievements.includes('attendanceKing'), '累计打卡 10 次解锁打卡达人');
const achEarly = api.achievementDefsPublic(achUser2).find((a) => a.id === 'earlyBird');
assertEq(achEarly.target, 3, '早到达人目标值 3');
const achKing = api.achievementDefsPublic(achUser2).find((a) => a.id === 'attendanceKing');
assertEq(achKing.target, 10, '打卡达人目标值 10');

// ---------- 意见反馈序列化 + 工位签到字段 + 扩展成就 ----------
console.log('\n📋 41. 意见反馈 / 工位签到 / 扩展成就');
const fbSp = api.createSpace('s41', '反馈空间', 1, 0);
fbSp.feedbacks.set('fb1', { id: 'fb1', account: 'alice', name: '甲', anonymous: false, category: '建议', content: '希望加一个意见反馈模块', status: 'answered', replies: [{ account: 'admin', name: '管理员', content: '收到，已加入排期', createdAt: 1 }], createdAt: 2, handledAt: 3 });
fbSp.feedbacks.set('fb2', { id: 'fb2', account: 'bob', name: '乙', anonymous: true, category: '吐槽', content: '咖啡机经常没咖啡', status: 'open', replies: [], createdAt: 4, handledAt: null });
const fbPub = api.feedbackPublic(fbSp, api.spaceUserInfo(fbSp.id));
assertEq(fbPub.length, 2, 'feedbackPublic 返回全部反馈');
assertEq(fbPub[0].author, '匿名成员', '匿名反馈隐藏真实作者');
assertEq(fbPub[0].replies.length, 0, '匿名反馈回复列表为空');
const fbPub1 = fbPub.find((f) => f.id === 'fb1');
assertEq(fbPub1.author, '甲', '实名反馈显示作者');
assertEq(fbPub1.replies[0].content, '收到，已加入排期', 'feedbackPublic 暴露管理员回复');
const fbStats = api.feedbackStats(fbSp);
assertEq(fbStats.open, 1, 'feedbackStats 统计待处理');
assertEq(fbStats.answered, 1, 'feedbackStats 统计已回复');
assertEq(fbStats.closed, 0, 'feedbackStats 统计已关闭');
const deskSp = api.createSpace('s42', '工位空间', 1, 0);
deskSp.desks.push({ id: 'd1', name: '3F工位A', location: '3F', description: '' });
deskSp.deskReservations.set('drv1', { id: 'drv1', deskId: 'd1', account: 'alice', name: '甲', startAt: 1, endAt: 2, note: '', status: 'active', actualStartAt: 1, actualEndAt: null });
const deskResPub = api.deskReservationsPublic(deskSp, api.spaceUserInfo(deskSp.id));
assertEq(deskResPub[0].actualStartAt, 1, '工位预约序列化暴露实际签到时间');
assertEq(deskResPub[0].actualEndAt, null, '未签退时实际签退时间为空');
const achUser3 = { stats: api.newStats(), achievements: [] };
achUser3.stats.deskCount = 5;
api.checkAchievements(achUser3);
assert(achUser3.achievements.includes('deskKnight'), '工位预约 5 次解锁工位达人');
achUser3.stats.oooCount = 5;
api.checkAchievements(achUser3);
assert(achUser3.achievements.includes('awayReporter'), '外出登记 5 次解锁外出报备达人');
achUser3.stats.feedbackReplyCount = 3;
api.checkAchievements(achUser3);
assert(achUser3.achievements.includes('listener'), '回复反馈 3 条解锁倾听达人');
const achListener = api.achievementDefsPublic(achUser3).find((a) => a.id === 'listener');
assertEq(achListener.target, 3, '倾听达人目标值 3');

// ---------- 物资优先级 + 心情序列化 ----------
console.log('\n📋 42. 物资优先级 / 心情序列化');
const matSp = api.createSpace('s43', '物资空间', 1, 0);
matSp.materialRequests.set('m1', { id: 'm1', name: '电池', qty: 1, unit: '节', reason: '', status: 'pending', requesterAccount: 'alice', requesterName: '甲', priority: 'normal', createdAt: 100, handledAt: null, slaRemindedAt: null });
matSp.materialRequests.set('m2', { id: 'm2', name: '纸', qty: 1, unit: '包', reason: '', status: 'pending', requesterAccount: 'bob', requesterName: '乙', priority: 'high', createdAt: 200, handledAt: null, slaRemindedAt: null });
matSp.materialRequests.set('m3', { id: 'm3', name: '笔', qty: 1, unit: '支', reason: '', status: 'pending', requesterAccount: 'carol', requesterName: '丙', priority: 'low', createdAt: 300, handledAt: null, slaRemindedAt: null });
const matPub2 = api.materialsPublic(matSp, new Map());
assertEq(matPub2[0].id, 'm2', 'materialsPublic 高优先级排在前面');
assertEq(matPub2[2].id, 'm3', 'materialsPublic 低优先级排在后面');
assertEq(matPub2[0].priority, 'high', 'materialsPublic 暴露 priority 字段');
const moodSp = api.createSpace('s44', '心情空间', 1, 0);
const moodToday = api.todayKey();
moodSp.moods.set('md1', { id: 'md1', account: 'alice', name: '甲', date: moodToday, emoji: '😊', createdAt: 1 });
moodSp.moods.set('md2', { id: 'md2', account: 'bob', name: '乙', date: moodToday, emoji: '😴', createdAt: 2 });
moodSp.moods.set('md3', { id: 'md3', account: 'carol', name: '丙', date: '2020-01-01', emoji: '😊', createdAt: 3 });
const moodPub = api.moodPublic(moodSp, api.spaceUserInfo(moodSp.id));
assertEq(moodPub.length, 2, 'moodPublic 仅返回今日记录');
assertEq(moodPub.find((r) => r.account === 'alice').emoji, '😊', 'moodPublic 保留心情表情');
const moodSt = api.moodStats(moodSp);
assertEq(moodSt.total, 2, 'moodStats 统计今日总人数');
assertEq(moodSt.counts['😴'], 1, 'moodStats 统计单种表情数量');
assertEq(moodSt.counts['😊'], 1, 'moodStats 统计多种表情数量');

// ---------- 活动序列化 + 统计 ----------
console.log('\n📋 43. 活动序列化 / 统计 / 提醒');
const evSp = api.createSpace('s45', '活动空间', 1, 0);
const tEv = new Date('2026-10-17T10:00:00+08:00').getTime();
evSp.events.set('ev1', { id: 'ev1', title: 'Q4 分享会', description: '技术分享', category: '分享会', location: '3F', hostAccount: 'alice', hostName: '甲', startAt: tEv, endAt: tEv + 60 * 60000, capacity: 5, rsvps: { alice: 'going', bob: 'maybe' }, cancelled: false, reminded: false, remindAt: tEv - 10 * 60000, createdAt: 1 });
evSp.events.set('ev2', { id: 'ev2', title: '团建', category: '团建', hostAccount: 'alice', hostName: '甲', startAt: tEv - 120 * 60000, endAt: tEv - 60 * 60000, capacity: 0, rsvps: {}, cancelled: false, reminded: false, remindAt: 0, createdAt: 2 });
evSp.events.set('ev3', { id: 'ev3', title: '已取消', category: '会议', hostAccount: 'bob', hostName: '乙', startAt: tEv + 3600000, endAt: tEv + 7200000, capacity: 0, rsvps: {}, cancelled: true, reminded: false, remindAt: 0, createdAt: 3 });
evSp.events.set('ev4', { id: 'ev4', title: '生日会', category: '生日会', hostAccount: 'alice', hostName: '甲', startAt: tEv + 3600000, endAt: tEv + 5400000, capacity: 0, rsvps: {}, cancelled: false, reminded: false, remindAt: 0, createdAt: 4 });
const evPub = api.eventPublic(evSp, api.spaceUserInfo(evSp.id), null, tEv);
assertEq(evPub.length, 4, 'eventPublic 返回全部活动');
assertEq(evPub.find((e) => e.id === 'ev1').status, 'ongoing', '进行中的活动状态为 ongoing');
assertEq(evPub.find((e) => e.id === 'ev2').status, 'ended', '已结束的活动状态为 ended');
assertEq(evPub.find((e) => e.id === 'ev3').status, 'cancelled', '已取消的活动状态为 cancelled');
assertEq(evPub.find((e) => e.id === 'ev1').goingCount, 1, 'eventPublic 统计参加人数');
assertEq(evPub.find((e) => e.id === 'ev1').maybeCount, 1, 'eventPublic 统计可能人数');
const evSt = api.eventStats(evSp, tEv);
assertEq(evSt.total, 4, 'eventStats 统计活动总数');
assertEq(evSt.upcoming, 1, 'eventStats 统计即将开始');
assertEq(evSt.ongoing, 1, 'eventStats 统计进行中');
assertEq(evSt.cancelled, 1, 'eventStats 统计已取消');
const evRem = api.dueEventReminders(evSp, tEv - 5 * 60000);
assertEq(evRem.length, 1, 'dueEventReminders 命中开始前 10 分钟内的活动');
assertEq(api.dueEventReminders(evSp, tEv + 5 * 60000).length, 0, 'dueEventReminders 活动开始后不再提醒');

// ---------- 投票序列化 + 统计 ----------
console.log('\n📋 44. 投票序列化 / 统计');
const plSp = api.createSpace('s46', '投票空间', 1, 0);
plSp.polls.set('pl1', { id: 'pl1', question: '午饭吃什么', options: [{ id: 'o1', text: '面' }, { id: 'o2', text: '饭' }], anonymous: true, creatorAccount: 'alice', creatorName: '甲', status: 'open', createdAt: 1, deadline: null, votes: { alice: 'o1', bob: 'o2', carol: 'o1' } });
const plPub = api.pollPublic(plSp, api.spaceUserInfo(plSp.id), { account: 'alice' });
assertEq(plPub.length, 1, 'pollPublic 返回投票');
assertEq(plPub[0].options[0].count, 2, 'pollPublic 统计选项票数');
assertEq(plPub[0].options[1].count, 1, 'pollPublic 统计第二项票数');
assertEq(plPub[0].myVote, 'o1', 'pollPublic 暴露本人投票');
assertEq(plPub[0].totalVotes, 3, 'pollPublic 统计总投票数');
assertEq(plPub[0].anonymous, true, 'pollPublic 保留匿名标记');
const plSt = api.pollStats(plSp);
assertEq(plSt.open, 1, 'pollStats 统计进行中');
assertEq(plSt.totalVotes, 3, 'pollStats 统计总投票');

// ---------- 知识库序列化 + 统计 ----------
console.log('\n📋 45. 知识库序列化 / 统计');
const kbSp = api.createSpace('s47', '知识空间', 1, 0);
kbSp.knowledge.set('kb1', { id: 'kb1', title: 'A4 纸在哪', content: '打印区右侧柜子', category: '操作指引', tags: ['打印'], authorAccount: 'alice', authorName: '甲', likes: ['alice', 'bob'], createdAt: 1, updatedAt: 2 });
kbSp.knowledge.set('kb2', { id: 'kb2', title: '会议室规则', content: '用完关灯', category: '规章制度', tags: [], authorAccount: 'bob', authorName: '乙', likes: [], createdAt: 3, updatedAt: 4 });
const kbPub = api.knowledgePublic(kbSp, api.spaceUserInfo(kbSp.id), { account: 'alice' });
assertEq(kbPub.length, 2, 'knowledgePublic 返回全部文章');
assertEq(kbPub[0].title, 'A4 纸在哪', 'knowledgePublic 按点赞数排序');
assertEq(kbPub[0].likeCount, 2, 'knowledgePublic 统计点赞数');
assertEq(kbPub[0].liked, true, 'knowledgePublic 标记本人已赞');
assertEq(kbPub[1].liked, false, 'knowledgePublic 未点赞为 false');
const kbSt = api.knowledgeStats(kbSp);
assertEq(kbSt.total, 2, 'knowledgeStats 统计文章数');
assertEq(kbSt.liked, 2, 'knowledgeStats 统计点赞总数');

// ---------- 扩展成就 ----------
console.log('\n📋 46. 活动 / 投票 / 知识库成就');
const achUser4 = { stats: api.newStats(), achievements: [] };
achUser4.stats.eventCount = 3; achUser4.stats.eventAttendCount = 5;
api.checkAchievements(achUser4);
assert(achUser4.achievements.includes('eventHost'), '举办活动 3 次解锁活动主办');
assert(achUser4.achievements.includes('eventAttendee'), '参加活动 5 次解锁活动达人');
achUser4.stats.pollCreateCount = 3; achUser4.stats.pollVoteCount = 5;
api.checkAchievements(achUser4);
assert(achUser4.achievements.includes('pollMaker'), '发起投票 3 次解锁决策发起人');
assert(achUser4.achievements.includes('pollVoter'), '参与投票 5 次解锁参与决策者');
achUser4.stats.knowledgeCount = 3; achUser4.stats.knowledgeLikeCount = 10;
api.checkAchievements(achUser4);
assert(achUser4.achievements.includes('knowledgeAuthor'), '发布知识 3 篇解锁知识贡献者');
assert(achUser4.achievements.includes('knowledgeLiked'), '获得 10 赞解锁知识之星');

console.log('\n==================================================');
console.log(`✅ 单元通过: ${passed}`);
console.log(`❌ 单元失败: ${failed}`);
console.log('==================================================');
process.exit(failed > 0 ? 1 : 0);
