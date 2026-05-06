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
const r = Roi.detectGameUI(img);
console.log('valid:', r.valid);
console.log('issues:', r.issues);
console.log('anchors:');
for (const k of ['hpBar','mpBar','expBar','adenaIcon']) {
  const b = r.anchors[k];
  if (b) console.log(`  ${k}: (${b.x},${b.y} ${b.width}x${b.height}) area=${b.area} hue=${b.avgHue.toFixed(0)}`);
  else console.log(`  ${k}: null`);
}
console.log('textROIs:', JSON.stringify(r.textROIs, null, 2));
