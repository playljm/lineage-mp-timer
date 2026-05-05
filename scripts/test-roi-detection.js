// RoiDetector 객관 검증 스크립트 — 사용자 첨부 스크린샷에서 4개 anchor 탐지 시도
// node scripts/test-roi-detection.js [<png-path>]

const fs = require('fs');
const path = require('path');
const PNG = require('pngjs').PNG;

// roi-detector.js는 module.exports 지원
const RoiDetector = require('../src/js/roi-detector.js');

const screenshotPath = process.argv[2] || 'C:/Users/playl/OneDrive/문서/사진/스크린샷/스크린샷 2026-05-04 235625.png';

console.log('Loading PNG:', screenshotPath);
const pngBuffer = fs.readFileSync(screenshotPath);
const png = PNG.sync.read(pngBuffer);

console.log(`Image: ${png.width} x ${png.height}, alpha=${png.alpha ? 'yes' : 'no'}`);

// PNG → ImageData 형식 (RGBA Uint8ClampedArray)
const imageData = {
  width: png.width,
  height: png.height,
  data: new Uint8ClampedArray(png.data)
};

console.log('\n=== RoiDetector.detectGameUI ===');
const result = RoiDetector.detectGameUI(imageData);
console.log('valid:', result.valid);
console.log('issues:', result.issues);
console.log('\nanchors:');
const fmt = (b) => b ? `(${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} hue=${b.avgHue?.toFixed(0)} sat=${(b.avgSat*100)?.toFixed(0)}%)` : 'null';
console.log('  hpBar    :', fmt(result.anchors?.hpBar));
console.log('  mpBar    :', fmt(result.anchors?.mpBar));
console.log('  expBar   :', fmt(result.anchors?.expBar));
console.log('  adenaIcon:', fmt(result.anchors?.adenaIcon));
console.log('\ntextROIs:');
console.log('  mp   :', result.textROIs?.mp);
console.log('  exp  :', result.textROIs?.exp);
console.log('  level:', result.textROIs?.level);
console.log('  adena:', result.textROIs?.adena);

// 추가 진단 — 임계값을 매우 완화한 후 각 색상별 가장 큰 blob 찾기
console.log('\n=== 임계값 완화 후 색상 분포 진단 ===');
const probes = [
  { name: 'red    (HP candidate)',   hueMin: 350, hueMax: 20,  satMin: 0.4, valMin: 0.4 },
  { name: 'blue   (MP candidate)',   hueMin: 195, hueMax: 240, satMin: 0.15, valMin: 0.3 },
  { name: 'orange (EXP candidate)',  hueMin: 10,  hueMax: 40,  satMin: 0.4, valMin: 0.4 },
  { name: 'yellow (ADENA candidate)', hueMin: 40, hueMax: 65,  satMin: 0.4, valMin: 0.4 },
];
for (const p of probes) {
  const blobs = RoiDetector.findColorBlobs(imageData, {
    hueMin: p.hueMin,
    hueMax: p.hueMax,
    satMin: p.satMin,
    valMin: p.valMin,
    minArea: 50,
  });
  console.log(`\n${p.name}: ${blobs.length} blobs (top 3)`);
  blobs.slice(0, 3).forEach((b, i) => {
    const yRel = (b.y / png.height).toFixed(2);
    const xRel = (b.x / png.width).toFixed(2);
    console.log(`  [${i}] (${b.x},${b.y} ${b.width}x${b.height}) area=${b.area} hue=${b.avgHue?.toFixed(0)} sat=${(b.avgSat*100)?.toFixed(0)}% xRel=${xRel} yRel=${yRel}`);
  });
}
