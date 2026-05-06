/**
 * deriveTextROIs 검증 — EXP/Level ROI가 막대 위/아래 어느 쪽으로 결정됐는지 확인
 */
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'roi-detector.js'), 'utf8');
const sandbox = { window: {} };
new Function('window', moduleSource)(sandbox.window);
const Roi = sandbox.window.RoiDetector;

const pngPath = process.argv[2];
const buf = fs.readFileSync(pngPath);
const png = PNG.sync.read(buf);
const img = { width: png.width, height: png.height, data: png.data };

const result = Roi.detectGameUI(img);
console.log('valid:', result.valid);
console.log('issues:', result.issues);
const a = result.anchors, r = result.textROIs;
console.log('expBar:', a.expBar);
console.log('rois.exp:  ', r.exp);
console.log('rois.level:', r.level);
console.log('rois.mp:   ', r.mp);
console.log('rois.adena:', r.adena);

// inkScore 비교
function inkScore(imageData, x, y, w, h) {
  const data = imageData.data;
  const fw = imageData.width;
  const xMin = Math.max(0, Math.floor(x));
  const yMin = Math.max(0, Math.floor(y));
  const xMax = Math.min(fw - 1, Math.floor(x + w));
  const yMax = Math.min(imageData.height - 1, Math.floor(y + h));
  let edges = 0, total = 0;
  for (let yy = yMin; yy < yMax; yy++) {
    for (let xx = xMin; xx < xMax; xx++) {
      const i = (yy * fw + xx) * 4;
      const lumC = (data[i] + data[i+1] + data[i+2]) / 3;
      const lumR = (data[i+4] + data[i+5] + data[i+6]) / 3;
      if (Math.abs(lumC - lumR) > 25) edges++;
      total++;
    }
  }
  return total > 0 ? edges / total : 0;
}
if (a.expBar) {
  const TEXT_H = Math.max(18, Math.round(a.expBar.height * 4));
  const aboveY = Math.max(0, a.expBar.y - TEXT_H - 1);
  const belowY = a.expBar.y + a.expBar.height + 1;
  console.log('\n[ink density 비교 — EXP 우측 영역]');
  console.log('above ink:', inkScore(img, a.expBar.x + a.expBar.width*0.45, aboveY, a.expBar.width*0.55, TEXT_H).toFixed(3));
  console.log('below ink:', inkScore(img, a.expBar.x + a.expBar.width*0.45, belowY, a.expBar.width*0.55, TEXT_H).toFixed(3));
}
