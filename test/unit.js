'use strict';
// 单元测试：直接对 createContext 暴露的纯函数做断言，无需启动服务、不依赖数据库。
// 覆盖 ID 生成、周统计、坑位段位、成就解锁、口令哈希等核心逻辑。
const { createContext } = require('../src/context');

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
api.users.delete('bu1'); spB.clients.delete(fakeWs);

console.log('\n==================================================');
console.log(`✅ 单元通过: ${passed}`);
console.log(`❌ 单元失败: ${failed}`);
console.log('==================================================');
process.exit(failed > 0 ? 1 : 0);
