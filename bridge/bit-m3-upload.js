'use strict';
/**
 * bit-m3-upload.js — m3 第一步：把炮灰视频传到抖音创作者中心（只上传，不发布）
 *
 * 之前这一步是用户手动拖的，这是 m3 全自动化的最后缺口。
 * 实测：上传页有可见的 `input[type=file]`（accept 含 video/*），`DOM.setFileInputFiles` 可直接塞文件；
 *      上传后 SPA 自动跳到 `…/content/post/video?enter_from=publish_page`（bit-m3-publish.js 接手）。
 *
 * 用法：
 *   node bit-m3-upload.js --env <号A> --video ~/Downloads/paohui视频/2026-09-11/demoA26091102.mp4
 *   node bit-m3-upload.js --env <号A> --frag demoA26091102          # 自动按识别码找今天的视频
 *
 * ⚠️ 只管上传；描述/挂车/短标题/发布交给 bit-m3-publish.js。发布需人工过验证码。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { attachSite } = require('./tab-reuse.js');
const CFG = require('./qc-config.js');

const argv = process.argv || [];
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const has = (k) => argv.includes(k);
const account = require('./account.js').accountOrExit(arg('--env') || arg('--account'), '--env/--account');
const frag = arg('--frag');
const probeOnly = has('--probe');
const log = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DY = (CFG.dyEnvs || []).find((d) => (d.name || '').includes(account));
if (!DY) { log({ stage: 'ARG', ok: false, err: '号未找到: ' + account }); process.exit(3); }
const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload';

/** 找今天(或最近)的炮灰视频：~/Downloads/paohui视频/<YYYY-MM-DD>/<frag>.mp4 */
function resolveVideo() {
  const explicit = arg('--video');
  if (explicit) {
    const p = path.resolve(explicit.replace(/^~/, os.homedir()));
    if (!fs.existsSync(p)) throw new Error('--video 不存在: ' + p);
    return p;
  }
  if (!frag) throw new Error('需要 --video 或 --frag');
  const root = path.join(os.homedir(), 'Downloads', 'paohui视频');
  if (!fs.existsSync(root)) throw new Error('炮灰视频目录不存在: ' + root);
  const dirs = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
  for (const d of dirs) {
    const p = path.join(root, d, frag + '.mp4');
    if (fs.existsSync(p)) return p;
  }
  // 兜底：递归找同名文件
  for (const d of dirs) {
    const hit = fs.readdirSync(path.join(root, d)).find((f) => f === frag + '.mp4' || f.startsWith(frag + '.'));
    if (hit) return path.join(root, d, hit);
  }
  throw new Error('没找到 ' + frag + '.mp4（最近的日期目录：' + dirs.slice(0, 3).join(', ') + '）');
}

(async () => {
  let OK = false;   // ⚠️ 只有真正上传成功才退 0（原来一律 exit(0)，编排器会把失败当成功）
  let video;
  try { video = resolveVideo(); } catch (e) { log({ stage: 'ARG', ok: false, err: e.message }); process.exit(3); }
  const sizeMb = (fs.statSync(video).size / 1048576).toFixed(1);
  log({ stage: 'BOOT', ok: true, 号: DY.name, 视频: video, 大小MB: sizeMb, 模式: probeOnly ? 'probe(只找file input)' : 'upload' });

  const tab = await attachSite(DY.env, UPLOAD_URL, { logFn: log });
  if (tab.blocked) { log({ stage: 'END', ok: false, err: '导航闸等满仍未放行（自动等过窗口了，不是脚本坏了）——过 2 分钟原命令重跑' }); process.exit(1); }
  const cdp = tab.cdp;
  const js = tab.js;

  try {
    await sleep(2500);
    const href0 = await js('location.href');
    log({ stage: 'PAGE', url: String(href0).split('?')[0] });

    // 找 file input（上传页有可见的 video/* 输入）
    const inputs = await js(`[...document.querySelectorAll('input[type=file]')].map(i => ({
      accept: (i.accept||'').slice(0,60), multiple: !!i.multiple, visible: !!i.offsetParent }))`);
    log({ stage: 'FILE_INPUTS', inputs });
    if (probeOnly) { log({ stage: 'PROBE_END', 说明: '--probe：不传文件' }); return; }

    const doc = await tab.send('DOM.getDocument', { depth: -1, pierce: true });
    // 优先挑 accept 含 video 的输入
    const q = await tab.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[type=file][accept*="video"], input[type=file]',
    });
    log({ stage: 'NODE', nodeId: q.nodeId });
    if (!q.nodeId) throw new Error('上传页没有 input[type=file]');

    await tab.send('DOM.setFileInputFiles', { files: [video], nodeId: q.nodeId });
    log({ stage: 'UPLOAD_SENT', 视频: path.basename(video) });

    // 等 SPA 跳到发布页（大文件要等上传+转码，最长 10 分钟）
    let ok = false;
    for (let i = 0; i < 120; i++) {
      await sleep(5000);
      const st = await js(`(() => ({ url: location.href, t: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 200) }))()`);
      const hasEditor = await js(`!!document.querySelector('[contenteditable=true]')`);
      if (i % 6 === 0) log({ stage: 'WAIT_UPLOAD', 轮次: i + 1, url: String(st.url).split('?')[0], 编辑器: hasEditor });
      if (/content\/post\/video/.test(st.url) && hasEditor) { ok = true; break; }
      if (/上传失败|重新上传|格式不支持/.test(st.t || '')) throw new Error('上传失败: ' + st.t.slice(0, 120));
    }
    log({ stage: ok ? 'UPLOAD_DONE' : 'UPLOAD_TIMEOUT', ok,
          提示: ok ? '已到发布页 → 接着跑 bit-m3-publish.js' : '10 分钟内没跳到发布页，请人工看上传页' });
    OK = !!ok;
  } catch (e) {
    log({ stage: 'ERR', ok: false, err: e.message });
  } finally {
    try { tab.close(); } catch (e) {}
    setTimeout(() => process.exit(OK ? 0 : 1), 500);
  }
})();
