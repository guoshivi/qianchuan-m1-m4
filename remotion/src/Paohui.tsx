import React from "react";
import {
  AbsoluteFill,
  Img,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  random,
  staticFile,
} from "remotion";

/**
 * Paohui — 炮灰视频合成（8~10 秒随机 / 9:16 / **6 套不同场景模板 + 参数随机**）
 *
 * 用户 2026-09-11 反馈：「3 个视频肉眼除了颜色其他都一样」→ 不能只随机参数，必须**结构不同**。
 * 因此这里改成 6 套场景模板（scene），由 seed 随机挑一套；每套内部参数继续随机：
 *   ① classic  居中卡片 + 光带 + 粒子（基础款）
 *   ② circle   圆形主图 + 旋转虚线环 + 轨道粒子 + 脉冲波纹
 *   ③ blinds   主图横条分割滑入拼合 + 扫描线 + 噪点
 *   ④ bounce   弹性弹入 + 手持抖动 + 地面倒影 + 贴纸标签
 *   ⑤ glitch   RGB 分离故障 + 扫描线 + 缩放脉冲 + 斜纹背景
 *   ⑥ glass    磨砂玻璃卡 + 大光斑 bokeh + 跑马灯描边 + 慢漂移
 *
 * ⚠️ 硬规则（用户 2026-09-11）：
 *   ① **任何元素都不得遮挡产品主图**（贴纸/标签一律放卡片外；粒子与光效画在卡片下层）
 *   ② **主图不得全屏铺满覆盖特效**（横条类只拼成卡片，四周必须能看见背景特效）
 *
 * 渲染：npx remotion render src/index.ts Paohui out/x.mp4 \
 *        --props='{"seed":"demoA26091102","durationSec":8.4}'
 */

const EASE_OUT = Easing.bezier(0, 0, 0.2, 1);
const EASE_IN_OUT = Easing.bezier(0.25, 0.1, 0.25, 1);
const EASE_BOUNCE = Easing.bezier(0.16, 1.4, 0.3, 1);

const PALETTES = [
  ["#1a1024", "#3d1f4d", "#ffd6a5", "#ff8fab"],
  ["#0b1220", "#12304d", "#a5e8ff", "#7cc4ff"],
  ["#1d1508", "#3d2c10", "#ffe6a5", "#ffb347"],
  ["#08130f", "#0f3a2c", "#b8ffd9", "#5ce1a6"],
  ["#1a0d0d", "#3d1414", "#ffd0d0", "#ff7a7a"],
];
const SCENES = ["combo", "classic", "circle", "blinds", "bounce", "glitch", "glass"] as const;

type Ctx = {
  frame: number;
  fps: number;
  W: number;
  H: number;
  frames: number;
  src: string;
  seed: string;
  bgDark: string;
  bgMid: string;
  a: string;
  b: string;
  R: (k: string) => number;
  cardSize: number;
  radius: number;
  /** 多图（≥1）；combo 场景会按段落轮播 */
  imgs: string[];
};

// ---------- 通用零件 ----------

const Particles: React.FC<Ctx & { n: number; rise?: boolean }> = ({ frame, fps, H, R, a, b, n, rise = true }) => (
  <AbsoluteFill>
    {Array.from({ length: n }, (_, i) => {
      const x = R(`px${i}`) * 1080;
      const y0 = H + R(`py${i}`) * 500;
      const r = 2.5 + R(`pr${i}`) * 9;
      const speed = 70 + R(`ps${i}`) * 180;
      const alpha = 0.08 + R(`pa${i}`) * 0.3;
      const y = rise
        ? ((y0 - frame * (speed / fps)) % (H + 600) + H + 600) % (H + 600)
        : (R(`py${i}`) * H + Math.sin((frame / fps) * (0.6 + R(`pf${i}`)) + i) * 40);
      const dx = Math.sin((frame / fps) * 0.7 + i) * 26;
      return (
        <div
          key={i}
          style={{
            position: "absolute",
            left: x + dx,
            top: y,
            width: r,
            height: r,
            borderRadius: "50%",
            background: R(`pc${i}`) > 0.5 ? a : b,
            opacity: alpha,
            boxShadow: `0 0 ${r * 2.5}px ${R(`pc${i}`) > 0.5 ? a : b}`,
          }}
        />
      );
    })}
  </AbsoluteFill>
);

/** 跑马灯虚线描边 */
const DashBorder: React.FC<{ frame: number; size: number; radius: number; color: string; gap?: number }> = ({
  frame,
  size,
  radius,
  color,
  gap = 16,
}) => (
  <div
    style={{
      position: "absolute",
      inset: -4,
      borderRadius: radius + 4,
      border: `3px dashed ${color}`,
      opacity: 0.75,
      transform: `rotate(${frame * 0.8}deg)`,
      backgroundImage: `repeating-conic-gradient(${color}00 0deg ${gap}deg, ${color}66 ${gap}deg ${gap * 2}deg)`,
      WebkitMaskImage: "linear-gradient(#000 0 0)",
      pointerEvents: "none",
    }}
  />
);

/** 贴纸（斜胶带） */
const Tape: React.FC<{ text: string; x: number; y: number; rot: number; color: string }> = ({ text, x, y, rot, color }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      transform: `rotate(${rot}deg)`,
      padding: "10px 26px",
      background: `${color}dd`,
      color: "#1b1b1b",
      fontWeight: 800,
      fontSize: 40,
      letterSpacing: 2,
      borderRadius: 6,
      boxShadow: "0 10px 24px rgba(0,0,0,0.35)",
      whiteSpace: "nowrap",
    }}
  >
    {text}
  </div>
);

/** 背景：模糊主图 + 移动光斑 */
const BgBlur: React.FC<Ctx & { zoomFrom: number; zoomTo: number; rot: number; blur: number }> = ({
  frame,
  fps,
  src,
  bgDark,
  bgMid,
  a,
  b,
  frames,
  zoomFrom,
  zoomTo,
  rot,
  blur,
}) => {
  const s = interpolate(frame, [0, frames], [zoomFrom, zoomTo], { easing: EASE_IN_OUT, extrapolateRight: "clamp" });
  const r = interpolate(frame, [0, frames], [-rot, rot], { extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <Img
        src={src}
        style={{
          position: "absolute",
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${s}) rotate(${r}deg)`,
          filter: `blur(${blur}px) brightness(0.36) saturate(1.3)`,
        }}
      />
      {[0, 1, 2].map((i) => {
        const sx = (i * 37 + 12) % 100;
        const sy = (i * 53 + 20) % 100;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${sx + Math.sin((frame / fps) * 0.25 + i) * 16}%`,
              top: `${sy + Math.cos((frame / fps) * 0.2 + i) * 12}%`,
              width: "46%",
              height: "46%",
              transform: "translate(-50%,-50%)",
              borderRadius: "50%",
              background: `radial-gradient(circle, ${i % 2 ? a : b} 0%, rgba(0,0,0,0) 68%)`,
              opacity: 0.26,
            }}
          />
        );
      })}
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 42%, rgba(255,255,255,0.06) 0%, ${bgMid}cc 48%, ${bgDark}f2 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};


// ---------- 场景 ⓪ combo（★用户指定：横条拼卡 + 经典卡片，支持多图轮播） ----------
// 结构：背景模糊图（多图交叉淡入） + 卡片（横条滑入拼成） + 光带 + 粒子（卡片下层）
// 多图：把时长均分成 N 段，每段一张图；段间用「横条滑出→滑入」做转场
const SceneCombo: React.FC<Ctx> = (c) => {
  const { frame, fps, src, R, a, b, cardSize, radius, H, W, frames, imgs } = c;
  const N = Math.max(1, imgs.length);
  const seg = frames / N;
  const idx = Math.min(N - 1, Math.floor(frame / seg));
  const local = frame - idx * seg;
  const cur = imgs[idx] || src;
  const prev = imgs[Math.max(0, idx - 1)] || cur;

  const bandN = 8 + Math.round(R("bn") * 5);      // 8~13 条
  const bandH = cardSize / bandN;
  const left = (W - cardSize) / 2;
  const topY = (H - cardSize) / 2;
  const floatY = Math.sin((frame / fps) * (0.9 + R("ff") * 1.1)) * (10 + R("fa") * 18);
  const breathe = 1 + Math.sin((frame / fps) * 1.05) * (0.006 + R("br") * 0.016);
  const tilt = Math.sin((frame / fps) * 0.7) * (1.2 + R("tl") * 2.2);

  // 段内：滑入(前18帧) / 滑出(后14帧)
  const enterP = (f: number) => Math.max(0, Math.min(1, (f - 2) / 18));
  const exitP = (f: number) => Math.max(0, Math.min(1, (f - (seg - 14)) / 14));

  // 背景交叉淡入（段首 20 帧）
  const bgMix = Math.max(0, Math.min(1, local / 20));

  return (
    <>
      {/* 背景：上一张 → 当前张 交叉淡入 */}
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <Img src={prev} style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover", filter: "blur(46px) brightness(0.34) saturate(1.3)", transform: `scale(${1.3 + Math.sin(frame / fps) * 0.04})`, opacity: 1 - bgMix }} />
        <Img src={cur} style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover", filter: "blur(46px) brightness(0.34) saturate(1.3)", transform: `scale(${1.3 - Math.sin(frame / fps) * 0.04})`, opacity: bgMix }} />
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ position: "absolute", left: `${(i * 37 + 14) % 100 + Math.sin((frame / fps) * 0.25 + i) * 15}%`, top: `${(i * 53 + 18) % 100 + Math.cos((frame / fps) * 0.2 + i) * 12}%`, width: "48%", height: "48%", transform: "translate(-50%,-50%)", borderRadius: "50%", background: `radial-gradient(circle, ${i % 2 ? a : b} 0%, rgba(0,0,0,0) 68%)`, opacity: 0.26 }} />
        ))}
        <AbsoluteFill style={{ background: `radial-gradient(circle at 50% 42%, rgba(255,255,255,0.06) 0%, ${c.bgMid}cc 48%, ${c.bgDark}f2 100%)` }} />
      </AbsoluteFill>

      {/* 粒子（卡片下层，不遮主图） */}
      <Particles {...c} n={14 + Math.round(R("pn") * 20)} />

      {/* 卡片底座（先画，避免遮图） */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ width: cardSize, height: cardSize, borderRadius: radius, background: "#0b0b12", boxShadow: `0 46px 100px rgba(0,0,0,0.6), 0 0 64px ${a}44`, transform: `translateY(${floatY}px) scale(${breathe}) rotate(${tilt}deg)` }} />
      </AbsoluteFill>

      {/* 横条：当前图滑入拼卡；段尾滑出 */}
      {Array.from({ length: bandN }, (_, i) => {
        const stagger = i * (1.6 + R(`sd${i}`) * 3.2);
        const ent = enterP(local - stagger);
        const ext = exitP(local + stagger * 0.4);
        const dir = R(`dir${i}`) > 0.5 ? 1 : -1;
        const off = (1 - ent) * dir * 760 + ext * -dir * 760;
        const isFirst = i === 0;
        const isLast = i === bandN - 1;
        return (
          <div key={i} style={{ position: "absolute", left, top: topY + i * bandH + floatY, width: cardSize, height: bandH + 1, overflow: "hidden", transform: `translateX(${off}px) scale(${breathe})`, opacity: Math.max(0, 1 - ext * 0.15), borderTopLeftRadius: isFirst ? radius : 0, borderTopRightRadius: isFirst ? radius : 0, borderBottomLeftRadius: isLast ? radius : 0, borderBottomRightRadius: isLast ? radius : 0 }}>
            <Img src={cur} style={{ position: "absolute", top: -i * bandH, left: 0, width: cardSize, height: cardSize, objectFit: "cover" }} />
          </div>
        );
      })}

      {/* 光带（半透明高光，不遮挡内容） */}
      {Array.from({ length: 1 + Math.round(R("swn") * 1) }, (_, i) => {
        const t0 = idx * seg + 22 + i * 46;
        const x = interpolate(frame, [t0, t0 + 66], [-700, 1600], { easing: EASE_IN_OUT, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const o = interpolate(frame, [t0, t0 + 16, t0 + 46, t0 + 66], [0, 0.5, 0.5, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return <div key={i} style={{ position: "absolute", top: topY - 200 + floatY, left: x, width: 220, height: cardSize + 400, transform: `rotate(${-22 + R(`sa${i}`) * 44}deg)`, background: "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.62) 50%, rgba(255,255,255,0) 100%)", opacity: o, filter: "blur(8px)" }} />;
      })}

      {/* 暗角 */}
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 50%, rgba(0,0,0,0.55) 100%)" }} />
    </>
  );
};

// ---------- 场景 ① classic ----------
const SceneClassic: React.FC<Ctx> = (c) => {
  const { frame, fps, frames, src, R, cardSize, radius } = c;
  const enter = interpolate(frame, [4, 28], [0, 1], { easing: EASE_OUT, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const y = interpolate(frame, [4, 28], [160, 0], { easing: EASE_OUT, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const floatY = Math.sin((frame / fps) * (0.9 + R("ff") * 1.2)) * (10 + R("fa") * 20);
  const tilts = interpolate(frame, [0, frames], [-(R("t") - 0.5) * 6, (R("t") - 0.5) * 6]);
  const sweeps = 1 + Math.round(R("sw") * 2);
  return (
    <>
      <Particles {...c} n={12 + Math.round(R("pn") * 22)} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div
          style={{
            width: cardSize,
            height: cardSize,
            transform: `translateY(${y + floatY}px) scale(${enter}) rotate(${tilts}deg)`,
            opacity: enter,
            borderRadius: radius,
            overflow: "hidden",
            position: "relative",
            backgroundColor: "#fff",
            boxShadow: `0 46px 100px rgba(0,0,0,0.58), 0 0 60px ${c.a}44`,
          }}
        >
          <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          {Array.from({ length: sweeps }, (_, i) => {
            const t0 = 20 + i * 55;
            const x = interpolate(frame, [t0, t0 + 70], [-700, 1600], { easing: EASE_IN_OUT, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            const o = interpolate(frame, [t0, t0 + 18, t0 + 50, t0 + 70], [0, 0.65, 0.65, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            return (
              <div key={i} style={{ position: "absolute", top: -300, left: x, width: 220, height: cardSize + 600, transform: `rotate(${-25 + R(`sa${i}`) * 50}deg)`, background: "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.8) 50%, rgba(255,255,255,0) 100%)", opacity: o, filter: "blur(7px)" }} />
            );
          })}
        </div>
      </AbsoluteFill>
    </>
  );
};

// ---------- 场景 ② circle ----------
const SceneCircle: React.FC<Ctx> = (c) => {
  const { frame, fps, src, R, a, b, cardSize } = c;
  const d = Math.min(cardSize, 820);
  const enter = interpolate(frame, [4, 30], [0.6, 1], { easing: EASE_BOUNCE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const ringRot = frame * (0.7 + R("rr") * 1.4);
  const wobble = Math.sin((frame / fps) * 1.4) * 6;
  // 脉冲波纹
  // 波纹从卡片外开始扩散（scale ≥ 1.05），保证不压主图
  const waves = Array.from({ length: 3 }, (_, i) => {
    const t = ((frame / fps) * 0.55 + i * 0.33) % 1;
    return { scale: 1.06 + t * 1.0, o: (1 - t) * 0.45 };
  });
  return (
    <>
      <Particles {...c} n={8 + Math.round(R("pn") * 18)} />
      {/* 脉冲波纹 */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        {waves.map((w, i) => (
          <div key={i} style={{ position: "absolute", width: d * w.scale, height: d * w.scale, borderRadius: "50%", border: `4px solid ${i % 2 ? a : b}`, opacity: w.o }} />
        ))}
      </AbsoluteFill>
      {/* 旋转虚线环 */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ position: "absolute", width: d * 1.28, height: d * 1.28, borderRadius: "50%", border: `6px dashed ${a}`, opacity: 0.85, transform: `rotate(${ringRot}deg)` }} />
        <div style={{ position: "absolute", width: d * 1.44, height: d * 1.44, borderRadius: "50%", border: `2px dotted ${b}`, opacity: 0.6, transform: `rotate(${-ringRot * 0.6}deg)` }} />
      </AbsoluteFill>
      {/* 主图（圆形） */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ width: d, height: d, borderRadius: "50%", overflow: "hidden", transform: `scale(${enter}) rotate(${wobble}deg)`, boxShadow: `0 40px 90px rgba(0,0,0,0.6), 0 0 70px ${a}66`, border: `10px solid rgba(255,255,255,0.9)` }}>
          <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        </div>
      </AbsoluteFill>
      {/* 轨道粒子 */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        {Array.from({ length: 10 }, (_, i) => {
          const ang = (i / 10) * Math.PI * 2 + frame * (0.4 + R("orbit") * 0.8);
          const rad = d * (0.78 + R(`or${i}`) * 0.25);
          return (
            <div key={i} style={{ position: "absolute", width: 12 + R(`os${i}`) * 14, height: 12 + R(`os${i}`) * 14, borderRadius: "50%", background: i % 2 ? a : b, boxShadow: `0 0 18px ${i % 2 ? a : b}`, transform: `translate(${Math.cos(ang) * rad}px, ${Math.sin(ang) * rad}px)` }} />
          );
        })}
      </AbsoluteFill>
    </>
  );
};

// ---------- 场景 ③ blinds（横条拼成**卡片**，不铺满全屏） ----------
// ⚠️ 用户要求：产品主图不能被其他元素遮挡；主图也不能全屏把特效盖掉。
//    所以横条只拼成 cardSize 的卡片，四周保留背景特效。
const SceneBlinds: React.FC<Ctx> = (c) => {
  const { frame, fps, src, R, a, b, cardSize, radius, H, W } = c;
  const N = 7 + Math.round(R("bn") * 5); // 7~12 条
  const bandH = cardSize / N;
  const left = (W - cardSize) / 2;
  const top = (H - cardSize) / 2;
  const floatY = Math.sin((frame / fps) * 1.1) * 14;
  const grain = Array.from({ length: 70 }, (_, i) => ({ x: R(`gx${i}`) * W, y: R(`gy${i}`) * H, s: 1 + R(`gs${i}`) * 3, o: 0.03 + R(`go${i}`) * 0.07 }));
  const scanY = ((frame * (6 + R("ss") * 8)) % (H + 200)) - 100;
  return (
    <>
      {/* 卡片外框（先画，避免遮挡） */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ width: cardSize, height: cardSize, borderRadius: radius, boxShadow: `0 46px 100px rgba(0,0,0,0.6), 0 0 60px ${a}44`, background: "#0c0c12", transform: `translateY(${floatY}px)` }} />
      </AbsoluteFill>
      {/* 横条依次滑入，拼成卡片内的主图 */}
      {Array.from({ length: N }, (_, i) => {
        const delay = 4 + i * (2 + R(`bd${i}`) * 5);
        const pgs = interpolate(frame, [delay, delay + 22], [0, 1], { easing: EASE_OUT, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const fromLeft = R(`bside${i}`) > 0.5;
        const dx = (1 - pgs) * (fromLeft ? -1 : 1) * 700;
        const yOff = Math.sin((frame / fps) * 0.8 + i) * 3;
        const isFirst = i === 0;
        const isLast = i === N - 1;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left,
              top: top + i * bandH + floatY + yOff,
              width: cardSize,
              height: bandH + 1,
              overflow: "hidden",
              transform: `translateX(${dx}px)`,
              opacity: pgs,
              borderTopLeftRadius: isFirst ? radius : 0,
              borderTopRightRadius: isFirst ? radius : 0,
              borderBottomLeftRadius: isLast ? radius : 0,
              borderBottomRightRadius: isLast ? radius : 0,
            }}
          >
            <Img
              src={src}
              style={{ position: "absolute", top: -i * bandH, left: 0, width: cardSize, height: cardSize, objectFit: "cover", filter: `saturate(${1 + R(`bsat${i}`) * 0.35})` }}
            />
          </div>
        );
      })}
      {/* 卡片外的扫描线（只在四周，不压主图） */}
      <AbsoluteFill>
        {[0, 1].map((i) => {
          const y = i === 0 ? scanY : ((frame * (9 + R("ss2") * 6)) % (H + 200)) - 100;
          const outside = y < top - 30 || y > top + cardSize + 30;
          if (!outside) return null;
          return <div key={i} style={{ position: "absolute", top: y, left: 0, width: W, height: 110, background: `linear-gradient(180deg, ${a}00, ${i % 2 ? a : b}77, ${b}00)`, filter: "blur(10px)", mixBlendMode: "screen" }} />;
        })}
      </AbsoluteFill>
      {/* 噪点（极淡，符合胶片感，不遮挡） */}
      <AbsoluteFill>
        {grain.map((g, i) => (
          <div key={i} style={{ position: "absolute", left: g.x, top: (g.y + frame * 3) % H, width: g.s, height: g.s, background: "#fff", opacity: g.o }} />
        ))}
      </AbsoluteFill>
    </>
  );
};

// ---------- 场景 ④ bounce（弹性 + 手持抖动 + 倒影 + 贴纸） ----------
const SceneBounce: React.FC<Ctx> = (c) => {
  const { frame, fps, src, R, a, b, cardSize, radius } = c;
  const enter = interpolate(frame, [3, 34], [0, 1], { easing: EASE_BOUNCE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const fromY = interpolate(frame, [3, 34], [-700, 0], { easing: EASE_BOUNCE, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const squash = 1 + Math.sin(frame / 6) * 0.02 * (frame < 60 ? 1 : 0.3);
  const shakeX = Math.sin(frame * 1.7) * (0.6 + R("shk") * 2.2);
  const shakeY = Math.cos(frame * 1.9) * (0.6 + R("shk2") * 2.2);
  const rot = Math.sin((frame / fps) * 0.9) * 3;
  const labels = ["实拍", "日常", "真实体验", "自用推荐", "随手拍"];
  const pick = labels[Math.floor(R("lb") * labels.length)];
  return (
    <>
      <Particles {...c} n={10 + Math.round(R("pn") * 16)} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ transform: `translate(${shakeX}px, ${fromY + shakeY}px) scale(${enter}) rotate(${rot}deg)` }}>
          {/* 卡片 */}
          <div style={{ width: cardSize, height: cardSize, borderRadius: radius, overflow: "hidden", position: "relative", backgroundColor: "#fff", transform: `scaleY(${squash}) scaleX(${2 - squash})`, boxShadow: `0 50px 90px rgba(0,0,0,0.55), 0 0 50px ${a}55` }}>
            <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            {/* 高光扫过 */}
            <div style={{ position: "absolute", top: -200, left: interpolate(frame, [35, 110], [-500, 1400], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }), width: 180, height: cardSize + 400, transform: "rotate(20deg)", background: "linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.75), rgba(255,255,255,0))", filter: "blur(6px)", opacity: interpolate(frame, [35, 60, 95, 110], [0, 0.6, 0.6, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }} />
          </div>
          {/* 贴纸（⚠️ 一律放在卡片【外面】，不遮挡产品主图） */}
          <Tape text={pick} x={cardSize * 0.5 - 110} y={-96} rot={-8 + R("tr") * 14} color={a} />
          <div style={{ position: "absolute", left: cardSize * 0.5 - 90, top: cardSize + 26, padding: "12px 26px", borderRadius: 999, background: b, color: "#101010", fontWeight: 900, fontSize: 44, boxShadow: "0 12px 30px rgba(0,0,0,0.4)", transform: `rotate(${4 + R("pr") * 8}deg)` }}>
            好物
          </div>
        </div>
      </AbsoluteFill>
      {/* 地面倒影 */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", top: cardSize * 0.55 }}>
        <div style={{ width: cardSize, height: cardSize * 0.5, borderRadius: `0 0 ${radius}px ${radius}px`, overflow: "hidden", transform: `scaleY(-0.5) translateY(${fromY * 0.4}px)`, opacity: 0.22 * enter, filter: "blur(3px)" }}>
          <Img src={src} style={{ width: "100%", height: "200%", objectFit: "cover" }} />
        </div>
      </AbsoluteFill>
    </>
  );
};

// ---------- 场景 ⑤ glitch ----------
const SceneGlitch: React.FC<Ctx> = (c) => {
  const { frame, src, R, a, b, cardSize, radius } = c;
  const glitchOn = (f: number) => R(`gp${Math.floor(f / 6)}`) > 0.62;
  const on = glitchOn(frame);
  const dx = on ? (R("gdx") - 0.5) * 26 : 0;
  const dy = on ? (R("gdy") - 0.5) * 14 : 0;
  const zoom = 1 + Math.sin(frame / (7 + R("gz") * 8)) * 0.03;
  const stripes = 1 + Math.round(R("stn") * 2);
  return (
    <>
      {/* 斜纹背景滚动 */}
      <AbsoluteFill style={{ background: `linear-gradient(${30 + R("sa") * 40}deg, ${c.bgDark}, ${c.bgMid})` }} />
      <AbsoluteFill style={{ opacity: 0.22, backgroundImage: `repeating-linear-gradient(${30 + R("sa") * 40}deg, ${a} 0 2px, transparent 2px 22px)`, backgroundPosition: `${frame * 6}px 0` }} />
      {/* RGB 分离故障 */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ width: cardSize, height: cardSize, position: "relative", transform: `scale(${zoom})`, borderRadius: radius, overflow: "hidden", boxShadow: `0 40px 90px rgba(0,0,0,0.6), 0 0 60px ${a}66` }}>
          <Img src={src} style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover", filter: "contrast(1.08) saturate(1.15)" }} />
          <Img src={src} style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover", transform: `translate(${dx}px, ${dy}px)`, mixBlendMode: "screen", opacity: on ? 0.5 : 0, filter: "hue-rotate(-40deg)" }} />
          <Img src={src} style={{ position: "absolute", width: "100%", height: "100%", objectFit: "cover", transform: `translate(${-dx}px, ${-dy}px)`, mixBlendMode: "screen", opacity: on ? 0.45 : 0, filter: "hue-rotate(60deg)" }} />
          {/* 故障扫过条 */}
          {on && <div style={{ position: "absolute", top: R("gty") * cardSize, left: 0, width: "100%", height: 8 + R("gth") * 26, background: "rgba(255,255,255,0.65)" }} />}
        </div>
      </AbsoluteFill>
      {/* 扫描线组（⚠️ 只扫卡片外区域，不横穿产品主图） */}
      <AbsoluteFill>
        {Array.from({ length: stripes }, (_, i) => {
          const y = ((frame * (10 + R(`sy${i}`) * 26)) % 2100) - 100;
          const top = (c.H - cardSize) / 2;
          const overCard = y + 90 > top && y < top + cardSize;
          if (overCard) return null;
          return <div key={i} style={{ position: "absolute", top: y, left: 0, width: c.W, height: 90, background: `linear-gradient(180deg, ${a}00, ${i % 2 ? a : b}88, ${b}00)`, mixBlendMode: "screen" }} />;
        })}
      </AbsoluteFill>
    </>
  );
};

// ---------- 场景 ⑥ glass（磨砂玻璃 + bokeh） ----------
const SceneGlass: React.FC<Ctx> = (c) => {
  const { frame, fps, src, R, a, b, cardSize, radius } = c;
  const enter = interpolate(frame, [5, 40], [0, 1], { easing: EASE_OUT, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const drift = Math.sin((frame / fps) * 0.6) * 26;
  const drift2 = Math.cos((frame / fps) * 0.5) * 18;
  const bokeh = Array.from({ length: 7 }, (_, i) => ({
    x: R(`bx${i}`) * 1080,
    y: R(`by${i}`) * 1920,
    r: 90 + R(`br${i}`) * 260,
    o: 0.1 + R(`bo${i}`) * 0.22,
    sp: 0.2 + R(`bsp${i}`) * 0.6,
    col: R(`bc${i}`) > 0.5 ? a : b,
  }));
  return (
    <>
      <BgBlur {...c} zoomFrom={1.1} zoomTo={1.3} rot={3} blur={60} />
      {/* bokeh 光斑 */}
      <AbsoluteFill>
        {bokeh.map((k, i) => (
          <div key={i} style={{ position: "absolute", left: k.x + Math.sin((frame / fps) * k.sp + i) * 60, top: k.y + Math.cos((frame / fps) * k.sp * 0.8 + i) * 50, width: k.r, height: k.r, borderRadius: "50%", background: `radial-gradient(circle, ${k.col} 0%, ${k.col}00 70%)`, opacity: k.o, transform: "translate(-50%,-50%)", filter: "blur(2px)" }} />
        ))}
      </AbsoluteFill>
      {/* 磨砂玻璃卡 */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ padding: 22, borderRadius: radius + 18, background: "rgba(255,255,255,0.14)", backdropFilter: "blur(14px)", border: "1px solid rgba(255,255,255,0.28)", boxShadow: `0 50px 110px rgba(0,0,0,0.5), 0 0 70px ${a}44`, transform: `translate(${drift}px, ${drift2}px) scale(${enter})`, opacity: enter }}>
          <div style={{ width: cardSize, height: cardSize, borderRadius: radius, overflow: "hidden", position: "relative", backgroundColor: "#fff" }}>
            <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
          <DashBorder frame={frame} size={cardSize} radius={radius} color={b} />
        </div>
      </AbsoluteFill>
    </>
  );
};

// ---------- 主组件 ----------
export const Paohui: React.FC<{
  imgSrc?: string;
  imgSrcs?: string[];
  seed?: string;
  durationSec?: number;
  scene?: string;
  /** 首帧封面段（秒）：这一段**整屏显示商品主图**，抖音默认封面就取首帧 → 用户 2026-09-18 定 */
  coverSec?: number;
}> = ({ imgSrc, imgSrcs, seed = "default", durationSec = 9, scene, coverSec = 0.6 }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const src = imgSrc || staticFile("paohui-main.png");
  const imgs = (imgSrcs && imgSrcs.length ? imgSrcs : [src]);
  const R = (k: string) => random(`${seed}-${k}`);

  const palette = PALETTES[Math.floor(R("palette") * PALETTES.length)];
  // 默认优先 combo（用户 2026-09-11 指定：横条拼卡 + 经典卡片结合）
  const pool = imgs.length > 1 ? (["combo", "combo", "classic", "glass"] as const) : SCENES;
  const picked = (scene && SCENES.includes(scene as any) ? scene : pool[Math.floor(R("scene") * pool.length)]) as (typeof SCENES)[number];

  const ctx: Ctx = {
    frame,
    fps,
    W: width,
    H: height,
    frames: durationInFrames,
    src,
    seed,
    bgDark: palette[0],
    bgMid: palette[1],
    a: palette[2],
    b: palette[3],
    R,
    cardSize: 700 + Math.round(R("card") * 220),
    radius: Math.round(R("radius") * 70),
    imgs,
  };

  const fadeIn = 6 + Math.round(R("fi") * 8);
  const fadeOut = 8 + Math.round(R("fo") * 8);
  const opacity = interpolate(frame, [0, fadeIn, durationInFrames - fadeOut, durationInFrames - 1], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  // 🖼 首帧封面段（2026-09-18 用户定：炮灰视频用商品主图做封面）
  //   · 开头 coverFrames 帧**整屏主图**（imgs[0] = 详情页图库第一张 = 主图）
  //   · 末 3 帧淡出，接回特效场景；总时长不变
  const coverFrames = Math.max(0, Math.round(coverSec * fps));
  const coverOpacity = coverFrames > 0
    ? interpolate(frame, [Math.max(0, coverFrames - 3), coverFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 0;

  const NewTabHint = process.env.PAOHUI_DEBUG_SCENE ? (
    <div style={{ position: "absolute", bottom: 20, left: 20, color: "#fff", fontFamily: "monospace", fontSize: 28, opacity: 0.7 }}>
      {picked} | {durationSec}s
    </div>
  ) : null;

  return (
    <>
    <AbsoluteFill style={{ backgroundColor: ctx.bgDark, opacity }}>
      {/* 背景（blinds/glitch 自绘背景，其余用模糊主图） */}
      {picked !== "combo" && picked !== "blinds" && picked !== "glitch" && picked !== "glass" && (
        <BgBlur {...ctx} zoomFrom={1.25 + R("bz") * 0.4} zoomTo={1.5 + R("bz") * 0.4} rot={(R("br") - 0.5) * 12} blur={30 + R("blur") * 50} />
      )}
      {picked === "combo" && <SceneCombo {...ctx} />}
      {picked === "classic" && <SceneClassic {...ctx} />}
      {picked === "circle" && <SceneCircle {...ctx} />}
      {picked === "blinds" && <SceneBlinds {...ctx} />}
      {picked === "bounce" && <SceneBounce {...ctx} />}
      {picked === "glitch" && <SceneGlitch {...ctx} />}
      {picked === "glass" && <SceneGlass {...ctx} />}
      {NewTabHint}
    </AbsoluteFill>
    /* 🖼 首帧封面段放在**淡入容器之外**：容器 opacity 从 0 起步，放里面首帧会全黑
       （2026-09-18 实测踩到：抽出第 0 帧是纯黑）*/
    {coverFrames > 0 && frame < coverFrames + 1 ? (
      <AbsoluteFill style={{ opacity: coverOpacity, backgroundColor: "#000" }}>
        <Img src={imgs[0]} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </AbsoluteFill>
    ) : null}
    </>
  );
};
