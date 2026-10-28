'use strict';
/**
 * mat-dir.js — 素材目录解析器（批量作业的关键：别写死路径）
 *
 * 背景（2026-09-11 实盘）：
 *   扩展按 `<账号名|default>/<商品ID>/video_N.mp4` 落盘 → 10 个品 = 10 个以**商品ID**命名的文件夹，天然隔离。
 *   但**第一层目录名不稳定**：可能是 `default`，也可能是扩展里选中的**账号名**；
 *   而且历史上出现过 `~/Downloads/6/default/玫瑰洗护二合一/` 这种**按品名**命名的。
 *   ⇒ 所以不能写死 `~/Downloads/4/default/<商品ID>`，要**按商品ID搜索**。
 *
 * 用法：
 *   const { findMaterialDir, listMaterialDirs } = require('./mat-dir.js');
 *   findMaterialDir('3000000000000000001')   // → {dir, videos:[...], count, warn} | null
 *   listMaterialDirs()                        // → 所有素材目录概览（排查用）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { accountFromDownloadDir } = require('./account.js');   // 目录编号 → 号（2026-09-12 新增）
const CFG = require('./qc-config.js');                        // 素材根目录配置（matRoots / matSharedRoots ✓ 2026-09-29）

const DOWNLOADS = path.join(os.homedir(), 'Downloads');
const MAX_DEPTH = 4;
const MEDIA_RE = /\.(mp4|mov)$/i;

/**
 * 素材根目录清单（**顺序 = 优先级** ✓）—— 2026-09-29 用户把各 ego 空间的下载目录映射到 NAS 之后
 * 本地不再落盘（`~/Downloads` 只作老布局兼容），所以"素材在哪"必须**配置驱动**、不能再写死 ✗。
 *
 * 优先级（用户 2026-09-29 口径，**跟我原本猜的相反**，问过才定的 ✓）：
 *   ① `qc-config.js` 的 `matSharedRoots` —— NAS 上的「共用」= **两个号都要用的素材** ⇒ **先查这里** ✓
 *      （用户原话：「一般情况 在共用的 都是两个号都要用的素材，一般都是先检测共用，
 *        如果共用没有新的再去监测号自己的目录」）
 *   ② `qc-config.js` 的 `matRoots[号]` —— 该号自己的空间目录（NAS 上**按空间名分层**，一个号一个目录）⇒ 共用没有再查 ✓
 *   ③ `~/Downloads` —— 老布局（`<编号>/default/<商品ID>`），靠目录编号反查号 ✓ 兼容用
 *
 * ⚠️ hetu/Default 是**个人 ego 空间**，它的下载路径也设成「共用」⇒ 不需要单列 ✓
 *    （与 `ego-profiles.local.js` 里「Default/hetu 是个人 profile，不能放业务」那条备注一致 ✓）
 *
 * 素材落盘形状（用户 2026-09-29 确认：「确实是这种格式 `/default/<商品ID>/`，这个是正确的」✓）：
 *   **标准 = `<根>/default/<商品ID>/video_N.mp4`** ✓（扩展的下载布局，NAS 上也一样 ✓）
 *   兼容 = `<根>/<商品ID>/video_N.mp4`（老/手放的）—— 两种都认，**`default/` 优先** ✓（score 里 +100）
 *
 * ⚠️ NAS 没挂载 / 目录不存在 ⇒ **跳过并留一条 `MAT_ROOT_MISSING`**（不静默 ✗，canon #65 家族）
 */
function materialRoots(cfg, opt = {}) {
  // 显式单根（老调用/单测注入）⇒ 只用它，行为与改版前一致 ✓
  if (opt.root) return [{ root: String(opt.root), 号: null, 共用: false, 布局: '指定根', 在: true }];
  if (Array.isArray(opt.roots) && opt.roots.length) return opt.roots.map((r) => Object.assign({ 布局: '注入', 在: true }, r));
  const C = cfg || CFG;
  const list = [];
  const 加 = (root, 号, 共用, 布局) => {
    if (!root) return;
    const p = String(root).replace(/^~/, os.homedir());
    let 在 = false;
    try { 在 = fs.existsSync(p); } catch (e) {}
    list.push({ root: p, 号: 号 || null, 共用: !!共用, 布局, 在 });
  };
  for (const p of (C.matSharedRoots || [])) 加(p, null, true, 'NAS·共用');
  for (const [号, p] of Object.entries(C.matRoots || {})) 加(p, 号, false, 'NAS·号目录');
  加(DOWNLOADS, null, false, '本地 Downloads');
  return list;
}

function _walk(root, depth, out) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(root, e.name);
    out.push(p);
    _walk(p, depth + 1, out);
  }
}

/** 列出所有素材根下含视频的目录（按视频数排序；排查用 ✓ 现在会把 NAS 各根一起列） */
function listMaterialDirs() {
  const res = [];
  const seen = new Set();
  for (const 根 of materialRoots(CFG, {})) {
    if (!根.在) { res.push({ dir: 根.root, 布局: 根.布局, count: 0, videos: [], 根不在: true, 只看名: '根目录不存在(NAS 没挂?)', 号: 根.号 }); continue; }
    const dirs = [根.root];
    _walk(根.root, 1, dirs);
    for (const d of dirs) {
      if (seen.has(d)) continue;
      seen.add(d);
      let files;
      try { files = fs.readdirSync(d); } catch (e) { continue; }
      const videos = files.filter((f) => MEDIA_RE.test(f)).sort();
      if (!videos.length) continue;
      // 号：① 根自己标了号（NAS 按空间分层 ✓）② 共用根 ⇒ 共用 ✓ ③ 老布局 ⇒ 目录编号反查 ✓
      const acc = 根.号 ? { name: 根.号, 编号: null } : (根.共用 ? { name: '共用', 编号: null } : accountFromDownloadDir(d));
      res.push({ dir: d, name: path.basename(d), count: videos.length, videos, 布局: 根.布局, 共用: !!根.共用,
                 只看名: /^\d{10,}$/.test(path.basename(d)) ? '商品ID' : '非商品ID(可能是品名)',
                 号: acc ? acc.name : null, 目录编号: acc ? acc.编号 : null });
    }
  }
  res.sort((a, b) => b.count - a.count);
  return res;
}

/**
 * 按商品ID找素材目录（也支持传品名兜底）
 * @returns {{dir, videos, count, warn} | null}
 */
function findMaterialDir(productId, opt = {}) {
  const key = String(productId || '').trim();
  if (!key) return null;
  // 🔑 2026-09-23 修：**按号选目录**。
  //   原来签名收了 `opt` 却**从没用过** ⇒ 同一个商品跑两个号时，第二个号会解析到**第一个号的目录**。
  //   实测：商品 3000000000000000005 同时给 <号A>/<号B> 跑，<号B> 解析到的是 ~/Downloads/4（<号A> 的）
  //   ⇒ m4 会把**别人的素材**传上去（与 m7 断点串号同一类缺陷：判据没绑账号）。
  //   现在：给了 account 就只认号一致的目录；号不符**宁可判空**，绝不退而求其次。
  // 🔑 2026-09-29（用户把各 ego 空间的下载目录映射到 NAS）：素材根目录改成**配置驱动 + 顺序=优先级**：
  //   **共用 → 号自己 → 本地 Downloads**（口径见 `materialRoots()` 头注释 ✓）。
  //   号是怎么认出来的（三条路，都不猜 ✓）：
  //     ① 命中在「NAS·共用」根下 ⇒ 号 = **共用**（两个号都要用的那批 ⇒ **任何号都能用** ✓）
  //     ② 命中在「NAS·号目录」根下 ⇒ 号 = **该根对应的号**（按空间分层，天然不会串号 ✓）
  //     ③ 命中在「本地 Downloads」根下 ⇒ 靠**目录编号层**反查（老机制 ✓）
  const want = String(opt.account == null ? '' : opt.account).trim();
  const accountOf = typeof opt.accountOf === 'function' ? opt.accountOf : accountFromDownloadDir;
  const log = typeof opt.log === 'function' ? opt.log : () => {};
  const roots = materialRoots(opt.cfg, opt);
  const cands = [];
  for (const 根 of roots) {
    if (!根.在) {
      log({ stage: 'MAT_ROOT_MISSING', 根: 根.root.replace(os.homedir(), '~'), 布局: 根.布局,
            说明: '素材根目录不在（NAS 没挂载？）⇒ 跳过这个根；若本该有素材，先挂载/确认路径 ✓' });
      continue;
    }
    const dirs = [根.root];
    _walk(根.root, 1, dirs);
    // 精确同名目录优先；其次目录名包含该 key
    const exact = dirs.filter((d) => path.basename(d) === key);
    const loose = dirs.filter((d) => path.basename(d).includes(key) && path.basename(d) !== key);
    // ⚠️ 同一商品可能同时有「原始目录」和「去重产物目录」（实测 /default/ 与 封面版_0910_去重2/ 同名）
    //    优先：含 /default/（扩展标准布局）> 不含「去重」> 路径更短
    const score = (d) => {
      let s0 = 0;
      if (/\/default\//.test(d)) s0 += 100;
      if (!/去重/.test(d)) s0 += 20;
      s0 -= d.split(path.sep).length;
      return s0;
    };
    for (const d of [...exact.sort((a, b) => score(b) - score(a)), ...loose]) {
      let files;
      try { files = fs.readdirSync(d); } catch (e) { continue; }
      const videos = files.filter((f) => MEDIA_RE.test(f)).sort();
      if (!videos.length) continue;                      // 空目录跳过（如 3000000000000000006 那次 0 条）
      const warn = [];
      if (videos.length > 5) warn.push(`素材 ${videos.length} 条 > 上限 5 → 只取排序前 5 条`);
      if (videos.length < 5) warn.push(`素材只有 ${videos.length} 条（链路约定 ≤5，通常 5）`);
      const nums = videos.map((f) => (f.match(/(\d+)/) || [])[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
      if (nums.length && (nums[0] !== 1 || nums[nums.length - 1] !== nums.length)) {
        warn.push(`编号不连续（实测抽油烟机那次是 ${nums.join(',')}）—— 扩展计数会跳号，属正常，按实际文件处理`);
      }
      // 号（三条路，见函数头注释）——认不出就**明确告警**，绝不默认成"随便哪个号" ✗
      const acc = 根.号 ? { name: 根.号, prefix: '', 编号: null }
        : (根.共用 ? { name: '共用', prefix: '', 编号: null }
          : accountOf(d));
      if (!acc) warn.push('认不出这个目录属于哪个号（老布局看 qc-config.js 的 dyEnvs[].downloadDirs；NAS 布局看 matRoots）→ 跑链路必须显式 --account');
      cands.push({ dir: d, videos, warn, 号: acc ? acc.name : null, 前缀: acc ? acc.prefix : null, 目录编号: acc ? acc.编号 : null,
                   共用: !!根.共用, 来源: 根.布局 });
    }
  }
  if (!cands.length) return null;
  const pick = (c) => ({ dir: c.dir, videos: c.videos, count: c.videos.length, warn: c.warn, 号: c.号, 前缀: c.前缀,
                         目录编号: c.目录编号, 共用: c.共用, 来源: c.来源 });

  // ① 指定了号 → 认「共用」与「该号自己」的；一个都不符 → **判空并把候选写进日志**（别静默拿错 ✗）
  if (want) {
    // roots 的顺序就是优先级 ⇒ `find` 天然实现「**共用优先**，共用没有再查号自己的目录」✓（用户口径）
    const hit = cands.find((c) => c.共用 || c.号 === want);
    if (hit) {
      const 共用候选 = cands.filter((c) => c.共用);
      const 号候选 = cands.filter((c) => !c.共用 && c.号 === want);
      if (共用候选.length && 号候选.length) {
        // ⏱ 用户口径里有「如果共用**没有新的**再去监测号自己的目录」⇒ 两边都有时，把**各自最新一条素材的
        //    时间**一起打出来 ⇒ 一眼看出"共用是不是旧的"（只加可见性，**不改选谁**：口径是共用优先 ✓）
        const 最新 = (c) => {
          let t = 0;
          for (const f of c.videos) { try { const m = fs.statSync(path.join(c.dir, f)).mtimeMs; if (m > t) t = m; } catch (e) {} }
          return t ? new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '(读不到)';
        };
        log({ stage: 'MAT_DIR_BOTH_ROOTS', 商品ID: key, 号: want,
              用: 共用候选[0].dir.replace(os.homedir(), '~'), 另有: 号候选[0].dir.replace(os.homedir(), '~'),
              共用: 共用候选[0].videos.length + ' 条 · 最新 ' + 最新(共用候选[0]),
              号目录: 号候选[0].videos.length + ' 条 · 最新 ' + 最新(号候选[0]),
              说明: '「共用」和该号自己的目录**都有**这个品 ⇒ 按口径用「共用」（两个号都要用的那批 ✓）；'
                  + '上面两个"最新"是给人看的：若共用那份明显更旧、而你想用号目录的新素材 ⇒ 显式 --dir，或把新素材放进共用 ✓' });
      }
      return pick(hit);
    }
    log({ stage: 'MAT_DIR_NO_ACCOUNT_MATCH', 商品ID: key, 要的号: want,
          候选: cands.map((c) => c.dir.replace(os.homedir(), '~') + ' (' + (c.号 || '号?') + ')'),
          说明: '没有属于该号（也没有共用）的素材目录 → m2/m4 应显式 --dir，或确认素材下载到了正确的空间目录' });
    return null;
  }

  // ② 没指定号 → 按 roots 顺序取第一个，但**同品多来源时明确告警**（原来这种会静默串号 ✗）
  const first = cands[0];
  const 多号 = [...new Set(cands.map((c) => c.号 || '号?'))];
  if (多号.length > 1) {
    // ⚠️ 老文案**一个字别动**：单测 `mat-dir.test.js` ④ 与历史排查都按「多个号」这个说法找 ✓
    first.warn.push('同品存在多个号的素材目录（' + 多号.join(' / ') + '）→ 必须显式 --account 或 --dir，否则会把别的号的素材传上去');
  } else if (cands.length > 1) {
    // 同号但多个来源（如 NAS·共用 与 NAS·号目录 都有）⇒ 已按 roots 顺序（共用优先 ✓）取第一个，留痕 ✓
    first.warn.push('同品有多个来源的素材目录（' + [...new Set(cands.map((c) => c.来源))].join(' / ') + '）→ 已按 roots 顺序取第一个（共用优先 ✓），需要时显式 --dir');
  }
  return pick(first);
}

module.exports = { findMaterialDir, listMaterialDirs, materialRoots, DOWNLOADS };

// CLI：node mat-dir.js [--id <商品ID>]
if (require.main === module) {
  const argv = process.argv || [];
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
  const id = arg('--id');
  if (id) {
    const r = findMaterialDir(id);
    console.log(JSON.stringify(r ? { 商品ID: id, ...r, dir: r.dir.replace(os.homedir(), '~') } : { 商品ID: id, found: false }, null, 1));
  } else {
    for (const r of listMaterialDirs()) {
      // 号反查不出来就显式写「号?", 别让人以为没这回事
      console.log(`${String(r.count).padStart(2)} 条  ${r.dir.replace(os.homedir(), '~')}   [${r.只看名}]${r.号 ? `   号: ${r.号}` : '   号: ?（目录编号未登记）'}`);
    }
  }
}
