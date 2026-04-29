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

contextBridge.exposeInMainWorld('overlayApi', {
  confirm: (region) => ipcRenderer.send('overlay:region-selected', region),
  cancel: () => ipcRenderer.send('overlay:cancelled'),
  getLoupeSourceId: () => loupeSourceId,
  getLoupeExpected: () => ({ w: expectedW, h: expectedH, x: displayX, y: displayY, scale })
});
