'use strict';
// 冒烟测试：快速验证「服务活着 + 页面可达 + WS 可连接 + 登录可用」。
// 供 `npm run smoke` 与 CI 快速门禁使用（比完整 e2e 更短）。
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
function httpJson(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ hostname: 'localhost', port: 3000, path, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, body: b }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(BASE + path, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
  });
}
function httpRaw(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const req = http.request({ hostname: 'localhost', port: 3000, path, method, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j, body: b }); });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function runSmoke() {
  console.log('\n🔥 冒烟测试 OfficeSpace · 办公空间管理...\n');

  const health = await httpJson('GET', '/api/health');
  assert(health.status === 200 && health.json.ok === true, '/api/health 返回 ok');
  assert(typeof health.json.uptime === 'number', '健康检查返回 uptime');

  const badJson = await httpRaw('POST', '/api/spaces', '{');
  assert(badJson.status === 400 && /不是合法 JSON/.test(badJson.body), '非法 JSON 返回 400');

  const page = await httpGet('/');
  assert(page.status === 200 && page.body.includes('OfficeSpace'), '首页可访问且含标题');

  const screen = await httpGet('/screen.html');
  assert(screen.status === 200 && screen.body.includes('大屏'), '电视墙大屏可访问');

  const spaces = await httpJson('GET', '/api/spaces');
  assert(spaces.status === 200 && Array.isArray(spaces.json), '/api/spaces 返回列表');

  const runKey = Date.now();
  const space = (await httpJson('POST', '/api/spaces', { name: '冒烟空间', squat_count: 2, urinal_count: 1 })).json;
  assert(space.id, '创建空间成功');
  const account = 'smoke_' + runKey;
  const reg = (await httpJson('POST', '/api/register', { account, password: 'pw', username: '冒烟用户', avatar: '🧑' })).json;
  assert(reg.ok, '注册账号成功');

  const ws = await new Promise((resolve, reject) => {
    const c = new WebSocket(WS_URL);
    c._messages = [];
    c.on('message', (d) => { try { c._messages.push(JSON.parse(d)); } catch {} });
    c.on('open', () => resolve(c));
    c.on('error', reject);
  });
  ws.send(JSON.stringify({ type: 'join', spaceId: space.id }));
  await new Promise((r) => setTimeout(r, 200));
  ws.send(JSON.stringify({ type: 'login', account, password: 'pw' }));
  await new Promise((r) => setTimeout(r, 250));
  const joined = ws._messages.some((m) => m.type === 'joined');
  const loggedIn = ws._messages.some((m) => m.type === 'loginSuccess');
  const gotRooms = ws._messages.some((m) => m.type === 'rooms');
  assert(joined, 'WS join 成功');
  assert(loggedIn, 'WS 登录成功');
  assert(gotRooms, '登录后收到 rooms 广播');

  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ 冒烟通过: ${passed}`);
  console.log(`❌ 冒烟失败: ${failed}`);
  if (errors.length > 0) { console.log('\n失败详情:'); errors.forEach((e) => console.log(`  - ${e}`)); }
  console.log(`${'='.repeat(50)}\n`);
  try { ws.close(); } catch {}
  process.exit(failed > 0 ? 1 : 0);
}

runSmoke().catch((err) => { console.error('冒烟测试运行出错:', err); process.exit(1); });
