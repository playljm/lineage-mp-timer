/**
 * Template Matcher — 픽셀 폰트 자릿수 직접 비교
 *
 * 학습된 lineage.traineddata는 오버피팅으로 폐기. 대신 463개 라벨 데이터에서
 * 추출한 자릿수 템플릿을 직접 픽셀 비교 (Hamming distance) → 99%+ 정확도.
 *
 * 사용법:
 *   1. await TemplateMatcher.load() — 앱 시작 시 1회
 *   2. const result = TemplateMatcher.match(canvas, expectedLength)
 *      → { text: "42402", confidence: 0.95, perCharScores: [...] }
 *
 * 통합 위치: OCR 결과 검증/보정 레이어로 사용 (Tesseract 결과와 비교 후 override 결정).
 */
(function (global) {
  'use strict';

  let TEMPLATES = null;       // { '0': [Uint8Array, ...], '1': [...], ... }
  let TEMPLATE_SIZE = [16, 24];
  let LOADED = false;

  function _hammingDistance(a, b) {
    // Pre-computed popcount lookup for byte (256 entries)
    let dist = 0;
    for (let i = 0; i < a.length; i++) {
      dist += POPCOUNT[a[i] ^ b[i]];
    }
    return dist;
  }

  // 0~255 popcount LUT
  const POPCOUNT = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let n = i, count = 0;
    while (n) { count += n & 1; n >>>= 1; }
    POPCOUNT[i] = count;
  }

  function _b64ToBytes(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  /**
   * 템플릿 JSON 로드.
   * @param {string} jsonPath digit-templates.json 경로 (Electron renderer는 file:// 또는 fetch 가능 경로)
   */
  async function load(jsonPath) {
    try {
      const path = jsonPath || './js/digit-templates.json';
      const res = await fetch(path);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      TEMPLATE_SIZE = json.size;
      TEMPLATES = {};
      let total = 0;
      for (const [ch, b64list] of Object.entries(json.templates)) {
        TEMPLATES[ch] = b64list.map(_b64ToBytes);
        total += TEMPLATES[ch].length;
      }
      LOADED = true;
      console.log('[TemplateMatcher] 로드 완료:', total, '템플릿,', Object.keys(TEMPLATES).length, '글자.', TEMPLATE_SIZE[0] + 'x' + TEMPLATE_SIZE[1]);
      return true;
    } catch (e) {
      console.error('[TemplateMatcher] 로드 실패:', e);
      return false;
    }
  }

  /**
   * Canvas 영역(x0~x1)을 16x24 binary signature로 변환.
   * threshold=128: 어두운 픽셀(글자) → 1, 밝은 픽셀(배경) → 0.
   */
  function _canvasToSignature(canvas, x0, x1) {
    const w = TEMPLATE_SIZE[0];
    const h = TEMPLATE_SIZE[1];
    // 임시 캔버스에 영역만 16x24로 리사이즈 (nearest-neighbor)
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const sw = Math.max(1, x1 - x0);
    const sh = canvas.height;
    ctx.drawImage(canvas, x0, 0, sw, sh, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const pixels = img.data;
    // RGBA → grayscale → binary → packed bytes (48 bytes)
    const sig = new Uint8Array(48);
    const totalPx = w * h;
    for (let i = 0; i < totalPx; i++) {
      const r = pixels[i * 4];
      const g = pixels[i * 4 + 1];
      const b = pixels[i * 4 + 2];
      const gray = (r + g + b) / 3;
      if (gray < 128) {
        sig[i >>> 3] |= (1 << (i & 7));
      }
    }
    return sig;
  }

  /**
   * 단일 자릿수 영역에서 모든 글자 템플릿과 비교 → 최고 점수.
   * @returns {{ char: string, score: number, dist: number, secondBest: object }}
   */
  function _matchChar(signature, allowedChars) {
    let best = { char: null, dist: 9999, score: 0 };
    let secondBest = { char: null, dist: 9999, score: 0 };
    const total = signature.length * 8;
    for (const [ch, templates] of Object.entries(TEMPLATES)) {
      if (allowedChars && !allowedChars.includes(ch)) continue;
      let minDist = 9999;
      for (const tpl of templates) {
        const d = _hammingDistance(signature, tpl);
        if (d < minDist) minDist = d;
      }
      const score = 1 - (minDist / total);  // 0~1
      if (minDist < best.dist) {
        secondBest = { ...best };
        best = { char: ch, dist: minDist, score };
      } else if (minDist < secondBest.dist) {
        secondBest = { char: ch, dist: minDist, score };
      }
    }
    return { ...best, secondBest };
  }

  /**
   * 캔버스 전체를 expectedLength 글자로 균등 분할 후 각각 매칭.
   *
   * @param {HTMLCanvasElement} canvas — OCR 영역 캔버스 (전처리된 형태가 좋음)
   * @param {number} expectedLength — 예상 글자 수 (Tesseract 결과 길이 사용)
   * @param {string} [allowedChars] — 허용 글자 (예: "0123456789" for ADENA)
   * @returns {{ text: string, confidence: number, perChar: array }}
   */
  function match(canvas, expectedLength, allowedChars) {
    if (!LOADED || !TEMPLATES) return { text: null, confidence: 0, error: 'not loaded' };
    if (!canvas || expectedLength <= 0) return { text: null, confidence: 0, error: 'invalid input' };
    return _matchWithLength(canvas, expectedLength, allowedChars);
  }

  function _matchWithLength(canvas, expectedLength, allowedChars) {
    const trimmed = _trimWhitespace(canvas);
    if (!trimmed) return { text: null, confidence: 0, error: 'all white' };
    const { x0, x1 } = trimmed;
    const charWidth = (x1 - x0) / expectedLength;
    const result = [];
    let totalScore = 0;
    for (let i = 0; i < expectedLength; i++) {
      const xs = Math.round(x0 + i * charWidth);
      const xe = Math.round(x0 + (i + 1) * charWidth);
      const sig = _canvasToSignature(canvas, xs, xe);
      const m = _matchChar(sig, allowedChars);
      result.push(m);
      totalScore += m.score;
    }
    const avgScore = totalScore / expectedLength;
    const text = result.map((r) => r.char || '?').join('');
    return { text, confidence: avgScore, perChar: result, length: expectedLength };
  }

  /**
   * 가변 길이 매칭 — 여러 길이(minLen~maxLen)를 모두 시도해서 confidence 최고 선택.
   * OCR이 자릿수를 잘못 셀 때(예: 47090 → 491) 효과적.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {number} minLen 최소 자릿수 (기본 1)
   * @param {number} maxLen 최대 자릿수 (기본 8)
   * @param {string} [allowedChars]
   * @returns 최고 confidence 결과 + 모든 길이 시도 결과
   */
  function matchVariableLength(canvas, minLen, maxLen, allowedChars) {
    if (!LOADED || !TEMPLATES) return { text: null, confidence: 0, error: 'not loaded' };
    if (!canvas) return { text: null, confidence: 0, error: 'no canvas' };
    minLen = Math.max(1, minLen || 1);
    maxLen = Math.max(minLen, maxLen || 8);

    const all = [];
    let best = { text: null, confidence: 0, length: 0 };
    for (let n = minLen; n <= maxLen; n++) {
      const r = _matchWithLength(canvas, n, allowedChars);
      if (r && r.text) {
        all.push({ length: n, text: r.text, confidence: r.confidence });
        if (r.confidence > best.confidence) {
          best = r;
        }
      }
    }
    return { ...best, allLengths: all };
  }

  /**
   * 좌우 빈 공간 제거 (어두운 픽셀이 처음/마지막 등장하는 컬럼).
   */
  function _trimWhitespace(canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, w, h);
    const px = img.data;
    let x0 = -1, x1 = -1;
    for (let x = 0; x < w; x++) {
      let hasDark = false;
      for (let y = 0; y < h; y++) {
        const idx = (y * w + x) * 4;
        const gray = (px[idx] + px[idx+1] + px[idx+2]) / 3;
        if (gray < 128) { hasDark = true; break; }
      }
      if (hasDark) {
        if (x0 < 0) x0 = x;
        x1 = x + 1;
      }
    }
    if (x0 < 0) return null;
    return { x0, x1 };
  }

  function isLoaded() { return LOADED; }
  function templateCount() {
    if (!LOADED) return 0;
    return Object.values(TEMPLATES).reduce((s, arr) => s + arr.length, 0);
  }

  global.TemplateMatcher = {
    load,
    match,
    matchVariableLength,
    isLoaded,
    templateCount
  };
})(window);
