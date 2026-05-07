#!/bin/bash
# Robust 학습 파이프라인:
#   1. Windows training-data → ground-truth sync
#   2. 모든 PNG에 대해 .lstmf 미리 변환 + corrupted 식별 + 제거
#   3. 학습 시작
# 이전 fail 케이스(deserialize header failed)를 사전에 차단

set -e
GT=/root/tesstrain/data/lineage-ground-truth
TRAIN=/mnt/c/Users/playl/AppData/Roaming/LineageMPTimer/training-data
ITER="${1:-10000}"
LSTMF_MIN_SIZE=1000

echo "===== Step 1: ground-truth 재sync ====="
mkdir -p $GT
# 기존 비우기 (이미 비어있을 수도)
rm -f $GT/*.png $GT/*.gt.txt $GT/*.lstmf $GT/*.box 2>/dev/null

total=0
for region in mp exp adena; do
  count=0
  for f in $TRAIN/$region/*.png; do
    [ -f "$f" ] || continue
    base=$(basename "$f" .png)
    gt="$TRAIN/$region/$base.gt.txt"
    if [ -f "$gt" ]; then
      cp "$f" $GT/
      cp "$gt" $GT/
      count=$((count+1))
    fi
  done
  printf "  %-7s : %d\n" "$region" "$count"
  total=$((total + count))
done
echo "Total synced: $total pairs"

echo ""
echo "===== Step 2a: tesstrain make lists로 .lstmf + .box 생성 ====="
cd /root/tesstrain
make lists MODEL_NAME=lineage START_MODEL=eng \
  TESSDATA=/root/tesstrain/tessdata_best \
  PSM=7 2>&1 | tail -10

echo ""
echo "===== Step 2b: corrupted .lstmf 식별 + 제거 ====="
removed=0
for f in $GT/*.lstmf; do
  [ -f "$f" ] || continue
  size=$(stat -c '%s' "$f" 2>/dev/null || echo 0)
  if [ "$size" -lt "$LSTMF_MIN_SIZE" ]; then
    base="${f%.lstmf}"
    rm -f "$base.png" "$base.gt.txt" "$base.lstmf" "$base.box"
    removed=$((removed+1))
  fi
done
echo "Removed corrupted .lstmf: $removed"

echo ""
echo "===== Step 2c: .lstmf 없는 PNG도 제거 ====="
removed2=0
for png in $GT/*.png; do
  [ -f "$png" ] || continue
  base="${png%.png}"
  if [ ! -f "$base.lstmf" ]; then
    rm -f "$base.png" "$base.gt.txt" "$base.box"
    removed2=$((removed2+1))
  fi
done
echo "Removed PNG without .lstmf: $removed2"

echo ""
echo "===== Step 2d: lists 재생성 (정리 후 list.train, list.eval 갱신) ====="
make lists MODEL_NAME=lineage START_MODEL=eng \
  TESSDATA=/root/tesstrain/tessdata_best \
  PSM=7 2>&1 | tail -5

echo ""
echo "===== Step 3: 정리 후 상태 ====="
png_n=$(ls $GT/*.png 2>/dev/null | wc -l)
gt_n=$(ls $GT/*.gt.txt 2>/dev/null | wc -l)
lstmf_n=$(ls $GT/*.lstmf 2>/dev/null | wc -l)
echo "PNG: $png_n, gt.txt: $gt_n, lstmf: $lstmf_n"

if [ "$png_n" -lt 100 ]; then
  echo "ERROR: 학습 데이터 너무 적음 ($png_n) - 중단"
  exit 1
fi

echo ""
echo "===== Step 4: 학습 (iterative — fail file 자동 제거) ====="
cd /root/tesstrain
TRAIN_EXIT=1
for retry in 1 2 3 4 5 6 7; do
  echo ""
  echo "----- Attempt $retry -----"
  echo "Start: $(date)"
  output=$(make training MODEL_NAME=lineage START_MODEL=eng \
    TESSDATA=/root/tesstrain/tessdata_best \
    MAX_ITERATIONS=$ITER PSM=7 2>&1)
  echo "$output" | tail -20

  # 학습이 actual iteration 시작했나 확인 (Mean rms 또는 Iteration X 출력)
  if echo "$output" | grep -qE "Mean rms|At iteration|Iteration [0-9]+/"; then
    echo "----- Training progressing/done -----"
    TRAIN_EXIT=0
    break
  fi

  # Deserialize fail file 추출
  fail_bases=$(echo "$output" | grep -oE "data/lineage-ground-truth/[^[:space:]]+\.lstmf" | sed -E 's|data/lineage-ground-truth/(.+)\.lstmf|\1|' | sort -u)
  if [ -z "$fail_bases" ]; then
    echo "----- No fail file detected, stopping retries -----"
    break
  fi

  echo "Removing fail files:"
  for base in $fail_bases; do
    rm -f "$GT/$base.png" "$GT/$base.gt.txt" "$GT/$base.lstmf" "$GT/$base.box"
    echo "  - $base"
  done

  # lists 재생성
  echo "Regenerating lists..."
  make lists MODEL_NAME=lineage START_MODEL=eng \
    TESSDATA=/root/tesstrain/tessdata_best \
    PSM=7 2>&1 | tail -3
done
echo "End: $(date)"
echo "Train exit code: $TRAIN_EXIT"

echo ""
echo "===== Step 5: Best checkpoint ====="
ls -la /root/tesstrain/data/lineage/checkpoints/ | sort -k9 | tail -5

echo ""
echo "===== Step 6: Final traineddata ====="
ls -la /root/tesstrain/data/lineage.traineddata 2>/dev/null

echo ""
echo "===== Training DONE ====="
exit $TRAIN_EXIT
