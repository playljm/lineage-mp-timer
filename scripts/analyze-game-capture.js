/**
 * Game capture PNG 픽셀 분석기 — RoiDetector가 보는 모든 후보를 시각화/출력
 *
 * 사용:
 *   node scripts/analyze-game-capture.js <PNG path>
 *
 * 출력:
 *   - 캔버스 크기
 *   - HP/MP/EXP/ADENA 후보 top-10 (위치, 크기, area, hue, sat)
 *   - 위치 필터 적용 전/후 비교
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

// roi-detector.js 로드 — Node 환경에서도 동작 (DOM 의존성은 detectGameUI 진입점에서만)
const RoiDetectorPath = path.join(__dirname, '..', 'src', 'js', 'roi-detector.js');
const moduleSource = fs.readFileSync(RoiDetectorPath, 'utf8');
// roi-detector는 (function(global){...})(globalScope)로 RoiDetector 노출
const sandbox = { window: {}, RoiDetector: null };
sandbox.globalScope = sandbox;
new Function('window', 'globalScope', moduleSource)(sandbox.window, sandbox);
const Roi = sandbox.window.RoiDetector || sandbox.RoiDetector;
if (!Roi) {
  console.error('RoiDetector load 실패');
  process.exit(1);
}

function loadPngAsImageData(filePath) {
  const buf = fs.readFileSync(filePath);
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

function fmtBlob(b, w, h) {
  if (!b) return '(none)';
  const xRel = (b.x / w).toFixed(2);
  const yRel = (b.y / h).toFixed(2);
  return `(${b.x},${b.y} ${b.width}x${b.height}) area=${b.area} hue=${b.avgHue.toFixed(0)} sat=${b.avgSat.toFixed(2)} xRel=${xRel} yRel=${yRel} ar=${(b.width/Math.max(1,b.height)).toFixed(1)}`;
}

const pngPath = process.argv[2];
if (!pngPath) {
  console.error('Usage: node analyze-game-capture.js <PNG path>');
  process.exit(1);
}

const img = loadPngAsImageData(pngPath);
const { width: w, height: h } = img;
console.log(`\n=== Image: ${pngPath} ===`);
console.log(`Size: ${w}x${h} (${(w*h).toLocaleString()} px)\n`);

// === 1. 빨강 (HP 후보) — 현재 SPEC 위치 필터 적용 ===
const hpFilteredCands = Roi.findHpBarCandidates(img, w, h);
console.log(`[HP candidates with SPEC filter (y>${(h*0.6).toFixed(0)})] count=${hpFilteredCands.length}`);
hpFilteredCands.slice(0, 10).forEach((b, i) => console.log(`  #${i+1} ${fmtBlob(b, w, h)}`));

// === 2. 빨강 (위치 필터 OFF) — 화면 전체 ===
const minHpArea = Math.max(20, Math.floor(w * h * 0.0008));
const allRedBlobs = Roi.findColorBlobs(img, {
  hueMin: 350, hueMax: 20, satMin: 0.6, valMin: 0.4,
  minArea: minHpArea
});
const wide = allRedBlobs.filter(b => b.width / Math.max(1, b.height) > 3);
console.log(`\n[ALL red blobs (no position filter, wide w/h>3)] total=${allRedBlobs.length}, wide=${wide.length}`);
wide.slice(0, 15).forEach((b, i) => console.log(`  #${i+1} ${fmtBlob(b, w, h)}`));

// === 3. 오렌지 (EXP 후보) ===
const expFilteredCands = Roi.findExpBarCandidates(img, w, h);
console.log(`\n[EXP candidates with SPEC filter (x<${(w*0.30).toFixed(0)}, y∈[${(h*0.65).toFixed(0)},${(h*0.95).toFixed(0)}])] count=${expFilteredCands.length}`);
expFilteredCands.slice(0, 10).forEach((b, i) => console.log(`  #${i+1} ${fmtBlob(b, w, h)}`));

// === 4. 오렌지 (위치 필터 OFF) ===
const minExpArea = Math.max(15, Math.floor(w * h * 0.0005));
const allOrangeBlobs = Roi.findColorBlobs(img, {
  hueMin: 12, hueMax: 38, satMin: 0.55, valMin: 0.4,
  minArea: minExpArea
});
const expWide = allOrangeBlobs.filter(b => b.width / Math.max(1, b.height) >= 2);
console.log(`\n[ALL orange blobs (no pos filter, w/h>=2)] total=${allOrangeBlobs.length}, wide=${expWide.length}`);
expWide.slice(0, 15).forEach((b, i) => console.log(`  #${i+1} ${fmtBlob(b, w, h)}`));

// === 5. 파랑 (MP 후보) — HP 없이 ===
const allBlueBlobs = Roi.findColorBlobs(img, {
  hueMin: 200, hueMax: 270, satMin: 0.10, valMin: 0.25,
  minArea: Math.max(20, Math.floor(w * h * 0.0006))
});
const mpWide = allBlueBlobs.filter(b => b.width / Math.max(1, b.height) >= 2.5);
console.log(`\n[ALL blue/purple blobs (MP family, no pos filter, w/h>=2.5)] total=${allBlueBlobs.length}, wide=${mpWide.length}`);
mpWide.slice(0, 15).forEach((b, i) => console.log(`  #${i+1} ${fmtBlob(b, w, h)}`));

// === 6. 노랑 (ADENA 후보) ===
const adFilteredCands = Roi.findAdenaIconCandidates(img, w, h);
console.log(`\n[ADENA candidates with SPEC filter (x>${(w*0.80).toFixed(0)}, y>${(h*0.80).toFixed(0)})] count=${adFilteredCands.length}`);
adFilteredCands.slice(0, 10).forEach((b, i) => console.log(`  #${i+1} ${fmtBlob(b, w, h)}`));

const allYellowBlobs = Roi.findColorBlobs(img, {
  hueMin: 42, hueMax: 62, satMin: 0.55, valMin: 0.4,
  minArea: Math.max(10, Math.floor(w * h * 0.0002))
});
console.log(`\n[ALL yellow blobs (no pos filter)] total=${allYellowBlobs.length}`);
allYellowBlobs.slice(0, 15).forEach((b, i) => console.log(`  #${i+1} ${fmtBlob(b, w, h)}`));

// === 7. detectGameUI 결과 ===
console.log(`\n=== detectGameUI 결과 ===`);
const result = Roi.detectGameUI(img);
console.log('valid:', result.valid);
console.log('issues:', result.issues);
console.log('anchors:');
console.log('  HP   :', fmtBlob(result.anchors.hpBar, w, h));
console.log('  MP   :', fmtBlob(result.anchors.mpBar, w, h));
console.log('  EXP  :', fmtBlob(result.anchors.expBar, w, h));
console.log('  ADENA:', fmtBlob(result.anchors.adenaIcon, w, h));
