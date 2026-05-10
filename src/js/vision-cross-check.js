/**
 * vision-cross-check.js — Vision LLM cross-check 호출 (v2.0.0 P3)
 *
 * 역할:
 *   Bayesian posterior < 0.85 시 백엔드 /vision endpoint 호출 → 의심 케이스 검증.
 *   응답값을 Bayesian tracker에 fed-back (force는 아님 — 정상 observe로 한 번 더 검증).
 *
 * Throttle:
 *   - region별 60 req/h (localStorage `lmp.vision.{region}.calls` — sliding window)
 *   - 전역 동시 in-flight 1개 (race 방지)
 *
 * 의존성: window.CloudAuth, window.CloudSync (BASE_URL)
 */
(function (global) {
  'use strict';

  const VISION_CALLS_KEY_PREFIX = 'lmp.vision.';
  const HOUR_MS = 3600 * 1000;
  const HOURLY_CAP_PER_REGION = 60;

  // 동시 호출 1개 — 같은 region이 빠르게 anomaly 반복 시 race 방지
  const _inflight = { mp: false, exp: false, level: false, adena: false };

  function _baseUrl() {
    if (global.CloudSync && typeof global.CloudSync._baseUrl === 'function') {
      return global.CloudSync._baseUrl();
    }
    return 'https://ramin-5gt.pages.dev/api/lineage-hub';
  }

  function _isAuthed() {
    return !!(global.CloudAuth && global.CloudAuth.isCloudAuthed && global.CloudAuth.isCloudAuthed());
  }

  function _authHeaders() {
    if (!global.CloudAuth || !global.CloudAuth.buildAuthHeaders) return {};
    return global.CloudAuth.buildAuthHeaders();
  }

  // ─────────────────────────────────────────────────────────────────
  // Sliding window throttle (region별 시간당 60건)
  // ─────────────────────────────────────────────────────────────────
  function _loadCalls(region) {
    try {
      const raw = localStorage.getItem(VISION_CALLS_KEY_PREFIX + region + '.calls');
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      // 1시간 이전 것 제거
      const cutoff = Date.now() - HOUR_MS;
      return arr.filter((ts) => Number.isFinite(ts) && ts > cutoff);
    } catch (_) { return []; }
  }

  function _recordCall(region) {
    try {
      const arr = _loadCalls(region);
      arr.push(Date.now());
      localStorage.setItem(VISION_CALLS_KEY_PREFIX + region + '.calls', JSON.stringify(arr));
    } catch (_) {}
  }

  function getRemainingCalls(region) {
    const used = _loadCalls(region).length;
    return Math.max(0, HOURLY_CAP_PER_REGION - used);
  }

  function _isThrottled(region) {
    return _loadCalls(region).length >= HOURLY_CAP_PER_REGION;
  }

  // ─────────────────────────────────────────────────────────────────
  // canvas → PNG base64 (data URL의 prefix 제거)
  // ─────────────────────────────────────────────────────────────────
  function _canvasToBase64(canvas) {
    if (!canvas || typeof canvas.toDataURL !== 'function') return null;
    try {
      const url = canvas.toDataURL('image/png');
      const m = url.match(/^data:image\/png;base64,(.+)$/);
      return m ? m[1] : null;
    } catch (_) { return null; }
  }

  /**
   * Vision LLM cross-check 요청.
   * @param {string} region 'mp'|'exp'|'level'|'adena'
   * @param {HTMLCanvasElement} canvas 검증 대상 ROI 캔버스
   * @param {Array<string|number>} candidates [paddleVal, tessVal] 등 후보값
   * @param {number|null} anchor 직전 trustedValue (서버 prior용)
   * @returns {Promise<{ok, value?, confidence?, model?, reason?, latencyMs?, skipped?, reason?}>}
   */
  async function requestVisionCheck(region, canvas, candidates, anchor) {
    if (!_isAuthed()) return { ok: false, skipped: true, reason: 'not_authed' };
    const validRegions = ['mp', 'exp', 'level', 'adena'];
    if (!validRegions.includes(region)) return { ok: false, error: 'invalid_region' };
    if (_inflight[region]) return { ok: false, skipped: true, reason: 'inflight' };
    if (_isThrottled(region)) return { ok: false, skipped: true, reason: 'rate_limited', remaining: 0 };

    const png_b64 = _canvasToBase64(canvas);
    if (!png_b64) return { ok: false, error: 'invalid_canvas' };

    _inflight[region] = true;
    _recordCall(region);

    const t0 = Date.now();
    try {
      const body = {
        region,
        png_b64,
        candidates: Array.isArray(candidates) ? candidates.map((c) => c == null ? '' : String(c)) : [],
        anchor: (anchor == null || !Number.isFinite(anchor)) ? null : anchor
      };
      const res = await fetch(_baseUrl() + '/vision', {
        method: 'POST',
        headers: Object.assign({
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }, _authHeaders()),
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) return { ok: false, error: 'auth_expired', status: res.status };
        if (res.status === 429) return { ok: false, error: 'rate_limited_server', status: 429 };
        return { ok: false, error: 'http_' + res.status };
      }
      const json = await res.json().catch(() => null);
      if (!json || json.value == null) return { ok: false, error: 'invalid_response' };
      return {
        ok: true,
        value: json.value,
        confidence: typeof json.confidence === 'number' ? json.confidence : null,
        model: json.model || 'unknown',
        reason: json.reason || '',
        latencyMs: typeof json.latency_ms === 'number' ? json.latency_ms : (Date.now() - t0),
        rateRemaining: typeof json.rate_remaining === 'number' ? json.rate_remaining : null
      };
    } catch (e) {
      return { ok: false, error: e && e.message || 'fetch_failed' };
    } finally {
      _inflight[region] = false;
    }
  }

  /**
   * Vision 결과를 region 타입에 맞춰 정수/실수로 파싱.
   * @returns {number|null}
   */
  function parseVisionValue(region, raw) {
    if (raw == null) return null;
    const s = String(raw).trim().replace(/[,\s]/g, '');
    if (region === 'exp') {
      const n = parseFloat(s);
      return Number.isFinite(n) && n >= 0 && n < 100 ? n : null;
    }
    // mp는 cur/max 형태 → 별도 파서가 필요. 여기서는 정수만 처리 (cur 값).
    if (region === 'mp') {
      // 'cur/max' 형태면 cur만 추출
      const m = s.match(/^(\d+)(?:\/(\d+))?$/);
      if (!m) return null;
      const cur = parseInt(m[1], 10);
      return Number.isFinite(cur) ? cur : null;
    }
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  }

  // ─────────────────────────────────────────────────────────────────
  // [v2.0.0 P3+] getDebugInfo — Vision 호출 throttle/inflight 상태
  // ─────────────────────────────────────────────────────────────────
  function getDebugInfo() {
    const remaining = {};
    const lastCallTs = {};
    ['mp', 'exp', 'level', 'adena'].forEach((r) => {
      const calls = _loadCalls(r);
      remaining[r] = Math.max(0, HOURLY_CAP_PER_REGION - calls.length);
      lastCallTs[r] = calls.length ? calls[calls.length - 1] : 0;
    });
    return {
      hourlyCapPerRegion: HOURLY_CAP_PER_REGION,
      remainingByRegion: remaining,
      inflight: Object.assign({}, _inflight),
      lastCallTsByRegion: lastCallTs
    };
  }

  global.VisionCrossCheck = {
    requestVisionCheck,
    parseVisionValue,
    getRemainingCalls,
    getDebugInfo,
    HOURLY_CAP_PER_REGION
  };
})(typeof window !== 'undefined' ? window : this);
