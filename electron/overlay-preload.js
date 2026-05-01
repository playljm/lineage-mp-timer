const { contextBridge, ipcRenderer } = require('electron');

// main process가 additionalArguments로 전달한 파라미터 추출
const argv = process.argv || [];
const getArg = (key) => {
  const a = argv.find((x) => typeof x === 'string' && x.startsWith(key));
  return a ? a.slice(key.length) : '';
};
const loupeSourceId = getArg('--loupe-source-id=');
const expectedW = parseInt(getArg('--loupe-expected-w='), 10) || 0;
const expectedH = parseInt(getArg('--loupe-expected-h='), 10) || 0;
const displayX = parseInt(getArg('--loupe-display-x='), 10) || 0;
const displayY = parseInt(getArg('--loupe-display-y='), 10) || 0;
const scale = parseFloat(getArg('--loupe-scale=')) || 1;

// 모든 source 후보 — base64-encoded JSON. 사용자가 'L' 키로 사이클하며
// 마우스 위치와 일치하는 모니터 직접 찾을 수 있게 함.
let loupeAllSources = [];
try {
  const raw = getArg('--loupe-all-sources=');
  if (raw) loupeAllSources = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
} catch (_) { loupeAllSources = []; }

contextBridge.exposeInMainWorld('overlayApi', {
  confirm: (region) => ipcRenderer.send('overlay:region-selected', region),
  cancel: () => ipcRenderer.send('overlay:cancelled'),
  getLoupeSourceId: () => loupeSourceId,
  getLoupeExpected: () => ({ w: expectedW, h: expectedH, x: displayX, y: displayY, scale }),
  getLoupeAllSources: () => loupeAllSources.slice()
});
