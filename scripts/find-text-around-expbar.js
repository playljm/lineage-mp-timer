/**
 * expBar 주변 다양한 위치에서 ink density / 흰 픽셀 비율 측정
 * 실제 EXP/Level 숫자 텍스트가 어디에 있는지 정확히 찾는 진단 도구
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
const result = Roi.detectGameUI(img);
const expBar = result.anchors.expBar;
const hpBar = result.anchors.hpBar;
console.log('expBar:', expBar);
console.log('hpBar:', hpBar);

function inkScore(x, y, w, h) {
  const data = img.data, fw = img.width;
  const xMin = Math.max(0, Math.floor(x)), yMin = Math.max(0, Math.floor(y));
  const xMax = Math.min(fw - 1, Math.floor(x + w)), yMax = Math.min(img.height - 1, Math.floor(y + h));
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

// 흰/베이지 텍스트 픽셀 비율 (게임 글자는 보통 R+G+B/3 > 180 + 채도 낮음)
function whiteRatio(x, y, w, h) {
  const data = img.data, fw = img.width;
  const xMin = Math.max(0, Math.floor(x)), yMin = Math.max(0, Math.floor(y));
  const xMax = Math.min(fw - 1, Math.floor(x + w)), yMax = Math.min(img.height - 1, Math.floor(y + h));
  let bright = 0, total = 0;
  for (let yy = yMin; yy < yMax; yy++) {
    for (let xx = xMin; xx < xMax; xx++) {
      const i = (yy * fw + xx) * 4;
      const lum = (data[i] + data[i+1] + data[i+2]) / 3;
      if (lum > 180) bright++;
      total++;
    }
  }
  return total > 0 ? bright / total : 0;
}

function overlapsHp(y, h) {
  if (!hpBar) return false;
  return Math.min(y+h, hpBar.y+hpBar.height) - Math.max(y, hpBar.y) > 0;
}

console.log('\n=== expBar 주변 후보 영역 분석 (좌측 절반=Level, 우측 절반=EXP) ===');
const Wfull = expBar.width;
const Hcand = 24;
// y 변동 범위 — expBar 위 60px ~ 아래 60px (10px 간격)
for (let dy = -60; dy <= 60; dy += 6) {
  const y = expBar.y + dy;
  if (y < 0 || y + Hcand > img.height) continue;
  const xL = expBar.x;
  const xR = expBar.x + Wfull * 0.45;
  const wL = Math.round(Wfull * 0.4);
  const wR = Math.round(Wfull * 0.55);
  const hpOver = overlapsHp(y, Hcand);
  const lvlIs = inkScore(xL, y, wL, Hcand);
  const expIs = inkScore(xR, y, wR, Hcand);
  const lvlWh = whiteRatio(xL, y, wL, Hcand);
  const expWh = whiteRatio(xR, y, wR, Hcand);
  console.log(`dy=${dy.toString().padStart(4)} y=${y} ${hpOver ? 'HP겹침' : '     '}  ink lvl=${lvlIs.toFixed(3)} exp=${expIs.toFixed(3)}  white lvl=${lvlWh.toFixed(3)} exp=${expWh.toFixed(3)}`);
}

console.log('\n=== expBar 좌측 영역 (Wide-search: 막대 좌측 100px 이내) ===');
for (let dx = -100; dx <= 0; dx += 20) {
  const x = expBar.x + dx;
  if (x < 0) continue;
  const y = expBar.y - Hcand - 1;
  if (y < 0) continue;
  const ink = inkScore(x, y, 80, Hcand);
  const wh = whiteRatio(x, y, 80, Hcand);
  console.log(`dx=${dx.toString().padStart(4)} (x=${x},y=${y}) 80x${Hcand}  ink=${ink.toFixed(3)}  white=${wh.toFixed(3)}`);
}
