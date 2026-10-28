'use strict';
/**
 * tab-reuse.js — 统一的「标签复用器」（用户 2026-09-11 明确：不要一直开标签，复用标签）
 *
 * 背景/教训：早期探针一律 openFreshTab（Target.createTarget），跑一次多一个标签，
 *           用户看到标签不断冒出来。仓库既有逻辑（bit-qc-lib.gotoAndWait）本来就是
 *           **按 origin 站级复用**：每个环境每站只留 1 个 tab。
 *
 * 本模块策略（比 gotoAndWait 更省一步）：
 *   1) 先在 /json/list 里找同 origin 的已开标签
 *   2) **URL 已经完全匹配就零导航直接附着**（保住页面上的表单/勾选状态，不刷新）
 *   3) 只是同站不同页 → 同 tab 内 navigate（导航前注入六件套）
 *   4) 实在没有同站标签 → 才新建（这是唯一会开标签的情况）
 *
 * close() 只断开 CDP 连接，**不关标签** —— 留给下次复用。
 *
 * 用法：
 *   const { attachSite } = require('./tab-reuse.js');
 *   const t = await attachSite(envId, url);          // 自动复用/导航
 *   await t.js('location.href');
 *   t.close();                                        // 只断连接
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = require('./bit-api.js');
const { Cdp } = require('./bit-cdp.js');
const { tryEval } = require('./commission-fetch.js');
const { execSync } = require('node:child_process');
const CONST = require('./qc-const.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify(o));

/**
 * 把浏览器窗口恢复正常并带到前台（**跨平台**）
 *
 * 为什么需要：比特窗口被最小化/隐藏时，Chrome 会**冻结渲染进程** → CDP 的 Runtime.evaluate 超时。
 * 原实现在 commission-fetch.js 里写死了 macOS 的 osascript，Windows 上会静默失效。
 * CDP 那部分（getWindowForTarget/setWindowBounds）本身跨平台；只有「提到前台」需要分平台。
 */
async function restoreWindowX(cdp, pid) {
  try {
    const w = await cdp.send('Browser.getWindowForTarget', {});
    await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } });
  } catch (e) {}
  try {
    if (!pid) return;
    if (process.platform === 'darwin') {
      execSync(`osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true'`, { timeout: 5000 });
    } else if (process.platform === 'win32') {
      // Windows：用 WScript.Shell.AppActivate 把该进程主窗口提到前台
      execSync(`powershell -NoProfile -Command "$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){$null=(New-Object -ComObject WScript.Shell).AppActivate($p.Id)}"`, { timeout: 8000 });
    }
    // 其它平台（Linux）：只靠 CDP 的 setWindowBounds，跳过前台激活
  } catch (e) { /* 前台激活失败不致命 */ }
}

/**
 * 附着到某环境里站点的标签（复用优先）
 * @param {string} envId  比特环境ID
 * @param {string} url    目标 URL
 * @param {object} [opt]  { logFn, timeout, noCreate }
 * @returns {{cdp, targetId, mode:'reuse'|'navigate'|'create', url, js, close}}
 */
/**
 * 同页判据（**复用优先的单一事实源**）：路径一致 + 目标的查询参数都被当前 URL 覆盖。
 * ⚠️ 不能要求全 URL 全等：`uni-prom?aavid=X` 与 `uni-prom?aavid=X&ct=1&dr=…` 是同一页，
 *    全等判据会把它们判成"要导航" → 每次调用整页刷新（用户："可以复用就复用不要一直刷新"）。
 */
function sameView(cur, want) {
  try {
    const c = new URL(cur), w = new URL(want);
    if (c.origin !== w.origin || c.pathname !== w.pathname) return false;
    for (const [k, v] of w.searchParams) if (c.searchParams.get(k) !== v) return false;
    return true;
  } catch (e) { return false; }
}

async function attachSite(envId, url, opt = {}) {
  const logFn = opt.logFn || (() => {});
  // ══ ego 运行时：同一个 tab 契约（js/send/close/blocked），换成 ego 传输 ══════════════
  // 用户 2026-09-22：「m3 m4 你要想办法换成 ego 的方式」。
  // 为什么在这条缝上做：`bit-m3-upload.js` / `bit-m4-upload.js` 都是 `attachSite()` 拿 tab，
  // 只要这里换实现，**两个脚本的判据一行不用改**（与 m8 用 makeEnvCtx 换传输同一套路）。
  // 返回形状对齐比特版 tab：{ env, js(e,ms), send(m,p), cdp:{send,js,eval}, close(), blocked }
  try {
    if (typeof taskSpace === 'function') {
      const EEC = require('./ego/ego-env-ctx.js');
      const ctx = EEC.makeEgoEnvCtx(envId, { log: logFn });
      const g = await ctx.gotoAndWait(url, { timeout: 25, waitUntil: 'domcontentloaded' });
      const page = await ctx.egoPage();
      const cur = String(await page.url().catch(() => ''));
      logFn({ stage: 'EGO_ATTACH_SITE', ok: true, env: envId, url: cur.split('?')[0] });
      return {
        env: envId, ego: true, url: cur, blocked: false, ageMs: 0,
        js: (e, ms) => ctx.js(e, ms),
        send: (m, p) => ctx.cdp(m, p),
        // ego 原生点击/按键（自带 actionability）—— 坐标点击在 ego 上偶发点不动
        click: (sel, opts) => ctx.egoClickSelector(sel, opts || {}),
        cdp: { send: (m, p) => ctx.cdp(m, p), js: (e, ms) => ctx.js(e, ms), eval: (e) => ctx.js(e), ws: null, acceptNextDialog: () => {}, click: (sel, opts) => ctx.egoClickSelector(sel, opts || {}) },
        // 暖会话：**不关空间**（ego 侧收尾统一走 ctx/编排层；关掉反而丢掉暖会话）
        close: () => {},
        ctx,
      };
    }
  } catch (e) {
    logFn({ stage: 'EGO_ATTACH_SITE_ERR', ok: false, env: envId, err: String(e.message || e).slice(0, 160), 说明: '回退比特链路' });
  }
  const target = new URL(url);
  const site = target.origin;
  const info = await api.open(envId);
  const list = async () => (await (await fetch(`http://${info.http}/json/list`)).json()) || [];
  const norm = (u) => String(u || '').split('#')[0].replace(/\/$/, '');
  // ⚠️ 2026-09-12 用户定位的弹窗来源：「切换到直投侧时，代投侧弹出『确定退出并放弃创建全域投放吗？』」
  //    根因 = 在**有草稿的创建页**上导航（URL 参数对不齐就判成"不同页"）。
  //    ⇒ 创建页（/uni-creation/product）只要路径相同 + aavid 一致就视为同页 → **零导航复用**。
  const sameDraftPage = (cur, want) => {
    try {
      const c = new URL(cur), w = new URL(want);
      if (!/\/uni-creation\/product/.test(c.pathname) || c.pathname !== w.pathname) return false;
      const ca = c.searchParams.get('aavid'), wa = w.searchParams.get('aavid');
      return !ca || !wa || ca === wa;
    } catch (e) { return false; }
  };
  const samePage = (u) => sameView(u, url) || sameDraftPage(u, url);
  const sameSite = (u) => String(u || '').startsWith(site) && !String(u).startsWith('chrome-extension://');

  let tabs = (await list()).filter((t) => t.type === 'page');
  // ⚠️ 绝不在"有草稿的创建页"上跳走（会弹原生确认并阻塞渲染进程 → CDP 全超时）：
  //    优先选已经在目标页 / 不在创建页的标签；只剩创建页而目标不是它 → 走新建分支
  const isDraftPage = (u) => /\/uni-creation\//.test(String(u || ''));
  const wantDraftPage = isDraftPage(url);
  let hit = tabs.find((t) => samePage(t.url))
         || tabs.find((t) => sameSite(t.url) && (!isDraftPage(t.url) || wantDraftPage))
         || (wantDraftPage ? tabs.find((t) => sameSite(t.url)) : null);

  if (!hit && opt.noCreate) return null;

  let mode, cdp;
  if (hit) {
    mode = samePage(hit.url) ? 'reuse' : 'navigate';
    logFn({ stage: 'TAB_REUSE', mode, 现有: String(hit.url).split('?')[0] });
    cdp = await Cdp.connectWs(hit.webSocketDebuggerUrl);
    await restoreWindowX(cdp, info.pid);
    if (mode === 'navigate') {
      // ⚠️ 六件套必须在导航前注册，否则首次加载裸奔（webdriver 暴露）→ 千川风控
      try { await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CONST.SIXPACK }); } catch (e) {}
      // 千川域导航过频会掉登录 → 走导航闸
      // ⚠️ 2026-09-13：撞闸**不再是失败**。批量连跑两个品时第二个品必然踩到
      //    （实测 `QCNAV_BLOCKED … 距今秒:113 闸门秒:120`），而调用方拿到
      //    `{blocked:true}` 后（m4/probe 都没检查）直接 `tab.js(...)` → 报
      //    `tab.js is not a function`（看着像脚本坏了，其实是限流）。
      //    ⇒ 撞闸 → **算出还要等多久 → 等窗口过去 → 自动重试**（导航闸的本意是
      //      "别太勤"，不是"不许走"）；等满仍不放行才把 blocked 交回调用方。
      let g = null, waitedMs = 0;
      for (let attempt = 1; attempt <= NAV_MAX_TRIES; attempt++) {
        g = await guardedNavigate({ send: (m, p) => cdp.send(m, p), url: hit.url }, url, { logFn, env: envId });
        if (!g.blocked) break;
        const wait = navWaitMs(g);
        if (attempt >= NAV_MAX_TRIES || wait > Math.max(0, NAV_WAIT_CAP_MS - waitedMs)) {
          logFn({ stage: 'QCNAV_WAIT_GIVEUP', ok: false, attempt, 已等秒: Math.round(waitedMs / 1000), 还需秒: Math.round(wait / 1000),
                  说明: '等满仍未放行（不是脚本坏了）→ 过 2 分钟原命令重跑即可；已完成步骤按台账 SKIP' });
          break;
        }
        logFn({ stage: 'QCNAV_WAIT', ok: true, attempt, 等秒: Math.round(wait / 1000), host: g.host, env: envId,
                说明: '导航闸（千川域过频会掉登录）→ 等窗口过去自动重试' });
        await sleepTicks(wait, (left) => logFn({ stage: 'QCNAV_WAIT_TICK', 剩余秒: Math.round(left / 1000) }));
        waitedMs += wait;
      }
      if (g && g.blocked) {
        try { cdp.close(); } catch (e) {}
        return { blocked: true, mode: 'blocked', host: g.host, ageMs: g.ageMs, gateMs: g.gateMs, 等过秒: Math.round(waitedMs / 1000) };
      }
    }
  } else {
    mode = 'create';
    logFn({ stage: 'TAB_CREATE', 说明: '该站无已开标签，新建（唯一会开标签的情况）', site });
    const browser = await Cdp.connectWs(info.ws);
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    await sleep(600);
    try { browser.close(); } catch (e) {}
    const nt = (await list()).find((t) => (t.id || t.targetId) === targetId);
    if (!nt) throw new Error('新标签未出现: ' + site);
    hit = nt;
    cdp = await Cdp.connectWs(nt.webSocketDebuggerUrl);
    await restoreWindowX(cdp, info.pid);
    try { await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CONST.SIXPACK }); } catch (e) {}
    await cdp.send('Page.navigate', { url });
  }

  try { await cdp.send('Page.bringToFront', {}); } catch (e) {}

  const timeout = opt.timeout || 20;
  try {
    await cdp.eval(`new Promise(res => { if (document.readyState === 'complete') return res(true);
      window.addEventListener('load', () => res(true), { once: true }); setTimeout(() => res(true), ${timeout * 1000}); })`);
  } catch (e) { /* 超时也让调用方继续，由它自己判断 */ }

  return {
    cdp,
    targetId: hit.id || hit.targetId,
    mode,
    url,
    js: (expr, ms) => tryEval(cdp, expr, ms || 8000),
    send: (m, p) => cdp.send(m, p),
    close: () => { try { cdp.close(); } catch (e) {} },   // ⚠️ 只断连接，不关标签
  };
}



// ══════════════════════════════════════════════════════════════════════════
// 千川页面「刷新闸」—— 2026-09-11 血的教训
//
// 事故：我为了校验状态，反复对千川页面发 Page.reload、并十几轮反复进创建页，
//       结果**把代投号(<代投号>)的千川会话刷掉了**，标签直接跳到 /login。
//       这正是项目早就写下的红线：「绝不反复刷新/导航千川页面」。
//
// 于是把红线做成代码级硬闸：**同一 host 在 minIntervalMs 内只允许 reload 一次**，
// 被拦下时打印 QCRELOAD_BLOCKED 而不是硬刷。所有脚本想刷新千川页面必须走这里。
// ══════════════════════════════════════════════════════════════════════════
// ⚠️ 2026-09-21 有意**不隔离**这一个文件：导航闸必须跨版本共享，否则两个版本各放各的
//    → 可能同一时刻各自导航千川 → 掉登录（当天已掉过一次）。
const THROTTLE_FILE = path.join(os.homedir(), '.qc-rebuild', 'visit-throttle.json');
// 需要严管的域：千川 + 精选联盟（这些后台对刷新最敏感）
const GUARDED_HOSTS = /^(qianchuan\.jinritemai\.com|buyin\.jinritemai\.com)$/;
const DEFAULT_MIN_INTERVAL_MS = parseInt(process.env.QC_RELOAD_MIN_MS || '600000', 10); // 默认 10 分钟

function _readThrottle() {
  try { return JSON.parse(fs.readFileSync(THROTTLE_FILE, 'utf8')); } catch (e) { return {}; }
}
// lastReload / lastNav 是全站共用（同一 host 只记最近一次）
function _writeThrottle(j) {
  try { fs.mkdirSync(path.dirname(THROTTLE_FILE), { recursive: true }); fs.writeFileSync(THROTTLE_FILE, JSON.stringify(j, null, 1)); } catch (e) {}
}

/**
 * 受闸保护的刷新：千川/联盟页面在 minIntervalMs 内只允许刷一次。
 * @returns {{reloaded:boolean, blocked?:boolean, ageMs?:number, host:string}}
 */
async function guardedReload(tab, opt = {}) {
  const logFn = opt.logFn || (() => {});
  let host = '';
  try { host = new URL(tab.url).host; } catch (e) { host = ''; }
  const min = opt.minIntervalMs || DEFAULT_MIN_INTERVAL_MS;
  if (!GUARDED_HOSTS.test(host)) {
    await tab.send('Page.reload', {}).catch(() => {});
    return { reloaded: true, host };
  }
  // ⚠️ 限流键必须带环境：不同比特环境是**独立浏览器**，a 环境访问过不该拦 b 环境
  //    （踩过：<号A>走了千川，把<号B>和代投一起拦了）
  const key = (opt.env || 'global') + '|' + host;
  const j = _readThrottle();
  const last = (j[key] && j[key].lastReload) || 0;
  const age = Date.now() - last;
  if (age < min) {
    logFn({ stage: 'QCRELOAD_BLOCKED', ok: false, host, env: opt.env || '',
            距今秒: Math.round(age / 1000), 闸门秒: Math.round(min / 1000),
            最近一次来自: crossKey && crossLast > (rec.lastNav || 0) ? (crossKey + '（**另一个版本**）') : key,
            原因: '千川页面刷新过频会掉登录（2026-09-11 事故）→ 已拦下，改用已加载的 DOM 读' });
    return { reloaded: false, blocked: true, ageMs: age, gateMs: min, host };
  }
  await tab.send('Page.reload', {}).catch(() => {});
  j[key] = Object.assign({}, j[key], { lastReload: Date.now() });
  _writeThrottle(j);
  return { reloaded: true, host };
}


// ── 导航闸：进千川页也不能太勤（用户 2026-09-11：「m4 你刷新太多次了，很多是可以复用的」）
//    复用（URL 已相同 → 零导航依附）**永远允许**；只有「要跳到另一个千川页」才受限。
const DEFAULT_NAV_MIN_MS = parseInt(process.env.QC_NAV_MIN_MS || '120000', 10); // 默认 2 分钟

// ── 撞闸后的自动等待（2026-09-13；批量连跑时第二个品必然踩到）
//    单个导航最多等 NAV_WAIT_CAP_MS（默认 5 分钟，够一个完整窗口 + 余量），最多重试 NAV_MAX_TRIES 次。
const NAV_WAIT_PAD_MS = parseInt(process.env.QC_NAV_PAD_MS || '2500', 10);        // 窗口边界余量
const NAV_WAIT_CAP_MS = parseInt(process.env.QC_NAV_WAIT_CAP_MS || '300000', 10); // 单次导航等待上限
const NAV_MAX_TRIES = parseInt(process.env.QC_NAV_TRIES || '3', 10);

/**
 * 撞闸后还要等多久（**纯函数**，便于单测）：`闸门秒 - 已过秒 + 余量`，钳到 [0, cap]。
 * @param {{gateMs?:number, ageMs?:number}} blk guardedNavigate 的 blocked 结果
 */
function navWaitMs(blk, opt = {}) {
  const pad = opt.pad === undefined ? NAV_WAIT_PAD_MS : opt.pad;
  const cap = opt.cap === undefined ? NAV_WAIT_CAP_MS : opt.cap;
  const gate = Number(blk && blk.gateMs) || 0;
  const age = Number(blk && blk.ageMs) || 0;
  return Math.min(Math.max(0, gate - age) + pad, cap);
}

/** 分段睡（每段 ≤20s 回调一次），避免"等 2 分钟"在日志里看起来像卡死 */
async function sleepTicks(ms, onTick) {
  const STEP = 20000;
  let left = ms;
  while (left > 0) {
    const d = Math.min(STEP, left);
    await new Promise((r) => setTimeout(r, d));
    left -= d;
    if (left > 0 && typeof onTick === 'function') { try { onTick(left); } catch (e) {} }
  }
}

/**
 * 导航闸等满仍不放行时，让调用方**明确失败**而不是继续用半个对象
 * （踩过：m4/probe 调 attachSite 后不检查 `.blocked` → `tab.js is not a function`，
 *   报错看着像脚本坏了，其实是限流闸；见 SOP 〇之二 #21「假成功」的同类问题）。
 */
function requireTab(tab, log) {
  if (tab && !tab.blocked) return tab;
  const ageSec = Math.round(((tab && tab.ageMs) || 0) / 1000);
  const e = new Error('NAV_BLOCKED: 导航闸等满仍未放行（' + ageSec + 's 前刚导航过该域）→ 过 2 分钟原命令重跑；'
    + '已完成步骤按台账 SKIP，不会重复建计划');
  e.code = 'NAV_BLOCKED';
  if (typeof log === 'function') { try { log({ stage: 'NAV_BLOCKED_ABORT', ok: false, err: e.message, host: (tab && tab.host) || '' }); } catch (x) {} }
  throw e;
}

/**
 * 受闸保护的导航（仅对千川/联盟域生效）
 * @returns {{navigated:boolean, blocked?:boolean, ageMs?:number, navCount?:number, host:string}}
 */
async function guardedNavigate(tab, url, opt = {}) {
  const logFn = opt.logFn || (() => {});
  let host = '';
  try { host = new URL(url).host; } catch (e) { host = ''; }
  if (!GUARDED_HOSTS.test(host) || opt.force) {
    await tab.send('Page.navigate', { url }).catch(() => {});
    return { navigated: true, host };
  }
  const min = opt.minIntervalMs || DEFAULT_NAV_MIN_MS;
  const key = (opt.env || 'global') + '|' + host;
  const j = _readThrottle();
  const rec = j[key] || {};
  // ⚠️ 2026-09-21（ego 变体专用）：**跨版本互斥** —— 闸文件与比特版共享，但 key 的命名两边不同
  //    （比特按 env hash、ego 按 profileId）→ 只看自己那把 key 等于没共享。
  //    所以这里额外取「该 host 下所有 key 的最新一次」，两个版本谁都别想抢先反复导航千川。
  let crossLast = 0, crossKey = '';
  for (const k of Object.keys(j)) {
    if (!k.endsWith('|' + host)) continue;
    const t = (j[k] && j[k].lastNav) || 0;
    if (t > crossLast) { crossLast = t; crossKey = k; }
  }
  const lastAny = Math.max(rec.lastNav || 0, crossLast);
  const age = Date.now() - lastAny;
  if (age < min) {
    logFn({ stage: 'QCNAV_BLOCKED', ok: false, host, env: opt.env || '',
            距今秒: Math.round(age / 1000), 闸门秒: Math.round(min / 1000),
            建议: '别为了「看一眼状态」反复进千川页；优先读已打开页面的 DOM，或直接复用当前页' });
    return { navigated: false, blocked: true, ageMs: age, gateMs: min, navCount: rec.navCount || 0, host };
  }
  await tab.send('Page.navigate', { url }).catch(() => {});
  j[key] = Object.assign({}, rec, { lastNav: Date.now(), navCount: (rec.navCount || 0) + 1 });
  _writeThrottle(j);
  return { navigated: true, host, navCount: j[key].navCount };
}

/** 看某 host 的访问统计（干跑排查用） */
function visitStats(host) {
  const j = _readThrottle();
  return host ? (j[host] || {}) : j;
}

module.exports = { attachSite, guardedReload, guardedNavigate, visitStats, restoreWindowX, sameView, GUARDED_HOSTS,
                   navWaitMs, requireTab, sleepTicks, NAV_WAIT_CAP_MS, NAV_WAIT_PAD_MS, NAV_MAX_TRIES };
