'use strict';
// 单元测试：直接对 createContext 暴露的纯函数做断言，无需启动服务、不依赖数据库。
// 覆盖 ID 生成、周统计、坑位段位、成就解锁、口令哈希等核心逻辑。
const { createContext } = require('../src/context');
const roomsModule = require('../src/modules/rooms');
const assetsModule = require('../src/modules/assets');
const keysModule = require('../src/modules/keys');
const fridgeModule = require('../src/modules/fridge');
const parkingModule = require('../src/modules/parking');
const parcelsModule = require('../src/modules/parcels');
const lockersModule = require('../src/modules/lockers');
const vehiclesModule = require('../src/modules/vehicles');
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
assertEq(stats.dutyCount, 0, 'newStats 初始 dutyCount=0');
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
assertEq(pub.length, 29, '成就公开列表含 29 项');
assert(pub.every((a) => a.id && a.name && a.desc && a.icon), '公开成就含 id/name/desc/icon');
user.stats.borrowCount = 3;
assert(api.achievementProgress(user, api.ACHIEVEMENT_DEFS.find((d) => d.id === 'borrower')).unlocked === true, '借用 3 次解锁借阅达人');
user.stats.meetingDuration = 60;
assert(api.achievementProgress(user, api.ACHIEVEMENT_DEFS.find((d) => d.id === 'meeter')).unlocked === true, '会议时长 60 分钟解锁会议达人');
user.stats.meetingOnTime = 5;
assert(api.achievementProgress(user, api.ACHIEVEMENT_DEFS.find((d) => d.id === 'meetingPunctual')).unlocked === true, '5 次准时开会解锁会议守时');
assert(api.achievementProgress(user, api.ACHIEVEMENT_DEFS.find((d) => d.id === 'meetingPunctual')).pct === 100, '会议守时达成后进度 100');
assertEq(api.newStats().meetingOnTime, 0, 'newStats 初始 meetingOnTime 为 0');
assertEq(api.newStats().meetingLate, 0, 'newStats 初始 meetingLate 为 0');
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
  genDoorCode: () => '000001',
  saveEntity: () => {},
  deleteEntity: () => {},
  recordWeekly: () => {},
  getUserByAccount: (a) => (a === 'alice' ? ownerUser : null),
  sendToUser: () => {},
  saveProfile: () => {},
  broadcastLeaderboard: () => {},
  roomStatsBroadcast: () => {},
  roomInsights: () => ({ ratingRanking: [], usageRanking: [] }),
};
const rooms = roomsModule(fakeApi);
const rsvSpace = { id: 's6', roomReservations: new Map(), rooms: [] };
rsvSpace.roomReservations.set('r1', { id: 'r1', roomId: 'rm1', ownerAccount: 'alice', startAt: Date.now() - 60 * 60000, endAt: Date.now() - 10 * 60000, status: 'active', actualStartAt: Date.now() - 30 * 60000 });
rooms.handleRooms({}, ownerUser, rsvSpace, { type: 'roomEnd', reservationId: 'r1' });
assertEq(ownerUser.stats.meetingDuration, 50, 'roomEnd 累计会议时长 50 分钟');
assertEq(ownerUser.stats.meetingActualDuration, 30, 'roomEnd 累计实际到场时长 30 分钟');

// ---------- 会议室参会人与到场确认 ----------
console.log('\n📋 12b. 会议室参会人与到场确认');
const attUser = { id: 'ru1', account: 'alice', nickname: '甲', currentSpace: 's12b', stats: {}, achievements: [] };
const memberB = { id: 'ru2', account: 'bob', nickname: '乙', currentSpace: 's12b', stats: {}, achievements: [] };
const memberC = { id: 'ru3', account: 'carol', nickname: '丙', currentSpace: 's12b', stats: {}, achievements: [] };
const roomsOnline = [attUser, memberB, memberC];
const sentTo = [];
const roomAttApi = {
  roomReservationsPublic: () => [],
  roomWaitlistPublic: () => [],
  roomPublic: (r) => r,
  broadcast: () => {},
  LIST_PAGE: 30,
  isAdmin: () => false,
  sendTo: (ws, obj) => { sentTo.push(obj); },
  serError: (m) => ({ type: 'error', message: m }),
  genId: () => 'x',
  genDoorCode: () => '000001',
  saveEntity: () => {},
  deleteEntity: () => {},
  recordWeekly: () => {},
  getUserByAccount: (a) => roomsOnline.find((u) => u.account === a) || null,
  sendToUser: () => {},
  sendToAccount: (a, obj) => { sentTo.push(Object.assign({ account: a }, obj)); },
  saveProfile: () => {},
  broadcastLeaderboard: () => {},
  roomStatsBroadcast: () => {},
  roomInsights: () => ({ ratingRanking: [], usageRanking: [] }),
};
const roomAttModule = roomsModule(roomAttApi);
const attSpace = { id: 's12b', roomReservations: new Map(), rooms: [] };
const attNow = Date.now();
attSpace.roomReservations.set('ra1', { id: 'ra1', roomId: 'rmA', ownerAccount: 'alice', startAt: attNow - 1000, endAt: attNow + 90 * 60000, title: '参会会', participants: 3, attendees: ['bob', 'carol'], attendedAccounts: [], status: 'pending', remindAt: attNow, reminded: false });
roomAttModule.handleRooms({}, attUser, attSpace, { type: 'roomStart', reservationId: 'ra1' });
assert(attSpace.roomReservations.get('ra1').status === 'active', 'roomStart 后预约变为 active');
assert(sentTo.some((m) => m.type === 'meetingStarted' && m.account === 'bob'), 'roomStart 向参会人下发 meetingStarted');
assert(sentTo.some((m) => m.type === 'meetingStarted' && m.account === 'carol'), 'roomStart 向所有参会人下发 meetingStarted');
roomAttModule.handleRooms({}, memberB, attSpace, { type: 'meetingAttend', reservationId: 'ra1' });
assert(attSpace.roomReservations.get('ra1').attendedAccounts.includes('bob'), 'meetingAttend 记录 bob 到场');
assert(!attSpace.roomReservations.get('ra1').attendedAccounts.includes('carol'), 'meetingAttend 未记录 carol');
attSpace.roomReservations.set('ra2', { id: 'ra2', roomId: 'rmA', ownerAccount: 'alice', startAt: attNow + 60000, endAt: attNow + 90 * 60000, title: '改参会人', participants: 3, attendees: [], attendedAccounts: [], status: 'pending', remindAt: attNow, reminded: false });
roomAttModule.handleRooms({}, attUser, attSpace, { type: 'reservationAttendees', reservationId: 'ra2', attendees: ['carol', 'bob', 'carol'] });
assertEq(attSpace.roomReservations.get('ra2').attendees.join(','), 'carol,bob', 'reservationAttendees 去重并保留顺序');
const errBefore = sentTo.filter((m) => m.type === 'error').length;
roomAttModule.handleRooms({}, attUser, attSpace, { type: 'reservationAttendees', reservationId: 'ra2', attendees: ['dave'] });
assertEq(sentTo.filter((m) => m.type === 'error').length - errBefore, 1, '非法参会人被拒');
const rpAtt = api.reservationPublic({ id: 'rp1', ownerAccount: 'alice', attendees: ['bob', 'carol'], attendedAccounts: ['bob'] }, new Map([['alice', { display: '甲' }]]));
assertEq(rpAtt.attendees.length, 2, 'reservationPublic 暴露 attendees');
assertEq(rpAtt.attendedAccounts.length, 1, 'reservationPublic 暴露 attendedAccounts');
assertEq(rpAtt.attendanceRate, 50, 'reservationPublic 计算 attendanceRate 50%');

// ---------- 会议室设备与维护 ----------
console.log('\n📋 12c. 会议室设备与维护');
const roomEqUser = { id: 'q1', account: 'admin', nickname: '管理员', stats: {}, achievements: [] };
const roomEqSent = [];
let roomEqSeq = 0;
const roomEqApi = {
  roomReservationsPublic: () => [],
  roomWaitlistPublic: () => [],
  roomPublic: (r) => r,
  roomInsights: () => ({ ratingRanking: [], usageRanking: [] }),
  broadcast: () => {},
  LIST_PAGE: 30,
  isAdmin: () => true,
  sendTo: (ws, obj) => { roomEqSent.push(obj); },
  serError: (m) => ({ type: 'error', message: m }),
  genId: (prefix) => (prefix === 'res' ? `res${roomEqSeq++}` : 'x'),
  saveEntity: () => {},
  deleteEntity: () => {},
  recordWeekly: () => {},
  getUserByAccount: () => null,
  sendToUser: () => {},
  sendToAccount: () => {},
  saveProfile: () => {},
  broadcastLeaderboard: () => {},
  expandRecurring: api.expandRecurring,
  roomStatsBroadcast: () => {},
  checkAchievements: () => {},
  pushNotification: () => {},
  ROOM_REMIND_WINDOW_MS: 30 * 60000,
  MEETING_ONTIME_GRACE_MS: 60 * 60000,
  genDoorCode: () => '000001',
};
const roomEqModule = roomsModule(roomEqApi);
const eqSpace = { id: 's12c', rooms: [], roomReservations: new Map(), roomWaitlist: new Map(), paused: false };
eqSpace.rooms.push({ id: 'rmEq', name: '设备间', capacity: 8, minMinutes: 5, maxMinutes: 720, tags: [], equipment: [] });
roomEqModule.handleRooms({}, roomEqUser, eqSpace, { type: 'roomEquipment', roomId: 'rmEq', equipment: ['投影', '投影', '白板', '电视', 'x'.repeat(20), ''] });
assertEq(eqSpace.rooms[0].equipment, ['投影', '白板', '电视', 'xxxxxxxxxxxx'], 'roomEquipment 去重、保序并截断超长项为 12 字符');
const nowEq = Date.now() + 3600000;
roomEqModule.handleRooms({}, roomEqUser, eqSpace, { type: 'roomMaintenance', roomId: 'rmEq', until: nowEq });
assertEq(eqSpace.rooms[0].maintenanceUntil, nowEq, 'roomMaintenance 设置维护截止时间');
roomEqModule.handleRooms({}, roomEqUser, eqSpace, { type: 'roomBook', roomId: 'rmEq', startAt: nowEq - 1000, endAt: nowEq + 60000, participants: 2, equipment: ['投影'] });
assertEq(roomEqSent[roomEqSent.length - 1].message, '该会议室维护中，暂不可预约', '维护期内预约被拒绝');
roomEqModule.handleRooms({}, roomEqUser, eqSpace, { type: 'roomMaintenance', roomId: 'rmEq', clear: true });
assertEq(eqSpace.rooms[0].maintenanceUntil, null, 'roomMaintenance clear 解除维护');
const eqNow = Date.now() + 3600000;
roomEqModule.handleRooms({}, roomEqUser, eqSpace, { type: 'roomBook', roomId: 'rmEq', startAt: eqNow, endAt: eqNow + 3600000, participants: 2, equipment: ['投影', '白板', '不存在设备'] });
const eqRes = [...eqSpace.roomReservations.values()].pop();
assert(eqRes, '解除维护后可预约');
assertEq(eqRes.equipment, ['投影', '白板'], '预约设备仅保留会议室已有设备');

// ---------- 资产台账 ----------
console.log('\n📋 12d. 资产台账');
const assetUser = { id: 'a1', account: 'admin', nickname: '管理员', stats: {}, achievements: [] };
const memberUser = { id: 'a2', account: 'member', nickname: '成员', stats: {}, achievements: [] };
const assetSent = [];
let assetSeq = 0;
const assetApi = {
  ASSET_CATEGORIES: ['固定资产', '办公设备', '家具', '电器', '其它'],
  ASSET_STATUSES: ['in_use', 'idle', 'maintenance', 'scrapped'],
  ASSET_CONDITIONS: ['intact', 'damaged', 'missing'],
  spaceUserInfo: () => new Map(),
  assetsPublic: (space) => [...space.assets.values()],
  assetsStats: (space) => { const all = [...space.assets.values()]; return { total: all.length, byStatus: {}, damaged: all.filter((a) => a.condition === 'damaged').length, missing: all.filter((a) => a.condition === 'missing').length }; },
  broadcast: () => {},
  LIST_PAGE: 30,
  isAdmin: (space, account) => account === 'admin',
  sendTo: (ws, obj) => { assetSent.push(obj); },
  serError: (m) => ({ type: 'error', message: m }),
  genId: (prefix) => (prefix === 'ast' ? `ast${assetSeq++}` : 'x'),
  saveEntity: () => {},
  deleteEntity: () => {},
  pushNotification: () => {},
  sendToAccount: () => {},
  checkAchievements: () => {},
  saveProfile: () => {},
  recordWeekly: () => {},
  broadcastLeaderboard: () => {},
};
const assetModule = assetsModule(assetApi);
const assetSpace = { id: 's12d', assets: new Map() };
assetModule.handleAssets({}, assetUser, assetSpace, { type: 'assetCreate', name: '投影仪', category: '办公设备', location: '3F', owner: 'alice', status: 'in_use' });
const created = [...assetSpace.assets.values()][0];
assert(created, 'assetCreate 创建资产');
assertEq(created.name, '投影仪', '资产名称已保存');
assertEq(created.condition, 'intact', '新资产默认完好');
assetModule.handleAssets({}, memberUser, assetSpace, { type: 'assetCreate', name: '越权资产' });
assert(assetSent.some((m) => m.message && m.message.includes('仅管理员')), 'member 创建资产被拒(RBAC)');
assetModule.handleAssets({}, memberUser, assetSpace, { type: 'assetCheck', id: created.id, condition: 'damaged', note: '屏幕花屏' });
assertEq(created.condition, 'damaged', 'assetCheck 标记资产损坏');
assertEq(created.status, 'maintenance', '损坏资产自动进入维护中');
assertEq(created.checks.length, 1, '资产状态变更记录一次检查');
assertEq(created.checks[0].account, 'member', '资产检查记录上报人');
assetModule.handleAssets({}, assetUser, assetSpace, { type: 'assetUpdate', id: created.id, name: '投影仪(新)', status: 'idle' });
assertEq(created.name, '投影仪(新)', 'assetUpdate 更新名称');
assertEq(created.status, 'idle', 'assetUpdate 更新状态');
assetModule.handleAssets({}, assetUser, assetSpace, { type: 'assetDelete', id: created.id });
assertEq(assetSpace.assets.size, 0, 'assetDelete 删除资产');

// ---------- 钥匙 / 门禁卡 ----------
console.log('\n📋 12e. 钥匙门禁借用');
const keyUser = { id: 'k1', account: 'admin', nickname: '管理员', stats: {}, achievements: [] };
const keyMember = { id: 'k2', account: 'member', nickname: '成员', stats: {}, achievements: [] };
const keySent = [];
let keySeq = 0;
const keyApi = {
  spaceUserInfo: () => new Map(),
  keysPublic: (space) => space.keys,
  keysStats: (space) => {
    const all = space.keys; const bySecurity = { low: 0, high: 0 };
    for (const k of all) bySecurity[k.security] = (bySecurity[k.security] || 0) + 1;
    const rs = [...space.keyRequests.values()];
    return { total: all.length, bySecurity, borrowed: rs.filter((r) => r.status === 'borrowed').length, pending: rs.filter((r) => r.status === 'pending').length, missing: rs.filter((r) => r.condition === 'missing').length };
  },
  keyRequestsPublic: (space) => [...space.keyRequests.values()],
  broadcast: () => {},
  KEY_CATEGORIES: ['工卡', '钥匙', '门禁卡', '登记薄', '其它'],
  isAdmin: (space, account) => account === 'admin',
  sendTo: (ws, obj) => { keySent.push(obj); },
  serError: (m) => ({ type: 'error', message: m }),
  genId: (prefix) => `${prefix}${keySeq++}`,
  saveEntity: () => {},
  deleteEntity: () => {},
  pushNotification: () => {},
  sendToAccount: () => {},
  getUserByAccount: () => keyMember,
  sendToUser: () => {},
  checkAchievements: () => {},
  saveProfile: () => {},
  broadcastLeaderboard: () => {},
};
const keyModule = keysModule(keyApi);
const keySpace = { id: 's12e', keys: [], keyRequests: new Map(), admins: new Set(['admin']) };
keyModule.handleKeys({}, keyUser, keySpace, { type: 'keyCreate', name: '机房钥匙', category: '钥匙', security: 'high', total: 1 });
const k = keySpace.keys[0];
assert(k, 'keyCreate 创建钥匙');
assertEq(k.security, 'high', '高安全钥匙已保存');
keyModule.handleKeys({}, keyMember, keySpace, { type: 'keyRequest', keyId: k.id, qty: 1 });
const kr = [...keySpace.keyRequests.values()][0];
assertEq(kr.status, 'pending', '高安全钥匙需审批（pending）');
keyModule.handleKeys({}, keyUser, keySpace, { type: 'keyApprove', id: kr.id });
assertEq(kr.status, 'borrowed', '批准后变为在借');
assertEq(kr.approvedBy, 'admin', '审批人已记录');
keyModule.handleKeys({}, keyUser, keySpace, { type: 'keyReturn', id: kr.id, condition: 'missing' });
assertEq(kr.status, 'returned', '钥匙归还后状态为已归还');
assertEq(kr.condition, 'missing', '归还登记丢失');
assertEq(k.total, 0, '丢失后库存总数扣减');
assertEq(keyApi.keysStats(keySpace).missing, 1, 'keysStats 统计丢失数');

// ---------- 冰箱 / 食品 ----------
console.log('\n📋 12f. 冰箱食品管理');
const fridgeSent = [];
let fridgeSeq = 0;
const fridgeApi = {
  spaceUserInfo: () => new Map(),
  fridgeItemsPublic: (space) => space.fridgeItems,
  fridgeStats: (space) => {
    const low = space.fridgeItems.filter((i) => i.available <= i.minAvailable).length;
    const logs = [...space.fridgeLogs.values()];
    return { total: space.fridgeItems.length, low, taken: logs.filter((l) => l.type === 'take').length, restocked: logs.filter((l) => l.type === 'restock').length };
  },
  fridgeLogsPublic: (space) => [...space.fridgeLogs.values()],
  broadcast: () => {},
  isAdmin: (space, account) => account === 'admin',
  sendTo: (ws, obj) => { fridgeSent.push(obj); },
  serError: (m) => ({ type: 'error', message: m }),
  genId: (prefix) => `${prefix}${fridgeSeq++}`,
  saveEntity: () => {},
  deleteEntity: () => {},
  pushNotification: () => {},
  broadcastLeaderboard: () => {},
};
const fridgeModule2 = fridgeModule(fridgeApi);
const fridgeSpace = { id: 's12f', fridgeItems: [], fridgeLogs: new Map() };
fridgeModule2.handleFridge({}, keyUser, fridgeSpace, { type: 'fridgeItemCreate', name: '矿泉水', category: '饮料', total: 6, unit: '瓶', minAvailable: 2 });
const fi = fridgeSpace.fridgeItems[0];
assert(fi, 'fridgeItemCreate 登记物品');
assertEq(fi.available, 6, '初始可用 6');
fridgeModule2.handleFridge({}, keyMember, fridgeSpace, { type: 'fridgeTake', id: fi.id, qty: 4 });
assertEq(fi.available, 2, '取用后可用 2');
assert(fridgeApi.fridgeStats(fridgeSpace).taken >= 1, 'fridgeStats 统计取用');
fridgeModule2.handleFridge({}, keyMember, fridgeSpace, { type: 'fridgeTake', id: fi.id, qty: 3 });
assert(fridgeSent.some((m) => m.message && m.message.includes('不足')), '超量取用被拒');
fridgeModule2.handleFridge({}, keyUser, fridgeSpace, { type: 'fridgeRestock', id: fi.id, qty: 6 });
assertEq(fi.total, 12, '补货后总数增加');
assertEq(fi.available, 8, '补货后可用恢复');

// ---------- 车辆 / 停车位 ----------
console.log('\n📋 12g. 车辆停车位管理');
const parkingSent = [];
let parkingSeq = 0;
const parkingApi = {
  spaceUserInfo: () => new Map(),
  parkingSpotsPublic: (space) => space.parkingSpots,
  parkingStats: (space) => {
    const byType = {}; for (const s of space.parkingSpots) byType[s.type] = (byType[s.type] || 0) + 1;
    const active = [...space.parkingReservations.values()].filter((r) => r.status === 'reserved' || r.status === 'checked_in').length;
    return { total: space.parkingSpots.length, active, byType };
  },
  parkingReservationsPublic: (space) => [...space.parkingReservations.values()],
  broadcast: () => {},
  PARKING_TYPES: ['standard', 'disabled', 'ev', 'reserved'],
  isAdmin: (space, account) => account === 'admin',
  sendTo: (ws, obj) => { parkingSent.push(obj); },
  serError: (m) => ({ type: 'error', message: m }),
  genId: (prefix) => `${prefix}${parkingSeq++}`,
  saveEntity: () => {},
  deleteEntity: () => {},
  pushNotification: () => {},
};
const parkingModule2 = parkingModule(parkingApi);
const parkingSpace = { id: 's12g', parkingSpots: [], parkingReservations: new Map() };
parkingModule2.handleParking({}, keyUser, parkingSpace, { type: 'spotCreate', name: 'B2 充电位', spotType: 'ev', total: 2 });
const pkSpot = parkingSpace.parkingSpots[0];
assert(pkSpot, 'spotCreate 新增车位');
assertEq(pkSpot.available, 2, '初始可用 2');
parkingModule2.handleParking({}, keyMember, parkingSpace, { type: 'spotReserve', spotId: pkSpot.id, date: '2026-10-16', startAt: Date.now() + 86400000, endAt: Date.now() + 86400000 + 3600000, plateNumber: '京A12345' });
const pr = [...parkingSpace.parkingReservations.values()][0];
assert(pr, 'spotReserve 创建预约');
assertEq(pr.status, 'reserved', '预约初始待签到');
assertEq(pkSpot.available, 1, '预约后可用减 1');
parkingModule2.handleParking({}, keyMember, parkingSpace, { type: 'spotCheckin', id: pr.id });
assertEq(pr.status, 'checked_in', '签到后状态为已停放');
parkingModule2.handleParking({}, keyMember, parkingSpace, { type: 'spotCheckout', id: pr.id });
assertEq(pr.status, 'checked_out', '签出后状态为已驶离');
assertEq(pkSpot.available, 2, '签出后可用恢复');
parkingModule2.handleParking({}, keyMember, parkingSpace, { type: 'spotReserve', spotId: pkSpot.id, date: '2026-10-16', startAt: Date.now() + 86400000, endAt: Date.now() + 86400000 + 3600000 });
parkingModule2.handleParking({}, keyMember, parkingSpace, { type: 'spotCancel', id: [...parkingSpace.parkingReservations.values()].pop().id });
assertEq(parkingApi.parkingStats(parkingSpace).active, 0, '取消后活跃归零');

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
spR.repairs.set('r8', { id: 'r8', reporterAccount: 'alice', reporterName: '甲', category: '灯光', priority: 'high', location: '走廊', description: '闪烁', status: 'reported', createdAt: Date.now(), updatedAt: Date.now(), comments: [{ id: 'rc1', account: 'alice', name: '甲', text: '已联系物业', createdAt: Date.now() }] });
const rp = api.repairsPublic(spR, new Map());
assertEq(rp[0].priority, 'high', 'repairsPublic 保留优先级');
assertEq(rp[0].location, '走廊', 'repairsPublic 保留位置');
assertEq(rp[0].commentCount, 1, 'repairsPublic 统计跟进评论数');
assertEq(rp[0].comments[0].text, '已联系物业', 'repairsPublic 暴露跟进评论');
// 已解决报修的满意度字段
spR.repairs.set('r8s', { id: 'r8s', reporterAccount: 'alice', reporterName: '甲', category: '空调', priority: 'normal', location: '会议室', description: '不制冷', status: 'resolved', createdAt: Date.now(), updatedAt: Date.now(), satisfaction: 4, satisfactionComment: '修得很快', satisfiedAt: Date.now() });
const rpS = api.repairsPublic(spR, new Map()).find((r) => r.id === 'r8s');
assertEq(rpS.satisfaction, 4, 'repairsPublic 暴露 satisfaction');
assertEq(rpS.satisfactionComment, '修得很快', 'repairsPublic 暴露 satisfactionComment');
assert(rpS.satisfiedAt > 0, 'repairsPublic 暴露 satisfiedAt');

// ---------- 报修满意度统计 ----------
console.log('\n📋 16b. 报修满意度统计');
const spSt = api.createSpace('s8b', '报修统计空间', 1, 0);
const stBase = Date.now();
spSt.repairs.set('st1', { id: 'st1', category: '灯光', location: '走廊', status: 'resolved', reporterAccount: 'alice', createdAt: stBase, updatedAt: stBase, handledAt: stBase + 600000, satisfaction: 5 });
spSt.repairs.set('st2', { id: 'st2', category: '灯光', location: '走廊', status: 'resolved', reporterAccount: 'bob', createdAt: stBase + 1, updatedAt: stBase + 1, handledAt: stBase + 1 + 1800000, satisfaction: 2 });
spSt.repairs.set('st3', { id: 'st3', category: '空调', location: '会议室', status: 'resolved', reporterAccount: 'carol', createdAt: stBase + 2, updatedAt: stBase + 2, handledAt: stBase + 2 + 1200000, satisfaction: 4 });
spSt.repairs.set('st4', { id: 'st4', category: '厕所', location: '厕所', status: 'reported', reporterAccount: 'dave', createdAt: stBase + 3, updatedAt: stBase + 3 });
const rs = api.repairsStats(spSt);
assertEq(rs.total, 4, 'repairsStats 统计总数');
assertEq(rs.resolved, 3, 'repairsStats 统计已解决数');
assertEq(rs.open, 1, 'repairsStats 统计待处理数');
assertEq(rs.rated, 3, 'repairsStats 统计已评价数');
assertEq(rs.avgSatisfaction, +((5 + 2 + 4) / 3).toFixed(1), 'repairsStats 计算平均满意度');
assertEq(rs.lowSatisfaction, 1, 'repairsStats 统计低分工单（≤2星）');
assertEq(rs.hotspots, [{ location: '走廊', count: 2 }], 'repairsStats 识别高频故障位置');
assertEq(rs.avgHandledMinutes, 20, 'repairsStats 计算平均处理时长');

// ---------- 会议室洞察 ----------
console.log('\n📋 16c. 会议室洞察');
const spRi = api.createSpace('s8c', '会议室洞察空间', 1, 0);
spRi.rooms.push({ id: 'ri1', name: '好评间', capacity: 4 });
spRi.rooms.push({ id: 'ri2', name: '差评间', capacity: 4 });
spRi.rooms.push({ id: 'ri3', name: '无评间', capacity: 4 });
const nowRi = Date.now();
spRi.roomReservations.set('rv1', { id: 'rv1', roomId: 'ri1', ownerAccount: 'alice', startAt: nowRi, endAt: nowRi + 60 * 60000, status: 'completed', rating: 5 });
spRi.roomReservations.set('rv2', { id: 'rv2', roomId: 'ri2', ownerAccount: 'bob', startAt: nowRi, endAt: nowRi + 30 * 60000, status: 'completed', rating: 2 });
spRi.roomReservations.set('rv3', { id: 'rv3', roomId: 'ri2', ownerAccount: 'carol', startAt: nowRi + 60 * 60000, endAt: nowRi + 90 * 60000, status: 'completed', rating: 1 });
const ri = api.roomInsights(spRi, nowRi);
assertEq(ri.ratingRanking.length, 2, 'roomInsights 口碑榜仅包含有评分的会议室');
assertEq(ri.ratingRanking[0].name, '好评间', 'roomInsights 口碑榜按平均分降序');
assertEq(ri.ratingRanking[0].avg, 5, 'roomInsights 口碑榜计算平均分');
assertEq(ri.ratingRanking[1].name, '差评间', 'roomInsights 口碑榜第二名为差评间');
assertEq(ri.usageRanking[0].name, '差评间', 'roomInsights 使用率排行按今日分钟/场次降序');
assertEq(ri.usageRanking[0].todayMinutes, 60, 'roomInsights 使用率排行统计今日分钟');

// ---------- 设备洞察 ----------
console.log('\n📋 16d. 设备洞察');
const spTi = api.createSpace('s8d', '设备洞察空间', 1, 0);
spTi.tools.push({ id: 'ti1', name: '热门机', category: '测试电脑', total: 2, available: 0, location: '', description: '' });
spTi.tools.push({ id: 'ti2', name: '冷门机', category: '测试手机', total: 1, available: 0, location: '', description: '' });
const nowTi = Date.now();
spTi.borrows.set('tiA', { id: 'tiA', toolId: 'ti1', borrowerAccount: 'alice', borrowerName: '甲', qty: 1, borrowedAt: nowTi - 10 * 86400000, dueAt: nowTi - 2 * 86400000, returnedAt: nowTi - 3 * 86400000, status: 'returned', condition: 'intact' });
spTi.borrows.set('tiB', { id: 'tiB', toolId: 'ti1', borrowerAccount: 'bob', borrowerName: '乙', qty: 1, borrowedAt: nowTi - 8 * 86400000, dueAt: nowTi - 1 * 86400000, returnedAt: nowTi - 2 * 86400000, status: 'returned', condition: 'damaged' });
spTi.borrows.set('tiC', { id: 'tiC', toolId: 'ti1', borrowerAccount: 'carol', borrowerName: '丙', qty: 1, borrowedAt: nowTi - 5 * 86400000, dueAt: nowTi - 1 * 86400000, returnedAt: null, status: 'borrowed', condition: 'intact' });
spTi.borrows.set('tiD', { id: 'tiD', toolId: 'ti2', borrowerAccount: 'dave', borrowerName: '丁', qty: 1, borrowedAt: nowTi, dueAt: nowTi + 7 * 86400000, returnedAt: null, status: 'borrowed', condition: 'intact' });
const ti = api.toolInsights(spTi, nowTi);
assertEq(ti.totalBorrows, 4, 'toolInsights 统计累计借用次数');
assertEq(ti.activeCount, 2, 'toolInsights 统计在借数量');
assertEq(ti.overdueCount, 1, 'toolInsights 统计逾期数量');
assertEq(ti.returnConditions, { intact: 1, damaged: 1, missing: 0 }, 'toolInsights 统计归还状态分布');
assertEq(ti.damagedRate, 50, 'toolInsights 计算损坏率 50%');
assertEq(ti.missingRate, 0, 'toolInsights 计算丢失率 0%');
assertEq(ti.borrowHeat[0].name, '热门机', 'toolInsights 热度榜第一名为热门机');
assertEq(ti.borrowHeat[0].borrowCount, 3, 'toolInsights 热度榜统计累计借用次数');
assertEq(ti.borrowHeat[0].activeCount, 1, 'toolInsights 热度榜统计在借数');

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

// ---------- 我的日程 ----------
console.log('\n📋 21b. 我的日程');
const spSch = api.createSpace('s13b', '日程空间', 1, 0);
const nowS = Date.now();
spSch.rooms.push({ id: 'rm1', name: '大会议室', location: '3F', capacity: 10 });
spSch.desks.push({ id: 'ds1', name: '工位A' });
spSch.roomReservations.set('rs1', { id: 'rs1', roomId: 'rm1', ownerAccount: 'alice', startAt: nowS + 3600000, endAt: nowS + 7200000, status: 'pending', title: '评审' });
spSch.roomReservations.set('rs2', { id: 'rs2', roomId: 'rm1', ownerAccount: 'alice', startAt: nowS - 3600000, endAt: nowS, status: 'pending', title: '已过会议' });
spSch.roomReservations.set('rs3', { id: 'rs3', roomId: 'rm1', ownerAccount: 'bob', startAt: nowS + 7200000, endAt: nowS + 10800000, status: 'pending', title: '别人会议' });
spSch.deskReservations.set('rd1', { id: 'rd1', deskId: 'ds1', account: 'alice', startAt: nowS + 10800000, endAt: nowS + 14400000, status: 'pending' });
spSch.events.set('ev1', { id: 'ev1', hostAccount: 'alice', title: '团建', startAt: nowS + 1800000, endAt: nowS + 2160000, location: '操场', rsvps: new Map() });
spSch.events.set('ev2', { id: 'ev2', hostAccount: 'bob', title: '分享会', startAt: nowS + 14400000, endAt: nowS + 18000000, rsvps: new Map([['alice', 'going']]) });
spSch.leaves.set('lv1', { id: 'lv1', account: 'alice', category: '年假', startAt: nowS + 21600000, endAt: nowS + 86400000 + 21600000, status: 'approved' });
spSch.leaves.set('lv2', { id: 'lv2', account: 'alice', category: '调休', startAt: nowS + 21600000, endAt: nowS + 86400000 + 21600000, status: 'pending' });
const sch = api.buildMySchedule(spSch, { account: 'alice' }, 7);
assertEq(sch.days, 7, '我的日程返回 7 天');
const schIds = sch.items.map((i) => i.id);
assertEq(schIds, ['ev1', 'rs1', 'rd1', 'ev2', 'lv1'], '我的日程按开始时间排序并聚合');
assert(!schIds.includes('rs2'), '已过期会议不进入日程');
assert(!schIds.includes('rs3'), '他人会议不进入我的日程');
assert(!schIds.includes('lv2'), '未批准请假不进入日程');
const schType = { ev1: 'event', rs1: 'meeting', rd1: 'desk', ev2: 'event', lv1: 'leave' };
for (const it of sch.items) assertEq(it.type, schType[it.id], '日程类型 ' + it.id + ' 正确');

// ---------- 空间共享日历 ----------
console.log('\n📋 21c. 空间共享日历');
const spCal = api.createSpace('s13c', '日历空间', 1, 0);
spCal.rooms.push({ id: 'rm1', name: '大会议室' });
spCal.desks.push({ id: 'ds1', name: '工位A' });
const calDay = (d) => new Date(2026, 9, d).getTime();
spCal.roomReservations.set('cr1', { id: 'cr1', roomId: 'rm1', ownerAccount: 'alice', startAt: calDay(5), endAt: calDay(5) + 3600000, status: 'pending', title: '评审' });
spCal.roomReservations.set('cr2', { id: 'cr2', roomId: 'rm1', ownerAccount: 'bob', startAt: calDay(12), endAt: calDay(12) + 3600000, status: 'cancelled', title: '取消会' });
spCal.deskReservations.set('cd1', { id: 'cd1', deskId: 'ds1', account: 'alice', startAt: calDay(8), endAt: calDay(8) + 7200000, status: 'pending' });
spCal.events.set('cev1', { id: 'cev1', hostAccount: 'alice', title: '团建', startAt: calDay(20), endAt: calDay(20) + 7200000, rsvps: new Map() });
spCal.leaves.set('clv1', { id: 'clv1', account: 'alice', category: '年假', startAt: calDay(25), endAt: calDay(26), status: 'approved' });
const oct = api.buildSpaceCalendar(spCal, 2026, 10);
assertEq(oct.year, 2026, '空间日历返回年份');
assertEq(oct.month, 10, '空间日历返回月份');
const calDays = oct.days.filter((x) => x && x.items.length);
assertEq(calDays.map((x) => x.day), [5, 8, 20, 25], '空间日历按天聚合');
const calIds = calDays.flatMap((x) => x.items.map((i) => i.id));
assert(calIds.includes('cr1'), '空间日历包含会议室预约');
assert(!calIds.includes('cr2'), '已取消预约不进入空间日历');
assert(calIds.includes('cd1') && calIds.includes('cev1') && calIds.includes('clv1'), '空间日历聚合工位/活动/请假');
assertEq(oct.totals.meeting, 1, '空间日历统计会议数');
assertEq(oct.totals.desk, 1, '空间日历统计工位数');

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

// ---------- 会议室审批催办 ----------
console.log('\n📋 23b. 会议室审批催办');
const spApproval = api.createSpace('s15b', '审批催办空间', 1, 0);
const nowApproval = 1000000000;
const SLA = api.ROOM_APPROVAL_SLA_MS;
spApproval.roomReservations.set('ar1', { id: 'ar1', roomId: 'rm1', ownerAccount: 'alice', title: '旧单', startAt: nowApproval + 60000, endAt: nowApproval + 3600000, status: 'pending_approval', createdAt: nowApproval - SLA, approvalRemindedAt: null });
spApproval.roomReservations.set('ar2', { id: 'ar2', roomId: 'rm1', ownerAccount: 'bob', title: '新单', startAt: nowApproval + 60000, endAt: nowApproval + 3600000, status: 'pending_approval', createdAt: nowApproval, approvalRemindedAt: null });
spApproval.roomReservations.set('ar3', { id: 'ar3', roomId: 'rm1', ownerAccount: 'carol', title: '已催', startAt: nowApproval + 60000, endAt: nowApproval + 3600000, status: 'pending_approval', createdAt: nowApproval - SLA, approvalRemindedAt: nowApproval - 1000 });
spApproval.roomReservations.set('ar4', { id: 'ar4', roomId: 'rm1', ownerAccount: 'dave', title: '普通', startAt: nowApproval + 60000, endAt: nowApproval + 3600000, status: 'pending', createdAt: nowApproval, approvalRemindedAt: null });
const apprRem = api.dueRoomApprovalReminders(spApproval, nowApproval);
assertEq(apprRem.map((r) => r.id), ['ar1'], '仅返回超过 SLA 且未催办过的待审批预约');
assertEq(api.ROOM_APPROVAL_SLA_MS, 24 * 3600 * 1000, '审批催办 SLA 为 24 小时');

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

// ---------- 请假审批 SLA 超时提醒 ----------
console.log('\n📋 27b. 请假审批 SLA 超时提醒');
const spLeave = api.createSpace('s19b', '请假 SLA 空间', 1, 0);
const nowLeave = 1000000000;
const lSla = api.LEAVE_APPROVAL_SLA_MS;
spLeave.leaves.set('lv1', { id: 'lv1', account: 'alice', name: '甲', category: '事假', reason: '家中有事', startAt: nowLeave + 86400000, endAt: nowLeave + 2 * 86400000, status: 'pending', createdAt: nowLeave - lSla, decidedAt: null, decidedBy: null, decideNote: '', slaRemindedAt: null });
spLeave.leaves.set('lv2', { id: 'lv2', account: 'bob', name: '乙', category: '病假', reason: '', startAt: nowLeave + 86400000, endAt: nowLeave + 2 * 86400000, status: 'pending', createdAt: nowLeave - lSla + 1, decidedAt: null, decidedBy: null, decideNote: '', slaRemindedAt: null });
spLeave.leaves.set('lv3', { id: 'lv3', account: 'carol', name: '丙', category: '年假', reason: '', startAt: nowLeave + 86400000, endAt: nowLeave + 2 * 86400000, status: 'pending', createdAt: nowLeave - lSla, decidedAt: null, decidedBy: null, decideNote: '', slaRemindedAt: nowLeave - 1000 });
spLeave.leaves.set('lv4', { id: 'lv4', account: 'dave', name: '丁', category: '调休', reason: '', startAt: nowLeave + 86400000, endAt: nowLeave + 2 * 86400000, status: 'approved', createdAt: nowLeave - lSla, decidedAt: nowLeave, decidedBy: 'admin', decideNote: '', slaRemindedAt: null });
const leaveSlaRem = api.dueLeaveSlaReminders(spLeave, nowLeave);
assertEq(leaveSlaRem.map((r) => r.id), ['lv1'], '仅返回超时且未提醒过的待审批请假');
assertEq(api.LEAVE_APPROVAL_SLA_MS, 24 * 3600 * 1000, '请假审批 SLA 为 24 小时');
const leavePub = api.leavesPublic(spLeave, new Map());
assertEq(leavePub[0].slaRemindedAt, null, 'leavesPublic 暴露 slaRemindedAt');

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
  auditLog: () => {},
  auditLogsPublic: () => [],
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
spRoomRate.rooms.push({ id: 'rm1', name: '会议室A', capacity: 8, location: '3F', description: '', tags: ['投影', '白板'] });
const nowRate = 1000000000;
spRoomRate.roomReservations.set('rr1', { id: 'rr1', roomId: 'rm1', ownerAccount: 'alice', ownerName: '甲', title: '评审', startAt: nowRate - 120000, endAt: nowRate - 60000, status: 'completed', rating: 5, ratingComment: '很好', ratedAt: nowRate - 50000, ratings: { environment: 5, equipment: 5, service: 4 } });
spRoomRate.roomReservations.set('rr2', { id: 'rr2', roomId: 'rm1', ownerAccount: 'bob', ownerName: '乙', title: '周会', startAt: nowRate - 240000, endAt: nowRate - 180000, status: 'completed', rating: 3, ratingComment: '', ratedAt: nowRate - 170000, ratings: { environment: 4, equipment: 2, service: 3 } });
spRoomRate.roomReservations.set('rr3', { id: 'rr3', roomId: 'rm1', ownerAccount: 'carol', ownerName: '丙', title: '讨论', startAt: nowRate - 300000, endAt: nowRate - 240000, status: 'completed', rating: 0, ratingComment: '', ratedAt: 0 });
spRoomRate.roomReservations.set('rr4', { id: 'rr4', roomId: 'rm1', ownerAccount: 'dave', ownerName: '丁', title: '未评', startAt: nowRate, endAt: nowRate + 60000, status: 'active', rating: 0, ratingComment: '', ratedAt: 0 });
const roomRateSum = api.roomRatingSummary(spRoomRate, 'rm1');
assertEq(roomRateSum.count, 2, '仅统计已评分的已完成会议');
assertEq(roomRateSum.avg, 4, '会议室平均评分 4 分');
assertEq(roomRateSum.dimensions.environment.avg, 4.5, '环境维度平均 4.5 分');
assertEq(roomRateSum.dimensions.equipment.avg, 3.5, '设备维度平均 3.5 分');
assertEq(roomRateSum.dimensions.service.avg, 3.5, '服务维度平均 3.5 分');
assertEq(roomRateSum.dimensions.environment.count, 2, '环境维度计数 2');
assertEq(roomRateSum.ratings.length, 2, '评分明细返回 2 条');
assertEq(api.roomPublic(spRoomRate, spRoomRate.rooms[0]).rating.avg, 4, 'roomPublic 暴露会议室平均评分');
assertEq(api.roomPublic(spRoomRate, spRoomRate.rooms[0]).tags.length, 2, 'roomPublic 暴露会议室标签');
assertEq(api.roomPublic(spRoomRate, spRoomRate.rooms[0]).minMinutes, 5, 'roomPublic 默认最短预约时长 5 分钟');
assertEq(api.roomPublic(spRoomRate, spRoomRate.rooms[0]).maxMinutes, 720, 'roomPublic 默认最长预约时长 720 分钟');
spRoomRate.rooms[0].equipment = ['投影', '白板'];
spRoomRate.rooms[0].maintenanceUntil = null;
const roomPub = api.roomPublic(spRoomRate, spRoomRate.rooms[0]);
assertEq(roomPub.equipment, ['投影', '白板'], 'roomPublic 暴露会议室设备清单');
assertEq(roomPub.maintenance, false, 'roomPublic 无维护截止时 maintenance=false');
const maintUntil = Date.now() + 3600000;
spRoomRate.rooms[0].maintenanceUntil = maintUntil;
const roomPubMaint = api.roomPublic(spRoomRate, spRoomRate.rooms[0]);
assertEq(roomPubMaint.maintenanceUntil, maintUntil, 'roomPublic 暴露维护截止时间');
assertEq(roomPubMaint.maintenance, true, 'roomPublic 维护期内 maintenance=true');
const resRatePub = api.reservationPublic(spRoomRate.roomReservations.get('rr1'), new Map());
assertEq(resRatePub.rating, 5, 'reservationPublic 暴露评分');
assertEq(resRatePub.ratedAt, nowRate - 50000, 'reservationPublic 暴露评分时间');
spRoomRate.roomReservations.get('rr1').equipment = ['投影', '白板'];
assertEq(api.reservationPublic(spRoomRate.roomReservations.get('rr1'), new Map()).equipment, ['投影', '白板'], 'reservationPublic 暴露预约设备清单');

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
// 用本地时间构造，避免 CI runner 时区差异导致 isLateAt / todayKey 判定漂移
const todayD = new Date(2026, 9, 16, 9, 5, 0, 0);
assertEq(api.todayKey(todayD.getTime()), '2026-10-16', 'todayKey 返回 YYYY-MM-DD');
const cfgA = api.newAttendanceConfig();
assertEq(cfgA.workStart, '09:00', '考勤默认上班时间 09:00');
assertEq(cfgA.workEnd, '18:00', '考勤默认下班时间 18:00');
assertEq(cfgA.lateMinutes, 15, '考勤默认迟到宽限 15 分钟');
assertEq(api.parseTime('09:05'), 545, 'parseTime 解析 HH:MM 为分钟');
assertEq(api.parseTime('bad'), null, 'parseTime 非法格式返回 null');
// 09:00 上班、宽限 15 分钟：09:15 已迟到（>= 宽限）
const localDay = new Date(2026, 9, 16, 0, 0, 0, 0).getTime();
const nine = localDay + 9 * 3600000;
const at9 = localDay + 9 * 3600000;
const at915 = localDay + 9 * 3600000 + 15 * 60000;
const at916 = localDay + 9 * 3600000 + 16 * 60000;
assertEq(api.isLateAt(at9, cfgA), false, '09:00 打卡不迟到');
assertEq(api.isLateAt(at915, cfgA), true, '09:15 打卡已迟到（宽限 15 分钟）');
assertEq(api.isLateAt(at916, cfgA), true, '09:16 打卡已迟到');
const spA = api.createSpace('s29', '考勤空间', 1, 0);
const nowA = localDay + 12 * 3600000;
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
kbSp.knowledge.set('kb1', { id: 'kb1', title: 'A4 纸在哪', content: '打印区右侧柜子', category: '操作指引', tags: ['打印'], authorAccount: 'alice', authorName: '甲', likes: ['alice', 'bob'], comments: [{ id: 'cm1', account: 'bob', name: '乙', text: '谢谢', createdAt: 5 }, { id: 'cm2', account: 'alice', name: '甲', text: '不客气', createdAt: 6, parentId: 'cm1', parentAccount: 'bob', parentName: '乙' }], createdAt: 1, updatedAt: 2 });
kbSp.knowledge.set('kb2', { id: 'kb2', title: '会议室规则', content: '用完关灯', category: '规章制度', tags: [], authorAccount: 'bob', authorName: '乙', likes: [], comments: [], createdAt: 3, updatedAt: 4 });
const kbPub = api.knowledgePublic(kbSp, api.spaceUserInfo(kbSp.id), { account: 'alice' });
assertEq(kbPub.length, 2, 'knowledgePublic 返回全部文章');
assertEq(kbPub[0].title, 'A4 纸在哪', 'knowledgePublic 按点赞数排序');
assertEq(kbPub[0].likeCount, 2, 'knowledgePublic 统计点赞数');
assertEq(kbPub[0].liked, true, 'knowledgePublic 标记本人已赞');
assertEq(kbPub[1].liked, false, 'knowledgePublic 未点赞为 false');
assertEq(kbPub[0].commentCount, 2, 'knowledgePublic 统计评论数');
assertEq(kbPub[0].comments[0].account, 'alice', 'knowledgePublic 评论倒序最新在前');
assertEq(kbPub[0].comments[0].parentId, 'cm1', 'knowledgePublic 暴露回复 parentId');
assertEq(kbPub[0].comments[0].parentName, '乙', 'knowledgePublic 暴露回复 parentName');
assertEq(kbPub[0].comments[1].account, 'bob', 'knowledgePublic 顶级评论无 parentId');
assertEq(kbPub[0].comments[1].parentId, null, '顶级评论 parentId 为 null');
const kbSt = api.knowledgeStats(kbSp);
assertEq(kbSt.total, 2, 'knowledgeStats 统计文章数');
assertEq(kbSt.liked, 2, 'knowledgeStats 统计点赞总数');
assertEq(kbSt.comments, 2, 'knowledgeStats 统计评论总数');

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

// ---------- 待办任务序列化 + 统计 ----------
console.log('\n📋 47. 待办任务序列化 / 统计');
const tkSp = api.createSpace('s48', '任务空间', 1, 0);
tkSp.tasks.set('tk1', { id: 'tk1', title: '整理周报', description: '周五前', creatorAccount: 'alice', creatorName: '甲', assigneeAccount: 'bob', assigneeName: '乙', priority: 'high', status: 'pending', dueAt: 2000, completedAt: null, createdAt: 1, updatedAt: 2, comments: [{ id: 'tc1', account: 'bob', name: '乙', text: '已完成初稿', createdAt: 6 }] });
tkSp.tasks.set('tk2', { id: 'tk2', title: '买电池', description: '', creatorAccount: 'bob', creatorName: '乙', assigneeAccount: '', assigneeName: '', priority: 'normal', status: 'in_progress', dueAt: null, completedAt: null, createdAt: 3, updatedAt: 4 });
const tkPub = api.tasksPublic(tkSp, api.spaceUserInfo(tkSp.id), { account: 'bob' });
assertEq(tkPub.length, 2, 'tasksPublic 返回任务');
assertEq(tkPub[0].id, 'tk1', 'tasksPublic 按优先级排序');
assertEq(tkPub[0].myAssignee, true, 'tasksPublic 标记本人为负责人');
assertEq(tkPub[1].myCreator, true, 'tasksPublic 标记本人为创建人');
assertEq(tkPub[0].myTask, true, 'tasksPublic 标记本人相关任务');
assertEq(tkPub[0].commentCount, 1, 'tasksPublic 统计评论数');
assertEq(tkPub[0].comments[0].text, '已完成初稿', 'tasksPublic 暴露评论');
assertEq(tkPub[1].commentCount, 0, '无评论任务评论数为 0');
const tkSt = api.taskStats(tkSp);
assertEq(tkSt.total, 2, 'taskStats 统计总数');
assertEq(tkSt.pending, 1, 'taskStats 统计待办');
assertEq(tkSt.in_progress, 1, 'taskStats 统计进行中');
assertEq(tkSt.open, 1, 'taskStats 统计开放认领');

// ---------- 通知中心序列化 ----------
console.log('\n📋 48. 通知中心序列化');
const ntSp = api.createSpace('s49', '通知空间', 1, 0);
ntSp.notifications.set('nt1', { id: 'nt1', type: 'taskAssigned', level: 'info', title: '任务指派', body: '测试', createdAt: 1, readBy: { alice: true } });
ntSp.notifications.set('nt2', { id: 'nt2', type: 'materialFulfilled', level: 'success', title: '已满足', body: '', createdAt: 2, readBy: {} });
const ntPub = api.notificationsPublic(ntSp, { account: 'alice' });
assertEq(ntPub.notifications.length, 2, 'notificationsPublic 返回通知');
assertEq(ntPub.notifications[0].id, 'nt2', 'notificationsPublic 按时间倒序');
assertEq(ntPub.notifications[0].read, false, 'notificationsPublic 标记未读');
assertEq(ntPub.unreadCount, 1, 'notificationsPublic 统计未读数');

// ---------- 考勤连续打卡 / 日历 ----------
console.log('\n📋 49. 考勤连续打卡 / 日历');
const stSp = api.createSpace('s50', '考勤空间', 1, 0);
const base = new Date('2026-10-01T10:00:00+08:00').getTime();
for (let i = 2; i >= 0; i--) {
  const day = new Date(base); day.setDate(day.getDate() - i);
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  stSp.attendance.set('alice::' + date, { id: 'a' + i, account: 'alice', name: '甲', date, checkInAt: day.getTime(), checkOutAt: null, isLate: false, status: 'checked_in', workedMinutes: 0 });
}
assertEq(api.attendanceStreak(stSp, 'alice', base), 3, 'attendanceStreak 连续 3 天');
const st2Sp = api.createSpace('s51', '考勤空间2', 1, 0);
for (let i = 2; i >= 1; i--) {
  const day = new Date(base); day.setDate(day.getDate() - i);
  const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  st2Sp.attendance.set('alice::' + date, { id: 'b' + i, account: 'alice', name: '甲', date, checkInAt: day.getTime(), checkOutAt: null, isLate: false, status: 'checked_in', workedMinutes: 0 });
}
assertEq(api.attendanceStreak(st2Sp, 'alice', base), 2, '今天未打卡回退到昨天连续');
const calSp = api.createSpace('s52', '日历空间', 1, 0);
const calBase = new Date('2026-10-10T10:00:00+08:00').getTime();
for (let day = 1; day <= 10; day++) {
  const d = new Date('2026-10-01T10:00:00+08:00'); d.setDate(day);
  const date = `2026-10-${String(day).padStart(2, '0')}`;
  calSp.attendance.set('bob::' + date, { id: 'c' + day, account: 'bob', name: '乙', date, checkInAt: d.getTime(), checkOutAt: null, isLate: day % 3 === 0, status: 'checked_in', workedMinutes: 0 });
}
const cal = api.attendanceCalendar(calSp, 'bob', 2026, 10, calBase);
assert(Array.isArray(cal.cells), 'attendanceCalendar 返回日历网格');
assertEq(cal.streak, 10, 'attendanceCalendar 连续 10 天');
assertEq(cal.perfectMonthCount, 0, '有迟到时全勤月为 0');
assertEq(cal.currentMonthPerfect, false, '本月有迟到非全勤');

// ---------- 请假审批序列化 + 统计 ----------
console.log('\n📋 50. 请假审批序列化 / 统计');
const lvSp = api.createSpace('lv', '请假空间', 1, 0);
const lvNow = new Date('2026-10-15T10:00:00+08:00').getTime();
lvSp.leaves.set('lv1', { id: 'lv1', account: 'alice', name: '甲', category: '病假', reason: '发烧', startAt: lvNow + 86400000, endAt: lvNow + 172800000, status: 'pending', createdAt: 10, decidedAt: null, decidedBy: null, decideNote: '' });
lvSp.leaves.set('lv2', { id: 'lv2', account: 'bob', name: '乙', category: '年假', reason: '休息', startAt: lvNow + 259200000, endAt: lvNow + 345600000, status: 'approved', createdAt: 30, decidedAt: 40, decidedBy: 'admin', decideNote: '' });
lvSp.leaves.set('lv3', { id: 'lv3', account: 'carol', name: '丙', category: '事假', reason: '搬家', startAt: lvNow, endAt: lvNow + 3600000, status: 'rejected', createdAt: 50, decidedAt: 60, decidedBy: 'admin', decideNote: '时段冲突' });
const lvPub = api.leavesPublic(lvSp, api.spaceUserInfo(lvSp.id), lvNow);
assertEq(lvPub.length, 3, 'leavesPublic 返回请假记录');
assertEq(lvPub[0].id, 'lv3', 'leavesPublic 按创建时间倒序');
assertEq(lvPub[0].status, 'rejected', 'leavesPublic 暴露状态');
assertEq(lvPub[0].decideNote, '时段冲突', 'leavesPublic 暴露驳回原因');
assertEq(lvPub[1].decidedBy, 'admin', 'leavesPublic 暴露审批人');
assertEq(lvPub[1].status, 'approved', 'leavesPublic 暴露已批准状态');
const lvSt = api.leavesStats(lvSp, lvNow);
assertEq(lvSt.pendingCount, 1, 'leavesStats 统计待审批');
assertEq(lvSt.approvedCount, 1, 'leavesStats 统计已批准');
assertEq(lvSt.rejectedCount, 1, 'leavesStats 统计已驳回');
assertEq(lvSt.todayCount, 1, 'leavesStats 统计今日开始数');

// ---------- 会议纪要序列化 + 统计 ----------
console.log('\n📋 51. 会议纪要序列化 / 统计');
const mnSp = api.createSpace('mn', '会议纪要空间', 1, 0);
const mnNow = new Date('2026-10-15T10:00:00+08:00').getTime();
mnSp.rooms.push({ id: 'rm1', name: '大会议室', capacity: 10 });
mnSp.roomReservations.set('rv1', { id: 'rv1', roomId: 'rm1', ownerAccount: 'alice', ownerName: '甲', title: '周会', startAt: mnNow, endAt: mnNow + 3600000, status: 'completed' });
mnSp.meetingNotes.set('mn1', { id: 'mn1', reservationId: 'rv1', title: '周会议纪要', content: '同步需求', account: 'bob', name: '乙', createdAt: mnNow, updatedAt: mnNow });
mnSp.meetingNotes.set('mn2', { id: 'mn2', reservationId: 'rv1', title: '', content: '纪要二', account: 'carol', name: '丙', createdAt: mnNow - 1000, updatedAt: mnNow + 1000 });
const mnPub = api.meetingNotesPublic(mnSp, api.spaceUserInfo(mnSp.id), mnNow);
assertEq(mnPub.length, 2, 'meetingNotesPublic 返回会议纪要');
assertEq(mnPub[0].id, 'mn2', 'meetingNotesPublic 按更新时间倒序');
assertEq(mnPub[0].reservationTitle, '周会', 'meetingNotesPublic 关联会议标题');
assertEq(mnPub[0].roomName, '大会议室', 'meetingNotesPublic 关联会议室');
const mnSt = api.meetingNotesStats(mnSp, mnNow);
assertEq(mnSt.total, 2, 'meetingNotesStats 统计总数');
assertEq(mnSt.todayCount, 2, 'meetingNotesStats 统计今日更新');

// ---------- 值班排班序列化与统计 ----------
console.log('\n📋 51b. 值班排班序列化 / 统计');
const spDuty = api.createSpace('duty', '值班空间', 1, 0);
const dutyNow = new Date('2026-10-16T10:00:00+08:00').getTime();
const dutyToday = api.todayKey(dutyNow);
const dutyTomorrow = api.todayKey(dutyNow + 86400000);
spDuty.duties.set('d1', { id: 'd1', date: dutyToday, account: 'alice', name: '甲', category: '环境', note: '倒垃圾', status: 'assigned', createdAt: dutyNow, completedAt: null, reminderAt: null });
spDuty.duties.set('d2', { id: 'd2', date: dutyToday, account: 'bob', name: '乙', category: '接待', note: '', status: 'completed', createdAt: dutyNow - 1000, completedAt: dutyNow, reminderAt: dutyToday });
spDuty.duties.set('d3', { id: 'd3', date: dutyTomorrow, account: 'carol', name: '丙', category: '值班', note: '', status: 'assigned', createdAt: dutyNow, completedAt: null, reminderAt: null });
const duPub = api.dutiesPublic(spDuty, api.spaceUserInfo(spDuty.id), dutyNow);
assertEq(duPub.length, 3, 'dutiesPublic 返回全部值班');
assertEq(duPub.find((r) => r.id === 'd2').status, 'completed', 'dutiesPublic 暴露已完成状态');
assertEq(duPub.find((r) => r.id === 'd1').isToday, true, 'dutiesPublic 标记今日值班');
const duSt = api.dutyStats(spDuty, dutyNow);
assertEq(duSt.todayCount, 2, 'dutyStats 统计今日值班数');
assertEq(duSt.todayCompleted, 1, 'dutyStats 统计今日已完成数');
assertEq(duSt.upcomingCount, 1, 'dutyStats 统计未来值班数');
const reminds = api.dueDutyReminders(spDuty, dutyNow);
assertEq(reminds.length, 1, 'dueDutyReminders 仅返回今日未完成且未提醒的值班');
// 值日达人成就
const dutyUser = { stats: api.newStats(), achievements: [] };
dutyUser.stats.dutyCount = 5;
api.checkAchievements(dutyUser);
assert(dutyUser.achievements.includes('dutyMaker'), '完成值班 5 次解锁值日达人');

// ---------- 新成就 ----------
console.log('\n📋 52. 待办任务 / 连续打卡成就');
const achUser5 = { stats: api.newStats(), achievements: [] };
achUser5.stats.taskCreateCount = 5; achUser5.stats.taskDoneCount = 5;
api.checkAchievements(achUser5);
assert(achUser5.achievements.includes('taskMaker'), '创建任务 5 次解锁任务达人');
assert(achUser5.achievements.includes('taskDoer'), '完成任务 5 次解锁高效执行');
achUser5.stats.attendanceStreak = 7;
api.checkAchievements(achUser5);
assert(achUser5.achievements.includes('streakKnight'), '连续打卡 7 天解锁连续打卡达人');

// ---------- 邀请码与审计日志 ----------
console.log('\n📋 53. 邀请码与审计日志');
const invSp = api.createSpace('inv', '邀请空间', 1, 0);
const invAdmin = { account: 'alice', nickname: '甲' };
const inv1 = api.createInvite(invSp, { reusable: false, maxUses: 2, createdBy: '甲' });
assert(inv1.code && /^[A-Z0-9]{6}$/.test(inv1.code), 'createInvite 生成 6 位邀请码');
assertEq(inv1.status, 'active', '新邀请码状态为 active');
assertEq(api.invitesPublic(invSp)[0].status, 'active', 'invitesPublic 暴露邀请码状态');
assertEq(api.useInvite(invSp, inv1.code.toLowerCase(), 'bob').ok, true, 'useInvite 接受大写邀请码');
assertEq(api.useInvite(invSp, inv1.code, 'carol').ok, true, '一次性邀请码第二次使用仍有效');
assertEq(api.useInvite(invSp, inv1.code, 'dave').ok, false, '超过最大使用次数后拒绝');
assertEq(api.invitesPublic(invSp)[0].status, 'exhausted', '用完后状态为 exhausted');
const invReuse = api.createInvite(invSp, { reusable: true, maxUses: 1, createdBy: '甲' });
assertEq(api.useInvite(invSp, invReuse.code, 'bob').ok, true, '可重复邀请码可用');
assertEq(api.useInvite(invSp, invReuse.code, 'bob').ok, true, '可重复邀请码可多次使用');
const invExpired = api.createInvite(invSp, { reusable: false, maxUses: 1, expiresAt: Date.now() - 1000, createdBy: '甲' });
assertEq(api.useInvite(invSp, invExpired.code, 'bob').ok, false, '过期邀请码拒绝使用');
assertEq(api.invitesPublic(invSp, Date.now()).find((i) => i.id === invExpired.id).status, 'expired', '过期状态为 expired');
const revOk = api.revokeInvite(invSp, invReuse.id);
assert(revOk && revOk.revokedAt, 'revokeInvite 撤销邀请码');
assertEq(api.useInvite(invSp, invReuse.code, 'bob').ok, false, '已撤销邀请码拒绝使用');
assertEq(api.auditLog(invSp, invAdmin, '创建邀请码', inv1.code).action, '创建邀请码', 'auditLog 写入管理日志');
assertEq(api.auditLogsPublic(invSp, 10).length, 1, 'auditLogsPublic 返回管理日志');

// ---------- 包裹 / 快递管理 ----------
console.log('\n📋 55. 包裹 / 快递管理');
const parcelSent = [];
let parcelSeq = 0;
const parcelApi = {
  spaceUserInfo: () => new Map([['bob', { display: '乙' }]]),
  parcelsPublic: (space) => [...space.parcels.values()],
  parcelStats: (space) => ({
    total: space.parcels.size,
    incoming: [...space.parcels.values()].filter((p) => p.status === 'incoming').length,
    picked: [...space.parcels.values()].filter((p) => p.status === 'picked').length,
    returned: [...space.parcels.values()].filter((p) => p.status === 'returned').length,
    cancelled: [...space.parcels.values()].filter((p) => p.status === 'cancelled').length,
    overdue: 0,
  }),
  parcelsBroadcast: () => {},
  broadcast: () => {},
  isAdmin: (space, account) => account === 'admin',
  sendTo: (ws, obj) => { parcelSent.push(obj); },
  serError: (m) => ({ type: 'error', message: m }),
  genId: () => `pc${parcelSeq++}`,
  saveEntity: () => {},
  deleteEntity: () => {},
  pushNotification: () => {},
  sendToAccount: () => {},
  spaceId: 's55',
};
const parcelsModule2 = parcelsModule(parcelApi);
const parcelSpace = { id: 's55', parcels: new Map() };
parcelsModule2.handleParcels({}, { account: 'admin' }, parcelSpace, { type: 'parcelCreate', recipientAccount: 'bob', courier: '顺丰', trackingNumber: 'SF123' });
const pc1 = [...parcelSpace.parcels.values()][0];
assert(pc1 && pc1.status === 'incoming', 'parcelCreate 登记包裹为待取');
assertEq(pc1.courier, '顺丰', '包裹记录快递公司');
parcelsModule2.handleParcels({}, { account: 'admin' }, parcelSpace, { type: 'parcelCreate', recipientAccount: 'carol', courier: '圆通' });
assert(parcelSent.some((m) => m.message && m.message.includes('收件人不在')), '非空间成员发件被拒');
parcelsModule2.handleParcels({}, { account: 'user' }, parcelSpace, { type: 'parcelCreate', recipientAccount: 'bob', courier: '中通' });
assert(parcelSent.some((m) => m.message && m.message.includes('仅管理员')), '非管理员登记包裹被拒');
parcelsModule2.handleParcels({}, { account: 'admin' }, parcelSpace, { type: 'parcelPick', id: pc1.id });
assertEq(pc1.status, 'picked', 'admin 可代领包裹');
const pc2 = { id: 'pcX', recipientAccount: 'bob', courier: '韵达', status: 'incoming', expectedAt: Date.now(), lastRemindedAt: 0 };
parcelSpace.parcels.set(pc2.id, pc2);
parcelsModule2.handleParcels({}, { account: 'admin' }, parcelSpace, { type: 'parcelReturn', id: pc2.id });
assertEq(pc2.status, 'returned', '管理员标记退回');
const pc3 = { id: 'pcY', recipientAccount: 'bob', courier: '京东', status: 'incoming', lastRemindedAt: 0 };
parcelSpace.parcels.set(pc3.id, pc3);
parcelsModule2.handleParcels({}, { account: 'admin' }, parcelSpace, { type: 'parcelCancel', id: pc3.id });
assertEq(pc3.status, 'cancelled', '管理员取消包裹');
assertEq(parcelApi.parcelStats(parcelSpace).picked, 1, 'parcelStats 统计已取');
assertEq(parcelApi.parcelStats(parcelSpace).cancelled, 1, 'parcelStats 统计取消');

// ---------- 储物柜 / 寄存管理 ----------
console.log('\n📋 56. 储物柜 / 寄存管理');
const lockerSent = [];
let lockerSeq = 0;
const lockerApi = {
  spaceUserInfo: () => new Map([['alice', { display: '甲' }], ['bob', { display: '乙' }]]),
  lockersPublic: (space) => space.lockers,
  lockerStats: (space) => ({
    total: space.lockers.length,
    active: [...space.lockerReservations.values()].filter((r) => r.status === 'reserved' || r.status === 'checked_in').length,
    byType: {},
  }),
  lockerReservationsPublic: (space) => [...space.lockerReservations.values()],
  lockersBroadcast: () => {},
  broadcast: () => {},
  isAdmin: (space, account) => account === 'admin',
  sendTo: (ws, obj) => { lockerSent.push(obj); },
  serError: (m) => ({ type: 'error', message: m }),
  genId: () => `lk${lockerSeq++}`,
  saveEntity: () => {},
  deleteEntity: () => {},
  pushNotification: () => {},
  sendToAccount: () => {},
  LOCKER_TYPES: ['regular', 'valuable', 'temporary'],
};
const lockersModule2 = lockersModule(lockerApi);
const lockerSpace = { id: 's56', lockers: [], lockerReservations: new Map() };
lockersModule2.handleLockers({}, { account: 'admin' }, lockerSpace, { type: 'lockerCreate', name: '3F 寄存柜', lockerType: 'valuable', total: 2 });
const lk1 = lockerSpace.lockers[0];
assert(lk1 && lk1.type === 'valuable', 'lockerCreate 新增贵重储物柜');
assertEq(lk1.available, 2, '新增后可用 2');
lockersModule2.handleLockers({}, { account: 'user' }, lockerSpace, { type: 'lockerCreate', name: '无权柜' });
assert(lockerSent.some((m) => m.message && m.message.includes('仅管理员')), '非管理员新增储物柜被拒');
lockersModule2.handleLockers({}, { account: 'alice' }, lockerSpace, { type: 'lockerReserve', lockerId: lk1.id });
const lkRes = [...lockerSpace.lockerReservations.values()][0];
assert(lkRes && lkRes.status === 'reserved', 'alice 预约储物柜');
assertEq(lk1.available, 1, '预约后可用减 1');
lockersModule2.handleLockers({}, { account: 'alice' }, lockerSpace, { type: 'lockerCheckin', id: lkRes.id });
assertEq(lkRes.status, 'checked_in', '签到后已使用');
lockersModule2.handleLockers({}, { account: 'alice' }, lockerSpace, { type: 'lockerCheckout', id: lkRes.id });
assertEq(lkRes.status, 'checked_out', '签退后已归还');
assertEq(lk1.available, 2, '签退后可用恢复');
lockersModule2.handleLockers({}, { account: 'admin' }, lockerSpace, { type: 'lockerDelete', id: lk1.id });
assertEq(lockerSpace.lockers.length, 0, '归还后可删除储物柜');
assertEq(lockerApi.lockerStats(lockerSpace).active, 0, 'lockerStats 活跃数为 0');

// ---------- 用车 / 公务车辆借用 ----------
console.log('\n📋 57. 用车申请 / 公务车辆');
const vhSent = [];
let vhSeq = 0;
const vhApi = {
  spaceUserInfo: () => new Map([['alice', { display: '甲' }], ['bob', { display: '乙' }]]),
  vehiclesPublic: (space) => space.vehicles,
  vehicleStats: (space) => ({ total: space.vehicles.length, maintenance: space.vehicles.filter((v) => v.maintenance).length, inUse: [...space.vehicleReservations.values()].filter((r) => r.status === 'checked_in').length, todayBookings: [...space.vehicleReservations.values()].filter((r) => r.status === 'reserved' || r.status === 'checked_in').length, byType: {} }),
  vehicleReservationsPublic: (space) => [...space.vehicleReservations.values()],
  vehiclesBroadcast: () => {},
  broadcast: () => {},
  isAdmin: (space, account) => account === 'admin',
  sendTo: (ws, obj) => { vhSent.push(obj); },
  serError: (m) => ({ type: 'error', message: m }),
  genId: () => `vh${vhSeq++}`,
  saveEntity: () => {},
  deleteEntity: () => {},
  pushNotification: () => {},
  VEHICLE_TYPES: ['sedan', 'suv', 'van', 'bus'],
};
const vehiclesModule2 = vehiclesModule(vhApi);
const vhSpace = { id: 's57', vehicles: [], vehicleReservations: new Map() };
vehiclesModule2.handleVehicles({}, { account: 'admin' }, vhSpace, { type: 'vehicleCreate', name: '公务轿车', plateNumber: '京A12345', vehicleType: 'suv' });
const v1 = vhSpace.vehicles[0];
assert(v1 && v1.type === 'suv' && v1.plateNumber === '京A12345', 'vehicleCreate 新增 SUV 车辆');
vehiclesModule2.handleVehicles({}, { account: 'user' }, vhSpace, { type: 'vehicleCreate', name: '越权车', plateNumber: 'X' });
assert(vhSent.some((m) => m.message && m.message.includes('仅管理员')), '非管理员新增车辆被拒');
vehiclesModule2.handleVehicles({}, { account: 'alice' }, vhSpace, { type: 'vehicleReserve', vehicleId: v1.id, date: '2026-10-20', startAt: Date.now() + 86400000, endAt: Date.now() + 86400000 + 3600000, purpose: '接送客户' });
const vr1 = [...vhSpace.vehicleReservations.values()][0];
assert(vr1 && vr1.status === 'reserved', 'alice 预约车辆');
// 同车时段冲突
vehiclesModule2.handleVehicles({}, { account: 'bob' }, vhSpace, { type: 'vehicleReserve', vehicleId: v1.id, date: '2026-10-20', startAt: Date.now() + 86400000 + 60000, endAt: Date.now() + 86400000 + 3600000 + 60000, purpose: '办事' });
assert(vhSent.some((m) => m.message && m.message.includes('已被借用')), '同车冲突时段被拒');
// 保养车不可借
vehiclesModule2.handleVehicles({}, { account: 'admin' }, vhSpace, { type: 'vehicleUpdate', id: v1.id, maintenance: true });
assertEq(v1.maintenance, true, 'vehicleUpdate 标记保养中');
vehiclesModule2.handleVehicles({}, { account: 'bob' }, vhSpace, { type: 'vehicleReserve', vehicleId: v1.id, date: '2026-10-21', startAt: Date.now() + 86400000, endAt: Date.now() + 86400000 + 3600000 });
assert(vhSent.some((m) => m.message && m.message.includes('保养中')), '保养中车辆不可借用');
vehiclesModule2.handleVehicles({}, { account: 'admin' }, vhSpace, { type: 'vehicleUpdate', id: v1.id, maintenance: false });
assertEq(v1.maintenance, false, 'vehicleUpdate 解除保养');
// 出车 / 还车 + 里程
vehiclesModule2.handleVehicles({}, { account: 'alice' }, vhSpace, { type: 'vehicleCheckin', id: vr1.id, mileageStart: 5000 });
assertEq(vr1.status, 'checked_in', '出车后状态为行驶中');
assertEq(vr1.mileageStart, 5000, '记录出发里程');
vehiclesModule2.handleVehicles({}, { account: 'alice' }, vhSpace, { type: 'vehicleCheckout', id: vr1.id, mileageEnd: 2000 });
assert(vhSent.some((m) => m.message && m.message.includes('不能小于')), '返回里程小于出发被拒');
vehiclesModule2.handleVehicles({}, { account: 'alice' }, vhSpace, { type: 'vehicleCheckout', id: vr1.id, mileageEnd: 5120 });
assertEq(vr1.status, 'checked_out', '还车后状态为已归还');
assertEq(vr1.mileageEnd - vr1.mileageStart, 120, '记录行驶里程');

// ---------- 统一空间搜索 ----------
console.log('\n📋 58. 统一空间搜索');
const ssh = api.createSpace('s58', '搜索空间', 1, 1);
ssh.rooms.push({ id: 'rm1', name: '云图会议室', capacity: 8, location: '3F', description: '带投影' });
ssh.tools.push({ id: 'tl1', name: '测试手机', category: '手机' });
ssh.materialRequests.set('mr1', { id: 'mr1', name: '5号电池', requesterName: '甲', reason: '平板用', createdAt: 1 });
ssh.repairs.set('rp1', { id: 'rp1', code: 'RP-001', category: '空调', location: '会议室', description: '不制冷', createdAt: 1 });
ssh.tasks.set('tk1', { id: 'tk1', title: '布置周会', createdAt: 1 });
ssh.knowledge.set('kn1', { id: 'kn1', title: '投影仪操作', category: '设备说明', content: '开关步骤', tags: '投影', createdAt: 1 });
ssh.notices.push({ id: 'n1', from: '管理员', text: '下周三团建', ts: 1 });
ssh.assets.set('a1', { id: 'a1', name: '3F 投影仪', category: '办公设备', createdAt: 1 });
const sshInfo = new Map([['alice', { account: 'alice', display: '甲甲', role: 'member' }]]);
assert(api.spaceSearch(ssh, sshInfo, '会议').hits.some((h) => h.type === 'rooms' && h.id === 'rm1'), '搜索命中会议室');
assert(api.spaceSearch(ssh, sshInfo, '测试手机').hits.some((h) => h.type === 'tools' && h.id === 'tl1'), '搜索命中设备');
assert(api.spaceSearch(ssh, sshInfo, '电池').hits.some((h) => h.type === 'materials' && h.id === 'mr1'), '搜索命中申领');
assert(api.spaceSearch(ssh, sshInfo, '不制冷').hits.some((h) => h.type === 'repairs' && h.id === 'rp1'), '搜索命中报修描述');
assert(api.spaceSearch(ssh, sshInfo, '周会').hits.some((h) => h.type === 'tasks' && h.id === 'tk1'), '搜索命中待办');
assert(api.spaceSearch(ssh, sshInfo, '投影仪').hits.some((h) => h.type === 'knowledge' && h.id === 'kn1'), '搜索命中知识库');
assert(api.spaceSearch(ssh, sshInfo, '团建').hits.some((h) => h.type === 'notices' && h.id === 'n1'), '搜索命中公告');
assert(api.spaceSearch(ssh, sshInfo, '投影').hits.some((h) => h.type === 'assets' && h.id === 'a1'), '搜索命中资产');
assert(api.spaceSearch(ssh, sshInfo, '甲甲').hits.some((h) => h.type === 'users' && h.id === 'alice'), '搜索命中成员');
assertEq(api.spaceSearch(ssh, sshInfo, '').hits.length, 0, '空关键词返回空');
assertEq(api.spaceSearch(ssh, sshInfo, '不存在的词xyz').hits.length, 0, '无匹配返回空');

// ---------- 概览运营看板（新模块指标） ----------
console.log('\n📋 59. 概览运营看板（包裹/储物柜/车辆/停车指标）');
const dSp = api.createSpace('s59', '运营空间', 1, 1);
const dUser = { account: 'alice', nickname: '甲' };
dSp.parcels.set('p1', { id: 'p1', status: 'incoming', expectedAt: Date.now() - 1000, lastRemindedAt: 0 });
dSp.parcels.set('p2', { id: 'p2', status: 'incoming', expectedAt: 0, lastRemindedAt: 0 });
dSp.parcels.set('p3', { id: 'p3', status: 'picked' });
dSp.lockers.push({ id: 'lk1', name: '柜1', total: 4, available: 2 });
dSp.lockerReservations.set('lr1', { id: 'lr1', lockerId: 'lk1', status: 'checked_in' });
dSp.vehicles.push({ id: 'vh1', name: '商务车', type: 'van', maintenance: false });
dSp.vehicles.push({ id: 'vh2', name: '保养车', type: 'sedan', maintenance: true });
dSp.vehicleReservations.set('vr1', { id: 'vr1', vehicleId: 'vh1', status: 'checked_in', date: api.todayKey(Date.now()), startAt: Date.now(), endAt: Date.now() + 3600000 });
dSp.parkingSpots.push({ id: 'pk1', name: '车位1', total: 2, available: 1 });
dSp.parkingReservations.set('pr1', { id: 'pr1', spotId: 'pk1', status: 'checked_in' });
const dg = api.buildDigest(dSp, dUser, Date.now());
assertEq(dg.incomingParcelsCount, 2, 'digest 统计待取包裹');
assertEq(dg.overdueParcelsCount, 1, 'digest 统计逾期包裹');
assertEq(dg.activeLockersCount, 1, 'digest 统计占用储物柜');
assertEq(dg.lockerTotal, 1, 'digest 统计柜位总数');
assertEq(dg.vehiclesInUseCount, 1, 'digest 统计行驶车辆');
assertEq(dg.todayVehicleBookingsCount, 1, 'digest 统计今日预借车辆');
assertEq(dg.maintenanceVehiclesCount, 1, 'digest 统计保养中车辆');
assertEq(dg.parkingOccupiedCount, 1, 'digest 统计停车占用');
assertEq(dg.parkingTotal, 1, 'digest 统计车位总数');

console.log('\n==================================================');
console.log(`✅ 单元通过: ${passed}`);
console.log(`❌ 单元失败: ${failed}`);
console.log('==================================================');
process.exit(failed > 0 ? 1 : 0);
