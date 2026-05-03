#!/usr/bin/env python3
"""
Inter-class purity rank-based filtering — 라벨 노이즈/시각적 outlier 제거 + 해상도 24x36 업그레이드.

알고리즘:
  1. 각 글자 PNG → 24x36 binary signature (108 bytes packed)
  2. 각 샘플 purity = (other class min Hamming) - (own class avg Hamming)
  3. Rank-based: 각 클래스에서 purity 상위 50개 유지 (절대 threshold 없음)
  4. 해상도 24x36 = 16x24의 2.25배 픽셀 → 변별력 ↑
"""
import os
import json
import base64
from PIL import Image

TEMPLATES_DIR = "/root/templates"
OUTPUT = "/mnt/c/dev/lineage-mp-timer/src/js/digit-templates.json"
OUTPUT_REPORT = "/mnt/c/dev/lineage-mp-timer/build/tessdata/template-rebuild-report.txt"
SIZE = (24, 36)
TOTAL_BITS = SIZE[0] * SIZE[1]   # 864 bits
PACKED_BYTES = (TOTAL_BITS + 7) // 8  # 108 bytes
THRESHOLD = 128
MAX_PER_CHAR = 50
MIN_PER_CHAR = 10

def binarize_packed(img):
    img = img.convert("L").resize(SIZE, Image.NEAREST)
    pixels = list(img.getdata())
    bits = [1 if p < THRESHOLD else 0 for p in pixels]
    bytes_arr = bytearray(PACKED_BYTES)
    for i, b in enumerate(bits):
        if b:
            bytes_arr[i // 8] |= (1 << (i % 8))
    return bytes(bytes_arr)

POPCOUNT = [bin(i).count('1') for i in range(256)]

def hamming(a, b):
    return sum(POPCOUNT[a[i] ^ b[i]] for i in range(len(a)))

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
                packed = binarize_packed(img)
                if packed in seen: continue
                seen.add(packed)
                sigs.append((packed, png))
            except Exception:
                pass
        all_sigs[char] = sigs
        print(f"  '{char}': {len(sigs)} unique sigs ({len(os.listdir(char_path))} PNGs)")
    return all_sigs

def filter_by_purity(all_sigs):
    chars = list(all_sigs.keys())
    other_sigs = {ch: [s for c2 in chars if c2 != ch for s, _ in all_sigs[c2]] for ch in chars}
    
    filtered = {}
    report_lines = []
    for ch in chars:
        sigs = all_sigs[ch]
        scored = []
        for sig, name in sigs:
            intra_dists = [hamming(sig, s) for s, _ in sigs if s != sig]
            intra = sum(intra_dists) / max(1, len(intra_dists)) if intra_dists else 0
            inter = min((hamming(sig, s) for s in other_sigs[ch]), default=999)
            purity = inter - intra
            scored.append((sig, name, intra, inter, purity))
        scored.sort(key=lambda x: -x[4])
        # Rank-based: top MAX_PER_CHAR by purity (always keep at least MIN_PER_CHAR even if negative purity)
        kept = scored[:MAX_PER_CHAR]
        # Stat: how many had positive purity?
        pos_count = sum(1 for t in scored if t[4] > 0)
        neg_count = len(scored) - pos_count
        filtered[ch] = [(t[0], t[1]) for t in kept]
        
        report_lines.append(f"\n=== '{ch}' ===")
        report_lines.append(f"  total unique: {len(sigs)}, kept: {len(kept)}")
        report_lines.append(f"  positive purity: {pos_count}, negative: {neg_count}")
        if kept:
            best = kept[0]
            worst = kept[-1]
            report_lines.append(f"  best  purity: {best[4]:+.1f} (intra={best[2]:.1f} inter={best[3]:.1f}) {best[1]}")
            report_lines.append(f"  worst kept:   {worst[4]:+.1f} (intra={worst[2]:.1f} inter={worst[3]:.1f}) {worst[1]}")
        if neg_count > 0 and len(kept) > 0:
            negs = [t for t in scored if t[4] <= 0][:5]
            report_lines.append(f"  ⚠ kept some with negative purity (top {len(negs)} listed):")
            for t in negs:
                report_lines.append(f"     purity={t[4]:+.1f} (intra={t[2]:.1f} inter={t[3]:.1f}) {t[1]}")
        print(f"  '{ch}': kept top {len(kept)} (pos={pos_count} neg={neg_count})")
    return filtered, report_lines

def write_output(filtered, report_lines):
    output = {"size": [SIZE[0], SIZE[1]], "templates": {}}
    total = 0
    for ch, sigs in filtered.items():
        b64s = [base64.b64encode(sig).decode('ascii') for sig, _ in sigs]
        output["templates"][ch] = b64s
        total += len(b64s)
    
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, 'w') as f:
        json.dump(output, f, separators=(',', ':'))
    size_kb = os.path.getsize(OUTPUT) / 1024
    print(f"\n✓ {OUTPUT} ({size_kb:.1f} KB, {total} templates @ {SIZE[0]}x{SIZE[1]})")
    
    os.makedirs(os.path.dirname(OUTPUT_REPORT), exist_ok=True)
    with open(OUTPUT_REPORT, 'w') as f:
        f.write(f"=== Template Rebuild Report (rank-based purity filter, {SIZE[0]}x{SIZE[1]}) ===\n")
        f.write(f"Total templates: {total}\n")
        f.write("\n".join(report_lines))
    print(f"✓ Report: {OUTPUT_REPORT}")

if __name__ == "__main__":
    print(f"[1/3] Collecting signatures @ {SIZE[0]}x{SIZE[1]} ({PACKED_BYTES} bytes/template)...")
    all_sigs = collect_all()
    print("\n[2/3] Filtering by inter-class purity (rank-based)...")
    filtered, report_lines = filter_by_purity(all_sigs)
    print("\n[3/3] Writing output...")
    write_output(filtered, report_lines)
    print("\nDone.")
