'use strict';
// 轻量语法检查：对 server.js / src/ 下全部 JS 执行 `node --check`。
// 供 `npm run lint` 与 CI 使用，不引入额外依赖。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const targets = ['server.js', 'test/test.js', 'test/smoke.js', 'test/restore.js', 'scripts/lint.js'];

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(full, acc);
    } else if (entry.name.endsWith('.js')) {
      acc.push(full);
    }
  }
}

const files = [...targets.map((f) => path.join(root, f))];
walk(path.join(root, 'src'), files);

let failures = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    console.log(`  ✓ ${path.relative(root, file)}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${path.relative(root, file)}`);
    console.error(String(err.stderr || err.message));
  }
}

console.log(`\n语法检查完成：${files.length} 个文件，${failures} 个错误`);
process.exit(failures > 0 ? 1 : 0);
