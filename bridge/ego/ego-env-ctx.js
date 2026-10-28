'use strict';
/**
 * ego-env-ctx.js —— **ego 版 env ctx**：与 `bit-qc-lib.js` 的 `makeEnvCtx(envId)` **同形**的驱动对象
 *
 * 为什么需要它（2026-09-22 用户拍板「先登代投，再做 ego 适配层，再重建」）：
 *   ego 变体此前只把 **m1 选品车读取** 与 **m11 监控** 搬到了 ego；`bit-qc-run.js` 的
 *   S1→S9 九步重建仍然挂在 `bit-api.js`（开比特环境 → CDP ws）上 ⇒ ego 里跑不动。
 *   而 `bit-qc-lib.js` 的业务判据（2000+ 行，12+ 次实战换来的）**只认 ctx 契约**，
 *   不认识传输：`{ env, cdp, js, wait, pressKey, gotoAndWait, listTabs, closeTab, pageInfo }`。
 *   ⇒ 所以**判据一行不改**，只补一个 ego 实现（与 `ego-transport.makeEgoReader` 同一套路）。
 *
 * 关键事实（实测，见 EGO-VERSION.md）：ego 的 `page.cdp()` 覆盖
 *   Page / Runtime / DOM / Network / Input ⇒ 比特链路用到的 CDP 调用点**原样可跑**。
 *   九步实际用到的 CDP 方法只有 7 个：
 *     Page.bringToFront×9 / Input.dispatchMouseEvent×6 / Page.addScriptToEvaluateOnNewDocument×3
 *     Page.navigate×2 / Input.dispatchKeyEvent×2 / Browser.getWindowForTarget / Browser.setWindowBounds
 *   （Target.createTarget / Target.closeTarget 只在比特的"开新标签"分支里，ego 用 task.newPage/close 代替）
 *
 * ⛔ 红线（与比特版同，一条不少）：
 *   1. **导航一律过闸**（`gatedGoto` → `tab-reuse.guardedNavigate`）：反复刷千川会掉登录（真实事故）。
 *      同页复用（零导航）不受闸限制，优先复用。
 *   2. **绝不在有草稿的创建页上导航**（`/uni-creation/` 页跳走会弹「确定退出并放弃…」并阻塞渲染进程）。
 *   3. **env → profile 绝不猜**：映射表（qc-config ↔ ego-profiles.local.js 的 aavid/qcEnv）对不上就抛错。
 *   4. 不打扰用户：只有登录闸才提窗口；这里一律 `raise:false`。
 */
const T = require('./ego-transport.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============ 「这页是不是能干活」的判据（**唯一主人** ✓，带单测 `ego-page-blank.test.js`）============
// 为什么必须有（2026-09-30 用户报「**老是会操作一半页面就变成了 about:blank**」）：
//   ego 空间**自带一张 `openedBy:unknown` 的 about:blank**（见 `bridge/monitor/ego-monitor.js:193`），
//   而且绑定中的句柄会**悄悄变成 about:blank / chrome://new-tab-page**（或句柄失效）。
//   原来 `ensurePage` 只判"`url()` 抛不抛错" —— 空白页**不抛错** ⇒ 空页被当成业务页继续用 ✗，
//   于是后面每一句 `js()`/`cdp()` 都打在空页上，报出来的却是一堆**看着像别的原因**的怪错：
//     `商品卡片未定位(卡片数:0)` · chip 读成空串 ⇒ 误报`抖音号切换未生效` · `发布确认/成功30s均未出现`
//     · 现场 dump = `about:blank`（17:49、18:04 两次实盘都是这个 dump）。
//   ⇒ 「空白」与「业务页」两个判据**只留这一份**，别在别处再写一遍正则（canon #46）✓
const 是空白页 = (u) => {
  const s = String(u == null ? '' : u).trim();
  return !s || /^(about:blank|about:srcdoc|chrome:\/\/new-?tab-?page|chrome:\/\/newtab|chrome:\/\/blank)/i.test(s);
};
const 是业务页 = (u) => {
  if (是空白页(u)) return false;
  let h = '';
  try { h = new URL(String(u)).hostname.toLowerCase(); } catch (e) { h = String(u).trim().toLowerCase(); }
  // ⚠️ 必须按 **hostname** 判，不能用 `/(^|\.)qianchuan\./` 直接套整串 —— 串首是 `https://`，
  //    `^` 命不中、前面又没有 `.` ⇒ 真页会被判成非业务页（本文件测试第 ② 条就是钉这个 ✓）
  return /(^|\.)qianchuan\.jinritemai\.com$/.test(h) || /(^|\.)douyin\.com$/.test(h);
};

/**
 * 挑一张"当前页"（纯函数，带单测 `ego-page-blank.test.js`）—— **唯一主人** ✓
 *
 * ⛔⛔ 唯一的铁律：**只有空间一张页都没有时，才允许 `new`**。
 *   为什么（2026-09-30 实盘翻车，用户截图 = 一个空间里 **5 个标签全是 about:blank**）：
 *   `ensurePage` 是**每一次 `js()`/`cdp()` 的入口** —— 一旦写成"没找到真页就 `newPage()`"，
 *   就会**每调一次多开一张 about:blank**，空间迅速撞满 ego 的 8 个标签上限
 *   ⇒ `Page budget reached (8/8)` ⇒ 整条链路当场炸（那次续跑直接死在 `EGO_RUN`，连 BOOT 都没到 ✗）。
 *   ⇒ 有空白页就**复用**它（调用方自己会 goto），绝不新开 ✓
 * @returns {{方式:'biz'|'real'|'blank-reuse'|'new', tab:object|null}}
 */
function 挑页(tabs) {
  const 列表 = Array.isArray(tabs) ? tabs : [];
  const biz = 列表.find((x) => 是业务页(x && x.url));
  if (biz) return { 方式: 'biz', tab: biz };
  const real = 列表.find((x) => !是空白页(x && x.url));
  if (real) return { 方式: 'real', tab: real };
  if (列表.length) return { 方式: 'blank-reuse', tab: 列表[0] };   // ⛔ 不是 'new' —— 见上
  return { 方式: 'new', tab: null };
}

// ⚠️ 空间复用（**ego 原生便利点**）：比特那边"一个环境一个窗口"，ego 这边空间是**可跨进程认领**的
//    （`takeOverTaskSpace(id)`）⇒ 上一次跑完还停在计划列表的窗口，这次直接接管，**零导航**，
//    既省时间又少碰导航闸（千川刷多了会掉登录）。入口脚本用 `setSpaceOverride({envId: spaceId})` 注入。
let SPACE_OVERRIDE = null;
function setSpaceOverride(map) { SPACE_OVERRIDE = map || null; }

function loadConfig() {
  try { return require('../qc-config.js'); } catch (e) { return {}; }
}

/**
 * envId → ego profile 的映射表（**唯一真值来源**）
 *   千川侧 env  = `qc-config.qcEnv`            ↔ `ego-profiles.local.js[*].qcEnv`
 *   直投侧 env  = `qc-config.dyEnvs[].env`     ↔ `ego-profiles.local.js[*].aavid`（**按 aavid 匹配**，
 *                 与仓库口径一致：「下拉选项带 ID:xxx → 按 ID 匹配，比名字精准」）
 *   ⚠️ 不按顺序/不按下标猜（识别码归属就是这么出过事的）——对不上宁可报错。
 */
function indexEnvProfiles() {
  const { file, accounts } = T.loadProfileMap();
  const CFG = loadConfig();
  const dyEnvs = Array.isArray(CFG.dyEnvs) ? CFG.dyEnvs : [];
  const pick = {};
  for (const [name, v] of Object.entries(accounts || {})) {
    if (v.qcEnv) {
      pick[String(v.qcEnv)] = { 账号: name, profileId: v.profileId, aavid: v.aavid, 依据: 'profile.qcEnv' };
    }
    if (v.aavid) {
      const d = dyEnvs.find((x) => String(x.aavid) === String(v.aavid));
      if (d) pick[String(d.env)] = { 账号: name, profileId: v.profileId, aavid: v.aavid, 业务名: d.name, 依据: 'dyEnvs[].aavid' };
      // 也允许直接用 aavid 当 env 查（排障时方便：makeEgoEnvCtx('1874…764')）
      if (!pick[String(v.aavid)]) pick[String(v.aavid)] = { 账号: name, profileId: v.profileId, aavid: v.aavid, 依据: 'aavid' };
    }
  }
  return { pick, file, qcEnv: String(CFG.qcEnv || ''), dyEnvs };
}

/** 解析 env → { profileId, 账号, aavid }；失败**不猜**，返回 ok:false + 可选值 */
function resolveEnvProfile(envId) {
  const idx = indexEnvProfiles();
  const k = String(envId == null ? '' : envId).trim();
  if (!k) return { ok: false, envId: k, 原因: '没给 env', 映射文件: idx.file };
  const hit = idx.pick[k];
  if (hit && hit.profileId) return { ok: true, envId: k, ...hit, 映射文件: idx.file };
  return {
    ok: false, envId: k, 映射文件: idx.file,
    原因: '这个 env 不在映射里（qc-config.qcEnv / dyEnvs[].env ↔ ego-profiles.local.js 的 aavid 都没对上）',
    可选: Object.keys(idx.pick),
    提示: '要么在 ego-profiles.local.js 里补这个号的 qcEnv/aavid，要么传正确的 env',
  };
}

function sameDraftPage(cur, want) {
  try {
    const c = new URL(cur), w = new URL(want);
    if (!/\/uni-creation\/product/.test(c.pathname) || c.pathname !== w.pathname) return false;
    const ca = c.searchParams.get('aavid'), wa = w.searchParams.get('aavid');
    return !ca || !wa || ca === wa;
  } catch (e) { return false; }
}

/**
 * 造 ego 版 env ctx —— 与 `bit-qc-lib.makeEnvCtx(envId)` 同形，可直接喂给 `makeLib(ctx)`。
 * @param {string} envId 比特语义的「环境 id」；在 ego 里它就是映射到某个 profile 的钥匙
 * @param {{log?:Function, spaceName?:string}} [opts]
 */
function makeEgoEnvCtx(envId, { log: logFn = () => {}, spaceName } = {}) {
  if (!T.inEgo()) throw new Error('NOT_IN_EGO：ego-env-ctx 只能在 `ego-browser nodejs` 运行时里用');
  const rp = resolveEnvProfile(envId);
  if (!rp.ok) {
    const e = new Error('EGO_ENV_UNMAPPED: ' + rp.原因 + '（env=' + envId + '，可选：' + (rp.可选 || []).join('/') + '）');
    e.code = 'EGO_ENV_UNMAPPED';
    throw e;
  }
  const 账号 = rp.账号, profileId = rp.profileId, envKey = profileId || envId;

  let task = null;
  let page = null;
  let pageTargetId = null;

  const setPage = async (p) => {
    page = p;
    try { pageTargetId = p && p.targetId ? String(p.targetId) : null; } catch (e) { pageTargetId = null; }
    return page;
  };

  const ensureTask = async () => {
    if (task) return task;
    // ① 优先复用已开空间（ego 原生 takeOverTaskSpace）—— 零导航、不撞闸、不闪新窗口
    const sid = SPACE_OVERRIDE && (SPACE_OVERRIDE[envId] || SPACE_OVERRIDE[账号]);
    if (sid) {
      try {
        const t = await takeOverTaskSpace(sid);
        const chk = await T.listTabs(t);
        task = t;
        // ⚠️ 2026-09-22 改：**默认暖会话**（进 KEEP_TASKS）—— 我自己的临时探针报错时没跑到 keepTask，
        //    退出就把暖空间收掉了（实测丢了两个已传素材的直投创建页）。要收只能用 finishAllSpacesForce / cleanup-spaces。
        T.keepTask(t);
        logFn({ stage: 'EGO_ENV_SPACE_REUSE', ok: true, env: envId, 账号, profileId, spaceId: sid, 现有页: chk.map((x) => String(x.url || '').split('?')[0]).slice(0, 4) });
        return task;
      } catch (e) {
        logFn({ stage: 'EGO_ENV_SPACE_REUSE_FAIL', ok: false, env: envId, spaceId: sid, err: String(e.message || e).slice(0, 120), 说明: '回退到新建空间' });
      }
    }
    // ② 认领**同一 profile 下已有的 agent 空间**（用户 2026-09-22：「你就不能在同一个空间添加标签吗？」）
    //    规则：先按「名字 + profileId」精确命中；没有再退「同 profile 的任意 agent 空间」——
    //    一个号**只用一个空间**，需要新页面就 `task.newPage()` 加标签，绝不为了省事再开一个窗口。
    //    ⛔ 不动 `user` / `agentDelegatedToUser`（已交还给人看的空间，SOP 第 5 条）。
    //    ⚠️ ego 硬规则：`taskSpace(name,{profileId})` 在**同名空间已存在**时会直接抛
    //       `taskSpace profileId only applies when creating a new task space; "…" already exists`（2026-09-22 踩到）
    //       ⇒ 绝不能盲建，必须先列举再决定。
    const nm = spaceName || ('千川重建 · ' + 账号);
    try {
      const spaces = (await listTaskSpaces()) || [];
      const sameProfile = spaces.filter((s) => s && String(s.profileId || '') === String(profileId));
      // ⚠️ 2026-09-22 修（号B 卡死的根因）：`agentDelegatedToUser` 不等于"用户的"——
      //    实测：我自己的进程异常退出后，留下的空间会变成 delegated；以前把它一并排除 ⇒
      //    每次只能新建 → 同名被占 → 改名 → 还被占 → 抛错 → 兜底比特链路 → 失败 → 又留一个 delegated……
      //    死循环，号B 就此卡住（空间 97/101/102 全是这么来的）。
      //    ⇒ 规则改成：**认领"我们自己命名的"空间**（名字匹配本仓库约定），只排除真正的 `user` 所有。
      const 是我们的 = (s) => /^(千川重建|qc |登录闸|六件套诊断|会话对比)/.test(String(s.name || ''));
      // ⚠️ 2026-09-23（**用户明确两条**）：
      //    「号a 我接管下，我接管以后会还给你 **你不要到时候要操作又开新空间**」
      //    「以后尽量**少开空间**，在做同一框架的事的时候」
      //    ⇒ 只要**名字是我们约定的**，不论 ownership 是 agent / agentDelegatedToUser / user，
      //      **一律优先认领回同一个空间**（takeOverTaskSpace）—— 用户接管过 ≠ 我们要另起一个。
      //    只有"同 profile 一个我们的空间都没有"时，才新建（且日志写明白）。
      const 我们的 = sameProfile.filter((s) => 是我们的(s));
      const usable = 我们的.concat(sameProfile.filter((s) => s.ownership === 'agent' && !是我们的(s)));
      if (sameProfile.length && usable.length === 0) {
        logFn({ stage: 'EGO_SPACE_ALL_TAKEN_BY_USER', ok: true, profileId,
                被接管的空间: sameProfile.map((s) => s.id + ':' + s.name + '(' + s.ownership + ')'),
                说明: '同 profile 没有任何"我们命名"的空间可认领 → 本次不得不新建一个；'
                    + '要复用旧空间：在 ego 界面把它交还/结束，或直接说一声我认领' });
      }
      // 逐个候选尝试认领（认领失败就试下一个；**不因为一次失败就去新建**）
      const 候选 = (usable.find((s) => s.name === nm) ? [usable.find((s) => s.name === nm)] : []).concat(usable.filter((s) => s.name !== nm));
      const 认领失败 = [];
      for (const hit of 候选) {
        try {
          const t = await takeOverTaskSpace(hit.id);
          task = t;
          T.keepTask(t);
          const chk = await T.listTabs(t);
          logFn({ stage: 'EGO_ENV_SPACE_ADOPT', ok: true, env: envId, 账号, profileId, spaceId: hit.id, name: hit.name,
                  ownership: hit.ownership, 同profile空间: usable.map((s) => s.id + ':' + s.name),
                  现有页: chk.map((x) => String(x.url || '').split('?')[0]).slice(0, 4),
                  说明: hit.name === nm ? '同名空间 → 认领复用' : '同 profile 已有空间 → 就地加标签（不新开窗口）' });
          return task;
        } catch (e) {
          认领失败.push(hit.id + ':' + String(e.message || e).slice(0, 60));
        }
      }
      if (候选.length) {
        logFn({ stage: 'EGO_SPACE_CLAIM_FAILED', ok: false, 试过: 认领失败,
                说明: '同 profile 有我们的空间但**认领失败**（多半还在用户手里）→ 本次只能新建；'
                    + '让用户把该空间交还/结束可避免多开' });
      }
    } catch (e) {
      logFn({ stage: 'EGO_ENV_SPACE_LIST_ERR', ok: false, env: envId, err: String(e.message || e).slice(0, 140), 说明: '列举空间失败 → 走新建' });
    }

    // ③ 新建空间
    // ⚠️ profileId 必传：不传会落 Default(hetu) = 用户个人 profile（`openSpace` 里有硬闸会拦）
    let r;
    try {
      r = await T.openSpace(nm, { profileId });
    } catch (e) {
      // 同名空间被**别的 profile** 占着 → 换个唯一名字（绝不为了省事把 profile 弄混）
      if (/already exists/i.test(String(e.message || ''))) {
        // ⚠️ 2026-09-22：只试一次新名字不够（实测：'…· Profile2' 也被占 ⇒ 抛错 ⇒ 回退比特 ⇒ 死循环）
        //    ⇒ 循环找空位：'…· Profile2'、'…· Profile2-2'、'…· Profile2-3' …
        const base = nm + ' · ' + String(profileId).replace(/\s+/g, '');
        let opened = null;
        for (let k = 1; k <= 6 && !opened; k++) {
          const cand = k === 1 ? base : (base + '-' + k);
          try {
            opened = await T.openSpace(cand, { profileId });
            logFn({ stage: 'EGO_ENV_SPACE_RENAME', ok: true, 原名: nm, 新名: cand, 原因: '同名空间被占 → 换唯一名字（循环找空位）' });
          } catch (e2) {
            if (!/already exists/i.test(String(e2.message || ''))) throw e2;
          }
        }
        if (!opened) throw new Error('同名空间占满 6 个候选名，仍建不出新空间（先用 cleanup-spaces 清一清）');
        r = opened;
      } else throw e;
    }
    task = r.task;
    T.keepTask(task);   // 新建的也默认暖会话
    logFn({ stage: 'EGO_ENV_SPACE', ok: true, env: envId, 账号, profileId, spaceId: task.spaceId, 依据: rp.依据 });
    return task;
  };

  const adoptTab = async (tab) => (tab.label ? task.page(tab.label) : task.adopt(tab.page));

  /** 当前目标页：优先业务页（千川/抖音），否则复用一张现成的页 */
  const ensurePage = async () => {
    const t = await ensureTask();
    const tabs = await T.listTabs(t);
    if (page) {
      let cur = null;
      try { cur = String(await page.url()); } catch (e) { cur = null; }   // null = 句柄已死
      if (cur !== null && !是空白页(cur)) return page;                     // 绑着的还是真页 ⇒ 原样用 ✓
      // ⚠️⚠️ 2026-09-30（用户报「**老是会操作一半页面就变成了 about:blank**」）：
      //    原来这里是 `if (page) { try { await page.url(); return page; } catch { setPage(null) } }`
      //    —— **`about:blank` 不会让 `url()` 抛错** ⇒ 直接 return 空页 ⇒ 之后每一次 `js()`/`cdp()`
      //    都在空页上跑 ✗✗。症状是"看起来在正常跑，其实在空页上跑"：
      //      · `S4商品picker诊断 … 卡片数:0`（no-card）· chip 读成空串（→ 误判「抖音号切换未生效」）
      //      · `发布确认/成功30s均未出现`（20 轮轮询全打在空页上）
      //      · 现场 dump 出来就是 `about:blank` / `chrome://new-tab-page/`（17:49、18:04 两次实盘）
      //    ⇒ 判据：**空白页一律不算"当前页"**，先尽力换回一张真页；换不到也要留痕 ✓
      logFn({ stage: 'EGO_PAGE_LOST', ok: false, 原页: cur,
              现有页: tabs.map((x) => String(x.url || '').split('?')[0]).slice(0, 8),
              说明: '绑定页变成空白/句柄失效 ⇒ 重新挑页（空页上跑出来的"卡0/读空/未出现"全是假象 ✗）' });
      await setPage(null);
    }
    // 优先真业务页；退而求其次**任何非空白真页**（选品库/达人页等也用这个 ctx ⇒ 不许把它们判死 ✗）
    const 选 = 挑页(tabs);
    if (选.tab) {
      if (选.方式 === 'blank-reuse') {
        // ⛔⛔⛔ 绝不在这里 `newPage()` —— `ensurePage` 是**每一次 `js()`/`cdp()` 的入口**，
        //   一旦写成"没真页就新开"，就会**每调一次多一张 about:blank** ⇒ 空间迅速堆满
        //   （ego 标签上限 8）⇒ `Page budget reached (8/8)` ⇒ 整条链路当场炸 ✗✗✗
        //   ⚠️ 2026-09-30 我第一版就是这么写的，**实盘翻车**：用户截图 = 一个空间里
        //      **5 个标签全是 about:blank**；随后续跑直接死在 `EGO_RUN`（exit 1，连 BOOT 都没到）✗。
        //   ⇒ 空间里**已经有页**（哪怕是空白页）就**认领一张现成的**，绝不新开 ✓
        logFn({ stage: 'EGO_PAGE_BLANK_REUSE', ok: false, 复用: String((选.tab.url) || '').split('?')[0], 现有页数: tabs.length,
                说明: '空间里只有空白页 ⇒ **复用**其中一张（⛔ 绝不新开，否则每调一次多一张、很快撞 8 个上限 ✗）；调用方必须先 goto 再用它' });
      }
      return await setPage(await adoptTab(选.tab));
    }
    // 空间**一张页都没有**（罕见）⇒ 这时新开是唯一选择，且必须留痕（调用方得先导航 ✓）
    const p = await t.newPage();
    logFn({ stage: 'EGO_PAGE_BLANK_NEW', ok: false, 说明: '空间是空的（一张页都没有）⇒ 新开一张 about:blank；调用方必须先 goto 再用 ✗' });
    return await setPage(p);
  };

  // ── 协议：cdp / js ────────────────────────────────────────────────────────
  // 域路由沿用 ego-transport.makeCdp（默认 page.cdp；Target.* 走 task.cdp，并留一次互备重试）
  const cdp = async (method, params) => {
    const t = await ensureTask();
    const p = await ensurePage();
    return await T.makeCdp(p, t).send(method, params);
  };

  const evalOnce = async (p, expr, ms) => T.evalWithTimeout(p, expr, ms);

  /** 执行 JS —— 与比特版 `cdp.eval` 同语义：10s 超时；超时补一次「取消弹窗」再重试一次 */
  const js = async (expr, ms) => {
    const p = await ensurePage();
    const to = ms || 10000;
    try { return await evalOnce(p, expr, to); }
    catch (e) {
      if (!/TIMEOUT|超时/i.test(String(e.message || ''))) throw e;
      try {
        const info = await p.info();
        if (info && info.dialog) await p.dismissDialog();   // 取消 = 留在当前页 = 不放弃草稿
      } catch (e2) {}
      logFn({ stage: 'EVAL_RETRY', 说明: '首次超时（疑似原生弹窗阻塞渲染进程），已补发取消并重试', 片段: String(expr).slice(0, 60) });
      return await evalOnce(p, expr, to);
    }
  };

  const pressKey = async (key) => {
    // ego 原生优先（`page.keyboard.press` 发给页面上**已聚焦**的元素，与 CDP Input 同语义）；失败回退 CDP
    if (page) {
      try { await egoKey(key); return; }
      catch (e) { logFn({ stage: 'EGO_KEY_FALLBACK', ok: false, key, err: String(e.message || e).slice(0, 100), 说明: '回退 CDP Input.dispatchKeyEvent' }); }
    }
    const map = { Enter: { key: 'Enter', code: 'Enter', vk: 13 }, Escape: { key: 'Escape', code: 'Escape', vk: 27 } };
    const k = map[key] || { key, code: key, vk: String(key).charCodeAt(0) };
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk });
  };

  /**
   * 导航到 url —— **复用优先**（与比特版同一套判据，坑位注释照搬）：
   *   ① 已有标签**就在目标页**（sameView）→ **零导航复用**（最省，也最不容易掉登录）
   *   ② 同站其它标签（**排除有草稿的创建页**）→ 在其上导航（过闸）
   *   ③ 都没有 → `task.newPage()` 新页导航
   *   `reload:true` 强制真重载（S6「重新刷新重新来」/用户点名的刷新场景）
   */
  // waitUntil（可选）：'load'（默认，行为不变）| 'domcontentloaded'
  //   ⏱ 2026-09-22 优化 #1：S4 进创建页实测 21.7s，大头是等**整页 load 完成**（千川创建页 JS 很重）；
  //   而后续代码本来就会 `waitFor` 表单元素 ⇒ 这里允许只等 DOM 就绪，把剩余就绪交给判据自己轮询。
  const gotoAndWait = async (url, { timeout = 20, reload = false, waitUntil = 'load' } = {}) => {
    const t = await ensureTask();
    const TR = require('../tab-reuse.js');
    const CONST = require('../qc-const.js');
    let site = '';
    try { site = new URL(url).origin; } catch (e) { site = ''; }

    const tabs = (await T.listTabs(t)).filter((x) => x.url && site && String(x.url).startsWith(site));
    const sameTab = tabs.find((x) => TR.sameView(x.url || '', url) || sameDraftPage(x.url || '', url));

    if (sameTab && !reload) {
      await setPage(await adoptTab(sameTab));
      try { await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: CONST.SIXPACK }); } catch (e) {}
      try { await page.cdp('Page.bringToFront', {}); } catch (e) {}
      logFn({
        stage: 'EGO_REUSE_SAME_PAGE', ok: true, 页: String(sameTab.url).split('?')[0],
        说明: sameDraftPage(sameTab.url || '', url) && !TR.sameView(sameTab.url || '', url)
          ? '创建页同路径 → 零导航复用（**不导航草稿页**，避免「确定退出并放弃创建」）'
          : '已在目标页 → 零导航复用（不刷新）',
      });
      return true;
    }

    let hit = sameTab || tabs.find((x) => !/\/uni-creation\//.test(x.url || '')) || tabs[0];
    // ⚠️ 绝不在"有草稿的创建页"上跳走：导航会触发原生确认框 → 渲染进程阻塞 → 之后 Runtime.evaluate 全超时
    if (hit && /\/uni-creation\//.test(hit.url || '') && !/\/uni-creation\//.test(url)) {
      logFn({ stage: 'EGO_NAV_NEW_TAB_DRAFT_SAFE', ok: true,
        说明: '现有标签是创建页（可能有未发布草稿）→ 另开新页，避免「确定退出并放弃」弹窗',
        草稿页: String(hit.url).split('?')[0], 目标: String(url).split('?')[0] });
      hit = null;
    }

    if (hit) {
      await setPage(await adoptTab(hit));
    } else {
      await setPage(await t.newPage());
      logFn({ stage: 'EGO_NEW_TAB', ok: true, 目标: String(url).split('?')[0] });
    }
    // 六件套必须在**导航前**注册（addScriptToEvaluateOnNewDocument 对已加载页无效）
    try { await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: CONST.SIXPACK }); } catch (e) {}
    try { await page.cdp('Page.bringToFront', {}); } catch (e) {}

    const g = await T.gatedGoto(page, url, { log: logFn, envKey });
    if (g && g.blocked) {
      // 撞闸**明确失败**（仓库坑表 #21：假成功比失败更贵）——绝不拿着半个页面继续跑
      const e = new Error('NAV_BLOCKED: 导航闸等满仍未放行（' + Math.round(((g && g.ageMs) || 0) / 1000) + 's 前刚导航过 '
        + (g && g.host) + '）→ 过几分钟原命令重跑即可；已完成阶段按断点续跑');
      e.code = 'NAV_BLOCKED';
      throw e;
    }

    // 导航后核对：URL 真的到了目标没（防"原生 beforeunload 弹窗吃掉导航"的假成功）
    for (let i = 0; i < 2; i++) {
      let cur = '';
      try { cur = String(await page.url()); } catch (e) {}
      if (TR.sameView(cur, url) || (site && cur.startsWith(site) && !/about:blank/.test(cur))) break;
      try {
        const info = await page.info();
        if (info && info.dialog) {
          await page.acceptDialog();   // 我们本来就是要离开这一页 → 明确"确定"
          logFn({ stage: 'EGO_NAV_DIALOG_ACCEPT', ok: true, 弹窗: String((info.dialog && info.dialog.message) || '').slice(0, 80) });
        }
      } catch (e) {}
      logFn({ stage: 'EGO_NAV_NOT_APPLIED', ok: false, attempt: i + 1, 当前: cur.split('?')[0], 目标: String(url).split('?')[0] });
      // 同一次导航的重试 → force 只为绕过"刚刚自己记下的那次导航"，不是绕过闸去刷别的页
      const g2 = await T.gatedGoto(page, url, { log: logFn, envKey, force: true });
      if (g2 && g2.blocked) break;
    }

    // 等加载：**ego 原生优先**（`waitForLoadState` 自带超时/actionability 语义，不用自己轮询 readyState）；
    // 原生件失败才退回比特版那套 readyState Promise 循环（逃生通道，保判据语义不丢）
    try {
      await page.waitForLoadState(waitUntil, { timeout: timeout * 1000 });
      return true;
    } catch (e) {
      logFn({ stage: 'EGO_LOADSTATE_FALLBACK', ok: false, err: String(e.message || e).slice(0, 100) });
    }
    let ok = null;
    for (let nav = 0; nav < 3 && !ok; nav++) {
      try {
        ok = await js(`new Promise(res => { if (document.readyState === 'complete') return res(true);
          window.addEventListener('load', () => res(true), { once: true }); setTimeout(() => res(true), ${timeout * 1000}); })`, timeout * 1000 + 5000);
      } catch (e) {
        if (!/TIMEOUT|超时|navigated or closed/i.test(String(e.message || ''))) throw e;
        await sleep(1500);
      }
    }
    return ok;
  };

  const listTabs = async () => {
    const t = await ensureTask();
    return (await T.listTabs(t)).map((x) => ({ id: x.targetId, targetId: x.targetId, url: x.url, title: x.title, label: x.label, openedBy: x.openedBy }));
  };

  const closeTab = async (id) => {
    const t = await ensureTask();
    const tabs = await T.listTabs(t);
    const hit = tabs.find((x) => String(x.targetId) === String(id));
    if (!hit) return { ok: false, 原因: '没找到 targetId=' + id };
    // 绝不关用户的标签（ego 用 openedBy==='unknown' 表示"来源不明/user-owned"）
    if (hit.openedBy === 'unknown') {
      logFn({ stage: 'EGO_CLOSE_SKIP_USER_TAB', ok: true, url: String(hit.url).split('?')[0], 说明: 'user-owned 标签不关（空间卫生 SOP 第 5 条）' });
      return { ok: false, 跳过: 'user-owned' };
    }
    const p = await adoptTab(hit);
    try { await p.close(); } catch (e) { return { ok: false, 原因: String(e.message || e).slice(0, 120) }; }
    if (pageTargetId && String(pageTargetId) === String(hit.targetId)) await setPage(null);
    return { ok: true };
  };

  const pageInfo = async () => {
    const p = await ensurePage();
    return { url: String(await p.url().catch(() => '')) };
  };

  return {
    transport: 'ego',
    env: envId, 账号, profileId, spaceId: () => (task && task.spaceId) || null,
    cdp, js, wait: (sec) => sleep(sec * 1000), pressKey, gotoAndWait,
    listTabs, closeTab, pageInfo,
    // ── ego 原生观察口（**测试/排查专用**，判据层不依赖）─────────────────────
    // 用户 2026-09-22：「测试时发现有 ego 特属的方式更方便就尽量去用」⇒
    //   看页面用 `snapshot()`（语义树）而不是自己拼 DOM 表达式；看视觉用 `screenshot()`。
    egoTask: async () => await ensureTask(),
    egoPage: async () => await ensurePage(),
    egoSnapshot: async (opts) => { const p = await ensurePage(); return await p.snapshot(opts); },
    egoScreenshot: async (opts) => { const p = await ensurePage(); return await p.screenshot(opts || {}); },
    // ── ego 原生动作口（判据层的 cdpClick / pressKey **优先走这里**，失败回退 CDP）──
    // 语义完全对齐比特版那条 CDP 序列：移到 → 等 hover 过渡 → 按下 → 停留 → 放开。
    // 好处：走 ego 自己的输入管线（动作会挂在光标气泡上，也算给你看得见），
    //       而且 ego 的鼠标自带"目标滚动进视口"之外的坐标语义与 CDP 一致（CSS 像素）。
    async egoMouseClick(x, y, { hoverMs = 0, pauseMs = 300 } = {}) {
      const p = await ensurePage();
      try { await p.cdp('Page.bringToFront', {}); } catch (e) {}
      await p.mouse.move(x, y);
      if (hoverMs > 0) await sleep(hoverMs);            // 坑：新移过去的首击会被 hover 过渡吞掉
      await p.mouse.click(x, y, { label: '点击 (' + x + ',' + y + ')' });
      if (pauseMs > 0) await sleep(pauseMs);
      return { ok: true, x, y, 方式: 'ego.page.mouse' };
    },
    async egoKey(key) {
      const p = await ensurePage();
      await p.keyboard.press(key, { label: '按键 ' + key });
      return { ok: true, 方式: 'ego.keyboard.press', key };
    },
    /**
     * ego 原生 `page.fill(选择器, 值)` —— **自带 actionability，且会校验值真的进去了** ✓
     *
     * 为什么要它（2026-10-02，用户报「我在飞书重建一直失败」）：
     *   S1「按计划名搜索」原来是「**坐标点击**搜索框 → JS 原生 setter 写值」✗ ——
     *   坐标点击在 ego 上经常**不落地**（canon #48/#71 同族："点一下让 X 出现"的步骤一律原生优先），
     *   点了没聚焦 ⇒ 值进不去 / 回车发给没人接的元素 ⇒ **搜索根本没提交** ⇒
     *   看到的是未过滤列表第 1 页 ⇒ 判成"这条计划不存在" ✗（而快照 1 分钟前还在 ⇒ 计划是活的 ✗）。
     *   skill《ego 相对 CDP 的优势》那两行就是这么写的：
     *     · `React 原生 setter 绕 SPA 输入框` → **`page.fill()`（会校验值真的进去）**
     *     · `CDP 回车 + JS 合成 KeyboardEvent 各一次` → **`page.press(sel,'Enter')`**
     *   ⇒ 两个原生件收在这里，判据只留这一份（canon #22）✓
     */
    async egoFill(sel, value, opts = {}) {
      const p = await ensurePage();
      await p.fill(sel, String(value), opts);
      return { ok: true, 方式: 'ego.page.fill', sel };
    },
    /** ego 原生 `page.press(选择器, 键)` —— **先聚焦再按**（自带 actionability），比"赌焦点"的 `keyboard.press` 可靠 ✓ */
    async egoPress(sel, key, opts = {}) {
      const p = await ensurePage();
      await p.press(sel, key, opts);
      return { ok: true, 方式: 'ego.page.press', sel, key };
    },
    /** 量一下布局视口（`innerWidth/innerHeight`）—— 塌陷判据的唯一读口 ✓ */
    async egoViewport() {
      // ⚠️ 这里必须用**闭包内的 `js`**，不是 `ctx.js` —— 本对象就是 ctx 本身，
      //   闭包里根本没有 `ctx` 这个名字 ⇒ 写成 `ctx.js(...)` 会 `ReferenceError: ctx is not defined`
      //   （2026-10-02 我亲手犯的：被 `bit-qc-run` 的 try/catch 吞成一条 `BOOT视口检查失败`，
      //   又被 S1 的重试循环吞成 `素材重试: 1/3 ctx is not defined` ⇒ **看着像页面问题，其实是代码错** ✗。
      //   同族：canon #40（漏 require 的别名 ⇒ 运行期 ReferenceError 被 catch 吞掉）；
      //   ⚠️ AUDIT_NS 只扫**单大写字母**别名（F/N/U/T…），`ctx` 这种小写名它扫不到 ⇒ 只能靠真跑一次 ✗）
      return await js(`(() => ({ w: window.innerWidth, h: window.innerHeight }))()`).catch(() => null);
    },
    /**
     * **视口塌陷的检测 + 自愈**（canon #22：检测与自愈只留这一份，`bit-qc-run` 与 `bit-qc-lib` 共用 ✓）
     *
     * 为什么要有它（2026-10-02 只读探针 `PROBE_滚动取证` 实测定性）：
     *   **ego 窗口被最小化/隐藏时，标签的布局视口会塌陷成 `0×0`** ⇒
     *   所有 rect 变负坐标、`scrollIntoView` 拉不回来、坐标点击点在屏幕外、
     *   `page.click` 的 actionability 永远等不到"可见" ✗
     *   ⇒ 症状是一串**看着像别的原因**的怪错：`素材面板未打开`(3/3) / `商品卡片未定位(卡片数:0)` /
     *     `发布确认/成功30s均未出现` / chip 读成空串 —— 全是同一个"视口塌陷" ✓
     *   ⚠️ 仓库早知道这件事（日志里 `EGO_NO_RAISE … 若页面真因最小化冻结，请手动把该 ego 窗口恢复`），
     *      但**从来没真正检测过** ⇒ 每次白烧 3×90s 再报一个误导人的错 ✗
     *
     * 口径（用户 2026-10-02 选 A 定的）：**只在视口塌陷时才动窗口** ✓ ——
     *   平时一律不碰窗口（守住"不抢焦点"那条规矩 ✓）；塌陷时恢复一次（会抢一下焦点 ✗，
     *   但那时页面本来就没法用，不恢复等于必失败）。恢复后**复测**，真回不来才判失败 ✓
     * @returns {{塌陷:boolean, 视口:object|null, 恢复了:boolean, 复测:object|null, 恢复:object|null}}
     */
    async egoEnsureViewport() {
      const 视口 = await this.egoViewport();
      const 塌陷 = !!(视口 && (视口.w <= 0 || 视口.h <= 0));
      if (!塌陷) return { 塌陷: false, 视口, 恢复了: false, 复测: null, 恢复: null };
      let 恢复 = null;
      try {
        const p = await ensurePage();
        恢复 = await T.raiseWindow(p);      // setWindowBounds({windowState:'normal'}) + 激活 + bringToFront
      } catch (e) { 恢复 = { err: String((e && e.message) || e).slice(0, 100) }; }
      await sleep(1500);
      const 复测 = await this.egoViewport();
      const 恢复了 = !!(复测 && 复测.w > 0 && 复测.h > 0);
      return { 塌陷: true, 视口, 恢复了, 复测, 恢复 };
    },
    /**
     * **滚轮**滚动（ego 原生 `page.mouse.wheel` = 真 wheel 事件、平滑多步）
     *
     * 为什么要它（用户 2026-09-22：「行为温和点 看看 bitbrowser 滚底怎么做的」）：
     *   两边原来的滚动都是 JS 直接赋 `scrollTop`（`scrollTop = scrollHeight` 瞬间跳到底 / `+= 800` 硬跳）——
     *   **零滚轮事件 + 位置瞬跳**是最容易被认出"非人类"的动作。人手是滚轮一格一格滚的。
     *   ⚠️ 但滚轮必须作用在"鼠标底下的那个可滚动容器"上：鼠标不在容器上 = 空转。
     *   ⇒ 所以这里先 JS 找到容器 → 把鼠标移进去 → 滚 → **回读 scrollTop 验证真的动了**；
     *      没动就返回 ok:false，调用方回退原来的 JS 滚动（绝不因为换方式把链路搞挂）。
     * @returns {{ok:boolean, before?:number, after?:number, 容器?:string, 原因?:string}}
     */
    async egoScroll({ selector, delta, label } = {}) {
      const p = await ensurePage();
      const sel = selector || '.parent-route-container';
      const findExpr = `(() => {
        let el = document.querySelector(${JSON.stringify(sel)});
        if (!el) {
          const all = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 100 && e.getBoundingClientRect().height > 200);
          el = all[0] || null;
        }
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 50 || r.height < 50) return null;
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height / 2, 300)), before: el.scrollTop,
                 tag: el.tagName + '.' + String(el.className || '').slice(0, 30), h: Math.round(r.height) };
      })()`;
      const info = await p.evaluate(findExpr);
      if (!info) return { ok: false, 原因: '没找到可滚动容器' };
      await p.mouse.move(info.x, info.y);
      await p.mouse.wheel(0, delta, { label: label || ('滚动 ' + delta + 'px') });
      await sleep(150);
      const top = await p.evaluate(`(() => { let el = document.querySelector(${JSON.stringify(sel)}); if (!el) { const all = [...document.querySelectorAll('*')].filter(e => e.scrollHeight > e.clientHeight + 100 && e.getBoundingClientRect().height > 200); el = all[0] || null; } return el ? Math.round(el.scrollTop) : null; })()`).catch(() => null);
      return { ok: top !== null && top !== info.before, before: info.before, after: top, 容器: info.tag, 高: info.h };
    },
    // 按选择器点击（ego 原生 `page.click` 自带 actionability：滚动进视口 + 等可点 + 单匹配校验）。
    // 用于那些「DOM `.click()` 不生效」的 React 组件（仓库既有血泪：抖音/Semi 只认真实输入）。
    async egoClickSelector(sel, { timeout = 6000, label } = {}) {
      const p = await ensurePage();
      await p.click(sel, { timeout, label: label || ('点击 ' + String(sel).slice(0, 40)) });
      return { ok: true, 方式: 'ego.page.click', sel };
    },
    // ── 遇到人机验证：把窗口**交还给你**（ego 原生 handOff），而不是傻等/傻重试 ──
    // 用户 2026-09-22：「刚才又跳验证了……不然老跳码」。验证只能人来过，脚本重试只会越刷越糟。
    // 交还后空间被登记进 KEEP_TASKS（beforeExit 不会收），你过完验证回一句，我原命令续跑。
    async handOffForHuman(reason) {
      const t = await ensureTask();
      const p = await ensurePage();
      const url = String(await p.url().catch(() => ''));
      T.keepTask(t);
      let handed = null;
      try { handed = await t.handOff(); } catch (e) { handed = { err: String(e.message || e).slice(0, 120) }; }
      logFn({ stage: 'EGO_HANDOFF_HUMAN', ok: true, 需要人工: true, reason: reason || 'CAPTCHA', 账号, profileId,
              spaceId: t.spaceId, url: url.split('?')[0], handOff: handed,
              请做: '在那个 ego 窗口（空间 ' + t.spaceId + '）里把验证过掉，回来跟我说一声，我原命令续跑剩下的阶段' });
      return { ok: true, spaceId: t.spaceId, url };
    },
    // 任务空间概念：ego 有、但判据层不用它（编排自己管收尾），这里保持与比特版同形的空实现
    async claimTaskSpace() { const t = await ensureTask(); return { id: t.spaceId, task: t }; },
    async completeTaskSpace() {},
    async handOffTaskSpace() {},
    async takeOverTaskSpace() {},
    async waitForAgentControl() {},
    async useOrCreateTaskSpace() { const t = await ensureTask(); return { id: t.spaceId, task: t }; },
  };
}

module.exports = { makeEgoEnvCtx, resolveEnvProfile, indexEnvProfiles, setSpaceOverride, 是空白页, 是业务页, 挑页 };
