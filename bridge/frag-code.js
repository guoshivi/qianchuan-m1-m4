'use strict';
/**
 * frag-code.js — 识别码（炮灰视频码）唯一事实源
 *
 * 格式：`<前缀><YYMMDD><NN>`，异常品在后面加 `-01`
 *   例：号A demoA26091103 · 号B demoB26091101 · 别的号 demoC26091101
 *       异常：demoA26091103-01
 *
 * ⚠️ 核心规则（用户 2026-09-11 明确）：**前缀是"每个抖音号自己的"**，不是全局固定值。
 *   号A=`demoA`、号B=`demoB`、别的号可能 `demoC` …… 全部配置在 qc-config.js 的
 *   `dyEnvs[].prefix`（并同步登记 `prefixRoute`）。任何按识别码找视频/发号的逻辑
 *   **必须按号取前缀**，写死 `demoA` 会让别的号（如号B）整条链路失效。
 *
 * 用法：
 *   const FC = require('./frag-code.js');
 *   FC.prefixForAccount('<号A>')     // 'demoA'
 *   FC.prefixForEnv('<envId>')             // 'demoB'
 *   FC.nextCode(ledger, 'demoB', '260911')  // { code:'demoB26091101', seq:1, ... }
 *   FC.parse('demoA26091103-01')          // { prefix, day:'260911', seq:3, exception:true }
 *   FC.codeReSrc('demoB')                 // 页面里 new RegExp(src,'i') 用
 */
const CFG = require('./qc-config.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 本地"学到的前缀"（前缀 → 归属环境/时间）。不需要人维护配置：见 learnPrefix()
 *  可用 QC_FRAG_LEARNED 覆盖路径（测试用，避免污染真实的 ~/.qc-rebuild-ego） */
const LEARNED_FILE = process.env.QC_FRAG_LEARNED || path.join(process.env.QC_STATE_DIR || path.join(os.homedir(), '.qc-rebuild-ego'), 'frag-prefixes.json');
function learned() {
  try { const j = JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf8')); return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {}; } catch (e) { return {}; }
}
/**
 * 记下"某前缀属于某个号"。**不需要人填配置** —— 调用方在"按前缀路由不到、于是遍历所有直投号、
 * 结果在某个号里找到了这条炮灰"时调用本函数：**归属由"在哪找到的"反推**，比任何猜测都权威。
 * 幂等：同一 prefix→env 已存在则不重复写。
 */
function learnPrefix(prefix, env, extra = {}) {
  const p = String(prefix || '').trim().toLowerCase();
  if (!p || !/^[a-z]{2,10}$/.test(p)) return false;
  try {
    const all = learned();
    if (all[p] && all[p].env === env) return false;
    all[p] = Object.assign({ env: env || null, at: new Date().toISOString() }, extra);
    fs.mkdirSync(path.dirname(LEARNED_FILE), { recursive: true });
    fs.writeFileSync(LEARNED_FILE, JSON.stringify(all, null, 1));
    return true;
  } catch (e) { return false; }
}

/** 转义正则元字符（前缀可能含数字/字母，稳妥起见） */
function escapeRe(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 已配置 + 已学习的全部前缀（去重、去空） */
function prefixes() {
  const set = new Set();
  for (const d of (CFG.dyEnvs || [])) if (d && d.prefix) set.add(String(d.prefix).toLowerCase());
  for (const k of Object.keys(CFG.prefixRoute || {})) if (k) set.add(String(k).toLowerCase());
  for (const k of Object.keys(learned())) if (k) set.add(String(k).toLowerCase());
  return [...set];
}

/** 按号名 / 环境ID / 前缀 本身 → 该号前缀；找不到返回 null */
function prefixForAccount(account) {
  const a = String(account || '').trim();
  if (!a) return null;
  const envs = CFG.dyEnvs || [];
  const hit = envs.find((d) => d.name === a || d.env === a || d.prefix === a || (d.name || '').includes(a));
  if (hit && hit.prefix) return String(hit.prefix);
  // 传入的就是前缀本身
  if (prefixes().includes(a.toLowerCase())) return a;
  return null;
}

/** 环境ID → 前缀 */
function prefixForEnv(envId) {
  const d = (CFG.dyEnvs || []).find((x) => x.env === envId);
  return d && d.prefix ? String(d.prefix) : null;
}

/** 前缀 → 环境ID（prefixRoute 优先 → 学到的 → dyEnvs[].prefix） */
function envForPrefix(prefix) {
  const p = String(prefix || '').toLowerCase();
  const route = CFG.prefixRoute || {};
  for (const [k, v] of Object.entries(route)) if (String(k).toLowerCase() === p) return v;
  const lr = learned()[p];
  if (lr && lr.env) return lr.env;
  const d = (CFG.dyEnvs || []).find((x) => String(x.prefix || '').toLowerCase() === p);
  return d ? d.env : null;
}

/**
 * 解析识别码。宽松兼容老格式（如 `demoA013`）：
 *   digits 长度 ≥ 8 → day = 前 6 位，seq = 其余
 *   否则            → seq = 全部，day = ''
 * `-NN` 视为**异常标记**（用户规则：异常加 -01）
 */
function parse(code) {
  const raw = String(code || '').trim();
  const m = raw.match(/^([A-Za-z]+)(\d+)(?:-(\d+))?$/);
  if (!m) return { ok: false, raw };
  const prefix = m[1], digits = m[2], ex = m[3];
  const day = digits.length >= 8 ? digits.slice(0, 6) : '';
  const seq = parseInt(digits.length >= 8 ? digits.slice(6) : digits, 10);
  return { ok: true, raw, prefix, day, seq: Number.isFinite(seq) ? seq : 0, exception: ex != null, 异常号: ex || null };
}

/** 组装识别码 */
function build(prefix, day, seq, { exception = false, exceptionNo = '01' } = {}) {
  const base = String(prefix) + String(day) + String(seq).padStart(2, '0');
  return exception ? `${base}-${exceptionNo}` : base;
}

/** 扫台账，取该「前缀+日期」号段下一个可用序号（单调，绝不撞码）
 *  ⚠️ `-01` 异常码与它的基码算同一个序号（两者都属于同一个品） */
function nextSeq(ledger, prefix, day) {
  const p = String(prefix) + String(day);
  let max = 0;
  const consider = (code) => {
    const r = parse(code);
    if (r.ok && (r.prefix + r.day) === p && r.seq > max) max = r.seq;
  };
  for (const e of Object.values(ledger || {})) {
    if (!e) continue;
    consider(e.识别码);
    if (e.m3 && e.m3.识别码) consider(e.m3.识别码);
  }
  return max + 1;
}

/** 一步到位：给台账 + 前缀 + 日期 → 下一个可用识别码 */
function nextCode(ledger, prefix, day, opts = {}) {
  const seq = nextSeq(ledger, prefix, day);
  return { code: build(prefix, day, seq, opts), 序号: seq, 前缀: prefix, 日期: day, 异常: !!opts.exception };
}

/** 页面里识别视频用（初筛）：前缀 + 数字
 *  ⚠️ 不指定前缀（=千川侧，素材可能来自任何号）时追加**语法兜底** —— 见 LOOSE_* 说明。
 *     指定前缀（=抖音某个号自己的列表）时**不加兜底**，保持严格，避免把别号的码当自己的。 */
const LOOSE_CODE = '(?<![a-z0-9])[a-z]{2,10}\\d{3,8}(?:-\\d{1,2})?(?![a-z0-9])';
const LOOSE_HEAD = '(?<![a-z0-9])[a-z]{2,10}\\d{3}';
function _alts(prefix) {
  const list = prefix ? [prefix] : prefixes();
  return (list.length ? list : ['demoA']).map(escapeRe).join('|');
}
function headReSrc(prefix) {
  return prefix ? `(?:${_alts(prefix)})\\d` : `(?:(?:${_alts(prefix)})\\d|${LOOSE_HEAD})`;
}

/** 页面里抓精确码用：前缀 + 数字 + 可选 -NN
 *  ⚠️ 2026-09-13 口径（用户："每个抖音号的识别码肯定不一样"）：**不假设任何前缀形状**。
 *     · 已登记/已学习前缀 → 精确匹配（常态）
 *     · 其它 → **语法兜底**：`字母2~10 + 数字3~8（+可选 -NN）` 且必须是独立 token（词边界）
 *       —— 只描述"识别码长什么样"，不管是 demoA / sbmyyd / demoC 还是别的；边界挡掉
 *         `素材ID: 7681…`、`h264`、`1080p` 这类文本里的字母数字串。
 *     · 归属不靠形状猜：读到未登记前缀时由**路由兜底**（遍历各号找到它）反推，并 learnPrefix() 记下来。
 *  ⚠️ 另外把旧的 `\d*`（可以零位数字）收紧成 `\d{2,}`：裸前缀不再被当成码。 */
function codeReSrc(prefix) {
  const strict = `(?:${_alts(prefix)})\\d{2,}(?:-\\d+)?`;
  return prefix ? strict : `(?:${strict}|${LOOSE_CODE})`;
}

module.exports = {
  escapeRe, prefixes, prefixForAccount, prefixForEnv, envForPrefix,
  parse, build, nextSeq, nextCode, headReSrc, codeReSrc,
  learned, learnPrefix, LEARNED_FILE,
};
