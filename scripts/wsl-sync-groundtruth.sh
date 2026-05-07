#!/bin/bash
# Windows training-data 본 폴더 → WSL tesstrain ground-truth 동기화
# LEVEL은 제외 (사용자 결정: 다양성 부족으로 v1.5.0 학습 미사용)

set -e
GT=/root/tesstrain/data/lineage-ground-truth
TRAIN=/mnt/c/Users/playl/AppData/Roaming/LineageMPTimer/training-data
TS=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/root/tesstrain/data/lineage-ground-truth.backup_$TS

echo "===== Step 1: 기존 ground-truth 백업 ====="
mkdir -p $BACKUP_DIR
mkdir -p $GT
existing=$(ls $GT/*.png 2>/dev/null | wc -l)
if [ "$existing" -gt 0 ]; then
  mv $GT/*.png $BACKUP_DIR/ 2>/dev/null || true
  mv $GT/*.gt.txt $BACKUP_DIR/ 2>/dev/null || true
  echo "백업: $BACKUP_DIR ($existing PNGs)"
else
  echo "기존 데이터 없음 — 백업 스킵"
fi

echo ""
echo "===== Step 2: Windows training-data → ground-truth 복사 ====="
total_png=0
total_gt=0
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
  printf "  %-7s : %d pairs\n" "$region" "$count"
  total_png=$((total_png + count))
done

echo ""
echo "===== Step 3: 검증 ====="
echo "PNG count: $(ls $GT/*.png 2>/dev/null | wc -l)"
echo "gt.txt count: $(ls $GT/*.gt.txt 2>/dev/null | wc -l)"
echo ""
echo "Sample 5 .gt.txt 내용:"
ls $GT/*.gt.txt 2>/dev/null | head -5 | while read gt; do
  printf "  %s : %s\n" "$(basename $gt)" "$(cat $gt)"
done

echo ""
echo "===== Sync DONE ====="
