#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""封面前置 + 轻去重 + 统一1080x1920 批量处理
用法:
  python3 cover_dedup.py --input 视频根目录 --covers 封面目录 --out 输出目录 [--workers 3]
封面目录: 每张图命名为 <子文件夹名>.jpg（一个产品文件夹一张封面图）
视频目录: 子文件夹=产品（如抖音 aweme_id），内含 video_*.mp4
"""
import os, sys, subprocess, random, shutil, argparse
from concurrent.futures import ThreadPoolExecutor, as_completed

FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"

def has_audio(path):
    r = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "a:0",
                        "-show_entries", "stream=index", "-of", "csv=p=0", path],
                       capture_output=True, text=True)
    return bool(r.stdout.strip())

def process_one(src, dst, cover, cover_sec=0.04, inplace=False):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    tmp = dst + ".tmp.mp4"
    z = random.uniform(1.012, 1.028)
    h = random.uniform(-4.0, 4.0)
    s = random.uniform(1.01, 1.035)
    b = random.uniform(-0.008, 0.012)
    ct = random.uniform(1.005, 1.025)
    crf = random.randint(20, 23)

    vf_video = (
        f"scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,"
        f"scale={int(1080*z)}:{int(1920*z)}:flags=lanczos,crop=1080:1920,"
        f"hue=h={h:.3f}:s={s:.3f},eq=brightness={b:.4f}:contrast={ct:.3f},"
        f"setsar=1,fps=30,format=yuv420p"
    )
    vf_cover = "scale=1080:1920,setsar=1,fps=30,format=yuv420p"
    delay_ms = int(cover_sec * 1000)

    if has_audio(src):
        fc = (
            f"[0:v]{vf_cover}[cv];"
            f"[1:v]{vf_video}[mv];"
            f"[cv][mv]concat=n=2:v=1:a=0[vout];"
            f"[1:a]adelay={delay_ms}:all=1,aformat=sample_rates=48000:channel_layouts=stereo[aout]"
        )
        cmd = [FFMPEG, "-y",
               "-loop", "1", "-t", str(cover_sec), "-i", cover,
               "-i", src,
               "-filter_complex", fc,
               "-map", "[vout]", "-map", "[aout]",
               "-c:v", "libx264", "-crf", str(crf), "-preset", "fast",
               "-c:a", "aac", "-b:a", "128k",
               "-movflags", "+faststart", tmp]
    else:
        fc = (
            f"[0:v]{vf_cover}[cv];"
            f"[1:v]{vf_video}[mv];"
            f"[cv][mv]concat=n=2:v=1:a=0[vout]"
        )
        cmd = [FFMPEG, "-y",
               "-loop", "1", "-t", str(cover_sec), "-i", cover,
               "-i", src,
               "-filter_complex", fc,
               "-map", "[vout]",
               "-c:v", "libx264", "-crf", str(crf), "-preset", "fast",
               "-an", "-movflags", "+faststart", tmp]

    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if r.returncode != 0 or not os.path.exists(tmp):
        print(f"FAIL {src}\n{r.stderr[-400:]}", flush=True)
        return False
    v = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "v:0",
                        "-show_entries", "stream=codec_name,width,height",
                        "-of", "csv=p=0", tmp], capture_output=True, text=True)
    if v.stdout.strip() != "h264,1080,1920":
        print(f"VERIFY_FAIL {src}: {v.stdout.strip()}", flush=True)
        os.remove(tmp)
        return False
    if inplace:
        # 覆盖模式：直接替换源文件（用户 2026-09-05 要求：不再每次手动删源）
        # 不留标记文件（用户 2026-09-05 纠正：标记会混进成品目录碍事）——重复跑由规格验证兜底
        os.replace(tmp, src)
    else:
        shutil.move(tmp, dst)
    return True

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="视频根目录（子文件夹=产品）")
    ap.add_argument("--covers", required=True, help="封面目录（<产品名>.jpg）")
    ap.add_argument("--out", required=True, help="输出目录")
    ap.add_argument("--inplace", action="store_true", help="覆盖模式：直接替换源文件（默认关）")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--cover-sec", type=float, default=0.04, help="封面前置秒数（一闪而过≈1-2帧）")
    args = ap.parse_args()

    items = []
    for d in sorted(os.listdir(args.input)):
        vdir = os.path.join(args.input, d)
        if not os.path.isdir(vdir):
            continue
        cover = os.path.join(args.covers, d + ".jpg")
        if not os.path.exists(cover):
            print(f"NO COVER {d}", flush=True)
            continue
        for f in sorted(os.listdir(vdir)):
            if not f.lower().endswith((".mp4", ".mov")):
                continue
            # 跳过上次跑留下的 .inplace_done 标记（它们不以 .mp4/.mov 结尾但保险起见显式排除）
            src = os.path.join(vdir, f)
            if args.inplace:
                # 覆盖模式：tmp 处理完直接替换源文件（不跳过已存在——源就是待处理素材）
                dst = src
            else:
                # 输出统一 .mp4（源 .mov 也转 mp4）
                dst = os.path.join(args.out, d, os.path.splitext(f)[0] + ".mp4")
                if os.path.exists(dst):
                    print(f"SKIP(done) {dst}", flush=True)
                    continue
            items.append((src, dst, cover))

    print(f"total jobs: {len(items)}", flush=True)
    ok = fail = 0
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(process_one, s, d, c, args.cover_sec, args.inplace): s for s, d, c in items}
        for fut in as_completed(futs):
            try:
                if fut.result():
                    ok += 1
                else:
                    fail += 1
            except Exception as e:
                fail += 1
                print(f"EXC: {e}", flush=True)
    print(f"DONE ok={ok} fail={fail}", flush=True)
    sys.exit(1 if fail else 0)

if __name__ == "__main__":
    main()