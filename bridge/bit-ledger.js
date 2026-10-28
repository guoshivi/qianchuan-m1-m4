'use strict';
/**
 * bit-ledger.js — 品台账（m2~m7 全链路状态，防重复处理）
 *
 * 用户 2026-09-11 要求：**记录选品车操作过的商品，不要重复**
 *
 * 台账文件：~/.qc-rebuild-ego/products-ledger.json
 *
 * 🔑 **主键 = `<千川商品ID>@<号>`（2026-09-18 改）**
 *   为什么要改：用户开始**同一个商品跑两个抖音号**（2 品 × 2 号）。原来主键只有商品ID，
 *   同一个品跑第二个号时会被判"已处理"→ 直接 SKIP，而且 号/识别码/短标题/计划ID 会被覆盖。
 *   ⇒ 台账/选品车缓存统一升级成复合主键（`商品ID@号`），"同品多号"从此是一等公民。
 *
 *   兼容与迁移：
 *   · **读口永远归一化**：把老的"纯商品ID"键按条目里的 `号` 补成 `商品ID@号`（内存里就统一了）
 *   · **首次落盘前自动备份**：save() 发现键集合变了 → 先写 `products-ledger.json.bak-migrate-<ts>`
 *   · 条目里没有 `号` 的老记录：保留纯商品ID 键，按"号无关"处理（任何号都能命中它）
 *
 * 结构：
 * {
 *   "<商品ID>@<号>": {
 *     标题, 号, 联盟ID, 佣金率, suffix,
 *     识别码, 视频ID,
 *     m1: { 来源, 时间 },
 *     m3: { 炮灰视频, 上传时间, 标题 },
 *     m4: { 计划ID, 时间, 预算 },
 *     m5: { 就位时间, 数量, 串码 },
 *     m6: { 店铺, 申请时间, 确认时间, 状态 },
 *     m7: { 计划ID, 时间, 目标ROI, 终验 },
 *     状态: '进行中'|'已完成'|'失败',
 *     更新于
 *   }
 * }
 *
 * CLI：
 *   node bit-ledger.js --list                                  # 列出全部（表格，带号）
 *   node bit-ledger.js --check <商品ID> [--account <号>]         # 查是否已处理（exit 0=已处理, 1=未处理）
 *   node bit-ledger.js --add <商品ID> --account <号> [--title .. --unionId .. --rate .. --frag ..]
 *   node bit-ledger.js --mark <商品ID> --stage m4 [--account <号>] --planId <ID> [--extra 预算50]
 *   node bit-ledger.js --unset <商品ID> --stage m4 [--account <号>]
 *   node bit-ledger.js --migrate                                # 把老键（纯商品ID）升级成 商品ID@号
 *   node bit-ledger.js --cart --account <号>                     # 拉选品车全量并标注「已处理/未处理」
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_DIR = process.env.QC_STATE_DIR || path.join(os.homedir(), '.qc-rebuild-ego');
const FILE = path.join(STATE_DIR, 'products-ledger.json');
// m2 = 素材下载+去重（2026-09-11 补）
// 'm3发布' = 上传+挂车+发布（与 m3a 生成分开记，bit-pipeline 的 CHAIN 就是这么判重复发布的）。
// 2026-09-12 修：**CLI `--mark` 的白名单原来漏了 'm3发布'** → 手工续跑 m3c 成功后想补记被拒
//   （{"ok":false,"err":"stage 需为 m2/m3/m4/m5/m6/m7"}），只能绕过 CLI 调模块。
//   白名单必须和 pipeline 的 CHAIN 对齐，否则"能跑的阶段"和"能补记的阶段"是两套。
const STAGES = ['m2', 'm3', 'm3发布', 'm4', 'm5', 'm6', 'm7'];

// ─────────────────────────────────────────────────────────────────────────────
// 复合主键：`<商品ID>@<号>`
// ─────────────────────────────────────────────────────────────────────────────
const SEP = '@';

/** 拆键 → {商品ID, 号}（老键没有 @ → 号 = ''，按"号无关"处理） */
function splitKey(k) {
  const s = String(k);
  const i = s.indexOf(SEP);
  return i < 0 ? { 商品ID: s, 号: '' } : { 商品ID: s.slice(0, i), 号: s.slice(i + 1) };
}
/** 组键（没给号 → 退回纯商品ID，兼容老数据/单号场景） */
function keyOf(productId, account) {
  const a = String(account == null ? '' : account).trim();
  return a ? String(productId) + SEP + a : String(productId);
}
/** 某商品ID 在台账里的所有键（可再按号过滤） */
function keysFor(j, productId, account) {
  const pid = String(productId);
  const acc = String(account == null ? '' : account).trim();
  return Object.keys(j).filter((k) => {
    const s = splitKey(k);
    if (s.商品ID !== pid) return false;
    return acc ? (s.号 === acc || s.号 === '') : true;   // '' = 老记录/号无关，任何号都能命中
  });
}
/** 归一化：老的"纯商品ID"键 → `商品ID@号`（条目里有 号 才搬；同名目标已存在则不动） */
function normalize(j) {
  let moved = 0;
  for (const k of Object.keys(j)) {
    if (String(k).indexOf(SEP) >= 0) continue;
    const e = j[k];
    if (!e) continue;
    const 号 = String(e.号 || '').trim();
    if (!号) continue;
    const nk = keyOf(k, 号);
    if (j[nk]) continue;
    j[nk] = e; delete j[k]; moved++;
  }
  return { j, moved };
}

function readRaw() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; }
}
/** 读口：**永远返回归一化后的映射**（磁盘上的迁移在 save 时落地） */
function load() { return normalize(readRaw()).j; }

function save(j) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // 键集合变了 = 这是一次迁移 → 先留一份原样备份（可回退）
  try {
    if (fs.existsSync(FILE)) {
      const old = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      const a = Object.keys(old).sort().join(','), b = Object.keys(j).sort().join(',');
      if (a !== b) fs.writeFileSync(FILE + '.bak-migrate-' + Date.now(), JSON.stringify(old, null, 1));
    }
  } catch (e) {}
  fs.writeFileSync(FILE, JSON.stringify(j, null, 1));
}
// ⚠️ 必须用本地时间：toISOString() 是 UTC，与后台看到的北京时间差 8 小时
// （2026-09-11 踩过：站点显示 20:13，台账写成 12:13）
function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 取条目（**精确到号**）
 * @param {string} productId
 * @param {{account?:string}} [opts] 不给号：只有一个条目才返回（多个=歧义 → null，别猜）
 */
function get(productId, opts = {}) {
  const j = load();
  const ks = keysFor(j, productId, opts.account);
  if (!ks.length) return null;
  const acc = String(opts.account == null ? '' : opts.account).trim();
  if (acc) { const 精确 = ks.find((k) => splitKey(k).号 === acc); return j[精确 || ks[0]] || null; }
  return ks.length === 1 ? j[ks[0]] : null;
}

/** 是否已处理（任一阶段存在即算处理过；可用于防重复） */
function isProcessed(productId, opts = {}) {
  const j = load();
  const ks = keysFor(j, productId, opts.account);
  const 命中 = ks.filter((k) => STAGES.some((s) => j[k] && j[k][s]));
  if (!命中.length) return { processed: false, 键数: ks.length };
  const k = 命中[0], e = j[k];
  return { processed: true, entry: e, stages: STAGES.filter((s) => e[s]), 键: k, 号: splitKey(k).号 };
}

/**
 * 写入/更新条目
 * @param {string} productId
 * @param {object} patch
 * @param {{account?:string}} [opts] 号（不给则用 patch.号）
 */
function upsert(productId, patch, opts = {}) {
  const j = load();
  const acc = String((opts.account != null ? opts.account : (patch && patch.号)) || '').trim();
  let k = keyOf(productId, acc);
  // 已经有同号（或老的"号无关"）条目 → 沿用那个键，别给同一个品+号开出两条
  const 现有 = keysFor(j, productId, acc);
  if (!j[k] && 现有.length === 1) k = 现有[0];
  j[k] = { ...(j[k] || {}), ...patch, 更新于: now() };
  if (!j[k].状态) j[k].状态 = '进行中';
  save(j);
  return j[k];
}

/**
 * 记某阶段
 * @param {{account?:string}} [opts]
 */
function markStage(productId, stage, data, opts = {}) {
  const j = load();
  const acc = String((opts.account != null ? opts.account : (data && data.号)) || '').trim();
  let k = keyOf(productId, acc);
  const 现有 = keysFor(j, productId, acc);
  if (!j[k] && 现有.length === 1) k = 现有[0];
  j[k] = j[k] || { 更新于: now() };
  j[k][stage] = { ...(j[k][stage] || {}), ...data, 时间: data && data.时间 ? data.时间 : now() };
  j[k].更新于 = now();
  if (stage === 'm7' && data && data.计划ID) j[k].状态 = '已完成';
  save(j);
  return j[k];
}

/** 撤销某阶段（返回被撤掉的原值） */
function unsetStage(productId, stage, opts = {}) {
  const j = load();
  const ks = keysFor(j, productId, opts.account);
  if (!ks.length) return { ok: false, err: '台账里没有这个商品ID: ' + String(productId) };
  const acc = String(opts.account == null ? '' : opts.account).trim();
  const k = (acc && ks.find((x) => splitKey(x).号 === acc)) || ks[0];
  const 原值 = j[k][stage];
  delete j[k][stage];
  j[k].更新于 = now();
  save(j);
  return { ok: true, 键: k, 商品ID: splitKey(k).商品ID, 号: splitKey(k).号, 已撤销阶段: stage, 原值 };
}

function listAll() {
  const j = load();
  return Object.entries(j).map(([k, v]) => ({ 键: k, 商品ID: splitKey(k).商品ID, ...v }));
}

/** 显式迁移（CLI --migrate 用）：搬到磁盘上，返回搬了几条 */
function migrate() {
  const { j, moved } = normalize(readRaw());
  if (moved) save(j);
  return { moved, 总数: Object.keys(j).length };
}

// ---------- CLI ----------
if (require.main === module) {
  const argv = process.argv || [];
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
  const has = (k) => argv.includes(k);
  const log = (o) => console.log(JSON.stringify(o));

  (async () => {
    if (has('--list') || (!argv[2])) {
      const all = listAll();
      console.log(`共 ${all.length} 条（主键 = 商品ID@号）\n`);
      for (const e of all) {
        const stages = STAGES.filter((s) => e[s]).join('+') || '-';
        console.log([
          e.商品ID,
          (e.号 || '(无号)').slice(0, 6).padEnd(7),
          (e.标题 || '').slice(0, 22).padEnd(24),
          (e.识别码 || '').padEnd(16),
          stages.padEnd(14),
          e.状态 || '',
          (e.m7 && e.m7.计划ID) || (e.m4 && e.m4.计划ID) || '',
        ].join(' | '));
      }
      process.exit(0);
    }

    if (has('--check')) {
      const pid = arg('--check') || argv[argv.indexOf('--check') + 1];
      const r = isProcessed(pid, { account: arg('--account') || '' });
      log({ 商品ID: pid, 号: arg('--account') || undefined, 已处理: r.processed, 阶段: r.stages || [], 命中键: r.键 || null, 台账: r.entry || null });
      process.exit(r.processed ? 0 : 1);
    }

    if (has('--migrate')) {
      const r = migrate();
      log({ ok: true, stage: 'MIGRATED', 搬了几条: r.moved, 当前条数: r.总数, 文件: FILE.replace(os.homedir(), '~'),
            说明: '老键（纯商品ID）→ 商品ID@号；落盘前已自动备份 .bak-migrate-<ts>' });
      process.exit(0);
    }

    if (has('--add')) {
      const pid = arg('--add');
      const account = arg('--account') || '';
      log({ ok: true, entry: upsert(pid, {
        标题: arg('--title') || '', 号: account,
        联盟ID: arg('--unionId') || '', 佣金率: arg('--rate') ? parseFloat(arg('--rate')) : undefined,
        suffix: arg('--suffix') || '', 识别码: arg('--frag') || '', 视频ID: arg('--itemid') || '',
      }, { account }) });
      process.exit(0);
    }

    if (has('--mark')) {
      const pid = arg('--mark');
      const stage = arg('--stage');
      const account = arg('--account') || '';
      if (!STAGES.includes(stage)) { log({ ok: false, err: 'stage 需为 ' + STAGES.join('/') }); process.exit(3); }
      const data = {};
      if (arg('--planId')) data.计划ID = arg('--planId');
      if (arg('--extra')) data.备注 = arg('--extra');
      if (arg('--店铺')) data.店铺 = arg('--店铺');
      if (arg('--状态')) data.状态 = arg('--状态');
      log({ ok: true, entry: markStage(pid, stage, data, { account }) });
      process.exit(0);
    }

    if (has('--unset')) {
      // 撤销某个阶段（**重跑该阶段的正规入口**，别手改 JSON）
      // 为什么需要（2026-09-12 号B渔具品）：m4 建的直投计划被人工删掉后，
      //   台账里 m4 还在 → 编排器 chainDone('m4') 为真 → 直接 SKIP，重跑不动。
      //   必须先把这条记录撤掉，重跑才有意义。
      // ⚠️ 只撤**指定那一个**阶段键；被撤下来的原值原样打出来（可追溯、可回填）。
      const pid = arg('--unset');
      const stage = arg('--stage');
      if (!STAGES.includes(stage)) { log({ ok: false, err: 'stage 需为 ' + STAGES.join('/') }); process.exit(3); }
      const r = unsetStage(pid, stage, { account: arg('--account') || '' });
      if (!r.ok) { log(r); process.exit(3); }
      log({ ...r, 原值: r.原值 === undefined ? '(本来就没有)' : r.原值,
            提示: '现在可以重跑该阶段：bit-pipeline.js --from ' + stage + ' --to ' + stage + ' --account ' + (r.号 || '<号>') });
      process.exit(0);
    }

    if (has('--cart')) {
      // 拉选品车全量 + 标注已处理/未处理
      const { readCartRows } = require('./commission-fetch.js');
      const CFG = require('./qc-config.js');
      const account = require('./account.js').accountOrExit(arg('--account'));
      const dy = (CFG.dyEnvs || []).find((d) => (d.name || '').includes(account));
      if (!dy) { log({ ok: false, err: '号未找到: ' + account }); process.exit(3); }
      const res = await readCartRows(dy.env, { log });
      const j = load();
      // ⚠️ 选品车给的是「联盟侧ID」，台账主键是「千川侧ID@号」→ 建反向索引（联盟ID → 条目）
      // 另存 选品车ID：实测决策页链接ID ≠ 选品车 tr[data-row-key]，两个都要能命中
      const byUnion = {};
      for (const [k, v] of Object.entries(j)) {
        if (!v) continue;
        if (v.联盟ID) byUnion[String(v.联盟ID)] = { k, v };
        if (v.选品车ID) byUnion[String(v.选品车ID)] = { k, v };
      }
      const rows = res.rows.map((r) => {
        const 直 = j[String(r.商品ID) + SEP + account] || null;
        const 反 = byUnion[r.商品ID] || null;
        const e = 直 || (反 && 反.v) || null;
        const 键 = 直 ? String(r.商品ID) + SEP + account : (反 ? 反.k : null);
        const stages = e ? STAGES.filter((s) => e[s]) : [];
        return { 联盟ID: r.商品ID, 标题: r.标题.slice(0, 30), 佣金片段: r.佣金片段, 已处理: stages.length > 0, 阶段: stages.join('+'), 千川ID: 键 ? splitKey(键).商品ID : null, 台账键: 键 };
      });
      log({ ok: true, 号: account, 选品车总数: rows.length, 已处理: rows.filter((x) => x.已处理).length, 未处理: rows.filter((x) => !x.已处理).length,
            说明: '已处理/未处理是**按本号**统计（主键 = 商品ID@号）' });
      for (const r of rows) log({ 联盟ID: r.联盟ID, 千川ID: r.千川ID || undefined, 已处理: r.已处理 ? '✅' + r.阶段 : '—', 佣金: r.佣金片段, 标题: r.标题 });
      process.exit(0);
    }

    log({ ok: false, err: '用法: --list | --check <ID> [--account <号>] | --add <ID> --account <号> | --mark <ID> --stage m4 [--account <号>] | --unset <ID> --stage m4 | --migrate | --cart --account <号>' });
    process.exit(3);
  })();
}

module.exports = { FILE, SEP, load, save, get, isProcessed, upsert, markStage, unsetStage, listAll, migrate,
                   keyOf, splitKey, keysFor, normalize, STAGES };
