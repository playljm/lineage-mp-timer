/**
 * 좌측 미니 패널의 LV 텍스트 픽셀 특성 분석
 * - 흰/베이지 픽셀 가로 cluster 검출
 * - 텍스트 영역 bounding box 도출
 * - 텍스트 색상/채도 통계
 */
const fs = require('fs');
const { PNG } = require('pngjs');

const buf = fs.readFileSync(process.argv[2]);
const png = PNG.sync.read(buf);
const w = png.width, h = png.height, data = png.data;

// 좌측 미니 패널 추정 영역: x ∈ [0, w*0.20], y ∈ [h*0.75, h*0.95]
const xMin = 0;
const xMax = Math.floor(w * 0.20);
const yMin = Math.floor(h * 0.75);
const yMax = Math.floor(h * 0.95);

// 흰/베이지 픽셀 마스크 — R+G+B/3 > 180 + saturation < 0.3
const isTextPixel = (r, g, b) => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const lum = (r + g + b) / 3;
  const sat = max === 0 ? 0 : (max - min) / max;
  return lum > 180 && sat < 0.35;
};

// 행별 텍스트 픽셀 수 (히스토그램)
console.log(`=== 좌측 패널 영역 (${xMin},${yMin} - ${xMax},${yMax}) ===`);
console.log('y: text-pixel-count (각 ▮ = 5px)');
const rowCounts = [];
for (let y = yMin; y < yMax; y++) {
  let count = 0;
  for (let x = xMin; x < xMax; x++) {
    const i = (y * w + x) * 4;
    if (isTextPixel(data[i], data[i+1], data[i+2])) count++;
  }
  rowCounts.push({ y, count });
}
rowCounts.forEach(r => {
  if (r.count >= 5) {
    console.log(`y=${r.y.toString().padStart(3)} (yRel=${(r.y/h).toFixed(2)}): ${r.count.toString().padStart(3)} ${'▮'.repeat(Math.floor(r.count/5))}`);
  }
});

// 텍스트가 많은 y 그룹 → 텍스트 라인 검출
console.log('\n=== 텍스트 라인 후보 (count>=15 + 인접 행 그룹) ===');
let lineStart = null;
const lines = [];
for (let i = 0; i < rowCounts.length; i++) {
  const c = rowCounts[i].count;
  if (c >= 15 && lineStart === null) lineStart = rowCounts[i].y;
  else if (c < 15 && lineStart !== null) {
    if (rowCounts[i].y - lineStart >= 8) {
      lines.push({ yStart: lineStart, yEnd: rowCounts[i].y - 1, height: rowCounts[i].y - lineStart });
    }
    lineStart = null;
  }
}
if (lineStart !== null) {
  const last = rowCounts[rowCounts.length - 1];
  lines.push({ yStart: lineStart, yEnd: last.y, height: last.y - lineStart });
}
lines.forEach((l, i) => console.log(`Line ${i+1}: y=${l.yStart}~${l.yEnd} (height=${l.height})`));

// 각 라인에서 흰 픽셀 가로 cluster 검출
console.log('\n=== 각 라인의 가로 cluster (텍스트 box 후보) ===');
for (const line of lines) {
  const yMid = Math.floor((line.yStart + line.yEnd) / 2);
  // 라인 내 모든 행의 픽셀을 vertical projection
  const colHits = new Array(xMax - xMin).fill(0);
  for (let y = line.yStart; y <= line.yEnd; y++) {
    for (let x = xMin; x < xMax; x++) {
      const i = (y * w + x) * 4;
      if (isTextPixel(data[i], data[i+1], data[i+2])) colHits[x - xMin]++;
    }
  }
  // 가로 cluster: 인접 column의 픽셀 수가 임계값 이상인 구간
  const minColPixels = Math.max(1, Math.floor(line.height * 0.2));
  const clusters = [];
  let cs = null;
  for (let x = 0; x < colHits.length; x++) {
    if (colHits[x] >= minColPixels) {
      if (cs === null) cs = x;
    } else if (cs !== null) {
      // gap 허용 (2px) — 글자 사이 빈 공간 무시
      let nextHit = -1;
      for (let nx = x + 1; nx <= Math.min(x + 3, colHits.length - 1); nx++) {
        if (colHits[nx] >= minColPixels) { nextHit = nx; break; }
      }
      if (nextHit > 0) { x = nextHit - 1; continue; }
      if (x - cs >= 8) clusters.push({ xStart: cs, xEnd: x - 1, width: x - cs });
      cs = null;
    }
  }
  if (cs !== null) clusters.push({ xStart: cs, xEnd: colHits.length - 1, width: colHits.length - cs });
  console.log(`Line y=${line.yStart}~${line.yEnd}: ${clusters.length} clusters`);
  clusters.forEach((c, i) => console.log(`  cluster ${i+1}: x=${c.xStart}~${c.xEnd} (width=${c.width})`));
}
