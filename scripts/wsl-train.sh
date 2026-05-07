#!/bin/bash
# WSL에서 tesstrain 학습 실행
# 사용: bash wsl-train.sh [iterations]

ITER="${1:-10000}"

echo "===== Tesseract LSTM 학습 시작 ====="
echo "MODEL_NAME=lineage"
echo "START_MODEL=eng"
echo "MAX_ITERATIONS=$ITER"
echo "PSM=7"
echo "Start time: $(date)"
echo ""

cd /root/tesstrain

# 기존 체크포인트 보존 — make는 자동으로 이어 학습
make training MODEL_NAME=lineage START_MODEL=eng \
  TESSDATA=/root/tesstrain/tessdata_best \
  MAX_ITERATIONS=$ITER PSM=7 2>&1

echo ""
echo "End time: $(date)"
echo ""
echo "===== Best checkpoint ====="
ls -la /root/tesstrain/data/lineage/checkpoints/ | sort -k9 | head -5

echo ""
echo "===== Final traineddata ====="
ls -la /root/tesstrain/data/lineage.traineddata 2>/dev/null

echo ""
echo "===== Training DONE ====="
