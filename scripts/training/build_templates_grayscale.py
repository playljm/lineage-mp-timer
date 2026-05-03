#!/usr/bin/env python3
"""
Grayscale signature templates — anti-alias gradient 정보 보존.

Binary 한계: 24x36에서도 0/4/6/7/8/9 변별 안 됨 (binary threshold가 anti-alias 날려버림)
해결책: 16x24 grayscale (8-bit) 사용 — 픽셀당 256 단계 정보 보존.

비교:
  Binary 16x24:  48 bytes/template, popcount Hamming distance
  Binary 24x36:  108 bytes/template, popcount Hamming distance
  Gray   16x24:  384 bytes/template, sum-abs-diff Manhattan distance ← THIS

알고리즘:
  1. 16x24 grayscale signature (각 픽셀 = 1 byte 0~255)
  2. inter-class purity 계산 (Manhattan distance)
  3. Rank-based: top N per class
"""
import os
import json
import base64
from PIL import Image

TEMPLATES_DIR = "/root/templates"
OUTPUT = "/mnt/c/dev/lineage-mp-timer/src/js/digit-templates.json"
OUTPUT_REPORT = "/mnt/c/dev/lineage-mp-timer/build/tessdata/template-rebuild-report.txt"
SIZE = (16, 24)
PIXELS = SIZE[0] * SIZE[1]   # 384 bytes
MAX_PER_CHAR = 50

def grayscale_signature(img):
    """이미지 → 16x24 grayscale bytes (anti-alias 보존)."""
    img = img.convert("L").resize(SIZE, Image.NEAREST)
    return bytes(img.getdata())  # 384 bytes, 0~255 each

def manhattan(a, b):
    """Sum of absolute differences (grayscale-aware)."""
    return sum(abs(a[i] - b[i]) for i in range(len(a)))

def collect_all():
    all_sigs = {}
    chars = sorted(os.listdir(TEMPLATES_DIR))
    for char_dir in chars:
        char_path = os.path.join(TEMPLATES_DIR, char_dir)
        if not os.path.isdir(char_path): continue
        char = char_dir
        if char_dir == "slash": char = "/"
        elif char_dir == "dot": char = "."
        seen = set()
        sigs = []
        for png in sorted(os.listdir(char_path)):
            if not png.endswith(".png"): continue
            try:
                img = Image.open(os.path.join(char_path, png))
                gray = grayscale_signature(img)
                if gray in seen: continue
                seen.add(gray)
                sigs.append((gray, png))
            except Exception:
                pass
        all_sigs[char] = sigs
        print(f"  '{char}': {len(sigs)} unique grayscale sigs ({len(os.listdir(char_path))} PNGs)")
    return all_sigs

def filter_by_purity(all_sigs):
    chars = list(all_sigs.keys())
    # Same-class avg distance (intra) and other-class min distance (inter)
    other_sigs = {ch: [s for c2 in chars if c2 != ch for s, _ in all_sigs[c2]] for ch in chars}
    
    filtered = {}
    report_lines = []
    for ch in chars:
        sigs = all_sigs[ch]
        scored = []
        for sig, name in sigs:
            intra_dists = [manhattan(sig, s) for s, _ in sigs if s != sig]
            intra = sum(intra_dists) / max(1, len(intra_dists)) if intra_dists else 0
            inter = min((manhattan(sig, s) for s in other_sigs[ch]), default=999999)
            purity = inter - intra
            scored.append((sig, name, intra, inter, purity))
        scored.sort(key=lambda x: -x[4])
        kept = scored[:MAX_PER_CHAR]
        pos_count = sum(1 for t in scored if t[4] > 0)
        neg_count = len(scored) - pos_count
        filtered[ch] = [(t[0], t[1]) for t in kept]
        
        report_lines.append(f"\n=== '{ch}' ===")
        report_lines.append(f"  total: {len(sigs)}, kept: {len(kept)}, pos purity: {pos_count}, neg: {neg_count}")
        if kept:
            best = kept[0]
            worst = kept[-1]
            avg_purity = sum(t[4] for t in kept) / len(kept)
            report_lines.append(f"  best  purity: {best[4]:+8.0f} (intra={best[2]:7.0f} inter={best[3]:7.0f})")
            report_lines.append(f"  worst kept:   {worst[4]:+8.0f} (intra={worst[2]:7.0f} inter={worst[3]:7.0f})")
            report_lines.append(f"  avg purity:   {avg_purity:+8.0f}")
        print(f"  '{ch}': kept {len(kept)} (pos={pos_count}, neg={neg_count})")
    return filtered, report_lines

def write_output(filtered, report_lines):
    output = {
        "size": [SIZE[0], SIZE[1]],
        "format": "grayscale",
        "templates": {}
    }
    total = 0
    for ch, sigs in filtered.items():
        b64s = [base64.b64encode(sig).decode('ascii') for sig, _ in sigs]
        output["templates"][ch] = b64s
        total += len(b64s)
    
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, 'w') as f:
        json.dump(output, f, separators=(',', ':'))
    size_kb = os.path.getsize(OUTPUT) / 1024
    print(f"\n✓ {OUTPUT} ({size_kb:.1f} KB, {total} grayscale templates @ {SIZE[0]}x{SIZE[1]})")
    
    os.makedirs(os.path.dirname(OUTPUT_REPORT), exist_ok=True)
    with open(OUTPUT_REPORT, 'w') as f:
        f.write(f"=== Template Rebuild Report (GRAYSCALE, {SIZE[0]}x{SIZE[1]}, {PIXELS} bytes/template) ===\n")
        f.write(f"Total templates: {total}, distance metric: Manhattan (sum-abs-diff)\n")
        f.write("\n".join(report_lines))
    print(f"✓ Report: {OUTPUT_REPORT}")

if __name__ == "__main__":
    print(f"[1/3] Collecting GRAYSCALE signatures @ {SIZE[0]}x{SIZE[1]} ({PIXELS} bytes/template)...")
    all_sigs = collect_all()
    print("\n[2/3] Filtering by inter-class purity (Manhattan distance)...")
    filtered, report_lines = filter_by_purity(all_sigs)
    print("\n[3/3] Writing output...")
    write_output(filtered, report_lines)
    print("\nDone.")
