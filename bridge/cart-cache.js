'use strict';
/**
 * cart-cache.js —— 选品车映射缓存的**唯一主人**（2026-09-30 加 ✓）
 *
 * 🔴 为什么要有它（真 bug ✗）：
 *   原来 `bit-cart-map.js` 与 `bit-m1-pick.js` **各自**写着同一个缓存路径
 *   `~/.qc-rebuild-ego/cart-map.json` ✗ —— **两个号共用一个文件、互相覆盖** ✗✗
 *   2026-09-30 凌晨实盘：号B 跑 m1，去查缓存发现里面全是**号A**的选品车
 *   ⇒ 10 个品全部报「缺失」✗（`NOTHING_TO_DO 缺失:10`）—— 正是 canon
 *   「**账号身份必须绑定**」（断点/缓存按号分文件，别今天又踩一遍 ✗）。
 *
 * 命名：`cart-map.<账号键>.json`；账号键 = 该号在 `qc-config.dyEnvs` 里的 **env**
 *   （稳定 ✓、与 ego profile 映射同一个键 ✓、**不含真名** ✓ ⇒ 不会把真值写进文件名/同步面 ✗）。
 *   找不到配置项时退化成"号名的 md5 前 8 位"✓（仍然按号分开 ✓，但同样不落真名 ✓）。
 *
 * ⛔ 旧的扁平 `cart-map.json` **故意不读** ✓ —— 无法判断它属于哪个号 ✗，读它就是继续串号 ✗。
 *   （想留着做备份可以，但它不再是任何号的判据 ✓。）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// 状态根：默认 ~/.qc-rebuild-ego，可用 QC_STATE_DIR 覆盖（便于多套隔离/测试）
const ROOT = process.env.QC_STATE_DIR || path.join(os.homedir(), '.qc-rebuild-ego');

function keyOf(account) {
  const a = String(account || '').trim();
  try {
    const CFG = require('./qc-config.js');
    const dy = (CFG.dyEnvs || []).find((d) => (d.name || '').includes(a) || String(d.prefix || '') === a);
    if (dy && dy.env) return String(dy.env);                 // 首选 env（与 ego 映射同键 ✓）
    if (dy && dy.prefix) return String(dy.prefix);
  } catch (e) {}
  if (!a) return 'unknown';
  return 'acct-' + crypto.createHash('md5').update(a).digest('hex').slice(0, 8);
}

function pathOf(account) { return path.join(ROOT, 'cart-map.' + keyOf(account) + '.json'); }

function load(account) {
  try { return JSON.parse(fs.readFileSync(pathOf(account), 'utf8')); } catch (e) { return {}; }
}
function save(account, map) {
  const f = pathOf(account);
  try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(map, null, 1)); return f; } catch (e) { return null; }
}
/** 给人看的短路径（日志用 ✓） */
function prettyPath(account) { return pathOf(account).replace(os.homedir(), '~'); }

module.exports = { ROOT, keyOf, pathOf, load, save, prettyPath };
