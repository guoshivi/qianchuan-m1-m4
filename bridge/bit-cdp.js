'use strict';
// 比特环境 CDP 驱动客户端（零依赖，Node>=22 原生 WebSocket/fetch）
// 用法: const cdp = await Cdp.connect(wsUrl or httpPort); await cdp.navigate(url); ...
// ⚠️ 参考文档坑: 必须不带 Origin 头(原生 WebSocket 默认不带), 否则握手 403

class Cdp {
  constructor(ws, port) {
    this.ws = ws;
    this.port = port;           // http 调试端口 "127.0.0.1:60126"
    this.id = 0;
    this.pending = new Map();
    this.ready = false;
    this._waitReady = new Promise((res) => { this._resolveReady = res; });
    // ── 原生弹窗（confirm/alert/beforeunload）──────────────────────────────
    // ⚠️ 2026-09-11 血泪：千川离开「全域投放创建页」时会弹原生确认框
    //    「确定退出并放弃重建全域投放吗？」。原生弹窗会**阻塞渲染进程** →
    //    接下来所有 `Runtime.evaluate` 全部无响应 → 报 "CDP超时(目标可能已跳转/失效)"。
    //    而原来的 _onMessage 把非 id 消息（事件）直接丢了，等于**完全不知道有弹窗**。
    //    现在：监听 Page.javascriptDialogOpening，默认 **取消(accept:false)** ——
    //    取消 = 留在当前页 = **不放弃重建**（放弃才是不可逆的）；并把弹窗原文打进日志。
    this.dialogs = [];          // [{message, type, url, at, action}]
    this._acceptNext = false;   // 明确要离开时置 true（导航场景）
  }

  _send(method, params = {}, sessionId, timeoutMs = 10000) {
    const id = ++this.id;
    const msg = { id, method };
    if (params) msg.params = params;
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
      // ⚠️ 超时保护: 环境 tab 跳转/会话失效后 CDP 会话可能永久无响应,
      // 若不加超时, cdP.eval(无 timeout) 会让编排进程永久挂死在 S10 等阶段。
      // 收紧到 10s: 一旦会话失效快速抛错(走"人工改ROI"兜底), 而不是让进程死等。
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          const dlg = this.dialogs[this.dialogs.length - 1];
          reject(new Error('CDP超时(' + method + ' 未在' + Math.round(timeoutMs / 1000) + 's内响应'
            + (dlg && Date.now() - dlg.at < 30000 ? '；最近弹窗: 「' + dlg.message.slice(0, 60) + '」已' + (dlg.action === 'cancel' ? '取消' : '确定') : '')
            + '；目标可能已跳转/失效)'));
        }
      }, timeoutMs);
    });
  }

  static async connectPort(httpPort) {
    // httpPort 形如 "127.0.0.1:60126"
    const tabs = await (await fetch(`http://${httpPort}/json/list`)).json();
    const page = tabs.find((t) => t.type === 'page' && !t.url.startsWith('chrome://') && t.webSocketDebuggerUrl);
    if (!page) throw new Error('no page target in /json/list');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const cdp = new Cdp(ws, httpPort);
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending?.has?.(m.id)) return; // 占位(下面用实例方法)
      cdp._onMessage(m);
    };
    ws.onerror = (e) => { cdp._lastError = e.message || 'ws error'; };
    await new Promise((res, rej) => {
      ws.onopen = res;
      setTimeout(() => rej(new Error(`ws connect timeout to ${page.webSocketDebuggerUrl}`)), 10000);
    });
    try { await cdp.send('Page.enable'); } catch (e) {}
    return cdp;
  }

  static async connectWs(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws, null);
    LIVE_WS.add(ws);
    ws.onclose = () => LIVE_WS.delete(ws);
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } cdp._onMessage(m); };
    ws.onerror = (e) => { cdp._lastError = e.message || 'ws error'; };
    await new Promise((res, rej) => {
      ws.onopen = res;
      setTimeout(() => rej(new Error(`ws connect timeout to ${wsUrl}`)), 10000);
    });
    // 打开 Page 域：否则收不到 Page.javascriptDialogOpening（原生弹窗 = CDP 全超时的元凶）
    try { await cdp.send('Page.enable'); } catch (e) {}
    return cdp;
  }

  _onMessage(m) {
    if (m.method === 'Page.javascriptDialogOpening') {
      const p = m.params || {};
      const accept = this._acceptNext;
      this._acceptNext = false;
      this.dialogs.push({ message: p.message || '', type: p.type || '', url: p.url || '', at: Date.now(), action: accept ? 'accept' : 'cancel' });
      console.log(JSON.stringify({ stage: 'JS_DIALOG', 弹窗: (p.message || '').slice(0, 120), 类型: p.type,
        处理: accept ? '确定(离开/放弃)' : '取消(留在当前页, 不放弃)',
        说明: accept ? '⚠️ 主动放弃：导航场景，草稿可能被丢弃' : '✅ 已取消：避免"确定退出并放弃重建"' }));
      // 立刻应答，解除渲染进程阻塞（不应答 = 页面永久卡住 = CDP 全超时）
      this._send('Page.handleJavaScriptDialog', { accept }).catch(() => {});
      return;
    }
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  }

  async send(method, params = {}, sessionId) {
    return this._send(method, params, sessionId);
  }

  /** 执行 JS。超时自动重试一次（原生弹窗阻塞时，取消弹窗后第二次就能过）；仍失败抛诊断错误 */
  async eval(expression, { timeoutMs = 10000, retries = 1 } = {}) {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await this._send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, undefined, timeoutMs);
        if (r.exceptionDetails) throw new Error('eval异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) + ' ||| 片段: ' + String(expression).slice(0, 150));
        return r.result?.value;
      } catch (e) {
        lastErr = e;
        if (!/CDP超时/.test(e.message) || i === retries) break;
        // 超时：很可能是原生弹窗卡住了渲染进程 → 主动补一次"取消"，然后重试
        const dlg = this.dialogs[this.dialogs.length - 1];
        if (dlg && Date.now() - dlg.at < 30000 && dlg.action === 'accept') break;   // 是"主动离开"，重试也没意义
        try { await this._send('Page.handleJavaScriptDialog', { accept: false }, undefined, 3000); } catch (e2) {}
        console.log(JSON.stringify({ stage: 'EVAL_RETRY', 说明: '首次超时（疑似原生弹窗阻塞渲染进程），已补发取消并重试', 片段: String(expression).slice(0, 60) }));
      }
    }
    throw lastErr;
  }

  /** 明确要离开当前页（例如已发布成功、要去列表页）时调用一次 */
  acceptNextDialog() { this._acceptNext = true; }

  async navigate(url) {
    // 导航是**明确要离开**当前页 → 若页面弹"确定退出并放弃重建"，这里选择确定（否则导航会被取消卡住）
    this.acceptNextDialog();
    await this._send('Page.navigate', { url });
    // 等 load 事件或超时
    await this.eval(`new Promise(res=>{ if(document.readyState==='complete') return res(true);
      window.addEventListener('load',()=>res(true),{once:true}); setTimeout(()=>res(true),20000); })`);
  }

  async screenshot(file = '/tmp/cdp-shot.png') {
    const { data } = await this._send('Page.captureScreenshot', { format: 'png' });
    const fs = await import('node:fs');
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  async setCookie(url, name, value, domain) {
    await this._send('Network.setCookie', { url, name, value, domain });
  }

  async getAllCookies() {
    const { cookies } = await this._send('Network.getAllCookies');
    return cookies;
  }

  async close() {
    try { this.ws.close(); } catch {}
  }
}

module.exports = { Cdp, closeAllCdp };

// ⚠️ 存活 ws 注册表: undici WebSocket 会挂住 Node 事件循环——不主动关, 进程永不退出,
// 调度器会把已跑完的 job 当成 running(工具调用被迫等满超时)
const LIVE_WS = new Set();
async function closeAllCdp() {
  const arr = [...LIVE_WS];
  for (const ws of arr) { try { ws.close(); } catch {} }
  LIVE_WS.clear();
  await new Promise((r) => setTimeout(r, 200));
}