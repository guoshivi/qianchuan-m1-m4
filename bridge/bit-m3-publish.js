'use strict';
/**
 * bit-m3-publish.js — m3 第三段：抖音创作者中心「发布视频」页自动化
 *
 * 背景（实测 2026-09-11，<号A>号）：
 *   1) 上传视频后进入 …/creator-micro/content/post/video?enter_from=publish_page
 *   2) 作品描述（contenteditable，上限 30 字）= 话题 + 识别码 ← 识别码必须写这里，m5 靠它认视频
 *   3) 扩展信息 → 购物车 → 粘贴商品链接（input placeholder「粘贴商品链接」）
 *      → 「添加链接」灰→红（span.cart-mybtn）→ 点它 → 「已添加商品（1）」
 *   4) 商品块「编辑」→ 弹层「商品短标题*」最多 10 个汉字 ← 从商品名取核心词 →「完成编辑」
 *   5) 「发布」按钮 className 含 primary
 *
 * 用法：
 *   node bit-m3-publish.js [--env <号A>]                      # 只读看状态
 *   node bit-m3-publish.js --desc "#日常 #搞笑 #实拍 demoAX" # 填作品描述（会校验长度）
 *   node bit-m3-publish.js --cart <商品链接>                  # 粘贴链接 + 点添加链接
 *   node bit-m3-publish.js --shortTitle 灰膜抽油烟机吸油棉     # 编辑商品 → 填短标题 → 完成编辑
 *   node bit-m3-publish.js --publish                          # 点发布（终态，谨慎）
 *   可组合：node bit-m3-publish.js --cart <url> --shortTitle X --desc "..." --publish
 */
const CFG = require('./qc-config.js');
const api = require('./bit-api.js');
const { Cdp } = require('./bit-cdp.js');

const argv = process.argv || [];
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const has = (k) => argv.includes(k);
const envArg = arg('--env');
const DESC = arg('--desc');
const CART = arg('--cart');
// 🔴 2026-09-29（用户问「挂购物车那步弹窗里的短标题你也都统一写'视频同款'了吗？」）
//   原来这里没默认值 ✗ ⇒ 谁不带 `--shortTitle` 直接跑，弹窗里就不是「视频同款」✗。
//   ⇒ 默认取**唯一主人** `short-title.js`（它现在一律返回「视频同款」✓）
const SHORT = arg('--shortTitle') || require('./short-title.js').shortTitle('');
const DO_PUBLISH = has('--publish');
const TIMEOUT = parseInt(arg('--timeout') || '15000', 10);
// 🖼 封面**不在发布页做**（用户 2026-09-18 明确：直接在**做炮灰视频时**把主图做成首帧即可）
//   → 见 `bit-m3-paohui.js` 的 COVER_IMAGE + Remotion 的 coverSec（首帧=商品主图）

function resolveEnv(v) {
  if (!v) return (CFG.dyEnvs || [])[0].env;
  const hit = (CFG.dyEnvs || []).find((d) => d.name === v || d.env === v || (d.name || '').includes(v));
  return hit ? hit.env : v;
}
const env = resolveEnv(envArg);
const envName = ((CFG.dyEnvs || []).find((d) => d.env === env) || {}).name || env;

const log = (o) => console.log(JSON.stringify(o));
const toastLog = (o) => console.log(JSON.stringify({ stage: 'ERR_CART_ROW', ...o }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- CDP 基元 ----------
async function ev(cdp, expr, ms = 8000) {
  const r = await Promise.race([cdp.eval(expr), sleep(ms).then(() => { throw new Error('eval超时'); })]);
  return r;
}
async function clickAt(cdp, expr, label) {
  const box = await ev(cdp, `(() => {
    const el = ${expr};
    if (!el) return null;
    const r0 = el.getBoundingClientRect();
    // ⭐ 2026-10-01（用户：「为啥他每个品都要往下翻滚一下？我觉得这边可以优化」✓）：
    //   原来**无条件** scrollIntoView ✗ ⇒ 每个品发布都在屏幕上滚一下 ✓。
    //   现在**只在元素不在视口内时才滚** ✓（表单按钮/链接绝大多数本就在视口内 ✓ ⇒ 不再翻滚 ✓）。
    //   ⛔ 坐标点击的语义不变 ✓（仍在滚动后取 rect 中点 ✓）—— 这条只去掉"多余的滚" ✓。
    const 在视口 = r0.top >= 0 && r0.left >= 0 && r0.bottom <= (window.innerHeight || 0) && r0.right <= (window.innerWidth || 0);
    if (!在视口) el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height),
             滚动: !在视口,
             txt: (el.innerText || el.value || '').replace(/\\s+/g, ' ').slice(0, 40) };
  })()`);
  if (!box || !box.w) throw new Error(`找不到可点元素: ${label}`);
  // 判据（机械兜底 ✓）：点法写进日志 ⇒ 以后不用猜"它到底滚没滚" ✓（同 m6 的 CLICK_MODE 套路 ✓）
  console.log(JSON.stringify({ stage: 'CLICK_MODE', 元素: label, 点法: box.滚动 ? '坐标(需滚动)' : '坐标(视口内·未滚)', 位置: { x: box.x, y: box.y } }));
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  }
  await sleep(400);
  return box;
}

const BY_TEXT = (t, sel = 'button,.ovui-btn,span,div,a') =>
  `[...document.querySelectorAll(${JSON.stringify(sel)})].filter(e=>e.offsetParent&&(e.innerText||'').trim()===${JSON.stringify(t)}).sort((a,b)=>a.innerText.length-b.innerText.length)[0]`;

// ---------- 页面读取 ----------
const READ = `(() => {
  const vis = (e) => !!(e && e.offsetParent);
  const txt = (e) => (e ? (e.innerText || '').replace(/\\s+/g, ' ').trim() : '');
  const body = document.body.innerText || '';
  const descEl = [...document.querySelectorAll('[contenteditable=true]')].filter(vis).sort((a,b)=>b.innerText.length-a.innerText.length)[0];
  const cartInput = [...document.querySelectorAll('input')].filter((i) => vis(i) && /粘贴商品链接/.test(i.placeholder || ''))[0];
  const addBtn = [...document.querySelectorAll('span,button,a')].filter((e) => vis(e) && /^添加链接$/.test(txt(e)))[0];
  const goods = (body.match(/已添加商品（(\\d+)）([\\s\\S]{0,300}?)(关联热点|添加共创)/) || null);
  const pub = [...document.querySelectorAll('button,.ovui-btn')].filter((e) => vis(e) && txt(e) === '发布')[0];
  const drawer = [...document.querySelectorAll('.ovui-drawer,.ovui-modal,[class*=drawer],[class*=modal]')]
    .filter((e) => vis(e) && e.getBoundingClientRect().width > 300).map((e) => txt(e).slice(0, 200))[0] || null;
  const shortInput = [...document.querySelectorAll('input,textarea')].filter((i) => {
    if (!vis(i)) return false;
    const lab = i.closest('div') ? (i.closest('div').innerText || '') : '';
    return /商品短标题/.test(lab) || /短标题/.test(i.placeholder || '');
  })[0];
  return {
    url: location.href,
    desc: descEl ? descEl.innerText.replace(/\\s+/g, ' ').trim() : null,
    descCounter: (body.match(/(\\d+)\\s*\\/\\s*30/) || [])[0] || null,
    cartInputValue: cartInput ? cartInput.value : null,
    addLinkBtn: addBtn ? { cls: String(addBtn.className).slice(0, 50), color: getComputedStyle(addBtn).color, cursor: getComputedStyle(addBtn).cursor } : null,
    goodsCount: goods ? goods[1] : '0',
    goodsBlock: goods ? goods[2].replace(/\\s+/g, ' ').trim() : null,
    drawer,
    shortTitleValue: shortInput ? shortInput.value : null,
    publishBtn: pub ? { disabled: pub.disabled === true, cls: String(pub.className).slice(0, 50) } : null,
  };
})()`;

// ---------- 动作 ----------
// ⚠️ 踩过的坑（2026-09-11 实测）：
//   1) macOS 全选是 Cmd(modifiers=4) 不是 Ctrl(modifiers=2)；直接用 CDP 的
//      `commands:['selectAll']` 最稳，跨平台不猜键位。
//   2) 不要 keyDown(text)+char(text) 双发 —— 会双写，字符翻倍（"#日日常常…"）。
//      只发一次 Input.insertText 即可；insertText 会替换当前选区，正好当"清空+写入"。
//   3) 抖音发布页 `.limit-FToEI9` 那个 "0/30" 计数器**不随输入变化**（两种输入方式都不变），
//      判定依据只能是编辑器 DOM 里 data-string 的实际文本，别信计数器。
const ZW = /\u200b/g;
async function setDesc(cdp, text) {
  const len = [...text].length;
  if (len > 30) throw new Error(`作品描述上限 30 字，当前 ${len} 字：${text}`);
  await clickAt(cdp, `[...document.querySelectorAll('[contenteditable=true]')].filter(e=>e.offsetParent).sort((a,b)=>b.innerText.length-a.innerText.length)[0]`, '作品描述编辑器');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['selectAll'] });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', commands: ['selectAll'] });
  await sleep(300);
  await cdp.send('Input.insertText', { text });
  await sleep(800);
  const got = await ev(cdp, `(() => { const e=[...document.querySelectorAll('[contenteditable=true]')].filter(e=>e.offsetParent).sort((a,b)=>b.innerText.length-a.innerText.length)[0]; return e? e.innerText.replace(/\\s+/g,' ').trim(): null; })()`);
  const clean = String(got || '').replace(/\u200b/g, '').trim();
  return { 期望: text, 实得: got, 一致: clean === text };
}

/**
 * 确保「购物车」这一行存在。
 * 实测（2026-09-11，用户手点录屏）：
 *   「添加标签」那行是个**单选下拉**（`.semi-select`），候选 = 位置|购物车|影视演艺|小程序|游戏手柄|标记万物。
 *   默认是「位置」，此时**页面上根本没有粘贴商品链接的输入框**（这就是之前 fillCart 报
 *   「找不到可点元素: 粘贴商品链接 input」的原因）。
 *   必须先把这行切成「购物车」，链接输入框才会出现。
 */
/**
 * 更稳地把「添加标签」切成「购物车」（2026-09-12 新增，号B 实测踩出来的）
 *
 * 为什么加：老实现（下面 ensureCartRow 的旧路径）两处依赖了"当时那个页面变体"：
 *   ① 只认 `.semi-select` 当触发控件；② 用固定容器类名 `.select-dropdown,[class*=select-dropdown]` 找选项。
 *   号B 这次发布页的变体里 chip 实际是 `div.select-dropdown-option-video`、下拉列表也不是那个容器 →
 *   报「下拉里没有「购物车」选项」+「可见下拉: ["位置"]」，**看起来极像"这个号没有挂车权限"**（差点误判成账号闸门）。
 *   实测手工点开同一个 chip：`位置|购物车|影视演艺|小程序|游戏手柄|标记万物` **6 个全在**。
 *   ⇒ 不是权限问题，是**判据绑定了类名 + 单次快照**（仓库自己的坑表就写着"别靠固定 sleep，要轮询 waitFor"）。
 *
 * 新判据（不依赖任何类名）：
 *   ① 触发器 = 页面上**可见且文本恰为** 位置/购物车/… 的小控件（优先 class 像下拉的）；
 *   ② 点开后**轮询**：页面上是否出现"文本恰为「购物车」的可见叶子元素" ——
 *      只要当前标签不是购物车，出现的那一个就必然是选项，**不需要知道它在哪个容器里**；
 *   ③ 点不中就**整轮重试**（首次点击常被吃）。
 */
async function switchToCartTag(cdp) {
  const hasInput = () => ev(cdp, `!!document.querySelector('input[placeholder*="粘贴商品链接"]')`);
  if (await hasInput()) return { ok: true, 已有输入框: true };
  const LAB = '位置|购物车|影视演艺|小程序|游戏手柄|标记万物';
  const TRIG = `(() => {
    const LAB = ${JSON.stringify(LAB)};
    const re = new RegExp('^(' + LAB + ')$');
    const els = [...document.querySelectorAll('div,span,a,button')]
      .filter(e => e.offsetParent && re.test((e.innerText || '').trim()))
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.width < 420 && r.height > 0 && r.height < 90; });
    els.sort((a, b) => {
      const sa = /select-dropdown|semi-select/.test(String(a.className)) ? 0 : 1;
      const sb = /select-dropdown|semi-select/.test(String(b.className)) ? 0 : 1;
      return sa - sb;
    });
    const e = els[0]; if (!e) return null;
    e.scrollIntoView({ block: 'center' });
    return e;
  })()`;
  // ⚠️ ev() 走的是 returnByValue：**绝不能返回 DOM 元素**（会报
  //    "Object reference chain is too long"）。所以判断存在性用 _BOX（回传坐标纯数据），
  //    真要点击时用 _EL（只在 clickAt 内部被取用，不外传）。
  const CART_OPT_BOX = `(() => {
    const o = [...document.querySelectorAll('*')]
      .filter(e => e.children.length === 0 && (e.innerText || '').trim() === '购物车')
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })[0];
    if (!o) return null;
    const r = o.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`;
  const CART_OPT_EL = `(() => {
    return [...document.querySelectorAll('*')]
      .filter(e => e.children.length === 0 && (e.innerText || '').trim() === '购物车')
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })[0] || null;
  })()`;

  const 尝试 = [];
  for (let round = 1; round <= 4; round++) {
    const cur = await ev(cdp, `(() => { const e = ${TRIG}; return e ? (e.innerText || '').trim() : null; })()`);
    if (!cur) break;                                    // 页面上找不到那个下拉 → 交给旧逻辑兜底
    try { await clickAt(cdp, TRIG, '添加标签下拉'); }
    catch (e) { 尝试.push({ round, 当前: cur, 点击: String(e.message).slice(0, 50) }); continue; }
    let hit = null;
    for (let i = 0; i < 12 && !hit; i++) { await sleep(500); hit = await ev(cdp, CART_OPT_BOX); }
    尝试.push({ round, 当前: cur, 命中购物车选项: !!hit });
    if (!hit) continue;
    try { await clickAt(cdp, CART_OPT_EL, '购物车选项'); } catch (e) { continue; }
    for (let i = 0; i < 8 && !(await hasInput()); i++) await sleep(500);
    if (await hasInput()) return { ok: true, 原标签: cur, 尝试 };
  }
  return { ok: false, 尝试, 提示: '多轮点开下拉仍切不到「购物车」→ 这时才该怀疑账号没有商品分享(带货)权限' };
}

async function ensureCartRow(cdp) {
  // ① 先走新路径（不依赖类名，带轮询+重试）
  const r = await switchToCartTag(cdp);
  if (r.ok) return { 切到购物车: true, 原标签: r.原标签, 新路径: true, 尝试: r.尝试 };
  log({ stage: 'CART_SWITCH_FALLBACK', ...r });
  // ② 旧路径兜底（老的 .semi-select 页面变体仍可能命中）
  const hasInput = () => ev(cdp, `!!document.querySelector('input[placeholder*="粘贴商品链接"]')`);
  if (await hasInput()) return { 已有输入框: true };

  const SEL_EXPR = `(() => {
    const cands = [...document.querySelectorAll('.semi-select')].filter(e => {
      const r = e.getBoundingClientRect();
      if (r.width <= 0) return false;
      return /^(位置|购物车|影视演艺|小程序|游戏手柄|标记万物)$/.test((e.innerText || '').trim());
    });
    const e = cands[0]; if (!e) return null;
    e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), 当前: (e.innerText||'').trim() };
  })()`;
  const sel = await ev(cdp, SEL_EXPR);
  if (!sel) return { 错误: '未找到「添加标签」单选下拉' };
  await clickAt(cdp, `(() => {
    const cands = [...document.querySelectorAll('.semi-select')].filter(e => {
      const r = e.getBoundingClientRect();
      if (r.width <= 0) return false;
      return /^(位置|购物车|影视演艺|小程序|游戏手柄|标记万物)$/.test((e.innerText || '').trim());
    });
    return cands[0] || null;
  })()`, '添加标签下拉');

  // 轮询等下拉出现，并**遍历所有可见下拉**找「购物车」（别只取最后一个）
  const findOpt = `(() => {
    const dds = [...document.querySelectorAll('.select-dropdown,[class*="select-dropdown"]')]
      .filter(e => e.getBoundingClientRect().width > 0);
    const 下拉文本 = dds.map(e => (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,60));
    for (const dd of dds) {
      const opts = [...dd.querySelectorAll('[class*="option"]')]
        .filter(e => (e.innerText || '').trim() === '购物车' && e.getBoundingClientRect().width > 0);
      if (opts.length) {
        const r = opts[0].getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), 下拉文本 };
      }
    }
    return { 没找到: true, 下拉文本 };
  })()`;
  let hit = null, diag = null;
  for (let i = 0; i < 10; i++) {
    await sleep(700);
    const r = await ev(cdp, findOpt);
    diag = r && r.下拉文本;
    if (r && r.x) { hit = r; break; }
  }
  if (!hit) return { 错误: '下拉里没有「购物车」选项', 当前: sel.当前, 可见下拉: diag };
  await clickAt(cdp, `(() => {
    const dds = [...document.querySelectorAll('.select-dropdown,[class*="select-dropdown"]')]
      .filter(e => e.getBoundingClientRect().width > 0);
    for (const dd of dds) {
      const o = [...dd.querySelectorAll('[class*="option"]')]
        .filter(e => (e.innerText || '').trim() === '购物车' && e.getBoundingClientRect().width > 0)[0];
      if (o) return o;
    }
    return null;
  })()`, '购物车选项');
  await sleep(1800);
  return { 切到购物车: await hasInput(), 原标签: sel.当前, 下拉文本: hit.下拉文本 };
}

async function fillCart(cdp, url) {
  // 0) 先把「添加标签」那行切成「购物车」（否则页面上没有粘贴链接的输入框）
  const ensured = await ensureCartRow(cdp);
  if (ensured.错误) toastLog(ensured);
  await clickAt(cdp, `[...document.querySelectorAll('input')].filter(i=>i.offsetParent && /粘贴商品链接/.test(i.placeholder||''))[0]`, '粘贴商品链接 input');
  await cdp.send('Input.insertText', { text: url });
  await sleep(900);
  const st = await ev(cdp, `(() => { const b=[...document.querySelectorAll('span,button,a')].filter(e=>e.offsetParent && /^添加链接$/.test((e.innerText||'').trim()))[0];
    return b? { cls:String(b.className).slice(0,50), color:getComputedStyle(b).color, cursor:getComputedStyle(b).cursor } : null; })()`);
  const red = st && /254,\s*44,\s*85|254, 44, 85/.test(st.color);
  if (!red) return { 已填链接: url, 按钮状态: st, 变红: false };
  const box = await clickAt(cdp, BY_TEXT('添加链接', 'span,button,a'), '添加链接');
  await sleep(1500);
  // ⚠️ 新 UI（2026-09-11 实测）：加成功后**不再显示「已添加商品（N）」**，
  //    而是出现商品块「每单赚¥2.1 售价¥9.9 ... 编辑 移除」。两种都认。
  // ⚠️ 关键（2026-09-11 实测）：点【添加链接】后应用会**自动弹出「编辑商品」弹层**，
  //    必须填「商品短标题」并点【完成编辑】，挂车**才算提交**（此时才出现「已添加商品（1）… 编辑 移除」）。
  //    所以这里等到「弹层出现」或「商品块出现」都算正常，交给后面 fillShortTitle / 发布前校验处理。
  let cnt = '0';
  for (let i = 0; i < 15; i++) {
    await sleep(900);
    const r = await ev(cdp, `(() => {
      const tx = (document.body.innerText || '').replace(/\\s+/g, ' ');
      const modal = [...document.querySelectorAll('.semi-modal-wrap,.semi-modal')]
        .some(e => e.getBoundingClientRect().width > 300 && /商品短标题/.test(e.innerText || ''));
      const m = tx.match(/已添加商品[（(](\\d+)[）)]/);
      return { modal, 计数: (m && m[1] !== '0') ? m[1] : '0',
               商品块: /每单赚\\s*¥/.test(tx) && /移除/.test(tx) };
    })()`);
    if (r && r.modal) { cnt = '待完成编辑'; break; }        // 弹层已开 → 需要走短标题
    if (r && (r.计数 !== '0' || r.商品块)) { cnt = r.计数 !== '0' ? r.计数 : '已添加'; break; }
  }
  return { 已填链接: url, 按钮状态: st, 变红: true, 点击坐标: box, 已添加商品: cnt };
}

async function fillShortTitle(cdp, title) {
  const n = [...title].length;
  if (n > 10) throw new Error(`商品短标题上限 10 个汉字，当前 ${n} 字：${title}`);
  const modalOpen = () => ev(cdp, `[...document.querySelectorAll('.semi-modal-wrap,.semi-modal')]
    .some(e => e.getBoundingClientRect().width > 300 && /商品短标题/.test(e.innerText||''))`);

  // ① 弹层没开 → 点购物车块里的「编辑」把它打开（等它渲染出来，早了会「找不到可点元素」）
  if (!(await modalOpen())) {
    let editPos = null;
    for (let i = 0; i < 15; i++) {
      editPos = await ev(cdp, `(() => {
        const els = [...document.querySelectorAll('span,button,a,div')]
          .filter(e => e.offsetParent && /^编辑$/.test((e.innerText||'').trim()))
          .sort((a,b) => a.innerText.length - b.innerText.length);
        const e = els[els.length - 1] || els[0]; if (!e) return null;
        e.scrollIntoView({ block: 'center' });
        const r = e.getBoundingClientRect();
        if (r.width <= 0) return null;
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      })()`);
      if (editPos) break;
      await sleep(1000);
    }
    if (!editPos) return { 错误: '没有「编辑商品」弹层，也找不到「编辑」按钮（商品可能没加成功）' };
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: editPos.x, y: editPos.y, button: 'left', clickCount: 1 });
    }
    await sleep(1500);
  } else {
    log({ stage: '编辑商品弹层_已自动打开', 说明: '点「添加链接」后应用自己弹的 → 直接填短标题' });
  }

  // ② 弹层里的短标题输入框
  let fin = null;
  for (let i = 0; i < 12; i++) {
    fin = await ev(cdp, `(() => {
      const w = document.querySelector('.semi-modal-wrap') || [...document.querySelectorAll('.semi-modal')].filter(e=>e.getBoundingClientRect().width>300).pop();
      if (!w || !/商品短标题/.test(w.innerText || '')) return null;
      const e = [...w.querySelectorAll('input,textarea')].filter(x => x.getBoundingClientRect().width > 60)[0];
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), 原值: e.value || '' };
    })()`);
    if (fin) break;
    await sleep(900);
  }
  if (!fin) return { 错误: '「编辑商品」弹层里没有短标题输入框' };
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: fin.x, y: fin.y, button: 'left', clickCount: 1 });
  }
  await sleep(300);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', commands: ['selectAll'] });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', commands: ['selectAll'] });
  await cdp.send('Input.insertText', { text: title });
  await sleep(800);
  const val = await ev(cdp, `(() => {
    const w = document.querySelector('.semi-modal-wrap');
    const e = w && [...w.querySelectorAll('input,textarea')].filter(x => x.getBoundingClientRect().width > 60)[0];
    return e ? e.value : null;
  })()`);

  // ③ 点【完成编辑】—— 它在 `.semi-modal-wrap` 页脚，类名 `modal-btn-rsq2u7`
  //    （踩过：用 [class*="modal"] 当作用域会匹配到输入框；全页找「完成编辑」在弹层没开时是空的）
  let okPos = null;
  for (let i = 0; i < 12; i++) {
    okPos = await ev(cdp, `(() => {
      const w = document.querySelector('.semi-modal-wrap');
      const scope = w || document;
      const e = [...scope.querySelectorAll('button.modal-btn-rsq2u7,button,span,div,a')]
        .filter(x => (x.innerText||'').trim() === '完成编辑' && x.getBoundingClientRect().width > 0)
        .map(x => ({ r: x.getBoundingClientRect() }))
        .sort((a,b) => a.r.width*a.r.height - b.r.width*b.r.height)[0];
      if (!e) return null;
      return { x: Math.round(e.r.x + e.r.width/2), y: Math.round(e.r.y + e.r.height/2) };
    })()`);
    if (okPos) break;
    await sleep(800);
  }
  if (okPos) {
    // ⚠️ 2026-09-22（ego 化）：坐标点击在 ego 上会"点了但没提交"（实测：弹层关了、商品块却没出现）
    //    ⇒ 优先 ego 原生 click（自带 actionability + 单匹配校验），不成再回退坐标点击。
    let clicked = false;
    if (typeof cdp.click === 'function') {
      for (const sel of ['button.modal-btn-rsq2u7', '.semi-modal-wrap button:has-text("完成编辑")', 'button:has-text("完成编辑")']) {
        try { await cdp.click(sel, { timeout: 4000, label: '完成编辑' }); clicked = true; break; } catch (e) {}
      }
    }
    if (!clicked) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: okPos.x, y: okPos.y, button: 'left', clickCount: 1 });
      }
    }
    await sleep(2500);
  }
  const left = await ev(cdp, `[...document.querySelectorAll('.semi-modal')].filter(e => e.getBoundingClientRect().width > 300).length`);
  // ④ 完成编辑后挂车才算提交 → 校验商品块
  const added = await ev(cdp, `(() => {
    const tx = (document.body.innerText || '').replace(/\\\\s+/g, ' ');
    const m = tx.match(/已添加商品[（(](\\\\d+)[）)]/);
    return (m && m[1] !== '0') ? m[1] : (/每单赚\\\\s*¥/.test(tx) && /移除/.test(tx) ? '已添加' : '0');
  })()`);
  return { 填入: title, 输入框值: val, 完成编辑: !!okPos, 弹层残留: left, 已添加商品: added };
}

async function doPublish(cdp) {
  const st = await ev(cdp, READ);
  if (!st.publishBtn || st.publishBtn.disabled) return { 已点击: false, 原因: '发布按钮不可用', 按钮: st.publishBtn };
  await clickAt(cdp, BY_TEXT('发布', 'button,.ovui-btn'), '发布');
  // 等跳转 / toast
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const s = await ev(cdp, `(() => ({ url: location.href, t: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,300) }))()`);
    if (!/content\/post\/video/.test(s.url)) return { 已点击: true, 新URL: s.url, 提示: s.t.slice(0, 160) };
    const m = s.t.match(/(发布成功|上传中|请勿关闭页面|失败|违规|审核)/);
    if (m && i > 3) return { 已点击: true, url: s.url, 页面提示: m[0] };
  }
  return { 已点击: true, 说明: '点击后 30s 内未见跳转，请人工确认' };
}

// ---------- 主流程 ----------
let OK = true;   // ⚠️ 任何一步不达标就置 false 并退 1（原来一律 exit(0)，编排器会把失败当成功）
(async () => {
  log({ stage: 'M3_PUBLISH_START', env: envName, 动作: { desc: !!DESC, cart: !!CART, shortTitle: !!SHORT, publish: DO_PUBLISH } });
  // ══ 取页：ego 走 ego-tab shim（page.cdp/evaluate），比特走原路 ══════════════════
  // 用户 2026-09-22：「m3 m4 你要想办法换成 ego 的方式」。业务判据一行不改。
  let cdp;
  if (typeof taskSpace === 'function') {
    const { openCdp } = require('./ego/ego-tab.js');
    const r = await openCdp({ envId: env, match: /creator\.douyin\.com\/creator-micro\/content\/post/, log });
    cdp = r.cdp;
    log({ stage: 'M3_PUBLISH_EGO', ok: true, url: r.url.split('?')[0], mode: r.mode });
  } else {
  const info = await api.open(env);
  const tabs = ((await (await fetch(`http://${info.http}/json/list`)).json()) || []).filter((t) => t.type === 'page');
  const tab = tabs.find((t) => /creator\.douyin\.com\/creator-micro\/content\/post/.test(t.url || ''));
  if (!tab) { log({ stage: 'M3_PUBLISH_FAIL', error: '未找到发布页标签', tabs: tabs.map((t) => String(t.url).split('?')[0]) }); process.exit(1); }
  cdp = await Cdp.connectWs(tab.webSocketDebuggerUrl);
  }
  try {
    log({ stage: '前状态', ...(await ev(cdp, READ)) });
    if (DESC) { const r = await setDesc(cdp, DESC); log({ stage: '填描述', ...r }); if (!r.一致) OK = false; }
    if (CART) {
      const r = await fillCart(cdp, CART); log({ stage: '挂车', ...r });
      if (!r.变红 || String(r.已添加商品 || '0') === '0') { OK = false; log({ stage: 'ERR_挂车未成功', 结果: r }); }
    }
    if (SHORT) {
      const r = await fillShortTitle(cdp, SHORT); log({ stage: '短标题', ...r });
      if (r.错误 || !r.输入框值 || r.弹层残留) { OK = false; log({ stage: 'ERR_短标题未完成', 结果: r }); }
    }
    // 🚨 发布前最后一道校验：要求挂车就必须在页面上看到**商品块**
    //    唯一判据 = `每单赚¥X 售价¥Y … 编辑 移除`。
    //    （2026-09-11 事故：链接填了/按钮红了/编辑商品弹层里也有「每单赚」，就去发布 → 发出去没车）
    if (DO_PUBLISH) {
      // ⚠️ 2026-09-22（ego 实盘）：商品块**渲染要几秒**（实测：完成编辑后立刻读 = 0，几秒后 = 1）
      //    ⇒ 改成轮询（最多 20s）；并且**只要要发布就校验**（不再要求传了 --cart —— 商品可能是上一轮挂好的）。
      let cartOK = false;
      for (let i = 0; i < 10 && !cartOK; i++) {
        cartOK = await ev(cdp, `(() => {
          const tx = (document.body.innerText || '').replace(/\\s+/g, ' ');
          return /每单赚\\s*¥/.test(tx) && /移除/.test(tx);
        })()`);
        if (!cartOK) await sleep(2000);
      }
      if (!cartOK) {
        OK = false;
        log({ stage: 'ABORT_发布前校验', ok: false,
              原因: '页面上看不到已挂车的商品块（必须同时出现「每单赚¥」和「移除」）→ 拒绝发布',
              提示: '重新走一遍：添加标签→购物车→贴链接→添加链接→看到商品块；或对已发布作品用 bit-m3-edit-cart.js' });
        throw new Error('挂车未确认，拒绝发布');
      }
      log({ stage: '发布前校验_挂车已确认' });
    }
    let pubRes = null;
    if (DO_PUBLISH) { pubRes = await doPublish(cdp); log({ stage: '发布', ...pubRes }); }
    log({ stage: '后状态', ...(await ev(cdp, READ)) });
    if (DO_PUBLISH) {
      // 成功判据：URL 离开了发布页，或页面出现「发布成功」
      const good = !!(pubRes && (pubRes.新URL || (pubRes.页面提示 && /成功/.test(pubRes.页面提示))));
      if (!good) { OK = false; log({ stage: 'M3_PUBLISH_UNCONFIRMED', 结果: pubRes, 提示: '未确认发布成功（可能撞验证码）→ 编排器会判失败' }); }
    }
  } catch (e) {
    OK = false; log({ stage: 'M3_PUBLISH_FAIL', error: String(e.message || e) });
  } finally { try { cdp.close(); } catch (e2) {} }
  process.exit(OK ? 0 : 1);
})().catch((e) => { log({ stage: 'M3_PUBLISH_FAIL', error: String(e.message || e) }); process.exit(1); });
