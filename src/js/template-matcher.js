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
  let TEMPLATE_FORMAT = 'binary';  // 'binary' (Hamming) or 'grayscale' (Manhattan)
  let LOADED = false;

  function _hammingDistance(a, b) {
    // Pre-computed popcount lookup for byte (256 entries)
    let dist = 0;
    for (let i = 0; i < a.length; i++) {
      dist += POPCOUNT[a[i] ^ b[i]];
    }
    return dist;
  }

  function _manhattanDistance(a, b) {
    // Sum of absolute differences (grayscale-aware)
    let dist = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i] - b[i];
      dist += d < 0 ? -d : d;
    }
    return dist;
  }

  function _distance(a, b) {
    return TEMPLATE_FORMAT === 'grayscale' ? _manhattanDistance(a, b) : _hammingDistance(a, b);
  }

  function _maxDistance() {
    // 최악의 거리: binary는 total bits, grayscale은 pixels * 255
    const pixels = TEMPLATE_SIZE[0] * TEMPLATE_SIZE[1];
    return TEMPLATE_FORMAT === 'grayscale' ? pixels * 255 : pixels;
  }

  // 0~255 popcount LUT (binary 모드 전용)
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
   * format 자동 감지: json.format === 'grayscale'이면 Manhattan, 아니면 Hamming(binary).
   * @param {string} jsonPath digit-templates.json 경로 (Electron renderer는 file:// 또는 fetch 가능 경로)
   */
  async function load(jsonPath) {
    try {
      const path = jsonPath || './js/digit-templates.json';
      const res = await fetch(path);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      TEMPLATE_SIZE = json.size;
      TEMPLATE_FORMAT = json.format === 'grayscale' ? 'grayscale' : 'binary';
      TEMPLATES = {};
      let total = 0;
      for (const [ch, b64list] of Object.entries(json.templates)) {
        TEMPLATES[ch] = b64list.map(_b64ToBytes);
        total += TEMPLATES[ch].length;
      }
      LOADED = true;
      console.log('[TemplateMatcher] 로드 완료:', total, '템플릿,', Object.keys(TEMPLATES).length, '글자.',
        TEMPLATE_SIZE[0] + 'x' + TEMPLATE_SIZE[1], '(' + TEMPLATE_FORMAT + ')');
      return true;
    } catch (e) {
      console.error('[TemplateMatcher] 로드 실패:', e);
      return false;
    }
  }

  /**
   * Canvas 영역(x0~x1)을 TEMPLATE_SIZE signature로 변환.
   *
   * 모드별 출력 형식:
   *   binary    — 픽셀당 1bit (gray<128=1) → packed bytes (16x24=48 / 24x36=108)
   *   grayscale — 픽셀당 1byte 0~255 → flat bytes (16x24=384)
   *
   * 게임 캔버스: 어두운 글자 = 검은(낮은 값), 밝은 배경 = 흰(높은 값) — 자동 반전 필요 X
   * (전처리 단계에서 이미 invert 처리됨)
   */
  function _canvasToSignature(canvas, x0, x1) {
    const w = TEMPLATE_SIZE[0];
    const h = TEMPLATE_SIZE[1];
    const totalPx = w * h;
    // 임시 캔버스에 영역만 리사이즈 (nearest-neighbor)
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
    if (TEMPLATE_FORMAT === 'grayscale') {
      const sig = new Uint8Array(totalPx);
      for (let i = 0; i < totalPx; i++) {
        const r = pixels[i * 4];
        const g = pixels[i * 4 + 1];
        const b = pixels[i * 4 + 2];
        sig[i] = ((r + g + b) / 3) | 0;
      }
      return sig;
    }
    // binary
    const packedBytes = (totalPx + 7) >>> 3;
    const sig = new Uint8Array(packedBytes);
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
   * Distance: TEMPLATE_FORMAT에 따라 Hamming(binary) or Manhattan(grayscale).
   * @returns {{ char: string, score: number, dist: number, secondBest: object }}
   */
  function _matchChar(signature, allowedChars) {
    const maxDist = _maxDistance();
    const INF = maxDist + 1;
    let best = { char: null, dist: INF, score: 0 };
    let secondBest = { char: null, dist: INF, score: 0 };
    for (const [ch, templates] of Object.entries(TEMPLATES)) {
      if (allowedChars && !allowedChars.includes(ch)) continue;
      let minDist = INF;
      for (const tpl of templates) {
        const d = _distance(signature, tpl);
        if (d < minDist) minDist = d;
      }
      const score = 1 - (minDist / maxDist);  // 0~1
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

  // =========================================================================
  // [v1.8.0] User Template — 사용자 환경 폰트 즉시 등록
  // 사용자가 트래커 NOW에 정확한 값 입력 후 "현재 캡처를 template으로 학습" 클릭
  // → 캡처 canvas를 자릿수 분리 → 사용자 폰트의 0~9 픽셀 패턴 추출 → localStorage 저장
  // 이후 OCR 시 사용자 template 우선 매칭 (ML OCR 우회)
  // =========================================================================
  // USER_TEMPLATES[region]['0'] = [Uint8Array signature, ...] (multiple variations)
  let USER_TEMPLATES = { mp: {}, exp: {}, adena: {}, level: {} };
  const USER_TEMPLATE_STORAGE_KEY = 'lmp.userTemplate';

  function _bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function loadUserTemplates() {
    try {
      const raw = localStorage.getItem(USER_TEMPLATE_STORAGE_KEY);
      if (!raw) return;
      const json = JSON.parse(raw);
      for (const region of ['mp', 'exp', 'adena', 'level']) {
        if (!json[region]) continue;
        USER_TEMPLATES[region] = {};
        for (const [ch, b64Arr] of Object.entries(json[region])) {
          USER_TEMPLATES[region][ch] = b64Arr.map(_b64ToBytes);
        }
      }
      const total = Object.values(USER_TEMPLATES).reduce((s, r) => s + Object.values(r).reduce((c, a) => c + a.length, 0), 0);
      console.log('[UserTemplate] loaded ' + total + ' signatures from localStorage');
    } catch (e) { console.warn('[UserTemplate] load fail:', e); }
  }

  function saveUserTemplates() {
    try {
      const json = {};
      for (const region of ['mp', 'exp', 'adena', 'level']) {
        if (!USER_TEMPLATES[region]) continue;
        json[region] = {};
        for (const [ch, arr] of Object.entries(USER_TEMPLATES[region])) {
          json[region][ch] = arr.map(_bytesToB64);
        }
      }
      localStorage.setItem(USER_TEMPLATE_STORAGE_KEY, JSON.stringify(json));
    } catch (e) { console.warn('[UserTemplate] save fail:', e); }
  }

  /**
   * 사용자 정답 라벨로부터 canvas 자릿수 분리 → 각 자릿수 signature 추출 → USER_TEMPLATES 등록.
   *
   * @param {HTMLCanvasElement} canvas — ADENA OCR 영역 캔버스 (white-extracted invert 결과 권장)
   * @param {string} label — 사용자 정답값 (예: "67144" for ADENA)
   * @param {string} region — 'mp' | 'exp' | 'adena' | 'level'
   * @returns {{ ok: boolean, registered: number, message: string }}
   */
  function registerUserTemplate(canvas, label, region) {
    if (!canvas || !label || !region) return { ok: false, registered: 0, message: 'invalid input' };
    if (!['mp', 'exp', 'adena', 'level'].includes(region)) return { ok: false, registered: 0, message: 'unknown region' };
    // ADENA/LEVEL: 숫자만. EXP: 정수.소수. MP: cur/max.
    // 핵심 자릿수만 추출 (특수문자 제외)
    const digitsOnly = String(label).replace(/[^0-9]/g, '');
    if (!digitsOnly) return { ok: false, registered: 0, message: 'no digits in label' };
    const trimmed = _trimWhitespace(canvas);
    if (!trimmed) return { ok: false, registered: 0, message: 'all white canvas' };
    const { x0, x1 } = trimmed;
    const charWidth = (x1 - x0) / digitsOnly.length;
    if (charWidth < 4) return { ok: false, registered: 0, message: 'char width too small (' + charWidth.toFixed(1) + 'px)' };
    if (!USER_TEMPLATES[region]) USER_TEMPLATES[region] = {};
    let added = 0;
    for (let i = 0; i < digitsOnly.length; i++) {
      const ch = digitsOnly[i];
      const xs = Math.round(x0 + i * charWidth);
      const xe = Math.round(x0 + (i + 1) * charWidth);
      const sig = _canvasToSignature(canvas, xs, xe);
      if (!USER_TEMPLATES[region][ch]) USER_TEMPLATES[region][ch] = [];
      // 중복 차단 — 동일 signature가 이미 있으면 skip
      const exists = USER_TEMPLATES[region][ch].some(t => {
        if (t.length !== sig.length) return false;
        for (let j = 0; j < t.length; j++) if (t[j] !== sig[j]) return false;
        return true;
      });
      if (!exists) {
        USER_TEMPLATES[region][ch].push(sig);
        added++;
      }
    }
    saveUserTemplates();
    console.log('[UserTemplate] registered ' + added + '/' + digitsOnly.length + ' digits for region=' + region + ' label=' + label);
    return { ok: true, registered: added, message: digitsOnly.length + '자리 중 신규 ' + added + '개 등록' };
  }

  /**
   * 사용자 template으로 매칭 — USER_TEMPLATES와 기본 TEMPLATES를 모두 사용.
   * 사용자 template이 있으면 우선, 없으면 기본 fallback.
   */
  function matchUser(canvas, expectedLength, region, allowedChars) {
    if (!canvas || expectedLength <= 0) return { text: null, confidence: 0, error: 'invalid input' };
    if (!USER_TEMPLATES[region] || !Object.keys(USER_TEMPLATES[region]).length) {
      return { text: null, confidence: 0, error: 'no user template' };
    }
    const trimmed = _trimWhitespace(canvas);
    if (!trimmed) return { text: null, confidence: 0, error: 'all white' };
    const { x0, x1 } = trimmed;
    const charWidth = (x1 - x0) / expectedLength;
    const result = [];
    let totalScore = 0;
    const allowed = allowedChars || '0123456789';
    for (let i = 0; i < expectedLength; i++) {
      const xs = Math.round(x0 + i * charWidth);
      const xe = Math.round(x0 + (i + 1) * charWidth);
      const sig = _canvasToSignature(canvas, xs, xe);
      // USER_TEMPLATES 우선, 없으면 fallback to TEMPLATES
      const m = _matchCharFromUser(sig, region, allowed);
      result.push(m);
      totalScore += m.score;
    }
    const avgScore = totalScore / expectedLength;
    const text = result.map((r) => r.char || '?').join('');
    return { text, confidence: avgScore, perChar: result, length: expectedLength, source: 'user-template' };
  }

  function _matchCharFromUser(signature, region, allowedChars) {
    const maxDist = _maxDistance();
    const INF = maxDist + 1;
    let best = { char: null, dist: INF, score: 0 };
    let secondBest = { char: null, dist: INF, score: 0 };
    const userTpls = USER_TEMPLATES[region] || {};
    for (const ch of allowedChars) {
      let minDist = INF;
      const tplsUser = userTpls[ch];
      if (tplsUser && tplsUser.length) {
        for (const tpl of tplsUser) {
          if (tpl.length !== signature.length) continue;
          const d = _distance(signature, tpl);
          if (d < minDist) minDist = d;
        }
      }
      // fallback to base TEMPLATES if no user template for this digit
      if (minDist === INF && TEMPLATES && TEMPLATES[ch]) {
        for (const tpl of TEMPLATES[ch]) {
          if (tpl.length !== signature.length) continue;
          const d = _distance(signature, tpl);
          if (d < minDist) minDist = d;
        }
      }
      if (minDist === INF) continue;
      const score = 1 - (minDist / maxDist);
      if (minDist < best.dist) {
        secondBest = { ...best };
        best = { char: ch, dist: minDist, score };
      } else if (minDist < secondBest.dist) {
        secondBest = { char: ch, dist: minDist, score };
      }
    }
    return { ...best, secondBest };
  }

  function userTemplateStats() {
    const out = {};
    for (const region of ['mp', 'exp', 'adena', 'level']) {
      const r = USER_TEMPLATES[region] || {};
      const digits = {};
      let total = 0;
      for (const [ch, arr] of Object.entries(r)) {
        digits[ch] = arr.length;
        total += arr.length;
      }
      out[region] = { total, digits };
    }
    return out;
  }

  function clearUserTemplates(region) {
    if (region) {
      USER_TEMPLATES[region] = {};
    } else {
      USER_TEMPLATES = { mp: {}, exp: {}, adena: {}, level: {} };
    }
    saveUserTemplates();
  }

  /**
   * [v1.8.2] 단일 자릿수만 삭제 — 잘못 학습된 sig 회복용.
   * 사용자가 디지트 그리드 셀 클릭 시 해당 글자 sig 전체 삭제 + 즉시 저장.
   */
  function clearUserTemplateDigit(region, digit) {
    if (!region || digit == null) return false;
    const ch = String(digit);
    if (!USER_TEMPLATES[region]) return false;
    if (!USER_TEMPLATES[region][ch]) return false;
    delete USER_TEMPLATES[region][ch];
    saveUserTemplates();
    return true;
  }

  // 앱 시작 시 자동 로드
  try { loadUserTemplates(); } catch (_) {}

  global.TemplateMatcher = {
    load,
    match,
    matchVariableLength,
    isLoaded,
    templateCount,
    // [v1.8.0] User template API
    registerUserTemplate,
    matchUser,
    userTemplateStats,
    clearUserTemplates,
    clearUserTemplateDigit,
    loadUserTemplates,
    saveUserTemplates
  };
})(window);
