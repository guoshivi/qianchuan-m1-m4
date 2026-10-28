'use strict';
/**
 * bit-m3-paohui.js — m3 炮灰视频生成（全自动：抓图 → Remotion 合成 → 归档）
 *
 * 用户规则（2026-09-11）：
 *   · 输出目录：`~/Downloads/paohui视频/<YYYY-MM-DD>/`
 *   · 视频文件名 = **识别码**（如 demoA26091102.mp4）
 *   · 时长 **8~10 秒随机**；特效用 `combo` 场景（横条拼卡 + 经典卡片）且**每条不同**（seed=识别码）
 *   · 多图：默认抓 **2~3 张**商品图（商品详情页图库）
 *   · 硬规则：任何元素不得遮挡产品主图；主图不得全屏盖掉特效
 *
 * 用法：
 *   node bit-m3-paohui.js --frag demoA26091102 --unionId <联盟商品ID> [--images 3] [--scene combo]
 *                          [--productId <千川商品ID>] [--account <号A>] [--minDur 8] [--maxDur 10]
 *   node bit-m3-paohui.js --frag demoA26091102 --cartTitle "抽油烟机吸油棉"   # 用标题从选品车找联盟ID
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const api = require('./bit-api.js');
const { openFreshTab, tryEval, cleanCartTitle, findCartRow, CART_URL, setCartSearch, findCartSearchBox,
        submitCartSearch, makeCartReader } = require('./commission-fetch.js');
const CAPTCHA = require('./captcha.js');
const CFG = require('./qc-config.js');
const LEDGER = require('./bit-ledger.js');

const argv = process.argv || [];
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const has = (k) => argv.includes(k);
const log = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FRAG = arg('--frag');
const ACCOUNT = require('./account.js').accountOrExit(arg('--account'));
const UNION_ID = arg('--unionId');
const PRODUCT_ID = arg('--productId');
const CART_TITLE = arg('--cartTitle');
const IMG_N = parseInt(arg('--images') || '3', 10);
const SCENE = arg('--scene') || 'combo';
const MIN_DUR = parseFloat(arg('--minDur') || '8');
const MAX_DUR = parseFloat(arg('--maxDur') || '10');
const KEEP_OPEN = has('--keepOpen');
// 🖼 首帧封面段（秒）：用户 2026-09-18 定「炮灰视频用商品主图做封面」→ 视频**开头这一段整屏主图**，
//   抖音默认封面即首帧；`--coverSec 0` 可关掉。主图 = 详情页图库第一张（imgs[0]）。
const COVER_SEC = parseFloat(arg('--coverSec') || '0.6');

// 出片工程位置：默认用本仓库自带的 remotion/（原私仓里是 ~/tools/remotion-vlog，
// 公开版改成跟随本仓库，可用 PAOHUI_REMOTION 覆盖）
const REMOTION = process.env.PAOHUI_REMOTION || path.join(__dirname, '..', 'remotion');
const PUBLIC = path.join(REMOTION, 'public');
const OUT_ROOT = process.env.PAOHUI_OUT || path.join(os.homedir(), 'Downloads', 'paohui视频');
// ⚠️ 必须用**本地日期**：`toISOString()` 是 UTC，本地 09-12 凌晨会被写成 09-11 的目录
//    （铁律 #5；实测：00:30 生成的炮灰落进了 2026-09-11 目录）
const TODAY = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); })();

if (!FRAG) { log({ stage: 'ARG', ok: false, err: '需要 --frag <识别码>（同时作为渲染 seed 与文件名）' }); process.exit(3); }
if (!UNION_ID && !CART_TITLE) { log({ stage: 'ARG', ok: false, err: '需要 --unionId <联盟商品ID> 或 --cartTitle <标题关键词>' }); process.exit(3); }

const DY = (CFG.dyEnvs || []).find((d) => (d.name || '').includes(ACCOUNT));
if (!DY) { log({ stage: 'ARG', ok: false, err: '号未找到: ' + ACCOUNT }); process.exit(3); }

(async () => {
  log({ stage: 'BOOT', ok: true, 识别码: FRAG, 号: DY.name, 图片数: IMG_N, 场景: SCENE, 时长区间: `${MIN_DUR}~${MAX_DUR}s`, 输出: path.join(OUT_ROOT, TODAY, FRAG + '.mp4') });

  // ---------- ① 定位联盟商品ID（可选：从选品车按标题找） ----------
  // ⚠️ 2026-09-13 改「三级查询」（原来只读一次全量 + 按标题匹配）：
  //    原来依赖"选品车页面当前恰好是干净的"，而 `bit-cart-map.js --find` 用完会**留下搜索过滤**
  //    （实测 `ROWS_LOADED 行数:1`）→ 这里报 `选品车没找到: <品名>`（品就在车里，被自己的过滤挡住了）。
  //    现在 findCartRow 走：**缓存(商品ID→联盟ID/标题) → 清过滤后读全量 → 搜索框（标题 / 商品ID）**，
  //    三级都命中不了才失败，并把诊断打出来（不猜、不静默）。
  let unionId = UNION_ID;
  let title = '';
  if (!unionId) {
    const found = await findCartRow(DY.env, { productId: PRODUCT_ID || '', title: CART_TITLE || '', log, account: DY.name });
    if (!found.row) {
      log({ stage: 'ARG', ok: false, err: '选品车没找到: ' + (CART_TITLE || PRODUCT_ID),
            诊断: found.诊断 || null,
            说明: '已按「缓存 → 全量 → 搜索框」三级查过；若是新号/刚清缓存，先跑 bit-cart-map.js --find <商品ID>' });
      process.exit(3);
    }
    unionId = found.row.商品ID; title = found.row.标题;
    log({ stage: 'FIND_UNION', ok: true, 联盟ID: unionId, 标题: String(title).slice(0, 30), 来源: found.来源 });
  }

  // ---------- ② 进商品决策页 → 抓商品图（**ego 原生**） ----------
  // ⚠️ 2026-09-23（用户两次点破）：
  //   ① 「你再目前这个标签就是选品车 搜索商品 id 这个页面直接续用这个页面点进进去不就好了吗？」
  //      —— 原来是**新开标签 + 裸 URL**（比特版 m3a 也这么写，我照抄了）。实测同一时间同一个品：
  //        裸 URL → 骨架屏「抱歉，暂时无法获取数据」，还可能撞验证码（截图 /tmp/qc-ego/diag-m3img.png）；
  //        从选品车点「去带货」→ 正常商品决策页，**8 张 ecom-shop-material 图、无验证码**（/tmp/qc-ego/diag-p18.jsonl）。
  //   ② 「你把 ego 的优势全丢了」—— 所以这里用 ego 原生的那套：
  //        认领已有标签（不 task.newPage）· `page.click('text=…')` 代替拼坐标 · `page.waitForFunction` 代替自写轮询
  //        · `page.evaluate(函数)` 代替拼字符串表达式（今天已因拼字符串+转义写坏过一次正则）。
  //   ⛔ 绝不"点第一个去带货"（canon #21 镜像：没证明过滤生效就点 = 可能点开别的商品 ⇒ 炮灰做成别的产品）。
  const detailUrl = `https://buyin.jinritemai.com/dashboard/merch-picking-library/merch-promoting?id=${unionId}&enter_from=%E9%80%89%E5%93%81%E8%BD%A6%E9%A1%B5%E9%9D%A2`;
  const info = (typeof taskSpace === 'function') ? { pid: null } : await api.open(DY.env);

  const 期望ID = String(PRODUCT_ID || '');
  const 联盟ID = String(unionId || '');
  const 标题头 = String(cleanCartTitle(CART_TITLE || title || '')).slice(0, 6);
  let imgUrls = [];
  let 抓图页 = '';   // 抓图时那一页的 URL（留痕：出片后能追溯"图是从哪页抓的"✓ 2026-09-29）
  let page = null, egoTask = null, 认领标签 = null, 裸URL开的 = false;
  let EGO_T = null;   // audit 的 REF 扫描要求声明紧跟 let ⇒ 单独一行

  const 是本品决策页 = (u) => /merch-promoting/.test(String(u || '')) && (!联盟ID || String(u).includes(联盟ID));
  const 全部标签 = async () => (egoTask && EGO_T) ? await EGO_T.listTabs(egoTask) : [];
  const 认领 = async (tab) => { page = tab.label ? egoTask.page(tab.label) : await egoTask.adopt(tab.page); 认领标签 = tab; return page; };
  const 抓图 = async () => {
    const urls = await page.evaluate(() => [...new Set([...document.querySelectorAll('img')]
      .map((i) => i.getAttribute('src') || '').filter((x) => /ecom-shop-material/.test(x)))]);
    return (urls || []).filter((u) => !/qualification/.test(u)).slice(0, IMG_N);
  };
  const 当前URL = async (pg) => { try { return String((await pg.evaluate(() => location.href)) || ''); } catch (e) { return ''; } };
  const 有验证码 = async (pg) => {
    try { return !!(await pg.evaluate(CAPTCHA.captchaInPage)); } catch (e) { return false; }
  };

  try {
    if (typeof taskSpace !== 'function') throw new Error('m3a 的 ego 入口只在 ego 运行时可用');
    EGO_T = require('./ego/ego-transport.js');
    egoTask = await require('./ego/ego-env-ctx.js').makeEgoEnvCtx(DY.env, { log }).egoTask();
    EGO_T.keepTask(egoTask);

    // ① **认领已有**的本品决策页标签（零导航、零点击 —— 用户常常已经点开了）
    const 现成 = (await 全部标签()).find((t) => 是本品决策页(t.url));
    if (现成) {
      await 认领(现成);
      log({ stage: 'DETAIL_TAB_REUSE', ok: true, label: 现成.label, url: String(现成.url).split('?')[0], 说明: '认领已打开的商品决策页（零导航）' });
    }

    // ② 没有 → 认领选品车标签 → ego 原生点「去带货」（**它会开新标签**）→ 去标签列表里认领新的
    if (!page) {
      let 车 = (await 全部标签()).find((t) => /merch-picking-cart/.test(String(t.url || '')));
      // 🔴🔴 2026-09-29 实盘（10 个品里 **3 个** `IMAGES count:0 → ERR 没抓到商品图` ✗：品04/05/10）：
      //   现在每轮跑完都**关空间**（`keepSpaces:false` ✓）⇒ 新空间里**根本没有选品车标签** ✗，
      //   而这条分支原来直接掉到 ③ **裸 URL** ✗ —— 本文件上面自己就写着"裸 URL 易得骨架屏/验证码"✗，
      //   于是出不出图全看运气（同一批 7 个出、3 个不出 ✗）。
      //   ⇒ 照 `bit-cart-map.js` 的老办法：**没有就自己开一张选品车**（六件套注入 + 导航 ✓），
      //     开完重新列标签，继续走下面那条"搜索 → 点商品名 → 认领决策页"的稳路 ✓。
      //   ⛔ 裸 URL 只配当最后的兜底，不能当主路 ✗
      if (!车) {
        try {
          const r0 = await openFreshTab(DY.env, info.pid, CART_URL);
          try { r0.cdp.close(); r0.browser.close(); } catch (e) {}
          for (let i = 0; i < 15 && !车; i++) {
            await sleep(800);
            车 = (await 全部标签()).find((t) => /merch-picking-cart/.test(String(t.url || '')));
          }
          log({ stage: 'CART_AUTO_OPEN', ok: !!车,
                说明: 车 ? '空间里没有选品车标签 → **自动开了一张**（避免掉到裸 URL 那条不稳的路 ✓）'
                        : '自动开选品车失败（12s 内没等到标签）→ 只能回落裸 URL ✗' });
        } catch (e) {
          log({ stage: 'CART_AUTO_OPEN', ok: false, err: String(e.message || e).slice(0, 120), 说明: '自动开选品车抛错 → 回落裸 URL ✗' });
        }
      }
      if (车) {
        await 认领(车);
        const 读车态 = () => page.evaluate(() => {
          const i = [...document.querySelectorAll('input')].find((x) => x.offsetParent && /商品名称或者ID|请输入商品/.test(x.placeholder || ''));
          const rows = [...document.querySelectorAll('tr')].filter((r) => r.offsetParent && /去带货|佣金/.test(r.innerText || ''));
          return { box: i ? i.value : null, rowCount: rows.length,
                   rowText: rows.length === 1 ? (rows[0].innerText || '').replace(/\s+/g, ' ').slice(0, 120) : '' };
        }).catch(() => ({}));
        const 判住 = (态) => (期望ID && String(态.box || '') === 期望ID)
          || (态.rowCount === 1 && (!标题头 || String(态.rowText || '').includes(标题头)));
        let 态 = await 读车态();
        let 过滤住了 = 判住(态);
        log({ stage: 'CART_FILTER_STATE', ok: 过滤住了, 期望ID, 搜索框: 态.box || null, 行数: 态.rowCount, 行文本: (态.rowText || '').slice(0, 60) });

        // 🆕 2026-09-29（第二轮补发实盘 ✗）：**光"检查"过滤状态是永远过不去的** ——
        //   现在每轮关空间 ⇒ 选品车要么没有（上游会自动开一张 ✓），要么刚开出来**搜索框是空的** ✗
        //   ⇒ CART_FILTER_STATE ok:false ⇒ 一路掉到裸 URL ⇒ `IMAGES count:0` ✗（品04/05 就卡在这）。
        //   ⇒ 按**用户 2026-09-23 亲自定的姿势**（原话：「你再目前这个标签就是选品车 **搜索商品 id**
        //     这个页面直接续用这个页面点进进去不就好了吗？」✓）：**脚本自己用搜索框定位本品** ✓
        //     —— 填商品ID（其次标题头）→ 回车 → 等结果 → **重新读状态证明过滤生效了，再点** ✓
        //   ⛔ 这一条**不违反**"没证明过滤生效就点"的红线 ✓：我们仍然要**证明**（重新读 ✓），证明不了照样不点 ✓
        if (!过滤住了) {
          const kw = 期望ID || 标题头;
          let 搜 = { ok: false, 原因: '没关键词' };
          if (kw) {
            // ⚠️ 2026-09-29 实盘两次踩坑（都在这条路上）：
            //   ① 选品车刚自动开出来，**搜索框还没渲染** ⇒ 自己 evaluate 找框 = `没找到搜索框` ✗
            //   ② 就算找到框，`i.value = k` 也**填不进去**（React 受控输入 ✗，实测 `填入:""` ✗）
            //   ⇒ 用仓库**现成**的 `setCartSearch`（原生 setter + input/change + 回车 ✓，找框自带
            //     8 轮 × 1.2s 轮询 + bringToFront ✓）—— 别再手搓第二份 ✗（canon：判据/动作只有一个主人 ✓）
            try {
              const reader = await makeCartReader(DY.env, log);   // ego 版 reader：复用已开的选品车页 ✓
              搜 = { ok: await setCartSearch(reader, kw, log), 方式: 'setCartSearch(原生 setter + 回车)' };
            } catch (e) {
              搜 = { ok: false, err: String(e.message || e).slice(0, 90) };
            }
            await sleep(2000);
            态 = await 读车态();
            过滤住了 = 判住(态);
          }
          log({ stage: 'CART_FILTER_SELF', ok: 过滤住了, 关键词: kw || null, 搜索: 搜,
                搜索框: 态.box || null, 行数: 态.rowCount, 行文本: (态.rowText || '').slice(0, 60),
                说明: '选品车原来没停在目标商品上 → 脚本自己用搜索框定位（用户 2026-09-23 定的姿势 ✓）；仍以"重新读状态"为判据 ✓' });
        }
        if (!过滤住了) {
          log({ stage: 'CART_NOT_FILTERED', ok: false, 搜索框: 态.box || null, 行数: 态.rowCount, 行文本: 态.rowText,
                说明: '选品车没停在目标商品上 → 不点（绝不点第一个去带货）；请先在选品车搜到该品' });
          // 🔴🔴 2026-09-29 实盘事故（用户报「炮灰视频什么产品图片都有，跟挂车的一点关系都没有」✗✗）：
          //   这里原来**只打日志、没把 page 置空** ✗ ⇒ `page` 还指着**选品车列表页**，
          //   而下面那道"不是本品决策页 ⇒ 置空走裸 URL"的兜底闸门被写在 `else`（过滤成功）分支里 ✗
          //   ⇒ 于是它在**选品车列表**上抓了 `img[src*=ecom-shop-material]` = **一页里各种商品的缩略图** ✗
          //   ⇒ 炮灰视频/封面全成了别的商品（实测抓到的封面是「栗子开口器」，挂车的是「断桥铝窗户防撞角」）✗✗。
          //   ⇒ 修：**一发现没停在目标商品上，立刻把 page 置空** ✓ ⇒ 自然走 ③ 裸 URL（detailUrl = 本品联盟ID
          //     的决策页 ✓）。**判据：抓图前必须能证明"这一页是本品决策页"**（canon #48/#65/#71/#72 同族 ✓）。
          page = null;
        } else {
          // ⚠️ 2026-09-23 实盘（<号B> 那次点了没反应）：p4 是**后台标签** —— 仓库里已有同类记录
          //   （canon #24「后台标签上 CDP 的打字/回车都不落地」）。⇒ 点之前先把**标签**切到前台。
          //   `Page.bringToFront` 只把标签在窗口内激活，**不会**提 OS 窗口（不抢用户焦点，符合纪律）。
          try { await page.cdp('Page.bringToFront', {}); } catch (e) {}
          await sleep(400);
          // ⚠️ 2026-09-23（用户点破：「你傻啊 直接点商品名就可以了啊」）：
          //   别去找那个「去带货」按钮 —— 选品车页里有 **4 个**同名元素（商品行 + 推荐位），
          //   撞多匹配 → 点了个不该点的、也没反应（实测 CART_ENTRY ok:false）。
          //   ⇒ **直接点商品名**（用户就是这么点进去的，能开出商品决策页标签）。
          let 点了 = false;
          try { await page.click('text=' + 标题头, { timeout: 6000 }); 点了 = true; }
          catch (e) { log({ stage: 'CART_NAME_CLICK_TRY', ok: false, how: 'text=', err: String(e.message).slice(0, 80) }); }
          if (!点了) {
            const pos = await page.evaluate((head) => {
              const el = [...document.querySelectorAll('a,span,div')].find((e) => e.offsetParent
                && (e.innerText || '').trim().includes(head) && (e.innerText || '').trim().length < 60);
              if (!el) return null;
              el.scrollIntoView({ block: 'center' });
              const r = el.getBoundingClientRect();
              return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
            }, 标题头).catch(() => null);
            if (pos) { await page.mouse.click(pos.x, pos.y); 点了 = true; }
          }
          log({ stage: 'CART_CLICK', ok: 点了, 方式: '点商品名', 标题头 });
          let 新 = null;
          for (let i = 0; i < 20 && !新; i++) { await sleep(700); 新 = (await 全部标签()).find((t) => 是本品决策页(t.url)); }
          if (新) { await 认领(新); log({ stage: 'CART_ENTRY', ok: true, label: 新.label, url: String(新.url).split('?')[0], 说明: '从选品车点「去带货」→ 认领新开的决策页标签' }); }
          else {
            // 两种可能：① 它是**原标签内跳转**（那就继续用这一页）② 压根没跳 → 必须离开选品车页
            const u = await 当前URL(page);
            if (是本品决策页(u)) log({ stage: 'CART_ENTRY', ok: true, 方式: '原标签内跳转', url: u.split('?')[0] });
            else { log({ stage: 'CART_ENTRY', ok: false, 现在: u.split('?')[0] || '(读不到)', 说明: '点了去带货但没等到本品决策页标签，也没在原标签跳过去' }); page = null; }
          }
          // ⛔ 兜底判据：**只要当前页不是本品的商品决策页，就绝不在它上面抓图**
          //    （2026-09-23 实盘踩到：入口失败后它留在选品车页，抓到了**行缩略图**当商品图 ——
          //      虽然仍是本商品的主图，但只有 1 张、且来源错了）
          if (page && !是本品决策页(await 当前URL(page))) { log({ stage: 'CART_LEAVE', ok: false, 说明: '当前页不是商品决策页 → 置空，走裸 URL 回落' }); page = null; 认领标签 = null; }
        }
      } else log({ stage: 'CART_ENTRY', ok: false, 说明: '空间里没有选品车标签' });
    }

    // ③ 回落：裸 URL（明确记一笔；实测这条路易得骨架屏/验证码）
    if (!page) {
      const r2 = await openFreshTab(DY.env, info.pid, detailUrl);
      const c2 = r2.cdp; 裸URL开的 = true;
      log({ stage: 'DETAIL_URL_FALLBACK', ok: true, 说明: '没有可复用的标签也没点成 → 回落裸 URL' });
      page = { evaluate: (fn) => Promise.resolve(fn()).then(() => null).catch(() => null) };   // 占位：兜底只用 cdp
      for (let i = 0; i < 20; i++) { await sleep(600); const u = String(await tryEval(c2, 'location.href', 4000) || ''); if (/merch-promoting/.test(u)) break; }
      if (await tryEval(c2, CAPTCHA.CAPTCHA_EXPR, 6000)) {
        log({ stage: 'CAPTCHA_BLOCK', ok: false, 号: DY.name, 识别码: FRAG, 提示: '这一页有验证码/滑块 → 窗口保留给你人工过，过完原命令重跑' });
        try { if (typeof handOff === 'function') handOff(); } catch (e) {}
        process.exit(4);
      }
      const raw = (await tryEval(c2, `(() => [...new Set([...document.querySelectorAll('img')].map(i => i.getAttribute('src') || '').filter(s => /ecom-shop-material/.test(s)))])()`, 12000)) || [];
      imgUrls = (raw || []).filter((u) => !/qualification/.test(u)).slice(0, IMG_N);
      抓图页 = String(await tryEval(c2, 'location.href', 4000) || '');
      if (imgUrls.length && imgUrls.length < 2) log({ stage: 'IMAGES_LOW', ok: false, count: imgUrls.length,
        说明: '只拿到 1 张（裸 URL 这条路常见）→ 炮灰只用一张图，观感会弱；建议在选品车点「去带货」后重跑' });
      title = title || String(await tryEval(c2, `(document.body.innerText||"").replace(/\\s+/g," ").slice(0,60)`, 6000) || '');
      page = null;
    } else {
      // 🔴🔴 2026-09-29 事故后的**纵深防御**（用户报「炮灰视频什么产品图片都有」✗✗）：认领到的这一页
      //   必须是**本品的商品决策页**才允许抓图 ✗ —— 事故根因是"没过滤住时 page 没置空 ⇒ 在选品车
      //   列表页抓到了各种商品的缩略图"（已在上游修掉 ✓，这里再钉一道：**证明不了就宁可不出片** ✗）。
      //   判据 = `是本品决策页(url)`（merch-promoting + 本品联盟ID ✓，canon #48/#65/#71/#72 同族）。
      const 本页 = await 当前URL(page);
      if (!是本品决策页(本页)) {
        log({ stage: 'IMG_PAGE_GUARD', ok: false, 现在: String(本页).split('?')[0] || '(读不到)',
              期望: 'merch-promoting + 联盟ID ' + (联盟ID || '(无)'),
              说明: '认领到的页面**不是本品决策页** ⇒ **拒绝抓图**（否则炮灰会做成别的商品 ✗✗）⇒ 请先在选品车搜到该品（或等裸 URL 那条路）再重跑' });
        process.exit(2);
      }
      抓图页 = 本页;
      // ④ 验证码当场认出来（判据主人 captcha.js）→ 保留窗口交还人工
      if (await 有验证码(page)) {
        log({ stage: 'CAPTCHA_BLOCK', ok: false, 号: DY.name, 识别码: FRAG, label: 认领标签 && 认领标签.label,
              提示: '这一页有验证码/滑块 → 窗口保留给你人工过，过完原命令重跑（已完成阶段会 SKIP）' });
        try { if (typeof handOff === 'function') handOff(); } catch (e) {}
        process.exit(4);
      }
      // ⑤ 图库：ego 原生「先查后睡」——节奏 = **先查一次 → 12s → 18s → 30s**（合计 ≤60s）
      //    ⚠️ 2026-09-28 实盘（新店铺首个品，两个号都踩到，canon #62）：原来是 20 轮 × 800ms ≈ 16s ⇒
      //       **刚点开决策页（冷标签）**时等满仍 0 张 ⇒ 报「没抓到商品图」把整条链路挡在 m3a ✗；
      //       而 2 分钟后**同一页**有 8 张 ecom-shop-material 图（readyState=complete）✓
      //       ⇒ 是「等得不够」，不是「没有图」（skill 定的节奏本来就是"首次 12s、未出再 18s"）。
      //       （同一页复跑时是走 ① 认领已有决策页 ⇒ 第一次就查到，这一轮等待不花时间 ✓）
      //    ⛔ 别改成密集轮询：每轮只读一次 DOM，**越等越长**（温柔原则，见 skill「提取数据的节奏」）。
      imgUrls = await 抓图();
      for (const waitMs of [12000, 18000, 30000]) {
        if (imgUrls.length) break;
        log({ stage: 'IMAGES_WAIT', ok: true, 本轮等毫秒: waitMs, 说明: '图库还没渲染出来 → 再等一轮（冷标签首次打开决策页会慢）' });
        await page.waitForFunction(() => [...document.querySelectorAll('img')].some((x) => /ecom-shop-material/.test(x.getAttribute('src') || '')), { timeout: waitMs }).catch(() => {});
        imgUrls = await 抓图();
      }
      // 🆕 2026-09-29 实盘（品04 摩托车手把套）：上面三档**全等满（12+18+30 = 60s）仍是 0 张** ✗。
      //   而 canon #62 的实盘结论是「同一页 **2 分钟后**有 8 张 ⇒ 是**等得不够**，不是没有图」✗
      //   ⇒ 再加一次 **reload + 两轮等待** ✓（刷新会把没渲染出来的 SPA 重新拉一遍 ✓）
      //   判据不变：还是抓 `ecom-shop-material`；只是给页面一次"重开"的机会 ✓
      if (!imgUrls.length) {
        try {
          try { await page.cdp('Page.bringToFront', {}); } catch (e) {}
          await page.evaluate(() => location.reload()).catch(() => {});
          log({ stage: 'IMAGES_RELOAD', ok: true, 说明: '等满 60s 仍 0 张 → **刷新决策页**再来一轮（canon #62：多为"等得不够" ✗）' });
          for (const waitMs of [20000, 25000]) {
            await sleep(waitMs);
            imgUrls = await 抓图();
            if (imgUrls.length) break;
            log({ stage: 'IMAGES_WAIT', ok: true, 本轮等毫秒: waitMs, 说明: 'reload 后仍没出图 → 再等一轮' });
          }
        } catch (e) {
          log({ stage: 'IMAGES_RELOAD', ok: false, err: String(e.message || e).slice(0, 100) });
        }
      }
      title = title || String(await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 60)).catch(() => '') || '');
    }
  } finally {
    // ⛔ 认领的都是空间里的**已有标签**（可能就是用户正在用的那一页）⇒ 一律不关、不导航走
    if (认领标签 || 裸URL开的) log({ stage: 'KEEP_TAB', ok: true, 说明: '保留标签（可能是用户在用的页）', label: 认领标签 && 认领标签.label });
  }
  log({ stage: 'IMAGES', ok: imgUrls.length > 0, count: imgUrls.length, 页面: String(抓图页).split('?')[0] || '(未记录)',
        联盟ID: 联盟ID || null,
        说明: '图是从上面这一页抓的 ⇒ 出了怪图先看这里（2026-09-29 事故：曾在选品车列表页抓到各种商品的缩略图 ✗）',
        urls: imgUrls.map((u) => u.slice(0, 70)) });
  if (!imgUrls.length) { log({ stage: 'ERR', ok: false, err: '没抓到商品图' }); process.exit(2); }

  // ---------- ③ 下载到 remotion public/ ----------
  const localImgs = [];
  for (let i = 0; i < imgUrls.length; i++) {
    const name = `m3-${FRAG}-${i + 1}.jpg`;
    const dest = path.join(PUBLIC, name);
    try {
      const r = await fetch(imgUrls[i]);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(dest, buf);
      localImgs.push(`/public/${name}`);
      log({ stage: 'DOWNLOAD', ok: true, file: name, kb: Math.round(buf.length / 1024) });
    } catch (e) { log({ stage: 'DOWNLOAD', ok: false, url: imgUrls[i].slice(0, 60), err: e.message }); }
  }
  if (!localImgs.length) { log({ stage: 'ERR', ok: false, err: '图片下载全部失败' }); process.exit(2); }

  // ---------- ③b 主图另存一份（**炮灰视频的封面**，用户 2026-09-18 定：以后封面一律用商品主图）----------
  //   主图 = 详情页图库里**第一张**（也就是喂给 Remotion 的第一张 imgUrls[0]）。
  //   存到 `~/Downloads/paohui视频/<日期>/<识别码>-主图.jpg` → m3c 发布时用它当封面（--cover 可覆盖）。
  fs.mkdirSync(path.join(OUT_ROOT, TODAY), { recursive: true });
  const coverPath = path.join(OUT_ROOT, TODAY, `${FRAG}-主图.jpg`);
  let coverOK = false;
  try {
    const r0 = await fetch(imgUrls[0]);
    fs.writeFileSync(coverPath, Buffer.from(await r0.arrayBuffer()));
    coverOK = fs.statSync(coverPath).size > 1024;
  } catch (e) { coverOK = false; }
  log({ stage: 'COVER_IMAGE', ok: coverOK, 文件: coverPath.replace(os.homedir(), '~'),
        ...(coverOK ? {} : { 说明: '主图没抓到/太小 → 发布时不设封面（m3c 会 WARN 不拦）' }) });

  // ---------- ④ 渲染（时长随机 8~10s；seed=识别码 → 特效唯一） ----------
  const dur = Math.round((MIN_DUR + Math.random() * (MAX_DUR - MIN_DUR)) * 10) / 10;
  fs.mkdirSync(path.join(OUT_ROOT, TODAY), { recursive: true });
  const finalPath = path.join(OUT_ROOT, TODAY, `${FRAG}.mp4`);
  const tmpOut = path.join(REMOTION, 'out', `${FRAG}.mp4`);
  const props = JSON.stringify({ seed: FRAG, durationSec: dur, scene: SCENE, imgSrcs: localImgs,
                                  coverSec: COVER_SEC });   // 首帧=主图（封面）
  log({ stage: 'RENDER', ok: true, 时长: dur, 首帧封面秒: COVER_SEC,
        说明: COVER_SEC > 0 ? '开头 ' + COVER_SEC + 's 整屏显示商品主图 → 抖音默认封面=主图' : '未启用首帧封面',
        props });
  // ⚠️ 2026-09-22（ego 化）：ego 沙箱的 PATH 很干净（连 `node`/`npx` 都没有，实测 ENOENT），
  //    而这里要起本地渲染子进程 ⇒ 用**绝对路径** npx + 给子进程一个正常 PATH。
  const NPX = (() => {
    const cands = [process.env.NPX_BIN, path.join(os.homedir(), '.local/bin/npx'), '/usr/local/bin/npx', '/opt/homebrew/bin/npx'];
    for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch (e) {} }
    return 'npx';
  })();
  const CHILD_ENV = { ...process.env, PATH: [path.join(os.homedir(), '.local/bin'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', process.env.PATH || ''].join(':') };
  log({ stage: 'RENDER_CMD', npx: NPX, cwd: REMOTION });
  const r = spawnSync(NPX, ['remotion', 'render', 'src/index.ts', 'Paohui', `out/${FRAG}.mp4`, `--props=${props}`], {
    cwd: REMOTION, encoding: 'utf8', timeout: 900000, maxBuffer: 64 * 1024 * 1024, env: CHILD_ENV,
  });
  if (r.status !== 0) {
    log({ stage: 'RENDER_FAIL', ok: false, err: (r.stderr || r.stdout || '').split('\n').slice(-6).join(' | ') });
    process.exit(2);
  }
  fs.copyFileSync(tmpOut, finalPath);
  const size = fs.statSync(finalPath).size;
  log({ stage: 'DONE', ok: true, 识别码: FRAG, 文件: finalPath, MB: (size / 1048576).toFixed(1), 时长秒: dur, 图片数: localImgs.length });

  // ---------- ⑤ 记台账（m3） ----------
  // ⚠️ 台账主键**必须是商品ID**（铁律 #3）。本脚本从选品车只拿得到**联盟ID**，
  //    所以以前 `PRODUCT_ID || unionId` 在没传 --productId 时会写出一条以联盟ID为键的**脏条目**
  //    （2026-09-11 实测：同一识别码在台账里出现两条，一条键是商品ID、一条是联盟ID）。
  //    现在：优先 --productId → 按识别码反查（m1 已建账）→ 按联盟ID反查；都查不到就**不写**并告警。
  const resolveKey = () => {
    if (PRODUCT_ID) return { key: PRODUCT_ID, 来源: '--productId' };
    const j = LEDGER.load() || {};
    for (const [pid, e] of Object.entries(j)) {
      if (e && e.识别码 === FRAG && /^\d{15,}$/.test(pid)) return { key: pid, 来源: '按识别码反查' };
    }
    for (const [pid, e] of Object.entries(j)) {
      if (e && String(e.联盟ID) === String(unionId)) return { key: pid, 来源: '按联盟ID反查' };
    }
    return { key: null, 来源: null };
  };
  try {
    const k = resolveKey();
    if (!k.key) {
      log({ stage: 'LEDGER_SKIP', ok: false, 识别码: FRAG, 联盟ID: unionId,
            说明: '查不到该品的商品ID → 不写台账（避免写出以联盟ID为键的脏条目）。'
                + '请先用 bit-m1-pick.js 建账，或给本脚本传 --productId' });
    } else {
      // 标题：**台账已有就用台账的**（m1 从选品车读的干净全名），只有没有才用这里抓到的。
      // 踩过（2026-09-12 柚子品实测）：这里原来无条件写 `标题: (title||'').slice(0,40)`，
      //   而 title 可能是 ① 选品车行原文（尾部粘「 ID 商品类目：」）或
      //   ② 干脆是**商品详情页正文前 60 字**（没传 --cartTitle 时的兜底）。
      //   → 把 m1 的干净标题覆盖成脏的、还截断到 40 字。台账标题是 m4/m7 的 --title 入参，
      //   脏了整条链路跟着脏（本次就是先把台账标题修回来才继续的）。
      const prev = (LEDGER.load() || {})[LEDGER.keyOf(k.key, DY.name)] || {};
      const keepTitle = prev.标题 || cleanCartTitle(title);
      LEDGER.upsert(k.key, { 标题: keepTitle, 号: DY.name, 联盟ID: unionId, 识别码: FRAG }, { account: DY.name });
      LEDGER.markStage(k.key, 'm3', { 视频: finalPath, 时长秒: dur, 图片数: localImgs.length, 备注: `remotion ${SCENE}` }, { account: DY.name });
      log({ stage: 'LEDGER', ok: true, key: k.key, 来源: k.来源, 标题保留自: prev.标题 ? '台账' : '现场抓取' });
    }
  } catch (e) { log({ stage: 'LEDGER', ok: false, err: e.message }); }
  process.exit(0);
})().catch((e) => { log({ stage: 'ERR', ok: false, err: e.message }); process.exit(2); });
