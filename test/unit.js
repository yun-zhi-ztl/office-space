'use strict';
// 单元测试：直接对 createContext 暴露的纯函数做断言，无需启动服务、不依赖数据库。
// 覆盖 ID 生成、周统计、坑位段位、成就解锁、口令哈希等核心逻辑。
const { createContext } = require('../src/context');
const roomsModule = require('../src/modules/rooms');

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
spBw.borrows.set('bw9', { id: 'bw9', toolId: 't9', borrowerAccount: 'alice', borrowerName: '甲', qty: 2, borrowedAt: Date.now() - 3 * 86400000, dueAt: Date.now() - 2 * 86400000, returnedAt: null, status: 'borrowed' });
const bwp = api.borrowsPublic(spBw, new Map());
assertEq(bwp.length, 1, 'borrowsPublic 返回借用记录');
assertEq(bwp[0].toolName, '测试手机', 'borrowsPublic 关联设备名称');
assertEq(bwp[0].status, 'borrowed', 'borrowsPublic 保留状态');
assertEq(bwp[0].overdue, true, 'borrowsPublic 标记逾期');

console.log('\n==================================================');
console.log(`✅ 单元通过: ${passed}`);
console.log(`❌ 单元失败: ${failed}`);
console.log('==================================================');
process.exit(failed > 0 ? 1 : 0);
