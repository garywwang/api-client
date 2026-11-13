'use strict';
/**
 * 生成一个额外使用 publisher `wangbin6957` 的 VSIX（供 VS Code Marketplace 使用），
 * 源码 package.json 保持 Open VSX 在用的 publisher 不变。
 * 无论打包成功或失败，finally 都会还原 package.json。
 *
 * 用法：npm run package:w
 * 可选环境变量：
 *   W_PUBLISHER     覆盖目标 publisher（默认 wangbin6957）
 *   W_PACKAGE_OUT   覆盖输出路径（默认 ../vsix/w-api-client-<version>.vsix）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const original = fs.readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(original);

const publisher = process.env.W_PUBLISHER || 'wangbin6957';
const out = process.env.W_PACKAGE_OUT || `../vsix/w-api-client-${pkg.version}.vsix`;
const args = [
  require.resolve('@vscode/vsce/vsce'),
  'package',
  '--no-dependencies',
  '--allow-missing-repository',
  ...(pkg.repository ? [] : ['--no-rewrite-relative-links']),
  '--out', out
];

console.log(`[package:w] publisher=${publisher} version=${pkg.version} → ${out}`);

pkg.publisher = publisher;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

let failed = false;
try {
  execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
} catch (e) {
  failed = true;
  console.error('[package:w] 打包失败:', e.message);
} finally {
  fs.writeFileSync(pkgPath, original);
  console.log('[package:w] package.json 已还原');
}

if (failed) process.exitCode = 1;
