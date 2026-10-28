'use strict';
// 千川重建 助手库 —— CDP 版（比特浏览器驱动），逻辑逐函数移植自生产版 qc-lib.js（ego 版，12+ 次实战验证）
// 差异: ctx = { env, cdp, js, wait, pressKey, newTab, listTabs, closeTab, gotoAndWait }
//  - env: 比特环境 id（千川/抖音分离，S3/S6 由 runner 切到抖音环境 ctx 调用）
const CONST = require('./qc-const.js');
const { Cdp } = require('./bit-cdp.js');
const api = require('./bit-api.js');
// ego 传输层：普通 node 下 `inEgo()` 恒为 false ⇒ 比特链路一字不变（152 例单测全绿）
const EGO = require('./ego/ego-transport.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ⚠️ fetch 超时保护: 环境 tab 端口变更/localAPI 限流时, 裸 fetch('/json/list') 可能永久挂起,
// 导致编排进程卡死在 S1/S10 等阶段无任何日志。统一走这里加 AbortController 超时。
const fetchJ = async (url, opts = {}, timeoutMs = 12000) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('fetch超时(' + (url.length > 90 ? url.slice(0, 90) + '…' : url) + ' ' + timeoutMs + 'ms)');
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

// ⏱ 行为温和化（用户 2026-09-22 批准）：**固定节奏**（雷打不动的 1.2s / 0.25s + 均匀滚动）是最像机器人的
//    特征之一。这里只做两件事：给等待加**随机抖动**、把"最后兜底"的轮数收一收。
//    ⛔ 判据与红线一个字不动；S3 的**搜索探测逻辑不动**（用户 2026-09-12 明确「s3 还是按照原来的，别动 S3」）。
const jitter = (base, spread = 0.5) => base + Math.random() * spread;
const waitJ = (base, spread = 0.5) => sleep(jitter(base, spread) * 1000);

/**
 * 滚动助手（用户 2026-09-22：「行为温和点 看看 bitbrowser 滚底怎么做的」）
 *   · 结构**照比特版**：首屏优先 → 向下增量滚 → 顶扫+下滚都失败才兜底"滚到底"（轮数也照比特版 80）。
 *   · 方式**改人手**：优先 egg 原生 `page.mouse.wheel`（真滚轮事件、平滑），
 *     它是"鼠标底下的容器"才吃滚动 ⇒ ctx.egoScroll 会移鼠标进去并**回读 scrollTop 验证真的动了**；
 *     没动/不支持 → 回退原来的 JS 滚动（`scrollTop += n` / `= scrollHeight`），绝不因为换方式把链路搞挂。
 */
const scrollPane = async (ctx, px, { selector = '.parent-route-container', label } = {}) => {
  if (ctx && ctx.egoScroll) {
    try { const r = await ctx.egoScroll({ selector, delta: px, label }); if (r && r.ok) return 'wheel'; } catch (e) {}
  }
  await ctx.js(`(() => { const sc = document.querySelector(${JSON.stringify(selector)}); if (sc) { sc.scrollTop += ${px}; return; } window.scrollBy(0, ${px}); })()`);
  return 'js';
};
const scrollPaneToBottom = async (ctx, { selector = '.parent-route-container', label } = {}) => {
  // 人手滚到底 = 连续几格滚轮（而不是一次性瞬跳 scrollHeight）
  if (ctx && ctx.egoScroll) {
    const h = await ctx.js(`(() => { const sc = document.querySelector(${JSON.stringify(selector)}); return sc ? Math.round(sc.clientHeight) : 0; })()`).catch(() => 0);
    const step = Math.max(400, Math.min(1200, h || 800));
    try {
      for (let i = 0; i < 6; i++) {
        const r = await ctx.egoScroll({ selector, delta: step, label: label || '滚到底' });
        if (!r || !r.ok) break;
      }
      return 'wheel';
    } catch (e) {}
  }
  await ctx.js(`(() => { const sc = document.querySelector(${JSON.stringify(selector)}); if (sc) { sc.scrollTop = sc.scrollHeight; return 1; } window.scrollTo(0, document.body.scrollHeight); return 2; })()`);
  return 'js';
};

// ============ ctx 适配层: 把比特环境包装成 qc-lib 需要的驱动接口 ============
// ctx.env = 环境id; 内部懒连接该环境 CDP(tab级自动找主页tab), newTab(url) 打开新页并切换目标
// ⚠️ 每次连接需要 /browser/open 拿端口, 但高频调用会触发 localAPI 429 限流 → 缓存连接, 断开才重连
function makeEnvCtx(envId) {
  // ── ego 运行时：同一个 ctx 契约，传输换成 ego（**业务判据一行不改**）─────────────
  // 用户 2026-09-22：「先登代投，再做 ego 适配层，再重建」。
  // 判据层只认 `{env,cdp,js,wait,pressKey,gotoAndWait,listTabs,closeTab,pageInfo}`，
  // 所以这里换实现即可；ego 的 page.cdp() 覆盖 Page/Runtime/DOM/Network/Input，CDP 调用点原样可跑。
  // env → profile 由 `ego-env-ctx` 按映射表（qc-config ↔ ego-profiles.local.js）解析，**对不上就抛错，绝不猜**。
  if (EGO.inEgo()) return require('./ego/ego-env-ctx.js').makeEgoEnvCtx(envId);

  let cdp = null;      // 当前连接的 Cdp
  let port = null;     // 当前 http 端口
  let targetId = null; // 当前目标 tab id
  let lastOpenAt = 0;

  const alive = () => cdp && cdp.ws && cdp.ws.readyState === 1;

  // 限流退避: 429 时等 1.5s 重试(最多3次); 两次 open 至少间隔 800ms
  const openOnce = async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 3; i++) {
      const gap = Date.now() - lastOpenAt;
      if (gap < 800) await wait(800 - gap);
      try {
        const info = await api.open(envId);
        lastOpenAt = Date.now();
        return info;
      } catch (e) {
        if (/429/.test(e.message) && i < 2) { await wait(1500); continue; }
        throw e;
      }
    }
  };

  const ensureConnected = async () => {
    // ⚠️ 不能只看 ws.readyState===1: 页面刷新/跳转后旧 cdp 表面 OPEN 但 target 已失效,
    //    后续 js/cdp 会死锁(永不返回)。每次调用都校验当前 target 是否仍是活千川/抖音页, 不满足即重连。
    if (alive() && port && targetId && (await targetAlive())) return;
    // 重建连接
    const info = await openOnce();
    port = info.http;
    const tabs = await fetchJ(`http://${port}/json/list`);
    const page = tabs.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://') && !t.url.includes('console.bitbrowser.net'));
    // 优先业务页(千川/抖音), 否则任意 page
    const biz = tabs.find((t) => t.type === 'page' && (t.url.includes('qianchuan') || t.url.includes('douyin'))) || page;
    if (!biz) throw new Error(`env ${envId} 无页面 target`);
    targetId = biz.id || biz.targetId;
    cdp = await Cdp.connectWs(biz.webSocketDebuggerUrl);
  };
  // 校验当前 target: 在 /json/list 里仍存在且 url 是千川/抖音业务页(证明没被刷新/跳走成失效 target)
  const targetAlive = async () => {
    try {
      const tabs = await fetchJ(`http://${port}/json/list`);
      const hit = tabs.find((t) => (t.id || t.targetId) === targetId && t.type === 'page');
      if (!hit) return false;
      const u = hit.url || '';
      return u.includes('qianchuan') || u.includes('douyin');
    } catch { return false; }
  };

  return {
    env: envId,
    async cdp(method, params) { await ensureConnected(); return cdp.send(method, params); },
    async js(expr) { await ensureConnected(); return cdp.eval(expr); },
    async wait(sec) { await sleep(sec * 1000); },
    async pressKey(key) {
      await ensureConnected();
      const map = { Enter: { key: 'Enter', code: 'Enter', vk: 13 }, Escape: { key: 'Escape', code: 'Escape', vk: 27 } };
      const k = map[key] || { key, code: key, vk: key.charCodeAt(0) };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk });
    },
    // 打开新 tab(或复用同站已有 tab), 导航并等待加载
    // ⚠️ 复用优先（用户 2026-09-11 多次强调：「有些窗口可以复用就复用不要一直刷新，除了我要求的刷新」）：
    //    ① 已有标签**就在目标页**（路径+关键参数一致）→ **零导航直接复用**（最省，也不会掉登录）
    //    ② 否则用同站其它标签导航过去（**避开带草稿的创建页**）
    //    ③ 都没有才开新标签
    //    只有显式 `{ reload: true }` 才会强制刷新（例如用户要求"必须刷新才能看到审核状态"的场景）
    async gotoAndWait(url, { timeout = 20, reload = false } = {}) {
      await ensureConnected();
      const info = { http: port };
      const tabs = await fetchJ(`http://${info.http}/json/list`);
      const site = new URL(url).origin;
      // 目标 vs 当前：共用 tab-reuse.js 的 sameView（单一事实源，避免两处判据分叉）
      const { sameView } = require('./tab-reuse.js');
      // ⚠️ 2026-09-12 用户定位：「切换到直投侧的时候，代投侧就弹出『确定退出并放弃创建全域投放吗？』」
      //    根因：创建页 URL 带 `enter_from_inside=…`，而页面自己跳转后常常少了这个参数 →
      //    sameView（要求目标参数全被当前覆盖）判成"不同页" → **在有草稿的创建页上导航** → 弹离开确认。
      //    ⇒ 创建页（/uni-creation/product）**只要路径相同且 aavid 一致就复用**，一律不导航。
      const sameDraftPage = (cur, want) => {
        try {
          const c = new URL(cur), w = new URL(want);
          if (!/\/uni-creation\/product/.test(c.pathname) || c.pathname !== w.pathname) return false;
          const ca = c.searchParams.get('aavid'), wa = w.searchParams.get('aavid');
          return !ca || !wa || ca === wa;
        } catch (e) { return false; }
      };
      const pages = tabs.filter((t) => t.type === 'page' && (t.url || '').startsWith(site) && !t.url.startsWith('chrome-extension://'));
      const sameTab = pages.find((t) => sameView(t.url || '', url) || sameDraftPage(t.url || '', url));
      let hit = sameTab || pages.find((t) => !/\/uni-creation\//.test(t.url || '')) || pages[0];
      if (sameTab && !reload) {
        // ① 零导航复用：页面已经在目标视图上，什么都不动
        targetId = sameTab.id || sameTab.targetId;
        cdp = await Cdp.connectWs(sameTab.webSocketDebuggerUrl);
        try { await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CONST.SIXPACK }); } catch (e) {}
        try { await cdp.send('Page.bringToFront', {}); } catch (e) {}
        console.log(JSON.stringify({ stage: 'REUSE_SAME_PAGE', ok: true,
          说明: sameDraftPage(sameTab.url || '', url) && !sameView(sameTab.url || '', url)
            ? '创建页同路径 → 零导航复用（**不导航草稿页**，避免"确定退出并放弃创建"）'
            : '已在目标页 → 零导航复用（不刷新）',
          页: String(sameTab.url).split('?')[0] }));
        return true;
      }
      // ⚠️ 2026-09-11 血泪：**绝不在"有草稿的创建页"上跳走**。
      //    创建页（uni-creation）一旦填过东西（加过商品/素材/标题），在上面导航会触发原生确认
      //    「确定退出并放弃重建全域投放吗？」——弹窗阻塞渲染进程 → 之后 Runtime.evaluate 全部超时。
      //    所以：现有标签停在创建页、而目标不是创建页 → **另开一个标签**，把草稿页原样留着。
      if (hit && /\/uni-creation\//.test(hit.url || '') && !/\/uni-creation\//.test(url)) {
        console.log(JSON.stringify({ stage: 'NAV_NEW_TAB_DRAFT_SAFE', ok: true,
          说明: '现有标签是创建页（可能有未发布草稿）→ 另开新标签，避免"确定退出并放弃重建"弹窗',
          草稿页: String(hit.url).split('?')[0], 目标: String(url).split('?')[0] }));
        hit = null;
      }
      const wsUrl = hit ? hit.webSocketDebuggerUrl : null;
      if (wsUrl) {
        targetId = hit.id || hit.targetId;
        cdp = await Cdp.connectWs(wsUrl);
        // ⚠️ 六件套必须在导航前注册(addScriptToEvaluateOnNewDocument 对当前已加载页无效),
        // 否则首次加载裸奔(webdriver暴露)→千川风控弹/login
        try { await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CONST.SIXPACK }); } catch {}
        // 复用已有 tab → 同 tab 内导航(刷新)
        // ⚠️ 创建页有草稿时跳转会弹原生确认「确定退出并放弃重建全域投放吗？」；
        //    不接受的话导航被取消 → 后续等 load 一直超时。这里明确表示"要走"（并会打日志）。
        cdp.acceptNextDialog();
        await cdp.send('Page.navigate', { url });
      } else {
        // 浏览器级建新 tab (openOnce 带节流缓存, 不会高频打 API)
        const info = await openOnce();
        const b = await Cdp.connectWs(info.ws);
        const { targetId: tid } = await b.send('Target.createTarget', { url });
        await sleep(1500);
        b.close();
        const tabs2 = await fetchJ(`http://${info.http}/json/list`);
        const nt = tabs2.find((t) => t.id === tid) || tabs2.find((t) => t.type === 'page' && (t.url || '').startsWith(site));
        if (!nt) throw new Error('新 tab 未出现: ' + site);
        targetId = nt.id || nt.targetId;
        cdp = await Cdp.connectWs(nt.webSocketDebuggerUrl);
      }
      // ⚠️ 跨环境切换必须把目标标签带到前台: 后台标签被浏览器节流,
      // SPA 不渲染列表(S3曾因此 pub=false priv=false 假失败,页面文本停在首页feed)
      try { await cdp.send('Page.bringToFront', {}); } catch {}
      let ok = null;
      for (let nav = 0; nav < 3 && !ok; nav++) {
        try {
          ok = await cdp.eval(`new Promise(res => { if (document.readyState === 'complete') return res(true);
            window.addEventListener('load', () => res(true), { once: true }); setTimeout(() => res(true), ${timeout * 1000}); })`);
        } catch (e) {
          if (!/navigated or closed/i.test(e.message || '')) throw e;
          await sleep(1500);
          try { cdp.acceptNextDialog(); await cdp.send('Page.navigate', { url }); } catch (_) {}
          await sleep(2500);
        }
      }
      return ok;
    },
    async listTabs() {
      await ensureConnected();
      const tabs = await fetchJ(`http://${port}/json/list`);
      return tabs.filter((t) => t.type === 'page').map((t) => ({ id: t.id, targetId: t.id, url: t.url, title: t.title }));
    },
    async closeTab(id) {
      await ensureConnected();
      const b = await Cdp.connectWs((await openOnce()).ws);
      try { await b.send('Target.closeTarget', { targetId: id }); } finally { b.close(); }
    },
    async pageInfo() {
      await ensureConnected();
      return { url: await cdp.eval('location.href') };
    },
    // 任务空间概念在比特环境不存在 —— runner 直接驱动环境, 无需认领
    async claimTaskSpace() { return { id: envId }; },
    async completeTaskSpace() {},
    async handOffTaskSpace() {},
    async takeOverTaskSpace() {},
    async waitForAgentControl() {},
    async useOrCreateTaskSpace() { return { id: envId }; },
  };
}

// ============ 业务库(逐函数移植自 qc-lib.js, 坑位注释保留) ============
function makeLib(ctx) {
  // ── 识别码前缀（**按号走**，见 frag-code.js）────────────────────────────
  // 抖音侧 ctx.env = 某个抖音号环境 → 用该号自己的前缀（号A demoA / 号B demoB / 别的号 demoC…）
  // 千川侧 ctx.env = 代投环境（不在 dyEnvs 里）→ 退回「全部已配置前缀」，因为素材可能来自任何一个号
  const FC = require('./frag-code.js');
  const FRAG_PREFIX = FC.prefixForEnv(ctx.env);
  const FRAG_HEAD_RE = FC.headReSrc(FRAG_PREFIX);     // 初筛：前缀+数字
  const FRAG_CODE_RE = FC.codeReSrc(FRAG_PREFIX);     // 抓码：前缀+数字+可选 -NN（-NN = 异常品）

  const injectSixPack = async () => {
    await ctx.cdp('Page.addScriptToEvaluateOnNewDocument', { source: CONST.SIXPACK });
  };

  // hoverMs: 鼠标【移过去之后、按下之前】额外停顿的毫秒数(默认 0 = 老行为, 一字不变)。
  // 🔥 2026-09-13: S6(搜索路径)首击连续 3/3 被吞, S3(滚动路径)3/3 命中 ——
  //    唯一差别: S6 鼠标是"从搜索框/批量管理按钮新移到卡片上"的, 会触发一次 hover 过渡, 首击被吞;
  //    S3 鼠标早就在列表区域, 没有新过渡。故首击给 hover 过渡留时间(把等待放在 mouseMoved 之后)。
  const cdpClick = async (x, y, pauseMs = 300, hoverMs = 0) => {
    // 🔥 2026-09-22（ego 变体，用户要求「有 ego 特属的方式更方便就尽量去用」）：
    //    ego 运行时里 ctx 提供 `egoMouseClick` ⇒ 优先走 `page.mouse`（ego 自己的输入管线），
    //    语义与下面那串 CDP 事件**逐条对齐**（move → hover 过渡 → down → 停留 → up）；
    //    抛错才回退 CDP（逃生通道保留，行为不因换传输而改变）。
    if (ctx.egoMouseClick) {
      try { await ctx.egoMouseClick(x, y, { hoverMs, pauseMs }); return; }
      catch (e) {
        console.log(JSON.stringify({ stage: 'EGO_MOUSE_FALLBACK', ok: false, x, y, err: String(e.message || e).slice(0, 120), 说明: 'ego 原生点击失败 → 回退 CDP 合成事件' }));
      }
    }
    await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    if (hoverMs > 0) await ctx.wait(hoverMs / 1000);
    await ctx.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await ctx.wait(pauseMs / 1000);
    await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };

  // ⏱ 心跳（2026-09-22，「自己起的监视」复盘发现的最大盲区）：
  //    长等待期间日志**一行中间状态都没有** —— S7 那次卡满 360s 被阶段看门狗打死，
  //    事后完全看不出它在等什么。⇒ 任何 waitFor 只要等超过 15s，就打一行心跳（含在等的判据片段）。
  //    纯加日志、不改判据、不改超时。
  const waitFor = async (expr, { timeout = 15000, interval = 250, 标签 = null } = {}) => {
    const t0 = Date.now();
    let 上次心跳 = 0;
    for (;;) {
      let r = null;
      try { r = await ctx.js(expr); } catch { r = null; }
      if (r) return r;
      const 已等 = Date.now() - t0;
      if (已等 > timeout) return null;
      if (已等 - 上次心跳 >= 15000) {
        上次心跳 = 已等;
        try {
          console.log(JSON.stringify({ stage: 'WAIT_HEARTBEAT', ok: true, 已等秒: Math.round(已等 / 1000), 上限秒: Math.round(timeout / 1000),
            等的是: (标签 || String(expr).replace(/\s+/g, ' ').slice(0, 70)) }));
        } catch (e) {}
      }
      await ctx.wait(interval / 1000);
    }
  };

  // 坑6: 视口外先 scrollIntoView; 坑18: 布局位移 → 语义定位
  const locateByText = async (text, { exact = true, scope = null, minY = 0, maxY = null, minW = 1 } = {}) => {
    const scopeExpr = scope ? `document.querySelector(${JSON.stringify(scope)})` : 'document';
    const match = exact ? `(e.innerText||'').trim()===${JSON.stringify(text)}` : `(e.innerText||'').includes(${JSON.stringify(text)})`;
    const yCond = maxY == null ? 'true' : `r.y<=${maxY}`;
    const expr = String.raw`(() => {
      const root = ${scopeExpr};
      if (!root) return null;
      const els = [...root.querySelectorAll('button,a,span,div,li')].filter(e => e.offsetParent && ${match});
      let best = null;
      for (const e of els) {
        const r = e.getBoundingClientRect();
        if (r.width>=${minW} && r.height>0 && r.y>=${minY} && (${yCond})) {
          const area = r.width*r.height;
          if (!best || area < best.area) best = { el: e, area };
        }
      }
      if (!best) return null;
      best.el.scrollIntoView({ block: 'center' });
      const r = best.el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`;
    return ctx.js(expr);
  };

  const clickByText = async (text, opts = {}) => {
    const pos = await locateByText(text, opts);
    if (!pos) return null;
    await cdpClick(pos.x, pos.y, opts.pauseMs || 300);
    return pos;
  };

  // 坑3: 原生 setter + input/change; 坑17: 需先聚焦再填
  const fillNative = async (query, value) => {
    const expr = String.raw`((q, v) => {
      const el = document.querySelector(q);
      if (!el) return null;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })` + `(${JSON.stringify(query)}, ${JSON.stringify(value)})`;
    return ctx.js(expr);
  };

  // 坑16: 日期筛选默认当天 → wide 扩为近7天~今天
  const gotoQianchuan = async (o = {}) => {
    let url = CONST.ENTRY_URL;
    if (o.wide) {
      const f = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const from = new Date(Date.now() - 6 * 86400000);
      const today = new Date();
      url = CONST.ENTRY_URL.split('?')[0] + '?aavid=' + CONST.ACCOUNT_ID + '&ct=1&dr=' + f(from) + '%2C' + f(today);
    }
    // ⚠️ bitbrowser 环境千川会话不稳定: 导航后常弹回 /login 账户选择页, 且点选账户后跳到 /home(非计划列表),
    //    导致后续 searchPlanById 找不到搜索框/列表 → S10 卡死。这里循环: 登录页就点选账户, 选完再 re-navigate 回计划列表,
    //    直到 URL 停在 uni-prom 且列表出现行。
    for (let round = 0; round < 4; round++) {
      await ctx.gotoAndWait(url, { timeout: 25, reload: !!o.reload });   // 🔧 reload: 强制真重载(不复用脏页)
      // 多账户会话兜底: 千川弹回 /login 选择账户页时, 按当前账户ID自动点选
      // ⚠️ 不能用"含 ID + 账户ID"双重匹配: 登录页把 `ID: 187...` 分行渲染, 没有单个 div/li 同时含两者,
      //    会永远匹配不到 → 一直卡在 /login。改成只按账户ID匹配(账户名与ID同容器卡片)。
      let picked = false;
      for (let n = 0; n < 14; n++) {
        const st = await ctx.js(`(() => {
          if (!location.href.includes('/login')) return 'ok';
          const wantMount = ${JSON.stringify(String(CONST.ACCOUNT_ID))};
          const els = [...document.querySelectorAll('div,li,button')].filter(e => e.offsetParent && (e.innerText||'').includes(wantMount));
          if (els.length) {
            let b = null;
            for (const e of els) { const r = e.getBoundingClientRect(); const a = r.width * r.height; if (r.width > 60 && r.height > 20 && (!b || a < b.a)) b = { r, a }; }
            if (b) return { x: Math.round(b.r.x + b.r.width/2), y: Math.round(b.r.y + b.r.height/2) };
          }
          const item = [...document.querySelectorAll('*')].find(e => e.offsetParent && /ID[：:]/.test(e.innerText||'') && (e.innerText||'').length < 60);
          let sc = null, hop = item;
          while (hop && hop !== document.body) { if (hop.scrollHeight > hop.clientHeight + 100) { sc = hop; break; } hop = hop.parentElement; }
          if (sc) sc.scrollTop += 500;
          return null;
        })()`);
        if (st === 'ok') break;
        if (st && st.x) { await cdpClick(st.x, st.y); picked = true; await ctx.wait(4); } else { await ctx.wait(1); }
      }
      // 判断是否已停在计划列表页(uni-prom) — 是则结束, 否(如 /home)则重新导航
      const done = await ctx.js(`(() => {
        const h = location.href;
        if (h.includes('/login')) return false;
        if (h.includes('uni-prom')) return true;
        return false;
      })()`);
      if (done) break;
      // 账户选完跳到 /home: 下一轮会 re-goto 回来; picked 表示本轮回退出登录态, 已尝试
    }
    await injectSixPack();
    await dismissModals();
    // ⚠️ 2026-09-21：**每次导航到计划列表都顺手清掉残留搜索/筛选**。
    //    实盘：S1/S2 搜旧计划 → S2 把旧计划删了 → 过滤条件还在（筛 0 行）→
    //    S5「新计划ID未找到」/ S7「素材入口未找到 hasPlanRow:false（rows 只有表头）」。
    //    放在这里 = S5/S7/S9 以及 m7 那条链一次修好（`clearPlanListFilter` 在后面定义，
    //    但本函数是"被调用时"才执行 → 那时它已初始化，不存在 TDZ 问题）。
    try { await clearPlanListFilter(); } catch (e) {}
    tmark('导航到计划列表');
  };
  const gotoDouyin = async (sub, opts = {}) => {
    // 🔥 用户 2026-09-12「s6 重新刷新重新来」: S6 强制【整页重载】—— gotoAndWait 默认"同视图零导航复用",
    //    S6 若复用 S3 留下的旧列表状态, 搜索框/列表状态不对 → 搜索失败。传 reload:true 强制刷新。
    await ctx.gotoAndWait(CONST.DOUYIN_BASE + sub, { timeout: 25, reload: !!opts.reload });
    await injectSixPack();
    // B26+: 隐藏/最小化窗口渲染冻结守卫 — 检测body异常小则尝试激活BitBrowser窗口, 仍冻结则明确报错
    for (let v = 0; v < 3; v++) {
      const h = await ctx.js(`(() => { const rc = document.querySelector('.parent-route-container'); return rc ? rc.scrollHeight : 0; })()`);
      if (h > 1000) return;
      // ⛔ 2026-09-22：ego 下**不做窗口置前**（`setWindowBounds` 可能把 OS 窗口提到前台 → 抢用户焦点，
      //    用户实证「我一直想在这里给你打字就是会被干扰」）。冻结守卫在 ego 下退化为"只检测、不救"。
      if (!EGO.inEgo()) {
        try { const w = await ctx.cdp('Browser.getWindowForTarget', {}); await ctx.cdp('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } }); } catch (e) {}
      }
      // ⚠️ 2026-09-22（ego 变体）：这条 osascript 是**比特专用**（pid 来自比特 localAPI 54345）。
      //    ego 下 API 不存在 → 空转；但本机若恰好有比特在跑，就可能去提"别人的窗口"。
      //    第一原则是**不打扰**（用户：「我用 ego 就是因为你操作时我能用电脑」）⇒ ego 下不执行。
      if (!EGO.inEgo()) {
        try {
          const pid = await fetchJ('http://127.0.0.1:54345/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: envId }) }).then(j => j.data && j.data.pid);
          if (pid) require('child_process').execSync(`osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true'`, { timeout: 5000 });
        } catch (e) {}
      }
      await ctx.cdp('Page.bringToFront', {}).catch(() => {});
      await sleep(2500);
    }
    const hf = await ctx.js(`(() => { const rc = document.querySelector('.parent-route-container'); return rc ? rc.scrollHeight : 0; })()`);
    if (hf <= 1000) throw new Error('抖音页面加载异常(路由容器空), 请刷新该环境窗口后重试');
  };

  // 消除干扰弹窗,最多5轮
  const dismissModals = async () => {
    for (let k = 0; k < 5; k++) {
      const hit = await ctx.js(String.raw`(() => {
        const ms = [...document.querySelectorAll('[class*="modal"],[class*="dialog"],[role="dialog"]')]
          .filter(e => e.offsetParent && e.getBoundingClientRect().width > 100 && (!e.innerText || /发现新机会|推荐|机会|知道了|我知道了|关闭|提示|问卷|调研/.test(e.innerText)));
        for (const m of ms) {
          const btns = [...m.querySelectorAll('button,span,div')].filter(b => b.offsetParent &&
            (/^[×✕Xx]$/.test((b.innerText||'').trim()) || /知道了|我知道了|关闭|取消|不再提示/.test((b.innerText||'').trim())));
          if (btns.length) { const r = btns[0].getBoundingClientRect(); if (r.width > 0) return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; }
          const ec = m.querySelector('[class*="close"]');
          if (ec && ec.offsetParent) { const r = ec.getBoundingClientRect(); if (r.width > 0) return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; }
        }
        return null;
      })()`);
      if (!hit) return;
      await cdpClick(hit.x, hit.y, 300);
      await ctx.wait(1);
    }
  };

  // ---------- 千川列表 ----------
  const planRow = async (planId) => {
    const expr = String.raw`(() => {
      const tr = [...document.querySelectorAll('tr')].find(t => t.offsetParent && (t.innerText||'').includes(${JSON.stringify(planId)}));
      if (!tr) return null;
      const txt = tr.innerText;
      return {
        id: (txt.match(/ID[：:]\s*(\d{15,20})/)||[])[1]||null,
        name: (txt.match(/[^\n]*保[0-9.]+/)||[])[0]||null, // 兼容 2026-开头 与 补_补_ 等新命名
        roi: (txt.match(/ROI目标\s*([\d.]+)/)||[])[1]||null,
        budget: (txt.match(/(?:每日预算|日预算)\s*(\d+)/)||[])[1]||null,
        mode: txt.includes('控成本投放') ? '控成本' : (txt.includes('放量投放') ? '放量' : '?'),
        status: (txt.match(/投放中|已结束|审核中|暂停|已删除|不存在/)||[])[0]||null,
        net: txt.includes('净成交'),
        raw: txt.replace(/\n+/g,'|').slice(0,200)
      };
    })()`;
    return waitFor(expr, { timeout: 20000 });
  };

  /**
   * 授权相关弹窗收尾（2026-09-14 用户截图确认，只点"关闭"类）
   *   ①「全域投放使用授权申请已发送 …」→ 点【我知道了】（申请成功后必现，不点会挡住创建页）
   *   ②「恭喜您！商品投放权限通过啦 …【创建商品全域计划】」浮层 → 只点右上 ×
   *      ⚠️ **绝不点【创建商品全域计划】**（那是新建计划入口，会干扰 S4）
   */
  const dismissAuthModals = async () => {
    for (let k = 0; k < 4; k++) {
      const hit = await ctx.js(`(() => {
        const vis = (e) => e.offsetParent && e.getBoundingClientRect().width > 0;
        const ok = [...document.querySelectorAll('button,span,div,a')].filter(e => vis(e) && (e.innerText || '').trim() === '我知道了');
        if (ok.length) { const r = ok[ok.length - 1].getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), what: '我知道了' }; }
        const cards = [...document.querySelectorAll('div')].filter(e => vis(e) && /创建商品全域计划/.test(e.innerText || '') && (e.innerText || '').length < 140);
        if (cards.length) {
          const c = cards[0];
          const x = [...c.querySelectorAll('*')].find(e => vis(e) && /^[×✕xX]$/.test((e.innerText || '').trim()));
          if (x) { const r = x.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), what: '恭喜浮层×' }; }
          // ⛔ 原来这里有个"点浮层右上角"的坐标兜底 —— 那个位置正好压着页面右下角的「智投星」悬浮球，
          //    会误点它(用户 2026-09-14 截图指出)。找不到明确 × 就不点，交给后面的 createPlan 入口再收一次。
          return null;
        }
        return null;
      })()`);
      if (!hit) return;
      await cdpClick(hit.x, hit.y, 300);
      console.log('  [授权弹窗] 已关闭: ' + hit.what);
      await ctx.wait(0.8);
    }
  };

  /**
   * 暂停计划的「失去权限」判据（2026-09-14 实测，只读）
   *   ① 行状态含 暂停、原因含 系统暂停
   *   ② hover 那个 ⓘ —— 它的锚点是 `div.oc-promotion-status-card-wrapper-desc-suffix`（**0×0**，
   *      坐标就是图标位置，别按尺寸找）→ 浮层文案进 DOM → 含「失去…商品全域投放权限」即命中。
   *   ⚠️ 不要 hover 状态单元格中心：单元格 69×40，中心正好落在两行文字的缝里，读不到提示。
   */
  const pausedAuthInfo = async (planId) => {
    const base = await ctx.js(String.raw`(() => {
      const tr = [...document.querySelectorAll('tr')].find(t => t.offsetParent && (t.innerText || '').includes(${JSON.stringify(planId)}));
      if (!tr) return null;
      const t = tr.innerText || '';
      const cls = (e) => String((e.className && e.className.baseVal !== undefined) ? e.className.baseVal : (e.className || ''));
      const cell = [...tr.querySelectorAll('div')].find(e => /ad-status/.test(cls(e)));
      const anchor = cell && [...cell.querySelectorAll('div')].find(e => /oc-promotion-status-card-wrapper-desc-suffix/.test(cls(e)));
      const r = anchor ? anchor.getBoundingClientRect() : null;
      return { status: (t.match(/投放中|已结束|审核中|已暂停|系统暂停|暂停|已删除|不存在/) || [])[0] || null,
               原因: (t.match(/已暂停[\s|]*([^\n|]{2,12})/) || [])[1] || null,
               有图标锚点: !!anchor, 锚点: r ? { x: Math.round(r.x), y: Math.round(r.y) } : null };
    })()`);
    if (!base) return null;
    if (!base.有图标锚点 || !base.锚点) return Object.assign(base, { tip: null, lostAuth: false });
    // ⚠️ 实测两个必要动作(缺一就读不到提示)：
    //   ① 先把鼠标**移到别处**再移过去 —— 指针已在原地时 mouseMoved 不产生新的 hover 事件
    //   ② 锚点可能不在视口内(0×0 元素) → 先 scrollIntoView 到屏幕中间再取坐标
    let tip = null;
    for (let att = 0; att < 2 && !tip; att++) {
      try {
        await ctx.js(String.raw`(() => { const tr = [...document.querySelectorAll('tr')].find(t => t.offsetParent && (t.innerText || '').includes(${JSON.stringify(planId)})); if (!tr) return null; const cls = (e) => String((e.className && e.className.baseVal !== undefined) ? e.className.baseVal : (e.className || '')); const cell = [...tr.querySelectorAll('div')].find(e => /ad-status/.test(cls(e))); const a = cell && [...cell.querySelectorAll('div')].find(e => /oc-promotion-status-card-wrapper-desc-suffix/.test(cls(e))); if (a) a.scrollIntoView({ block: 'center' }); return true; })()`);
        await ctx.wait(0.3);
        const p = await ctx.js(String.raw`(() => { const tr = [...document.querySelectorAll('tr')].find(t => t.offsetParent && (t.innerText || '').includes(${JSON.stringify(planId)})); if (!tr) return null; const cls = (e) => String((e.className && e.className.baseVal !== undefined) ? e.className.baseVal : (e.className || '')); const cell = [...tr.querySelectorAll('div')].find(e => /ad-status/.test(cls(e))); const a = cell && [...cell.querySelectorAll('div')].find(e => /oc-promotion-status-card-wrapper-desc-suffix/.test(cls(e))); if (!a) return null; const r = a.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), 视口内: r.y > 0 && r.y < window.innerHeight }; })()`);
        if (!p || !p.视口内) continue;
        await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 8, y: 8 });
        await ctx.wait(0.25);
        await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
        await ctx.wait(1.4);
        tip = await ctx.js(`(() => { const t = [...document.querySelectorAll('*')].filter(x => x.offsetParent && /失去.*权限|重新获取权限/.test(x.innerText || '')); return t.length ? (t[t.length-1].innerText || '').replace(/\\s+/g, ' ').slice(0, 140) : null; })()`);
        if (!tip) { base.锚点 = p; }
      } catch (e) {}
    }
    try { await ctx.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 }); } catch (e) {}
    await ctx.wait(0.3);
    return Object.assign(base, { tip, lostAuth: !!(tip && /失去.*权限|重新获取权限/.test(tip)) });
  };

  /** 清掉计划列表上残留的「搜索/筛选」条件
   *
   *  ⚠️ 2026-09-21 实盘（用户：「现在重建出问题了」）：S1/S2 定位**旧计划**时把条件填进了列表搜索框，
   *    S4 发布后如果页面没换（日志 `REUSE_SAME_PAGE 已在目标页`），列表**仍被旧计划ID过滤** →
   *    S5 在第一行找不到新建计划 → `新计划ID未找到`（导航 15s + 读 20s 全白等）。
   *    证据：失败 dump 的 URL 里带 `"sd":{"option":"1","value":"3000000000000000106"}`（= 旧计划ID）。
   *    清法与选品车搜索框同一套口径：原生 setter 置空 + input/change + **JS 合成回车**（后台标签上
   *    CDP 的 insertText/回车都不落地，见 SOP 坑表 #24）。 */
  const clearPlanListFilter = async () => {
    const findExpr = `[...document.querySelectorAll('input')].filter(i => i.offsetParent && /输入计划名称|计划名称|请输入计划/.test(i.placeholder || ''))[0] || null`;
    try {
      const cur = await ctx.js(`(() => { const i = ${findExpr}; return i ? i.value : null; })()`);
      if (cur === null) return false;                 // 列表没渲染/没有搜索框 → 不动
      if (cur === '') return true;                    // 本来就干净
      await ctx.js(`(() => {
        const i = ${findExpr};
        if (!i) return false;
        i.focus();
        const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        s.call(i, '');
        i.dispatchEvent(new Event('input', { bubbles: true }));
        i.dispatchEvent(new Event('change', { bubbles: true }));
        for (const t of ['keydown', 'keypress', 'keyup'])
          i.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        return true;
      })()`);
      console.log(JSON.stringify({ stage: 'LIST_FILTER_CLEARED', ok: true, 原过滤值: String(cur).slice(0, 40), 说明: '列表被上次搜索条件挡着 → 已清空，否则读不到刚建的计划' }));
      await ctx.wait(1.5);
      return true;
    } catch (e) { return false; }
  };

  const findNewPlanId = async (suffix) => {
    // 🔥 修复: 同名计划(5%/10%佣金都叫 _X%保Y)很多, 按 suffix 搜会撞错。新建的必在列表最上面(发布成功返回列表, 新→旧)。
    //    ⚠️ 不要 gotoQianchuan(wide) 重刷 (会把发布成功后的"新计划在最上"即时状态冲掉/或列表重新排序) → 直接在当前页取第一行含suffix的。
    //    ⚠️ 2026-09-21：但**先清掉残留过滤**（见 clearPlanListFilter 的注释），否则"当前页"根本不含新建计划。
    const suf = suffix.replace(/\s+/g, '');
    const expr = String.raw`(() => {
      const ts = [...document.querySelectorAll('tr')].filter(t => t.offsetParent && (t.innerText||'').replace(/\s+/g,'').includes(${JSON.stringify(suf)}));
      if (!ts.length) return null;
      const t = ts[0]; // 新建在最上: 第一行 = 刚建的
      const m = t.innerText.match(/ID[：:]\s*(\d{15,20})/);
      return m ? m[1] : null;
    })()`;
    await clearPlanListFilter();
    // ⭐ 2026-10-01 修 #23（用户：「**把品3 跑完啊**」✓ 顺着查出这条 ✗）：
    //   原来**当前页等 15s** ✗ + 回退宽列表**等 20s** ✗ ⇒ 约 50s 就判 `新计划ID未找到` ✗，
    //   而实盘那次 `S4建计划 ok:true` ✓ 计划名都在 ✓（终检 8/8 全过 ✓）—— **计划明明建成了** ✗
    //   ⇒ 纯粹是**平台列表刷得慢**（新建计划是异步进列表的 ✓）。
    //   ⇒ 现在：① 两段等待都放宽（45s / 60s ✓）；② 每段都打一行判据
    //      （`S5_等列表 阶段:当前页|宽列表 等秒:N 找到:true|false` ✓）⇒ 以后一眼分清"等多久、在哪等、等到没" ✓；
    //      ③ 仍保留原来的回退顺序（当前页 → **真重载**宽日期列表 ✓ —— 那条同时防"列表被缓存/被旧过滤挡着" ✗，
    //      与 2026-10-01 的 #24「权限提示被页面缓存」是同一族教训 ✓）。
    const t0 = Date.now();
    const id = await waitFor(expr, { timeout: 45000 });
    console.log(JSON.stringify({ stage: 'S5_等列表', 阶段: '当前页', 等秒: Math.round((Date.now() - t0) / 1000), 找到: !!id }));
    if (id) { tmark('读新计划ID'); return id; }
    // 当前页没找到(可能停在创建页/被过滤)→ 才回退宽日期列表（**强制真重载**，别复用带状态的脏页）
    await gotoQianchuan({ wide: true, reload: true });
    await clearPlanListFilter();
    const t1 = Date.now();
    const id2 = await waitFor(expr, { timeout: 60000 });
    console.log(JSON.stringify({ stage: 'S5_等列表', 阶段: '宽列表(已真重载)', 等秒: Math.round((Date.now() - t1) / 1000), 找到: !!id2,
      提示: id2 ? '新计划已在列表 ✓' : '两段共等了约 105s 仍没出现 ✗ —— 可按仓库自带姿势续跑：bit-qc-new.js --file <清单> --resume <商品ID> --account <号> --go ✓（断点幂等，不会重复建计划 ✓）' }));
    tmark('读新计划ID');
    return id2;
  };

  // 坑17: 搜索框先聚焦再填再回车; 坑12: 清空再输(整值替换天然清了)
  const searchPlanById = async (planId) => {
    // 🔧 2026-09-14 用户实测指出: 上一条跑完常把千川页停在「计划详情/素材抽屉」态(URL 带 adId=)，
    //    下一条 gotoQianchuan 会判定"已在目标页"→ 零导航复用 → **列表搜索框根本不在** → 报「搜索后未命中」。
    //    所以搜索前先确保处于列表态: 关抽屉 → 如果还是详情态/没有搜索框, 就**强制重载**列表页。
    try { await closeDrawer(); } catch (e) {}
    try {
      let st = await ctx.js(`(() => { const u = location.href;
        const box = [...document.querySelectorAll('input')].some(i => i.offsetParent && (i.placeholder||'').indexOf('输入计划名称') >= 0);
        return { detail: /[?&]adId=\\d+/.test(u), box }; })()`);
      // ⏱ 2026-09-22（用户：「导航闸不要设置这么久可以吗？」）：**刚导航过来时 SPA 还没渲染出搜索框**，
      //    旧逻辑立刻判成"不在列表态"→ `reload:true` 强制重载 → 撞上自己刚记下的那次导航 → 白等一整个闸窗口
      //    （实测 S1 因此花掉 154s）。⇒ 先给搜索框最多 8s 渲染时间，**只有真的不在列表页/详情态**才重载。
      for (let i = 0; i < 8 && st && !st.box && !st.detail; i++) {
        await ctx.wait(1);
        st = await ctx.js(`(() => { const u = location.href;
          const box = [...document.querySelectorAll('input')].some(i => i.offsetParent && (i.placeholder||'').indexOf('输入计划名称') >= 0);
          return { detail: /[?&]adId=\\d+/.test(u), box }; })()`);
      }
      if (st && (st.detail || !st.box)) {
        console.log(JSON.stringify({ stage: 'LIST_RELOAD', ok: true, 说明: '页面不在计划列表态(详情/抽屉残留) → 强制重载列表页', 详情态: st.detail, 有搜索框: st.box }));
        await gotoQianchuan({ wide: true, reload: true });
        await ctx.wait(1.2);
      } else if (st && st.box) {
        console.log(JSON.stringify({ stage: 'LIST_READY', ok: true, 说明: '列表态就绪（搜索框在）→ 不重载，省掉一次导航闸等待' }));
      }
    } catch (e) {}
    let lastErr = '搜索框未找到';
    for (let attempt = 0; attempt < 3; attempt++) {
      await dismissModals();
      const box = await waitFor(`(() => {
        const i = [...document.querySelectorAll('input')].find(x => x.offsetParent && (x.placeholder||'').indexOf('输入计划名称') >= 0);
        if (!i) return null;
        i.scrollIntoView({ block: 'center' });
        const r = i.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      })()`, { timeout: 8000 });
      if (!box) { lastErr = '搜索框未找到'; continue; }
      // ⚠️⚠️ 2026-10-02（用户报「**我在飞书重建一直失败**」—— 当天 **5 次**飞书重建**全部**死在 S1 这一步，
      //   err 清一色 `搜索后未命中(疑似弹窗/分页): <planId>`，而**同一条计划 1 分钟前的监控快照里还在**
      //   (`monitor/snap-*.json`) ⇒ **计划是活的，是我们读不到** ✗）：
      //   病根 = "写值/提交"两步都在**赌焦点**：原来是「**坐标点击**搜索框 → JS 原生 setter 写值 → pressKey('Enter')」✗
      //     · 坐标点击在 ego 上经常**不落地**（canon #48/#71 同族："点一下让 X 出现"的步骤一律**原生优先** ✗）
      //     · 没聚焦 ⇒ `keyboard.press('Enter')` 发给**没人接的元素** ⇒ **搜索根本没提交** ⇒
      //       看到的是未过滤列表第 1 页 ⇒ 当然没有目标行 ⇒ 被判成"计划不存在" ✗✗
      //   这正是 canon **#24**（后台标签 CDP 打字/回车不落地 ⇒ 搜索框假成功 ⇒ 把"在"报成"不在"）
      //   ＋ canon **#21 反面**（判"没有"之前，必须先证明"**我的查询真的生效了**"）。
      //   ⇒ 按 skill《ego 相对 CDP 的优势》那两行改：**`page.fill()`（会校验值真的进去 ✓）** +
      //     **`page.press(sel,'Enter')`（自带 actionability：先聚焦再按 ✓）**；
      //     原生件失败才回退老路径（保证不比以前差）；**每一步都读回**，并把方式写进日志
      //     （AGENTS.md：关键判据要有"机械兜底"——`写入方式`/`提交方式` 就是这条 ✓）。
      const 搜索框选择器 = 'input[placeholder*="输入计划名称"]';
      const 读回值 = () => ctx.js(`(() => { const i = [...document.querySelectorAll('input')].find(x => x.offsetParent && (x.placeholder||'').indexOf('输入计划名称') >= 0); return i ? String(i.value||'') : null; })()`);
      let 写入方式 = 'native-fill(fallback可用)', 提交方式 = 'native-press(fallback可用)', wrote = null;
      if (typeof ctx.egoFill === 'function') {
        try { await ctx.egoFill(搜索框选择器, planId, { timeout: 8000 }); 写入方式 = 'native-fill'; }
        catch (e) { 写入方式 = 'native-fill失败:' + String((e && e.message) || e).slice(0, 40); }
      } else 写入方式 = 'no-egoFill';
      wrote = await 读回值();
      if (wrote !== planId) {
        // 回退老路径（坐标点击 + 原生 setter）—— 它有时也能成，只是不可靠
        await cdpClick(box.x, box.y);
        await ctx.wait(0.9);
        await ctx.js(String.raw`(() => {
          const i = [...document.querySelectorAll('input')].find(x => x.offsetParent && (x.placeholder||'').indexOf('输入计划名称') >= 0);
          if (!i) return null;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(i, ${JSON.stringify(planId)});
          i.dispatchEvent(new Event('input', { bubbles: true }));
          i.dispatchEvent(new Event('change', { bubbles: true }));
          return i.value;
        })()`);
        wrote = await 读回值();
        写入方式 += ' ⇒ setter回退';
      }
      // 🚨 canon #24：**只写不读回 = 假成功** —— 值没进去就别去搜（搜了也是搜空气，还会误报"计划不存在"✗）
      if (wrote !== planId) {
        lastErr = '计划名搜索框写入未生效(读到: ' + JSON.stringify(wrote) + ') ⇒ 不搜索，避免误判"计划不存在"';
        console.log(JSON.stringify({ stage: 'S1搜索写入未生效', ok: false, planId, 读到: wrote, 写入方式,
          说明: '搜索框没接收到值（ego 上坐标点击常不落地）⇒ **不搜**：否则会拿未过滤列表第 1 页当证据，误报"计划不存在" ✗' }));
        continue;
      }
      let 已提交 = false;
      if (typeof ctx.egoPress === 'function') {
        try { await ctx.egoPress(搜索框选择器, 'Enter', { timeout: 8000 }); 提交方式 = 'native-press'; 已提交 = true; }
        catch (e) { 提交方式 = 'native-press失败:' + String((e && e.message) || e).slice(0, 40); }
      } else 提交方式 = 'no-egoPress';
      if (!已提交) { await ctx.pressKey('Enter'); 提交方式 += ' ⇒ pressKey回退'; }
      console.log(JSON.stringify({ stage: 'S1搜索提交', ok: true, planId, 写入方式, 提交方式,
        说明: '写入/提交都读回确认过（canon #24）—— 若仍"未命中"，先看这两列，别急着说"计划不存在" ✗' }));
      await ctx.wait(2);
      const row = await waitFor(String.raw`(() => {
        const tr = [...document.querySelectorAll('tr')].find(t => t.offsetParent && (t.innerText||'').includes(${JSON.stringify(planId)}));
        if (!tr) return null;
        const txt = tr.innerText;
        return {
          id: (txt.match(/ID[：:]\s*(\d{15,20})/)||[])[1]||null,
        name: (txt.match(/[^\n]*保[0-9.]+/)||[])[0]||null, // 兼容 2026-开头 与 补_补_ 等新命名
          roi: (txt.match(/ROI目标\s*([\d.]+)/)||[])[1]||null,
          budget: (txt.match(/(?:每日预算|日预算)\s*(\d+)/)||[])[1]||null,
          mode: txt.includes('控成本投放') ? '控成本' : (txt.includes('放量投放') ? '放量' : '?'),
          status: (txt.match(/投放中|已结束|审核中|暂停|已删除|不存在/)||[])[0]||null,
          net: txt.includes('净成交')
        };
      })()`, { timeout: 10000 });
      if (row) { tmark('搜索计划行'); return row; }
      // 🚦 2026-10-26（实盘 r1792972763933 / plan 3000000000000000107）：「未命中」必须分成两类 ——
      //    **读不到** vs **真的不存在**。混在一起会两头顶牛：
      //      S2 删成功了、判据误报失败 ⇒ 断点没记 S2 ⇒ 续跑重搜 ⇒ 又报「旧计划行未找到」
      //      ⇒ 卡死在「旧计划已删 + 新计划未建」的红线（canon #21 的另一半）
      //    判「真的不存在」只认三件事**同时**成立（交叉判据，单判据不算 —— canon #71 的教训 ✓）：
      //      ① 搜索框里**确实**是我的 planId（= 过滤条件生效；否则就是老那个"未过滤第 1 页"的假阴性 ✗）
      //      ② 视口内**一条带 ID 的数据行都没有**（0 行 ⇒ 不可能是未过滤页的 10 行）
      //      ③ 页面上没有弹窗/遮罩（有弹窗时列表可能是"假空" ✗）
      //    ⚠️ 还要**连续两轮**都这样才认（第三轮才抛）—— 误判"不存在"会让旧计划留着 + 新建计划 = 双投（真花钱）✗
      const 空列表 = await ctx.js(String.raw`(() => {
        const i = [...document.querySelectorAll('input')].find(x => x.offsetParent && (x.placeholder||'').indexOf('输入计划名称') >= 0);
        const 值 = i ? String(i.value || '') : null;
        const 数据行 = [...document.querySelectorAll('tr')].filter(t => t.offsetParent && /ID[：:]\s*\d{10,}/.test(t.innerText || '')).length;
        // ⚠️ 2026-10-26 实盘教训（probe-s2-emptylist.js 打出来的）：老判据"任何 modal/dialog 元素"**永远是 true** ✗
        //    千川列表页常驻一个 qc-newcomer-reprot-modal（空壳、height 0）⇒ 条件③ 恒假 ⇒ 判据永远不成立
        //    ⇒ 退回「搜索后未命中(疑似弹窗/分页)」⇒ 明明删掉了却报失败（canon #21 的另一半：证据要真能成立）
        //    现在只认**看得见、有尺寸、且带可操作按钮**的对话框 ✓
        const 对话框 = [...document.querySelectorAll('[class*="modal"],[class*="dialog"],[role="dialog"]')]
          .filter(x => {
            if (!x.offsetParent) return false;
            const r = x.getBoundingClientRect();
            if (!(r.width > 120 && r.height > 120)) return false;          // 空壳/占位容器不算 ✓
            return /确定|确认|删除|申请|取消/.test(x.innerText || '');       // 没有按钮 = 不是要我处理的东西 ✓
          });
        const 弹窗 = 对话框.length > 0;
        const 弹窗词 = 弹窗 ? (对话框[0].innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) : null;
        return { 值, 数据行, 弹窗, 弹窗词 };
      })()`);
      const 查询生效且空 = !!(空列表 && 空列表.值 === planId && 空列表.数据行 === 0 && !空列表.弹窗);
      // 📎 每次未命中都把三个分量打出来（2026-10-26：判据恒假却只报"疑似弹窗/分页"，白查半小时 ✗）
      console.log(JSON.stringify({ stage: 'S1未命中取证', ok: false, planId, attempt, 空列表,
        说明: '"值/数据行/弹窗"三件必须同时成立才判"不存在"；哪一件不成立看这一行 ✓（canon #21）' }));
      if (查询生效且空 && attempt >= 1) {
        console.log(JSON.stringify({ stage: 'S1查询生效但无此计划', ok: false, planId, 证据: 空列表,
          说明: '过滤条件已生效（框里就是该 ID）且列表 0 行、无弹窗 ⇒ 判"计划不存在"，不是"读不到" ✓' }));
        const e = new Error('计划不存在(过滤已生效且列表 0 行): ' + planId);
        e.absent = true; e.证据 = 空列表;
        throw e;
      }
      if (查询生效且空) console.log(JSON.stringify({ stage: 'S1未命中但查询生效', ok: false, planId, 证据: 空列表,
        说明: '本轮先按"可能读不到"再试一次（宁可多等 12s，也不误判"不存在" ⇒ 防双投）' }));
      lastErr = '搜索后未命中(疑似弹窗/分页): ' + planId;
    }
    throw new Error(lastErr);
  };

  // 安全红线: 删除前核对行内ID+名称后缀
  const deletePlan = async (planId, mustSuffix = null) => {
    // 省时: 上一阶段刚在宽日期列表搜索过 → 免整页刷新, 关掉残留抽屉即可; 不在列表才刷新
    const onList = await ctx.js(`(() => location.href.indexOf('uni-prom') >= 0 && document.querySelectorAll('tr').length > 0)()`);
    if (onList) { await closeDrawer(); try { await ctx.cdp('Page.bringToFront', {}); } catch (e) {} }
    else await gotoQianchuan({ wide: true }); // 旧计划可能不在当天列表(如08-29), 必须宽日期
    await dismissModals();
    let row = null;
    try { row = await searchPlanById(planId); }
    catch (e) {
      // 🚦 2026-10-26：旧计划**本来就不在了** = 删除目标已达成，别当故障 ✗
      //    典型现场：上一轮删成功了、判据却误报「删除后行仍在」⇒ 断点里没有 S2 ⇒ 续跑重搜 ⇒
      //    `旧计划行未找到` ⇒ 整条重建死在「旧计划已删 + 新计划未建」的红线（canon #21 的另一半）。
      if (e && e.absent) {
        console.log(JSON.stringify({ stage: 'S2旧计划已不存在', ok: true, planId, 证据: e.证据 || null,
          说明: '过滤已生效且列表 0 行（不是"读不到"）⇒ 删除目标已达成，按"已删除"继续；否则续跑永远卡在 S2 ✓' }));
        return { ok: true, alreadyGone: true, name: null, toast: false };
      }
      throw e;
    }
    if (!row) throw new Error('旧计划行未找到: ' + planId);
    if (mustSuffix && !((row.name || '').replace(/％/g, '%').replace(/\s+/g, '')).includes(mustSuffix.replace(/％/g, '%').replace(/\s+/g, ''))) {
      throw new Error('安全红线: 后缀=' + JSON.stringify(mustSuffix) + ' 行名=' + JSON.stringify((row.name || '').slice(0, 60)));
    }
    const more = await waitFor(String.raw`(() => {
      const tr = [...document.querySelectorAll('tr')].find(x => x.offsetParent && (x.innerText||'').includes(${JSON.stringify(planId)}));
      if (!tr) return null;
      const e = [...tr.querySelectorAll('span,div,a')].find(x => (x.innerText||'').trim() === '更多');
      if (!e) return null;
      e.scrollIntoView({ block: 'center' });
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`, { timeout: 10000 });
    if (!more) throw new Error('行内"更多"未找到');
    await cdpClick(more.x, more.y);
    const del = await waitFor(String.raw`(() => {
      const els = [...document.querySelectorAll('li,span,div,[class*="item"],[class*="option"]')]
        .filter(e => e.offsetParent && (e.innerText||'').trim() === '删除' && e.getBoundingClientRect().y > 100);
      if (!els.length) return null;
      const e = els[els.length - 1];
      const r = e.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`, { timeout: 8000 });
    if (!del) throw new Error('下拉菜单"删除"未找到');
    await cdpClick(del.x, del.y);
    const ok = await waitFor(String.raw`(() => {
      const m = [...document.querySelectorAll('[class*="modal"],[class*="dialog"],[role="dialog"]')]
        .find(e => e.offsetParent && (e.innerText||'').includes('确定要删除该计划吗') &&
          [...e.querySelectorAll('button')].some(b => b.innerText.trim() === '确认'));
      if (!m) return null;
      const b = [...m.querySelectorAll('button')].find(b => b.innerText.trim() === '确认');
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`, { timeout: 8000 });
    if (!ok) throw new Error('删除确认弹窗未找到');
    await cdpClick(ok.x, ok.y);
    // 🚦 2026-10-26（实盘 r1792972763933 / plan 3000000000000000107）：**删除其实成功了，是判据误报** ✗
    //    现象：`S2删旧 ms:20555 err:"删除后行仍在"` —— 历史 113 次里唯一一次；
    //    事后只读探针（`fp-matrix/bridge/ego/probe-s2-delete.js`）复核：该 planId 过滤后**列表 0 行**，
    //    同号别的计划（3000000000000000108）能正常搜到 ⇒ 计划真的没了，只是**虚拟表格的行没在 12s 内重排掉**。
    //    代价极大（断点不记 S2 ⇒ 续跑卡死在"旧计划已删+新计划未建"）。
    //    ⇒ 不再拿"单次 DOM 里还有那行"当唯一证据（canon #71 的教训：判据要交叉 + 读回）：
    //      ① 正向证据：确认后出现 `删除成功/操作成功` toast（8s）
    //      ② 行消失（原位，15s）
    //      ③ 还在 ⇒ **重新提交一次搜索**（虚拟表格重排可能滞后；重搜 ~2s，不动导航闸）再判 10s
    //      ④ 仍不消失 **且** 没有任何删除成功证据 ⇒ 才算"真没删掉"（附现场：弹窗/拒绝话术）
    const goneJS = String.raw`(() => ![...document.querySelectorAll('tr')].some(t => t.offsetParent && (t.innerText||'').includes(${JSON.stringify(planId)})))()`;
    const toastOk = await waitFor(`(() => /删除成功|操作成功/.test(document.body.innerText) ? true : null)()`, { timeout: 8000, 标签: '删除成功 toast' });
    let gone = await waitFor(goneJS, { timeout: 15000, 标签: '删除后行消失' });
    let 复核方式 = '原位';
    if (!gone) {
      try {
        if (typeof ctx.egoPress === 'function') await ctx.egoPress('input[placeholder*="输入计划名称"]', 'Enter', { timeout: 6000 });
        else await ctx.pressKey('Enter');
        复核方式 = '重搜';
        await ctx.wait(2);
      } catch (e) { 复核方式 = '重搜失败:' + String((e && e.message) || e).slice(0, 40); }
      gone = await waitFor(goneJS, { timeout: 10000, 标签: '删除后行消失(重搜复核)' });
    }
    const 现场 = await ctx.js(String.raw`(() => {
      const txt = document.body.innerText || '';
      return { 删除成功: /删除成功|操作成功/.test(txt),
        拒绝话术: (txt.match(/[^\n]*(?:不可删除|无法删除|不能删除|请先暂停|删除失败)[^\n]*/g) || []).slice(0, 3),
        弹窗: [...document.querySelectorAll('[class*="modal"],[class*="dialog"],[role="dialog"]')]
          .filter(e => e.offsetParent).map(e => (e.className || '') + ' | ' + (e.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60)).slice(0, 3) };
    })()`);
    if (!gone && !(现场 && 现场.删除成功) && !toastOk) {
      throw new Error('删除后行仍在(原位 15s + 重搜 10s 都不见行消失，且无删除成功文案) ' + JSON.stringify(现场 || {}));
    }
    if (!gone) console.log(JSON.stringify({ stage: 'S2行残留但已删', ok: true, planId, 复核方式, 现场,
      说明: '有删除成功证据 ⇒ 按已删除继续；虚拟表格重排滞后，别拿单次 DOM 当"没删掉" ✗（2026-10-26 就是这么误报的）' }));
    const toast = !!(await ctx.js(`/删除成功|操作成功/.test(document.body.innerText)`));
    tmark('删除计划');
    return { ok: true, name: row.name, toast, 复核方式, ...(gone ? {} : { 行残留: true }) };
  };

  // ---------- 抖音侧(在抖音环境 ctx 中执行) ----------
  // 坑4/坑15: 两段确认/卡片滚动; 坑14: 不可投=私密标志
  // 2026新版抖音web: 作品页有「作品|私密作品|合集|短剧」子tab(位于批量工具栏下方 y~260),
  // 私密视频在「私密作品」子tab下; 先切tab再进批量管理(旧版无子tab,直接兼容跳过)

  // 动态识别码解析: <该号前缀>0x / <该号前缀>(日期)0x; 带"-01"后缀=卡bug失败号, 排除;
  //   前缀**按抖音号走**（号A demoA / 号B demoB / …），见 frag-code.js；写死 demoA 会让别的号全链路失效
  // 取最新(列表顶部优先), 返回 {frag 精确码, itemid 视频ID, list 所在列表}; 私密列表优先
  const resolveSbmguoVideo = async () => {
    const seen = new Map();
    const scan = async () => ctx.js(`(() => {
      const out = [];
      for (const e of document.querySelectorAll('li,div,a')) {
        if (!e.offsetParent) continue;
        const t = (e.innerText||'');
        if (!new RegExp(${JSON.stringify(FRAG_HEAD_RE)}, 'i').test(t) || t.length > 120) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 150 || r.width > 450) continue;
        const a = e.tagName === 'A' ? e : e.querySelector('a[href*="/video/"]');
        const vid = a ? ((a.getAttribute('href')||'').match(/\\/video\\/(\\d+)/)||[])[1] : null;
        if (!vid) continue;
        const m = t.match(new RegExp(${JSON.stringify(FRAG_CODE_RE)}, 'i'));
        if (m) out.push({ vid, code: m[0], title: t.replace(/[\\n|]+/g,' ').slice(0,60) });
      }
      return out;
    })()`);
    for (const which of ['priv', 'pub']) {
      await gotoDouyin(which === 'priv' ? 'private_post' : 'video');
      await ctx.js('window.scrollTo(0,0)');
      await ctx.wait(1.2);
      for (let screen = 0; screen < 6; screen++) {
        for (const c of (await scan() || [])) if (!seen.has(c.vid)) seen.set(c.vid, { ...c, list: which });
        const good = [...seen.values()].filter((c) => c.code && !/-01$/.test(c.code));
        if (good.length) return { frag: good[0].code, itemid: good[0].vid, list: which, title: good[0].title };
        await ctx.js(`(() => { const sc = document.querySelector('.parent-route-container'); if (sc) { sc.scrollTop += 900; return; } window.scrollBy(0, 900); })()`);
        await ctx.wait(1.1);
      }
    }
    return null;
  };
  // 🔥 B50 (用户 2026-09-12 发现): 抖音「作品」列表点「批量管理」后会出现搜索框, 可直接搜识别码 → 免深扫滚动。
  //   ⚠️ 只给 S6 用(作品列表); **S3 绝不用** —— 用户 2026-09-12 明确「S3 按原来的别改, 我说的是 S6」:
  //      S3 扫的是「私密作品」列表, 那里没有搜索框; 误接会打错框 → 页面渲染出识别码 → probeFrag 的
  //      "body 含识别码"判定**假命中** → S3 报「归属号列表未提取到视频ID」(历史首次)。S3 保持原深扫链。
  //   命中判定由调用方传入 hitExpr(默认 body 文本含识别码); S6 传"真卡片"表达式 → 从根上排除假命中。
  //   v3(2026-09-12): 可见性用 rect(兼容 position:fixed 工具栏, 其 offsetParent 恒 null); 匹配
  //      placeholder/aria-label/title/name; 等 6s; 找不到时 dump 候选输入框进日志。
  //   返回 true=已搜到; false=没搜索框或搜不到(此时已清空搜索框, 调用方回退原深扫链)。
  //   紧急开关: 环境变量 BIT_QC_BATCH_SEARCH=0 关掉; 现默认**开**(2026-09-12 v4: 已加 mode 门 + 真卡片判据 + 强制进批量管理)
  const douyinBatchSearch = async (fragArg, hitExpr) => {
    // ✅ 2026-09-12 晚: 默认【开】(用户在千川卡顿时明确要求"应该用搜索别往下滚")。
    //    配套已修: ①命中判据=真结果卡片(带勾选框, 排联想/下拉层); ②搜索命中后 cardReady/点击一律走【严格判据】(排 popover);
    //    ③搜索未命中会清空搜索框再回退原深扫链(不改变既有行为)。设 BIT_QC_BATCH_SEARCH=0 可临时关。
    if (process.env.BIT_QC_BATCH_SEARCH === '0') return false;
    const HIT = hitExpr || ('document.body.innerText.includes(' + JSON.stringify(fragArg) + ') ? true : null');
    const PRE = "const vis=(e)=>{const r=e.getBoundingClientRect();return r.width>20&&r.height>8&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none';};" +
      "const tagf=(e)=>((e.getAttribute('placeholder')||'')+' '+(e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')+' '+(e.getAttribute('name')||''));" +
      "const all=()=>[...document.querySelectorAll('input,textarea,[contenteditable=\"true\"]')].filter(vis);" +
      "const findBox=()=>{const a=all();" +
      // ① 精确认框: 批量管理工具栏的「搜索你发布的作品」(用户 2026-09-12 截图确认, 旁边有「日期筛选」)
      "let b=a.find(e=>/发布的作品/.test(tagf(e))); if(b) return b;" +
      // ② 兜底: 含"搜索"但**必须排除顶部全局搜索「搜索你感兴趣的内容」** ——
      //    第一版就是按 DOM 顺序取到它 → 回车触发联想面板把识别码渲染到页面上 → 假命中(S3 翻车根因)
      "b=a.find(e=>/搜索|搜/.test(tagf(e)) && !/感兴趣|全站|抖音搜索/.test(tagf(e))); return b||null;};";
    const boxCoords = () => waitFor(`(() => { ${PRE} const b = findBox(); if (!b) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`, { timeout: 4000 });
    // 🔥 正确顺序(用户 2026-09-12 纠正): 搜索在【点「批量管理」之前】执行 —— 作品列表本身就有「搜索你发布的作品」框。
    //   ⚠️ 这里【绝不主动点「批量管理」】: 旧代码在此提前点了, 而调用方随后还会再点一次 → 会把批量管理切掉。
    //   框没出现只是页面没渲染完 → 再等一小会重试即可。
    let box = await boxCoords();
    if (!box) { await ctx.wait(0.8); box = await boxCoords(); }
    if (!box) {
      let dump = null;
      try {
        dump = await ctx.js(`(() => { ${PRE} return all().map(e => ({ t: e.tagName, ty: e.type || '', ph: (e.getAttribute('placeholder') || '').slice(0, 18), aria: (e.getAttribute('aria-label') || '').slice(0, 14), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) })).slice(0, 10); })()`);
      } catch (e) {}
      console.log('  [B50] 批量管理态未找到搜索框, 候选输入框: ' + JSON.stringify(dump));
      return false;                       // 没搜索框 → 不改变任何状态, 调用方走原逻辑
    }
    const setVal = (v) => ctx.js(`(() => { ${PRE} const b = findBox(); if (!b) return null; if (b.tagName === 'INPUT' || b.tagName === 'TEXTAREA') { const d = Object.getOwnPropertyDescriptor(b.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'); d.set.call(b, ${JSON.stringify(v)}); b.dispatchEvent(new Event('input', { bubbles: true })); b.dispatchEvent(new Event('change', { bubbles: true })); } else { b.innerText = ${JSON.stringify(v)}; b.dispatchEvent(new Event('input', { bubbles: true })); } return b.value || b.innerText; })()`);
    await cdpClick(box.x, box.y);
    await ctx.wait(0.35);
    await setVal(fragArg);
    await ctx.wait(0.3);
    await ctx.pressKey('Enter');
    let hit = await waitFor(HIT, { timeout: 6000 });   // 搜索可能是防抖+接口过滤, 给 6s
    if (!hit) { await ctx.pressKey('Enter'); hit = await waitFor(HIT, { timeout: 2500 }); }  // 补一次回车(首帧未提交)
    if (hit) { tmark('批量管理搜索定位'); return true; }
    console.log('  [B50] 搜索未命中(已清空并回退深扫): ' + fragArg);
    // 搜不到 → 清空搜索框(否则列表被过滤成空, 回退滚动也白滚), 再交回原深扫链
    await setVal('');
    await ctx.pressKey('Enter');
    await ctx.wait(1);
    return false;
  };
  // 轻量探测: 识别码是否在指定列表(priv/pub) — 多直投号归属判定用(不执行任何操作)
  // 照抄ego语义: 先进批量管理(该模式下列表渲染更全), 窗口滚动到底触发加载, 按标题(识别码)匹配
  const probeFrag = async (fragArg, which, maxScrolls = 80) => {
    await gotoDouyin(which === 'priv' ? 'private_post' : 'video');
    const bm = await locateByText('批量管理', { exact: true });
    if (bm) { await cdpClick(bm.x, bm.y); await waitJ(1.0, 0.9); }   // 温和化：原固定 1.2s
    // ⛔ B50 不接 S3(用户 2026-09-12 明确: "s3 还是按照原来的, 别动 S3; 我都说了 S6"):
    //    S3 扫的是「私密作品」列表, 那里没有搜索框; 之前误接导致打错框 → 页面上渲染出识别码 →
    //    本函数的"body 含识别码"判定假命中 → S3 报「归属号列表未提取到视频ID」。S3 保持原深扫链。
    const fragExpr = 'document.body.innerText.includes(' + JSON.stringify(fragArg) + ') ? true : null';
    let found = false, stuck = 0, lastH = 0;
    for (let i = 0; i <= maxScrolls && !found; i++) {
      found = !!(await ctx.js(fragExpr));
      if (found) { console.log('  [定位] ' + fragArg + ' 命中(第' + i + '轮)'); break; }
      if (i % 5 === 0) console.log('  [定位] ' + fragArg + ' 第' + i + '轮...');
      await scrollPaneToBottom(ctx, { label: '滚到底(找识别码)' });
      await waitJ(0.9, 1.0);   // 温和化：原固定 1.2s（滚动节奏看不出规律）
      const h = await ctx.js('document.body.scrollHeight');
      if (h === lastH) { stuck++; if (stuck >= 25) { console.log('  [定位] 25轮无增长停'); break; } } else stuck = 0;
      lastH = h;
    }
    return found;
  };
  // 保本ROI → 实际ROI目标：**唯一事实源在 `roi-map.js`**（canon #22：一个判据两份实现必然分叉 ✗）
  //   2026-09-27 用户改口径：**统一 4/10**（目标 = 保本 × 0.4）；且重建时**优先用旧计划当前的 ROI 目标**
  //   （人后期在千川改过的那个 ⇒ 用 resolveRoi 判，见 createPlan 里）✓
  const { mapRoi, resolveRoi } = require('./roi-map.js');
  /** 抖音列表页可能停在「视频弹层」态（URL 带 `modal_id=`）→ 先点关闭，关不掉就强制重载回列表。
   *
   *  ⚠️ 2026-09-21 实盘（计划 3000000000000000101 的 S6 失败）：
   *    dump 里 URL = `douyin.com/user/self?modal_id=3000000000000000102&showSubTab=video`
   *    —— 页面根本不是作品列表，深扫抓到的"卡片"其实在弹层里 → 坐标 `220,317 top=VIDEO.`
   *    连点 6 次都勾不上 → `S6识别码设回私密 ok:false` → **识别码没归私密（红线）**。
   *    同一天另一次成功案例坐标是 `335,317 top=SPAN.semi-checkbox-inner-display`（真正的勾选框）。 */
  const dyCleanList = async (sub) => {
    try {
      const u = String((await ctx.js('location.href')) || '');
      if (!/[?&]modal_id=/.test(u)) return false;
      console.log(JSON.stringify({ stage: 'DY_MODAL_CLEAN', ok: true,
        说明: '抖音页停在视频弹层(modal_id=) → 回干净列表；先点关闭，关不掉就强制重载', 原URL: u.slice(0, 100) }));
      await ctx.js(`(() => { const b = document.querySelector('.semi-modal-close, [class*="closeBtn"], [aria-label="关闭"], [class*="close-icon"]'); if (b) { b.click(); return true; } return false; })()`).catch(() => {});
      // 🔥 2026-09-22（ego 原生优先）：弹层关闭按钮是 React 组件，DOM `.click()` 常常不生效 →
      //    ego 运行时里补一发 `page.click`（自带 actionability / 单匹配校验），失败再靠下面的强制重载兜底。
      if (ctx.egoClickSelector) {
        try { await ctx.egoClickSelector('.semi-modal-close, [class*="closeBtn"], [aria-label="关闭"], [class*="close-icon"]', { label: '关闭视频弹层' }); }
        catch (e) { /* 关不掉没关系，下一步强制重载 */ }
      }
      await ctx.wait(0.8);
      const u2 = String((await ctx.js('location.href')) || '');
      if (/[?&]modal_id=/.test(u2)) await gotoDouyin(sub, { reload: true });
      return true;
    } catch (e) { return false; }
  };

  const douyinSetVideoPrivacy = async (frag, mode, opts = {}) => {
    const fromTab = mode === 'public' ? 'private_post' : 'video';
    const noNav = !!opts.noNavigate; // S3: probeFrag 已导航并进批量管理, 原地操作
    // 双向列表探测(对齐ego): 整页重载→点目标tab→页面文本含识别码为判据
    // ⚠️ 识别码视频在公开网格(3000+)排位深, 虚拟滚动下不在首屏DOM——必须渐进滚动扫描
    const verifyList = async (which, { maxScrolls = 8 } = {}) => {
      const fragExpr = `document.body.innerText.includes(${JSON.stringify(frag)}) ? true : null`;
      await gotoDouyin(which === 'priv' ? 'private_post' : 'video');
      // 2026-09-21：弹层态(modal_id=)会让深扫抓错卡片 → 勾选失败 → 识别码没归私密（红线）
      await dyCleanList(which === 'priv' ? 'private_post' : 'video');
      const pos = await waitFor(`(() => {
        const t = [...document.querySelectorAll('.semi-tabs-tab')].find(e => {
          if (!e.offsetParent) return false;
          const txt = (e.innerText||'').trim();
          const r = e.getBoundingClientRect();
          if (${which === 'priv'}) return txt === '私密作品';
          return txt.split(String.fromCharCode(10))[0] === '作品' && txt.indexOf('私密') < 0 && r.y < 260;
        });
        if (!t) return null;
        t.scrollIntoView({ block: 'center' });
        const r2 = t.getBoundingClientRect();
        return { x: Math.round(r2.x + r2.width/2), y: Math.round(r2.y + r2.height/2) };
      })()`, { timeout: 10000 });
      if (!pos) return false;
      await cdpClick(pos.x, pos.y);
      let found = false;
      for (let i = 0; i <= maxScrolls && !found; i++) {
        found = !!(await ctx.js(fragExpr));
        if (!found && i < maxScrolls) {
          if (i > 0 && i % 3 === 0) console.log('  [验证] ' + which + ' 滚动扫描第' + (i + 1) + '屏...');
          await ctx.js(`(() => { const sc = document.querySelector('.parent-route-container'); if (sc) { sc.scrollTop += 900; return; } window.scrollBy(0, 900); })()`);
          await ctx.wait(1.1);
        }
      }
      return found;
    };
    // 幂等兜底: 已处于目标可见性则直接成功(断点重跑/上次弹窗已生效但验证误报的场景)
    // 探测用小扫描上限(快速判定); 注意 mode=public 时若识别码排位深, pub=false 也可能"已公开但在深处",
    // 故 public 幂等要求 priv=true 即可认定未公开(私密列表小而准)
    // ⚠️ 省时: 判定只需要私密列表(小而准), 不再预扫公开列表(省一次重载+4屏 ≈8s/次×2阶段)
    let prePub = null;
    if (opts.skipIdempotency) { console.log('  [幂等] 调用方已深扫确认, 直接执行'); }
    else {
    const prePriv = await verifyList('priv', { maxScrolls: 3 });
    if (mode === 'private' && prePriv) { console.log('  [幂等] 识别码已是私密, 跳过操作'); return { ok: true, hasPub: prePub, hasPriv: prePriv }; }
    if (mode === 'public' && !prePriv) { console.log('  [幂等] 识别码不在私密列表(已公开), 跳过操作'); return { ok: true, hasPub: prePub, hasPriv: prePriv }; }
    }
    if (!noNav) {
    // 🔥 S6(mode=private) 强制【整页刷新】: 不复用 S3 留下的旧列表状态(否则搜索框/列表状态不对, 搜索失败)
    await gotoDouyin(fromTab, { reload: mode === 'private' });
    }
    // ⚠️ 列表选择(对齐ego语义): S3(mode=public,从私密列表出发)→点「私密作品」sub-tab;
    //    S6(mode=private,视频已公开在主列表)→点第一行「作品」tab。比特下URL参数不可靠, 必须显式点击
    const wantPrivList = mode === 'public';
    // 🔥 B50 搜索判据(仅 S6): 必须是"带勾选框的真结果卡片" —— 排搜索联想/下拉弹层里的候选项(翻车元凶)
    const cardSelectableExpr = String.raw`(() => {
      const F = ${JSON.stringify(frag)};
      let best = null;
      for (const e of document.querySelectorAll('li,div')) {
        if (!(e.innerText||'').includes(F) || !e.offsetParent) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 150 || r.width > 450) continue;
        if (e.closest('[class*="popover"],[class*="dropdown"],[class*="popper"],[class*="suggest"]')) continue; // 排联想/下拉层
        if (!best || r.width*r.height < best.area) best = { el: e, area: r.width*r.height };
      }
      if (!best) return null;
      let box = best.el.querySelector('.semi-checkbox') || best.el.querySelector('[class*="checkbox"]');
      let hop = best.el;
      while (!box && hop.parentElement && hop.getBoundingClientRect().height < 300) {
        hop = hop.parentElement;
        box = hop.querySelector('.semi-checkbox') || hop.querySelector('[class*="checkbox"]');
      }
      return box ? true : null;   // 没勾选框 = 不是结果卡片
    })()`;
    // 🔥 搜索命中判据(批量管理【之前】用): 那时卡片还没有勾选框套件 → 只要求"卡片尺寸元素含识别码且不在联想/下拉层"。
    //   (若这里也要求勾选框, 搜索永远判不中 → 白搜。勾选框判据留给【批量管理之后】的 cardSelectableExpr。)
    const searchHitExpr = String.raw`(() => {
      const F = ${JSON.stringify(frag)};
      for (const e of document.querySelectorAll('li,div')) {
        if (!(e.innerText||'').includes(F) || !e.offsetParent) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 150 || r.width > 450) continue;
        if (e.closest('[class*="popover"],[class*="dropdown"],[class*="popper"],[class*="suggest"]')) continue;
        return true;
      }
      return null;
    })()`;
    let usedSearch = false;
    // ⚠️ 2026-09-22（ego 变体实盘，S3 踩到）——**弹层态(modal_id=)必须先清，两条路都要清，且要在点 tab / 进批量管理之前**。
    //    原代码只有 `verifyList`（幂等分支）会调 `dyCleanList`，而 S3/S6 **都传 `skipIdempotency:true`** ⇒ 一次都没清。
    //    于是上一刀留在标签上的视频弹层被 `sameView` 判成"同页"→ 零导航复用 → 深扫在弹层里抓到"卡片"
    //    （弹层正文就含识别码）→ 勾选时该坐标上是播放器错误层，实测 `top=XG-ERROR.xgplayer-error @1393,505`
    //    → 连点 6 次全废。与 2026-09-21 记下的同型事故（那次在 S6，走幂等分支才清到）同一个坑。
    const wasModal = await dyCleanList(fromTab);

    const enterBatchMode = async () => {
      const tabPos = await waitFor(`(() => {
      const t = [...document.querySelectorAll('.semi-tabs-tab')].find(e => {
        if (!e.offsetParent) return false;
        const txt = (e.innerText||'').trim();
        const r = e.getBoundingClientRect();
        if (${wantPrivList}) return txt.split(String.fromCharCode(10))[0] === '私密作品';
        return txt.split(String.fromCharCode(10))[0] === '作品' && txt.indexOf('私密') < 0 && r.y < 260;
      });
      if (!t) return null;
      t.scrollIntoView({ block: 'center' });
      const r2 = t.getBoundingClientRect();
      return { x: Math.round(r2.x + r2.width/2), y: Math.round(r2.y + r2.height/2) };
    })()`, { timeout: 8000 });
      if (tabPos) { await cdpClick(tabPos.x, tabPos.y); await ctx.wait(1.5); }
      else if (wantPrivList) {
        // 🔥 2026-09-23（ego 实盘，「私密作品tab未找到」真因）：
        //   本账号的抖音UI（抖音精选版式）**根本没有「私密作品」子tab** —— 实测截图 +
        //   `.semi-tabs-tab` 全量 dump 只有：作品410 / 推荐 / 喜欢 / 收藏 / 观看历史 / 稍后再看 / 我的预约。
        //   ⇒ 这里原来直接 throw，S3（唯一 wantPrivList=true 的调用方）必然死在 8s 超时上，
        //     而"识别码视频"其实就躺在当前列表里可正常操作。
        //   上方的注释早就写明该兼容（"旧版无子tab,直接兼容跳过"），只是从来没实现 ⇒ 现在按原意补上。
        //   ⚠️ 判据未变：仍然是「在当前列表里按识别码定位卡片 → 权限设置 → 公开」，只是不再要求先切子tab。
        //   ⚠️ 必须确认"子tab行真的渲染出来了"才走兼容（否则页面没加载完会被误判成"无子tab"而瞎点）。
        const tabTexts = await ctx.js(`(() => {
          const ts = [...document.querySelectorAll('.semi-tabs-tab')].filter(e => e.offsetParent);
          return ts.length ? JSON.stringify(ts.map(e => (e.innerText||'').trim())) : null;
        })()`);
        if (!tabTexts) throw new Error('私密作品tab未找到(子tab行未渲染)');
        console.log(JSON.stringify({ stage: 'DY_NO_PRIV_TAB', ok: true,
          说明: '当前抖音UI无「私密作品」子tab → 兼容路径：在当前列表原地操作', 子tab: JSON.parse(tabTexts) }));
      }
      // 🔥🔥 B50 正确顺序(用户 2026-09-12 纠正): **先在作品列表搜索识别码 → 再点「批量管理」**。
      //   搜索框「搜索你发布的作品」在未进批量管理时就存在(实测 hasBatchSearch:true); 先搜→列表被过滤→再进批量管理直接看到目标卡。
      //   ⚠️ 旧代码顺序反了(先进批量管理→再搜) → 批量管理态下搜索联想下拉干扰 → 三次翻车根因。
      if (mode === 'private') usedSearch = await douyinBatchSearch(frag, searchHitExpr);
      const bm = await locateByText('批量管理', { exact: true });
      if (!bm) {
        // 🔥 2026-09-23（ego 实盘，同一条链）：S3 紧跟在 `probeFrag` 之后，而 probeFrag **已经点过「批量管理」**
        //   ⇒ 此时工具栏按钮已变成「退出管理」，`批量管理` 找不到；老代码在这里 throw「批量管理未找到」。
        //   再点一次「批量管理」也不对（会退出管理态）⇒ 只有"确实已在批量管理态"时才跳过，否则照旧报错。
        const inBatch = await ctx.js(`/全选/.test(document.body.innerText) && /权限设置/.test(document.body.innerText)`);
        if (!inBatch) throw new Error('批量管理未找到');
        console.log(JSON.stringify({ stage: 'DY_ALREADY_BATCH', ok: true, 说明: '已在批量管理态(按钮=退出管理) → 原地复用，不再点一次' }));
      } else {
        await cdpClick(bm.x, bm.y);
        await ctx.wait(1.2);
      }
    };

    if (noNav) {
      // 原地操作: probeFrag 已在目标列表+批量管理态
      // ⚠️ 但"原地"只在页面干净时成立：刚清过弹层（或本来就在弹层里）⇒ 批量管理态已随之消失，
      //    必须重建，否则后面找勾选框永远找不到（卡片在列表态没有勾选框套件）。
      if (wasModal) {
        console.log(JSON.stringify({ stage: 'DY_REENTER_BATCH', ok: true, 说明: '清弹层后批量管理态已失效 → 原地路径重建（点目标tab + 批量管理）' }));
        await enterBatchMode();
      }
    } else {
      await enterBatchMode();
    }
    // 定位识别码视频卡片 —— 🔥 回到稳定版(几十个计划验证)的正确深扫链:
    //    ① 首屏 querySelectorAll 查; ② 向下增量滚(每屏0.25s) 每4屏点「过滤不良素材」刷新; ③ 兜底滚到底触发全部加载。
    //    ⚠️ 为什么必须滚动: 识别码视频"很早发布"在几百/几千作品深处, 虚拟列表默认只渲染首屏, 不滚 querySelectorAll 永远找不到。
    //    "滚到底"(scrollTop=scrollHeight)能让虚拟列表触发懒加载, 把深位视频加载进 DOM, 再被识别。这是我之前改"完全不滚"失败的原因。
    const cardExpr = String.raw`(() => {
      let b = null;
      for (const e of document.querySelectorAll('li,div')) {
        if ((e.innerText||'').includes(${JSON.stringify(frag)}) && e.offsetParent) {
          if (e.closest('[class*="popover"],[class*="dropdown"],[class*="popper"],[class*="suggest"]')) continue; // 排搜索联想/下拉层
          const r = e.getBoundingClientRect();
          if (r.width>=150 && r.width<=450 && (!b || r.width*r.height < b.area)) b = { el: e, area: r.width*r.height };
        }
      }
      return !!b;
    })()`;
    // ⓪ B50 搜索已在【批量管理之前】执行(见上, usedSearch); 这里只用判据定位卡片
    let cardReady = null;
    if (usedSearch) cardReady = await waitFor(cardSelectableExpr, { timeout: 3000 }); // 搜索命中后走【严格判据】(排联想/下拉层), 防假命中
    if (!cardReady) cardReady = await waitFor(cardExpr, { timeout: 2500 }); // ① 首屏(原逻辑, 搜索不可用时回退)
    // ② 增量下滚(每屏0.25s), 每4屏点「过滤不良素材」刷新
    for (let scan = 0; scan < 12 && !cardReady; scan++) {
      await scrollPane(ctx, 800, { label: '增量下滚' });
      await waitJ(0.2, 0.35);   // 温和化：原固定 0.25s
      cardReady = await waitFor(cardExpr, { timeout: 800 });
      if (!cardReady && (scan + 1) % 4 === 0) {
        const filt = await locateByText('过滤不良素材', { exact: false, minW: 1 });
        if (filt) { await cdpClick(filt.x, filt.y, 200); await waitJ(0.5, 0.5); }   // 温和化：原固定 0.6s
      }
    }
    // ③ 兜底滚到底触发全部加载(深位视频), 直到找到或滚动高度不再增长
    if (!cardReady) {
      // ⚠️ 2026-09-22 改回**比特版轮数 80**（用户：「看看 bitbrowser 滚底怎么做的」）——
      //    温和不靠砍轮数，靠"**人手滚轮** + 随机节奏"（原来 24 轮是我自作主张，已还原）。
      for (let scan = 0; scan < 80 && !cardReady; scan++) {
        await scrollPaneToBottom(ctx, { label: '兜底滚到底' });
        await waitJ(0.5, 0.6);
        cardReady = await waitFor(cardExpr, { timeout: 800 });
      }
    }
    if (!cardReady) throw new Error('识别码卡片深扫未找到: ' + frag);
    tmark('定位识别码卡片');
    // 🔥 2026-09-13 「勾选失败(CDP与DOM均无效)」根因(同一失败页面实测):
    //    ① CDP 真实点击(同坐标) ✅ 能切换 1↔0; ② box.click() 点外层 span ❌ 无效; ③ input.click() ❌ 也无效。
    //    → Semi 勾选框只认真实鼠标点击, 旧代码的"DOM 兜底"根本走不通 → 必然报"CDP与DOM均无效"。
    //    唯一可行方案 = 真实点击, 失败原因只可能是"点下去那一刻该坐标上不是勾选框"(错位/被遮)。
    //    故改为: 点前 elementFromPoint 校验 → 点后轮询判定 → 不成就重算坐标重试(最多6次), 并打印现场。
    const cbProbe = () => ctx.js(String.raw`(() => {
      const USE_SEARCH = ${JSON.stringify(usedSearch)};
      const F = ${JSON.stringify(frag)};
      let best = null, bestBoxed = null;
      for (const e of document.querySelectorAll('li,div')) {
        if (!(e.innerText||'').includes(F) || !e.offsetParent) continue;
        // ⚠️ 排除搜索联想/下拉/气泡层 —— 2026-09-12 翻车元凶: 宽松判据把下拉项当卡片 → 无勾选框 → 勾选失败
        if (e.closest('[class*="popover"],[class*="dropdown"],[class*="popper"],[class*="suggest"]')) continue;
        const r = e.getBoundingClientRect();
        if (r.width<150 || r.width>450) continue;
        const area = r.width*r.height;
        if (!best || area < best.area) best = { el: e, area };
        // 找勾选框(向上 hop, 卡片的勾选框常在祖先容器)
        let box = e.querySelector('.semi-checkbox') || e.querySelector('[class*="checkbox"]');
        if (!box) { let hop = e; while (!box && hop.parentElement && hop.getBoundingClientRect().height < 300) { hop = hop.parentElement; box = hop.querySelector('.semi-checkbox') || hop.querySelector('[class*="checkbox"]'); } }
        if (box && (!bestBoxed || area < bestBoxed.area)) bestBoxed = { box, area };
      }
      // 优先带勾选框的真结果卡片; 搜索路径必须带(否则宁可不点, 防勾错/防失败); 原深扫路径保留旧的 el 兜底
      const pick = bestBoxed || (USE_SEARCH ? null : (best ? { box: best.el } : null));
      if (!pick) return null;
      pick.box.scrollIntoView({ block: 'center' });
      const r = pick.box.getBoundingClientRect();
      const x = Math.round(r.x + Math.min(r.width/2, 30)), y = Math.round(r.y + r.height/2);
      const t = document.elementFromPoint(x, y);
      return { x, y, onBox: !!(t && (t === pick.box || pick.box.contains(t))),
               top: t ? (t.tagName + '.' + String(t.className || '').slice(0, 44)) : null,
               // 🔥 这张卡**自己的勾选框**是否已勾上 —— 比"整页出现任意勾选态/已选计数"精确得多,
               //    用来在"首击疑似被吞"时快速、无歧义地复查(避免误判导致二次点击把勾去掉)。
               checked: /checked/.test(String(pick.box.className || '')) || !!(pick.box.querySelector && pick.box.querySelector('.semi-checkbox-checked,[class*="checkbox"][class*="checked"]')) };
    })()`);
    // 🔥 勾选判定: "已选>0" 或 "出现勾选态" 任一成立即通过(轮询, 不早判)
    const selOk = (ms) => waitFor(`(() => {
      const t = document.body.innerText;
      const m = t.match(/已选[^\\d]*(\\d+)/) || t.match(/已选择\\s*(\\d+)/);
      if (m && +m[1] > 0) return true;
      return document.querySelector('.semi-checkbox-checked, .semi-checkbox.checked, [class*="checkbox"][class*="checked"]') ? true : null;
    })()`, { timeout: ms });
    let checked = null, cb = null;
    const s6 = mode === 'private';   // S6=搜索路径(整页 reload 后操作); S3=深扫路径(noNavigate 原地)
    for (let att = 0; att < 6 && !checked; att++) {
      // 🔥 首击参数按路径分(S3 深扫 / S6 搜索), S3 保持原样不动(用户口径: "S3 按原来的别改"):
      //   · S3(mode=public): 首击 250ms 按下 + 移过去停 1000ms —— 实测 0/6 被吞, 一字不改。
      //   · S6(mode=private): 首击 80ms 快击、无 hover 停顿。原先那 1s hover 停顿(2026-09-12 20:07 加)
      //     实测**无效**(加不加都被吞), 属纯浪费 → 已删: S6「勾选+权限设置」4386→3223ms。
      //   注: S6 首击被吞(打日志 `第1次点击未生效`)的根因**未定**, 已否掉两个假设 ——
      //     ①点击参数(250ms/80ms 都被吞) ②DOM 未稳定(静默≥500ms 后仍被吞);
      //     且被吞的首击与必成的重试**坐标/元素完全相同**(335,317 / SPAN.semi-checkbox-inner-display)。
      //     影响仅"白点一下 + 重试多等 ~2.5s", 重试必成; 用户 2026-09-12 决定不再追。详见 SOP 第三节 B52。
      cb = await cbProbe();
      if (!cb) throw new Error('识别码视频卡片未定位');
      if (!cb.onBox) {
        console.log('  [勾选] 第' + (att + 1) + '次: 该坐标上不是勾选框(' + cb.top + '), 300ms 后重算');
        // 🔥 2026-10-22 实盘（plan 3000000000000000103：S3 连挂 6 次 → 旧计划已删/新计划未建 = 断链）：
        //    日志里 top 前 4 次是 `DIV.trust-login-dialog-mask`（信任登录遮罩），后两次是 `IMG.` / `XG-VIDEO-CONTAINER`，
        //    收尾 dump 的 URL = `douyin.com/user/self?modal_id=…&showSubTab=private_post`
        //    ⇒ 页面被**视频弹层 + 遮罩**占住，深扫在弹层正文里"看到"识别码就当成了卡片（同 SOP B58）。
        //    这种现场干点 6 次必然全废（坐标永远落在遮罩/播放器上）。判据：top 命中播放器/遮罩 **或** URL 带 modal_id=
        //    ⇒ 先清弹层（dyCleanList：ego 原生点关闭 + 关不掉就强制重载兜底），再重算坐标；不清就一定白点。
        //    ⚠️ 遮罩是「信任登录」时脚本**只清弹层、绝不代替人做登录动作**（铁律 9：硬停移交）；
        //       清不掉就带着现场抛错，由人手动点掉后 `--resume` 续跑。
        const badTop = /trust-login-dialog-mask|xg-video-container|^VIDEO\.|xgplayer|xg-error/i.test(String(cb.top || ''));
        const hasModal = !!(await ctx.js('/[?&]modal_id=/.test(location.href) ? true : null').catch(() => null));
        if ((badTop || hasModal) && att < 3) {
          console.log(JSON.stringify({ stage: 'DY_OBSTRUCTED', ok: true,
            说明: '点击点被弹层/遮罩占据 → 先清弹层再重算坐标（否则 6 次全废）', top: cb.top, hasModal }));
          await dyCleanList(fromTab);
          await ctx.wait(1.2);
        }
        await waitJ(0.3, 0.4); continue;
      }
      // 🔥 2026-09-12 晚(用户口径: "反正就按照 S3 的方式来就行"): **首击参数统一按 S3 那套** ——
      //    250ms 按下 + 移过去停 1s(等 hover 过渡), 不再给 S6 单独一套参数。
      //    (诚实记录: S3 这套参数在 S6 上 20:04 / 20:14 两跑**照样被吞** —— 它不解决"被吞", 只让 S6 与 S3
      //     行为一致; 真正兜住耗时的是下面那 0.7s 快查 + 精确复查。)
      const slowFirst = att === 0;
      if (slowFirst) console.log('  [勾选] 首击: 移到卡片后停 1s 再按(等 hover 过渡, S3/S6 统一)');
      // 温和化：首击前的 hover 停顿也加抖动（原固定 1000ms）
      await cdpClick(cb.x, cb.y, slowFirst ? jitter(220, 150) : 80, slowFirst ? jitter(800, 700) : 0);
      // 🔥 S6 被吞时把"发现失败"的时间从 2500ms 压到 ~700ms: 先用短的整页判定(命中即返回), 失败再
      //    **精确复查这张卡自己的勾选框**(cbProbe.checked) —— 勾上了就认定成功(避免误判成失败再点第二下
      //    把勾去掉), 真没勾上就立刻重试。S3 分支不进这里(逐字未动)。
      checked = await selOk(att === 0 && s6 ? 700 : (att === 0 ? 2500 : 1500));
      if (!checked && s6) {
        const cbRe = await cbProbe();
        if (cbRe && cbRe.checked) { checked = true; console.log('  [勾选] 首击其实中了(整页判定慢), 精确复查确认'); }
      }
      if (!checked) console.log('  [勾选] 第' + (att + 1) + '次点击未生效 坐标=' + cb.x + ',' + cb.y + ' top=' + cb.top);
    }
    if (!checked) {
      // 2026-10-22：把"为什么点不上"直接写进错误里 —— 别再让人从 JSON 里猜（上次就是这么白查的）。
      const top = String((cb && cb.top) || '');
      const why = /trust-login-dialog-mask/.test(top)
        ? '（抖音弹了「信任登录」遮罩盖住整页 ⇒ 需人工在 ego 里把它点掉，再 --resume 从 S3 续跑；脚本不做登录动作）'
        : /xg-video-container|xgplayer|xg-error|^VIDEO\./.test(top)
          ? '（点击点落在视频弹层里 ⇒ 列表被视频弹层占住；清弹层没成功 ⇒ 人工关掉弹层后 --resume 从 S3 续跑）'
          : '';
      throw new Error('勾选失败(CDP与DOM均无效): ' + JSON.stringify(cb) + why);
    }
    const perm = await waitFor(String.raw`(() => {
      const e = [...document.querySelectorAll('span,div,button')].find(x => x.offsetParent && (x.innerText||'').trim() === '权限设置');
      if (!e) return null;
      const r = e.getBoundingClientRect();
      if (r.x < 0 || r.x > window.innerWidth) return { off: true };
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`, { timeout: 2000 });
    if (!perm || perm.off) throw new Error('权限设置未找到');
    await cdpClick(perm.x, perm.y);
    tmark('勾选+权限设置');
    const target = mode === 'public' ? '公开·所有人可见' : '私密·仅自己可见';
    const radio = await waitFor(String.raw`(() => {
      const r = [...document.querySelectorAll('.semi-radio')].find(e => e.offsetParent && (e.innerText||'').includes(${JSON.stringify(target)}));
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) };
    })()`, { timeout: 8000 });
    if (!radio) throw new Error('权限radio未找到');
    await cdpClick(radio.x, radio.y);
    const ok = await waitFor(String.raw`(() => {
      const bs = [...document.querySelectorAll('button')].filter(b => b.offsetParent && /^(确\s*定|确\s*认)$/.test((b.innerText||'').trim()));
      if (!bs.length) return null;
      const b = bs[bs.length - 1];
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`, { timeout: 6000 });
    if (!ok) throw new Error('权限确认按钮未找到');
    await cdpClick(ok.x, ok.y);
    // 🔥 2026-09-13 清理静默超时(原 8s 且结果未检查): 收音只是"等弹窗收起"的礼貌等待, 真正的判据由
    //    S7(不可投)/S9(终验) 权威兜底 → 收到 3s 并检查, 没收起就只打一行日志, 继续往下走。
    const radioGone = await waitFor(`(() => ![...document.querySelectorAll('.semi-radioGroup')].some(e => e.offsetParent))()`, { timeout: 3000 });
    if (!radioGone) console.log('  [权限] 弹窗 3s 未收起(不阻塞, 由 S7/S9 权威验证)');
    // 尾部双向验证已删除(B30省时): 私密与否由 S7 千川素材面板「不可投」权威验证
    // 若私密切换静默失败, S7 会发现不可投未出现 → 编排层自动重做一次本函数
    return { ok: true };
  };

  // ---------- 素材面板 ----------
  // B36: 整窗被遮挡/后台时 CDP bringToFront 不够 → 按 pid 用 osascript 置前(千川/抖音通用)
  // ⚠️ 2026-09-22（ego 变体）：这里是**比特专用**的（pid 要去问比特 localAPI `127.0.0.1:54345`）。
  //    ego 下那条 API 不存在 → fetch 失败 → 本来就空转；但若本机恰好有比特浏览器在跑，
  //    `id: envId` 万一撞上就会去"置前别人的窗口"。用户第一原则是**不打扰**（「我用 ego 就是因为在
  //    你操作时我能用电脑」）⇒ ego 运行时不走 osascript，只做"最小化恢复"这一无害动作，
  //    并把"冻结守卫在 ego 下退化"这件事**明确打出来**，别让它悄悄失效。
  const raiseWin = async () => {
    if (EGO.inEgo()) {
      // ⛔ 2026-09-22 用户实证：「你在操作其他空间的时候还是会抢我的控制权，我一直想在这里给你打字就是会被干扰」。
      //    `Browser.setWindowBounds({windowState:'normal'})` 即使窗口本来就是 normal，也可能把 OS 窗口提到前台
      //    → 直接摘掉：ego 下**什么窗口动作都不做**（冻结守卫的代价 << 抢用户焦点的代价）。
      console.log(JSON.stringify({ stage: 'EGO_NO_RAISE', ok: true, 说明: 'ego 下不做任何提窗口动作（不抢用户焦点）—— 若页面真因最小化冻结，请手动把该 ego 窗口恢复后再跑' }));
      return;
    }
    try {
      const pid = await fetchJ('http://127.0.0.1:54345/browser/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: envId }) }).then(j => j.data && j.data.pid);
      if (pid) require('node:child_process').execSync(`osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true'`, { timeout: 5000 });
    } catch (e) {}
  };

  // 关闭当前打开的千川抽屉(详情/素材面板共用). ⚠️ 关键(实测): 这个抽屉按 Escape 关不掉, 必须点右上角关闭X(.oc-drawer-close).
  //   检测"有抽屉"用真实抽屉类(.ovui-drawer/.ovui-modal)且 400<宽<1800 —— 别用 [class*="drawer"] width>400,
  //   会命中 ad-detail-drawer-ref(整页引用容器, 宽≈1920, 永远"开着")误判. S1读素材/S2删旧/S8补素材都靠它回列表页.
  const closeDrawer = async () => {
    for (let esc = 0; esc < 2; esc++) {
      const openBefore = await ctx.js(`(() => {
        const dr = [...document.querySelectorAll('.ovui-drawer, .ovui-modal, [class*="drawer"]')]
          .find(d => d.offsetParent && d.getBoundingClientRect().width > 400 && d.getBoundingClientRect().width < 1800);
        return !!dr;
      })()`);
      if (!openBefore) break;
      const xPos = await ctx.js(`(() => {
        const e = document.querySelector('.oc-drawer-close, [class*="drawer-close"]');
        if (!e || !e.offsetParent) return null;
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      })()`);
      if (xPos) { await cdpClick(xPos.x, xPos.y, 400); }
      // ⛔ 不再用 ESC 兜底：在创建页上按 ESC 会触发「确定退出并放弃创建全域投放吗？」
      //    （2026-09-12 用户两次点名）。找不到关闭图标就**保持抽屉开着**，等下一步复用。
      else { console.log(JSON.stringify({ stage: 'CLOSE_DRAWER_SKIP', 说明: '没有关闭图标 → 不点也不按 ESC（避免触发放弃创建）' })); break; }
      await ctx.wait(0.8);
    }
    const stillOpen = await ctx.js(`(() => {
      const dr = [...document.querySelectorAll('.ovui-drawer, .ovui-modal')]
        .find(d => d.offsetParent && d.getBoundingClientRect().width > 400 && d.getBoundingClientRect().width < 1800);
      return !!dr;
    })()`);
    if (stillOpen) { await ctx.pressKey('Escape'); await ctx.wait(0.7); }
  };

  const openMaterialDrawer = async (planId, opts = {}) => {
    // 省时: reusePage 时若已在列表页则免刷新; 页面状态意外不对(不在列表)自动回退刷新, 稳字当头
    if (opts.reusePage) {
      const onList = await ctx.js(`(() => location.href.indexOf('uni-prom') >= 0 && document.querySelectorAll('tr').length > 0)()`);
      if (!onList) await gotoQianchuan({ wide: true });
      // ⚠️ 必须把千川页签/窗口带回前台: S6 在抖音窗口操作后前台在抖音,
      //    后台页签被浏览器节流 → SPA 不渲染(B26变体) → S8视频选择器打不开
      else { try { await ctx.cdp('Page.bringToFront', {}); } catch (e) {} await raiseWin(); }
    } else {
      await gotoQianchuan({ wide: true }); // 旧计划不在当天列表, 必须宽日期
    }
    // ⚠️ 实测关键(B36修复): 先关掉已打开的抽屉弹窗, 再从【计划表行内】的「素材」按钮点进去。
    //    坑A: 这个抽屉(ad-detail-drawer-ref + ovui-drawer--right)按 Escape 关不掉, 必须点右上角关闭X(.oc-drawer-close)。
    //    坑B: 检测"有抽屉"不能用 [class*="drawer"] 里 width>400 —— ad-detail-drawer-ref 是整页引用容器(宽≈1920),
    //         永远"开着"导致误判 → 必须用真实抽屉类并限定 400<宽<1800。
    //    坑C: 抽屉没关掉就直接点行内「素材」→ 点在遮罩上/行被盖住 → 新页面素材面板打不开 → 添加视频挂车失败。
    //    S1/S2 等阶段要回到列表页也复用它(同样Escape关不掉详情抽屉)。
    // 🔥 优化(用户实测): S7 验证不可投已打开本计划素材抽屉(含"添加视频"), S8 应直接复用, 不要 close 重进。
    //    若当前已开着该计划素材抽屉 → 直接返回(复用), 省去"关抽屉→点行内素材→重进"的重复往返。
    const alreadyOpen = await ctx.js(String.raw`(() => {
      const d = [...document.querySelectorAll('.ovui-drawer')].reverse().find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes(${JSON.stringify(planId)}) && (x.innerText||'').includes('添加视频'));
      return !!d;
    })()`);
    if (alreadyOpen && opts && !opts.forceReopen) { tmark('打开素材抽屉'); return true; }
    await closeDrawer();
    const mat = await waitFor(String.raw`(() => {
      // ⚠️⚠️ 2026-10-02 第二次实测（承接同日的"取最内层"修复）：
      //   改完仍然报「素材面板未打开」，新日志给出决定性线索 —— S1素材入口 … 视口内:false, 坐标:-758,-122，
      //   而且**连 scrollIntoView 都救不回来**（三次坐标 -758/-736/-757 全在视口外）✗。
      //   结合只读探针看到的"整行 TD 都是负坐标"（x≈-652, y≈-161）⇒ 判定：
      //   这个表是**虚拟滚动**的 ⇒ 同一条计划**同时存在多张 tr**（可见那张 + 离屏缓冲区那张），
      //   而原来的 [...trs].find(...) 取的是**第一个** —— 很可能正是**离屏那张** ✗
      //   ⇒ 判据改成：**在所有匹配行里，挑「素材入口真的落在视口内」的那一张** ✓；
      //     一张可见的都没有才退回第一张，并如实标 视口内:false（日志一眼看出"没找到可见的" ✗）
      const trs = [...document.querySelectorAll('tr')].filter(x => x.offsetParent && (x.innerText||'').includes(${JSON.stringify(planId)}));
      if (!trs.length) return null;
      const 候选 = [];
      for (const tr of trs) {
        const 精确 = [...tr.querySelectorAll('div,span,a')].filter(x => (x.innerText||'').trim() === '素材');
        if (!精确.length) continue;
        const e = 精确.find(x => x.children.length === 0)
               || 精确.find(x => /arrow-name-text/.test(String(x.className||'')))
               || 精确[精确.length - 1];
        const r = e.getBoundingClientRect();
        候选.push({ e, 同名数: 精确.length, 视口内: r.x >= 0 && r.y >= 0 && r.x + r.width <= window.innerWidth && r.y + r.height <= window.innerHeight });
      }
      if (!候选.length) return null;
      const 选 = 候选.find(c => c.视口内) || 候选[0];
      // ⚠️ 先**选定**再 scroll（对每个候选都 scroll 会把先前的滚动位置冲掉 ⇒ 读到的坐标是过期的 ✗）
      选.e.scrollIntoView({ block: 'center', inline: 'center' });
      const r2 = 选.e.getBoundingClientRect();
      return { x: Math.round(r2.x + r2.width/2), y: Math.round(r2.y + r2.height/2),
               标签: 选.e.tagName, 类: String(选.e.className||'').slice(0, 46),
               同名数: 选.同名数,
               候选行数: 候选.length, 有可见行: 候选.some(c => c.视口内),
               视口内: r2.x >= 0 && r2.y >= 0 && r2.x + r2.width <= window.innerWidth && r2.y + r2.height <= window.innerHeight };
    })()`, { timeout: 20000 });
    if (!mat) {
      const diag = await ctx.js(`(() => ({
        rows: [...document.querySelectorAll('tr')].filter(t => t.offsetParent).slice(0, 5).map(t => (t.innerText||'').slice(0, 60).split(String.fromCharCode(10)).join('|')),
        hasPlanRow: [...document.querySelectorAll('tr')].some(t => t.offsetParent && (t.innerText||'').includes(${JSON.stringify(planId)}))
      }))()`);
      throw new Error('素材入口未找到 ' + JSON.stringify(diag));
    }
    // ⚠️⚠️⚠️ 2026-10-02 **真因**（只读探针 `PROBE_滚动取证` 实测定性，canon #64 手法）：
    //   探针打出来的是 —— **`window.innerWidth = 0`、`innerHeight = 0`** ✗✗
    //   ⇒ 这个标签的**布局视口塌陷成 0×0**（ego 窗口被**最小化/隐藏**时就是这样）⇒ 于是：
    //     · 所有 rect 都是**负坐标**（布局退化，探针里整行 TD 是 x≈-700, y≈-161）
    //     · `scrollIntoView` **永远拉不回来**（没有视口可滚）
    //     · 坐标点击**点在屏幕外**；`page.click` 的 actionability **永远等不到"可见"** ✗
    //   ⇒ 这就是 `素材面板未打开` 的真因，**也是更早那批** `商品卡片未定位(卡片数:0)` /
    //     `发布确认/成功30s均未出现` / chip 读成空串 的**共同真因** ✓（同一个"视口塌陷"）
    //   仓库其实早知道（日志里那句 `EGO_NO_RAISE … 若页面真因最小化冻结，请手动把该 ego 窗口恢复后再跑`），
    //   但**从来没有真正检测过** ⇒ 每次白烧 3×90s，最后报一个**误导人**的 `素材面板未打开` ✗✗
    //   ⇒ 判据（canon #48/#71：**读到 0/点不动之前，先证明"读取面"真的就位**）：
    //     **视口塌陷就别去点、别重试** —— 直接说人话让用户恢复窗口 ✓（本仓库按用户口径**不抢焦点**，
    //     所以不会自己把窗口弹出来；要自动恢复得用户点头 ✗）
    if (typeof ctx.egoEnsureViewport === 'function') {
      // ⚠️ 自愈件本身出错**不许拖垮主流程**（2026-10-02 实盘：它内部一个 ReferenceError
      //    被这里一路冒泡成 `素材重试: 1/3 ctx is not defined` ⇒ 看着像页面问题，其实是代码错 ✗）
      let vp = null;
      try { vp = await ctx.egoEnsureViewport(); }
      catch (e) { log({ stage: 'S1视口自愈_跳过', ok: false, err: String((e && e.message) || e).slice(0, 100),
                        说明: '自愈件报错 ⇒ 跳过它继续跑（不许把主流程拖垮 ✗）' }); }
      if (vp && vp.塌陷) {
        log({ stage: 'S1视口塌陷', ok: vp.恢复了, planId,
              视口: vp.视口 ? vp.视口.w + 'x' + vp.视口.h : null, 复测: vp.复测 ? vp.复测.w + 'x' + vp.复测.h : null,
              恢复: vp.恢复,
              说明: vp.恢复了
                ? 'ego 窗口被最小化 ⇒ 布局视口 0×0 ⇒ 元素全不可点；**已自动恢复窗口**（用户 2026-10-02 选 A）⇒ 复测正常，继续 ✓'
                : 'ego 窗口被最小化/隐藏 ⇒ 布局视口 0×0 ⇒ 元素全不可点；**自动恢复无效** ⇒ 请人工把该 ego 窗口恢复后重跑 ✗' });
        if (!vp.恢复了) throw new Error('视口塌陷且自动恢复无效(ego 窗口被最小化/隐藏) ⇒ 请人工恢复该窗口后重跑');
      }
    } else {
      const 视口 = await ctx.js(`(() => ({ w: window.innerWidth, h: window.innerHeight }))()`).catch(() => null);
      if (视口 && (视口.w <= 0 || 视口.h <= 0)) throw new Error('视口塌陷(ego 窗口被最小化: innerWidth=' + 视口.w + ') ⇒ 请把该 ego 窗口恢复后重跑');
    }
    // ⚠️ 2026-10-02（探针实测）：这个入口在视口外时坐标点击**必失效**（点在屏幕外）⇒
    //   一律**原生点击优先**（`page.click` 自带 actionability：会自己把元素滚进视口 ✓），坐标只做兜底 ✓
    log({ stage: 'S1素材入口', ok: true, 计划: planId, 选中: mat.标签 + (mat.类 ? '.' + mat.类.split(' ')[0] : ''),
          同名数: mat.同名数, 视口内: mat.视口内, 候选行数: mat.候选行数, 有可见行: mat.有可见行, 坐标: mat.x + ',' + mat.y,
          说明: '取最内层同名元素（原来取最外层包裹 div ⇒ 点了没反应 ✗）；视口外时坐标点击无效 ⇒ 原生优先 ✓' });
    let 开了 = false;
    if (typeof ctx.egoClickSelector === 'function') {
      for (const sel of ['tr:has-text("' + planId + '") .oc-promotion-product-adinfo-arrow-name-text',
                         'tr:has-text("' + planId + '") div:has-text("素材")']) {
        try { await ctx.egoClickSelector(sel, { timeout: 5000, label: '素材入口' }); 开了 = true; break; } catch (e) {}
      }
    }
    if (!开了) await cdpClick(mat.x, mat.y);
    // ⚠️ 新版UI: 点「素材」是整页跳转(URL带 openMaterialDrawer=1&adId=...), 抽屉在新页面自动打开;
    //    旧UI才是原地弹抽屉。跳转时会报 navigated or closed —— 等新页面加载后重查即可
    let opened = null;
    for (let nav = 0; nav < 3 && !opened; nav++) {
      try {
        opened = await waitFor(String.raw`(() => {
          const d = [...document.querySelectorAll('.ovui-drawer')].reverse().find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes(${JSON.stringify(planId)}));
          return d ? (d.innerText||'').includes('添加视频') : false;
        })()`, { timeout: 12000 });
      } catch (e) {
        if (!/navigated or closed/i.test(e.message || '')) throw e;
        await sleep(3500);
      }
    }
    if (!opened) {
      // ⚠️ 2026-09-27（S7 实盘：首读报「素材面板未打开」→ 后面每次"重读"都是在**没打开的页面上数 0**
      //    ⇒ 判据全假 ⇒ 白烧 360s 看门狗才失败）：行内「素材」那一下是坐标点击，ego 上偶尔点了不跳转。
      //    ⇒ 再整体重来一次（关抽屉 → 重新定位入口 → 原生点击优先 → 再等抽屉），比交给看门狗划算。
      const 二次 = await (async () => {
        try {
          await closeDrawer();
          await ctx.wait(1);
          const m2 = await waitFor(String.raw`(() => {
            const tr = [...document.querySelectorAll('tr')].find(x => x.offsetParent && (x.innerText||'').includes(${JSON.stringify(planId)}));
            if (!tr) return null;
            const e = [...tr.querySelectorAll('span,div,a')].find(x => (x.innerText||'').trim() === '素材');
            if (!e) return null;
            e.scrollIntoView({ block: 'center' });
            const r = e.getBoundingClientRect();
            return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
          })()`, { timeout: 15000 });
          if (!m2) return false;
          let _m2 = false;
          if (typeof ctx.egoClickSelector === 'function') {
            // ⚠️ 2026-10-02（探针实测）：这里原来写 **`span:has-text("素材")`** —— 可那 5 个同名元素
            //   **全是 `DIV`**（`div.oc-promotion-product-adinfo-material` / `…-arrow-name` /
            //   `…-arrow-name-text` / 无名叶子）⇒ 这个选择器**一个都匹配不到** ✗ ⇒ 每次都掉回坐标点击
            //   ⇒ 又撞"视口外坐标点在屏幕外"⇒ 必失败 ✗✗（这就是 `素材面板未打开` 3/3 的直接原因）
            for (const sel of ['tr:has-text("' + planId + '") .oc-promotion-product-adinfo-arrow-name-text',
                               'tr:has-text("' + planId + '") div:has-text("素材")']) {
              try { await ctx.egoClickSelector(sel, { timeout: 4000, label: '素材入口(二次)' }); _m2 = true; break; } catch (e) {}
            }
          }
          if (!_m2) await cdpClick(m2.x, m2.y);
          for (let nav = 0; nav < 3; nav++) {
            try {
              const o = await waitFor(String.raw`(() => {
                const d = [...document.querySelectorAll('.ovui-drawer')].reverse().find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes(${JSON.stringify(planId)}));
                return d ? (d.innerText||'').includes('添加视频') : false;
              })()`, { timeout: 12000 });
              if (o) return true;
            } catch (e) {
              if (!/navigated or closed/i.test(e.message || '')) return false;
              await sleep(3500);
            }
          }
          return false;
        } catch (e) { return false; }
      })();
      if (!二次) throw new Error('素材面板未打开');
      log({ stage: 'S7素材面板二次打开生效', 说明: '首次点「素材」没跳转 ⇒ 关抽屉重定位后再开成功' });
    }
    return true;
  };

  const readCount = async () => {
    const v = await waitFor(`(() => {
      const d = [...document.querySelectorAll('.ovui-drawer')].find(x => x.offsetParent && x.getBoundingClientRect().width > 400);
      if (!d) return null;
      const m = d.innerText.match(/共\s*(\d+)\s*个视频/);
      return m ? +m[1] : null;
    })()`, { timeout: 8000 });
    return v || null;
  };

  const materialReport = async (planId, opts = {}) => {
    await openMaterialDrawer(planId, opts || {});
    const rowCount = async () => {
      const v = await waitFor(String.raw`(() => {
        const d = [...document.querySelectorAll('.ovui-drawer')].reverse().find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes(${JSON.stringify(planId)}));
        if (!d) return null;
        const n = [...d.querySelectorAll('tr')].filter(r => r.offsetParent && (r.innerText||'').includes('素材ID')).length;
        return { n };
      })()`, { timeout: 8000 });
      return v == null ? null : v.n;
    };
    const delivering = await rowCount();
    // 坑10: 清空筛选(默认筛"投放中"); 坑20: 可漂移实例,失败重试
    // 🔥 2026-09-28（用户报「s7 一直出错」；实盘 A/B 定性）：这一步原来**只**用坐标点击 ⇒
    //    ego 上"点了不生效" ⇒「投放状态：投放中」筛选一直挂着 ⇒ 素材列表恒为 **0 行**
    //    （识别码视频此刻已被 S6 设成私密，本来就不在「投放中」里）⇒ S7 把它读成「不可投未出现」
    //    ⇒ 兜底重做私密 + 白烧 360s 看门狗才 failed ✗✗（09-27/09-28 共 5 次）。
    //    实测（同一页、同一计划、只差点击方式）：
    //      · CDP 坐标点 → `共0个视频` / `含素材ID行数:0` / `暂无数据` ✗
    //      · **ego 原生点** → `共2个视频` / `含素材ID行数:2` / `不可投:1` ✓（清空一生效，S7 当场就过）
    //    ⇒ 按 canon #48 的纪律：**原生点击优先，坐标只兜底**（"点一下让 X 出现"的步骤一律如此）。
    let 清空生效 = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const pos = await ctx.js(String.raw`(() => {
        const d = [...document.querySelectorAll('.ovui-drawer')].reverse().find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes(${JSON.stringify(planId)}));
        if (!d) return null;
        const e = [...d.querySelectorAll('span,div,button')].find(x => x.offsetParent && (x.innerText||'').trim() === '清空');
        if (!e) return null;
        const r = e.getBoundingClientRect();
        if (r.x + r.width > 1 && r.x < (window.innerWidth - 20)) return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
        return { off: true };
      })()`);
      if (pos && !pos.off) {
        let _clk = false;
        if (typeof ctx.egoClickSelector === 'function') {
          try { await ctx.egoClickSelector('.ovui-drawer--right span:has-text("清空")', { timeout: 4000, label: '清空素材筛选' }); _clk = true; } catch (e) {}
        }
        if (!_clk) await cdpClick(pos.x, pos.y, 400);
        await ctx.wait(1.2);
        const chipGone = await ctx.js(String.raw`(() => {
          const d = [...document.querySelectorAll('.ovui-drawer')].find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes(${JSON.stringify(planId)}));
          return d ? d.innerText.indexOf('投放状态') < 0 : true;
        })()`);
        if (chipGone) { 清空生效 = true; break; }
      } else {
        await ctx.wait(1);
      }
    }
    const total = await rowCount();
    // ⚠️ 留痕，但要**准**（2026-09-28 实跑反馈：`chipGone` 这个判据太粗 —— 没筛选时它也会为假 ✗，
    //    于是"清空没生效"会在完全正常的跑里误报）。真正有害的组合只有一个：
    //    **清空没生效 且 数出来 0 行**（已私密的素材不在「投放中」里 ⇒ 0 行是假数据）⇒ 只有这时才报 ✓。
    if (!清空生效 && total === 0) log({ stage: 'S7清筛选未生效', ok: false, 计划: planId,
      说明: '「投放状态」筛选没被清掉 **且** 数出 0 行 ⇒ 本次的 0 是**假数据**（素材被筛选挡住了，不是"不可投未出现"）→ 结果不可信' });
    const bn = await ctx.js(String.raw`(() => {
      const d = [...document.querySelectorAll('.ovui-drawer')].reverse().find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes(${JSON.stringify(planId)}));
      const trs = [...(d ? d.querySelectorAll('tr') : [])].filter(r => r.offsetParent && (r.innerText||'').includes('素材ID'));
      let nb = 0; for (const r of trs) if (r.innerText.includes('不可投')) nb++;
      return nb;
    })()`);
    tmark('读素材报表(含开抽屉)');   // ⏱ 2026-09-22 补埋点：S7 卡满 360s 时看不出卡在哪
    return { delivering, total, 不可投: bn };
  };

  // 用户指令(去重金标准): 旧计划素材面板的「不可投」行 = 当前绑定的识别码视频 → 读精确 demoA 码+素材ID
  const readMaterialFrag = async (planId) => {
    // ⚠️ 调用方已做完 导航+搜索; 这里绝不刷新(刷新会丢会话/丢搜索态), 失败就原地等重试
    await openMaterialDrawer(planId, { reusePage: true });
    tmark('打开素材抽屉读识别码');
    // 坑10: 面板默认筛「投放中」会滤掉不可投视频, 必须先清空
    // ⚠️ 2026-09-28：原来注释写「CDP真实点击, DOM click对组件无效」——**在 ego 上恰恰相反** ✗：
    //    坐标点击经常"点了不生效"，必须**ego 原生点击**（同一处 A/B 实测见 materialReport 里的长注释：
    //    坐标点 `共0个视频` / 原生点 `共2个视频 + 不可投:1`）。⇒ 原生优先、坐标兜底 ✓（canon #48 纪律）。
    let 清空生效 = false;
    for (let ca = 0; ca < 3; ca++) {
      const cp = await ctx.js(String.raw`(() => {
        const d = [...document.querySelectorAll('.ovui-drawer')].reverse().find(x => x.offsetParent && x.getBoundingClientRect().width > 400);
        if (!d) return null;
        const e = [...d.querySelectorAll('span,div,button')].find(x => x.offsetParent && (x.innerText||'').trim() === '清空');
        if (!e) return null;
        const r = e.getBoundingClientRect();
        if (r.x + r.width < 2 || r.x > window.innerWidth - 20) return { off: true };
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      })()`);
      if (cp && !cp.off) {
        let _clk = false;
        if (typeof ctx.egoClickSelector === 'function') {
          try { await ctx.egoClickSelector('.ovui-drawer--right span:has-text("清空")', { timeout: 4000, label: '清空素材筛选(读识别码)' }); _clk = true; } catch (e) {}
        }
        if (!_clk) await cdpClick(cp.x, cp.y, 300);
        await ctx.wait(0.8);
      }
      const chipGone = await ctx.js(String.raw`(() => { const d=[...document.querySelectorAll('.ovui-drawer')].reverse().find(x=>x.offsetParent&&x.getBoundingClientRect().width>400); return d ? d.innerText.indexOf('投放状态') < 0 : true; })()`);
      if (chipGone) { 清空生效 = true; break; }
      await ctx.wait(0.5); // 🔥 优化: 未消失再等 0.5s(旧1s), 循环判断快退出
    }
    tmark('清空筛选');
    // 新版UI: 行内无「素材ID」字段, tr/div混合 → 最小面积匹配「不可投+识别码token+视频链接」
    // ⚠️ 正则一律用 [0-9] 字符类(不用\\d), 换行用 fromCharCode —— 规避写入转义吞噬
    // 🔥 优化: 清空筛选后识别码视频必然在列表(可能在深位) → 先首屏立即查, 未命中再每屏快速增量滚(0.25s), 命中即返回。
    //    旧逻辑单一 waitFor(12s) 会干等接近超时(实测读不可投≈10s, 是S1黑洞) → 改为主动快滚, 命中即停, 不稳等。
    const fragExpr = String.raw`(() => {
      const d = [...document.querySelectorAll('.ovui-drawer')].reverse().find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes(${JSON.stringify(planId)}));
      if (!d) return null;
      let best = null;
      for (const e of d.querySelectorAll('tr,div')) {
        if (!e.offsetParent) continue;
        const t = e.innerText || '';
        // ⚠️ 2026-09-21 **用户口径**（原话：「这条不一样，不可投变成已删除了……不管是不可投还是已删除
        //    都往下走。你只要识别不可投跟已删除都是可以重建的就行」）：
        //    旧判据只认「不可投」→ 这条计划的素材终态显示「已删除」时直接 continue → 一个候选都没有
        //    → S1 报「素材识别码3次读取失败，为防误删已中止」。两种终态都代表"该素材已不可用"，
        //    对红线（识别码视频不能还在公开可投）是等价的，所以都接受；读到哪个会记进「状态」便于追溯。
        const dead = t.includes('不可投') ? '不可投' : (t.includes('已删除') ? '已删除' : null);
        if (!dead) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 200 || r.height < 20 || r.height > 130) continue;
        // ⚠️ 原来写死 /sbm[a-z]*[0-9]*/ —— 只碰巧兼容 demoA/demoB，别的号（如 demoC）会漏读
        const m = t.match(new RegExp(${JSON.stringify(FRAG_CODE_RE)}, 'i'));
        if (!m) continue;
        const a = e.querySelector('a[href*="/video/"], a[href*="aweme"]');
        const vm = a && (a.getAttribute('href') || '').match(/(?:video|aweme)\/([0-9]{10,25})/);
        const area = r.width * r.height;
        if (!best || area < best.area) best = { area, code: m[0], itemid: vm ? vm[1] : null, 状态: dead, title: t.split(${JSON.stringify('NL')}).join(' ').slice(0, 80) };
      }
      return best;
    })()`;
    // 首屏立即查(清空后"我的视频"最新在前, 识别码常在首屏)
    let mat = await waitFor(fragExpr, { timeout: 1500 });
    // 未命中 → 向下增量滚(每屏0.25s, 最多16屏), 命中即返回; 每4屏点一次「过滤不良素材」刷新兜底(防深位+慢加载)
    for (let s = 0; s < 16 && !mat; s++) {
      await ctx.js(`(() => { const d=[...document.querySelectorAll('.ovui-drawer')].reverse().find(x=>x.offsetParent&&x.getBoundingClientRect().width>400); if (!d) return false; const sc=[...d.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+100&&e.getBoundingClientRect().height>200)[0]; if (sc) sc.scrollTop += 800; return !!sc; })()`);
      await ctx.wait(0.25);
      mat = await waitFor(fragExpr, { timeout: 700 });
      if (!mat && (s + 1) % 4 === 0) {
        const filt = await ctx.js(`(() => { const d=[...document.querySelectorAll('.ovui-drawer')].reverse().find(x=>x.offsetParent&&x.getBoundingClientRect().width>400); if (!d) return false; const e=[...d.querySelectorAll('span,div,button')].find(x=>x.offsetParent&&(x.innerText||'').includes('过滤不良素材')); if (!e) return false; e.click(); return true; })()`);
        if (filt) await ctx.wait(0.8);
      }
    }
    tmark('读不可投识别码');
    // ⚠️ 留痕要**准**（同 materialReport 的 2026-09-28 修正）：只有"清空没生效 **且** 没读到识别码"才是真问题 ✓；
    //    清空没生效但读到了 ⇒ 别刷无用的告警（否则正常跑里也会误报，反而把人带偏 ✗）。
    if (!mat && !清空生效) log({ stage: 'S7清筛选未生效', ok: false, 计划: planId,
      说明: '读识别码前「投放状态」筛选没清掉 **且** 没扫到识别码行 ⇒ 候选被筛选挡住了（假阴性），不是"素材真的没有"' });
    return mat;
  };

  // 坑8/坑22: 两段确认(第二段时有时无,不出现以picker关闭为准); 坑13: 已绑定素材在picker中是禁用卡; 坑20: 抽屉动画/滚动/收敛循环
  const addVideosFromMyVideos = async (planId, opts = {}) => {
    await openMaterialDrawer(planId, opts || {});
    tmark('打开素材抽屉');
    await ctx.wait(0.8);
    const locateAdd = () => ctx.js(String.raw`(() => {
      const d = [...document.querySelectorAll('.ovui-drawer')].reverse().find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes(${JSON.stringify(planId)}));
      if (!d) return null;
      let best = null;
      for (const e of d.querySelectorAll('button,span,div')) {
        if ((e.innerText||'').trim() === '添加视频' && e.offsetParent) {
          const r = e.getBoundingClientRect();
          const area = r.width * r.height;
          if (!best || area < best.area) best = { el: e, area };
        }
      }
      if (!best) return null;
      best.el.scrollIntoView({ block: 'center' });
      const r = best.el.getBoundingClientRect();
      if (r.x < 0 || r.x > (window.innerWidth - 20)) return { off: true };
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`);
    const add0 = await locateAdd();
    // ⚠️ 2026-09-22（ego 实盘）：抽屉是**从右侧滑入**的，入场动画/布局未稳定时按钮的 x 可能暂时越过视口右缘
    //    → 旧代码只测一次就抛「添加视频入口在视口外(布局异常)」，把"等一拍就好"的情况当成硬故障。
    //    改成重定位轮询（守卫保留：5 次仍不可点才报错）。
    let add = (add0 && !add0.off) ? add0 : null;
    for (let i = 0; !add && i < 5; i++) {
      if (add0 && add0.off) console.log(JSON.stringify({ stage: 'ADD_VIDEO_OFFSCREEN', attempt: i + 1, 说明: '添加视频按钮暂在视口外（抽屉入场动画/布局未稳）→ 等一拍重定位' }));
      await ctx.wait(1.2);
      const a = await locateAdd();
      if (a && !a.off) add = a;
    }
    if (!add) throw new Error('添加视频入口未找到/在视口外(重定位5次仍不可点)');
    // ⚠️ 服务器慢/页签后台节流时 picker 打不开: 3轮 重定位按钮→CDP点击→等弹窗, 每轮前 bringToFront
    let picker = null;
    for (let att = 0; att < 3 && !picker; att++) {
      try { await ctx.cdp('Page.bringToFront', {}); } catch (e) {}
      const a = att === 0 ? add : await locateAdd();
      if (a && !a.off) await cdpClick(a.x, a.y, 400);
      picker = await waitFor(`(() => { const d=[...document.querySelectorAll('.ovui-drawer--right')].find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes('我的视频')); return !!d; })()`, { timeout: 9000 });
      if (!picker) await ctx.wait(1.5);
    }
    if (!picker) {
      const diag = await ctx.js(`(() => ({
        drawers: [...document.querySelectorAll('[class*="drawer"]')].filter(d => d.offsetParent).map(d => String(d.className).slice(0, 60)),
        right: [...document.querySelectorAll('.ovui-drawer--right')].length,
        hasMy: (document.body.innerText||'').includes('我的视频')
      }))()`);
      throw new Error('视频选择器未打开 ' + JSON.stringify(diag));
    }
    const hasCards = await waitFor(`(() => {
      const d = [...document.querySelectorAll('.ovui-drawer--right')].find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes('我的视频'));
      return d ? [...d.querySelectorAll('.oc-create-material-card-wrapper')].filter(c => c.offsetParent).length : 0;
    })()`, { timeout: 10000 });
    if (!hasCards) throw new Error('选择器内无卡片(可能列表未渲染或全部禁用)');
    tmark('打开我的视频选择器');
    const cards = await ctx.js(String.raw`(() => {
      const d = [...document.querySelectorAll('.ovui-drawer--right')].find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes('我的视频'));
      const cs = [...(d ? d.querySelectorAll('.oc-create-material-card-wrapper') : [])].filter(c => c.offsetParent);
      return cs.map(c => ({ id: c.getAttribute('itemid'), disabled: /disabled/.test((c.className||'').toString()), title: (c.getAttribute('title')||'').slice(0,22) }));
    })()`);
    const selectable = cards.filter(c => !c.disabled);
    log({ pickerCards: cards.length, selectableN: selectable.length, cards });
    if (!selectable.length) throw new Error('无可选卡片');
    tmark('遍历选卡');
    // 🔥 优化: 视频卡必须逐张 CDP 真实点击(dom click 只切 class 不上报), 但每张之间用 0.15s 极短间隔快连点,
    //    不再每张卡后都 wait(0.7)+re-selCount(逐张校验) — 一次把全部卡点完, 最后统一校验已选数(命中1次即可)。
    const selCount = async () => {
      const v = await ctx.js(String.raw`(() => {
        const d = [...document.querySelectorAll('.ovui-drawer--right')].find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes('我的视频'));
        const m = (d ? d.innerText : '').match(/已选[^\d]*(\d+)\//);
        return m ? +m[1] : 0;
      })()`);
      return v || 0;
    };
    const clickCard = async (id) => {
      // 🔥 2026-09-22（ego 原生优先，用户口径「有 ego 特属的方式更方便就尽量去用」）：
      //    这里原来是"快连点"坐标点击（`cdpClick(x,y,150)`，**不给 hover 过渡**）—— 实盘 S8 报
      //    `已选数不匹配: 选中2 应选3`：3 张卡连点 3 轮，总有一张点不中（首击被 hover 过渡吞掉 /
      //    坐标落在卡内的播放器层上，与 S3「首击被吞」同型）。
      //    ego 运行时里改用 `page.click(选择器)`：自带 actionability（滚动进视口 + 等稳定 + 单匹配校验 +
      //    被遮挡重试），点不中会抛错 → 下面回退原来的坐标路径，行为不变。
      if (ctx.egoClickSelector) {
        try {
          // ⚠️ 选择器必须**简单**：ego 只支持 `css=` / `text=` / 终止式 `:has-text()` / `>> nth=N` 这个子集，
          //    `:has-text("我的视频") .child` 这种"拼后代"写法会报 `Invalid locator`（2026-09-22 实测踩到）。
          //    实测 `.oc-create-material-card-wrapper[itemid="…"]` 全页唯一命中，且能真正切换勾选态。
          await ctx.egoClickSelector('.oc-create-material-card-wrapper[itemid="' + id + '"]', { label: '选素材卡 ' + id });
          return true;
        } catch (e) {
          console.log(JSON.stringify({ stage: 'EGO_PICK_FALLBACK', ok: false, id, err: String(e.message || e).slice(0, 110), 说明: 'ego 原生点击失败 → 回退坐标点击' }));
        }
      }
      const pos = await ctx.js(String.raw`(() => {
        const d = [...document.querySelectorAll('.ovui-drawer--right')].find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes('我的视频'));
        const c = [...(d ? d.querySelectorAll('.oc-create-material-card-wrapper') : [])].find(x => (x.getAttribute('itemid')||'') === ${JSON.stringify(id)});
        if (!c) return null;
        c.scrollIntoView({ block: 'center' });
        let p = c.parentElement;
        for (let i = 0; p && i < 8; i++, p = p.parentElement) {
          if (p.scrollHeight > p.clientHeight + 10) p.scrollTop = c.offsetTop - p.clientHeight / 2;
        }
        const r = c.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + Math.min(r.height/2, 150)) };
      })()`);
      if (!pos) return false;
      await cdpClick(pos.x, pos.y, 150, 500); // 坐标兜底：给 hover 过渡留时间（首击被吞的老坑）
      return true;
    };
    // 快连点全部卡(不限轮次, 直到已选数达标或全部尝试完); 每轮内部依次点所有卡, 只做一次最终校验
    for (let pass = 0; pass < 3; pass++) {
      for (const card of selectable) await clickCard(card.id);
      await ctx.wait(0.3);
      if ((await selCount()) >= selectable.length) break;
    }
    const sel = await ctx.js(String.raw`(() => {
      const d = [...document.querySelectorAll('.ovui-drawer--right')].find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes('我的视频'));
      const m = (d ? d.innerText : '').match(/已选[^\d]*(\d+)\//);
      return m ? +m[1] : null;
    })()`);
    if (sel !== selectable.length) throw new Error('已选数不匹配: 选中' + sel + ' 应选' + selectable.length);
    const ok1 = await waitFor(String.raw`(() => {
      const d = [...document.querySelectorAll('.ovui-drawer--right')].find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes('我的视频'));
      if (!d) return null;
      const b = [...d.querySelectorAll('button')].find(x => (x.innerText||'').trim() === '确定');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`, { timeout: 8000 });
    if (!ok1) throw new Error('pick确定未找到');
    // ⚠️ 2026-09-22（ego 实盘：S4 连续两次 `picker未关闭`）：这两处「确定」原来都是**坐标点击**，
    //    在 ego 上会"点了但抽屉不关"（同 S8 那个坑）⇒ 优先 ego 原生 click，失败再回退坐标。
    let _c1 = false;
    if (typeof ctx.egoClickSelector === 'function') {
      for (const sel of ['.ovui-drawer--right button:has-text("确定")', 'button:has-text("确定")']) {
        try { await ctx.egoClickSelector(sel, { timeout: 4000, label: '素材抽屉·确定' }); _c1 = true; break; } catch (e) {}
      }
    }
    if (!_c1) await cdpClick(ok1.x, ok1.y);
    const ok2 = await waitFor(String.raw`(() => {
      const m = [...document.querySelectorAll('[class*="modal"],[class*="dialog"],[role="dialog"]')]
        .find(e => e.offsetParent && (e.innerText||'').includes('确认添加并开始投放'));
      if (!m) return null;
      const b = [...m.querySelectorAll('button')].find(x => x.innerText.trim() === '确定');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`, { timeout: 1500 }); // ⚠️ 第二段确认时有时无: 不出现别干等(坑8)
    if (ok2) {
      let _c2 = false;
      if (typeof ctx.egoClickSelector === 'function') {
        // 二次确认弹层（"确认添加并开始投放"）里的确定：ego 下同样优先原生点击
        try { await ctx.egoClickSelector('button:has-text("确定")', { timeout: 4000, label: '确认添加·确定' }); _c2 = true; } catch (e) {}
      }
      if (!_c2) await cdpClick(ok2.x, ok2.y);
    }
    const drawerOpen = `(() => [...document.querySelectorAll('.ovui-drawer--right')].some(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes('我的视频')))()`;
    let pickerClosed = await waitFor(`(() => !${drawerOpen})()`, { timeout: 6000 });
    if (!pickerClosed) {
      // 兜底（ego 实盘）：原生再点一次确定 / 点抽屉关闭 X / Esc，任一奏效即可
      const 兜底 = [];
      if (typeof ctx.egoClickSelector === 'function') {
        for (const sel of ['.ovui-drawer--right button:has-text("确定")', 'button:has-text("确定")', '.ovui-drawer--right [class*=close]', '[class*=drawer] [aria-label*=close]']) {
          try { await ctx.egoClickSelector(sel, { timeout: 3000, label: '关抽屉兜底' }); 兜底.push(sel); } catch (e) {}
          const okNow = await ctx.js(`(() => !${drawerOpen})()`);
          if (okNow) break;
        }
      }
      if (typeof ctx.pressKey === 'function') { try { await ctx.pressKey('Escape'); } catch (e) {} }
      await ctx.wait(1);
      pickerClosed = await waitFor(`(() => !${drawerOpen})()`, { timeout: 6000 });
      log({ stage: pickerClosed ? 'S4关抽屉兜底生效' : 'S4关抽屉兜底未生效', 试过: 兜底 });
    }
    if (!pickerClosed) throw new Error('picker未关闭');
    tmark('选择器关闭确认');
    return { selected: selectable.length };
  };

  // ---------- 建计划(S4) ----------
  const createPlan = async (noteA) => {
    // 🎯 目标 ROI 的**唯一判据**（别在这儿再写一遍 ✗）：
    //   ① 旧计划**当前**的 ROI 目标（人后期在千川改过的 ⇒ 重建必须认它 ✓）
    //   ② 没有 ① 才映射：保本 × 0.4（用户 2026-09-27 定的 4/10）
    const ROI判 = resolveRoi({ 当前目标: noteA && noteA.targetRoi, 保本: noteA && noteA.roi, 人工覆盖: noteA && noteA.roiOverride, 名字目标: noteA && noteA.名字目标 });
    const 目标ROI = String(ROI判.值 || (noteA && noteA.roi) || '1.40');
    if (noteA) { noteA.目标ROI = 目标ROI; noteA.ROI来源 = ROI判.来源; }   // 📌 留痕：status/日志/台账都看得到 ✓
    if (typeof console !== 'undefined') console.log('  [ROI] 用 ' + 目标ROI + '（来源：' + ROI判.来源 + '）');
    // 省时: 直接URL进创建页(原先先回列表页再跳创建页 = 多一次整页刷新)
    // 1) 直接URL进入「投放商品」创建页(路由等价 控成本切换+投放商品tab; 同站tab复用刷新)
    // ⏱ 2026-09-22 优化 #1（S4 进创建页实测 21.7s）：只等 DOM 就绪，不等整页 load ——
    //    千川创建页 JS 很重，而下面本来就会 waitFor「uni-creation」路由与表单元素（判据自己会轮询）。
    await ctx.gotoAndWait('https://qianchuan.jinritemai.com/uni-creation/product?aavid=' + CONST.ACCOUNT_ID + '&enter_from_inside=promotion_uni_header_create', { timeout: 25, waitUntil: 'domcontentloaded' });
    await dismissModals();
    await dismissAuthModals();   // 🔥 授权申请/确认后的「我知道了」「恭喜…创建商品全域计划」浮层会挡住创建页
    const created = await waitFor(`(() => location.href.includes('uni-creation'))()`, { timeout: 15000 });
    if (!created) throw new Error('未进入创建页');
    await ctx.wait(1.2);
    tmark('进入创建页');

    // 2) 抖音号(轮询等待 chip 渲染; 当前默认号不固定(沐尘/汐鑫/<旧直投号>…), 一律重选<旧直投号>)
    // ⚠️ 两段确认 + 窗口焦点坑: 失焦时下拉开了即关——先 Page.bringToFront 再点;
    //    下拉面板类名是 ovui-select__popper/oc-select__popover(不含popup/dropdown!), 以可见 .ovui-option 数为开合判据;
    //    ⚠️chip 回显bug(SOP): 不更新显示但已生效——以「修改抖音号」弹窗确认为准, 不做 chip 文本校验,
    //    真实账号由发布前【全字段终检】账号字段兜底(不符即停)
    await ctx.cdp('Page.bringToFront', {});
    await ctx.wait(0.5);
    let chipOk = false;
    for (let attempt = 0; attempt < 3 && !chipOk; attempt++) {
      const pre = await ctx.js(`(() => { const e = document.querySelector('.qc-ui-aweme-choose'); return e ? (e.innerText||'') : ''; })()`);
      if (pre.includes(CONST.AWEME_NAME) || pre.includes(String(CONST.AWEME_ID))) { console.log('  [抖音号] chip已是目标号, 免切换'); chipOk = true; break; }
      // 点选择框本体(.ovui-custom-input__content 中心; ⚠️整行 oc-select 宽968 其中心落在框外空白!)
      const chipPos = await waitFor(`(() => {
        const root = document.querySelector('.qc-ui-aweme-choose');
        if (!root || !root.offsetParent) return null;
        const e = root.querySelector('.ovui-custom-input__content') || root.querySelector('.ovui-custom-input');
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return r.width > 0 ? { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) } : null;
      })()`, { timeout: 2000 });
      if (!chipPos) throw new Error('抖音号chip未找到');
      await cdpClick(chipPos.x, chipPos.y, 300);
      const optN = await waitFor(`(() => [...document.querySelectorAll('.ovui-option')].filter(e => e.offsetParent).length)()`, { timeout: 5000 });
      if (!optN) { console.log('  [抖音号] attempt' + (attempt + 1) + ' 下拉未开'); continue; }
      // 选项: 按抖音号ID匹配(选项文本含 ID:xxx; 列表深处选项 offsetParent 也非空, ego同款), CDP 点击其中心
      const opt = await waitFor(String.raw`(() => {
        const o = [...document.querySelectorAll('.ovui-option')].filter(e => e.offsetParent && (e.innerText||'').includes(${JSON.stringify(CONST.AWEME_ID)}) || (e.innerText||'').includes(${JSON.stringify(CONST.AWEME_NAME)}));
        if (!o.length) return null;
        const e = o[0];
        e.scrollIntoView({ block: 'center' });
        const r = e.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      })()`, { timeout: 8000 });
      if (!opt) {
        const info = await ctx.js(`(() => [...document.querySelectorAll('.ovui-option')].filter(e => e.offsetParent).slice(0,4).map(o => (o.innerText||'').split(String.fromCharCode(10)).join('|').slice(0,24)))()`);
        console.log('  [抖音号] attempt' + (attempt + 1) + ' 无ID选项:', JSON.stringify(info));
        await ctx.pressKey('Escape');
        continue;
      }
      await cdpClick(opt.x, opt.y, 400);
      // 两段确认:「确认要修改抖音号吗?」弹窗 → 确定(CDP 点击按钮中心)
      const dlg = await waitFor(String.raw`(() => {
        const m = [...document.querySelectorAll('[class*="modal"],[class*="dialog"],[role="dialog"]')]
          .find(e => e.offsetParent && /修改.*抖音号/.test(e.innerText||''));
        if (!m) return null;
        const b = [...m.querySelectorAll('button')].find(x => { const t = (x.innerText||'').trim(); return t === '确定' || t === '确认'; });
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      })()`, { timeout: 8000 });
      if (dlg) await cdpClick(dlg.x, dlg.y);
      await ctx.wait(1.2);
      console.log('  [抖音号] attempt' + (attempt + 1) + ' 弹窗确认:', !!dlg);
      chipOk = !!dlg;
    }
    if (!chipOk) {
      const cur = await ctx.js(`(() => { const e = document.querySelector('.qc-ui-aweme-choose'); return e ? (e.innerText||'').replace(/\\s+/g,' ').slice(0,40) : '?'; })()`);
      throw new Error('抖音号切换未生效, 当前chip: ' + cur);
    }
    tmark('选择抖音号');

    // 3) 添加商品(省时三档): ①草稿恢复已含目标商品→整段跳过(千川会恢复未发布草稿);
    //    ②picker默认列表直取(最近投放的商品常在首屏, 免搜索); ③搜索兜底
    // ⚠️ 行判定: ID 全局唯一 + 容器限定 + 可勾选, 不再要求价格文本(窄版布局价格可能不渲染)
    const prowExpr = String.raw`(() => {
      const d = [...document.querySelectorAll('.ovui-drawer, .ovui-modal, [class*="drawer"], [class*="product-list"]')]
        .find(x => x.offsetParent && x.getBoundingClientRect().width > 300 && (x.innerText||'').includes('商品信息'));
      const scope = d || document;
      const e = [...scope.querySelectorAll('div')].find(x => x.offsetParent && (x.innerText||'').length > 5 && (x.innerText||'').length < 150 && [...x.querySelectorAll('[class*="checkbox"], [class*="radio"]')].some(cc => cc.offsetParent && cc.getBoundingClientRect().width < 60 && cc.getBoundingClientRect().y > 200 && !(cc.closest('div,tr') || {innerText:''}).innerText.includes('只看未投放') && !(cc.closest('div,tr') || {innerText:''}).innerText.includes('全选')));
      return e ? true : null;
    })()`;
    let addDone = !!(await ctx.js(`(() => {
      const i = document.body.innerText.indexOf('选择要投放的商品');
      if (i < 0) return null;
      const m = document.body.innerText.slice(i, i + 400).match(/已添加[：:]\\s*([0-9]+)\\/30/);
      return m && +m[1] >= 1 ? true : null; // 单产品账户: 表单已有商品=就是它, 不比对ID
    })()`));
    if (addDone) console.log('  [添加商品] 表单已含目标商品(草稿恢复), 跳过picker');
    if (!addDone) {
      const addP = await locateByText('添加商品', { exact: true, minY: 150 });
      if (!addP) throw new Error('添加商品按钮未找到');
      await cdpClick(addP.x, addP.y);
      // 新UI: picker默认视图为空 → 点「查看全部可投商品」加载列表
      await ctx.wait(0.9);
      await ctx.js(String.raw`(() => {
        const dd = [...document.querySelectorAll('.ovui-drawer, [class*="drawer"], [class*="modal"]')].reverse().find(x => x.offsetParent && (x.innerText||'').includes('商品'));
        if (!dd) return false;
        const e = [...dd.querySelectorAll('span,div,button,a')].find(x => x.offsetParent && (x.innerText||'').includes('查看全部可投商品'));
        if (e) { e.click(); return true; }
        return false;
      })()`);
      // 🔥 优化: 旧逻辑这里硬等 1.5s, 但下面 waitFor(20s) 本身会轮询, 前面只稍等 0.4s 让 picker 渲染即可
      await ctx.wait(0.4);
      // ② 默认列表直取: 3.5s 拿不到再走搜索路径
      // 用户指令: 单产品账户不需要ID搜索 — 查看全部后耐心等行出现(15s), 彻底去掉搜索兜底
      const rowReady = await waitFor(prowExpr, { timeout: 20000 });
      if (!rowReady) throw new Error('商品行未找到(picker内无结果)');
    }
    if (!addDone) {
    // ⚠️ 多商品账户防错选: 目标商品ID已知(旧计划捕获/配置)时必须按ID匹配卡片;
    //    找不到目标ID就直接中止(宁可不选也不错选其他商品)。ID未知才维持旧的"第一卡片"行为并告警。
    const wantPid = String(CONST.PRODUCT_ID || '');
    const wantTitle = String(CONST.PRODUCT_TITLE || '').slice(0, 14);
    const wantImg = String(CONST.PRODUCT_IMG || '');
    // ⚠️ 多商品: 弹窗搜索框按商品ID过滤(S1已捕获), 精确定位; 无搜索框则按标题/图hash匹配; ID未知才允许第一卡片
    let searchRan = false;
    if (wantPid) {
      const sb = await waitFor(String.raw`(() => {
        const d = [...document.querySelectorAll('.ovui-drawer, [class*="drawer"]')].reverse().find(x => x.offsetParent && x.getBoundingClientRect().width > 300 && (x.innerText||'').includes('商品信息'));
        if (!d) return null;
        const i = [...d.querySelectorAll('input')].find(x => x.offsetParent && /商品|名称|ID|搜索/i.test(x.placeholder || ''));
        if (!i) return null;
        i.scrollIntoView({ block: 'center' });
        const r = i.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      })()`, { timeout: 4000 });
      if (sb) {
        await cdpClick(sb.x, sb.y, 250);
        await ctx.wait(0.4);
        await ctx.js(String.raw`(() => {
          const d = [...document.querySelectorAll('.ovui-drawer, [class*="drawer"]')].reverse().find(x => x.offsetParent && x.getBoundingClientRect().width > 300 && (x.innerText||'').includes('商品信息'));
          const i = d && [...d.querySelectorAll('input')].find(x => x.offsetParent && /商品|名称|ID|搜索/i.test(x.placeholder || ''));
          if (!i) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(i, ${JSON.stringify(wantPid)});
          i.dispatchEvent(new Event('input', { bubbles: true }));
          i.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
        await ctx.pressKey('Enter');
        await ctx.wait(0.8); // 🔥 优化: 旧逻辑硬等 2s, 但下面 waitFor(6s)已轮询, 等 0.8s 让搜索结果渲染即可
        searchRan = true;
        console.log('  [添加商品] 已按商品ID搜索: ' + wantPid);
      }
    }
    const matchClick = async (clickMode) => ctx.js(String.raw`(() => {
      const mode = ${JSON.stringify(clickMode)};
      const want = ${JSON.stringify(wantPid)};
      const wantT = ${JSON.stringify(wantTitle)};
      const wantI = ${JSON.stringify(wantImg)};
      const searchRan = ${JSON.stringify(searchRan)};
      const d = [...document.querySelectorAll('.ovui-drawer, [class*="drawer"]')].reverse().find(x => x.offsetParent && x.getBoundingClientRect().width > 300 && (x.innerText||'').includes('商品信息'));
      if (!d) return { m: 'no-drawer' };
      // ⚠️ 2026-09-12 放宽（对齐重建路径的容错）：原判据多了「y > 150」且长度 < 200，
      //    新 UI 的商品卡片（含"暂无…全域投放权限（商品所属店铺：X）"提示）会超 200 字 → 被判成 no-card。
      const cards = [...d.querySelectorAll('div,[class*="oc-card"]')].filter(x => x.offsetParent && x.querySelector('.ovui-checkbox')
        && !/只看未投放|全选|投放账户内/.test(x.innerText||'') && (x.innerText||'').trim().length > 5 && (x.innerText||'').length < 400);
      if (!cards.length) return { m: 'no-card' };
      const imgHash = (c) => { const i = [...c.querySelectorAll('img')].map(x => x.src || '').find(s => s.includes('ecom-shop-material')); const m = i ? (i.match(/(?:jpeg|png|webp)_m_([0-9a-f]+)/i) || [])[1] : ''; return m || ''; };
      let hit = null, how = '';
      if (want) { hit = cards.find(c => (c.innerHTML || '').includes(want) || (c.getAttribute('itemid') || '') === want); if (hit) how = 'pid'; }
      if (!hit && wantT) { hit = cards.find(c => (c.innerText || '').includes(wantT)); if (hit) how = 'title'; }
      if (!hit && wantI) { hit = cards.find(c => imgHash(c) === wantI); if (hit) how = 'img'; }
      if (!hit && searchRan && want) { hit = cards[0]; how = 'search-filtered'; }
      if (!hit && !want && !searchRan) { hit = cards[0]; how = 'first(无目标ID)'; }
      if (!hit) return { m: 'none', titles: cards.slice(0, 4).map(c => (c.innerText || '').slice(0, 18)) };
      hit.scrollIntoView({ block: 'center' });
      // ⚠️ 2026-09-12 与 m4 同一个坑（用户实测："你没选商品 已选永远是 0/30"）：
      //    商品卡片里有两个复选框 ——「只看未投放商品」（筛选，默认勾上）和**商品行自己的**（在 .product-info 内）。
      //    取第一个 = 点到筛选框 → 已选恒 0/30。这里只认 .product-info 内的那个。
      const box = hit.querySelector('.product-info .ovui-checkbox__wrapper')
             || hit.querySelector('.product-info .ovui-checkbox')
             || hit.querySelector('.product-info input[type="checkbox"]')
             || hit.querySelector('.ovui-checkbox__wrapper')
             || hit.querySelector('.ovui-checkbox');
      // ⚠️ 2026-09-12 实测：这个 React 勾选框**不认 DOM 合成点击**（box.click() 无效），
      //    只认真实鼠标点击；而且勾选框在行**最右侧**（实测 x=911），
      //    原来 coords 用"卡片左边 + 40"完全点错位置。⇒ 一律走真实鼠标点击，坐标取勾选框自己的中心。
      const br = box ? box.getBoundingClientRect() : hit.getBoundingClientRect();
      return { m: how, x: Math.round(br.x + br.width / 2), y: Math.round(br.y + br.height / 2),
               目标: box ? (box.className || '').toString().slice(0, 40) : '(无勾选框→点卡片)' };
    })()`);
    let pick = await matchClick('coords');   // 直接取坐标 → CDP 真实鼠标点击（DOM click 不生效）
    if (pick && pick.m === 'no-card') pick = await matchClick('coords');
    if (!pick || pick.m === 'no-drawer' || pick.m === 'no-card') throw new Error('商品卡片未定位');
    if (pick.m === 'none') throw new Error('目标商品未在picker中找到: ID=' + (wantPid || '无') + ' 标题=' + (wantTitle || '无') + ' | 弹窗内有: ' + (pick.titles || []).join(' / ') + ' — 防错选中止');
    if (pick.x != null) await cdpClick(pick.x, pick.y, 400);
    console.log('  [添加商品] 已选商品(匹配: ' + pick.m + ')');
    // ⚠️ 2026-09-12 与 m4 同一个坑：平台有**两套抽屉 UI** ——
    //    卡片版有「已选 N/30」；**表格版没有这个计数**（只有页面「已添加：0/30」，点确定后才更新）。
    //    死等"已选计数"会把明明勾上的判成失败（实测：复选框已 true 却报"勾选未生效"）。
    //    ⇒ 判据 = 「已选计数 > 0」**或**「商品行勾选框已勾上」。
    const readSel = () => waitFor(String.raw`(() => { const m = document.body.innerText.match(/已选\s*(\d+)\/30/); return m ? +m[1] : null; })()`, { timeout: 6000 });
    const readChecked = () => ctx.js(`(() => {
      const PID = ${JSON.stringify(CONST.PRODUCT_ID)};
      const d = [...document.querySelectorAll('.ovui-drawer, .ovui-modal, [class*="drawer"]')]
        .find(x => x.offsetParent && x.getBoundingClientRect().width > 300 && (x.innerText || '').includes(PID));
      if (!d) return null;
      const cards = [...d.querySelectorAll('div,tr')].filter(x => x.offsetParent && (x.innerText || '').includes(PID) && x.querySelector('input[type="checkbox"]'));
      cards.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      const card = cards[0]; if (!card) return null;
      const inp = card.querySelector('.product-info input[type="checkbox"]') || card.querySelector('input[type="checkbox"]');
      return inp ? !!inp.checked : null;
    })()`);
    let selCount = await readSel();
    let checked = await readChecked();
    for (let g = 0; g < 3 && !(selCount > 0 || checked === true); g++) {
      const pc2 = await matchClick('coords');
      if (pc2 && pc2.x != null) { await cdpClick(pc2.x, pc2.y, 450); await ctx.wait(1.2); }
      selCount = await readSel();
      checked = await readChecked();
    }
    if (!(selCount > 0 || checked === true)) throw new Error('勾选未生效(已选计数未出现且勾选框未勾上; 已选=' + selCount + ' 勾选=' + checked + ')');
    console.log('  [添加商品] 勾选已生效(已选=' + selCount + ' 勾选=' + checked + ')');
    // 「确定」限定在 picker 容器内
    // 🔥 2026-09-14 重写：原来"找不到容器就 scope=document，取最后一个确定" → **会点到页面右下角的
    //    「智投星」悬浮球**（用户截图指出），点了它选择不会提交(已添加仍 0/30)。
    //    新判据：**以「取消」为锚点** —— picker 的确定必然在取消右侧、同一行(y 差 < 24)。
    const okP = await waitFor(String.raw`(() => {
      const vis = (e) => e.offsetParent && e.getBoundingClientRect().width > 20 && e.getBoundingClientRect().height > 10;
      const btns = [...document.querySelectorAll('button')].filter(vis);
      const cancels = btns.filter(x => /^取\s*消$/.test((x.innerText || '').trim()));
      const confirms = btns.filter(x => /^(确\s*定|确\s*认)$/.test((x.innerText || '').trim()));
      if (!confirms.length) return null;
      for (const c of cancels) {
        const cr = c.getBoundingClientRect();
        const near = confirms.filter((x) => { const r = x.getBoundingClientRect();
          return r.left > cr.left && Math.abs((r.top + r.height/2) - (cr.top + cr.height/2)) < 24; })
          .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
        if (near) { const r = near.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), 判据: '取消右侧同行的确定' }; }
      }
      // 没有取消按钮时：取"包含「已选 N/30」的最小容器"里的确定，仍不退化到全页
      const holders = [...document.querySelectorAll('div,section,footer')].filter(x => vis(x) && /已选\s*\d+\s*\/\s*30/.test(x.innerText || ''))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      for (const h of holders) {
        const b = [...h.querySelectorAll('button')].filter(x => vis(x) && /^(确\s*定|确\s*认)$/.test((x.innerText || '').trim()));
        if (b.length) { const r = b[b.length - 1].getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), 判据: '已选计数容器内' }; }
      }
      return null;   // ⛔ 绝不退化到"全页最后一个确定"
    })()`, { timeout: 6000 });
    if (!okP) throw new Error('商品picker确定未找到(已拒绝"全页取最后一个确定"的兜底, 防误点智投星)');
    console.log('  [添加商品] 点确定 @' + okP.x + ',' + okP.y + ' (' + okP.判据 + ')');
    await cdpClick(okP.x, okP.y);
    const addedOK = await waitFor(String.raw`/已添加[：:]\s*1\/30/.test(document.body.innerText) ? true : null`, { timeout: 8000 });
    if (!addedOK) {
      const cur = await ctx.js(`(() => (document.body.innerText.match(/已添加[：:]\\s*\\d+\\/30/)||[])[0] || '无计数')()`);
      throw new Error('商品未入库(已添加未出现, 当前: ' + cur + ')');
    }
    } // end if(!addDone)
    tmark('添加商品');

    // 4) 表单内切控成本(坑5; ⚠️原版waitFor结果未检查=静默超时, 且需bringToFront)
    await ctx.cdp('Page.bringToFront', {});
    await ctx.wait(0.5);
    const ck = await waitFor(`(() => {
      const r = [...document.querySelectorAll('.ovui-radio-item, [class*="radio-item"]')].find(e => e.offsetParent && (e.innerText||'').trim().indexOf('控成本投放') === 0);
      if (!r) return null;
      const b = r.getBoundingClientRect();
      return { x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2) };
    })()`, { timeout: 8000 });
    if (!ck) throw new Error('表单内控成本radio未找到');
    let ckOk = null;
    for (let n = 0; n < 2 && !ckOk; n++) {
      await cdpClick(ck.x, ck.y, 400);
      ckOk = await waitFor(`(() => {
        const r = [...document.querySelectorAll('.ovui-radio-item')].find(e => e.offsetParent && (e.innerText||'').trim() === '控成本投放');
        return r && String(r.className).includes('checked') ? true : null;
      })()`, { timeout: 5000 });
      if (!ckOk) {
        // ⚠️ 兜底也必须点 item 本身(用 includes 会匹配到 radio-group 容器, 点了无效)
        await ctx.js(`(() => { const r=[...document.querySelectorAll('.ovui-radio-item')].find(e => e.offsetParent && (e.innerText||'').trim() === '控成本投放'); if (r) { r.click(); return true; } return false; })()`);
        ckOk = await waitFor(`(() => {
          const r = [...document.querySelectorAll('.ovui-radio-item')].find(e => e.offsetParent && (e.innerText||'').trim() === '控成本投放');
          return r && String(r.className).includes('checked') ? true : null;
        })()`, { timeout: 5000 });
      }
    }
    if (!ckOk) throw new Error('表单内切控成本未生效');
    // 🔥 2026-09-13 清理静默超时(原 8s 未检查): 这是"等表单切完渲染出预算/ROI"的礼貌等待;
    //    真找不到会由下面 ROI 双模式 + 发布前八项终检拦住 → 收到 4s 并检查。
    const formReady = await waitFor(`(() => { const t=document.body.innerText; return t.includes('净成交ROI目标') && t.includes('日预算'); })()`, { timeout: 4000 });
    if (!formReady) console.log('  [切控成本] 4s 内未见到「净成交ROI目标/日预算」, 继续(下面 ROI 双模式会报错)');
    tmark('切控成本');

    // 5) 预算 + ROI(坑18: ROI锚定标签就近; 预算填后校验生效)
    // ⛔ 2026-10-22 千川改版（实盘 plan 3000000000000000103）：控成本表单里 **ROI 目标框渲染在「投放日预算」上面**
    //    ⇒ 旧写法 `fillNative('input.ovui-input[placeholder="请输入"]')`（**取第一个**）把预算写进了 ROI 框，
    //      紧接的 ROI 步骤又把同一个框覆盖成目标值 ⇒ 终检「预算」**永远 false**（"预算未填入/预算 未通过" 连报 2 轮）✗
    //    ⇒ 取框判据收到**唯一一处**：先按「净成交ROI目标」标签就近认出 ROI 框，**剩下的最后一个才是日预算框** ✓
    const 期望预算 = String(noteA.budget || 300);
    // 🎯 「日预算 / ROI 目标」两个 `请输入` 输入框的**唯一取法**（改版后禁止再"取第一个" ✗）
    const 预算框JS = (动作) => String.raw`(() => {
      const 候选 = [...document.querySelectorAll('input.ovui-input')].filter(i => i.offsetParent && i.placeholder === '请输入');
      const lab = [...document.querySelectorAll('div,span,label')].find(e => e.offsetParent && (e.innerText||'').trim() === '净成交ROI目标');
      let roi = null;
      if (lab) { const lr = lab.getBoundingClientRect();
        roi = 候选.find(i => { const r = i.getBoundingClientRect();
          return Math.abs((r.x + r.width/2) - (lr.x + lr.width/2)) < 300 && Math.abs(r.y - (lr.y + lr.height/2)) < 60; }) || null; }
      const 其余 = 候选.filter(i => i !== roi);
      const 预算 = 其余.length ? 其余[其余.length - 1] : null;
      if (!预算) return { ok: false, 原因: '没认出日预算框', 候选数: 候选.length, 有ROI框: !!roi };
      ${动作}
    })()`;
    const 填预算 = await ctx.js(预算框JS(String.raw`
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(预算, ${JSON.stringify(期望预算)});
      预算.dispatchEvent(new Event('input', { bubbles: true }));
      预算.dispatchEvent(new Event('change', { bubbles: true }));
      const r = 预算.getBoundingClientRect();
      return { ok: 预算.value === ${JSON.stringify(期望预算)}, 值: 预算.value, 盒: [Math.round(r.x), Math.round(r.y)], 候选数: 候选.length, 有ROI框: !!roi };`));
    console.log('  [预算] 填 ' + 期望预算 + ' ⇒ ' + JSON.stringify(填预算));
    const bvOk = await waitFor(预算框JS(String.raw`return 预算.value === ${JSON.stringify(期望预算)} ? true : null;`), { timeout: 5000 });
    if (!bvOk) throw new Error('预算未填入(' + JSON.stringify(填预算) + ')');
    // ROI 双模式: 原生UI=请输入(标签就近); 插件版=倍数+确认按钮行。先原生, 失败再插件版
    const roiInp = await waitFor(String.raw`(() => {
      const label = [...document.querySelectorAll('div,span')].find(e => e.offsetParent && (e.innerText||'').trim() === '净成交ROI目标');
      if (!label) return null;
      const lr = label.getBoundingClientRect();
      const list = [...document.querySelectorAll('input.ovui-input')].filter(i => i.offsetParent && i.placeholder === '请输入');
      const roi = list.find(i => { const r = i.getBoundingClientRect();
        return Math.abs((r.x + r.width/2) - (lr.x + lr.width/2)) < 300 && Math.abs(r.y - (lr.y + lr.height/2)) < 60; });
      if (!roi) return null;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(roi, ${JSON.stringify(目标ROI)});
      roi.dispatchEvent(new Event('input', { bubbles: true }));
      roi.dispatchEvent(new Event('change', { bubbles: true }));
      return roi.value;
    })()`, { timeout: 6000 });
    let roiDone = roiInp || null;
    if (!roiDone) {
      const roiRow = await ctx.js(`(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.offsetParent && (b.innerText||'').trim() === '确认');
        if (!btn) return null;
        let row = btn.parentElement, inp = null;
        for (let k = 0; k < 5 && row && !inp; k++) { inp = row.querySelector('input'); if (inp) break; row = row.parentElement; }
        if (!inp) return null;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(inp, ${JSON.stringify(目标ROI)});
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return inp.value;
      })()`);
      if (!roiRow) throw new Error('ROI输入框未找到(双模式均失败)');
      const roiBtn = await ctx.js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.offsetParent && (b.innerText||'').trim() === '确认'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; })()`);
      if (!roiBtn) throw new Error('ROI确认按钮未找到');
      await cdpClick(roiBtn.x, roiBtn.y, 400);
      await ctx.wait(1.0);
      roiDone = roiRow;
    }
    if (roiDone !== 目标ROI) throw new Error('ROI设置未生效: ' + roiDone);
    tmark('预算+ROI');

    // 6) 自选投放素材
    const t6s = Date.now();   // 🔥 省时排查(2026-09-12): ⑥ 稳定 14.7~15.2s, 疑似有"结果未检查"的固定超时干等 → 先分解计时
    // 🔧 2026-09-14: 断点续跑落在**带草稿的创建页**时，页面滚动位置与首次不同 → 原来的 minY:900 会把
    //    "已经在视口里但 y<900" 的卡片判成找不到（实跑秒挂「自选投放素材卡未找到」）。
    //    改成: 先按原判据 → 不行就回页首、放宽 minY 再试两次。
    let zone = await locateByText('自选投放素材', { exact: true, minY: 900 });
    if (!zone) {
      try { await ctx.js('window.scrollTo(0, 0)'); } catch (e) {}
      await ctx.wait(0.8);
      for (let z = 0; z < 2 && !zone; z++) {
        zone = await locateByText('自选投放素材', { exact: true, minY: 0 });
        if (!zone) await ctx.wait(1.2);
      }
      if (zone) console.log('  [⑥] 自选投放素材: 放宽 minY 后命中');
    }
    if (!zone) throw new Error('自选投放素材卡未找到');
    // 🔧 2026-09-14: 断点续跑落在带草稿的创建页时，**素材区可能本来就是展开的** —— 再点一次标题会把它
    //    **折叠**回去(实跑症状: 点完就报「素材区选择商品未找到」)。所以: 已经能看到「选择商品」就别点;
    //    点完若 2.5s 内仍看不到, 就再点一次(切回来)重试, 最多 3 轮。
    const hasSelect = () => ctx.js(`(() => [...document.querySelectorAll('.ovui-input__prefix, .ovui-select, [class*="select"]')].some(e => e.offsetParent && /^\\s*选择商品/.test((e.innerText||'').trim())))()`);
    let alreadyOpen = false;
    try { alreadyOpen = !!(await hasSelect()); } catch (e) {}
    if (alreadyOpen) console.log('  [⑥] 素材区已展开(草稿恢复) → 不再点标题(避免折叠)');
    else {
      for (let z = 0; z < 3; z++) {
        await cdpClick(zone.x, zone.y);
        await ctx.wait(1.2);
        try { if (await hasSelect()) { if (z) console.log('  [⑥] 第' + (z + 1) + '次点标题后素材区展开'); break; } } catch (e) {}
        // 没展开 → 可能刚被点折叠了/没点中, 重新定位再点
        const z2 = await locateByText('自选投放素材', { exact: true, minY: 0 });
        if (z2) { zone = z2; }
        await ctx.wait(0.8);
      }
    }
    // 🔥 2026-09-13 清理静默超时(原 8s 未检查): 实测这步 382ms 就命中; 未就绪也不阻塞 —— 下面开浮层
    //    本来就有 3 次重试兜住 → 收到 3s 并检查。
    const areaReady = await waitFor(`(() => { const txt=document.body.innerText; return txt.includes('选择要添加素材的商品') && txt.includes('添加视频'); })()`, { timeout: 3000 });
    if (!areaReady) console.log('  [⑥] 素材区文案 3s 未就绪 → 继续(开浮层的 3 次重试兜底)');
    const t6a = Date.now();

    // 7) 素材区选择商品
    // ⚠️ 比特特有: 打开浮层 CDP 坐标点击不可靠(ego能开,比特不开)→未开时 DOM click 兜底;
    //    行选择必须 CDP 真实点击(DOM click 只切 checked class 不上报组件)
    const sp = await waitFor(String.raw`(() => {
      const t = [...document.querySelectorAll('.ovui-input__prefix, .ovui-select, [class*="select"]')].filter(e => e.offsetParent && /^\s*选择商品/.test((e.innerText||'').trim())).sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length)[0];
      if (!t) return null;
      const selNode = t.closest('.ovui-select') || t.parentElement;
      selNode.scrollIntoView({ block: 'center' });
      const r = selNode.getBoundingClientRect();
      return { x: Math.round(r.x + Math.min(r.width/2, 200)), y: Math.round(r.y + r.height/2) };
    })()`, { timeout: 8000 });
    if (!sp) throw new Error('素材区选择商品未找到');
    await ctx.cdp('Page.bringToFront', {});
    await ctx.wait(0.3); // 🔥 优化: bringToFront后等 0.3s(旧0.5s)
    let sopt = null;
    // 🔥 2026-09-12 实测: 纯 DOM click 打不开浮层(第 1 次尝试必超时白等 3.5s), CDP 坐标点+DOM 兜底才打得开。
    //    两跑都是"第 2 次尝试命中、命中后行渲染仅 ~0.7s" —— 证明那 3.5s 是【白等重试】, 不是服务端慢。
    //    故把两条路子对调: 首试就走 CDP+DOM(验证过的那条), 纯 DOM click 退居备份。预期 ⑥ 再省 ~3s。
    const domClickSelect = () => ctx.js(String.raw`(() => {
      const t = [...document.querySelectorAll('.ovui-input__prefix, .ovui-select, [class*="select"]')].filter(e => e.offsetParent && /^\s*选择商品/.test((e.innerText||'').trim())).sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length)[0];
      if (!t) return false;
      const selNode = t.closest('.ovui-select') || t.parentElement;
      selNode.scrollIntoView({ block: 'center' });
      selNode.click();
      return true;
    })()`);
    for (let attempt = 0; attempt < 3 && !sopt; attempt++) {
      if (attempt !== 1) {
        // ✅ 主力: CDP 真实坐标点击 + DOM click 兜底(比特下 CDP 单点常打不开该组件)
        await cdpClick(sp.x, sp.y);
        await domClickSelect();
      } else {
        // 备份: 纯 DOM click
        await domClickSelect();
      }
      // 🔥 优化: 开浮层后不再固定 wait(0.9), 直接用下方 waitFor 轮询素材商品选项出现(浮层渲染即命, 不空等)
      sopt = await waitFor(String.raw`(() => {
        const pop = document.querySelector('.creative-multi-products-select');
        if (!pop || !pop.offsetParent || pop.getBoundingClientRect().width < 100) return null;
        const rows = [...pop.querySelectorAll('.ovui-option')].filter(o => o.offsetParent && o.getBoundingClientRect().width > 0 && (o.innerText||'').trim().length > 3);
        if (!rows.length) return null;
        const cb = rows[rows.length-1].querySelector('[class*="checkbox"]') || rows[rows.length-1];
        const r = cb.getBoundingClientRect();
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      })()`, { timeout: attempt === 2 ? 9000 : 3500 });   // 🔥 省时: 前两次不用等满 9s(命中即返回); 最坏 3.5+3.5+9 而非 9×3
      if (sopt) console.log('  [⑥] 浮层第 ' + (attempt + 1) + ' 次尝试命中(共等 ' + (Date.now() - t6s) + 'ms)');
    }
    const t6m = Date.now();
    if (!sopt) throw new Error('素材商品选项未找到');
    // 必须 CDP 真实点击选择(实验证实 DOM click 只切 class 不上报)
    await cdpClick(sopt.x, sopt.y, 400);
    // 🔥 优化: 确认素材商品选中收紧到 3s(旧8s) —— 没选中会抛错, 不必干等8s
    // 🔥 省时(2026-09-12 实测): 这个 waitFor 的**结果从来没被使用**(只影响"没选中"时干等), 而 2026-09-12 实测
    //    浮层选完后它稳定烧满 3s(多选浮层不关、行的 checked class 判不出来) → 收到 800ms。
    //    真没点中, 后面的硬判据会拦: 「视频 ( 1 )」/「已添加 1/30」/ 发布前八项终检, 不会静默放过。
    await waitFor(String.raw`(() => { const pop = document.querySelector('.creative-multi-products-select'); if (!pop || !pop.offsetParent) return true; const o = [...pop.querySelectorAll('.ovui-option')].find(x => x.offsetParent && String(x.className).indexOf('checked') >= 0); return o ? true : null; })()`, { timeout: 800 });
    // ↑ 结果依旧不阻塞(下方硬判据「视频(1)/已添加1/30/八项终检」会拦); 保留 800ms 只为给选中状态一点传播时间
    const t6b = Date.now();
    // ⚠️ 选完商品后, 识别码(炮灰)视频此刻刚从"公开"同步到"我的视频"列表, 还没到位。
    // 🔥 优化: 旧逻辑这里硬等 5s(不管同步快慢都死等) —— 同步快时白白浪费5s。
    //    改为不硬等: 直接打开「添加视频」选择器, 交由下方扫屏循环用 首屏轮询 + 「过滤不良素材」刷新主动等它出现,
    //    视频一到就立刻命中, 不再固定空耗5s。
    // 8) 添加视频 → 选识别码视频
    const av = await locateByText('添加视频', { exact: true, minY: 450 });
    if (!av) throw new Error('素材区添加视频未找到');
    await cdpClick(av.x, av.y);
    // 🔧 2026-09-14(用户: 网络慢/刷新慢): 判据从"必须有「我的视频」文本"放宽为 **文本 或 已渲染出素材卡**,
    //    超时 10s→18s —— 实测慢加载时标题未出但卡片已到位, 原来会误判"视频选择器未打开"。
    const picker = await waitFor(`(() => { const ds=[...document.querySelectorAll('.ovui-drawer--right, .creation-drawer-container, [class*="drawer"]')].filter(x => x.offsetParent && x.getBoundingClientRect().width > 400); if (!ds.length) return null; return ds.some(x => (x.innerText||'').includes('我的视频') || x.querySelectorAll('.oc-create-material-card-wrapper').length > 0) ? true : null; })()`, { timeout: 18000 });
    if (!picker) throw new Error('视频选择器未打开');
    tmark('选素材商品+开添加视频');
    console.log('  [⑥分解] 自选素材卡→区域文案就绪 ' + (t6a - t6s) + 'ms | 开浮层(含重试) ' + (t6m - t6a) + 'ms | 点选商品+选中确认 ' + (t6b - t6m) + 'ms | 点添加视频→抽屉打开 ' + (Date.now() - t6b) + 'ms');
    // 🔥 优化: 识别码(炮灰)视频是今天刚发布 → 在「我的视频」最新在前 → 优先从上往下扫, 命中即停。
    //    旧逻辑默认滚到最底部(scrollTop=scrollHeight) + 每3轮点一次「过滤不良素材」重载 + 每屏wait 1.1s,
    //    对这种新发布的视频是反方向浪费。只在顶扫+下滚都失败时才兜底深扫。
    //    ⚠️ 必须用 waitFor(String.raw`...`) 原生写法(和优化前一致的可靠编法), 不要序列化函数本体。
    const vcardExpr = String.raw`(() => {
      const ds = [...document.querySelectorAll('.ovui-drawer--right, .creation-drawer-container, [class*="drawer"]')].filter(x => x.offsetParent && x.getBoundingClientRect().width > 400);
      const d = ds.find(x => (x.innerText||'').includes('我的视频')) || ds.find(x => x.querySelectorAll('.oc-create-material-card-wrapper').length > 0) || ds[0];
      const cards = [...(d ? d.querySelectorAll('.oc-create-material-card-wrapper') : [])];
      // ⚠️ 判据一（2026-09-12 新增，**优先**）：**卡片文字里含识别码**。
      //    识别码是炮灰真正的身份，而且它就印在卡片上（实测卡片文本 = 「竖版 00:08 #日常 #搞笑 #实拍 demoB26091201」）。
      //    踩过（号B渔具品）：解析出来的 itemid 抓错了元素（返回的 title 是整页导航文字
      //    「作品 131 推荐…找到你发过的3个相关视频」）→ 拿到 3000000000000000104，
      //    而抽屉里炮灰卡的 itemid 是 3000000000000000105，**根本不在列表里** →
      //    只认 itemid 就报「识别码视频卡片未找到」，可**用户肉眼都看见那张卡了**。
      //    ⇒ 判据要认"真正要用的那个东西"（识别码），而不是一个可能解析错的 id。
      // ⚠️ 判据二：itemid 精确命中（原逻辑，保留做兜底）
      const frag = ${JSON.stringify(CONST.ID_VIDEO.frag)};
      const byFrag = frag ? cards.find(x => (x.innerText||'').includes(frag)) : null;
      const byId = cards.find(x => (x.getAttribute('itemid')||'') === ${JSON.stringify(CONST.ID_VIDEO.itemid)});
      const c = byFrag || byId;
      if (!c) return null;
      c.scrollIntoView({ block: 'center' });
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + Math.min(r.height/2, 120)),
               判据: byFrag ? '识别码文字' : 'itemid',
               卡片itemid: c.getAttribute('itemid') || null, 期望itemid: ${JSON.stringify(CONST.ID_VIDEO.itemid)} || null };
    })()`;
    let vcard = null;
    // 🔥 优化: 首屏主动等同步 —— 去掉了选完商品后的硬等5s, 改成"打开选择器后停在首屏, 用刷新等炮灰出现":
    //    视频从抖音公开同步到千川「我的视频」是网络延迟, 快慢不定. 固定等5s是浪费.
    //    这里轮询首屏(最长~6s), 期间每 ~1.6s 点一次「过滤不良素材」触发列表重载催它出现, 一到即命中.
    //    (识别码最新在前, 同步到位必然在首屏; 不用去下滚一排排找还没同步进来的)
    for (let s = 0; s < 4 && !vcard; s++) {
      vcard = await waitFor(vcardExpr, { timeout: 1500 });
      if (!vcard && (s < 2)) { // 前两轮点「过滤不良素材」; 之后落入常规冒泡下滚
        const filt = await locateByText('过滤不良素材', { exact: false, minW: 1 });
        if (filt) { await cdpClick(filt.x, filt.y, 150); await waitJ(0.5, 0.5); }   // 温和化：原固定 0.6s
      }
    }
    // 首屏仍未命中(可能同步真的慢/或排位不在首屏) → 下滚逐屏找, 每4屏点一次「过滤不良素材」刷新
    for (let scan = 0; scan < 12 && !vcard; scan++) {   // 温和化：只是加抖动，轮数不动
      vcard = await waitFor(vcardExpr, { timeout: 800 });
      if (vcard) break;
      // S8 抽屉内滚动：先试人手滚轮（egoScroll 会自动找可滚动容器），没动再回退 JS
      if (!(ctx.egoScroll && (await ctx.egoScroll({ selector: '.ovui-drawer--right', delta: 800, label: '抽屉下滚' }).catch(() => null) || {}).ok)) {
        await ctx.js(`(() => { const d=[...document.querySelectorAll('.ovui-drawer--right')].find(x=>x.offsetParent&&x.getBoundingClientRect().width>400&&(x.innerText||'').includes('我的视频')); if (!d) return false; const sc=[...d.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+100&&e.getBoundingClientRect().height>200)[0]; if (sc) sc.scrollTop += 800; return !!sc; })()`);
      }
      await waitJ(0.2, 0.4);   // 温和化：原固定 0.25s
      vcard = await waitFor(vcardExpr, { timeout: 800 });
      // 每 4 屏仍没找到 → 再点一次「过滤不良素材」刷新(交替开/关), 让炮灰尽早刷出来
      if (!vcard && (scan + 1) % 4 === 0) {
        const filt = await locateByText('过滤不良素材', { exact: false, minW: 1 });
        if (filt) { await cdpClick(filt.x, filt.y, 200); await ctx.wait(0.6); }
      }
    }
    // 顶扫+下滚都没找到 → 兜底滚到底深扫(只在罕见"炮灰排位很深"时触发)
    for (let scan = 0; scan < 40 && !vcard; scan++) {
      await ctx.js(`(() => { const d=[...document.querySelectorAll('.ovui-drawer--right')].find(x=>x.offsetParent&&x.getBoundingClientRect().width>400&&(x.innerText||'').includes('我的视频')); if (!d) return false; const sc=[...d.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+100&&e.getBoundingClientRect().height>200)[0]; if (sc) sc.scrollTop=sc.scrollHeight; return !!sc; })()`);
      await ctx.wait(0.4);
      vcard = await waitFor(vcardExpr, { timeout: 800 });
    }
    if (!vcard) throw new Error('识别码视频卡片未找到');
    // ⚠️ 2026-09-27（同批修复，第 2 处）：这一下**也是纯坐标点击** —— ego 上坐标点经常"点了没选上"。
    //    实测连锁：卡片没选中 ⇒ 抽屉里的「确定」是 **disabled** ⇒ 点它不生效 ⇒ 抽屉不关
    //    ⇒ 兜底只能点关闭 X 收场 ⇒ 抽屉是关了、但视频没落地 ⇒ 发布前终检 `视频素材:false`
    //    （终检是权威判据，拦得对 —— 它没让半成品计划发出去；但这一处点击得修成原生的）。
    let _vc = false;
    if (typeof ctx.egoClickSelector === 'function' && vcard.卡片itemid) {
      try { await ctx.egoClickSelector('.oc-create-material-card-wrapper[itemid="' + vcard.卡片itemid + '"]', { timeout: 4000, label: '选炮灰视频卡 ' + vcard.卡片itemid }); _vc = true; } catch (e) {}
    }
    if (!_vc) await cdpClick(vcard.x, vcard.y, 250); // 点选炮灰视频(等待压到250ms)
    // 🔥 优化: 点选后尽快找「确定」并点击, 不再等"已选"计数 + "找确定"两段串行(合计可能干等数秒).
    //    直接等「确定」按钮可点即可(选定状态一次到位), 找到就立即点. 已选计数只作兜底校验.
    const okV1 = await waitFor(String.raw`(() => {
      const d = [...document.querySelectorAll('.ovui-drawer--right')].find(x => x.offsetParent && x.getBoundingClientRect().width > 400 && (x.innerText||'').includes('我的视频'));
      if (!d) return null;
      const b = [...d.querySelectorAll('button')].find(x => (x.innerText||'').trim() === '确定');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`, { timeout: 6000 });
    if (!okV1) throw new Error('picker确定未找到');
    // ⚠️ 2026-09-27（ego 实盘：3 条计划 × 3 次重试全挂在同一点 `picker未关闭`，前一晚同段是通的）：
    //    这里原来和 1446 段一样是**纯坐标点击** —— ego 上会"点了但抽屉不关"（09-22 已在 1577 段修过同一个坑，
    //    但那处只覆盖「素材抽屉」，这处「识别码视频抽屉」漏了）⇒ 统一改 ego 原生 click 优先、坐标兜底。
    let _v1 = false;
    if (typeof ctx.egoClickSelector === 'function') {
      for (const sel of ['.ovui-drawer--right button:has-text("确定")', 'button:has-text("确定")']) {
        try { await ctx.egoClickSelector(sel, { timeout: 4000, label: '识别码抽屉·确定' }); _v1 = true; break; } catch (e) {}
      }
    }
    if (!_v1) await cdpClick(okV1.x, okV1.y, 200);
    const okV2 = await waitFor(String.raw`(() => {
      const m = [...document.querySelectorAll('[class*="modal"],[class*="dialog"],[role="dialog"]')]
        .find(e => e.offsetParent && (e.innerText||'').includes('确认添加并开始投放'));
      if (!m) return null;
      const b = [...m.querySelectorAll('button')].find(x => x.innerText.trim() === '确定');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    })()`, { timeout: 1500 }); // ⚠️ 第二段确认时有时无: 出现就在1s内, 不出现别干等(坑8)
    if (okV2) {
      let _v2 = false;
      if (typeof ctx.egoClickSelector === 'function') {
        try { await ctx.egoClickSelector('button:has-text("确定")', { timeout: 4000, label: '确认添加·确定(识别码)' }); _v2 = true; } catch (e) {}
      }
      if (!_v2) await cdpClick(okV2.x, okV2.y);
    }
    tmark('两段确认(确定→确认添加)');   // ⏱ 2026-09-22 补埋点：S8 实测 22~27s，原先这里整段没有细步计时
    // ⚠️ 2026-09-14 修正: `creation-drawer-container` 是**常驻容器**(没抽屉时也在) → 拿它判"还开着"会永远不通过。
    //    判据只认「右侧抽屉消失」(+ 素材卡也不在)。
    // ⚠️ 2026-09-14 实测: 抽屉关了但卡片 DOM 会残留(offsetParent 仍非空) → 判据只认「右抽屉消失」。
    //    之前加"卡片数=0"是假阴性(明明成功了却报 picker未关闭)。
    let pickerClosed = await waitFor(`(() => { const ds=[...document.querySelectorAll('.ovui-drawer--right')].filter(x => x.offsetParent && x.getBoundingClientRect().width > 400); return ds.length ? null : true; })()`, { timeout: 10000 });
    if (!pickerClosed) {
      // 兜底（2026-09-27）: 同 1577 段 —— 原生再点一次确定 / 点抽屉关闭 X / Esc，任一奏效即可。
      //   今天 6 次失败都停在 10s 干等之后的这一行；兜底比"直接放弃"划算得多（放弃 = 旧计划已删、新计划没建出来）。
      const 兜底 = [];
      if (typeof ctx.egoClickSelector === 'function') {
        for (const sel of ['.ovui-drawer--right button:has-text("确定")', '.ovui-drawer--right [class*=close]', '[class*=drawer] [aria-label*=close]']) {
          try { await ctx.egoClickSelector(sel, { timeout: 3000, label: '关抽屉兜底(识别码)' }); 兜底.push(sel); } catch (e) {}
          const okNow = await ctx.js(`(() => { const ds=[...document.querySelectorAll('.ovui-drawer--right')].filter(x => x.offsetParent && x.getBoundingClientRect().width > 400); return ds.length ? false : true; })()`);
          if (okNow) break;
        }
      }
      if (typeof ctx.pressKey === 'function') { try { await ctx.pressKey('Escape'); } catch (e) {} }
      await ctx.wait(1);
      pickerClosed = await waitFor(`(() => { const ds=[...document.querySelectorAll('.ovui-drawer--right')].filter(x => x.offsetParent && x.getBoundingClientRect().width > 400); return ds.length ? null : true; })()`, { timeout: 6000 });
      log({ stage: pickerClosed ? 'S4关抽屉兜底生效(识别码)' : 'S4关抽屉兜底未生效(识别码)', 试过: 兜底 });
    }
    if (!pickerClosed) throw new Error('picker未关闭');
    // 🔥 2026-09-13 清理静默超时(原 6s 未检查): 「视频(1)」由紧接着的发布前八项终检(视频素材项)权威把关
    //    → 这里收到 3s 并检查, 未出现只打日志。
    const vidOne = await waitFor(`/视频\\s*\(\\s*1\\s*\)/.test(document.body.innerText)`, { timeout: 3000 });
    if (!vidOne) console.log('  [添加识别码视频] 「视频 ( 1 )」3s 未出现(发布前终检会拦)');
    tmark('添加识别码视频');

    // 9) 计划名称后缀(坑10: 空白规范化)
    const nameFix = await ctx.js(String.raw`(() => {
      const inp = [...document.querySelectorAll('input')].find(i => i.offsetParent && /计划名称/.test(i.placeholder||''));
      if (!inp) return null;
      if (!inp.value.includes('→') || !inp.value.includes(${JSON.stringify(noteA.suffix)})) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(inp, inp.value + ${JSON.stringify(noteA.suffix)} + '→' + ${JSON.stringify(目标ROI)});
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return inp.value;
    })()`);
    if (!nameFix || !nameFix.includes(noteA.suffix)) throw new Error('计划名称未追加后缀: ' + nameFix);

    // 10) 发布前终检(坑: ROI兜底重填 + 八项检查)
    await ctx.js(String.raw`(() => {
      const label = [...document.querySelectorAll('div,span')].find(e => e.offsetParent && (e.innerText||'').trim() === '净成交ROI目标');
      if (!label) return false;
      const lr = label.getBoundingClientRect();
      const list = [...document.querySelectorAll('input.ovui-input')].filter(i => i.offsetParent && i.placeholder === '请输入');
      const roi = list.find(i => { const r = i.getBoundingClientRect();
        return Math.abs((r.x + r.width/2) - (lr.x + lr.width/2)) < 300 && Math.abs(r.y - (lr.y + lr.height/2)) < 60; });
      if (!roi) return false;
      if (roi.value === ${JSON.stringify(目标ROI)}) return true;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(roi, ${JSON.stringify(目标ROI)});
      roi.dispatchEvent(new Event('input', { bubbles: true }));
      roi.dispatchEvent(new Event('change', { bubbles: true }));
      return roi.value;
    })()`);
    await ctx.wait(0.4); // 🔥 优化: 终检读取前只需等 ROI 字段稳定, 0.4s 足够(旧 1s)
    const chk0 = await ctx.js(String.raw`(() => {
      const txt = document.body.innerText;
      const list = [...document.querySelectorAll('input.ovui-input')].filter(i => i.offsetParent && i.placeholder === '请输入');
      const lab = [...document.querySelectorAll('div,span')].find(e => e.offsetParent && (e.innerText||'').trim() === '净成交ROI目标');
      const lr = lab ? lab.getBoundingClientRect() : null;
      const roiVal = lr ? (list.find(i => { const r = i.getBoundingClientRect();
        return Math.abs((r.x + r.width/2) - (lr.x + lr.width/2)) < 300 && Math.abs(r.y - (lr.y + lr.height/2)) < 60; }) || {}).value : null;
      const name = [...document.querySelectorAll('input')].find(i => i.offsetParent && /计划名称/.test(i.placeholder||''));
      return {
        账号: txt.includes(${JSON.stringify(CONST.AWEME_ID)}) || txt.includes(${JSON.stringify(CONST.AWEME_NAME)}),
        商品: /已添加[：:]\s*1\/30/.test(txt),
        控成本: [...document.querySelectorAll('.ovui-radio-item')].some(e => e.offsetParent && (e.innerText||'').includes('控成本投放') && e.className.includes('checked')),
        ROI: roiVal === ${JSON.stringify(目标ROI)},
        净成交: txt.includes('净成交ROI目标'),
        视频素材: /视频\s*\(\s*1\s*\)/.test(txt),
        名称: !!(name && name.value.includes(${JSON.stringify(noteA.suffix)}))
      };
    })()`);
    // ⛔ 2026-10-22 改版：终检的「预算」**不许再用宽口径**（"任意 input 值是 300" 会被 ROI 框骗过 ✗）——
    //    与上面填预算用**同一个取框判据**（`预算框JS`），只读回值 ⇒ 判据只有一个主人 ✓
    const 预算读 = await ctx.js(预算框JS(String.raw`return { ok: 预算.value === ${JSON.stringify(期望预算)}, 值: 预算.value, 候选数: 候选.length };`));
    const chk = {
      账号: chk0.账号, 商品: chk0.商品, 控成本: chk0.控成本,
      预算: !!(预算读 && 预算读.ok),
      ROI: chk0.ROI, 净成交: chk0.净成交, 视频素材: chk0.视频素材, 名称: chk0.名称,
    };
    log({ 终检: chk, 预算框: 预算读 });
    const bad = Object.entries(chk || {}).filter(([, v]) => !v).map(([k]) => k);
    if (bad.length) throw new Error('发布前终检未通过: ' + bad.join(','));
    tmark('名称+终检');

    // 11) 发布
    const pub = await locateByText('发布计划', { exact: true });
    if (!pub) throw new Error('发布计划按钮未找到');
    await cdpClick(pub.x, pub.y, 200);
    // 🔥 优化: 发布确认弹窗通常 ~1s 内出现; 旧逻辑每轮 wait 1.0s(最多20轮=20s). 收紧为:
    //    快poll(250ms)查弹窗/成功, 命中确认立即点(不再取中心坐标漂移). 只在确认缺失时才退避等0.3s, 绝不干等1s.
    let published = false;
    for (let p = 0; p < 20 && !published; p++) {
      const st = await ctx.js(`(() => {
        const m = [...document.querySelectorAll('[class*="modal"],[class*="dialog"],[role="dialog"]')]
          .find(e => e.offsetParent && (e.innerText||'').includes('确认发布') &&
            [...e.querySelectorAll('button')].some(b => b.innerText.trim() === '确认发布'));
        if (m) { const b = [...m.querySelectorAll('button')].find(b => b.innerText.trim() === '确认发布'); const r = b.getBoundingClientRect(); return { act: 'confirm', x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) }; }
        if (/成功|已发布/.test(document.body.innerText)) return { act: 'done' };
        return null;
      })()`);
      if (st && st.act === 'confirm') { await cdpClick(st.x, st.y, 200); published = true; }
      if (st && st.act === 'done') published = true;
      if (!st) await ctx.wait(0.3); // 弹窗未出才退避, 命中即不延后
    }
    if (!published) throw new Error('发布确认/成功30s均未出现');
    // 成功文本判定放宽: 交由 S5(findNewPlanId) 作为发布成功的最终验证
    await ctx.wait(0.5);
    tmark('发布');
    return { ok: true, name: nameFix };
  };

  // ---------- 风控/诊断 ----------
  // 放宽: 隐藏/微小元素不算验证码(抖音页面常有无害的 verification token 元素, 防误报)
  const isCaptcha = async () => {
    try {
      // 🔑 判据主人 = `captcha.js`（带单测）。2026-09-23 之前这份判据是**就地内联**的，
      //    于是 m3a 那边用不上：实盘遇到「请完成下列验证后继续 / 按住左按钮拖动完成上方拼图」
      //    （老正则一条都不含）时判成"没有验证码" → 脚本继续在骨架屏上找死图 → 报误导人的「没抓到商品图」。
      const r = await ctx.js(require('./captcha.js').CAPTCHA_EXPR);
      return !!r;
    } catch { return false; }
  };

  // 收尾: 每站只留1个tab
  const cleanupTabs = async () => {
    try {
      const tabs = await ctx.listTabs();
      if (!tabs || !tabs.length) return { closed: 0, kept: 0 };
      const keep = [];
      const close = [];
      for (const t of tabs) {
        const u = t.url || '';
        if (u.startsWith('https://qianchuan.jinritemai.com')) { if (!keep.some(k => k.startsWith('https://qianchuan.jinritemai.com'))) keep.push(u); else close.push(t.id); }
        else if (u.startsWith('https://www.douyin.com')) { if (!keep.some(k => k.startsWith('https://www.douyin.com'))) keep.push(u); else close.push(t.id); }
        else close.push(t.id);
      }
      for (const id of close) { try { await ctx.closeTab(id); } catch (e) {} }
      return { closed: close.length, kept: keep.length };
    } catch (e) { return { err: e.message }; }
  };

  const dumpState = async (label) => {
    try {
      const pi = await ctx.pageInfo();
      const s = await ctx.js(`(() => ({
        url: location.href,
        head: document.body.innerText.replace(/\\s+/g,' ').slice(0,160)
      }))()`);
      log({ dump: label, ...pi, ...(s || {}) });
    } catch (e) { log({ dump: label, err: e.message }); }
  };

  return { injectSixPack, cdpClick, waitFor, locateByText, clickByText, fillNative, gotoQianchuan, gotoDouyin, dismissModals, closeDrawer,
    planRow, findNewPlanId, searchPlanById, deletePlan, douyinSetVideoPrivacy, probeFrag, resolveSbmguoVideo, openMaterialDrawer, readCount,
    materialReport, readMaterialFrag, addVideosFromMyVideos, createPlan, isCaptcha, cleanupTabs, dumpState, mapRoi, pausedAuthInfo, dismissAuthModals };
}

// 全局日志(编排脚本覆盖)
let log = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o));
function setLogger(fn) { log = fn; }

// ============ 每小步计时(优化定位用) ============
// 编排脚本(bit-qc-run.js)在开跑每阶段前调 setStage('S4'), 各阶段内部在子步骤边界调 tmark('选抖音号');
// getTimings() 汇总成 [{stage,step,ms}] 供 DONE 时整体输出一次, 看清每小步耗在哪。
let TIMINGS = [];
let CUR_STAGE = '';
let stageT0 = 0;
let lastT = 0;
function setStage(stage) {
  CUR_STAGE = stage;
  stageT0 = Date.now();
  lastT = stageT0;
  TIMINGS = [];
}
function tmark(step) {
  if (!CUR_STAGE) return;
  const now = Date.now();
  TIMINGS.push({ stage: CUR_STAGE, step, ms: now - lastT });
  lastT = now;
}
function getTimings() { return TIMINGS; }

module.exports = { makeEnvCtx, makeLib, setLogger, setStage, tmark, getTimings };