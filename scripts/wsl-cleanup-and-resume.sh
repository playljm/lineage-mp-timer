#!/bin/bash
# 4 fail .lstmf 직접 제거 + list.train/eval sed 정리 + 학습 재개
GT=/root/tesstrain/data/lineage-ground-truth
LT=/root/tesstrain/data/lineage/list.train
LE=/root/tesstrain/data/lineage/list.eval

names="79of235__20260503_015539_850 139of235_20260503_020051_849 179of235_20260503_002349_313 9135_20260507_234752_334_v2"

echo "===== 1. fail file 정리 ====="
for base in $names; do
  echo "[$base]"
  rm -fv "$GT/$base.png" "$GT/$base.gt.txt" "$GT/$base.lstmf" "$GT/$base.box"
  sed -i "/$base/d" "$LT" 2>/dev/null
  sed -i "/$base/d" "$LE" 2>/dev/null
done

echo ""
echo "===== 2. 검증 ====="
echo "list.train: $(wc -l < $LT) lines"
echo "list.eval: $(wc -l < $LE) lines"
remaining=0
for base in $names; do
  if [ -f "$GT/$base.lstmf" ]; then echo "FAIL: $base.lstmf still exists"; remaining=$((remaining+1)); fi
  if grep -q "$base" "$LT" 2>/dev/null; then echo "FAIL: $base in list.train"; remaining=$((remaining+1)); fi
  if grep -q "$base" "$LE" 2>/dev/null; then echo "FAIL: $base in list.eval"; remaining=$((remaining+1)); fi
done
if [ $remaining -gt 0 ]; then
  echo "ERROR: $remaining issue remaining"
  exit 1
fi
echo "OK: 4 fail files completely cleaned"

echo ""
echo "===== 3. iterative training (max 5 retries) ====="
cd /root/tesstrain
TRAIN_OK=0
for retry in 1 2 3 4 5; do
  echo ""
  echo "----- Attempt $retry -----"
  echo "Start: $(date)"

  output=$(make training MODEL_NAME=lineage START_MODEL=eng \
    TESSDATA=/root/tesstrain/tessdata_best \
    MAX_ITERATIONS=10000 PSM=7 2>&1)
  echo "$output" | tail -25

  if echo "$output" | grep -qE "Mean rms|At iteration|Iteration [0-9]+/"; then
    echo "----- Training progressing -----"
    TRAIN_OK=1
    break
  fi

  fail_bases=$(echo "$output" | grep -oE "data/lineage-ground-truth/[^[:space:]]+\.lstmf" | sed -E 's|data/lineage-ground-truth/(.+)\.lstmf|\1|' | sort -u)
  if [ -z "$fail_bases" ]; then
    echo "No fail file detected, stopping retries"
    break
  fi

  echo "Removing additional fail files:"
  for base in $fail_bases; do
    rm -fv "$GT/$base.png" "$GT/$base.gt.txt" "$GT/$base.lstmf" "$GT/$base.box"
    sed -i "/$base/d" "$LT"
    sed -i "/$base/d" "$LE"
  done
done

if [ $TRAIN_OK -eq 0 ]; then
  echo "===== TRAINING FAILED after 5 retries ====="
  exit 1
fi

echo ""
echo "===== 4. Best checkpoint ====="
ls -la /root/tesstrain/data/lineage/checkpoints/ | sort -k9 | tail -5

echo ""
echo "===== 5. Final traineddata ====="
ls -la /root/tesstrain/data/lineage.traineddata 2>/dev/null

echo ""
echo "===== Training DONE ====="
