#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dedup_run.py — 去重一条龙：自动从封面池配封面 → 调 cover_dedup.py

背景（用户 2026-09-11）：
  · 封面池固定 `~/Downloads/4/image`，**以后封面都放这里**
  · 绑定规则 = **按商品ID做种子随机挑一张，同一次跑不重复**
    → 同一商品重跑结果一致；一次跑内多个商品不会撞同一张
  · 但 cover_dedup.py 认 `<产品文件夹名>.jpg`，池内是「唯美风景图_MJ07_01.jpg」这类通用名
    → 本脚本负责这层解析：挑图 → 规范化成 1080x1920 → 另存 `<产品文件夹名>.jpg`

用法:
  # 先看会给谁配哪张（不渲染、不写盘）
  python3 dedup_run.py --input ~/Downloads/default/3000000000000000001 --dry-run

  # 就地覆盖去重
  python3 dedup_run.py --input ~/Downloads/default/3000000000000000001 --inplace

  # 另存输出
  python3 dedup_run.py --input ~/Downloads/6/default --out ~/Downloads/6/default_去重3

参数:
  --input     素材根目录（子文件夹 = 产品；也接受直接给单个产品文件夹）
  --pool      封面池根目录（默认 ~/Downloads/4/image）
  --resolved  解析产物目录（默认 ~/.qc-rebuild-ego/covers-resolved，**不放进封面池**）
  --out       输出目录（与 --inplace 二选一）
  --inplace   覆盖源文件
  --workers   cover_dedup 并发（默认 3）
  --cover-sec 封面前置秒数（默认 0.04）
  --dry-run   只打印「商品 → 封面」映射，不处理视频
  --remap     忽略已有映射，重新抽签（默认沿用已存在的 <产品>.jpg）
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
COVER_DEDUP = os.path.join(HERE, "cover_dedup.py")
DEFAULT_POOL = os.path.expanduser("~/Downloads/4/image")
# ⚠️ 解析产物**不要**放池子里（用户明确「封面我全放这里」——那是他的封面目录，不该被塞东西）
# 与品台账同处 ~/.qc-rebuild/ 下，跟项目其它状态文件放一起
# ⚠️ 2026-09-22 隔离修正：ego 变体的状态根是 `~/.qc-rebuild-ego`（本仓库原来写死 `~/.qc-rebuild`
#    = **比特版的状态根**，实测会把封面映射写进对方目录 → 两个版本互相污染）。
#    可用 QC_STATE_ROOT 覆盖（与仓库其它脚本同口径）。
QC_STATE_ROOT = os.environ.get("QC_STATE_ROOT") or os.path.expanduser("~/.qc-rebuild-ego")
DEFAULT_RESOLVED = os.path.join(QC_STATE_ROOT, "covers-resolved")
IMG_EXT = (".jpg", ".jpeg", ".png", ".webp")
# ⚠️ 池内 `_` 开头的目录都是工作目录，不是成品封面：
#    _raw / _raw_old（lovart 原始产物）、_log、_resolved（本脚本解析产物）
# 踩过：只排除精确名 `_raw` 时，`_raw_old/` 里 4 张旧图会混进池子被抽中。
def _is_workdir(name):
    return name.startswith("_") or name.startswith(".")

FFMPEG, FFPROBE = "ffmpeg", "ffprobe"


def log(*a):
    print(*a, flush=True)


def collect_pool(pool):
    """递归收集封面池成品图（排除 _ 开头工作目录），返回按相对路径排序的稳定列表"""
    out = []
    for root, dirs, files in os.walk(pool):
        dirs[:] = sorted(d for d in dirs if not _is_workdir(d))
        for f in sorted(files):
            if f.lower().endswith(IMG_EXT) and not _is_workdir(f):
                out.append(os.path.join(root, f))
    return sorted(out, key=lambda p: os.path.relpath(p, pool))


def _has_media_direct(d):
    """目录里【直接】放着视频才算产品（避免把 out/、_resolved/ 这类目录当成产品）"""
    try:
        return any(
            f.lower().endswith((".mp4", ".mov")) and os.path.isfile(os.path.join(d, f))
            for f in os.listdir(d)
        )
    except OSError:
        return False


def collect_products(inp, exclude=()):
    """--input 既可以是「根目录（子文件夹=产品）」，也可以直接是单个产品文件夹

    返回 (products, single)；single=True 表示 inp 本身就是某个产品文件夹。
    ⚠️ 坑 1：cover_dedup.py 只遍历 --input 的**子文件夹** → single 时必须搭符号链接暂存层。
    ⚠️ 坑 2：--out 若落在 --input 里面，输出目录会被误当成产品（成品被二次去重）
             → 用 exclude 排除，且只认「直接含视频」的子目录。
    """
    if _has_media_direct(inp):
        return [(os.path.basename(os.path.abspath(inp)), inp)], True
    ex = {os.path.abspath(p) for p in exclude if p}
    products = []
    for d in sorted(os.listdir(inp)):
        vdir = os.path.join(inp, d)
        if not os.path.isdir(vdir) or _is_workdir(d):
            continue
        if os.path.abspath(vdir) in ex:
            continue
        if not _has_media_direct(vdir):
            continue
        products.append((d, vdir))
    return products, False


def pick_seeded(name, pool, used):
    """按 name 做种子挑一张；命中已占用则向后线性探测 → 同一次跑不重复"""
    n = len(pool)
    if not n:
        raise SystemExit("封面池为空")
    seed = int(hashlib.md5(name.encode("utf-8")).hexdigest(), 16)
    for step in range(n):
        i = (seed + step) % n
        if i not in used:
            used.add(i)
            return pool[i]
    return pool[seed % n]                        # 池子比商品还少时的兜底


def find_explicit(pool, name):
    """池里若已有 <产品名>.jpg 等精确同名图 → 尊重手工指定，优先用它"""
    for ext in (".jpg", ".jpeg", ".png", ".webp"):
        p = os.path.join(pool, name + ext)
        if os.path.exists(p):
            return p
    return None


def normalize_cover(src, dst):
    """统一成 1080x1920 的 jpg（cover_dedup 的封面滤镜要求）"""
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".tmp.jpg"
    cmd = [FFMPEG, "-y", "-i", src,
           "-vf", "scale=1080:1920:force_original_aspect_ratio=increase,"
                  "crop=1080:1920,setsar=1,format=yuv420p",
           "-frames:v", "1", "-q:v", "2", tmp]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(tmp):
        raise RuntimeError(f"封面规范化失败: {src}\n{r.stderr[-300:]}")
    os.replace(tmp, dst)
    return dst


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--pool", default=DEFAULT_POOL)
    ap.add_argument("--resolved", default=None)
    ap.add_argument("--out")
    ap.add_argument("--inplace", action="store_true")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--cover-sec", type=float, default=0.04)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--remap", action="store_true")
    args = ap.parse_args()

    inp = os.path.expanduser(args.input)
    pool_dir = os.path.expanduser(args.pool)
    resolved = os.path.expanduser(args.resolved) if args.resolved else DEFAULT_RESOLVED
    if not os.path.isdir(inp):
        raise SystemExit(f"--input 不存在: {inp}")
    if not os.path.isdir(pool_dir):
        raise SystemExit(f"封面池不存在: {pool_dir}")

    pool = collect_pool(pool_dir)
    products, single = collect_products(inp, exclude=[args.out, resolved])
    log(f"封面池 {pool_dir} → {len(pool)} 张成品图")
    log(f"待处理 {inp} → {len(products)} 个产品" + ("（单产品文件夹模式）" if single else ""))
    if not pool:
        raise SystemExit("封面池里没有可用图片")
    if not products:
        raise SystemExit(f"没找到含视频的产品文件夹（--input {inp}）")

    mapping, used, rows = {}, set(), []
    for name, vdir in products:
        key = name or os.path.basename(vdir.rstrip("/"))
        existing = None if args.remap else os.path.join(resolved, key + ".jpg")
        if existing and os.path.exists(existing):
            src, how = existing, "沿用已解析"
        else:
            explicit = find_explicit(pool_dir, key)
            if explicit:
                src, how = explicit, "池内同名(手工指定)"
            else:
                src, how = pick_seeded(key, pool, used), "种子抽签"
        mapping[key] = src
        rows.append((key, os.path.relpath(src, pool_dir), how))

    w = max((len(r[0]) for r in rows), default=8)
    for key, relsrc, how in rows:
        log(f"  {key:<{w}}  ←  {relsrc}   [{how}]")

    if args.dry_run:
        log("dry-run：未处理视频")
        return 0

    # 落盘封面（统一 1080x1920 jpg），并记映射便于追溯
    for key, src in mapping.items():
        dst = os.path.join(resolved, key + ".jpg")
        if not os.path.exists(dst) or args.remap:
            normalize_cover(src, dst)
    os.makedirs(resolved, exist_ok=True)
    with open(os.path.join(resolved, "_mapping.json"), "w", encoding="utf-8") as f:
        json.dump(mapping, f, ensure_ascii=False, indent=1)
    log(f"封面已就绪 → {resolved}（映射写 _mapping.json）")

    # 单产品文件夹时：cover_dedup 只认「子文件夹=产品」，故在临时目录搭一层同名软链
    stage = None
    cd_input = inp
    if single:
        stage = tempfile.mkdtemp(prefix="dedup-stage-")
        for key, vdir in products:
            os.symlink(os.path.abspath(vdir), os.path.join(stage, key))
        cd_input = stage

    cmd = [sys.executable, COVER_DEDUP, "--input", cd_input, "--covers", resolved,
           "--out", os.path.expanduser(args.out) if args.out else resolved,
           "--workers", str(args.workers), "--cover-sec", str(args.cover_sec)]
    if args.inplace:
        cmd.append("--inplace")
    log("→ " + " ".join(cmd))
    try:
        return subprocess.run(cmd).returncode
    finally:
        if stage:
            shutil.rmtree(stage, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
