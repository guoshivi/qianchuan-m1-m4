'use strict';
/**
 * bit-m1-pick.js — m1 选品：**给商品ID，自动建台账 + 生成清单行**（读选品车，不碰千川）
 *
 * 用户 2026-09-11 定版原则：「就先搜索商品 id」——一切以**商品ID**为主键，
 *   杜绝批量时选错品。本脚本就是这条原则的入口：你只给商品ID，其余身份信息自动补齐。
 *
 * 数据来源：`~/.qc-rebuild-ego/cart-map.<该号env>.json`（bit-cart-map.js hover 选品车「ID」标签得到；**按号分文件** ✓）
 *   · 缺失的ID → 提示（或 --refresh 自动）跑 bit-cart-map.js 刷新映射
 * 自动推导：保本ROI / suffix / 目标ROI（复用 commission-parse.js + roi-map.js）
 *          商品短标题（short-title.js，挂车用 ≤10 汉字）
 *          识别码 <该号前缀><YYMMDD><NN>（**单调分配**：扫台账取该号该日最大号 +1，杜绝撞码）
 *          ⚠️ 前缀**按抖音号走**（号A demoA / 号B demoB / 别的号 demoC…），配置在 qc-config.js
 *
 * 用法：
 *   node bit-m1-pick.js --ids 3000000000000000001,3000000000000000002        # 只看（默认只读）
 *   node bit-m1-pick.js --ids 3688… --go                                    # 写台账 + 追加 manifest
 *   node bit-m1-pick.js --ids 3688… --go --out manifest.json --account <号A>
 *   node bit-m1-pick.js --ids 3688… --refresh                               # 先刷新选品车映射
 *   node bit-m1-pick.js --ids 3688… --prefix demoC --go                       # 手动指定前缀（新号还没进配置时）
 *
 * 红线：默认只读（不写台账、不写文件）；--dryRun 等价只读；只读选品车，不做任何写操作。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { shortTitle } = require('./short-title.js');
const FC = require('./frag-code.js');
const { breakevenRoi, buildSuffix } = require('./commission-parse.js');
const { mapRoi } = require('./roi-map.js');
const LEDGER = require('./bit-ledger.js');
const { findMaterialDir } = require('./mat-dir.js');                 // 素材目录（含号反查）
const { accountFromDownloadDir } = require('./account.js');          // 目录编号 → 号

// 🔴 2026-09-30：与 bit-cart-map.js 共用**同一个**按号缓存路径（唯一定义在 cart-cache.js ✓）
const cartCache = require('./cart-cache.js');
// ⚠️ 2026-09-30：**不能在这里求值** ✗ —— `arg()` 此时还没定义（`ReferenceError: Cannot access 'arg'
//   before initialization` ✓，`node --check` 查不出来，是 `frag-code.test.js` 抓到的 ✓）
//   ⇒ 先声明、等 `arg` 定义之后再赋值（就在下面 `const arg = …` 之后 ✓）
let CACHE = null;
const { cartCacheLookup } = require('./commission-fetch.js');   // 缓存读口（带号）
const argv = process.argv || [];
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };

// ✅ 现在 `arg` 已定义 ⇒ 才能算出**按号**的缓存路径 ✓（账号键=该号 env ✓ 绝不串号 ✗）
CACHE = cartCache.pathOf(arg('--account'));
const has = (k) => argv.includes(k);
const log = (o) => console.log(JSON.stringify(o));
const home = (p) => String(p).replace(os.homedir(), '~');

// ---------------- 纯函数（可单测） ----------------

/** 本地日期 YYMMDD */
function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return String(d.getFullYear()).slice(2) + p(d.getMonth() + 1) + p(d.getDate());
}

/**
 * 识别码单调分配（**前缀按号走**，见 frag-code.js）。
 * ⚠️ 不能按「本次清单下标」发号——跨天/跨批次会撞码（已有 demoA26091001…、demoA26091101… 的先例）。
 * ⚠️ 更不能写死 `demoA`：号B是 `demoB`，写死会让它整条链路找不到视频。
 * @param {object} ledger 台账
 * @param {string} prefix 该抖音号的前缀（必传；来自 qc-config.js 的 dyEnvs[].prefix）
 * @param {string} day    YYMMDD
 */
function nextFrag(ledger, prefix, day = ymd()) {
  const r = FC.nextCode(ledger, prefix, day);
  return { frag: r.code, 序号: r.序号, 号段: prefix + day, 前缀: prefix };
}

/** 解析该用哪个前缀：--prefix > 号名/环境ID/前缀本身 > 只有一个号时用它 > 报错 */
function resolvePrefix(explicit, account) {
  if (explicit) return { prefix: explicit, 来源: '--prefix' };
  const byAcct = FC.prefixForAccount(account);
  if (byAcct) return { prefix: byAcct, 来源: '账号配置' };
  const envs = (require('./qc-config.js').dyEnvs || []).filter((d) => d.prefix);
  if (envs.length === 1) return { prefix: envs[0].prefix, 来源: '唯一配置的号' };
  return { prefix: null, 来源: null, 可选: envs.map((d) => `${d.name}=${d.prefix}`) };
}

/** 由商品名 + 佣金率 推导一行完整信息（纯函数） */
function deriveRow(info, opts = {}) {
  const rate = parseFloat(info && info.佣金率);
  const y = breakevenRoi(rate, { refundRate: opts.refundRate == null ? 0.15 : opts.refundRate });
  return {
    标题: (info && info.标题) || '',
    店铺: (info && info.店铺) || '',
    佣金率: Number.isFinite(rate) ? rate : null,
    联盟ID: (info && info.联盟ID) || '',
    保本ROI: y,
    suffix: Number.isFinite(y) ? buildSuffix(rate, y) : '',
    目标ROI: mapRoi(y),
    短标题: shortTitle((info && info.标题) || ''),
  };
}

function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { return {}; } }

// ---------------- CLI ----------------
// ⚠️ ego 运行时是**被 ego-entry `require` 进来**的 ⇒ `require.main === module` 永不为真（README 记的"还差的三件事"之二）。
if (require.main === module || (typeof taskSpace === 'function')) {
  const ids = String(arg('--ids') || '').split(/[,\s]+/).filter(Boolean);
  const go = has('--go') && !has('--dryRun');
  let account = arg('--account') || '';
  const outFile = arg('--out') || '';

  if (!ids.length) {
    log({ stage: 'USAGE', 用法: 'node bit-m1-pick.js --ids <商品ID>[,<商品ID>…] [--go] [--out manifest.json] [--account <号A>] [--refresh] [--refund 0.15]' });
    process.exit(2);
  }

  // ⭐ 没给 --account 时**自己检测**：按素材目录的编号层反查号（~/Downloads/<编号>/default/<商品ID>）
  //    映射在 qc-config.js 的 dyEnvs[].downloadDirs —— 2026-09-12 用户点名要求
  //    「你自己检测啊 是哪一个抖音号」，不要再回头问人。
  //    ⛔ 只在**所有入参商品都指向同一个号**时才采用；指不到或指向多个 → 保持空，
  //       后面 resolvePrefix 会报错列出可选号（宁可报错，不发错账号）。
  if (!account && ids.length) {
    const found = new Map();
    for (const pid of ids) {
      const hit = findMaterialDir(pid);
      const acc = hit && accountFromDownloadDir(hit.dir);
      if (acc) found.set(acc.name, { ...acc, 商品ID: pid, 目录: hit.dir });
      else log({ stage: 'ACCOUNT_DETECT_MISS', 商品ID: pid, 说明: '素材目录反查不出号（编号层没在 qc-config.dyEnvs[].downloadDirs 登记）' });
    }
    if (found.size === 1) {
      const a = [...found.values()][0];
      account = a.name;
      log({ stage: 'ACCOUNT_DETECTED', 号: a.name, 前缀: a.prefix, 来源: a.source, 目录编号: a.编号, 依据: a.目录.replace(os.homedir(), '~') });
    } else if (found.size > 1) {
      log({ stage: 'ACCOUNT_DETECT_AMBIGUOUS', 候选: [...found.keys()], 说明: '入参商品分属多个号 → 请显式 --account' });
    }
  }

  // --refresh：调 bit-cart-map.js 刷新选品车映射（不自造浏览器逻辑，复用已有脚本）
  if (has('--refresh') && typeof taskSpace === 'function') {
    // ego 下不 spawn 子进程（沙箱里不可靠、process.execPath 是 ego Helper）→ 让调用方单独跑
    log({ stage: 'REFRESH_NEED_SEPARATE', ok: false,
          说明: 'ego 下 --refresh 不能起子进程 → 请单独跑：ego-entry + bit-cart-map.js --all --account <号>（缓存会落到 ~/.qc-rebuild-ego/cart-map.json，本脚本随后直接读缓存）' });
  } else if (has('--refresh')) {
    try {
      log({ stage: 'REFRESH_START', 说明: '跑 bit-cart-map.js --all 刷新选品车映射' });
      const out = execFileSync(process.execPath, [path.join(__dirname, 'bit-cart-map.js'), '--all',
        ...(account ? ['--account', account] : [])], { encoding: 'utf8', timeout: 15 * 60 * 1000 });
      const lines = out.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      const done = lines.find((l) => l.stage === 'SCAN_DONE');
      log({ stage: 'REFRESH_DONE', ...(done || {}) });
    } catch (e) {
      log({ stage: 'REFRESH_FAIL', ok: false, err: String(e.message || e).slice(0, 200) });
    }
  }

  // 前缀：识别码按号走，先确定是哪个号的
  const PF = resolvePrefix(arg('--prefix'), account);
  if (!PF.prefix) {
    log({ stage: 'ARG', ok: false, err: '无法确定识别码前缀：请给 --account <号名> 或 --prefix <前缀>',
          可选: PF.可选, 说明: '前缀按抖音号走（号A demoA / 号B demoB / …），配置在 qc-config.js 的 dyEnvs[].prefix' });
    process.exit(3);
  }
  log({ stage: 'PREFIX', 前缀: PF.prefix, 来源: PF.来源 });

  let cache = loadCache();
  // ⚠️ 2026-09-20 补（实盘触发：用户在<号B>侧说"就在第一个啊 / 用搜索框搜索啊"）：
  //    `--refresh` 走的是 `bit-cart-map --all`，而它只扫**已渲染出来的行**（实测 45 行的车里只扫到 20 行）
  //    → 新加的品若排在第 20 行之后，`--refresh` 永远 MISSING（会被误读成"该品不在这个号的选品车"）。
  //    这里对每个查不到的 ID 再补一次 `--find <商品ID>`：它走**选品车搜索框**按商品ID唯一命中，
  //    不依赖页面渲染了多少行（搜索框那条路 2026-09-20 修好：后台标签上 CDP 输入/回车不落地 → 改原生 setter + JS 合成回车）。
  {
    let miss0 = ids.filter((pid) => !cartCacheLookup(cache, pid, account));
    if (miss0.length && typeof taskSpace === 'function') {
      // ego：不 spawn。缓存里没有 = 得先单独跑 cart-map --find（或在 ego 内直接调用 CF 的搜索那条路）
      log({ stage: 'FIND_NEED_SEPARATE', ok: false, 数量: miss0.length, 商品ID: miss0,
            说明: 'ego 下不 spawn 子进程 → 请先单独跑：ego-entry + bit-cart-map.js --find <商品ID> --account <号>' });
      cache = loadCache();   // 重新读一次（万一刚跑过）
      miss0 = ids.filter((pid) => !cartCacheLookup(cache, pid, account));
      if (miss0.length) { log({ stage: 'NOTHING_TO_DO', ok: false, 缺失: miss0 }); process.exit(1); }
    }
    if (miss0.length) {
      log({ stage: 'FIND_FALLBACK', 数量: miss0.length, 商品ID: miss0, 说明: '缓存里没有 → 用选品车搜索框按商品ID查（--find）' });
      for (const pid of miss0) {
        try {
          const o = execFileSync(process.execPath, [path.join(__dirname, 'bit-cart-map.js'), '--find', String(pid),
            ...(account ? ['--account', account] : [])], { encoding: 'utf8', timeout: 5 * 60 * 1000 });
          const lines = o.trim().split('\n').map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
          const f = lines.find((l) => l.stage === 'FOUND');
          log({ stage: 'FIND_FALLBACK_RESULT', 商品ID: pid, 命中: !!f,
                ...(f ? { 标题: String(f.标题 || '').slice(0, 30), 佣金率: f.佣金率 } : {}) });
        } catch (e) {
          log({ stage: 'FIND_FALLBACK_FAIL', ok: false, 商品ID: pid, err: String(e.message || e).slice(0, 160) });
        }
      }
      cache = loadCache();
    }
  }
  // 🔑 台账/缓存主键都带号：同一个商品在号A/号B 上是两条独立记录（2026-09-18）
  const ledger = LEDGER.load() || {};
  const 台账键 = (pid) => LEDGER.keyOf(pid, account);
  const usedIds = new Set();
  const rows = [], missing = [];

  for (const pid of ids) {
    // 🔑 缓存主键 = 商品ID@号（2026-09-18）：同品多号时各按自己的佣金率算 ROI
    const info = cartCacheLookup(cache, pid, account);
    if (!info) { missing.push(pid); log({ stage: 'MISSING', 商品ID: pid, 说明: '选品车映射里没有这个商品ID', 建议: 'node bit-cart-map.js --find ' + pid + '（或 --refresh）' }); continue; }
    if (usedIds.has(pid)) { log({ stage: 'DUP_SKIP', 商品ID: pid, 说明: '同一次入参里重复，已跳过' }); continue; }
    usedIds.add(pid);

    const prev = ledger[台账键(pid)] || {};
    const der = deriveRow(info, { refundRate: parseFloat(arg('--refund') || '0.15') });
    // 已有识别码就沿用（幂等），没有才分配新号
    const frag = prev.识别码 || nextFrag(ledger, PF.prefix, ymd()).frag;
    if (!prev.识别码) ledger[台账键(pid)] = { ...(ledger[台账键(pid)] || {}), 识别码: frag, 号: account };   // 占位，保证同批次内不重号

    const row = {
      productId: pid,
      识别码前缀: PF.prefix,
      title: der.标题,
      frag,
      shop: der.店铺,
      shortTitle: der.短标题,
      account: prev.号 || account || (require('./account.js').resolveAccount(null).name || ''),
      佣金率: der.佣金率, 保本ROI: der.保本ROI, suffix: der.suffix, 目标ROI: der.目标ROI,
      联盟ID: der.联盟ID,
      已有台账: Object.keys(prev).length > 0,
    };
    rows.push(row);
    log({ stage: 'ROW', 商品ID: pid, 识别码: frag, 标题: der.标题.slice(0, 24), 店铺: der.店铺,
          佣金率: der.佣金率, 保本ROI: der.保本ROI, suffix: der.suffix, 目标ROI: der.目标ROI, 短标题: der.短标题 });
  }

  if (!rows.length) { log({ stage: 'NOTHING_TO_DO', ok: false, 缺失: missing.length }); process.exit(1); }
  log({ stage: 'SUMMARY', 行数: rows.length, 缺失: missing.length, 模式: go ? '写入' : '只读' });

  if (!go) {
    log({ stage: 'DRY_RUN', 说明: '只读模式，未写台账/文件；要落地加 --go' });
    console.log(JSON.stringify(rows.map(({ 佣金率, 保本ROI, suffix, 目标ROI, 联盟ID, 已有台账, ...x }) => x), null, 1));
    process.exit(missing.length ? 1 : 0);
  }

  // 写台账
  for (const r of rows) {
    LEDGER.upsert(r.productId, {
      标题: r.title, 店铺: r.shop, 佣金率: r.佣金率, 联盟ID: r.联盟ID,
      识别码: r.frag, 识别码前缀: r.识别码前缀, 短标题: r.shortTitle, 保本ROI: r.保本ROI, 目标ROI: r.目标ROI, suffix: r.suffix,
      号: r.account,
      m1: { 来源: 'bit-m1-pick.js', 时间: new Date().toLocaleString('sv-SE').slice(0, 16) },
    }, { account: r.account });
    log({ stage: 'LEDGER_WRITTEN', 商品ID: r.productId, 识别码: r.frag });
  }

  // 追加 manifest（存在则合并，不覆盖已有行）
  if (outFile) {
    const p = path.resolve(outFile.replace(/^~/, os.homedir()));
    let list = [];
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); list = Array.isArray(j) ? j : (j.products || []); } catch (e) { list = []; }
    const byId = new Map(list.map((x) => [String(x.productId || x.商品ID), x]));
    for (const r of rows) {
      byId.set(r.productId, {
        productId: r.productId, title: r.title, frag: r.frag, shop: r.shop,
        shortTitle: r.shortTitle, account: r.account,
      });
    }
    const merged = [...byId.values()];
    fs.writeFileSync(p, JSON.stringify(merged, null, 1));
    log({ stage: 'MANIFEST_WRITTEN', 文件: home(p), 合计: merged.length, 本次新增或更新: rows.length });
  }

  if (missing.length) { log({ stage: 'DONE_WITH_MISSING', ok: false, 缺失: missing, 说明: '有商品ID没查到，先补齐再跑批量' }); process.exit(1); }
  log({ stage: 'DONE', ok: true, 行数: rows.length });
}

module.exports = { ymd, nextFrag, deriveRow, resolvePrefix };
