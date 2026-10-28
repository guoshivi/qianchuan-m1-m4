'use strict';
// 千川重建 共享常量（**单处维护**，main 上的唯一事实源）
//
// 📍 2026-09-13 从 `qianchuan/qc-const.js` 搬到这里：原来放在根目录的 `qianchuan/` 里，
//    而那个目录是同名 ego（非比特）链路的家 —— ego 已整体移到 `ego-legacy` 分支，
//    但**这份常量是两条链路共用的**（比特侧 10 个脚本都 require 它），所以搬进 bridge/。
//
// 用途有两层（别只看字面以为"用不到"就删）：
//   ① 非账号常量：`SIXPACK`（爬虫六件套，每次导航前注入）、`DOUYIN_BASE`
//   ② **运行时可变的共享状态**：`ACCOUNT_ID / PRODUCT_ID / ID_VIDEO / AWEME_*` ——
//      `bit-qc-run.js` 每跑一个计划会**覆写**它们（`CONSTS.PRODUCT_ID = …`），
//      `bit-qc-lib.js` 再读它们拼页面判据。初始值来自本地未入库的 `qc-config.js` 的 `legacy` 块。
//
// ⚠️ 脱敏：账号类真实值**不写在本文件**（本文件被 git 跟踪，仓库要能分享给别人）→
//    一律从**本地未入库**的 `fp-matrix/bridge/qc-config.js` 的 `legacy` 块读
//    （形状见 `qc-config.example.js` 的 ⑤ legacy 说明）。
const CFG = require('./qc-config.js');
const L = CFG.legacy || {};

const MISS = (k) => '<未配置 legacy.' + k + '>';
const pick = (v, k) => (v === undefined || v === null || v === '' ? MISS(k) : v);

const ACCOUNT_ID = pick(L.accountId, 'accountId');
const ID_VIDEO = {
  title: pick((L.idVideo || {}).title, 'idVideo.title'),
  itemid: pick((L.idVideo || {}).itemid, 'idVideo.itemid'),
  frag: pick((L.idVideo || {}).frag, 'idVideo.frag'),
};

module.exports = {
  ACCOUNT_ID,
  ACCOUNT_NAME: pick(L.accountName, 'accountName'),
  ENTRY_URL: 'https://qianchuan.jinritemai.com/uni-prom?aavid=' + ACCOUNT_ID,
  AWEME_ID: pick(L.awemeId, 'awemeId'),
  AWEME_NAME: pick(L.awemeName, 'awemeName'),
  PRODUCT_ID: pick(L.productId, 'productId'),
  PRODUCT_NAME: pick(L.productName, 'productName'),
  // 识别码视频（老 ego 兜底用；bit 链路已改成从素材面板自动读）
  ID_VIDEO,
  NAME_SUFFIX: pick(L.nameSuffix, 'nameSuffix'),
  DOUYIN_BASE: 'https://www.douyin.com/user/self?showSubTab=',

  // SIXPACK —— **反自动化注入脚本**（每个 heredoc/脚本开始、每次导航前注入到 tab 里）
  // ⚠️ 2026-09-22 **命名撞车警告**：这里旧注释写的"爬虫六件套"是**误导**——
  //    用户口中的「爬虫六件套」是**本机另一套东西**：`~/.hermes/skills/web/unified-browser/SKILL.md`
  //    管着的六个抓取/浏览器引擎（Firecrawl / Crawl4AI / CloakBrowser / browser-harness / Scrapling / ego-lite）
  //    —— 跟本文件这段 JS **毫无关系**。别再混为一谈（我 2026-09-22 就混了一次，白体检一轮）。
  // ⚠️ 2026-09-22 v2（用户反复追问「你用了爬虫 6 件套没」→ 我做了一次反爬体检 `qc-diag-detect.js`）：
  //    旧版有**两处一眼假**：
  //      ① `navigator.plugins = [1,2,3,4,5]` —— 真浏览器是 PluginArray（Plugin 对象数组）；
  //         实测 `Object.prototype.toString` = "[object Array]"、首元素是 number，检测方一看就穿。
  //      ② 补丁函数 `getParameter` 的 `toString()` 直接把补丁源码吐出来。
  //    另外原来打在**实例**上（`Object.defineProperty(navigator,…)`）→
  //      `Object.getOwnPropertyDescriptor(navigator,'webdriver')` 能查到非原生 own property ⇒ 改成**原型级**。
  //    ⛔ 注意：**六件套不是 ego 跳验证的原因** —— 比特链路注入的是同一份（`bit-cdp.js` 也打这一发），
  //      它带着同样的 plugins 假货却不跳。真正差异在 BitBrowser 的原生指纹引擎与"环境=老设备"。
  //      所以 v2 只是"把客观存在的假货修掉"，别指望它单独解决验证问题。
  SIXPACK: String.raw`
(() => {
  const patched = [];
  const _fts = Function.prototype.toString;
  Function.prototype.toString = function () {
    if (patched.indexOf(this) >= 0) return 'function ' + (this.name || '') + '() { [native code] }';
    return _fts.call(this);
  };
  patched.push(Function.prototype.toString);
  const def = (obj, prop, getter) => { try { Object.defineProperty(obj, prop, { get: getter, configurable: true, enumerable: true }); patched.push(getter); } catch (e) {} };
  // ① webdriver：**原型级**（实例级会被 getOwnPropertyDescriptor 查到）
  //   ⚠️ v3：值从 undefined 改成 false —— 真 Chrome 非自动化态就是 false
  //      （实测 ego 原生也是 false），返回 undefined 反而与真 Chrome 不同。
  def(Navigator.prototype, 'webdriver', function () { return false; });
  // ② plugins：伪装成 PluginArray（原型指向 PluginArray.prototype，元素是 Plugin 对象）
  try {
    const mk = (name, filename, description) => {
      const p = { name: name, filename: filename, description: description, length: 1 };
      p.item = function (i) { return i === 0 ? p : null; };
      p.namedItem = function (n) { return n === name ? p : null; };
      patched.push(p.item, p.namedItem);
      try { Object.setPrototypeOf(p, Plugin.prototype); } catch (e) {}
      return p;
    };
    const list = [
      mk('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      mk('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      mk('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      mk('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format'),
      mk('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format'),
    ];
    list.item = function (i) { return list[i] || null; };
    list.namedItem = function (n) { for (let i = 0; i < list.length; i++) { if (list[i].name === n) return list[i]; } return null; };
    patched.push(list.item, list.namedItem);
    try { Object.setPrototypeOf(list, PluginArray.prototype); } catch (e) {}
    try { Object.defineProperty(list, Symbol.toStringTag, { get: function () { return 'PluginArray'; }, configurable: true }); } catch (e) {}
    def(Navigator.prototype, 'plugins', function () { return list; });
  } catch (e) {}
  // ③ 其余
  // ⚠️ 2026-09-23 **SIXPACK v3：删掉“把真值改成通用假值”的那几条**（用户「按建议来」）。
  //    起因：只读探针（/tmp/qc-ego/diag-fp.jsonl）发现 v1/v2 的补丁把一台**真实 Mac**改成了
  //    “自称 Mac + Intel 核显 + 8核8G” —— 这个组合全世界可能只有我们这一台 ⇒ **稀有性本身=风险信号**。
  //    风控要的是“常见、自洽、稳定”，而真机原值恰恰最符合。详见 skill §1.55。
  //
  //    ⛔ 已删（改回真实值透出）：
  //      · languages 强制 ['zh-CN','zh','en'] —— 系统只有 zh-CN/zh，而 **Accept-Language 请求头
  //        由浏览器按真实设置发送、JS 改不到** ⇒ 改了反而造出“JS 与请求头不一致”（新增破绽）。
  //      · hardwareConcurrency 8 / deviceMemory 8 —— 真机是 10 / 16（Apple M4），真值更普通。
  //      · WebGL 37445/37446 强制 'Intel Inc.' / 'Intel Iris OpenGL Engine' ——
  //        ① 与 platform=MacIntel 拼成“Mac 上的 Intel 核显”；
  //        ② Intel Iris OpenGL Engine 是**旧版 macOS 原生 GL 的写法**，Chrome 152 报的是
  //           ANGLE (Intel, Intel(R) Iris(TM) …, …) 格式 ⇒ **渲染器字符串格式与浏览器版本对不上**。
  //        真机原值 ANGLE (Apple, ANGLE Metal Renderer: Apple M4, …) 自洽且常见。
  //    ✅ 保留：
  //      · webdriver —— 但值改成 **false**（真 Chrome 非自动化态就是 false）；仍是**原型级** getter。
  //      · plugins —— 假的那 5 条**与 Chromium 原生列表逐条相同**（实测），留着等于兜底，无害。
  //      · Permissions.query —— 本来就在**模仿**真 Chrome 的正确行为。
  //      · Function.prototype.toString 伪装 —— 让上面这些 getter 看起来是 [native code]。
  window.chrome = window.chrome || {};
  // ⛔ 不再塞 id: 'dsh' —— 真 Chrome 的**网页**里 chrome.runtime.id 是 undefined，
  //    而 'dsh' 不是合法扩展 ID（真的是 32 位小写字母）—— 那是一条"一眼假"的自动化标记。
  window.chrome.runtime = window.chrome.runtime || { connect: function () {}, sendMessage: function () {} };
  try {
    const _q = window.Permissions.prototype.query;
    window.Permissions.prototype.query = function (d) { if (d && d.name === 'notifications') { return Promise.resolve({ state: Notification.permission }); } return _q.call(this, d); };
    patched.push(window.Permissions.prototype.query);
  } catch (e) {}
})();
`,
};
