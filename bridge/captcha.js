'use strict';
/**
 * captcha.js —— 「这一页是不是被验证码/滑块拦了」的**唯一判据主人**
 *
 * 为什么单独成文件：
 *   · 原来这份判据埋在 `bit-qc-lib.js` 的 isCaptcha 里**就地内联**，别处抄不到、也**没法单测**；
 *   · 2026-09-23 实盘就漏了：m3a 抓商品图 0 张，截图 `/tmp/qc-ego/diag-m3img.png` 显示的是
 *     「**请完成下列验证后继续**」+「按住左按钮拖动完成上方拼图」——
 *     **一条都不含**老正则里的 `滑块|拖动滑块|滑动验证|安全验证` ⇒ 判成"没有验证码"，
 *     于是脚本继续在骨架屏上找死图，最后报一个误导人的「没抓到商品图」。
 *
 * 两种用法（**同一份判据**）：
 *   · ego 原生：`page.evaluate(captchaInPage)`        ← 传函数（不拼字符串、不跟转义搏斗）
 *   · CDP/字符串：`ctx.js(CAPTCHA_EXPR)`              ← 表达式形式
 */

const RE_SRC = '滑块|拖动滑块|滑动验证|安全验证|请完成下列验证|拖动完成上方拼图|按住左按钮拖动|验证后继续';
const RE = new RegExp(RE_SRC);

/** 纯函数：一段文本像不像验证码页（可单测） */
function looksLikeCaptcha(text) {
  return RE.test(String(text == null ? '' : text));
}

/**
 * 页面侧函数本体 —— **必须自包含**（会被序列化后在页面里跑，不能引用外部变量）。
 * 用 `page.evaluate(captchaInPage)` 调用。
 */
function captchaInPage() {
  const RE2 = /滑块|拖动滑块|滑动验证|安全验证|请完成下列验证|拖动完成上方拼图|按住左按钮拖动|验证后继续/;
  const t = document.body ? (document.body.innerText || '') : '';
  if (RE2.test(t)) return true;
  const el = document.querySelector('[class*="captcha"],[class*="verify"],[class*="slider"]');
  if (el && el.offsetParent && el.getBoundingClientRect().width > 100 && /验证|滑块/.test(el.innerText || '')) return true;
  return false;
}

/** 表达式形式（喂给 cdp.eval / tryEval） */
const CAPTCHA_EXPR = '(' + captchaInPage.toString() + ')()';

module.exports = { RE, RE_SRC, looksLikeCaptcha, captchaInPage, CAPTCHA_EXPR };
