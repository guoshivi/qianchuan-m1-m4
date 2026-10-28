'use strict';
/**
 * commission-parse.js — 选品车「佣金率」解析 + 保本ROI 计算（m7 品信息采集的纯函数层）
 *
 * 背景：m7「新建控成本计划」没有旧计划行可读（m8 重建能直接从旧行读 `_X%保Y`），
 *       必须去该号环境的选品车页按商品ID找品、读佣金率，再算 保本ROI / 目标ROI。
 *
 * 佣金率在选品车有 6 种表示（用户 2026-09-10 提供）：
 *   ① 团长 xx%        ② 活动高佣 xx%     ③ 双佣金 xx%
 *   ④ 只有 xx%        ⑤ 团长高佣          ⑥ 专属高佣 xx%
 * 目标：稳定提取那个 xx%。
 *
 * ⚠️ 入参必须是**佣金率那一块的文本**（不要把整张商品卡文本塞进来，
 *    否则「好评率 98%」「月销 1.2万」等数字会混入 candidates）。
 *
 * 保本ROI 公式（✅ 用户 2026-09-10 给出）：
 *   保本ROI Y = 1 ÷ (佣金率 × 服务费系数 × (1 − 退款率))
 *   默认：服务费系数 0.9（平台抽 10%）、退款率 0.15
 *   实证：现场 6 条计划全部命中（5%→26.14 / 10%→13.07 / 13%→10.06 / 15%→8.71 / 40%→3.27 / 50%→2.61）
 *   这也解释了此前的「X%×Y≈1.307」现象：K = 1/(0.9×0.85) = 1.307，**K 由退款率决定**（退款率按品不同 → K 按品不同）。
 */

const { mapRoi } = require('./roi-map.js');

/**
 * 归一化：全角％、不换行空格，以及**选品车真实 DOM 的拆散数字**
 * 实测样本（<号A>选品车 2026-09-10）：`团长 11 %`、`团长 10 .1 %`、`团长 11 .98 %`
 * —— 数字与 % 被拆到不同 span，innerText 会插入空格
 */
function normalize(text) {
  return String(text == null ? '' : text)
    .replace(/％/g, '%')
    .replace(/\u00a0/g, ' ')
    .replace(/(\d)\s*\.\s*(\d)/g, '$1.$2')   // "10 .1" → "10.1"
    .replace(/(\d)\s+%/g, '$1%')             // "11 %" → "11%"
    .replace(/\s+/g, ' ');
}

/** 识别佣金率「表示种类」（顺序敏感：高佣类要排在「团长」前面） */
const KIND_RULES = [
  { re: /团长\s*高佣/, kind: '团长高佣' },
  { re: /专属\s*高佣/, kind: '专属高佣' },
  { re: /活动\s*高佣/, kind: '活动高佣' },
  { re: /双\s*佣金/, kind: '双佣金' },
  { re: /团长/, kind: '团长' },
];

/**
 * 解析佣金率
 * @param {string} text 佣金率片段文本
 * @returns {{rate:number|null, raw:string, kind:string, candidates:number[], ambiguous:boolean}}
 *   rate        提取到的百分比数值（如 13 表示 13%）；无法确定时 null
 *   kind        表示种类（团长高佣/专属高佣/活动高佣/双佣金/团长/unknown）
 *   candidates  片段里出现的全部百分比数值
 *   ambiguous   true = 片段里有多个百分比（如「双佣金 15%+5%」），rate 取第一个，需人工/上层确认
 */
function parseCommission(text) {
  const raw = normalize(text);
  const candidates = [...raw.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) => parseFloat(m[1]));

  let kind = 'unknown';
  for (const k of KIND_RULES) {
    if (k.re.test(raw)) { kind = k.kind; break; }
  }

  let rate = null;
  let ambiguous = false;
  if (candidates.length === 1) {
    rate = candidates[0];
  } else if (candidates.length > 1) {
    rate = candidates[0];      // 约定：取第一个（达人佣金一般在前）
    ambiguous = true;
  }
  return { rate, raw, kind, candidates, ambiguous };
}

/** K = 1 ÷ (服务费系数 × (1 − 退款率))；仅用于观察/对账（K≈1.307 即退款率 15%） */
function kFromRefund(refundRate = 0.15, serviceFee = 0.9) {
  const r = parseFloat(refundRate);
  const f = parseFloat(serviceFee);
  if (!isFinite(r) || !isFinite(f) || r >= 1 || f <= 0) return null;
  return Math.round((1 / (f * (1 - r))) * 1000) / 1000;
}

/**
 * 保本ROI：Y = 1 ÷ (佣金率 × 服务费系数 × (1 − 退款率))
 * @param {number|string} ratePercent 佣金率（如 13 表示 13%）
 * @param {{refundRate?:number, serviceFee?:number}} [opts] 默认退款率 0.15、服务费系数 0.9
 * @returns {number|null} 保留两位小数；参数非法时 null
 */
function breakevenRoi(ratePercent, opts = {}) {
  const refundRate = opts.refundRate != null ? parseFloat(opts.refundRate) : 0.15;
  const serviceFee = opts.serviceFee != null ? parseFloat(opts.serviceFee) : 0.9;
  const x = parseFloat(ratePercent) / 100;
  if (!x || !isFinite(refundRate) || !isFinite(serviceFee)) return null;
  const denom = x * serviceFee * (1 - refundRate);
  if (denom <= 0) return null;
  return Math.round((1 / denom) * 100) / 100;
}

/** 数字去尾零：13 → '13'，10.06 → '10.06' */
function trimNum(v) {
  const n = parseFloat(v);
  if (!isFinite(n)) return null;
  return String(Number(n.toFixed(2)));
}

/** 计划名称后缀：_X%保Y（与 m8 从旧行解析出的 suffix 同格式） */
function buildSuffix(ratePercent, y) {
  const x = trimNum(ratePercent);
  const yy = trimNum(y);
  if (x == null || yy == null) return null;
  return `_${x}%保${yy}`;
}

/**
 * 一站式：佣金率片段 → { rate, suffix, breakeven, targetRoi }
 * @param {string} text 佣金率片段
 * @param {{refundRate?:number, serviceFee?:number}} [opts]
 */
function buildNoteAFields(text, opts = {}) {
  const p = parseCommission(text);
  const breakeven = p.rate != null ? breakevenRoi(p.rate, opts) : null;
  return {
    ...p,
    suffix: breakeven != null ? buildSuffix(p.rate, breakeven) : null,
    breakeven,                                   // 保本ROI Y
    targetRoi: breakeven != null ? mapRoi(breakeven) : null,  // 实投ROI目标
  };
}

module.exports = { parseCommission, breakevenRoi, kFromRefund, buildSuffix, buildNoteAFields, normalize, KIND_RULES };
