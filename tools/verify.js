#!/usr/bin/env node
'use strict';
/**
 * tools/verify.js — 本仓库自检（不连浏览器、不写任何数据）
 *
 *   1) 所有 bridge/*.js 语法检查（node --check）
 *   2) qc-config.js 是否存在、必填字段是否还是占位符
 *   3) 依赖环境（node / python3+Pillow / remotion 是否装了依赖）
 *   4) 状态根 ~/.qc-rebuild-ego 可创建
 *
 * 用法：node tools/verify.js
 * 退出码：0 全过；1 有 FAIL
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const results = [];
const pass = (name, extra) => results.push({ ok: true, name, extra });
const fail = (name, extra) => results.push({ ok: false, name, extra });
const warn = (name, extra) => results.push({ ok: true, name, extra, warn: true });

// ---------- ① 语法检查 ----------
const bridge = path.join(ROOT, 'bridge');
const jsFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (e.name.endsWith('.js')) jsFiles.push(p);
  }
})(bridge);
let bad = 0;
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; fail('语法 ' + path.relative(ROOT, f), (r.stderr || '').split('\n')[0]); }
}
if (!bad) pass(`语法检查 ${jsFiles.length} 个 js 文件`);

// ---------- ② 配置 ----------
const cfgPath = path.join(bridge, 'qc-config.js');
const cfgExample = path.join(bridge, 'qc-config.example.js');
if (!fs.existsSync(cfgPath)) {
  fail('bridge/qc-config.js 不存在', `先跑：cp ${path.relative(ROOT, cfgExample)} bridge/qc-config.js`);
} else {
  let CFG = {};
  try { CFG = require(cfgPath); pass('bridge/qc-config.js 可加载'); }
  catch (e) { fail('bridge/qc-config.js 加载失败', e.message); }

  const PLACEHOLDER = /填|example|your-|<.*>/i;
  const envs = Array.isArray(CFG.dyEnvs) ? CFG.dyEnvs : [];
  if (!envs.length) fail('dyEnvs 为空', '至少配一个直投号');
  else {
    envs.forEach((d, i) => {
      const missing = ['env', 'uid', 'aavid', 'name', 'prefix'].filter((k) => !d[k] || PLACEHOLDER.test(String(d[k])));
      if (missing.length) fail(`dyEnvs[${i}] (${d.name || '未命名'}) 字段没填/还是占位符`, missing.join(', '));
      else if (!Array.isArray(d.downloadDirs) || !d.downloadDirs.length) {
        warn(`dyEnvs[${i}] (${d.name}) 没配 downloadDirs`, '素材目录将无法自动反查号，必须每次显式 --account');
      }
    });
    if (envs.length && envs.every((d) => !String(d.prefix || '').trim())) fail('所有号都没配 prefix', '识别码发不出来');
    const names = envs.map((d) => String(d.name || ''));
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      if (names[i] && (names[i].includes(names[j]) || names[j].includes(names[i]))) {
        warn(`号名互相包含：${names[i]} / ${names[j]}`, '--account 是包含匹配，容易挑错号');
      }
    }
  }
  if (!CFG.accountId || PLACEHOLDER.test(String(CFG.accountId))) fail('accountId 没填/还是占位符', '代投千川 aavid');
  if (!CFG.prefixRoute || !Object.keys(CFG.prefixRoute).length) warn('prefixRoute 为空', '按识别码路由到抖音号会失败');
}

// ---------- ③ 外部依赖 ----------
const [nodeMajor] = process.versions.node.split('.').map(Number);
nodeMajor >= 18 ? pass(`Node ${process.versions.node}`) : fail(`Node ${process.versions.node} 太旧`, '需要 ≥ 18（用到全局 fetch）');

const py = spawnSync('python3', ['-c', 'import PIL, sys; print(sys.version.split()[0])'], { encoding: 'utf8' });
if (py.status === 0) pass('python3 + Pillow', py.stdout.trim());
else warn('python3 / Pillow 不可用', '只有 m2 去重需要：pip3 install pillow');

if (fs.existsSync(path.join(ROOT, 'remotion', 'node_modules'))) pass('remotion 依赖已安装');
else warn('remotion 依赖未安装', '只有 m3 出片需要：cd remotion && pnpm i（约 500MB）');

// ---------- ④ 状态根 ----------
const stateDir = process.env.QC_STATE_DIR || path.join(os.homedir(), '.qc-rebuild-ego');
try {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.accessSync(stateDir, fs.constants.W_OK);
  pass('状态根可写', stateDir.replace(os.homedir(), '~'));
  const ledger = path.join(stateDir, 'products-ledger.json');
  if (fs.existsSync(ledger)) {
    const n = Object.keys(JSON.parse(fs.readFileSync(ledger, 'utf8')) || {}).length;
    pass('台账已有数据', `${n} 条 → ${ledger.replace(os.homedir(), '~')}`);
  } else pass('台账尚未创建（第一次 m1 --go 时自动生成）');
} catch (e) {
  fail('状态根不可写', stateDir + ' — ' + e.message);
}

// ---------- 汇总 ----------
let fails = 0, warns = 0;
for (const r of results) {
  const tag = r.ok ? (r.warn ? 'WARN' : ' OK ') : 'FAIL ';
  if (!r.ok) fails++; else if (r.warn) warns++;
  console.log(`[${tag}] ${r.name}${r.extra ? '  — ' + r.extra : ''}`);
}
console.log(`\n${results.length - fails - warns} 通过 / ${warns} 警告 / ${fails} 失败`);
process.exit(fails ? 1 : 0);
