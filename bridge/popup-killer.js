'use strict';
/**
 * popup-killer.js — 千川/抖音的弹窗清理（**关键步骤前必跑**）
 *
 * 由来（用户 2026-09-12）：「弹窗那么多不关你怎么操作？」
 *   实测两个挡路的：
 *     · 代投环境：「恭喜您！商品投放权限通过啦 …6个店铺> / 创建商品全域计划」（launcher/悬浮球引导弹窗，**没有文字关闭按钮**）
 *     · 直投号  ：「恭喜你，计划创建成功！账户余额不足…放弃福利 / 立即充值」
 *   qc-lib 原有的 dismissModals 只认「发现新机会|推荐|知道了|关闭…」→ 这两个都认不出，于是永远挡着。
 *
 * 原则：
 *   · 只点**放弃/关闭**类（放弃福利 / 不感兴趣 / 稍后再说 / 跳过 / 关闭 / 知道了 / × / 遮罩）
 *   · **绝不点** 立即充值 / 确定 / 确认 / 创建商品全域计划 / 去充值 等"动作"按钮
 *   · 关不掉的（真·拦截型弹窗）→ 如实报出来，不硬点
 */
// 「再想想」= 撤销"退出并放弃创建" → 保留草稿，属于安全取消，必须点它（不要点"仍要退出"）
const DISMISS_TEXT = /^(放弃福利|放弃奖励|不感兴趣|不再提示|稍后再说|暂不|暂不开启|以后再说|再想想|跳过|跳过引导|关闭|关闭弹窗|知道了|我知道了|我知道了！|我知道了。|X|×|✕)$/;
const NEVER_CLICK = /立即充值|去充值|充值|确定|确认|创建商品全域计划|立即创建|马上创建|开通|购买|支付/;

const CAND = '[class*="modal"],[class*="popup"],[class*="launcher"],[class*="guide"],[class*="dialog"],[role="dialog"],[class*="floatball"]';

/** 扫描可见弹窗（含悬浮球引导） */
const SCAN = `(() => {
  const cands = [...document.querySelectorAll(${JSON.stringify(CAND)})]
    .filter(e => e.offsetParent && e.getBoundingClientRect().width > 150 && e.getBoundingClientRect().height > 60);
  // 只留最外层（避免同一个弹窗的多层容器重复处理）
  const outer = cands.filter(c => !cands.some(o => o !== c && c.contains(o)));
  return outer.map(c => {
    const r = c.getBoundingClientRect();
    const btns = [...c.querySelectorAll('button,span,div,a')]
      .filter(b => b.offsetParent && (b.innerText || '').trim() && (b.innerText || '').trim().length <= 12)
      .map(b => { const br = b.getBoundingClientRect(); return { t: (b.innerText || '').trim(), x: Math.round(br.x + br.width/2), y: Math.round(br.y + br.height/2), w: Math.round(br.width) }; });
    // 关闭图标：class 含 close 的可见元素（排除输入框包装）
    let closeIcon = null;
    const ci = [...c.querySelectorAll('[class*="close"],[class*="Close"]')]
      .filter(e => e.offsetParent && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().width < 60)
      .pop();
    if (ci) { const ir = ci.getBoundingClientRect(); closeIcon = { x: Math.round(ir.x + ir.width/2), y: Math.round(ir.y + ir.height/2) }; }
    return { cls: (c.className || '').toString().slice(0, 60), text: (c.innerText || '').replace(/\\s+/g, ' ').slice(0, 80),
             x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), btns, closeIcon };
  });
})()`;

/**
 * 关掉当前页上能关的弹窗。
 * @param {object} cdp Cdp 实例
 * @param {function} log 日志函数
 * @returns {Promise<{closed:number, stubborn:string[]}>}
 */
async function killPopups(cdp, log = () => {}) {
  let closed = 0;
  const stubborn = [];
  for (let round = 0; round < 6; round++) {
    const list = await cdp.eval(SCAN, { timeoutMs: 8000 }).catch(() => []);
    if (!Array.isArray(list) || !list.length) break;
    let acted = false;
    for (const p of list) {
      // ① 文字"放弃/关闭"类按钮
      const hit = (p.btns || []).find((b) => DISMISS_TEXT.test(b.t) && !NEVER_CLICK.test(b.t) && b.w > 0);
      let target = hit ? { x: hit.x, y: hit.y, how: '按钮:' + hit.t } : null;
      // ② 关闭图标
      if (!target && p.closeIcon) target = { x: p.closeIcon.x, y: p.closeIcon.y, how: '关闭图标' };
      // ③ 不再"点遮罩外侧"（实测瞎点 18 次也没关掉，还可能误触）→ 交给后面的 ESC 兜底
      if (!target) { if (!stubborn.includes(p.text.slice(0, 40))) stubborn.push(p.text.slice(0, 40)); continue; }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 80));
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 700));
      log({ stage: 'POPUP_CLOSED', 弹窗: p.text.slice(0, 50), 方式: target.how });
      closed++; acted = true;
    }
    // ⛔ 不再按 ESC（2026-09-12 用户：「怎么每次你都会触发弹窗？」）——
    //    ESC 会触发千川的「确定退出并放弃创建全域投放吗？」等离开确认 → 反而制造弹窗。
    //    这里只做**白名单文字按钮**的点击；关不掉的就如实报 POPUP_STUBBORN，交人工。
    if (!acted) break;
  }
  await clearStaleMasks(cdp, log);   // 关完弹窗常有空壳遮罩残留 → 一并失效，否则后面点不动
  if (stubborn.length) log({ stage: 'POPUP_STUBBORN', ok: false, 关不掉的: stubborn.slice(0, 3),
    说明: '这些弹窗没有可点的"放弃/关闭"入口，需人工看一下（程序不会硬点动作按钮）' });
  return { closed, stubborn };
}

/**
 * 清掉**残留的空壳遮罩**（不点任何东西，只把它失效）—— 2026-09-12 实测的关键一环
 *
 * 现象：关掉弹窗后，`DIV.ovui-modal__wrap.oc-modal-wrap` 这种**空壳容器**留在 DOM 里盖住整页，
 *   把后续点击**全部吃掉** → 【添加商品】点不动 → 抽屉不开 → 报「商品卡片未定位」。
 *   （用户看到的就是"弹窗关了但页面还是点不动"）
 * 做法：面积占大半屏、里面**没有可见弹窗内容**的遮罩 → `pointer-events:none` + `display:none`。
 *   ⚠️ 不点击、不按 ESC —— 没有任何触发新弹窗的风险。
 */
const STALE = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const out = [];
  for (const e of document.querySelectorAll('[class*="modal__wrap"],[class*="modal-wrap"],[class*="mask"],[class*="overlay"],[class*="ModalWrap"]')) {
    if (!e.offsetParent) continue;
    const r = e.getBoundingClientRect();
    if (r.width < vw * 0.4 || r.height < vh * 0.4) continue;   // 放宽：实测残壳常常不是满屏
    // 里面有"看得见的弹窗内容"吗？（有就说明是真弹窗，别动）
    // 只有"真正的弹窗内容"才算数：够宽 + 有实质文字 + 不是纯遮罩壳
    const inner = [...e.querySelectorAll('*')].filter((x) => x.offsetParent && x.getBoundingClientRect().width > 200
      && (x.innerText || '').trim().length > 8 && !/wrap|mask|overlay/i.test(String(x.className || '')));
    if (inner.length) continue;
    e.style.pointerEvents = 'none';
    e.style.display = 'none';
    out.push((e.className || '').toString().slice(0, 50));
  }
  return out;
})()`;

async function clearStaleMasks(cdp, log = () => {}) {
  try {
    const killed = await cdp.eval(STALE, { timeoutMs: 8000 });
    if (Array.isArray(killed) && killed.length) log({ stage: 'STALE_MASK_CLEARED', 数量: killed.length, 类名: killed.slice(0, 3) });
    return Array.isArray(killed) ? killed.length : 0;
  } catch (e) { return 0; }
}

module.exports = { killPopups, clearStaleMasks, DISMISS_TEXT, NEVER_CLICK };
