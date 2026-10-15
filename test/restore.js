'use strict';
// 回归测试：页面刷新后的「自动恢复会话」流程必须向服务端发送 join（携带保存的 spaceId）。
// 该 bug 曾因 connect().onopen 只检查已存在的 S.space 而漏发 join，导致用户卡在“正在恢复会话…”。
// 本测试用 vm + 极简 DOM/WebSocket stub 加载 public/index.html 的内联脚本，断言恢复路径发送 join。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');

const sent = [];
class FakeWS {
  constructor(url) {
    this.url = url; this.readyState = 1; this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
  }
  send(data) { sent.push(JSON.parse(data)); }
  close() {}
}

const domReady = [];
const elements = {};
function el(sel) {
  if (!elements[sel]) elements[sel] = {
    style: {}, innerHTML: '', value: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
  };
  return elements[sel];
}
const document = {
  addEventListener(ev, cb) { if (ev === 'DOMContentLoaded') domReady.push(cb); },
  querySelector: el, querySelectorAll: () => [],
  createElement() { return { className: '', textContent: '', style: {}, onclick: null, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} }; },
  getElementById: el,
};
const localStorage = {
  _d: { os_token: 'tok123', os_space: 'space42' },
  getItem(k) { return this._d[k] || null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
const sandbox = {
  console, setTimeout, setInterval, clearTimeout, clearInterval,
  WebSocket: FakeWS, document, localStorage,
  location: { protocol: 'http:', host: 'localhost:3000' },
  confirm: () => true, alert: () => {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(script, sandbox);

domReady.forEach((cb) => cb()); // 触发 init()

setTimeout(() => {
  const join = sent.find((m) => m.type === 'join');
  const joinOk = !!(join && join.spaceId === 'space42');
  let csvOk = false;
  try {
    const csv = sandbox.rowsToCsv([{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], [{ a: '1', b: 'x,y' }, { a: 2, b: 'he said "hi"' }]);
    csvOk = sandbox.csvCell('a"b') === '"a""b"' && csv === 'A,B\r\n1,"x,y"\r\n2,"he said ""hi"""';
  } catch (e) { csvOk = false; }
  if (joinOk && csvOk) {
    console.log('✅ 恢复会话用保存的 spaceId 发送了 join');
    console.log('✅ CSV 导出转义正确');
    process.exit(0);
  }
  if (!joinOk) console.log('❌ 恢复会话未发送 join（已发送: ' + JSON.stringify(sent) + '）');
  if (!csvOk) console.log('❌ CSV 导出转义失败');
  process.exit(1);
}, 20);
