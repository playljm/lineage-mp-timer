#!/bin/bash
# WSL Ubuntu (root) 에서 실행 — _pending PNG ensemble OCR
# 사용:
#   wsl.exe -d Ubuntu -u root -- bash /mnt/c/dev/lineage-mp-timer/scripts/wsl-tesseract-batch.sh [setup|test|batch]

set -u
MODE="${1:-test}"

PENDING=/mnt/c/Users/playl/AppData/Roaming/LineageMPTimer/training-data/_pending
LINEAGE_SRC=/root/tesstrain/data/lineage.traineddata
TESSDATA_STD=/usr/share/tesseract-ocr/5/tessdata
OUT_DIR=/mnt/c/Users/playl/AppData/Local/Temp/lineage_ocr_batch
mkdir -p "$OUT_DIR"

# ----- setup: lineage.traineddata 표준 위치 복사 -----
setup_lineage() {
  if [ ! -f "$TESSDATA_STD/lineage.traineddata" ]; then
    cp "$LINEAGE_SRC" "$TESSDATA_STD/lineage.traineddata"
    echo "[setup] copied lineage.traineddata"
  else
    echo "[setup] lineage.traineddata already in standard tessdata"
  fi
  ls -la "$TESSDATA_STD/lineage.traineddata"
}

# ----- ocr_one: PNG 1장 ensemble OCR (5 modes) -----
ocr_one() {
  local png="$1"
  local r1 r2 r3
  # lineage 단독이 픽셀 폰트에 가장 정확. eng 섞으면 결과 오염.
  r1=$(tesseract "$png" - -l lineage --psm 7 2>/dev/null | tr -d '\n\r\t')
  r2=$(tesseract "$png" - -l lineage --psm 8 2>/dev/null | tr -d '\n\r\t')
  r3=$(tesseract "$png" - -l lineage --psm 13 2>/dev/null | tr -d '\n\r\t')
  printf "%s|%s|%s" "$r1" "$r2" "$r3"
}

if [ "$MODE" = "setup" ]; then
  setup_lineage
  exit 0
fi

if [ "$MODE" = "test" ]; then
  setup_lineage
  echo ""
  echo "===== Test on 5 PNGs (sanity check) ====="
  for region in mp exp adena; do
    test_png=$(ls "$PENDING/$region"/*.png 2>/dev/null | head -1)
    if [ -n "$test_png" ]; then
      base=$(basename "$test_png" .png)
      json="$PENDING/$region/$base.json"
      ocrsugg=$(grep -o '"ocrSuggestion": *"[^"]*"' "$json" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/')
      printf "[%s] %s (ocrSugg=%s)\n" "$region" "$base" "$ocrsugg"
      result=$(ocr_one "$test_png")
      IFS='|' read -r r1 r2 r3 <<< "$result"
      printf "  lineage/p7 : %s\n" "$r1"
      printf "  lineage/p8 : %s\n" "$r2"
      printf "  lineage/p13: %s\n" "$r3"
      echo ""
    fi
  done
  exit 0
fi

if [ "$MODE" = "batch" ]; then
  setup_lineage > /dev/null
  echo "===== Batch OCR start: $(date) ====="
  for region in mp exp adena; do
    out="$OUT_DIR/${region}_results.tsv"
    > "$out"
    pngs=("$PENDING/$region"/*.png)
    total=${#pngs[@]}
    echo "[$region] processing $total PNGs..."
    i=0
    for png in "${pngs[@]}"; do
      [ -f "$png" ] || continue
      base=$(basename "$png" .png)
      json="$PENDING/$region/$base.json"
      ocrsugg=""
      if [ -f "$json" ]; then
        ocrsugg=$(grep -o '"ocrSuggestion": *"[^"]*"' "$json" | sed 's/.*"\([^"]*\)"$/\1/')
      fi
      result=$(ocr_one "$png")
      printf "%s\t%s\t%s\n" "$base" "$ocrsugg" "$result" >> "$out"
      i=$((i+1))
      if (( i % 50 == 0 )); then
        printf "  [%s] %d/%d\n" "$region" "$i" "$total"
      fi
    done
    echo "[$region] done: $i lines -> $out"
  done
  echo "===== Batch OCR done: $(date) ====="
  exit 0
fi

echo "Unknown mode: $MODE (expected: setup|test|batch)"
exit 1
