/**
 * Raw PNG에서 EXP/Level ROI 영역만 잘라서 별도 PNG로 저장
 */
const fs = require('fs');
const { PNG } = require('pngjs');

const inputPath = process.argv[2];
const x = parseInt(process.argv[3], 10);
const y = parseInt(process.argv[4], 10);
const w = parseInt(process.argv[5], 10);
const h = parseInt(process.argv[6], 10);
const outputPath = process.argv[7];

const buf = fs.readFileSync(inputPath);
const png = PNG.sync.read(buf);

const cropped = new PNG({ width: w, height: h });
for (let yy = 0; yy < h; yy++) {
  for (let xx = 0; xx < w; xx++) {
    const srcIdx = ((y + yy) * png.width + (x + xx)) * 4;
    const dstIdx = (yy * w + xx) * 4;
    cropped.data[dstIdx]     = png.data[srcIdx];
    cropped.data[dstIdx + 1] = png.data[srcIdx + 1];
    cropped.data[dstIdx + 2] = png.data[srcIdx + 2];
    cropped.data[dstIdx + 3] = png.data[srcIdx + 3];
  }
}
fs.writeFileSync(outputPath, PNG.sync.write(cropped));
console.log(`Saved ${w}x${h} crop from (${x},${y}) → ${outputPath}`);
