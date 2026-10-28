'use strict';
/**
 * bit-m4-upload.js — m4 直投放量计划：商品 + 自选素材本地上传（**到传完素材为止，绝不发布**）
 *
 * 用户 2026-09-11 定的规则：
 *   · 先搜商品ID（别指望列表里正好有）
 *   · 复用标签，不要一直开新标签
 *   · 跑到素材传完就停，【发布计划】留给人工点
 *
 * 实测链路（2026-09-11，<号A>直投号）：
 *   创建页 https://qianchuan.jinritemai.com/uni-creation/product?aavid=<aavid>
 *   ① 【添加商品】→ 抽屉 → 搜索框输入商品ID并回车 → 勾行内复选框（已选 N/30）→【确定】→ 已添加：1/30
 *   ② 素材设置 → 「自选投放素材」是一张**带勾选框的模式卡**（.oc-switch-card-item，勾上才有上传区）
 *   ③ 素材区【选择商品：】是**可输入下拉**（.oc-row-select → .ovui-select → input.ovui-input），
 *      不选商品会一直提示「请先选择要添加创意的商品」
 *   ④ 【添加视频】→ 弹素材抽屉（z=2000，全屏高度）：我的视频 / **上传视频** / 其他视频 / 管理视频
 *      —— 「我的视频」里能看到本号已发作品（含带识别码的炮灰视频）
 *   ⑤ 「上传视频」页签 → 拖拽区「点击上传」→ **动态唤起原生文件选择器**（页面无 input[type=file]）
 *      ⇒ 必须走 CDP：Page.setInterceptFileChooserDialog + Page.fileChooserOpened 拿 backendNodeId
 *         → DOM.setFileInputFiles({ files, backendNodeId })
 *   ⑥ 校验「已选择 N/500」→ 抽屉内【确定】把素材挂到计划
 *
 * 踩过的坑（都写进代码了）：
 *   · 抽屉选择用 .reverse().find(width>300) 会抓到抽屉 header → 改为「取文本最长的抽屉」
 *   · 顶部导航 y<120 有扩展注入项，全页按文本找按钮会误点 → 加坐标保护（抽屉内豁免，
 *     因为素材抽屉是全屏高度、页签就在 y≈32）
 *   · 复用标签会保留页面状态 ⇒ 每一步先判状态再动作（已勾/已开就别再点，点了等于关掉）
 *
 * 用法：
 *   node bit-m4-upload.js --account <号A> --productId 3000000000000000001 --probe
 *   node bit-m4-upload.js --account <号A> --productId 3000000000000000001 \
 *        --name 吸油棉 --dir ~/Downloads/4/default/3000000000000000001
 */
const fs = require('node:fs');
const path = require('node:path');
const { attachSite } = require('./tab-reuse.js');
const { makeLib } = require('./bit-qc-lib.js');
const CFG = require('./qc-config.js');

const argv = process.argv || [];
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const has = (k) => argv.includes(k);
const account = require('./account.js').accountOrExit(arg('--account'));
const pid = arg('--productId');
const name = arg('--name') || '';
const title = arg('--title') || '';   // 直投计划【标题】：用户 2026-09-11 定 = 用商品名
const visibility = arg('--visibility') || '主页始终可见';   // 用户 2026-09-11：必须是「主页始终可见」
const doPublish = has('--publish');   // 点【发布计划】（用户授权：由我点）
const dir = arg('--dir');
const probeOnly = has('--probe');
const log = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DY = (CFG.dyEnvs || []).find((d) => (d.name || '').includes(account));
if (!DY) { log({ stage: 'ARG', ok: false, err: '号未找到: ' + account }); process.exit(3); }
if (!pid) { log({ stage: 'ARG', ok: false, err: '必须给 --productId（商品ID）' }); process.exit(3); }
const AAVID = DY.aavid || arg('--aavid');   // ← 来自 qc-config.js（不硬编码账号ID）
const URL = 'https://qianchuan.jinritemai.com/uni-creation/product?aavid=' + AAVID + '&enter_from_inside=promotion_uni_header_create';

// 取「文本最长的可见抽屉」（踩过：reverse().find 会抓到 header）
const DRAWER = `[...document.querySelectorAll('.ovui-drawer,[class*="drawer"]')]
  .filter(x => x.getBoundingClientRect().width > 300)
  .sort((a,b) => ((b.innerText||'').length - (a.innerText||'').length))[0]`;

// 取「最上层抽屉」（按 z-index 最大；素材抽屉 z=2000）
const TOP_DRAWER = `(() => {
  const ds = [...document.querySelectorAll('.ovui-drawer__wrap,.ovui-drawer,.ovui-modal,[class*="drawer"],[class*="modal"]')]
    .filter(x => { const r = x.getBoundingClientRect(); return r.width > 300 && r.height > 200; });
  ds.sort((a, b) => (parseInt(getComputedStyle(b).zIndex || '0', 10) || 0) - (parseInt(getComputedStyle(a).zIndex || '0', 10) || 0));
  return ds[0] || null;
})()`;

// 按精确文本取「面积最小的可见元素」（= 真按钮，不是包裹容器）
const btnExpr = (text) => `(() => {
  const els = [...document.querySelectorAll('button,.ovui-btn,span,div,a')]
    .filter(e => (e.innerText||'').trim() === ${JSON.stringify(text)})
    .map(e => ({ e, r: e.getBoundingClientRect() }))
    .filter(x => x.r.width > 0 && x.r.height > 0);
  els.sort((a,b) => a.r.width*a.r.height - b.r.width*b.r.height);
  const x = els[0]; if (!x) return null;
  x.e.scrollIntoView({ block: 'center' });
  const r = x.e.getBoundingClientRect();
  return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), tag: x.e.tagName,
           cls: String(x.e.className||'').slice(0,50), 候选: els.length };
})()`;

const FILE_INPUTS = `[...document.querySelectorAll('input[type=file]')].map(i => ({
  accept: i.accept || '', multiple: !!i.multiple, visible: i.getBoundingClientRect().width > 0 }))`;

(async () => {
  let OK = false;   // ⚠️ 只有动作确实完成才退 0（原来一律 exit(0)，编排器会把失败当成功）
  let pubOK = !doPublish;
  log({ stage: 'BOOT', 号: DY.name, aavid: AAVID, 商品ID: pid, 名称: name || '(未给)', 标题: title ? title.slice(0,20) + '…' : '(未给)', 模式: probeOnly ? 'probe(只看不传)' : 'upload' });
  const tab = await attachSite(DY.env, URL, { logFn: log });   // ✅ 复用标签：同页零导航
  // ⚠️ 2026-09-13：attachSite 撞导航闸时会**自己等窗口重试**（批量连跑第二个品必踩）。
  //    等满仍不放行 → 明确报出来并退非 0；⛔ 绝不能往下走：原来不检查 `.blocked`，
  //    下面 `tab.js` / `tab.cdp` 直接 TypeError（`tab.js is not a function`），
  //    看着像脚本坏了，其实是限流闸（同类问题见 SOP 〇之二 #21）。
  if (tab.blocked) {
    log({ stage: 'QCNAV_ABORT', ok: false, err: '导航闸等满仍未放行（不是脚本坏了）',
          host: tab.host, 距今秒: Math.round((tab.ageMs || 0) / 1000), 已等秒: tab.等过秒 || 0,
          建议: '过 ~2 分钟原命令重跑；编排器会自动续跑，已完成阶段按台账 SKIP（不会重复建计划）' });
    process.exit(1);
  }
  // ⚠️ 弹窗挡路（用户 2026-09-12）：千川常弹"恭喜…权限通过""计划创建成功 放弃福利"等，先清一遍
  try { const { killPopups } = require('./popup-killer.js'); await killPopups(tab.cdp, log); } catch (e) {}
  const cdp = tab.cdp;
  const ctx = { env: DY.env, js: (e, ms) => tab.js(e, ms || 8000), cdp: (m, p) => tab.send(m, p), wait: (s) => sleep(s * 1000), pressKey: async () => {}, gotoAndWait: async () => {} };
  const lib = makeLib(ctx);
  const js = ctx.js;

  // 文件选择器拦截：把 fileChooserOpened 的 backendNodeId 收下来
  const chooser = [];
  try {
    cdp.ws.addEventListener('message', (ev) => {
      try { const m = JSON.parse(ev.data); if (m.method === 'Page.fileChooserOpened') chooser.push(m.params); } catch (e) {}
    });
    await tab.send('Page.setInterceptFileChooserDialog', { enabled: true });
  } catch (e) { log({ stage: 'WARN_拦截器', err: e.message }); }

  const click = async (p, d = 600) => {
    if (!p || !p.x) return false;
    // 顶部导航 y<120 有扩展注入项；素材抽屉是全屏高度（页签 y≈32）→ 抽屉内豁免
    if (!p.fromDrawer && p.y < 120) { log({ stage: 'CLICK_GUARD', 拒绝: { x: p.x, y: p.y }, 原因: '疑似顶部导航' }); return false; }
    await lib.cdpClick(p.x, p.y, d);
    return true;
  };
  // 轮询等待（别靠固定 sleep：抽屉/列表渲染时间不稳定）
  const waitFor = async (expr, ms = 15000, step = 700) => {
    const t0 = Date.now();
    for (;;) {
      const r = await js(expr, 8000);
      if (r) return r;
      if (Date.now() - t0 > ms) return null;
      await sleep(step);
    }
  };
  const readAdded = () => js(`((document.body.innerText||'').match(/已添加[:：]\\s*(\\d+)\\s*\\/\\s*30/)||[])[1] || '0'`);
  const cardActive = () => js(`(() => { const c = [...document.querySelectorAll('.oc-switch-card-item')].find(e => (e.innerText||'').includes('自选投放素材'));
    return c ? ((c.className||'').toString().indexOf('active') >= 0) : null; })()`);
  const readMatN = () => js(`(() => { const t = (document.body.innerText||'').replace(/\\s+/g,' ');
    return { 素材: parseInt((t.match(/已添加[:：]\\s*(\\d+)\\/500/)||[])[1] || '0', 10),
             视频: parseInt((t.match(/视频\\s*\\((\\d+)\\)/)||[])[1] || '0', 10) }; })()`);
  const drawerText = () => js(`(() => { const d = ${TOP_DRAWER}; return d ? (d.innerText||'').replace(/\\s+/g,' ').slice(0,400) : null; })()`);
  const waitChooser = async (ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (chooser.length) return chooser[chooser.length - 1]; await sleep(400); }
    return null;
  };

  try {
    await sleep(2500);

    // ① 状态
    let added = await readAdded();
    log({ stage: 'STEP1_初始状态', 已添加商品: added, 自选素材已启用: await cardActive() });

    // ② 商品未加 → 添加商品 → 搜ID → 勾选 → 确定
    if (added === '0') {
      // ⚠️ 2026-09-28：按钮位置**整页刷新后会变** ⇒ 每次重新算（下面卡住时要刷新页面再来一遍）
      const findAddBtn = () => js(btnExpr('添加商品'));
      const addBtn = await findAddBtn();
      log({ stage: 'STEP2_添加商品', pos: addBtn });
      // ⚠️ 2026-09-12 两个坑（用户："每次都出来了商品 你又把弹窗关了"）：
      //   ① 原来的"抽屉就绪"判据是 `元素宽度>300` —— 而 `creation-drawer-container`(w=804) **一直存在**，
      //      所以判据恒为 true，抽屉其实没开也当就绪；
      //   ② 抽屉**已经开着**时再点一次【添加商品】= 把它**关掉**（toggle）→ 后面自然找不到搜索框。
      //   正确判据 = "能看到商品搜索框"；且**已经开着就直接复用，不再点**（复用优先）。
      const hasProductDrawer = `(() => {
        const i = [...document.querySelectorAll('input')].find(x => x.offsetParent && /商品名称|商品ID|商品.*ID|名称.*ID|搜索/.test(x.placeholder || ''));
        if (!i) return false; const r = i.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })()`;
      // 抽成函数：**整页刷新后要能重来一遍**（2026-09-28 用户指出：「检测商品时如果过久，需要刷新页面才会出现」）
      const ensureDrawerOpen = async () => {
        if (await js(hasProductDrawer)) {
          log({ stage: 'STEP2_复用已开抽屉', ok: true, 说明: '商品抽屉本来就开着 → 直接复用，不再点【添加商品】（点了会把它关掉）' });
          return true;
        }
        await click(await findAddBtn(), 800);
        return !!(await waitFor(hasProductDrawer, 15000));
      };
      const opened = await ensureDrawerOpen();
      log({ stage: 'STEP2_抽屉就绪', ok: opened, 判据: '能看到商品搜索框' });
      if (!opened) { log({ stage: 'ABORT_抽屉没开', ok: false, 说明: '点了【添加商品】也没出现商品搜索框' }); return; }

      // ── 加商品：固定四步，别搞花的（用户 2026-09-11 定：**就用商品ID搜索**） ──
      //   ① 点【添加商品】打开抽屉
      //   ② 点【查看全部可投商品】 —— 默认抽屉是空列表（「暂无可选择的商品」），
      //      不展开的话搜索也是搜空列表（踩过：直接搜ID返回 0 条，误判成"商品不可投"）
      //   ③ 搜索框输入【商品ID】→ 回车 → 正常只会剩 1 行，就是它
      //   ④ 勾选 → 确定 → 校验「已添加：1/30」
      //   批量时这四步保证**不会选错品**（在列表里"找行"才会选错，已废弃）
      // 展开 + 用商品ID搜（抽成函数：整页刷新后要能重来一遍；见下面 PAGE_RELOAD 那段）
      const expandAndSearch = async () => {
        const more = await waitFor(`(() => {
          const e = [...document.querySelectorAll('a,span,div,button')]
            .filter(x => /查看全部可投商品/.test(x.innerText||'') && x.getBoundingClientRect().width > 0 && (x.innerText||'').length < 30)
            .sort((a,b) => (a.innerText||'').length - (b.innerText||'').length)[0];
          if (!e) return null;
          e.scrollIntoView({ block: 'center' });
          const r = e.getBoundingClientRect();
          return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), fromDrawer: true };
        })()`, 10000);
        log({ stage: 'STEP2a_查看全部可投商品', pos: more });
        if (more) { await click(more, 800); await sleep(3000); }

        const sbox = await waitFor(`(() => {
          const d = ${DRAWER};
          const i = (d ? [...d.querySelectorAll('input')] : []).find(x => /商品名称|商品ID|商品.*ID|名称.*ID/.test(x.placeholder||''))
                 || [...document.querySelectorAll('input')].find(x => x.offsetParent && /商品名称|商品ID|商品.*ID|名称.*ID/.test(x.placeholder||''));
          if (!i) return null;
          i.scrollIntoView({ block: 'center' });
          const r = i.getBoundingClientRect();
          if (r.width <= 0) return null;
          return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), ph: i.placeholder };
        })()`, 15000);
        log({ stage: 'STEP2b_搜索框', box: sbox });
        if (!sbox) return false;
        await lib.cdpClick(sbox.x, sbox.y, 300);
        await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['selectAll'] });
        await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', commands: ['selectAll'] });
        await sleep(200);
        await tab.send('Input.insertText', { text: pid });       // ← 只搜商品ID
        await sleep(400);
        await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
        await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
        await sleep(3000);
        return true;
      };
      if (!await expandAndSearch()) { log({ stage: 'ABORT_无搜索框', ok: false, 说明: '展开后仍找不到搜索框' }); return; }

      // 搜索结果：应只剩我们这一行
      //
      // ⛔⛔ 2026-09-30（**用户当场点破**：「都已经显示了你为什么就是不去点击确认商品？」✗）：
      //    ⭐ **用户 2026-09-30 定版口径：「渠道 id 就是 商品 id」** ✓ —— 同一个品有两个面的 ID：
      //    选品车/素材目录那份（= 我们手里的 `--productId`）与**千川创建页抽屉里显示的「渠道ID」**，
      //    **两边都代表这同一个商品** ✓（别因为数字不同就不认 ✗，见 canon #82）。
      //    （实盘抽屉原文：`渠道品 GREENER/绿林重型折叠美工刀… 渠道ID：3000000000000000003 …`）
      //    而老判据只认「行里出现 `ID：<我们那份商品ID>`」⇒ 对渠道品**永远不相等** ✗
      //    ⇒ 报 `ABORT_搜不到该商品`，可**商品明明就在抽屉第一行** ✗ —— 假阴性（canon #24 家族 ✗）。
      //    ⇒ 判据改成**两级**（沿用仓库口径「主键优先、名字只做兜底且必须**全名**匹配、模糊一律不许」✓）：
      //      ① **主键优先**：行内出现 `ID：<商品ID>` 且等于本品 ⇒ 认它 ✓（原有行为，一个字不改 ✓）
      //      ② **兜底（仅渠道品这种主键不可见的场景）**：抽屉里**只有一个商品ID/渠道ID**、
      //         且该行含**完整标题** ⇒ 认它 ✓（搜索本来就是按本品商品ID 发的 ✓，且**全名**匹配 ✓）
      //      ③ 两个都不满足 ⇒ 返回 null（**绝不模糊匹配** ✗ canon #75 家族：宁可停，绝不挂错品 ✓）
      //    ⚠️ 2026-09-30 第二版（第一版兜底**选错了元素** ✗，活页面探针实锤 ✓）：
      //       「含价格」的最短元素是 `DIV.product-price`（只有「价格 19.9 元」9 个字 ✗）⇒
      //       拿它跟完整标题比必然 false ✗。**含完整标题**的最短元素才是那一行
      //       （`DIV.product-info` / `DIV.product-column`，87 字 ✓，实测 17 个元素含完整标题 ✓）。
      //       ⇒ 兜底改成「**含完整标题、且含 `.product-info`** 的最短元素」——
      //         带 `.product-info` 是为了让下面 findRowPos 的勾选框选择器必然命中 ✓
      //         （`.product-info .ovui-checkbox__wrapper` 是仓库原有的判据 ✓）。
      const rowExpr = `(() => {
        const d = ${DRAWER}; if (!d) return null;
        const TXT = (e) => (e.innerText || '').replace(/\\s+/g, ' ');
        const ids = new Set();
        for (const e of d.querySelectorAll('tr,div,li')) { const m = TXT(e).match(/ID[：:]\\s*(\\d{10,})/); if (m) ids.add(m[1]); }
        const cands = [...d.querySelectorAll('tr,div,li')]
          .filter(e => /价格/.test(TXT(e)))
          .sort((a,b) => TXT(a).length - TXT(b).length);
        const hit = cands.find(e => { const m = TXT(e).match(/ID[：:]\\s*(\\d{10,})/); return m && m[1] === ${JSON.stringify(pid)}; });
        if (hit) return hit;
        const TITLE = ${JSON.stringify(String(title || ''))};
        if (!TITLE) return null;
        const withTitle = cands.filter(e => TXT(e).includes(TITLE));
        return withTitle.find(e => e.querySelector('.product-info')) || withTitle[0] || null;
      })()`;
      // ⚠️ 商品卡片里有**两个**复选框：「只看未投放商品」（筛选，默认勾上）和**商品行本身的勾选框**。
      //    2026-09-11 踩坑：原来直接取 `row.querySelector('input[type=checkbox]')`（DOM 里第一个）
      //    → 点到了筛选框，商品始终没被选中，`已选` 永远是 0/30（用户："你没选商品 已选永远是 0/30"）。
      //    实测：商品行的勾选框在 `.product-info` 里（.ovui-checkbox__wrapper，16×16）。
      const findRowPos = () => js(`(() => {
        const row = ${rowExpr}; if (!row) return null;
        row.scrollIntoView({ block: 'center' });
        const b = row.querySelector('.product-info .ovui-checkbox__wrapper')
               || row.querySelector('.product-info input[type="checkbox"]')
               || row.querySelector('.product-info .ovui-checkbox')
               || row.querySelector('.oc-card-wrapper .ovui-checkbox__wrapper')
               || row.querySelector('.card-container .ovui-checkbox__wrapper');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        if (r.width <= 0) return null;
        // ⚠️ 权限提示可能在同一行的**另一个单元格**里（表格版），只读"含ID+价格的最小元素"会漏掉
        const trEl = row.closest('tr') || row.parentElement || row;
        const trTxt = (trEl.innerText || '').replace(/\\s+/g, ' ');
        const inp = (b.tagName === 'INPUT') ? b : b.querySelector('input[type="checkbox"]');
        const checked = inp ? !!inp.checked : null;
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
                 目标: (b.className||'').toString().slice(0,50),
                 已勾上: checked,
                 // ⚠️ 留痕：这一行是**按商品ID**认出来的，还是**按完整标题**兜底认出来的（渠道品 ✓）
                 匹配: ((row.innerText||'').includes(${JSON.stringify(pid)})) ? '商品ID' : '完整标题(渠道品)',
                 整行: trTxt.slice(0, 300),
                 行: (row.innerText||'').replace(/\\s+/g,' ').slice(0,90) };
      })()`);
      // 重新触发一次搜索（清空重输 + 回车）—— 千川搜索是异步的，
      // 踩过 2026-09-11：输入框里已有 ID，但结果列表还没回来就判定"搜不到"并 ABORT，
      // 实际商品几分钟后就出现在列表里（用户："不是出来了吗"）。
      const retypeSearch = async () => {
        const b = await js(`(() => { const d = ${DRAWER}; if (!d) return null;
          const i = [...d.querySelectorAll('input')].find(x => /商品|名称|ID|搜索/.test(x.placeholder||''));
          if (!i) return null; const r = i.getBoundingClientRect();
          return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
        if (!b) return false;
        await lib.cdpClick(b.x, b.y, 250);
        await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['selectAll'] });
        await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', commands: ['selectAll'] });
        await sleep(200);
        await tab.send('Input.insertText', { text: pid });
        await sleep(400);
        await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
        await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
        return true;
      };
      // ⭐ 2026-09-28（**用户指出**）：「检测商品时如果过久，需要**刷新页面**才能出现」。
      //    实盘坐实：权限早已生效，而 m4 那几轮全是 `EGO_REUSE_SAME_PAGE 零导航复用（不刷新）`
      //    + 只在抽屉里重搜 ⇒ **永远看不到更新** ✗（监视器 `--reloadEvery 30` 一刷新，
      //    第 1 轮就 `PERMISSION_READY`：`我们的行:ID：…`、`行有权限提示:false` ✓）。
      //    ⇒ 卡住就**整页刷新一次**，再重开抽屉 + 展开 + 用商品ID重搜。
      //    ⚠️ 刷新是对「千川页绝不反复刷新（会掉登录）」红线的**用户指定例外**，
      //       所以必须带**掉登录自检**（判据与 `probe-qc-shop-permission.js` 同一套）：
      //       一掉登录**立刻停**，绝不一边刷一边把会话刷没 ✗。
      const reloadThenResearch = async (round) => {
        try { await tab.send('Page.reload', { ignoreCache: true }); } catch (e) {}
        await sleep(4500);
        const st = await js(`(() => ({ url: location.href,
          login: /login|passport|sso/i.test(location.href) || /扫码登录|请登录|登录后即可/.test(document.body.innerText || '') }))()`);
        if (st && st.login) {
          log({ stage: 'LOGIN_LOST', ok: false, 轮次: round, url: String(st.url).slice(0, 90),
                说明: '⚠️ 整页刷新后掉登录 → 立刻停止（继续刷只会更糟）；请人工登录后重跑 m4' });
          return false;
        }
        log({ stage: 'PAGE_RELOAD', ok: true, 轮次: round, url: String((st && st.url) || '').split('?')[0],
              说明: '抽屉里重搜看不到更新（权限/索引是服务端状态）→ 整页刷新后重开抽屉再搜' });
        if (!await ensureDrawerOpen()) {
          // 🚨 判据纪律：抽屉没开 ≠ 商品不在 ⇒ 这一轮不作为"搜不到"的依据（同监视器的 DRAWER_NOT_OPEN）
          log({ stage: 'DRAWER_NOT_OPEN', ok: false, 轮次: round, 说明: '刷新后抽屉没开出来 → 本轮不作为"行没出现"的依据' });
          return true;
        }
        await expandAndSearch();
        return true;
      };
      // 轮询等结果（最长 ~90s + 中途一次整页刷新）：每 4 轮打印一次抽屉实况，方便判断到底是"没搜到"还是"还在加载"
      let rowPos = null;
      // ⭐ 每品独立（⛔ 不能用 globalThis —— 第二个品会继承 true ⇒ 不刷新 ✗）
      let permReloaded = false;
      for (let i = 0; i < 30 && !rowPos; i++) {
        rowPos = await findRowPos();
        if (rowPos) break;
        if (i === 6 || i === 14) { const r = await retypeSearch(); log({ stage: 'STEP2c_重搜', 轮次: i + 1, 已重输: r }); }
        if (i === 20) { if (!await reloadThenResearch(i + 1)) return; }
        if (i % 4 === 0) {
          const dt = await js(`(() => { const d = ${DRAWER}; return d ? (d.innerText||'').replace(/\\s+/g,' ').slice(0,180) : null; })()`);
          log({ stage: 'STEP2c_等结果', 轮次: i + 1, 抽屉: dt });
        }
        await sleep(3000);
      }
      const seenIds = await js(`(() => { const d = ${DRAWER}; if (!d) return [];
        const s = new Set(); for (const e of d.querySelectorAll('tr,div,li')) {
          const m = (e.innerText||'').match(/ID[：:]\\s*(\\d{10,})/); if (m) s.add(m[1]); }
        return [...s].slice(0, 6); })()`);
      // 判据文本 = 整行（含同行其它单元格） + 抽屉全文（权限提示有时挂在行外的列表容器上）
      let drawerTxt = await js(`(() => { const d = ${DRAWER}; return d ? (d.innerText||'').replace(/\\s+/g,' ') : ''; })()`);
      let rowText = ((rowPos && rowPos.整行) || '') + ' || ' + ((rowPos && rowPos.行) || '') + ' || ' + (drawerTxt || '');
      // ⚠️ 第二道闸门：行上挂着「暂无…全域投放权限」= 商品还没法加（不是"没勾上"）。
      //    2026-09-12 实测（中性笔品）：报"商品未勾上"会误导排查方向，这里明确报闸门。
      const PERM_RE = /全域投放权限[^）)]*[（(]商品所属店铺[：:]\s*([^）)]+)/;
      let permMsg = rowText.match(PERM_RE);
      // ⭐⭐ 2026-10-01（**用户实测点破** ✓）：「一定要**刷新页面**才会出现，不然缓存永远是
      //    『暂无使用所选抖音号投放商品所属店铺的全域投放权限，请耐心等待权限配置生效』——
      //    我用**其他空间**看了下早就好了 ✓」。
      //    ⇒ 这句是**页面缓存下来的前端状态** ✗：本脚本走 `EGO_REUSE_SAME_PAGE` **零导航复用** ✓，
      //      不刷新就永远看到那句旧的 ✓（与第 316~323 行同一条实盘结论 ✓，但**那道闸门当时没走刷新就 abort 了** ✗
      //      ⇒ 今晚一整夜的"等权限"多半都是假的 ✗）。
      //    ⇒ 现在：**每分钟刷一次 + 抽屉重搜**，最多 3 轮（≈3 分钟）再判 ✓；
      //      刷新后**还在** ⇒ 才是真的没生效 ⇒ 才 abort ✓。
      //      ⛔ 每轮只刷一次、总共 3 次，绝不密集刷 ✗（千川"别反复刷新"是红线 ✓，
      //      `reloadThenResearch` 自带**掉登录自检** ✓，一掉登录立刻停 ✓）。
      if (permMsg && !permReloaded) {
        permReloaded = true;
        // 用户 2026-10-01 追加：「**可以附加一分钟刷一次页面再里面**」✓
        //   ⇒ 服务端权限是**异步生效**的 ✓，一分钟一轮刚好把"刚生效"那一刻捞进来 ✓。
        for (let k = 1; k <= 3 && permMsg; k++) {
          log({ stage: 'PERM_刷新重判', 第几次: k, 最多: 3, 店铺: permMsg[1], 命中原文: permMsg[0],
                说明: '页面缓存嫌疑（用户 2026-10-01 实测：其他空间早就好了）⇒ 整页刷新 + 抽屉重搜后再判 ✓（约每分钟一次 ✓）' });
          if (!await reloadThenResearch('perm' + k)) return;     // 掉登录 ⇒ 它已打 LOGIN_LOST ✓，我们立刻停 ✓
          await sleep(35000);                                    // 摊到约 1 分钟一轮 ✓
          const dt2 = await js(`(() => { const d = ${DRAWER}; return d ? (d.innerText||'').replace(/\\s+/g,' ') : ''; })()`);
          const row2 = await findRowPos();
          drawerTxt = dt2;
          rowText = ((row2 && row2.整行) || '') + ' || ' + ((row2 && row2.行) || '') + ' || ' + (dt2 || '');
          permMsg = rowText.match(PERM_RE);
          if (row2 && !permMsg) {
            rowPos = row2;
            log({ stage: 'PERM_刷新后已生效', ok: true, 第几次: k, 说明: '刷新后权限提示消失 ⇒ 继续勾选（用户判断正确 ✓）' });
            break;
          }
          log({ stage: 'PERM_仍未生效', ok: false, 第几次: k, 还剩: 3 - k, 抽屉尾部: String(dt2 || '').slice(-120) });
        }
      }
      if (permMsg) {
        log({ stage: 'ABORT_店铺权限未生效', ok: false, 商品ID: pid, 店铺: permMsg[1],
              // ⚠️ 2026-09-12 修：原来只打 `rowText.slice(0,160)` —— 而权限提示挂在**行/抽屉尾部**，
              //    正好被切掉，排查时看不到关键证据（SOP 〇之二 #1「判据写窄/只读最小元素」的同类）。
              //    现在把命中的那句单独打出来，并附抽屉尾部，一眼就能看到"是哪家店、什么提示"。
              命中原文: permMsg[0],
              抽屉尾部: String(drawerTxt || '').slice(-160),
              原文: rowText.slice(0, 160),
              说明: '该店铺的「全域投放权限」还没生效（**已刷新过一次仍在** ✓ 所以不是缓存）→ 等权限生效再跑 m4（probe-qc-shop-permission 可监视）；'
                  + '这是**外部配置**，不是脚本能绕的' });
        return;
      }
      log({ stage: 'STEP2c_搜ID结果', row: rowPos, 搜索到的ID: seenIds });
      if (!rowPos) {
        const dt = await js(`(() => { const d = ${DRAWER}; return d ? (d.innerText||'').replace(/\\s+/g,' ').slice(0,200) : null; })()`);
        log({ stage: 'ABORT_搜不到该商品', ok: false, 商品ID: pid, 搜索到的ID: seenIds, 抽屉实况: dt,
              最可能: '①搜索是异步的还没回来（已等 90s）②商品未过审 ③店铺「全域投放权限」未生效 ④权限已转给代投号（顺序反了）' });
        return;
      }
      for (let att = 1; att <= 3; att++) {
        const c2 = await findRowPos();
        if (c2 && c2.x) { await lib.cdpClick(c2.x, c2.y, 600); }
        await sleep(1500);
        const sel = await js(`(() => { const d = ${DRAWER};
          return d ? ((d.innerText||'').replace(/\\s+/g,' ').match(/已选\\s*(\\d+)\\s*\\/\\s*30/)||[])[1] || null : null; })()`);
        const ck2 = await findRowPos();
        log({ stage: 'STEP2d_勾选', att, 已选: sel, 勾选框已勾: ck2 && ck2.已勾上, 目标: c2 && c2.目标 });
        // ⚠️ 2026-09-12 实测：平台有**两套抽屉 UI** ——
        //    卡片版有「已选 N/30」计数；**表格版没有这个计数**（只有页面上的「已添加：0/30」，
        //    点确定后才更新）。死等"已选"会把明明勾上的判成失败（实测：复选框已 true 却报"商品未勾上"）。
        //    ⇒ 判据 = 「已选计数 > 0」**或**「商品行勾选框已勾上」。
        if ((sel && sel !== '0') || (ck2 && ck2.已勾上 === true)) break;
      }
      {
        const selFinal = await js(`(() => { const d = ${DRAWER};
          return d ? ((d.innerText||'').replace(/\\s+/g,' ').match(/已选\\s*(\\d+)\\s*\\/\\s*30/)||[])[1] || '0' : '0'; })()`);
        const ckF = await findRowPos();
        if (selFinal === '0' && !(ckF && ckF.已勾上 === true)) {
          log({ stage: 'ABORT_商品未勾上', ok: false, 商品ID: pid, 已选: selFinal, 勾选框已勾: ckF && ckF.已勾上,
                说明: '已选计数为 0 且商品行勾选框未勾上 → 别点确定，否则等于没加商品' });
          return;
        }
        log({ stage: 'STEP2d_勾选确认', ok: true, 已选: selFinal, 勾选框已勾: ckF && ckF.已勾上 });
      }


      const okBtn = await js(btnExpr('确定'));
      log({ stage: 'STEP2e_确定', pos: okBtn });
      await click(okBtn, 800);
      await sleep(2500);
      added = await readAdded();
      log({ stage: 'STEP2f_添加结果', 已添加商品: added });
      // ⚠️ 快速失败：商品加不进去就别往下跑了
      //    实测最常见原因：**该品的视频还没过审**，千川侧看不到 → 搜不到商品、素材区/可见性全 disabled
      if (added === '0') {
        log({ stage: 'ABORT_商品不可投', ok: false, 商品ID: pid,
              原因: '千川「添加商品」里加不进这个商品',
              最可能: '该品视频还没过审核（内容管理里状态仍为「审核中」）→ 审核通过前千川看不到它',
              其它可能: '权限已转给代投号（m6 早于 m4，顺序反了）',
              提示: '用 node probe-review-status.js --env ' + account + ' --frag <识别码> 等过审，再重跑' });
        return;
      }
    } else {
      log({ stage: 'STEP2_跳过', 说明: '商品已在计划里（复用标签保留了状态）' });
    }

    // ③ 启用「自选投放素材」（已 active 千万别再点）
    if (!(await cardActive())) {
      const card = await js(`(() => {
        const c = [...document.querySelectorAll('.oc-switch-card-item')].find(e => (e.innerText||'').includes('自选投放素材'));
        if (!c) return null;
        c.scrollIntoView({ block: 'center' });
        const inp = c.querySelector('input[type="checkbox"]');
        const r = (inp || c).getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      })()`);
      log({ stage: 'STEP3_启用自选素材', pos: card });
      // ⚠️ 2026-09-22（ego 实盘，用户让重新上传时踩到）：坐标点击在 ego 上"点了但模式卡不 active"
      //    （日志 STEP3b 已启用:false ⇒ 后面素材区/商品下拉/抽屉全 null ⇒ ABORT_计划素材不足）
      //    ⇒ 优先 ego 原生 click（attachSite 的 ego shim 提供），失败再回退坐标点击。判据不变。
      let _cardOK = false;
      if (typeof tab.click === 'function') {
        for (const sel of ['.oc-switch-card-item:has-text("自选投放素材")', 'text=自选投放素材']) {
          try { await tab.click(sel, { timeout: 4000, label: '自选投放素材' }); _cardOK = true; break; } catch (e) {}
        }
      }
      if (!_cardOK) await click(card, 800);
      await sleep(3000);
    }
    log({ stage: 'STEP3b_自选素材', 已启用: await cardActive() });

    // ③c 素材区必须选商品（否则一直提示「请先选择要添加创意的商品」）
    const cur = await js(`(() => { const t = (document.body.innerText||'').replace(/\\s+/g,' '); const i = t.indexOf('选择要添加素材的商品'); return i >= 0 ? t.slice(i, i + 60) : null; })()`);
    log({ stage: 'STEP3c_素材区', 文本: cur });
    if (!(cur || '').includes(pid)) {
      const selInp = await js(`(() => {
        const row = [...document.querySelectorAll('.oc-row-select')].find(e => (e.innerText||'').includes('选择要添加素材的商品'));
        const i = row && row.querySelector('input.ovui-input');
        if (!i) return null;
        i.scrollIntoView({ block: 'center' });
        const r = i.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), ph: i.placeholder || '' };
      })()`);
      log({ stage: 'STEP3d_商品下拉输入框', pos: selInp });
      if (selInp) {
        // 同一类问题：商品下拉输入框也优先 ego 原生点击
        let _selOK = false;
        if (typeof tab.click === 'function') {
          for (const sel of ['.oc-row-select input.ovui-input', 'input.ovui-input']) {
            try { await tab.click(sel, { timeout: 4000, label: '素材区商品下拉' }); _selOK = true; break; } catch (e) {}
          }
        }
        if (!_selOK) await lib.cdpClick(selInp.x, selInp.y, 300);
        await sleep(1000);
        const opts = await js(`(() => {
          const row = [...document.querySelectorAll('.oc-row-select')].find(e => (e.innerText||'').includes('选择要添加素材的商品'));
          const s = row && row.querySelector('.ovui-select'); if (!s) return [];
          const a = s.getBoundingClientRect(); const out = [];
          for (const e of document.querySelectorAll('body *')) {
            const r = e.getBoundingClientRect();
            if (r.width < 80 || r.height < 16 || r.height > 70) continue;
            if (r.y < a.y - 10 || r.y > a.y + 420) continue;
            if (r.x < a.x - 60 || r.x > a.x + a.width + 260) continue;
            const t = (e.innerText||'').replace(/\\s+/g,' ').trim();
            if (!t || t.length > 100) continue;
            out.push({ t, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), h: Math.round(r.height) });
          }
          out.sort((x,y) => x.h - y.h);
          const u = [], seen = new Set();
          for (const o of out) { const k = o.t.slice(0,40); if (seen.has(k)) continue; seen.add(k); u.push(o); }
          return u.slice(0, 8);
        })()`);
        log({ stage: 'STEP3e_下拉选项', 选项: opts });
        const hit = (opts || []).find((o) => o.t.includes(pid))
          || (opts || []).find((o) => name && o.t.includes(name))
          || null;
        if (hit) { log({ stage: 'STEP3f_选中商品', hit }); await lib.cdpClick(hit.x, hit.y, 800); await sleep(2000); }
        else log({ stage: 'STEP3f_无命中', 说明: '下拉里没有匹配项，先不点' });
      }
    } else {
      log({ stage: 'STEP3d_跳过', 说明: '素材区已选好商品' });
    }

    // ⭐ 2026-10-01 #15（**用户现场教训** ✓）：原来要**把 869MB 素材全传完**才发现账户余额不足 ✗
    //   （`STEP14c 发布结果 提示:"余额不足"` ✗ —— 那时已白传 ~6 分钟 ✗）。
    //   ⇒ 在这里（**开素材抽屉之前** ✓）先读一眼账户余额，**提前告警** ✓。
    //   ⚠️ **只告警、不拦** ✗ —— 同夜实证：余额不足时计划**仍能建成** ✓（只是跑不起来 ✓），
    //     硬停会**误伤** ✓（所以表里 #15 的原方案"低于日预算就直接停"被我按实盘**改掉**了 ✓）。
    try {
      const bal = await js(`(() => { const t = (document.body.innerText||'').replace(/\\s+/g,' ');
        const m = t.match(/可用余额\\(元\\)\\s*([\\d.]+)/) || t.match(/余额[^\\d]{0,8}([\\d.]+)\\s*元/);
        return { 余额: m ? m[1] : null, 即将不足: /余额即将不足|余额不足/.test(t) }; })()`);
      const 低 = !!(bal && (bal.即将不足 || (bal.余额 !== null && Number(bal.余额) < 300)));
      log({ stage: 'PREFLIGHT_BALANCE', ...(bal || {}),
            建议: 低 ? '⚠️ 余额偏低/不足 ⇒ **先去充值** ✓（计划一般仍能建成 ✓，但**跑不起来** ✗；本次不拦 ✓ 只提醒 ✓）'
                     : '余额看起来够 ✓' });
    } catch (e) { log({ stage: 'PREFLIGHT_BALANCE', ok: false, err: String((e && e.message) || e).slice(0, 120) }); }

    // ④ 打开素材抽屉（已开则跳过）
    const isOpen = await js(`(() => { const d = ${TOP_DRAWER}; const t = d ? (d.innerText||'') : ''; return /我的视频/.test(t) && /上传视频/.test(t); })()`);
    if (isOpen) {
      log({ stage: 'STEP4_跳过', 说明: '素材抽屉已打开' });
    } else {
      const av = await js(btnExpr('添加视频'));
      log({ stage: 'STEP4_添加视频按钮', pos: av });
      await click(av, 900);
      await sleep(3000);
    }
    log({ stage: 'STEP4b_抽屉', 文本: await drawerText() });

    // ⑤ 切「上传视频」页签（已在上传面板则不点）
    const onUpload = await js(`(() => { const d = ${TOP_DRAWER}; const t = d ? (d.innerText||'') : ''; return /点击上传/.test(t) || /将文件拖拽到此处/.test(t); })()`);
    if (!onUpload) {
      const tabPos = await js(`(() => {
        const d = ${TOP_DRAWER}; if (!d) return null;
        const els = [...d.querySelectorAll('*')].filter(e => (e.innerText||'').trim() === '上传视频');
        const e = els[els.length - 1]; if (!e) return null;
        const r = e.getBoundingClientRect(); if (r.width <= 0) return null;
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), fromDrawer: true };
      })()`);
      log({ stage: 'STEP5_上传视频页签', pos: tabPos });
      await click(tabPos, 900);
      await sleep(2500);
    } else {
      log({ stage: 'STEP5_跳过', 说明: '已在上传面板' });
    }
    log({ stage: 'STEP5b_上传面板', 文本: await drawerText() });

    const upExpr = `(() => { const d = ${TOP_DRAWER}; if (!d) return null;
      const els = [...d.querySelectorAll('*')].filter(e => /点击上传/.test((e.innerText||'').trim()));
      const e = els[els.length - 1]; if (!e) return null; const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), fromDrawer: true }; })()`;

    if (probeOnly) {
      const up = await js(upExpr);
      log({ stage: 'PROBE_上传入口', pos: up });
      const z = await js(`(() => { const d = ${TOP_DRAWER}; if (!d) return null;
        const els = [...d.querySelectorAll('*')].filter(e => /将文件拖拽到此处/.test((e.innerText||'').trim()));
        const e = els[els.length - 1]; if (!e) return null; const r = e.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
      log({ stage: 'PROBE_拖拽区', zone: z });
      log({ stage: 'PROBE_END', 说明: '--probe：不传文件、不发布' });
      OK = true; return;
    }

    // ⑥ 素材上传（已齐则跳过，只做后续标题）
    let files = [];
    let expectMat = 0;          // 计划最终应有的素材数（= 素材目录前 5 条），用于建计划后终验
    let needUpload = false;
    if (!dir) {
      log({ stage: 'STEP6_跳过上传', 说明: '未给 --dir' });
    } else {
      const all = fs.readdirSync(dir).filter((f) => /\.(mp4|mov)$/i.test(f)).sort().map((f) => path.join(dir, f)).slice(0, 5);
      const already = (await readMatN()).素材 || 0;
      files = all.slice(already);           // 已挂上的不重复上传
      expectMat = all.length;
      log({ stage: 'STEP6_待传文件', 目录总数: all.length, 已挂: already, 本次补传: files.length, files: files.map((f) => path.basename(f)) });
      needUpload = files.length > 0;
      if (!needUpload) log({ stage: 'STEP6_跳过上传', 说明: '素材已齐' });
    }

    if (needUpload) {
      // 直接拖拽进框上传（用户 2026-09-11：可以拖，不一定要点）
      const zone = await js(`(() => {
        const d = ${TOP_DRAWER}; if (!d) return null;
        const hits = [...d.querySelectorAll('*')].filter(e => /将文件拖拽到此处/.test((e.innerText||'').trim()));
        const cands = [];
        for (const h of hits) {
          let e = h;
          for (let i = 0; i < 6 && e; i++) {
            const r = e.getBoundingClientRect();
            if (r.width >= 200 && r.height >= 80) { cands.push({ r }); break; }
            e = e.parentElement;
          }
        }
        if (!cands.length) return null;
        cands.sort((a, b) => (a.r.width * a.r.height) - (b.r.width * b.r.height));
        const r = cands[0].r;
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width), h: Math.round(r.height), fromDrawer: true };
      })()`);
      log({ stage: 'STEP6_拖拽区', zone });
      if (zone) {
        // 记录拖拽前的基线「已选择 N/500」，目标 = 基线 + 本次文件数
        // （抽屉里可能预勾了已挂素材，只看 files.length 会误判过关）
        const baseSel = parseInt(((await drawerText() || '').match(/已选择\s*(\d+)\/500/) || [])[1] || '0', 10);
        const targetSel = baseSel + files.length;
        log({ stage: 'STEP6a_已选择基线', baseSel, 本次: files.length, 目标: targetSel });
        // ⚠️ 2026-09-12 新增告警：**抽屉里残留了上一轮的选择**。
        //   实测：m4 中途失败后重跑，创建页被复用、抽屉还开着，残留 5 个已选 →
        //   baseSel=5 → 目标=10 → 再点确定就把同一批素材**挂两遍**。
        //   判据：baseSel>0 而计划上「已挂」还是 0（说明这 N 个不是"计划里已有的"，是抽屉里的残留）。
        //   这里只告警（不拦），因为正确处置是"关掉草稿页标签再跑"（关标签=干净页，见下）。
        //   👉 重跑 m4 的标准姿势：**先关掉创建页标签**（不是导航走，避免"放弃创建"弹框），再跑。
        if (baseSel > 0 && already === 0) {
          log({ stage: 'WARN_抽屉残留已选', ok: false, baseSel, 目标: targetSel,
                说明: '抽屉里已有 ' + baseSel + ' 个残留选择（多半是上一轮失败留下的）→ '
                    + '本次目标会被抬到 ' + targetSel + '，确定后会**挂重**。'
                    + '正确做法：关掉创建页标签（Page.close，不要导航走）后重跑本步' });
        }
        const data = { items: [], files, dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
          await tab.send('Input.dispatchDragEvent', { type, x: zone.x, y: zone.y, data });
          await sleep(700);
        }
        log({ stage: 'STEP6b_已拖拽', 文件数: files.length });
        // ⚠️ 必须等全部传完再点确定（踩过：传一半点确定 → 只挂上 1 个）
        // ⚠️ 2026-09-11 二次踩坑：原逻辑 `if (!busy && i > 6) break;` 会在 ~35s 后无脑跳出，
        //    传 5 条实际只挂上 3 条，链路照旧往下走 → 千川只同步出 3 条素材（m5 才发现）。
        //    现在：等够 10 分钟；没到 targetSel 就 ABORT，绝不带着缺料点确定建计划。
        let finalSel = 0;
        for (let i = 0; i < 120; i++) {
          await sleep(5000);
          const st = await drawerText();
          finalSel = parseInt(((st || '').match(/已选择\s*(\d+)\/500/) || [])[1] || '0', 10);
          const busy = /取消上传|\d+%/.test(st || '');
          if (i % 3 === 0 || !busy) log({ stage: 'STEP6c_上传进度', 已选择: finalSel, 目标: targetSel, 仍在传: busy, 轮次: i + 1 });
          if (!busy && finalSel >= targetSel) break;
          if (!busy && i >= 24) break;   // ~2 分钟不动 → 认定卡住，走下面 ABORT
        }
        if (finalSel < targetSel) {
          log({ stage: 'ABORT_素材未传齐', ok: false, 目标: targetSel, 实际: finalSel,
                说明: '不等齐绝不点确定（带缺料建计划 → m5 素材不足、计划已生成无法补救）；重跑本步即可，已挂上的不会重复上传' });
          return;
        }
      }
      log({ stage: 'STEP8_上传后', 抽屉: await drawerText() });

      // ⑥b 「我的视频」页签 —— **只读诊断，不拦截**（2026-09-12 我自己踩的反面教材）
      //   背景：用户说 m4 把炮灰视频混进了素材池。我先写了个"清勾 + 有勾选就 ABORT"的判据，
      //   结果**误报**把流程挡住了：抽屉底部的 `已选择 N/500` 是**两个页签共用**的计数
      //   （数的是刚上传的那 5 个），根本不能当「我的视频勾选数」；而 `[class*=checkbox]` 里
      //   `/checked|selected/` 还匹配到了「过滤不良素材」这类无关元素。
      //   实测两次运行的 STEP4b 都是「已选择 0/500」→ **我的视频里本来就没有预勾选**。
      //   ⇒ 判据没对齐页面时**别急着拦人**（假警报比不拦更贵），这里降级为只读记录；
      //     真正管用的判据放在**结果侧**（下面 STEP10：计划上素材多了才 ABORT）。
      {
        const myTab = await js(`(() => { const d = ${TOP_DRAWER}; if (!d) return null;
          const els = [...d.querySelectorAll('*')].filter(e => (e.innerText||'').trim() === '我的视频' && !e.querySelector('*'));
          const e = els[els.length - 1]; if (!e) return null; const r = e.getBoundingClientRect();
          return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), fromDrawer: true }; })()`);
        if (myTab) {
          await click(myTab, 900); await sleep(2000);
          const info = await js(`(() => { const d = ${TOP_DRAWER}; if (!d) return null;
            const t = (d.innerText||'').replace(/\\s+/g,' ');
            // 只在"含时长的条目"里数已勾选的复选框（排除「过滤不良素材」这类控件）
            const items = [...d.querySelectorAll('*')].filter(e => {
              const x = (e.innerText||'').replace(/\\s+/g,' ');
              return /\\d{2}:\\d{2}/.test(x) && x.length < 120 && e.querySelector('input,[class*=checkbox]');
            });
            const checked = items.filter(e => /checkbox-checked|checkbox-wrapper-checked/.test(String(e.innerHTML).slice(0, 4000)));
            return { 页脚已选择: ((t.match(/已选择\\s*(\\d+)\\s*\\/\\s*500/)||[])[1] || null),
                     条目数: items.length, 条目已勾选数: checked.length,
                     条目文本: items.slice(0, 6).map(e => (e.innerText||'').replace(/\\s+/g,' ').slice(0, 40)) };
          })()`);
          log({ stage: 'STEP8b_我的视频只读诊断', ...(info || {}) });
          const upTab = await js(`(() => { const d = ${TOP_DRAWER}; if (!d) return null;
            const els = [...d.querySelectorAll('*')].filter(e => (e.innerText||'').trim() === '上传视频' && !e.querySelector('*'));
            const e = els[els.length - 1]; if (!e) return null; const r = e.getBoundingClientRect();
            return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), fromDrawer: true }; })()`);
          if (upTab) { await click(upTab, 900); await sleep(2000); }
        }
      }

      const okBtn = await js(`(() => { const d = ${TOP_DRAWER}; if (!d) return null;
        const bs = [...d.querySelectorAll('button,.ovui-btn')].filter(e => (e.innerText||'').trim() === '确定' && e.getBoundingClientRect().width > 0);
        const b = bs[bs.length - 1]; if (!b) return null; const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), fromDrawer: true }; })()`);
      log({ stage: 'STEP9_抽屉确定', pos: okBtn });
      await click(okBtn, 900);
      await sleep(3000);
    }

    // ⑦ 标题（至少 1 条，否则发不出去）—— 用户 2026-09-11：用商品名
    const matNow = await readMatN();
    log({ stage: 'STEP10_素材结果', 素材: matNow, 已添加商品: await readAdded() });
    // ⚠️ 终验：计划上实际挂了多少素材 ≠ 抽屉里选了多少（千川有审核/去重/同步延迟）
    // 2026-09-11 踩坑：抽屉显示 5，计划实际只挂 3 → m5 素材不足。这里立刻拦下，别等发布后才发现。
    if (expectMat && (matNow.素材 || 0) < expectMat) {
      log({ stage: 'ABORT_计划素材不足', ok: false, 应有: expectMat, 实际: matNow.素材 || 0,
            说明: '素材没挂齐就不带病往下走；重跑本步会跳过已挂素材只补缺的' });
      return;
    }
    // ⚠️ 2026-09-12：原来只判"不足"，我加过一版"多了也 ABORT" —— **已降级为告警**。
    //   原因：用户 2026-09-12 明确「服务器的 bug 不是我们这边的问题」：
    //   平台自己多塞/重复一条素材时，卡住整条链路（要人工删计划重跑）代价远大于收益。
    //   ⇒ 记录事实、继续跑；真要在意"多了"，看这条日志再人工处理。
    if (expectMat && (matNow.素材 || 0) > expectMat) {
      log({ stage: 'WARN_计划素材多了', ok: true, 应有: expectMat, 实际: matNow.素材 || 0,
            说明: '计划上挂的素材比本次上传的多（平台侧行为，非本脚本）→ 只告警不拦，继续往下跑' });
    }
    const readTitleN = () => js(`(() => { const t = (document.body.innerText||'').replace(/\\s+/g,' ');
      return parseInt((t.match(/标题\\s*添加标题\\s*已添加[:：]\\s*(\\d+)\\/30/)||[])[1] || '0', 10); })()`);
    if (title) {
      // 关掉素材抽屉（z=2010 的遮罩会挡住标题区）
      const shut = await js(`(() => { const d = ${TOP_DRAWER};
        if (!d) return null;
        if (!/我的视频/.test(d.innerText||'')) return null;
        const bs = [...d.querySelectorAll('button,.ovui-btn')].filter(e => (e.innerText||'').trim() === '取消' && e.getBoundingClientRect().width > 0);
        const b = bs[bs.length-1]; if (!b) return null; const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), fromDrawer: true }; })()`);
      if (shut) { log({ stage: 'STEP11a_关素材抽屉', pos: shut }); await click(shut, 800); await sleep(2000); }

      // 找标题输入行（内联，不是弹窗）
      const findTin = () => js(`(() => {
        const i = [...document.querySelectorAll('input,textarea')].find(e => /请输入标题/.test(e.placeholder||''));
        if (!i) return null;
        i.scrollIntoView({ block: 'center' });
        const r = i.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), ph: i.placeholder, val: i.value || '' };
      })()`);

      let tin = await findTin();
      if (!tin) {
        let tb = await js(btnExpr('添加标题'));
        log({ stage: 'STEP11b_添加标题按钮', pos: tb });
        // ⭐ 2026-09-30（用户实拍 ✓）：「上传完视频要**添加标题**，页面抖了一下 ⇒ 点错地方」✗
        //   根因：坐标是**之前**量好的 ✓，而量完到点击之间页面又动过（关抽屉动画/懒加载 ✓）
        //   ⇒ 旧坐标过期 ⇒ 点在空白处 ✗（用户肉眼看到按钮明明在 ✓ —— 探针实测 x:818 y:1017 ✓）
        //   修法（**只加这一句，判据一字不改** ✓）：**点击前重新量一次**坐标 ✓
        await sleep(300);
        const tb2 = await js(btnExpr('添加标题'));
        if (tb2) { log({ stage: 'STEP11b2_点击前复量', 旧: tb, 新: tb2 }); tb = tb2; }
        await click(tb, 900);
        await sleep(2500);
        tin = await findTin();
      }
      log({ stage: 'STEP11c_标题输入框', pos: tin });

      // ⚠️ 判据是「输入框里有没有值」，不是「已添加 1/30」——踩过：空行也算 1/30
      if (tin && !String(tin.val || '').trim()) {
        await lib.cdpClick(tin.x, tin.y, 300);
        await sleep(300);
        await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['selectAll'] });
        await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', commands: ['selectAll'] });
        await tab.send('Input.insertText', { text: title });
        await sleep(700);
        await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13 });
        await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13 });
        await sleep(1800);
        const v1 = (await findTin() || {}).val;
        log({ stage: 'STEP11d_回车后', 值: v1 });
        if (!String(v1 || '').trim()) {
          const addb = await js(btnExpr('添加'));
          if (addb) { log({ stage: 'STEP11e_点添加', pos: addb }); await click(addb, 800); await sleep(1800); }
        }
      } else {
        log({ stage: 'STEP11c_跳过填写', 说明: tin ? '输入框已有值' : '没有输入框' });
      }
      const fin = await findTin();
      log({ stage: 'STEP11f_标题结果', 标题数: await readTitleN(), 输入框值: fin ? fin.val : null });
    }
    // ⑧ 抖音主页可见性：**必须是「主页始终可见」**（用户 2026-09-11 明确）
    const visExpr = (label) => `(() => {
      const els = [...document.querySelectorAll('label,span,div')]
        .filter(e => (e.innerText||'').trim() === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0);
      const e = els[els.length - 1]; if (!e) return null;
      e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect();
      const box = e.closest('label') || e.parentElement || e;
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
               cls: String(box.className || '').slice(0, 70), 自己类: String(e.className||'').slice(0,50) };
    })()`;
    const visState = () => js(`(() => {
      const pick = (label) => {
        const els = [...document.querySelectorAll('label,span,div')].filter(e => (e.innerText||'').trim() === label && e.getBoundingClientRect().width > 0);
        const e = els[els.length - 1]; if (!e) return null;
        const box = e.closest('label') || e.parentElement || e;
        return /checked|active|selected/.test(String(box.className || '') + String(e.className || ''));
      };
      return { 仅单次展示可见: pick('仅单次展示可见'), 主页始终可见: pick('主页始终可见') };
    })()`);
    let vs = await visState();
    log({ stage: 'STEP13_可见性现状', ...vs, 目标: visibility });
    if (!vs || !vs[visibility]) {
      for (let i = 0; i < 3; i++) {
        const v = await js(visExpr(visibility));
        log({ stage: 'STEP13b_点可见性', 第几次: i + 1, pos: v });
        if (!v) break;
        await lib.cdpClick(v.x, v.y, 800);
        await sleep(1500);
        vs = await visState();
        if (vs && vs[visibility]) break;
      }
    }
    vs = await visState();
    log({ stage: 'STEP13c_可见性结果', ...vs });
    const visOK = !!(vs && vs[visibility]);

    // ⑨ 发布计划
    if (doPublish) {
      if (!visOK) { log({ stage: 'STEP14_拒绝发布', 原因: `可见性未确认为「${visibility}」`, 现状: vs }); return; }
      const pub = await js(btnExpr('发布计划'));
      log({ stage: 'STEP14_发布计划按钮', pos: pub });
      // ⚠️ 2026-09-22（ego 实盘：号B 此次发布没生效，创建页留在草稿态 ⇒ 列表里没有新计划）
      //    坐标点击在 ego 上会"点了没反应"（连互斥弹层都没弹）⇒ 优先 ego 原生 click。
      let _pubOK = false;
      if (typeof tab.click === 'function') {
        for (const sel of ['button:has-text("发布计划")', 'span.button-text:has-text("发布计划")', 'text=发布计划']) {
          try { await tab.click(sel, { timeout: 5000, label: '发布计划' }); _pubOK = true; break; } catch (e) {}
        }
      }
      if (!_pubOK) await click(pub, 1200);
      else await sleep(1200);
      // ⚠️ 2026-09-22 实盘（用户：「留毛人工，能做的你肯定都做」）：点【发布计划】会先弹
      //    「为保证全域投放的唯一性…」互斥提示（不再提示 / 取消 / 确定）——**不点它会挡住后面一切点击**
      //    （实测 ego 原生 page.click 全部 timeout，计划也没建出来）。这里自动点它的主按钮。
      for (let i = 0; i < 6; i++) {
        await sleep(1200);
        // ⚠️ 2026-09-22 实测结构：正文在 `.ovui-modal__body`，**按钮在它的兄弟节点 footer 里**
        //    （`.ovui-modal__footer` / `.confirm-modal-footer`，按钮文本 = 「取消」/「确认发布」）。
        //    上一版把作用域限在 __body 里 ⇒ 永远找不到主按钮。
        const m = await js(`(() => {
          const foots = [...document.querySelectorAll('.ovui-modal__footer,.confirm-modal-footer,[class*=modal__footer]')]
            .filter(e => e.offsetParent && /确认发布|确定|确认|我知道了/.test(e.innerText || ''));
          if (!foots.length) return null;
          const f = foots[foots.length - 1];
          const all = [...f.querySelectorAll('button,[role=button],[class*=btn]')].filter(x => x.offsetParent);
          const pref = all.filter(x => /^(确认发布|确定|确认|继续发布|我知道了)$/.test((x.innerText || '').trim()));
          const b = pref[pref.length - 1] || all[all.length - 1];
          if (!b) return { 没找到主按钮: all.map(x => (x.innerText || '').trim()).filter(Boolean) };
          const r = b.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), t: (b.innerText || '').trim() };
        })()`);
        if (!m) break;
        if (m.x) {
          // ego 原生优先（tab.click 由 ego shim 提供），失败再坐标点击
          let ok = false;
          if (typeof tab.click === 'function') { try { await tab.click(`button:has-text("${m.t}")`, { timeout: 4000, label: '互斥提示 ' + m.t }); ok = true; } catch (e) {} }
          if (!ok) await click({ x: m.x, y: m.y }, 900);
          log({ stage: 'STEP14_互斥提示_已确认', 按钮: m.t, 方式: ok ? 'ego 原生' : '坐标' });
        } else { log({ stage: 'STEP14_互斥提示_无主按钮', 候选: m.没找到主按钮 }); break; }
      }
      let done = null;
      for (let i = 0; i < 24; i++) {
        await sleep(2000);
        const st = await js(`(() => ({ url: location.href, t: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 500) }))()`);
        const m = (st.t || '').match(/(恭喜你|创建成功|计划创建成功|发布成功|失败|错误|余额不足|请先[^ ]{0,10})/);
        // ⭐ 2026-10-01 修 #17（用户现场点破：「**从我看品 3 页是成功的**」✓）：
        //   ⛔ 不能**只看 toast** ✗ —— 平台在**计划已建成**时也可能弹「余额不足」（= 提醒：计划建好了、
        //     账户没钱**跑不起来** ✓），而 URL 里明明白白带着 `sourceFrom=**createSuccess**` ✓✓。
        //   实盘：品③ 因此被判 `发布成功:false` ✗ ⇒ 连带整批停 ✗（SOP 早写了"去计划列表核实"这条姿势 ✓）。
        //   ⇒ 现在把**平台自己的成功参数**当主判据 ✓，toast 降级为**附注** ✓（余额不足照样记下来 ✗ 别丢）。
        const urlOK = /sourceFrom=createSuccess/i.test(String(st.url || ''));
        if (urlOK) { done = { 提示: (m ? m[0] : null), url: st.url, 判据: 'url:sourceFrom=createSuccess' }; break; }
        if (m) { done = { 提示: m[0], url: st.url, 判据: 'toast' }; break; }
        if (!/uni-creation/.test(st.url)) { done = { 已跳转: st.url, t: st.t.slice(0, 200), 判据: '已离开创建页' }; break; }
        if (i === 8) log({ stage: 'STEP14b_等待中', 页面: st.t.slice(0, 160) });
      }
      // 成功判据（按强弱排序 ✓）：① URL 带 `sourceFrom=createSuccess`（平台自己说的 ✓）
      //   ② toast 含"恭喜/成功" ③ 已离开创建页跳去别处 ✓ —— ⛔ 单凭「余额不足/失败」的 toast 不算失败 ✗
      //   （那种情况下面 `计划ID候选` + 平台列表仍可核实 ✓；要人工确认时按 SOP：搜到 ⇒ 补台账 ✓）
      const urlOK2 = !!(done && /sourceFrom=createSuccess/i.test(String(done.url || '')));
      pubOK = !!(done && ((done.提示 && /恭喜|成功/.test(done.提示)) || urlOK2 || done.已跳转));
      log({ stage: 'STEP14c_发布结果', 发布成功: pubOK, 判据: (done && done.判据) || '(48s 内无明确信号)',
            ...(done || { 说明: '48s 内未见明确提示' }),
            ...(/余额不足|失败|错误/.test(String((done && done.提示) || '')) ? { 平台附注: '弹过「' + (done && done.提示) + '」—— 若是"余额不足"，计划可能已建成但**跑不起来** ⇒ 该充值 ✓（判据以 URL/列表为准 ✓）' } : {}) });
      const pid2 = await js(`(() => { const t=(document.body.innerText||'').replace(/\\s+/g,' ');
        const m = t.match(/ID[：:]\\s*(\\d{12,})/) || t.match(/(\\d{15,})/); return m ? m[1] : null; })()`);
      log({ stage: 'STEP14d_计划ID候选', 值: pid2 });
    }

    log({ stage: 'STEP12_最终' , 素材: await readMatN(), 已添加商品: await readAdded(),
          标题数: await readTitleN(),
          标题段: await js(`(() => { const t=(document.body.innerText||'').replace(/\\s+/g,' '); const i=t.indexOf('标题 添加标题'); return i>=0? t.slice(i, i+160) : null; })()`) });
    // 成功判据：没要求发布 → 素材齐即可；要求发布 → 必须确认创建成功
    const matNow2 = await readMatN();
    OK = doPublish ? pubOK : (matNow2.素材 >= 1);
    log({ stage: 'END', ok: OK, 素材: matNow2.素材, 发布成功: doPublish ? pubOK : undefined,
          说明: OK ? '动作完成' : '未达成预期（看上面 STEP 日志）' });
  } catch (e) {
    log({ stage: 'ERR', ok: false, err: e.message });
  } finally {
    try { tab.close(); } catch (e) {}   // ✅ 只断 CDP，不关标签
    setTimeout(() => process.exit(OK ? 0 : 1), 500);
  }
})();
