'use strict';
/**
 * ego-transport.js —— **ego 传输层**：与比特链路「同形」的 reader
 *
 * 设计原则（用户 2026-09-21：「ego 版老代码过度老了，我做过很多优化」）：
 *   ⛔ 不复制、不 fork 任何业务判据。这里**只提供传输**，判据仍然只有一个主人：
 *      `commission-fetch.js`（佣金/行采集）、`frag-code.js`（发号）、`short-title.js`、
 *      `roi-map.js`、`commission-parse.js`。
 *   ⇒ 目的：让**同一份 main 代码**跑在 ego 上，而不是回到 ego-legacy 的旧判据。
 *
 * 为什么可行（2026-09-21 实测，本机 ego lite 0.5.0.32）：
 *   · `taskSpace / listTaskSpaces / profiles` 是**真全局**——在被 `require` 的模块里也可见
 *   · `require(绝对路径)` 可用；`process.cwd()` 是 `/`、`process.argv` 拿不到、`process.env` 是沙箱
 *   · 所以判据「在不在 ego 里」= `typeof taskSpace === 'function'`（与 monitor 同一写法）
 *
 * 用法（只能在 ego 运行时里）：
 *   const T = require('<repo>/fp-matrix/bridge/ego/ego-transport.js')
 *   const reader = await T.makeEgoReader({ url: CF.CART_URL, log })
 *   // reader 与比特版同形：{ js, send, cdp, mode, close } —— 现有业务函数直接吃
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify(o));

/** 是否跑在 ego 运行时里（被 require 的模块里同样可见 → 这是全仓库唯一需要的判据） */
function inEgo() {
  try { return typeof taskSpace === 'function'; } catch (e) { return false; }
}

/**
 * 仓库根：**以本模块自身位置为准**（ego 沙箱拿不到 argv/env，且 cwd = `/`）
 *   __dirname = <root>/bridge/ego → 上两级即仓库根
 *   参数文件 / QC_ROOT 可覆盖（wrapper 会写参数文件）
 *   ⚠️ 曾经写死过某个仓库的绝对路径 —— 一搬仓库就会加载旧仓库的模块（测的是别人家的
 *      代码）。ego 层必须能跟着仓库走，所以这里只认自身位置。
 */
function repoRoot(paramsFile) {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  try {
    const p = JSON.parse(fs.readFileSync(paramsFile || TMP_DIR + '/params.json', 'utf8'));
    if (p && p.root) return String(p.root).replace(/\/$/, '');
  } catch (e) {}
  try { if (process.env && process.env.QC_ROOT) return String(process.env.QC_ROOT).replace(/\/$/, ''); } catch (e) {}
  const guess = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(guess, 'bridge', 'ego', 'ego-transport.js'))) return guess;
  return guess;
}

/**
 * 参数走**文件**（ego 沙箱拿不到 argv/env —— 仓库既有约定：/tmp/qc-ego/plan.txt、/tmp/qc-ego/monitor-params.json）
 * @param {string} name  脚本名，如 'm1-pick' → /tmp/qc-ego/m1-pick-args.json
 */
function readParams(name, fallbackFile) {
  const fs = require('node:fs');
  const file = fallbackFile || (TMP_DIR + '/' + name + '-args.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}
function writeParams(name, obj, file) {
  const fs = require('node:fs');
  try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch (e) {}
  const f = file || (TMP_DIR + '/' + name + '-args.json');
  fs.writeFileSync(f, JSON.stringify(obj, null, 1));
  return f;
}

/**
 * 开空间。**profileId = 登录态隔离单位**（ego 版的 `dyEnvs[].env`）
 *   ⚠️ profileId 只在**创建**空间时生效（ego 官方语义："new spaces only"）→ 复用时传了也无效。
 *   ⚠️ profile 只能由人在 ego GUI 里建（`help()` 全量 API 里**没有**创建 profile 的方法，
 *      只有 profiles() 列表 + taskSpace(name,{profileId})）。
 */
/** 个人 profile（**业务链路禁止落在它上面**）—— 用户 2026-09-21：「hetu 是我自己用的 profile」 */
function personalProfiles() {
  const path = require('node:path');
  try { const m = require(path.join(__dirname, 'ego-profiles.local.js')); if (Array.isArray(m.个人profiles)) return m.个人profiles; } catch (e) {}
  try { const m = require(path.join(__dirname, 'ego-profiles.example.js')); if (Array.isArray(m.个人profiles)) return m.个人profiles; } catch (e) {}
  return ['Default'];
}

async function openSpace(name, { profileId, allowPersonal = false } = {}) {
  // ⚠️ 2026-09-21 事故：不传 profileId → 落 **Default（hetu）= 用户个人 profile**，
  //    我把号A 的千川点进去了（污染）。⇒ 这里加硬闸：业务链路必须显式给 profile，
  //    或由 ego-profiles.local.js 的映射解析出来；确实要看个人 profile 时才 allowPersonal。
  const 目标 = profileId || null;
  const 个人 = personalProfiles();
  if (!allowPersonal && (!目标 || 个人.includes(目标))) {
    const e = new Error('PERSONAL_PROFILE_BLOCKED: 目标 profile = ' + (目标 || '默认(Default=hetu，个人 profile)')
      + ' —— 业务链路禁止落在个人 profile 上。请显式给 profileId（或让映射 ego-profiles.local.js 解析出号对应的 profile）；'
      + '确认要看个人 profile 时才传 allowPersonal');
    e.code = 'PERSONAL_PROFILE_BLOCKED';
    throw e;
  }
  const nm = name || ('qc ' + new Date().toISOString().slice(0, 19).replace('T', ' '));
  const task = profileId ? await taskSpace(nm, { profileId }) : await taskSpace(nm);
  LIVE_TASKS.add(task);
  return { task, name: nm, profileId: profileId || null };
}
/**
 * 把**认领来的**空间登记进收尾名单。
 * ⚠️ 为什么需要：`takeOverTaskSpace(id)` 走的是 runtime 全局，**绕过了 openSpace** ⇒ 不进 LIVE_TASKS，
 *    `finishAllSpaces()` / `beforeExit` 都收不到它 → 复用出来的窗口会留在屏幕上（违反「跑完就关」）。
 */
function registerTask(task) { if (task) LIVE_TASKS.add(task); return task; }
/**
 * 把空间登记为**"要留给人"**（`beforeExit` 与 `finishAllSpaces()` 都会跳过它）。
 * ⚠️ 2026-09-22 修：`keepSpace:true` 原来只跳过脚本自己那次 `finishAllSpaces`，
 *    `beforeExit` 兜底仍会把空间收掉 ⇒ "留着的窗口"其实没留住（重建只能新建空间、白跑一次导航闸）。
 */
function keepTask(task) { if (task) { LIVE_TASKS.add(task); KEEP_TASKS.add(task); } return task; }
/**
 * 把本次进程开过的**全部**空间登记为"留给人"（**暖会话模式**）。
 *
 * 用户 2026-09-22 纠正：「跟指纹没关系，我记得当时 bitbrowser 上操作的时候，那时候**一直没有关**
 *   相关的 profile」⇒ 比特那边环境窗口是**一直开着**的（同一浏览器实例、暖会话）；而我这边
 *   "每条计划跑完就关空间、下一条再新开"——关/开之间**会话态**（sessionStorage、页面内存里的
 *   ticket/msToken 之类）会重来一遍。
 *   实测：cookie 层身份（s_v_web_id / UIFID / passport_*）关开前后**完全一致** ⇒ 变的不是 cookie，
 *   但"一直开着"确是我与比特操作方式上的真实差异 ⇒ 改成空间不关、持续复用。
 */
function keepAllSpaces() { let n = 0; for (const t of LIVE_TASKS) { KEEP_TASKS.add(t); n++; } return { 保留: n }; }
/** **强制**收掉本次进程碰过的全部空间（连 KEEP 一起）—— 只给"显式声明不要暖会话"的入口用 */
async function finishAllSpacesForce(keep = []) {
  const out = [];
  for (const t of [...LIVE_TASKS]) { KEEP_TASKS.delete(t); out.push(await finishSpace(t, keep)); }
  return out;
}
async function finishSpace(task, keep = []) {
  if (task) LIVE_TASKS.delete(task);
  try { const r = await task.finish({ keep }); return r || { ok: true }; }
  catch (e) { return { ok: false, err: String(e.message || e).slice(0, 160) }; }
}
/** 收尾：把本次进程开过的空间全部关掉（**不留窗口**，用户 2026-09-12 的要求） */
async function finishAllSpaces(keep = []) {
  const out = [];
  for (const t of [...LIVE_TASKS]) {
    if (KEEP_TASKS.has(t)) { out.push({ ok: true, skipped: '交还用户中（登录闸）' }); continue; }
    out.push(await finishSpace(t, keep));
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// 登录闸 —— 遇登录页就**把控制权交给用户**，扫完码再接管接着跑
//
// 为什么这么设计（ego 原生能力，比特没有）：
//   · `task.handOff()` 把控制权交给用户；用户操作完由 `takeOverTaskSpace(spaceId)` 接管
//   · 这两个动作**跨进程**（handOff 后本轮脚本就该结束），所以状态落 `/tmp/qc-ego/login.json`
//   · 登录态存在 **profile** 里，不随空间关闭消失 ⇒ 验完可以把窗口关掉（见 README 的持久性实测）
// ⛔ 本模块只负责"开闸/验闸"，绝不代填账号密码、绝不代收验证码。
// ══════════════════════════════════════════════════════════════════════════

const SERVICE_URLS = {
  qianchuan: 'https://qianchuan.jinritemai.com/',
  oceanengine: 'https://business.oceanengine.com/',
  // 达人工作台（巨量百应）：根域就是工作台
  // ⚠️ 未登录时根域会被重定向到 `www.douyinec.com` 落地页 —— 靠 detectLogin 的
  //    **「落到别的域就算未登录」**判据识别（offHost），所以可以放心用根域。
  // ⛔ 不要再用 `buyin.jinritemai.com/login`：那是 404（nginx），2026-09-21 实测踩过。
  daren: 'https://buyin.jinritemai.com/',
  buyin: 'https://buyin.jinritemai.com/dashboard/merch-picking-cart',
  // 抖音创作者中心（作品管理/视频公开私密那条线）
  creator: 'https://creator.douyin.com/',
  douyin: 'https://www.douyin.com/user/self',
};
// ego 变体的临时目录（**与比特版隔离**）：参数/状态/登录闸都落这里
const TMP_DIR = '/tmp/qc-ego';
const LOGIN_STATE_FILE = TMP_DIR + '/login.json';
const LOGIN_URL_RE = /\/login|passport|\/sso|oceanengine\.com\/login|select-account/i;
const LOGIN_HINT_RE = /扫码登录|立即登录|请登录|登录后|手机登录|邮箱登录|发送验证码|验证码登录|选择账户|二维码|账号登录|其他方式登录/g;

/**
 * 判「当前页是不是要我登录/选账户」——**只看事实**，不猜
 * ⚠️ 2026-09-21 修：原来只认 `/login` 字样 + 页面提示词，漏了**「落到了别的域」**这种情况
 *    （`buyin.jinritemai.com` 未登录时被重定向到 `www.douyinec.com` 落地页 → 被误判成"已登录"，
 *      还把用户窗口关掉了）。⇒ 传 `expectHost` 时，落到别的 host 一律算"要登录"。
 */
async function detectLogin(page, { expectHost } = {}) {
  let url = '';
  try { url = String(await page.url()); } catch (e) {}
  let probe = { len: 0, head: '', hints: [] };
  try {
    probe = await page.evaluate(() => {
      const t = String((document.body && document.body.innerText) || '').replace(/\s+/g, ' ');
      return { len: t.length, head: t.slice(0, 200),
               hints: (t.match(/扫码登录|立即登录|请登录|手机登录|邮箱登录|发送验证码|选择账户|二维码|账号登录/g) || []).slice(0, 4),
               rows: document.querySelectorAll('tr[data-row-key]').length };
    });
  } catch (e) {}
  const landed = (() => { try { return new URL(url).host; } catch (e) { return ''; } })();
  const offHost = !!(expectHost && landed && !landed.endsWith(expectHost) && !expectHost.endsWith(landed));
  // ⚠️ 2026-09-21 假成功事故：页面读不到（url 空 & 正文 0）时，原来会**滑过所有登录特征 → 判"已登录"**。
  //    「读不到」既不是"已登录"也不是"未登录"，是**未知**；未知一律按"需要人工"处理（宁可多问一句，
  //     绝不报成功）—— 同类假成功在仓库坑表里已记了多起。
  const unknown = !url || (probe.len === 0 && probe.hints.length === 0);
  const isLogin = unknown || LOGIN_URL_RE.test(url) || offHost || (probe.hints.length > 0 && probe.len < 900);
  return { url, isLogin, unknown, landed, expectHost: expectHost || null, offHost, ...probe };
}

const saveLoginState = (o) => { try { require('node:fs').writeFileSync(LOGIN_STATE_FILE, JSON.stringify(o, null, 1)); } catch (e) {} };
const loadLoginState = () => { try { return JSON.parse(require('node:fs').readFileSync(LOGIN_STATE_FILE, 'utf8')); } catch (e) { return null; } };

/**
 * 开闸：打开服务页；若需要登录 → **handOff 交还用户**并留下 spaceId
 *
 * @param {object} o
 *   · profileId  在哪个 profile 里开（不传 = 默认 profile）
 *   · service    qianchuan | oceanengine | daren（达人工作台）| buyin | creator | douyin
 *   · url        直接指定地址（优先于 service）
 *   · spaceId    复用**上次交还给你的那个窗口**（takeOver 接管它，不再多开一个）；接管失败自动改为新开
 * @returns {Promise<object>} { ok:true, 已登录:true } 或 { ok:false, 需要人工:true, spaceId, 请做 }
 */
async function openLoginGate({ profileId, account, service = 'qianchuan', url, log: logFn = () => {}, spaceName, spaceId, selectAccount = false, keepSpace = false, allowPersonal = false } = {}) {
  let aavid = null;
  // ⚠️ 只要给了 account 就解析 aavid（**即使显式传了 profileId**）—— 否则"选账户"那步拿不到 ID
  if (account) {
    const rp = resolveProfile(account);
    if (rp.ok) {
      if (!profileId) profileId = rp.profileId || undefined;
      aavid = rp.aavid || null;
      logFn({ stage: 'PROFILE_RESOLVED', ok: true, 账号: rp.账号, profileId: profileId || '(未指定)', aavid: rp.aavid, 映射文件: rp.映射文件 });
    } else logFn({ stage: 'PROFILE_RESOLVE_FAIL', ok: false, account, err: rp.原因, 可选: rp.可选 });
  }
  const target = url || SERVICE_URLS[service] || service;
  const nm = spaceName || ('登录闸 · ' + (profileId || '默认 profile') + ' · ' + service + ' · ' + new Date().toISOString().slice(0, 19).replace('T', ' '));

  // ① 优先复用交还中的窗口（takeOver 可能要你在 ego 界面点一下批准）
  let task = null, reused = false;
  if (spaceId) {
    try {
      task = await takeOverTaskSpace(spaceId);
      LIVE_TASKS.add(task);
      reused = true;
      logFn({ stage: 'LOGIN_REUSE_SPACE', ok: true, spaceId, 说明: '接管上次交还的窗口（不再多开一个）' });
    } catch (e) {
      logFn({ stage: 'LOGIN_REUSE_SPACE', ok: false, spaceId, err: String(e.message || e).slice(0, 140), 说明: '接管失败 → 改为新开一个窗口' });
      task = null;
    }
  }
  if (!task) { const o = await openSpace(nm, { profileId, allowPersonal }); task = o.task; }

  const pages = await task.pages();
  const page = (pages && pages.length) ? pages[0] : await task.newPage();
  // ⚠️ 走导航闸：别为了"看一眼登录态"把千川/联盟域刷掉（2026-09-21 事故）
  const g = await gatedGoto(page, target, { log: logFn, envKey: profileId || 'ego-default' });   // 不提窗口（不打扰）
  if (g && g.blocked) {
    await finishSpace(task, []);
    return { ok: false, 撞闸: true, host: g.host, 距今秒: Math.round((g.ageMs || 0) / 1000), 闸门秒: Math.round((g.gateMs || 0) / 1000),
             说明: '该 profile 刚导航过这个域，闸门没放行 —— 等一会儿原命令重跑；**不要硬刷**（千川会掉登录）' };
  }
  await page.waitForTimeout(4500);
  let d = await detectLogin(page, { expectHost: (() => { try { return new URL(target).host; } catch (e) { return ''; } })() });

  // 停在巨量「选择账户」：按 aavid 选（`selectAccount` 显式传 true 才点，默认只报告候选）
  let picked = null;
  if (d.isLogin && aavid && /选择账户/.test(String(d.head || ''))) {
    picked = await selectAccountOption(page, { aavid, click: !!selectAccount, log: logFn });
    if (picked.已点击) {
      await page.waitForTimeout(6000);
      d = await detectLogin(page, { expectHost: (() => { try { return new URL(target).host; } catch (e) { return ''; } })() });
      logFn({ stage: 'ACCOUNT_AFTER_PICK', ok: !d.isLogin, 账号已进: !d.isLogin, url: String(d.url).split('?')[0] });
    }
  }

  if (!d.isLogin) {
    // 默认不留窗口（用户 2026-09-12「不想它一直开着」）；但登录/选账户这类"人想亲眼看一眼"的场景
    // 传 keepSpace=true 把窗口留着 —— 否则整个过程在人眼睛之外几秒跑完（用户 2026-09-21：「我都没看到你打开啊」）
    if (!keepSpace) await finishSpace(task, []);
    else { KEEP_TASKS.add(task); logFn({ stage: 'LOGIN_KEEP_SPACE', ok: true, spaceId: task.spaceId, 说明: 'keepSpace=true → 窗口留着给你看（看完说一声我关）' }); }
    return { ok: true, 已登录: true, spaceId: task.spaceId, profileId: profileId || '(默认 profile)', service, url: d.url, 复用了窗口: reused, 选了账户: picked || undefined, 留窗口: keepSpace };
  }

  const state = { spaceId: task.spaceId, profileId: profileId || null, service, url: target, aavid: aavid || null,
                  spaceName: reused ? ('登录闸（复用空间 ' + spaceId + '）') : nm, at: new Date().toISOString(),
                  检测: { url: d.url, hints: d.hints, len: d.len }, 选账户候选: picked || undefined };
  saveLoginState(state);
  KEEP_TASKS.add(task);   // ⚠️ 别让 beforeExit 兜底把交还给用户的窗口关掉
  logFn({ stage: 'LOGIN_NEEDED', ok: false, 需要人工: true, ...state,
          请做: '在 ego 里那个窗口完成登录（' + (service === 'daren' ? '抖音扫码登录达人工作台' : '扫码 / 收验证码') + '），'
              + '完成后回我一句"扫好了"，我用 takeOverTaskSpace(' + task.spaceId + ') 接管并验证' });
  // ⚠️ 交还前必须把窗口提到眼前，否则用户"看不到我在干什么"（2026-09-21 实测踩过）
  try { const rw = await raiseWindow(page); logFn({ stage: 'LOGIN_RAISE_WINDOW', ok: true, ...rw }); } catch (e) {}
  try { await task.handOff(); logFn({ stage: 'LOGIN_HANDOFF', ok: true, spaceId: task.spaceId, 说明: '控制权已交还用户；空间保持打开（不会被自动收尾）' }); }
  catch (e) { logFn({ stage: 'LOGIN_HANDOFF', ok: false, err: String(e.message || e).slice(0, 160) }); }
  return { ok: false, 需要人工: true, ...state };
}

/**
 * 验闸：接管上次交还的空间，确认登录态；**验过就关窗口**（登录态在 profile 里，不会丢）
 */
async function resumeLoginGate({ spaceId, log: logFn = () => {} } = {}) {
  const st = loadLoginState();
  const id = spaceId || (st && st.spaceId);
  if (!id) return { ok: false, err: '没有可接管的 spaceId（先跑 open 模式）' };
  let task;
  try { task = await takeOverTaskSpace(id); }
  catch (e) { return { ok: false, spaceId: id, err: 'takeOverTaskSpace 失败: ' + String(e.message || e).slice(0, 160),
                       提示: '可能需要在 ego 界面里批准这次接管' }; }
  LIVE_TASKS.add(task); KEEP_TASKS.delete(task);

  const pages = await task.pages();
  const page = (pages && pages.length) ? pages[0] : (await task.tabs())[0] && (await task.tabs())[0].page;
  if (!page) { await finishSpace(task, []); return { ok: false, spaceId: id, err: '空间里没有可用的页' }; }

  let d = await detectLogin(page, { expectHost: (() => { try { return new URL((st && st.url) || '').host; } catch (e) { return ''; } })() });
  // 读不到页面（unknown）→ **不导航、不报成功**，如实交回人工
  if (d.unknown) {
    KEEP_TASKS.add(task);
    logFn({ stage: 'LOGIN_UNREADABLE', ok: false, 需要人工: true, spaceId: id, url: d.url,
            说明: '页面读不到（url/正文都为空）→ 既不能判已登录也不能判未登录；窗口留着，请人工看一眼' });
    return { ok: false, 需要人工: true, 读不到页面: true, spaceId: id, ...d };
  }
  // 只有"还在登录页"才补一次导航（⛔ 且**必须过闸**：千川域别反复刷）
  if (d.isLogin) {
    const target = (st && st.url) || SERVICE_URLS[(st && st.service) || 'qianchuan'];
    const g = await gatedGoto(page, target, { log: logFn, envKey: (st && st.profileId) || 'ego-default' });
    if (g && g.blocked) {
      KEEP_TASKS.add(task);
      return { ok: false, 需要人工: false, 撞闸: true, host: g.host, 距今秒: Math.round((g.ageMs || 0) / 1000), spaceId: id,
               说明: '刚导航过该域、闸门未放行 → 等一会儿再 resume；窗口留着（空间不会被收尾）' };
    }
    await page.waitForTimeout(4500);
    d = await detectLogin(page, { expectHost: (() => { try { return new URL(target).host; } catch (e) { return ''; } })() });
  }
  const out = { spaceId: id, profileId: (st && st.profileId) || null, service: (st && st.service) || null,
                已登录: !d.isLogin, 读到页面: !d.unknown, url: d.url, 正文长度: d.len, 提示词: d.hints };
  if (d.isLogin) {
    KEEP_TASKS.add(task);   // 还没登好 → 继续留给用户
    logFn({ stage: 'LOGIN_STILL_NEEDED', ok: false, 需要人工: true, ...out,
            请做: '还在登录页 —— 在那个窗口里继续完成登录，然后再回我一句' });
    return { ok: false, 需要人工: true, ...out };
  }
  const f = await finishSpace(task, []);
  logFn({ stage: 'LOGIN_OK', ok: true, ...out, 收尾: f && f.closedSpace ? 'closedSpace' : JSON.stringify(f).slice(0, 80),
          说明: '登录态已确认；窗口已关（登录态存在 profile 里，不随空间关闭消失）' });
  return { ok: true, ...out };
}

// ⚠️ 兜底：脚本忘了收尾也不能留下窗口 —— 进程退出前统一 finish（ego 运行时是真 Node，事件循环空转时触发）
const LIVE_TASKS = new Set();
// 登录闸交还给用户的空间放这里：beforeExit 兜底**必须跳过**，否则会把你正在扫码的窗口关掉
const KEEP_TASKS = new WeakSet();
let _exiting = false;
if (inEgo()) {
  try {
    process.on('beforeExit', async () => {
      if (_exiting) return;
      _exiting = true;
      await finishAllSpaces([]);
    });
  } catch (e) { /* 拿不到 process 就算了，显式调用 finishAllSpaces 仍可用 */ }
}

/** 空间里的全部标签（含未托管）：ego 没有 /json/list，这是唯一的枚举口 */
async function listTabs(task) {
  const tabs = (await task.tabs()) || [];
  return tabs.map((t) => ({
    label: t.label || null, targetId: t.targetId, title: t.title, url: t.url,
    active: !!t.active, openedBy: t.openedBy || null, page: t.page,
  }));
}

/** 同页判据：**直接用 tab-reuse.js 的 sameView（单一事实源）**，绝不在这里另造一份 */
function sameViewShared(cur, want) {
  try { return require('../tab-reuse.js').sameView(cur, want); } catch (e) { return false; }
}
function sameOrigin(cur, want) {
  try { return new URL(cur).origin === new URL(want).origin; } catch (e) { return false; }
}

function samePath(cur, want) {
  try { const c = new URL(cur), w = new URL(want); return c.origin === w.origin && c.pathname === w.pathname; } catch (e) { return false; }
}

/**
 * 把 **OS 窗口**提到前台（不是只提标签！）
 *
 * 为什么必须有（用户 2026-09-21：「我都没看到你打开啊 / 就一个新标签界面」）：
 *   我此前只调 `Page.bringToFront` —— 那只把**标签**在窗口内激活，**不会把窗口**从最小化/被遮挡
 *   状态提到眼前，用户看到的是他自己的窗口（一个新标签页），于是完全不知道我在干什么。
 *   比特版早就解决过这件事：`tab-reuse.restoreWindowX()` = `Browser.getWindowForTarget` +
 *   `Browser.setWindowBounds({windowState:'normal'})` + macOS `osascript` 激活前台。
 *   ⇒ 传输层换了，这一步也得跟着搬（同"闸不能换掉"的道理）。
 * ⚠️ 交接给用户前**必须**调用：否则你让人扫码，他却看不到窗口。
 */
/**
 * 挑一个**可以续用/复用**的标签（不新建）。用户 2026-09-23：「我不是让你可以续用或者复用标签要续用跟复用吗？」
 *
 * 优先级：
 *   ① **重复页**（同一 pathname 出现 ≥2 次）—— 这类拿一个来续用最安全（另一个还在）
 *   ② **监视类残留**（创作者中心内容管理 / 抖音主页）—— 本来就该收，拿来续用等于顺手清掉
 *   ③ **同域页**（同 host）
 * ⛔ 绝不碰：草稿创建页（`/uni-creation/`）、发布页（`/content/post`）、以及正在被复用的商品决策页。
 * @returns {{tab:object, why:string}|null}
 */
function pickReusableTab(tabs, url) {
  const list = Array.isArray(tabs) ? tabs : [];
  const u = String(url || '');
  const host = (() => { try { return new URL(u).host; } catch (e) { return ''; } })();
  const 路径 = (x) => { try { return new URL(String(x)).pathname; } catch (e) { return ''; } };
  const 保护 = (x) => /\/uni-creation\/|\/content\/post/.test(String(x));
  const 监视 = (x) => /creator-micro\/content\/manage/.test(String(x)) || /^https:\/\/www\.douyin\.com\/user/.test(String(x));
  const 可用 = list.filter((t) => t && !保护(t.url));
  const 计数 = new Map();
  for (const t of 可用) 计数.set(路径(t.url), (计数.get(路径(t.url)) || 0) + 1);
  const dup = 可用.filter((t) => 计数.get(路径(t.url)) >= 2);
  if (dup.length) return { tab: dup[0], why: '重复页（同类有多个，拿一个续用）' };
  const mon = 可用.filter((t) => 监视(t.url));
  if (mon.length) return { tab: mon[0], why: '监视残留页（顺手续用/收掉）' };
  const same = 可用.filter((t) => { try { return new URL(String(t.url)).host === host; } catch (e) { return false; } });
  if (same.length) return { tab: same[0], why: '同域页续用' };
  return null;
}

/**
 * **取一个能用的标签** —— 用户 2026-09-23 定的规则：
 *   「同域的标签页只要留一个 直接刷新续用复用」
 *
 * 顺序：
 *   ① 同 URL 精确命中 → 直接用（不刷新）
 *   ② **同域已有标签** → 挑一个 → **把同域多余的关掉（只留这一个）** → `goto(url)` 即"刷新续用"
 *   ③ 都没有 → 腾位后新建
 * ⛔ 受保护的页永不关、永不导航走：草稿创建页（`/uni-creation/`）、发布页（`/content/post`）。
 * @returns {{page:object, mode:string, closed:string[]}}
 */
async function acquireTab(task, url, { log = () => {}, 保护 = /\/uni-creation\/|\/content\/post/ } = {}) {
  const want = String(url || '');
  const tabs = (await listTabs(task)).filter((t) => t && !保护.test(String(t.url || '')));
  const 路径 = (x) => { try { const u = new URL(String(x)); return u.origin + u.pathname; } catch (e) { return String(x).split('?')[0]; } };
  const host = (() => { try { return new URL(want).host; } catch (e) { return ''; } })();
  const 同域 = tabs.filter((t) => { try { return new URL(String(t.url)).host === host; } catch (e) { return false; } });

  // ① 同 URL 直接用
  const 精确 = tabs.find((t) => String(t.url || '').split('#')[0] === want.split('#')[0]);
  if (精确) {
    const page = 精确.label ? task.page(精确.label) : await task.adopt(精确.page);
    return { page, mode: 'reuse-exact', closed: [] };
  }

  // ② 同域续用：挑一个 → 关掉同域多余的（只留一个）→ 刷新续用
  if (同域.length) {
    const 计数 = new Map();
    for (const t of 同域) 计数.set(路径(t.url), (计数.get(路径(t.url)) || 0) + 1);
    const 选 = 同域.find((t) => 计数.get(路径(t.url)) >= 2) || 同域.find((t) => /creator-micro\/content\/manage/.test(String(t.url))) || 同域[0];
    const closed = [];
    for (const t of 同域) {
      if (t.label === 选.label || t === 选) continue;
      try { const p2 = t.label ? task.page(t.label) : await task.adopt(t.page); await p2.close(); closed.push(String(t.url).split('?')[0]); } catch (e) {}
      await sleep(250);
    }
    const page = 选.label ? task.page(选.label) : await task.adopt(选.page);
    if (closed.length) log({ stage: 'TAB_SAME_HOST_TRIM', ok: true, 留下: String(选.url).split('?')[0], 关了同域多余的: closed });
    return { page, mode: 'reuse-same-host(刷新续用)', closed };
  }

  // ③ 新建（先腾位）
  await ensureTabRoom(task, log, 1);
  const page = await task.newPage();
  return { page, mode: 'new', closed: [] };
}

/**
 * ego 每个空间有**标签上限（实测 8 个）**：满了再 `task.newPage()` 会抛
 *   `Page budget reached (8/8) in space "…"` ⇒ 上层脚本直接炸
 *   （2026-09-23 实盘：m6 确认就因某个号的空间堆到 8/8 而失败，日志只有 BOOT/OPEN_FAIL）。
 *
 * ⇒ 开新标签前先**自动腾位**：只清**明确可清理**的，绝不碰业务页/用户正在看的页。
 *   可清理 = ① 创作者中心内容管理（监视残留）② 抖音主页/作品页（监视残留）
 *            ③ 重复的千川 uni-prom（保留第一个）④ 选品库页（非选品车、非商品决策页）
 *   一律保留：选品车、商品决策页、任何其它页、以及"每类里的第一个"。
 */
async function ensureTabRoom(task, log = () => {}, need = 1) {
  const BUDGET = 8, 目标 = BUDGET - need - 1;          // 留一点余量
  const 看 = async () => (await listTabs(task)).map((t) => ({ t, u: String(t.url || '') }));
  let tabs = await 看();
  if (tabs.length <= 目标) return { ok: true, 现有: tabs.length, 关了: [] };
  const 是监视类 = (u) => /creator\.douyin\.com\/creator-micro\/content\/manage/.test(u) || /^https:\/\/www\.douyin\.com\/user/.test(u);
  const 是选品库 = (u) => /buyin\.jinritemai\.com\/dashboard\/merch-picking-library(\?|$)/.test(u);
  let 见过千川 = false;
  const 关了 = [];
  for (const x of tabs) {
    if ((await 看()).length <= 目标) break;
    const u = x.u;
    let 可清 = false;
    if (是监视类(u)) 可清 = true;
    else if (是选品库(u)) 可清 = true;
    else if (/qianchuan\.jinritemai\.com\/uni-prom/.test(u)) { if (见过千川) 可清 = true; else 见过千川 = true; }
    if (!可清) continue;
    try {
      const p = x.t.label ? task.page(x.t.label) : await task.adopt(x.t.page);
      await p.close();
      关了.push(u.split('?')[0]);
    } catch (e) { /* 关不掉就算了 */ }
    await sleep(300);
  }
  const 后 = (await 看()).length;
  if (关了.length) log({ stage: 'TAB_ROOM_FREED', ok: true, 前: tabs.length, 后, 关了,
    说明: 'ego 空间标签上限 8 → 开新页前自动腾位（只清监视残留/重复页）' });
  return { ok: 后 <= 目标, 现有: 后, 关了 };
}

async function raiseWindow(page) {
  const out = {};
  try {
    const w = await page.cdp('Browser.getWindowForTarget', {});
    if (w && w.windowId != null) {
      await page.cdp('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } });
      out.windowId = w.windowId;
    }
  } catch (e) { out.boundsErr = String(e.message || e).slice(0, 100); }
  try {
    if (process.platform === 'darwin') {
      require('node:child_process').execSync('osascript -e \'tell application "ego lite" to activate\'', { timeout: 4000 });
      out.activated = 'ego lite';
    }
  } catch (e) { out.activateErr = String(e.message || e).slice(0, 100); }
  try { await page.cdp('Page.bringToFront', {}); } catch (e) {}
  return out;
}

/**
 * 受闸导航 —— **必须走仓库自带的导航闸**（`tab-reuse.guardedNavigate` + `GUARDED_HOSTS`）
 *
 * 为什么（2026-09-21 我亲手踩的事故，血的教训）：
 *   我第一版 ego 层直接用 `page.goto()` → 绕过了闸 → 15 分钟里对 `qianchuan.jinritemai.com`
 *   导航了 4 次（3 个 profile 各一次 + 一次复测）→ **Profile 2「号B」的千川登录掉了**，
 *   从完整后台跳回 `business.oceanengine.com/login`。
 *   而仓库早就写下了红线并做成了代码级硬闸：「千川页面刷新/导航过频会掉登录（2026-09-11 事故）」。
 *   ⇒ 教训：**传输层换了，闸不能换掉**。
 * 闸键 = `profileId|host`（与比特侧「不同环境是独立浏览器，不该互相拦」同一个道理）。
 * 已相同页的**复用永远允许**（零导航不受闸限制）—— 只有"要跳到另一个千川/联盟页"才受限。
 */
async function gatedGoto(page, url, { log: logFn = () => {}, envKey = 'ego-default', force = false, send } = {}) {
  const TR = require('../tab-reuse.js');
  const sendFn = send || ((m, p) => page.cdp(m, p));
  let cur = '';
  try { cur = String(await page.url()); } catch (e) {}
  let g = null, waitedMs = 0;
  for (let attempt = 1; attempt <= TR.NAV_MAX_TRIES; attempt++) {
    g = await TR.guardedNavigate({ send: sendFn, url: cur }, url, { logFn, env: envKey, force });
    if (!g.blocked) return g;
    const wait = TR.navWaitMs(g);
    if (attempt >= TR.NAV_MAX_TRIES || wait > Math.max(0, TR.NAV_WAIT_CAP_MS - waitedMs)) break;
    logFn({ stage: 'EGO_NAV_WAIT', ok: true, attempt, 等秒: Math.round(wait / 1000), host: g.host, env: envKey,
            说明: '导航闸（千川/联盟域过勤会掉登录）→ 等窗口过去自动重试' });
    await TR.sleepTicks(wait, (left) => logFn({ stage: 'EGO_NAV_WAIT_TICK', 剩余秒: Math.round(left / 1000) }));
    waitedMs += wait;
  }
  logFn({ stage: 'EGO_NAV_BLOCKED', ok: false, host: g && g.host, env: envKey,
          距今秒: Math.round(((g && g.ageMs) || 0) / 1000), 闸门秒: Math.round(((g && g.gateMs) || 0) / 1000),
          等过秒: Math.round(waitedMs / 1000),
          说明: '等满仍未放行 → **不要硬刷千川**（会掉登录）；过几分钟原命令重跑即可' });
  return g;
}

/**
 * 附着到某站点的页（**复用优先，零导航**；与 attachSite 同精神）
 * ⚠️ 2026-09-21 smoke 实测修正：原来用「norm(url) 全等」判同页 —— 页面自己跳转后多了
 *    `?universal_page_params_id=…`，于是每次调用都判成"要导航" → **反复刷新选品车**。
 *    ⇒ 改用 `sameView`（目标的参数被当前页覆盖即算同页），与比特链路同一个判据主人。
 * @returns {{page:object, mode:'reuse'|'navigate'|'create', blocked?:boolean}}
 */
async function attachPage(task, url, { log: logFn = () => {}, envKey = 'ego-default', raise = false } = {}) {
  const tabs = await listTabs(task);
  let hit = tabs.find((t) => sameViewShared(t.url, url)) || tabs.find((t) => sameOrigin(t.url, url));

  let page, mode;
  if (hit && hit.label) {
    page = task.page(hit.label);
    mode = sameViewShared(hit.url, url) ? 'reuse' : 'navigate';
  } else if (hit && !hit.label) {
    page = await task.adopt(hit.page);      // 未托管的标签要先认领才能操作
    mode = sameViewShared(hit.url, url) ? 'reuse' : 'navigate';
  } else {
    const pages = await task.pages();
    page = (pages && pages.length) ? pages[0] : await task.newPage();
    mode = 'create';
  }
  logFn({ stage: 'EGO_ATTACH', mode, env: envKey, 命中: hit ? String(hit.url).split('?')[0] : null,
          现有标签: tabs.map((t) => String(t.url || '').split('?')[0]).slice(0, 5) });

  if (mode !== 'reuse') {
    const g = await gatedGoto(page, url, { log: logFn, envKey });
    if (g && g.blocked) return { blocked: true, page, mode: 'blocked', host: g.host, ageMs: g.ageMs, gateMs: g.gateMs };
  }
  // ⚠️ 默认**不提窗口**（用户 2026-09-21：「我为什么要用 ego？因为 ego 在你操作的时候
  //    我可以用电脑，不会影响到我」）。只在**需要人动手**（登录/扫码 handOff）时才 raise。
  if (raise) { try { const rw = await raiseWindow(page); logFn({ stage: 'EGO_RAISE_WINDOW', ok: true, ...rw }); } catch (e) {} }
  // 六件套：导航前注册才对下次加载生效（对当前已加载页无效，与比特版同语义）
  try { await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: require('../qc-const.js').SIXPACK }); } catch (e) {}
  try { await page.waitForLoadState('load', { timeout: 20000 }); } catch (e) {}
  return { page, mode };
}

/**
 * 域路由（**2026-09-21 smoke 实测修正**）：
 *   默认走 **page.cdp**（页会话自带 target，`Browser.getWindowForTarget {}` 这样不带 targetId 的调用才成立）；
 *   只有 `Target.*` 这类页会话发不出去的才走 **task.cdp**，并保留一次互备重试。
 *   ⚠️ 一开始按「Browser.* → task.cdp」路由，实测报 `No web contents in the target`
 *      —— task.cdp 是浏览器级会话，缺 targetId。别按域前缀想当然。
 */
function makeCdp(page, task) {
  return {
    async send(method, params = {}) {
      const forTask = /^Target\./.test(method);
      if (forTask) {
        try { return await task.cdp(method, params); }
        catch (e) { return await page.cdp(method, params); }
      }
      try { return await page.cdp(method, params); }
      catch (e) {
        if (/^(Browser|Target)\./.test(method)) return await task.cdp(method, params);
        throw e;
      }
    },
    async eval(expr) { return await page.evaluate(expr); },
  };
}

/** evaluate 无内建超时 → 自己加一层（比特版 cdp.eval 也是 10s 超时保护） */
async function evalWithTimeout(page, expr, ms = 10000) {
  return Promise.race([
    page.evaluate(expr),
    sleep(ms).then(() => { throw new Error('EGO_EVAL_TIMEOUT(' + ms + 'ms)'); }),
  ]);
}

/**
 * 造一个 ego reader —— **返回形状与比特版 makeCartReader 完全一致**：{ js, send, cdp, mode, close }
 * 下游（waitRows / buildRowsExpr / findCartSearchBox / setCartSearch / submitCartSearch）原样可用。
 */
async function makeEgoReader({ url, log: logFn = () => {}, spaceName, task: reuseTask, profileId, account, allowPersonal = false, raise = false } = {}) {
  if (!inEgo()) throw new Error('NOT_IN_EGO：ego-transport 只能在 `ego-browser nodejs` 运行时里用');
  // 给了账号名（号A/前缀/目录编号/aavid）就按映射表解析出 profileId
  if (!profileId && account) {
    const rp = resolveProfile(account);
    if (rp.ok) { profileId = rp.profileId || undefined; logFn({ stage: 'PROFILE_RESOLVED', ok: true, 账号: rp.账号, profileId: rp.profileId, aavid: rp.aavid, 映射文件: rp.映射文件 }); }
    else logFn({ stage: 'PROFILE_RESOLVE_FAIL', ok: false, account, err: rp.原因, 可选: rp.可选, 映射文件: rp.映射文件 });
  }
  const opened = reuseTask ? { task: reuseTask, name: reuseTask.name, profileId: profileId || null } : await openSpace(spaceName, { profileId, allowPersonal });
  const task = opened.task;
  const envKey = profileId || opened.profileId || 'ego-default';
  const att = await attachPage(task, url, { log: logFn, envKey, raise });
  // ⚠️ 撞闸要**明确失败**，不能让调用方拿着半个对象继续跑（仓库坑表 #21 的同类：假成功）
  if (att.blocked) {
    const e = new Error('NAV_BLOCKED: 导航闸等满仍未放行（' + Math.round((att.ageMs || 0) / 1000) + 's 前刚导航过 '
      + att.host + '）→ 过几分钟原命令重跑；已完成步骤按台账 SKIP');
    e.code = 'NAV_BLOCKED';
    throw e;
  }
  const cdp = makeCdp(att.page, task);
  return {
    transport: 'ego',
    task, spaceName: opened.name, profileId: opened.profileId, envKey,
    page: att.page, mode: att.mode, cdp,
    js: (expr, ms) => evalWithTimeout(att.page, expr, ms || 10000),
    send: cdp.send,
    // ⚠️ 只断连接、**不关标签/不关空间**（与比特版 close 同语义）；收尾由调用方 finishSpace 决定
    close: async () => {},
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 账号 ↔ profile 映射（**ego 版的 `dyEnvs[].env`**）
//
// 为什么必须有这张表：比特"一个环境一个号"，**不会出现"选哪个账户"的歧义**；
//   ego 是 profile 隔离登录态，像 `Default` 这种 profile 里可能同时躺着号A 与代投的
//   巨量登录 → 页面上就弹「选择账户」。所以要把「哪个号 → 哪个 profile / 哪个 aavid」
//   显式写下来（真值在 gitignored 的 `ego-profiles.local.js`），匹配一律**按 aavid**，
//   与仓库口径一致（「下拉选项带 ID:xxx → 按 ID 匹配，比名字精准」）。
// ══════════════════════════════════════════════════════════════════════════
function loadProfileMap() {
  const path = require('node:path');
  for (const f of ['ego-profiles.local.js', 'ego-profiles.example.js']) {
    try {
      const m = require(path.join(__dirname, f));
      if (m && m.accounts) return { file: f, accounts: m.accounts };
    } catch (e) {}
  }
  return { file: null, accounts: {} };
}

/** 用 号名 / 前缀 / 目录编号 / aavid 任一都能查到 { profileId, aavid, ... } */
function resolveProfile(key) {
  const { file, accounts } = loadProfileMap();
  const k = String(key == null ? '' : key).trim();
  if (!k) return { ok: false, 原因: '没给账号（号名/前缀/目录编号/aavid 都行）', 映射文件: file };
  for (const [name, v] of Object.entries(accounts)) {
    const dirs = Array.isArray(v.dirs) ? v.dirs.map(String) : [];
    const hit = name === k || v['号'] === k || v.prefix === k || v.aavid === k || v.name === k
      || dirs.includes(k) || (v.name && (v.name.includes(k) || k.includes(v.name)));
    if (hit) return { ok: true, 账号: name, ...v, 映射文件: file };
  }
  return { ok: false, 原因: '映射里没有「' + k + '」', 映射文件: file, 可选: Object.keys(accounts) };
}

/**
 * 在巨量「选择账户」页上按 **aavid** 找账户并（可选）点击
 * 只认「可见 + 文本里带该 aavid + 最深（子节点最少）」的那个元素，取中心点走原生鼠标点击
 * （与仓库对下拉选项的做法一致：ID 匹配 + 真实点击；DOM .click() 常只切 class 不上报组件）
 * @returns {{ok:boolean, 找到:boolean, 已点击:boolean, text?:string, x?:number, y?:number, 候选数?:number}}
 */
/** 轮询等"进账户成功"（URL 离开 /login 且不是 unknown）；返回最后一次探测结果 */
async function waitUntilLoggedIn(page, { timeoutMs = 12000, intervalMs = 1200 } = {}) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    last = await detectLogin(page, {}).catch(() => null);
    if (last && !last.isLogin && !last.unknown) return last;
    if (Date.now() - t0 > timeoutMs) return last;
    await sleep(intervalMs);
  }
}

async function selectAccountOption(page, { aavid, click = false, log: logFn = () => {} } = {}) {
  const want = String(aavid || '');
  if (!want) return { ok: false, 原因: '没给 aavid（真值在 ego-profiles.local.js）' };
  let found = null;
  try {
    found = await page.evaluate((aid) => {
      const all = [...document.querySelectorAll('*')].filter((e) => e.offsetParent && String(e.textContent || '').includes(aid));
      if (!all.length) return null;
      all.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      const el = all[0];
      // ⚠️ 点"文字节点"没用（2026-09-21 实测：点在 info-bottom-box 下边缘，页面纹丝不动）
      //    → 必须**向上找条目/卡片祖先**再点它的中心。优先类名含 item/card/option/row 的祖先。
      let t = el, item = null, clsHit = '';
      for (let i = 0; i < 8 && t; i++) {
        const cls = String(t.className || '');
        const r = t.getBoundingClientRect();
        if (/(item|card|option|row)/i.test(cls) && r.width >= 150 && r.height >= 40 && r.height <= 400) { item = t; clsHit = cls; break; }
        t = t.parentElement;
      }
      if (!item) {   // 退路：取"文本仍含 aid 且高度 60~400"的最小祖先
        t = el;
        while (t && t.parentElement) {
          const pr = t.parentElement.getBoundingClientRect();
          if (pr.height < 60 || pr.height > 400) break;
          t = t.parentElement;
        }
        item = t; clsHit = String(t.className || '');
      }
      const r = item.getBoundingClientRect();
      return { text: String(item.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140),
               候选数: all.length, tag: item.tagName, cls: clsHit.slice(0, 60),
               命中方式: clsHit ? '类名(item/card/option/row)' : '退路(高度)',
               卡片: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
               x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
               可见: r.width > 0 && r.height > 0 };
    }, want);
  } catch (e) { return { ok: false, aavid: want, 找到: false, err: String(e.message || e).slice(0, 140) }; }
  if (!found) return { ok: false, aavid: want, 找到: false, 说明: '页面上没有带这个 aavid 的可见元素（是不是已经进账户了？）' };
  logFn({ stage: 'ACCOUNT_OPTION', ok: true, aavid: want, ...found, 将点击: click });
  if (!click) return { ok: true, aavid: want, 找到: true, 已点击: false, ...found };
  // ⚠️ 2026-09-21 实测：**后台/非前台标签上 CDP 输入不落地**（仓库血泪：SEARCH_TYPED 期望…实得:""）
  //    → 点之前必须把窗口带到前台，否则坐标点击/原生点击都可能被丢弃。
  try { await page.cdp('Page.bringToFront', {}); } catch (e) {}
  await page.waitForTimeout(400);

  const tries = [];
  const sel = '.account-list-item:has-text("' + want + '")';
  // ① ego 原生 click（自带 actionability，选择器按 aavid 文本限定到那一条卡片）
  try { await page.click(sel, { timeout: 6000, label: '选择账户 ' + want }); tries.push('page.click(' + sel + ')'); }
  catch (e) { tries.push('page.click 失败: ' + String(e.message || e).slice(0, 70)); }
  let after = await waitUntilLoggedIn(page, { timeoutMs: 12000 });

  // ② 退坐标点击卡片中心
  if (after && after.isLogin) {
    await page.mouse.click(found.x, found.y, { label: '选择账户(坐标中心) ' + want });
    tries.push('坐标中心(' + found.x + ',' + found.y + ')');
    after = await waitUntilLoggedIn(page, { timeoutMs: 12000 });
  }
  // ③ 再退：卡片左侧（头像/名称区，有些卡片只在那儿挂 handler）
  if (after && after.isLogin && found.卡片) {
    const x2 = found.卡片.x + 30, y2 = found.卡片.y + Math.round(found.卡片.h / 2);
    await page.mouse.click(x2, y2, { label: '选择账户(坐标左侧) ' + want });
    tries.push('坐标左侧(' + x2 + ',' + y2 + ')');
    after = await waitUntilLoggedIn(page, { timeoutMs: 12000 });
  }

  const 仍在登录页 = !!(after && after.isLogin);
  logFn({ stage: 'ACCOUNT_CLICKED', ok: !仍在登录页, aavid: want, 尝试: tries, 仍在登录页,
          url: after ? String(after.url).split('?')[0] : null, 正文长度: after ? after.len : null });
  return { ok: !仍在登录页, aavid: want, 找到: true, 已点击: true, 尝试: tries, 点后仍在登录页: 仍在登录页, ...found };
}

module.exports = {
  ensureTabRoom, pickReusableTab, acquireTab,
  inEgo, repoRoot, readParams, writeParams,
  openSpace, finishSpace, finishAllSpaces, finishAllSpacesForce, registerTask, keepTask, keepAllSpaces, listTabs, attachPage, gatedGoto, makeCdp, makeEgoReader,
  samePath, sameOrigin, evalWithTimeout, sleep, log,
  // 登录闸
  SERVICE_URLS, LOGIN_STATE_FILE, TMP_DIR, detectLogin, saveLoginState, loadLoginState, openLoginGate, resumeLoginGate,
  // 账号 ↔ profile 映射 + 选账户
  loadProfileMap, resolveProfile, selectAccountOption, raiseWindow,
};
