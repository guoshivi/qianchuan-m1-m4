'use strict';
/**
 * commission-fetch.js — 选品车「商品ID + 佣金率」采集（可复用模块）
 *
 * 从 bit-fetch-commission.js 抽出的模块层，供 m7 编排（bit-qc-new.js）与 CLI 共用。
 *
 * ✅ 实测结构（2026-09-10，<号A>选品车 79 品）：
 *   · 选品车 = aurora-table：`tr[data-row-key]` 一行一品，**data-row-key 即商品ID**
 *   · 佣金率 = 表头含「佣金率」那一列（实测 index 3）
 *   · 佣金率 DOM 把数字与 % 拆到不同 span（textContent 得 `团长11%`）
 *
 * 抗冻结（用户建议用六件套突破）：
 *   ① 复用已打开的选品车标签（零导航）+ 先恢复窗口（隐藏/最小化会冻结渲染进程）
 *   ② 仍无响应 → 新标签 + 注入六件套（SIXPACK）后导航 → 读完关闭该标签
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CONST = require('./qc-const.js');
const { Cdp } = require('./bit-cdp.js');
const api = require('./bit-api.js');
// ego 传输层（**只在 ego 运行时里生效**；普通 node 下 inEgo() 恒为 false，比特路径一字不变）
const EGO = require('./ego/ego-transport.js');

const CART_URL = 'https://buyin.jinritemai.com/dashboard/merch-picking-cart';
// 选品车「商品ID ↔ 名/店铺/佣金率/联盟ID」映射（bit-cart-map.js 写的；m1 也是读它）
const CART_MAP_FILE = path.join(process.env.QC_STATE_DIR || path.join(os.homedir(), '.qc-rebuild-ego'), 'cart-map.json');
// 选品车搜索框（实测 placeholder 形态：商品名称 / 商品ID / 名称ID）
const CART_SEARCH_PH = /商品名称|商品ID|名称.*ID/i;
const TIMEOUT = Symbol('timeout');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ego 传输用：同一进程内**按 envId 复用**同一个空间（不复用就会每次开新窗口）。
// ⚠️ 2026-09-22 修：原来是一个全局 `_egoTask` —— 一个进程里连跑两个号时会**串号**（A 的空间被 B 用）。
//    而且它只认"调用方先塞进来的 task"，自己不知道 envId→profile ⇒ 直接开空间会落 Default(个人 profile) 被硬闸拦。
//    ⇒ 改成 keyed by envId，并且**自己能按 envId 解析出 profile**（ego-env-ctx.resolveEnvProfile）。
const _egoTasks = {};
let _egoTask = null;   // 兼容旧引用（finishEgoSpace）
/** envId → ego profile（对不上直接抛错，不猜） */
function egoProfileOf(envId) {
  const EEC = require('./ego/ego-env-ctx.js');
  const rp = EEC.resolveEnvProfile(envId);
  if (!rp.ok) throw new Error('EGO_ENV_UNMAPPED: ' + rp.原因);
  return rp;
}
async function egoTaskFor(envId, spacePrefix) {
  if (_egoTasks[envId]) return _egoTasks[envId];
  // ⛔ 2026-09-23（**用户指出**）：「你非常喜欢开新空间 … 一个空间你明明可以操作多个标签，你就是会打开新的
  //    空间操作，导致跳验证。」
  //    根因就在这里：原来按**用途前缀**开空间（`qc 选品车 · X`、`qc 抓图/新页 · X` 各一个）
  //    ⇒ 同一个号被拆成好几个空间、每次多开一个窗口 → 空间越堆越多（97/101/102/104/110…）+ 容易跳验证。
  //    现在：**一个号只用一个空间**（由 ego-env-ctx 统一认领/新建，规范名 `千川重建 · <账号>`），
  //    其它用途一律在这个空间里**开标签**；前缀只当用途标签写日志。
  const EEC = require('./ego/ego-env-ctx.js');
  const ctx0 = require('./ego/ego-env-ctx.js').makeEgoEnvCtx(envId, { log: () => {} });
  const task = await ctx0.egoTask();
  _egoTasks[envId] = task;
  try {
    log({ stage: 'EGO_REUSE_SPACE', env: envId, 用途: spacePrefix || '(未指定)',
          spaceId: (typeof ctx0.spaceId === 'function' ? ctx0.spaceId() : null),
          说明: '一个号只用一个空间（多标签复用），不再按用途开新空间' });
  } catch (e) {}
  return task;
}

/**
 * 选品车标题清洗 —— **单一事实源**（所有"从选品车读商品名"的地方都走这里）
 *
 * 踩过什么（2026-09-12 柚子品全链路）：
 *   选品车那一行的标题单元格 innerText 不止商品名 —— 后面还粘着行内控件的文字，
 *   实测原文：`【老树红心柚】福建平和红心蜜柚老树蜜柚香甜柚子坏果包赔多仓发货 ID 商品类目：`
 *   这个脏值有两条传播路径：
 *     ① `bit-m3-paohui.js` 把它（还 slice(0,40) 截断）**回写进台账**，覆盖掉 m1 的干净标题；
 *     ② 台账标题是 m4/m7 的 `--title` 入参 → 脏标题顺着链路一路传下去。
 *   ⇒ 在**唯一读口**（这里）就洗干净，下游（m1 / m3a / 台账 / 佣金）全部受益。
 *
 * 判据：从第一个**行内标签**（ID / 商品类目 / 体验分 / 佣金率 / 售价 …）之前截断。
 *   ⚠️ 必须要求标签前有空白，否则商品名里正当出现的「达人」「商家」会被误切。
 */
const TITLE_JUNK = /\s+(?:ID|id|商品类目|体验分|佣金率|售价|券后价)\s*[:：]?/;

/** 选品车行文本 → 干净商品名（默认截 80 字，与页面侧原口径一致） */
function cleanCartTitle(text, max = 80) {
  let s = String(text || '').replace(/[\s\u00a0]+/g, ' ').trim();
  const i = s.search(TITLE_JUNK);
  if (i > 0) s = s.slice(0, i).trim();      // i>0：别把整串都切没（万一标签就在开头）
  return s.slice(0, max);
}

/**
 * 「ID」标签 tooltip 原文 → 商品ID（**唯一解析口**，canon #22）
 *
 * 背景（2026-09-30 ego 实盘，探针 A/B 取证 ✓）：
 *   选品车行里的「ID」标签 hover 后弹 tooltip，**原文 = 「商品ID 3000000000000000007」**
 *   （旧 UI 走 trigger 的 aria-describedby 指到 tooltip 容器；新 UI 是 aurora-tooltip 容器，机制一样 ✓）。
 *   ⚠️ 真正让 `bit-cart-map --find` 报假阴性的**不是**解析，而是
 *   **CDP 的 Input.dispatchMouseEvent(mouseMoved) 在 ego 上不触发 React 的 hover** ✗
 *   ⇒ tooltip 一直是 aurora-tooltip-hidden、trigger 上也没有 aria-describedby ⇒ 恒读不到 ✗
 *   （修法见 bit-cart-map.js 里那段「JS 合成 mouseover/mouseenter」✓）。
 *   解析放这里是为了**能单测**（页面侧只负责把 tooltip 原文带回来 ✓）。
 *
 * @returns {string|null} 商品ID；认不出**返回 null**（⛔ 绝不拿行里别的数字冒充 —— canon #24 家族）
 */
function pidFromTooltip(text) {
  const t = String(text == null ? '' : text).replace(/[\s\u00a0]+/g, ' ').trim();
  if (!t) return null;
  const m = t.match(/商品\s*ID\s*[:：]?\s*(\d{10,})/);   // 标准形态：商品ID + 空格 + 10 位以上数字
  if (m) return m[1];
  const bare = t.match(/^(?:ID\s*[:：]?\s*)?(\d{10,})$/); // 兜底：tooltip 里只有裸 ID（别放宽成"含数字"✗）
  return bare ? bare[1] : null;
}

async function tryEval(cdp, expr, ms = 6000) {
  return Promise.race([
    cdp.eval(expr).then((v) => v).catch(() => null),
    sleep(ms).then(() => TIMEOUT),
  ]);
}

/** 隐藏/最小化窗口会冻结渲染进程 → 恢复窗口并前置 */
async function restoreWindow(cdp, pid) {
  try {
    const w = await cdp.send('Browser.getWindowForTarget', {});
    await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } });
  } catch (e) {}
  try {
    if (pid) execSync(`osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true'`, { timeout: 5000 });
  } catch (e) {}
}

/** 新建标签 + 六件套注入 + 导航 */
async function openFreshTab(envId, pid, url) {
  // ── ego 传输（同语义：新页 + 六件套 + 导航 + 等 readyState）──────────────
  if (EGO.inEgo()) {
    const task = await egoTaskFor(envId, 'qc 抓图/新页');
    // ⛔ 2026-09-23（**用户明确**：「还有可复用的标签不要去新建标签跑」）：
    //   原来这里**无条件 newPage()** ⇒ 每跑一次就多一个标签（抓图/授权确认都走它）。
    //   ⇒ 先找**同 URL 的现成标签**复用之（URL 含 id/识别码等关键查询参数，不会串品）；没有才新开。
    let page = null;
    {
      const want = String(url || '');
      const hit = (await EGO.listTabs(task)).find((t) => String(t.url || '').split('#')[0] === want.split('#')[0]);
      if (hit) page = hit.label ? task.page(hit.label) : await task.adopt(hit.page);
    }
    // ⛔ 2026-09-23（用户：「续用跟复用」+ 实测 8 标签上限）：
    //   同 URL 没命中时**不要直接 newPage()** —— 先拿一个"可续用"的现成标签导航过去；
    //   实在没有再新建（新建前还会自动腾位，避免撞 `Page budget reached (8/8)` 直接炸）。
    if (!page) {
      // 用户 2026-09-23 定：「同域的标签页只要留一个 直接刷新续用复用」
      const acq = await EGO.acquireTab(task, url, { log: (o) => console.log(JSON.stringify(o)) });
      page = acq.page;
      console.log(JSON.stringify({ stage: 'TAB_ACQUIRE', ok: true, 方式: acq.mode, 关掉同域多余: acq.closed, 目标: String(url).split('?')[0] }));
    }
    const ec = EGO.makeCdp(page, task);
    try { await ec.send('Page.addScriptToEvaluateOnNewDocument', { source: CONST.SIXPACK }); } catch (e) {}
    await page.goto(url, { timeout: 60000 });
    try { await ec.send('Page.bringToFront', {}); } catch (e) {}
    for (let i = 0; i < 25; i++) {
      const st = await tryEval(ec, 'document.readyState', 3000);
      if (st === 'complete' || st === 'interactive') break;
      await sleep(1000);
    }
    return {
      cdp: ec, targetId: page.targetId, mode: 'ego-create',
      // ⚠️ 2026-09-30：把 **ego 的 page 对象**也带出来 ✓（纯加法，老调用方不受影响 ✓）——
      //   调用方要做「ego 原生点击」时只能靠它（`page.click(选择器)` 自带 actionability：
      //   滚进视口 + 等可点 + 单匹配校验 ✓）；纯坐标 `Input.dispatchMouseEvent` 在 ego 上
      //   **经常点了不生效** ✗（canon #46/#71：该类点击一律原生优先、坐标回退 ✓）。
      page,
      // ⚠️ 2026-09-22：调用方会 `browser.send('Target.closeTarget', {targetId})` 关临时页，
      //    原来只给了 `{close(){}}` ⇒ 报 "browser.send is not a function"（实测）。
      browser: {
        send: async (m, p2) => {
          if (m === 'Target.closeTarget') { try { await page.close(); } catch (e) {} return {}; }
          return {};
        },
        close() {},
      },
    };
  }
  const info = await api.open(envId);
  const browser = await Cdp.connectWs(info.ws);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  await sleep(600);
  const tabs = await (await fetch(`http://${info.http}/json/list`)).json();
  const nt = tabs.find((t) => (t.id || t.targetId) === targetId);
  if (!nt) throw new Error('新标签未出现');
  const cdp = await Cdp.connectWs(nt.webSocketDebuggerUrl);
  await restoreWindow(cdp, pid);
  try { await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CONST.SIXPACK }); } catch (e) {}
  await cdp.send('Page.navigate', { url });
  try { await cdp.send('Page.bringToFront', {}); } catch {}
  for (let i = 0; i < 25; i++) {
    const st = await tryEval(cdp, 'document.readyState', 3000);
    if (st === 'complete' || st === 'interactive') break;
    await sleep(1000);
  }
  return { cdp, targetId, browser };
}

/**
 * 打开选品车读取器（复用标签优先，零导航）
 * @returns {{js:Function, close:Function, mode:string}}
 */
async function makeCartReader(envId, log = () => {}) {
  // ── ego 传输（2026-09-21）：**判据不动，只换 reader 的构造** ──────────────
  //    下面的 waitRows / buildRowsExpr / findCartSearchBox / setCartSearch / findCartRow /
  //    readCartRows / fetchOne 全部**原样**吃这个 reader（形状与比特版一致）。
  if (EGO.inEgo()) {
    const r = await EGO.makeEgoReader({ url: CART_URL, log, task: await egoTaskFor(envId, 'qc 选品车') });
    _egoTask = r.task;
    log({ stage: 'EGO_CART_READER', ok: true, mode: r.mode, 空间: r.spaceName, 传输: 'ego',
          说明: r.mode === 'reuse' ? '复用已开的选品车页（零导航）' : '附着/新开选品车页' });
    return r;
  }
  const info = await api.open(envId);
  const pid = info.pid;
  const tabs = ((await (await fetch(`http://${info.http}/json/list`)).json()) || []).filter((t) => t.type === 'page');
  const buyinTabs = tabs.filter((t) => (t.url || '').includes('buyin.jinritemai.com'));
  const cartTab = buyinTabs.find((t) => (t.url || '').includes('merch-picking-cart'));
  log({ stage: 'TABS', ok: true, buyin标签: buyinTabs.map((t) => (t.url || '').split('?')[0]), 已有选品车标签: !!cartTab });

  if (cartTab) {
    const cdp = await Cdp.connectWs(cartTab.webSocketDebuggerUrl);
    await restoreWindow(cdp, pid);
    try { await cdp.send('Page.bringToFront', {}); } catch {}
    let st = await tryEval(cdp, 'document.readyState', 6000);
    if (st === TIMEOUT) {
      log({ stage: 'REUSE_RETRY', ok: false, 提示: '标签无响应 → 恢复窗口后重试一次' });
      await restoreWindow(cdp, pid);
      await sleep(1800);
      st = await tryEval(cdp, 'document.readyState', 8000);
    }
    if (st !== TIMEOUT) {
      log({ stage: 'REUSE_TAB', ok: true, 说明: '复用已打开的选品车标签（零导航）' });
      return { js: (e) => cdp.eval(e), send: (m, p) => cdp.send(m, p), mode: 'reuse', close: () => { try { cdp.close(); } catch (e) {} } };
    }
    try { cdp.close(); } catch (e) {}
    log({ stage: 'REUSE_FAIL', ok: false, err: '选品车标签渲染进程无响应 → 改用新标签+六件套注入' });
  }

  const { cdp, targetId, browser } = await openFreshTab(envId, pid, CART_URL);
  log({ stage: 'NEW_TAB', ok: true, 说明: '新标签 + 六件套注入 + 导航（读完即关闭）' });
  return {
    js: (e) => cdp.eval(e),
    send: (m, p) => cdp.send(m, p),
    mode: 'newtab',
    close: async () => { try { await browser.send('Target.closeTarget', { targetId }); } catch (e) {} try { cdp.close(); browser.close(); } catch (e) {} },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 选品车搜索框操作 + 「商品ID → 联盟ID」查询（2026-09-13）
//
// 踩过什么（09-13 批量连跑，白跑一次 m3a）：
//   `bit-cart-map.js --find <商品ID>` 走的是**选品车搜索框**，用完会在页面上**留下过滤**
//   （实测 `ROWS_LOADED 行数:1`）→ 紧接着跑 m3a 读全量就只剩那一行 → 报
//   `选品车没找到: <品名>`（品其实就在车里，是被自己留下的过滤挡住了）。
// ⇒ 两条规矩：
//   ① **读选品车之前先清掉自己留下的过滤**（readCartRows/fetchOne 默认 resetSearch=true）
//   ② m3a 找联盟ID 走三级：**缓存 → 全量 → 搜索框**，不再依赖"页面当前恰好是干净的"
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 选品车缓存主键 = `<商品ID>@<号>`（2026-09-18）
//   为什么：同一个商品在两个号上的**佣金率可能不同**（实测 46.6% vs 45%），
//   而 ROI 完全由佣金率决定 → 缓存只留一个槽位会让另一个号按错的佣金算计划。
//   老数据（纯商品ID 键、条目里没号）仍然可读：先找 `商品ID@号`，再退回纯 `商品ID`。
// ─────────────────────────────────────────────────────────────────────────────
const CART_KEY_SEP = '@';
/** 组缓存键（没给号 → 退回纯商品ID，兼容老数据） */
function cartKeyOf(productId, account) {
  const a = String(account == null ? '' : account).trim();
  return a ? String(productId) + CART_KEY_SEP + a : String(productId);
}

/**
 * 从缓存里取该商品ID的映射（**纯函数**，可单测）
 * @param {object} cache  cart-map.json 的内容 {`商品ID@号`: {标题,店铺,佣金率,联盟ID}}
 * @param {string} productId
 * @param {string} [account] 号（给了就只认这个号 / 或号无关的老记录）
 * @returns {{联盟ID:string, 标题:string, 店铺?:string, 佣金率?:number, 键:string, 号:string}|null}
 */
function cartCacheLookup(cache, productId, account) {
  if (!cache || !productId) return null;
  const pid = String(productId);
  const keys = account ? [cartKeyOf(pid, account), pid] : [pid];
  for (const k of keys) {
    const e = cache[k];
    if (e && e.联盟ID) {
      return { 联盟ID: String(e.联盟ID), 标题: cleanCartTitle(e.标题), 店铺: e.店铺, 佣金率: e.佣金率,
               键: k, 号: String(e.号 || (k.indexOf(CART_KEY_SEP) >= 0 ? k.slice(k.indexOf(CART_KEY_SEP) + 1) : '')) };
    }
  }
  return null;
}

/** 读缓存文件（不存在/坏文件都返回 null，调用方当"缓存未命中"处理） */
function readCartCache(productId, account) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(CART_MAP_FILE, 'utf8')); } catch (e) { return null; }
  return cartCacheLookup(j, productId, account);
}

/** 写缓存（唯一写口；条目里带上「号」，方便以后迁移/排查） */
function writeCartCache(productId, account, patch, file = CART_MAP_FILE) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  const k = cartKeyOf(productId, account);
  j[k] = Object.assign({}, j[k] || {}, patch, { 商品ID: String(productId), 号: String(account == null ? '' : account).trim() });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(j, null, 1));
  return j[k];
}

/** 迁移：老的纯商品ID 键 → 商品ID@号（只有条目里记了「号」才搬；返回搬了几条） */
function migrateCartCache(file = CART_MAP_FILE) {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { moved: 0 }; }
  let moved = 0;
  for (const k of Object.keys(j)) {
    if (k.indexOf(CART_KEY_SEP) >= 0) continue;
    const e = j[k]; if (!e) continue;
    const 号 = String(e.号 || '').trim(); if (!号) continue;
    const nk = cartKeyOf(k, 号);
    if (j[nk]) continue;
    j[nk] = e; delete j[k]; moved++;
  }
  if (moved) { fs.writeFileSync(file + '.bak-migrate-' + Date.now(), JSON.stringify(j, null, 1)); fs.writeFileSync(file, JSON.stringify(j, null, 1)); }
  return { moved, 总数: Object.keys(j).length };
}

/**
 * 找选品车搜索框（**轮询**；冷标签/后台标签第一次 eval 常拿不到 → 单次快照 = 假阴性）
 * 踩过（09-12）：`SEARCH_NO_BOX` + 「扫到 0 行」，几分钟后手工看搜索框和 40 行都在。
 */
async function findCartSearchBox(reader, log = () => {}, rounds = 8) {
  let box = null;
  for (let i = 1; i <= rounds && !box; i++) {
    box = await reader.js(`(() => {
      const i = [...document.querySelectorAll('input')].find(x => x.offsetParent && ${CART_SEARCH_PH}.test(x.placeholder || ''));
      if (!i) return null; const r = i.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), ph: i.placeholder || '', val: i.value || '' };
    })()`).catch(() => null);
    if (!box && i < rounds) { try { await reader.send('Page.bringToFront', {}); } catch (e) {} await sleep(1200); }
  }
  if (!box) log({ stage: 'CART_SEARCH_NO_BOX', ok: false, 轮次: rounds, 说明: '轮询后仍没找到搜索框（未登录/标签失效）' });
  return box;
}

/**
 * 往选品车搜索框写值（React 原生 setter + input/change；⛔ `Input.insertText` 写不进 SPA 输入框）
 * @returns {Promise<boolean>} 是否写成功
 */
/** 在选品车搜索框上**回车**（提交查询）：CDP + JS 合成各发一次
 *
 *  ⚠️ 2026-09-20 修（用户："用搜索框搜索啊" / "就在第一个啊"）：
 *    后台/非前台标签上 **CDP 键盘事件和 `Input.insertText` 一样不落地** —— 实测
 *    `SEARCH_TYPED 期望:3837…1140 实得:""`（值没进去）、以及"值进去了但行数一直 40/45"（回车没生效），
 *    结果 `--find` 报 NOT_FOUND，而品**明明在选品车里**（用户当场看到就在第一行）。
 *    JS 合成 KeyboardEvent 走 React 的事件委托，不依赖页面/OS 焦点 → 这条才是可靠的那条。
 *  ⛔ 判据只有一个主人：`bit-cart-map.js` 的搜索框流程也调本函数，别再抄一份。 */
async function submitCartSearch(reader, log = () => {}) {
  try {
    await reader.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
    await reader.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
  } catch (e) {}
  const ok = await reader.js(`(() => {
    const i = [...document.querySelectorAll('input')].find(x => x.offsetParent && ${CART_SEARCH_PH}.test(x.placeholder || ''));
    if (!i) return false;
    i.focus();
    for (const t of ['keydown', 'keypress', 'keyup'])
      i.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    return true;
  })()`).catch(() => false);
  if (!ok) log({ stage: 'CART_SEARCH_ENTER_FAIL', ok: false, 说明: '搜索框没找到 → 回车没发出去' });
  return ok;
}

async function setCartSearch(reader, kw, log = () => {}) {
  const box = await findCartSearchBox(reader, log);
  if (!box) return false;
  const ok = await reader.js(`(() => {
    const i = [...document.querySelectorAll('input')].find(x => x.offsetParent && ${CART_SEARCH_PH}.test(x.placeholder || ''));
    if (!i) return false;
    i.focus();
    const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    s.call(i, ${JSON.stringify(String(kw))});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`).catch(() => false);
  if (!ok) { log({ stage: 'CART_SEARCH_SET_FAIL', ok: false, placehoder: box.ph }); return false; }
  await sleep(400);
  await submitCartSearch(reader, log);
  await sleep(1200);
  log({ stage: 'CART_SEARCH_SET', ok: true, 关键词: String(kw).slice(0, 20), 占位符: box.ph });
  return true;
}

/** 清掉搜索过滤（= 把搜索框清空 + 回车），并等行数回来 */
async function resetCartSearch(reader, log = () => {}) {
  const box = await findCartSearchBox(reader, log);
  if (!box) return false;
  if (!box.val) { log({ stage: 'CART_SEARCH_ALREADY_CLEAN', ok: true }); return true; }
  log({ stage: 'CART_SEARCH_RESET', ok: true, 原值: String(box.val).slice(0, 20), 说明: '清掉上一次查询留下的过滤（否则读全量只有 1 行）' });
  const ok = await setCartSearch(reader, '', log);
  await waitRows(reader, { log });
  return ok;
}

/**
 * 找某品在选品车里的行（三级：缓存 → 全量 → 搜索框）
 * @returns {Promise<{row:{商品ID:string,标题:string}|null, 来源:string|null, 诊断?:object}>}
 *   ⚠️ `row.商品ID` 是**选品车行键（联盟侧记录ID）**，即详情页要的 `id=`；⛔ 不是千川商品ID
 */
async function findCartRow(envId, { productId = '', title = '', log = () => {}, cache = null, account = '' } = {}) {
  // ① 缓存优先：m1 之前跑过 `bit-cart-map.js --find <商品ID>` 就已经写好了映射
  //    （`cache` 只是给单测注入用的；不传就读本地 cart-map.json）
  if (productId) {
    const c = cache ? cartCacheLookup(cache, productId, account) : readCartCache(productId, account);
    if (c) {
      log({ stage: 'CART_FROM_CACHE', ok: true, 商品ID: productId, 联盟ID: c.联盟ID, 标题: String(c.标题 || '').slice(0, 30) });
      return { row: { 商品ID: c.联盟ID, 标题: c.标题, 店铺: c.店铺, 佣金率: c.佣金率 }, 来源: '缓存' };
    }
    log({ stage: 'CART_CACHE_MISS', ok: false, 商品ID: productId, 说明: '缓存里没有该商品ID → 去选品车找（可先跑 bit-cart-map.js --find）' });
  }
  const reader = await makeCartReader(envId, log);
  try {
    // ② 全量（**先清掉自己留下的过滤**）
    await resetCartSearch(reader, log);
    const n = await waitRows(reader, { log });
    const readRows = async (pid, ttl) => {
      const res = await reader.js(buildRowsExpr(pid, ttl));
      const arr = ((res && res.命中) || (res && res.全部) || []).map((x) => ({ ...x, 标题: cleanCartTitle(x && x.标题) }));
      return { arr, 总行数: (res && res.总行数) || 0 };
    };
    // ⚠️ buildRowsExpr 的「商品ID」= 行键 = **联盟侧ID**，所以**不能**用它按千川商品ID过滤
    //    （SOP 〇之二 #10：商品ID 只在 hover「ID」标签的 tooltip 里）→ 全量这级只按标题匹配
    // ⚠️ 页面侧把行标题 slice(0,80) 过，台账标题可能更长 → 直接 indexOf 全名会假阴性。
    //    取前 20 字符当匹配键（选品车里一品一行，20 字足够唯一）。
    const titleKey = String(title).slice(0, 20);
    if (titleKey) {
      const r1 = await readRows('', titleKey);
      if (r1.arr.length) return { row: r1.arr[0], 来源: '全量(按标题)' };
    }
    if (n === 1 && !title) return { row: null, 来源: null, 诊断: { 行数: n, 说明: '车里只有 1 行且没给标题 → 不猜' } };
    // ③ 搜索框（用户定版：「肯定是要用搜索框的」「就用商品 id 搜索」）
    if (title) {
      log({ stage: 'CART_SEARCH_TRY', ok: true, 关键词: String(title).slice(0, 12), 说明: '全量没命中 → 用搜索框搜标题' });
      if (await setCartSearch(reader, titleKey, log)) {
        await waitRows(reader, { log, timeoutMs: 10000 });
        const r2 = await readRows('', titleKey);
        if (r2.arr.length) return { row: r2.arr[0], 来源: '搜索(标题)' };
      }
    }
    if (productId) {
      log({ stage: 'CART_SEARCH_TRY', ok: true, 关键词: productId, 说明: '用搜索框搜商品ID（用户定版口径）' });
      if (await setCartSearch(reader, productId, log)) {
        await waitRows(reader, { log, timeoutMs: 10000 });
        const r3 = await readRows('', '');
        log({ stage: 'CART_SEARCH_RESULT', 行数: r3.arr.length, 首行: (r3.arr[0] && r3.arr[0].标题 || '').slice(0, 30) });
        if (r3.arr.length === 1) return { row: r3.arr[0], 来源: '搜索(商品ID)' };
        if (r3.arr.length > 1 && title) {
          const hit = r3.arr.find((r) => (r.标题 || '').includes(String(title).slice(0, 6)));
          if (hit) return { row: hit, 来源: '搜索(商品ID)+标题校验' };
        }
        return { row: null, 来源: null, 诊断: { 行数: r3.arr.length, 说明: '按商品ID搜也不唯一/未命中 → 不猜（宁可失败）' } };
      }
    }
    return { row: null, 来源: null, 诊断: { 行数: n, 说明: '缓存/全量/搜索框三级都没命中' } };
  } finally {
    try { await reader.close(); } catch (e) {}
  }
}

/** 表格行采集表达式：商品ID=tr[data-row-key]，佣金率=表头「佣金率」列 */
function buildRowsExpr(pid, title) {
  return String.raw`(() => {
    const wantId = ${JSON.stringify(pid || '')};
    const wantTitle = ${JSON.stringify(title || '')};
    const heads = [...document.querySelectorAll('th')];
    let ci = heads.findIndex((h) => ((h.innerText || h.textContent || '')).indexOf('佣金率') >= 0);
    if (ci < 0) ci = 3;
    const KW = /(团长|高佣|佣金|专属|活动)/;
    const pickFrag = (cell) => {
      if (!cell) return null;
      const cands = [];
      for (const e of cell.querySelectorAll('*')) {
        if (e.children.length > 20) continue;
        const t = (e.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t || t.length > 60) continue;
        if (t.indexOf('%') < 0) continue;
        const hasKw = KW.test(t);
        const bare = /^\d+(\.\d+)?\s*%$/.test(t);
        if (!hasKw && !bare) continue;
        cands.push({ text: t, kw: hasKw ? 0 : 1, n: e.querySelectorAll('*').length });
      }
      cands.sort((a, b) => (a.kw - b.kw) || (a.n - b.n));
      return cands.length ? cands[0].text : null;
    };
    const rows = [...document.querySelectorAll('tr[data-row-key]')];
    const all = rows.map((r) => {
      const tds = [...r.querySelectorAll('td')];
      const cell = tds[ci] || null;
      const titleCell = tds[1] || null;
      return {
        商品ID: r.getAttribute('data-row-key'),
        标题: titleCell ? (titleCell.innerText || titleCell.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '',
        佣金片段: pickFrag(cell),
        佣金列原文: cell ? (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : null,
      };
    });
    let hit = all;
    if (wantId) hit = all.filter((x) => x.商品ID === wantId);
    else if (wantTitle) hit = hit.filter((x) => (x.标题 || '').indexOf(wantTitle) >= 0);
    return { 总行数: all.length, 佣金列: ci, 命中: hit, 全部: (wantId || wantTitle) ? null : all };
  })()`;
}

/**
 * 等表格出现 + 滚动加载全部行（选品车是虚拟滚动，只渲染可见行）
 * @returns {Promise<number>} 行数
 */
async function waitRows(reader, { timeoutMs = 15000, scrollPasses = 15, log = () => {} } = {}) {
  const t0 = Date.now();
  let n = 0;
  const count = async () => {
    try { return (await reader.js('document.querySelectorAll("tr[data-row-key]").length')) || 0; } catch (e) { return 0; }
  };
  // ① 先等首次渲染
  for (;;) {
    n = await count();
    if (n > 0) break;
    if (Date.now() - t0 > timeoutMs) { log({ stage: 'WAIT_ROWS', ok: false, 提示: '等表格超时，行数仍为 0（未登录/未加载完）' }); return 0; }
    await sleep(1000);
  }
  // ② 再滚动加载全部（虚拟滚动只渲染可见行）
  let last = n;
  for (let i = 0; i < scrollPasses; i++) {
    try {
      await reader.js(`(() => {
        const rows = [...document.querySelectorAll('tr[data-row-key]')];
        const last = rows[rows.length - 1];
        if (last) last.scrollIntoView({ block: 'end' });
        const sc = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 100 && e.getBoundingClientRect().height > 200)[0];
        if (sc) sc.scrollTop = sc.scrollHeight;
        window.scrollTo(0, document.body.scrollHeight);
        return true;
      })()`);
    } catch (e) {}
    await sleep(700);
    n = await count();
    if (n > last) { last = n; continue; }
    if (i >= 2 && n === last) { break; }   // 连续两次无增长即停
  }
  log({ stage: 'ROWS_LOADED', ok: true, 行数: n });
  return n;
}

/**
 * 读取选品车全表（一行一品）
 * @returns {Promise<{总行数:number, 佣金列:number, rows:Array}>}
 */
async function readCartRows(envId, { log = () => {}, resetSearch = true } = {}) {
  const reader = await makeCartReader(envId, log);
  try {
    // ⚠️ 默认先清掉搜索过滤（2026-09-13）：`bit-cart-map --find` 用完会留下过滤，
    //    不清就会把「全量」读成那一行 → 下游报"选品车没找到该品"（其实是自己挡的）。
    if (resetSearch) await resetCartSearch(reader, log);
    await waitRows(reader, { log });
    await sleep(400);
    const res = await reader.js(buildRowsExpr('', ''));
    // ⚠️ 读口统一清洗：页面侧标题单元格粘着「 ID 商品类目：」等行内控件文字
    const rows = ((res && res.全部) || []).map((x) => ({ ...x, 标题: cleanCartTitle(x && x.标题) }));
    return { 总行数: (res && res.总行数) || 0, 佣金列: res && res.佣金列, rows };
  } finally {
    try { await reader.close(); } catch (e) {}
  }
}

/**
 * 查单个商品（按商品ID 精确匹配，失败可退回标题）
 * @returns {Promise<{row:object|null, 总行数:number, 佣金列:number}>}
 */
async function fetchOne(envId, { productId, title, log = () => {}, resetSearch = true } = {}) {
  const reader = await makeCartReader(envId, log);
  try {
    if (resetSearch) await resetCartSearch(reader, log);
    await waitRows(reader, { log });
    await sleep(400);
    const res = await reader.js(buildRowsExpr(productId || '', title || ''));
    const row = (res && res.命中 && res.命中[0]) || null;
    return { row: row ? { ...row, 标题: cleanCartTitle(row.标题) } : null, 总行数: (res && res.总行数) || 0, 佣金列: res && res.佣金列 };
  } finally {
    try { await reader.close(); } catch (e) {}
  }
}

/**
 * ego 收尾：关掉本次进程开的 ego 空间（**不留窗口**）
 * 普通 node 下是空操作；ego 入口脚本在结束时调用一次（ego-transport 里还有 beforeExit 兜底）
 */
async function finishEgoSpace() {
  const ts = Object.values(_egoTasks);
  _egoTasksClear();
  if (!ts.length) return { ok: true, skipped: true };
  const out = [];
  for (const t of ts) out.push(await EGO.finishSpace(t, []));
  return { ok: true, 空间数: ts.length, 明细: out };
}
function _egoTasksClear() { for (const k of Object.keys(_egoTasks)) delete _egoTasks[k]; _egoTask = null; }

module.exports = { CART_URL, CART_MAP_FILE, makeCartReader, buildRowsExpr, readCartRows, fetchOne, waitRows, restoreWindow, tryEval, openFreshTab, cleanCartTitle, pidFromTooltip, TIMEOUT, finishEgoSpace,
                   cartCacheLookup, readCartCache, writeCartCache, migrateCartCache, cartKeyOf, CART_KEY_SEP, findCartSearchBox, setCartSearch, resetCartSearch, findCartRow, CART_SEARCH_PH,
                   submitCartSearch };
