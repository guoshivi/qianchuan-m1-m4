'use strict';
/**
 * account.js — 号名解析（**脚本里不写死任何号名**）
 *
 * 为什么有这个文件：
 *   2026-09-11 脱敏时把脚本里"默认号名"也扫成了占位符 `<号A>` → 脚本找不到号、整条链路停摆。
 *   根因不是脱敏过分，而是**默认值本来就不该写死真实号名**。
 *   统一规则：
 *     ① 显式给了 --account/--env 就用它（占位符 `<…>` 视为没给，直接报错，别静默跑错号）
 *     ② 没给、且 qc-config.js 里只配了一个号 → 用那个（唯一解，不算猜）
 *     ③ 没给、且配了多个 → 报错并列出可选号（**不猜**：跑错号 = 发错账号，代价极高）
 *     ④ 没给、但能从**素材下载目录的编号层**反查出号 → 用那个（见 accountFromDownloadDir）
 */
const CFG = require('./qc-config.js');
const os = require('node:os');
const path = require('node:path');

const isPlaceholder = (v) => !v || /^<.*>$/.test(String(v).trim());

/** → { name, source, 可选[] }；解析不出时 name=null */
function resolveAccount(explicit) {
  if (!isPlaceholder(explicit)) return { name: String(explicit).trim(), source: '参数' };
  const envs = (CFG.dyEnvs || []).filter((d) => d && d.name);
  if (envs.length === 1) return { name: envs[0].name, source: '唯一配置的号' };
  return { name: null, source: null, 可选: envs.map((d) => d.name) };
}

/** 解析不出就打印 ARG 错误并退出 3（脚本入口用） */
function accountOrExit(explicit, argName = '--account') {
  const r = resolveAccount(explicit);
  if (!r.name) {
    console.log(JSON.stringify({
      stage: 'ARG', ok: false, err: `需要 ${argName} <号名>`, 可选: r.可选,
      说明: '脚本里不写死号名；请传号名，或在 qc-config.js 里只配一个抖音号',
    }));
    process.exit(3);
  }
  return r.name;
}

/** 只拿一个默认号名（编排器给清单行兜底用）；解析不出返回 '' */
function defaultAccountName() { return resolveAccount(null).name || ''; }

/** 全部已配置号名 */
function allAccountNames() { return (CFG.dyEnvs || []).filter((d) => d && d.name).map((d) => d.name); }

/**
 * 从**素材下载目录**反查"这批素材属于哪个号"（2026-09-12 用户点名要求：你自己检测）
 *
 * 背景：扩展落盘路径形如 `~/Downloads/<编号>/default/<商品ID>/video_N.mp4`，
 *   其中**编号层**（实测 `4` / `5` / `6`）是判断这批素材该发给哪个号的唯一机器可读线索。
 *   映射登记在 `qc-config.js` 的 `dyEnvs[].downloadDirs`（真实值不入库）。
 *   ⛔ 这条知识以前**只在用户脑子里** —— 结果是"新素材是哪个号的"每次都要回头问人，
 *      用户 2026-09-12 明确不满：「我不是说过 5 是<号B> 你没记录吗？」
 *
 * 判据：取 `Downloads` 之后的**第一层**（编号层）去匹配 `downloadDirs`。
 *   ⚠️ 匹配不上就 **返回 null** —— 调用方必须报错或让用户显式给 `--account`，
 *      **绝不许猜**：猜错 = 素材发到别的号 → 识别码前缀错 → 整条链路白跑。
 * @param {string} dirOrPath 素材目录（如 ~/Downloads/5/default/3000000000000000004）
 * @param {Array} [envs] 测试注入用（默认读 qc-config.dyEnvs）
 * @returns {{name,prefix,env,编号,source}|null}
 */
function accountFromDownloadDir(dirOrPath, envs) {
  const list = (envs || CFG.dyEnvs || []).filter((d) => d && d.name);
  const segs = String(dirOrPath || '').replace(/^~/, os.homedir()).split(path.sep).filter(Boolean);
  const i = segs.lastIndexOf('Downloads');
  if (i < 0) return null;
  const 编号 = segs[i + 1];                      // Downloads 之后的第一层 = 编号层
  if (!编号) return null;
  for (const d of list) {
    if ((d.downloadDirs || []).map(String).includes(String(编号))) {
      return { name: d.name, prefix: d.prefix || '', env: d.env, 编号, source: '下载目录编号' };
    }
  }
  return null;
}

module.exports = { resolveAccount, accountOrExit, defaultAccountName, allAccountNames, isPlaceholder, accountFromDownloadDir };
