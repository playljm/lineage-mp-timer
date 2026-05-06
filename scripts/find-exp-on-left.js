/**
 * 좌측 미니 패널 안의 진짜 EXP 진행 막대 찾기
 * 사용자 게임 화면(image #2)에서 LEV:7 16.8151% 옆 작은 막대 위치 파악
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'roi-detector.js'), 'utf8');
const sandbox = { window: {} };
new Function('window', moduleSource)(sandbox.window);
const Roi = sandbox.window.RoiDetector;

const buf = fs.readFileSync(process.argv[2]);
const png = PNG.sync.read(buf);
const img = { width: png.width, height: png.height, data: png.data };

// 좌측 ~10% 영역에서 오렌지/노랑/연한 빨강 작은 가로 blob 모두 검색
const allOrange = Roi.findColorBlobs(img, {
  hueMin: 12, hueMax: 38, satMin: 0.4, valMin: 0.3,
  minArea: 30,  // 매우 작은 임계값
  posFilter: (x, y, w, h) => {
    if (x > img.width * 0.15) return false; // 좌측 15% 만
    if (y < img.height * 0.7) return false; // 하단 30% 만
    if (w / Math.max(1, h) < 1.5) return false;
    return true;
  }
});
console.log('좌측 하단(x<15%, y>70%) 오렌지/노랑 작은 blobs:', allOrange.length);
allOrange.slice(0, 20).forEach((b, i) => {
  const xRel = (b.x / img.width).toFixed(2);
  const yRel = (b.y / img.height).toFixed(2);
  console.log(`  #${i+1} (${b.x},${b.y} ${b.width}x${b.height}) area=${b.area} hue=${b.avgHue.toFixed(0)} sat=${b.avgSat.toFixed(2)} xRel=${xRel} yRel=${yRel}`);
});

// 좌측 빨강 (HP 미니바)
const allRedSmall = Roi.findColorBlobs(img, {
  hueMin: 350, hueMax: 20, satMin: 0.5, valMin: 0.3,
  minArea: 30,
  posFilter: (x, y, w, h) => {
    if (x > img.width * 0.15) return false;
    if (y < img.height * 0.7) return false;
    return true;
  }
});
console.log('\n좌측 하단 빨강 작은 blobs:', allRedSmall.length);
allRedSmall.slice(0, 10).forEach((b, i) => {
  const xRel = (b.x / img.width).toFixed(2);
  const yRel = (b.y / img.height).toFixed(2);
  console.log(`  #${i+1} (${b.x},${b.y} ${b.width}x${b.height}) area=${b.area} hue=${b.avgHue.toFixed(0)} sat=${b.avgSat.toFixed(2)} xRel=${xRel} yRel=${yRel}`);
});

// 좌측 파랑 (MP 미니바)
const allBlueSmall = Roi.findColorBlobs(img, {
  hueMin: 200, hueMax: 270, satMin: 0.10, valMin: 0.20,
  minArea: 30,
  posFilter: (x, y, w, h) => {
    if (x > img.width * 0.15) return false;
    if (y < img.height * 0.7) return false;
    return true;
  }
});
console.log('\n좌측 하단 파랑 작은 blobs:', allBlueSmall.length);
allBlueSmall.slice(0, 10).forEach((b, i) => {
  const xRel = (b.x / img.width).toFixed(2);
  const yRel = (b.y / img.height).toFixed(2);
  console.log(`  #${i+1} (${b.x},${b.y} ${b.width}x${b.height}) area=${b.area} hue=${b.avgHue.toFixed(0)} sat=${b.avgSat.toFixed(2)} xRel=${xRel} yRel=${yRel}`);
});
