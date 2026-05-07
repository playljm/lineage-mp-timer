#!/bin/bash
# .lstmf 변환 실패한 PNG 정리 + 재학습
# 첫 학습이 "Deserialize header failed: ... .lstmf" + "First document cannot be empty" 에러로 죽었을 때 사용

set -e
GT=/root/tesstrain/data/lineage-ground-truth
ITER="${1:-10000}"

echo "===== 1. 비어있는/작은 .lstmf 제거 + 해당 4종 파일 ====="
rm_small=0
while IFS= read -r f; do
  base="${f%.lstmf}"
  rm -f "$base.png" "$base.gt.txt" "$base.lstmf" "$base.box"
  rm_small=$((rm_small+1))
done < <(find $GT -name "*.lstmf" -size -200c 2>/dev/null)
echo "removed small/empty .lstmf+PNG+gt+box: $rm_small"

echo ""
echo "===== 2. .lstmf 없는 PNG 제거 (tesseract 변환 fail) ====="
rm_no_lstmf=0
for png in $GT/*.png; do
  [ -f "$png" ] || continue
  base="${png%.png}"
  if [ ! -f "$base.lstmf" ]; then
    rm -f "$base.png" "$base.gt.txt" "$base.box"
    rm_no_lstmf=$((rm_no_lstmf+1))
  fi
done
echo "removed PNG without .lstmf: $rm_no_lstmf"

echo ""
echo "===== 3. 정리 후 상태 ====="
png_n=$(ls $GT/*.png 2>/dev/null | wc -l)
gt_n=$(ls $GT/*.gt.txt 2>/dev/null | wc -l)
lstmf_n=$(ls $GT/*.lstmf 2>/dev/null | wc -l)
echo "PNG: $png_n, gt.txt: $gt_n, lstmf: $lstmf_n"

if [ "$png_n" -lt 100 ]; then
  echo "ERROR: 학습 데이터 너무 적음 ($png_n) - 중단"
  exit 1
fi

echo ""
echo "===== 4. 학습 재시작 (이번엔 .lstmf 있는 것만) ====="
cd /root/tesstrain
echo "Start time: $(date)"
make training MODEL_NAME=lineage START_MODEL=eng \
  TESSDATA=/root/tesstrain/tessdata_best \
  MAX_ITERATIONS=$ITER PSM=7 2>&1
echo "End time: $(date)"

echo ""
echo "===== 5. Best checkpoint ====="
ls -la /root/tesstrain/data/lineage/checkpoints/ | sort -k9 | tail -5

echo ""
echo "===== 6. Final traineddata ====="
ls -la /root/tesstrain/data/lineage.traineddata 2>/dev/null

echo ""
echo "===== Training DONE ====="
