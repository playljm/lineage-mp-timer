// HP 우측 인접 영역에서 진짜 MP 바 hue/sat 분포 분석
const fs = require('fs');
const PNG = require('pngjs').PNG;
const RoiDetector = require('../src/js/roi-detector.js');

const png = PNG.sync.read(fs.readFileSync('C:/Users/playl/OneDrive/문서/사진/스크린샷/스크린샷 2026-05-04 235625.png'));
const imageData = { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };

// HP 바 (528, 784) 334x37 — 우측 영역 (862~1700, 770~840) 분석
const xMin = 862;
const xMax = 1700;
const yMin = 770;
const yMax = 850;

console.log(`MP 영역 후보 분석: x ${xMin}-${xMax}, y ${yMin}-${yMax}`);

// hue 히스토그램 (hue 200-280, sat>0.05)
const hueBuckets = {};
const samples = [];
for (let y = yMin; y < yMax; y++) {
  for (let x = xMin; x < xMax; x++) {
    const di = (y * png.width + x) * 4;
    const r = png.data[di], g = png.data[di+1], b = png.data[di+2];
    const hsv = RoiDetector.rgbToHsv(r, g, b);
    if (hsv.s > 0.05 && hsv.v > 0.15 && hsv.h >= 180 && hsv.h <= 280) {
      const bucket = Math.floor(hsv.h / 5) * 5;
      hueBuckets[bucket] = (hueBuckets[bucket] || 0) + 1;
      samples.push({ x, y, h: hsv.h, s: hsv.s, v: hsv.v, r, g, b });
    }
  }
}

console.log('\n파랑/보라 픽셀 hue 히스토그램 (5° bucket):');
const sorted = Object.entries(hueBuckets).sort((a,b) => +a[0] - +b[0]);
for (const [hue, count] of sorted) {
  if (count < 50) continue;
  const bar = '█'.repeat(Math.min(60, Math.floor(count / 50)));
  console.log(`  hue ${hue}-${+hue+5}°: ${count.toString().padStart(5)}  ${bar}`);
}

// 매우 관대한 hue 범위 + 적은 sat으로 blob 검색
console.log('\n매우 관대한 임계값 blob 검색 (hue 195-260, sat>0.10, val>0.20, area>200):');
const blobs = RoiDetector.findColorBlobs(imageData, {
  hueMin: 195, hueMax: 260, satMin: 0.10, valMin: 0.20, minArea: 200,
  posFilter: (x, y, bw, bh) => x >= 862 && x <= 1700 && y >= 750 && y <= 870 && bw / Math.max(1, bh) >= 1.5
});
console.log(`총 ${blobs.length} blob:`);
blobs.slice(0, 10).forEach((b, i) => {
  console.log(`  [${i}] (${b.x},${b.y} ${b.width}x${b.height}) area=${b.area} hue=${b.avgHue?.toFixed(0)} sat=${(b.avgSat*100)?.toFixed(0)}% aspect=${(b.width/b.height).toFixed(1)}`);
});
