'use strict';
/**
 * ego-tab.js —— **共用取页 shim**：给"自己 `api.open + Cdp.connectWs`"的那几个脚本一个 ego 实现
 *
 * 用户 2026-09-22：「m3 m4 你要想办法换成 ego 的方式」「把 m1 开始从 ego 跑起来」。
 *
 * 为什么要有这个中间层：`bit-m3-publish.js` / `bit-m3-edit-cart.js` / `bit-m3-paohui.js` 各自
 * 手搓比特取页（`api.open(DY.env)` + `fetch(/json/list)` + `Cdp.connectWs`），然后在业务里只用
 * `cdp.send / cdp.eval / cdp.close`。⇒ 把这三件套抽成 shim：**ego 走 page.cdp/evaluate，比特走原路**，
 * 业务判据一行不改（与 m8 用 makeEnvCtx、m3-upload/m4-upload 用 attachSite 同一套路）。
 *
 * 用法（在脚本里替换原来的取页段）：
 *   const { openCdp } = require('./ego/ego-tab.js');
 *   const { cdp, mode, url } = await openCdp({ envId: DY.env, url: POST_URL, match: /content\/post/, log });
 *   // cdp.send(method, params) / cdp.eval(expr) / cdp.close()  ← 与比特版同形
 */
const EGO = require('./ego-transport.js');

/**
 * @param {{envId:string, url?:string, match?:RegExp, log?:Function, profileHint?:string}} o
 * @returns {Promise<{cdp:object, mode:string, url:string, ego:boolean, ctx?:object}>}
 */
async function openCdp({ envId, url, match, log = () => {}, profileHint = '' }) {
  // ── ego 运行时：复用/导航到目标页，返回同形 cdp ────────────────────────────────
  if (EGO.inEgo()) {
    const EEC = require('./ego-env-ctx.js');
    const re = match || (/^https?:/.test(String(url || '')) ? new RegExp(String(url).split('?')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : null);
    const ctx = EEC.makeEgoEnvCtx(envId, { log });
    const T = require('./ego-transport.js');
    const task = await ctx.egoTask();
    let page = await ctx.egoPage();
    let cur = String(await page.url().catch(() => ''));
    let mode = 'reuse';
    if (!(re && re.test(cur))) {
      // ⚠️ 2026-09-23 事故：只给了 `match`（没给 url）时，原来**直接拿 ctx 当前页** ⇒
      //    m3-publish 复用了千川 `uni-prom` 列表页 → "找不到描述编辑器"（发布失败）。
      //    ⇒ 正确顺序：①当前页匹配就用；②否则在空间里**按精确正则找标签**（上传后留着的 /content/post 页）；
      //      ③再否则有 url 就导航；④都没有 → **明确报错**，绝不在错误的页上操作。
      const hit = re ? (await T.listTabs(task)).find((t) => re.test(String(t.url || ''))) : null;
      if (hit) {
        page = hit.label ? task.page(hit.label) : await task.adopt(hit.page);
        mode = 'adopt-tab';
      } else if (url) {
        await ctx.gotoAndWait(url, { timeout: 25, waitUntil: 'domcontentloaded' });
        page = await ctx.egoPage();
        mode = 'navigate';
      } else {
        throw new Error('ego-tab: 当前页不匹配 ' + String(re) + ' 且空间内没有匹配标签、也没给 url → 拒绝在错误的页上操作');
      }
      cur = String(await page.url().catch(() => ''));
    }
    log({ stage: 'EGO_OPEN_CDP', ok: true, env: envId, mode, url: cur.split('?')[0], 账号: ctx.账号 });
    // ⚠️ 2026-09-23 事故（同一个坑的第三次）：cdp 必须**绑在判定/操作的那一页**上。
    //    上一版这里写的是 `ctx.cdp / ctx.js` ⇒ 打在 **ctx 的当前页**（当时是千川 uni-prom）上，
    //    而返回的 url 却是被 adopt 的发布页 → 脚本在错页上找元素："找不到可点元素: 作品描述编辑器"。
    return {
      ego: true, ctx, mode, url: cur,
      cdp: {
        ego: true,
        send: (m, p2) => page.cdp(m, p2),
        eval: (e) => page.evaluate(e),
        // ego 原生点击（自带 actionability、单匹配校验）—— 坐标点击在 ego 上偶发点不动
        click: (sel, opts) => page.click(sel, opts || {}),
        close: () => {},                       // 暖会话：不关空间/页
        // 兼容极少数用 `cdp.ws` 判活的写法
        ws: { readyState: 1 },
        acceptNextDialog: () => {},
      },
    };
  }

  // ── 比特链路：原路（api.open + /json/list + connectWs）─────────────────────────
  const api = require('../bit-api.js');
  const { Cdp } = require('../bit-cdp.js');
  const info = await api.open(envId);
  const tabs = ((await (await fetch(`http://${info.http}/json/list`)).json()) || []).filter((t) => t.type === 'page');
  const tab = (match ? tabs.find((t) => match.test(t.url || '')) : null) || tabs.find((t) => url && String(t.url).startsWith(String(url).split('?')[0]));
  if (!tab) {
    const e = new Error('未找到目标标签' + (match ? '（' + match + '）' : '') + '：' + tabs.map((t) => String(t.url).split('?')[0]).join(' | '));
    e.code = 'NO_TAB';
    throw e;
  }
  const cdp = await Cdp.connectWs(tab.webSocketDebuggerUrl);
  log({ stage: 'BIT_OPEN_CDP', ok: true, env: envId, url: String(tab.url).split('?')[0] });
  return { ego: false, cdp, mode: 'bit', url: String(tab.url) };
}

module.exports = { openCdp };
