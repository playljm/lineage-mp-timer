/**
 * cloud-sync.js — ramin.co.kr Lineage Hub 클라우드 동기화 (v2.0.0 P3)
 *
 * 역할:
 *   1) uploadSample(region, dataUrl, ocrCandidates, label?, confidence)
 *      - multipart POST /samples — 학습 데이터 풀링
 *      - throttle: 30s/region 최소 간격
 *      - daily cap: 100 sample 또는 10MB (localStorage day quota)
 *      - 사용자 정정 (label) → 우선 업로드 (priority bypass throttle)
 *
 *   2) downloadLatestTraineddata()
 *      - GET /traineddata/latest + ETag 비교
 *      - main process IPC로 build/tessdata/lineage.traineddata 교체
 *      - 24h 주기 자동 + 앱 시작 1회
 *
 *   3) getStats(period)
 *      - GET /stats?period=7d
 *
 * Endpoint BASE_URL 결정:
 *   - localStorage `lmp.cloudBaseUrl` override (dev/staging 전환용)
 *   - default: https://ramin-5gt.pages.dev/api/lineage-hub
 *
 * 의존성: window.CloudAuth (인증 토큰), window.api (Electron IPC, traineddata write)
 */
(function (global) {
  'use strict';

  const DEFAULT_BASE_URL = 'https://ramin-5gt.pages.dev/api/lineage-hub';
  const BASE_URL_KEY = 'lmp.cloudBaseUrl';
  const SYNC_ENABLED_KEY = 'lmp.cloudSync';            // '1' | '0'
  const QUOTA_KEY = 'lmp.cloudSync.dayQuota';          // { date, count, bytes }
  const LAST_UPLOAD_KEY_PREFIX = 'lmp.cloudSync.lastUpload.'; // + region
  const ETAG_KEY = 'lmp.cloudSync.traineddataEtag';
  const TRAINEDDATA_LAST_CHECK_KEY = 'lmp.cloudSync.traineddataCheckedAt';
  const MODEL_VERSION_KEY = 'lmp.cloudSync.modelVersion';

  const REGION_THROTTLE_MS = 30 * 1000;       // 30s per region
  const DAILY_SAMPLE_CAP = 100;               // 100 samples / day
  const DAILY_BYTE_CAP = 10 * 1024 * 1024;    // 10MB / day
  const TRAINEDDATA_INTERVAL_MS = 24 * 3600 * 1000; // 24h

  function _baseUrl() {
    try {
      const override = localStorage.getItem(BASE_URL_KEY);
      if (override && /^https?:\/\//.test(override)) return override.replace(/\/$/, '');
    } catch (_) {}
    return DEFAULT_BASE_URL;
  }

  function _isAuthed() {
    return !!(global.CloudAuth && global.CloudAuth.isCloudAuthed && global.CloudAuth.isCloudAuthed());
  }

  function _authHeaders() {
    if (!global.CloudAuth || !global.CloudAuth.buildAuthHeaders) return {};
    return global.CloudAuth.buildAuthHeaders();
  }

  function isSyncEnabled() {
    try { return localStorage.getItem(SYNC_ENABLED_KEY) === '1'; } catch (_) { return false; }
  }

  function setSyncEnabled(enabled) {
    try { localStorage.setItem(SYNC_ENABLED_KEY, enabled ? '1' : '0'); } catch (_) {}
  }

  // ─────────────────────────────────────────────────────────────────
  // Quota tracking (per UTC day)
  // ─────────────────────────────────────────────────────────────────
  function _todayKey() {
    const d = new Date();
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  function _loadQuota() {
    try {
      const raw = localStorage.getItem(QUOTA_KEY);
      if (!raw) return { date: _todayKey(), count: 0, bytes: 0 };
      const q = JSON.parse(raw);
      if (!q || q.date !== _todayKey()) return { date: _todayKey(), count: 0, bytes: 0 };
      return q;
    } catch (_) { return { date: _todayKey(), count: 0, bytes: 0 }; }
  }

  function _saveQuota(q) {
    try { localStorage.setItem(QUOTA_KEY, JSON.stringify(q)); } catch (_) {}
  }

  function getDayQuota() {
    const q = _loadQuota();
    return {
      date: q.date,
      count: q.count,
      bytes: q.bytes,
      capCount: DAILY_SAMPLE_CAP,
      capBytes: DAILY_BYTE_CAP,
      remainingCount: Math.max(0, DAILY_SAMPLE_CAP - q.count),
      remainingBytes: Math.max(0, DAILY_BYTE_CAP - q.bytes)
    };
  }

  function _checkAndIncQuota(byteSize) {
    const q = _loadQuota();
    if (q.count + 1 > DAILY_SAMPLE_CAP) return { ok: false, reason: 'daily_count_cap' };
    if (q.bytes + byteSize > DAILY_BYTE_CAP) return { ok: false, reason: 'daily_byte_cap' };
    q.count += 1;
    q.bytes += byteSize;
    _saveQuota(q);
    return { ok: true, quota: q };
  }

  // ─────────────────────────────────────────────────────────────────
  // Throttle (region별 최소 간격)
  // ─────────────────────────────────────────────────────────────────
  function _lastUploadAt(region) {
    try {
      const raw = localStorage.getItem(LAST_UPLOAD_KEY_PREFIX + region);
      const n = raw ? parseInt(raw, 10) : 0;
      return Number.isFinite(n) ? n : 0;
    } catch (_) { return 0; }
  }

  function _markUploadAt(region, ts) {
    try { localStorage.setItem(LAST_UPLOAD_KEY_PREFIX + region, String(ts)); } catch (_) {}
  }

  // ─────────────────────────────────────────────────────────────────
  // dataURL → Blob (multipart용)
  // ─────────────────────────────────────────────────────────────────
  function _dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== 'string') return null;
    const m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!m) return null;
    try {
      const mime = m[1];
      const bin = atob(m[2]);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: mime });
    } catch (_) { return null; }
  }

  function _clientVersion() {
    try {
      // app.js가 #app-version에 v1.8.4 형태로 채움 — 없으면 unknown
      const el = document.getElementById('app-version');
      if (el && el.textContent) return el.textContent.replace(/^v/, '').trim() || 'unknown';
    } catch (_) {}
    return 'unknown';
  }

  // ─────────────────────────────────────────────────────────────────
  // 1) uploadSample
  // ─────────────────────────────────────────────────────────────────
  /**
   * @param {string} region 'mp'|'exp'|'level'|'adena'
   * @param {string} dataUrl 'data:image/png;base64,...'
   * @param {object} ocrCandidates { paddle?, tess?, lineage? }
   * @param {string|null} label 사용자 정정 ground truth (null이면 voting)
   * @param {number} confidence 0~1
   * @returns {Promise<{ok, id?, deduped?, skipped?, reason?}>}
   */
  async function uploadSample(region, dataUrl, ocrCandidates, label, confidence) {
    if (!isSyncEnabled()) return { ok: false, skipped: true, reason: 'sync_disabled' };
    if (!_isAuthed()) return { ok: false, skipped: true, reason: 'not_authed' };
    const validRegions = ['mp', 'exp', 'level', 'adena'];
    if (!validRegions.includes(region)) return { ok: false, error: 'invalid_region' };

    const isUserCorrection = !!(label && String(label).trim());
    const now = Date.now();
    const last = _lastUploadAt(region);
    // Throttle: 사용자 정정은 priority — throttle 무시. 일반 OCR은 30s + 더 큰 throttle (60s)
    const minGap = isUserCorrection ? 0 : (REGION_THROTTLE_MS * 2); // 60s for OCR, 0 for correction
    if (!isUserCorrection && (now - last) < minGap) {
      return { ok: false, skipped: true, reason: 'throttled', nextAtMs: last + minGap };
    }

    const blob = _dataUrlToBlob(dataUrl);
    if (!blob) return { ok: false, error: 'invalid_dataUrl' };

    // 미리 quota 체크 (post-fail은 quota 차감 안 됨)
    const quotaCheck = _checkAndIncQuota(blob.size);
    if (!quotaCheck.ok) return { ok: false, skipped: true, reason: quotaCheck.reason };

    try {
      const fd = new FormData();
      fd.append('png', blob, region + '.png');
      fd.append('region', region);
      if (isUserCorrection) fd.append('label', String(label).trim());
      if (ocrCandidates) {
        if (ocrCandidates.paddle != null) fd.append('ocr_paddle', String(ocrCandidates.paddle));
        if (ocrCandidates.tess != null) fd.append('ocr_tess', String(ocrCandidates.tess));
        if (ocrCandidates.lineage != null) fd.append('ocr_lineage', String(ocrCandidates.lineage));
      }
      if (Number.isFinite(confidence)) fd.append('confidence', String(confidence));
      fd.append('client_ver', _clientVersion());

      const res = await fetch(_baseUrl() + '/samples', {
        method: 'POST',
        headers: Object.assign({}, _authHeaders()),
        body: fd
      });
      if (!res.ok) {
        // 401/403: token 만료
        if (res.status === 401 || res.status === 403) {
          return { ok: false, error: 'auth_expired', status: res.status };
        }
        return { ok: false, error: 'http_' + res.status };
      }
      const json = await res.json().catch(() => ({}));
      _markUploadAt(region, now);
      return {
        ok: true,
        id: json.id,
        deduped: !!json.deduped,
        rateRemaining: json.rate_remaining
      };
    } catch (e) {
      return { ok: false, error: e && e.message || 'fetch_failed' };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 2) downloadLatestTraineddata
  // ─────────────────────────────────────────────────────────────────
  /**
   * @param {object} opts { force?: boolean }
   * @returns {Promise<{ok, status, etag?, version?, written?, skipped?, reason?}>}
   */
  async function downloadLatestTraineddata(opts) {
    opts = opts || {};
    if (!_isAuthed()) return { ok: false, skipped: true, reason: 'not_authed' };

    if (!opts.force) {
      try {
        const last = parseInt(localStorage.getItem(TRAINEDDATA_LAST_CHECK_KEY) || '0', 10);
        if (Number.isFinite(last) && (Date.now() - last) < TRAINEDDATA_INTERVAL_MS) {
          return { ok: false, skipped: true, reason: 'within_interval' };
        }
      } catch (_) {}
    }

    let etag = '';
    try { etag = localStorage.getItem(ETAG_KEY) || ''; } catch (_) {}

    try {
      const headers = Object.assign({}, _authHeaders());
      if (etag) headers['If-None-Match'] = etag;
      const res = await fetch(_baseUrl() + '/traineddata/latest', {
        method: 'GET',
        headers
      });
      try { localStorage.setItem(TRAINEDDATA_LAST_CHECK_KEY, String(Date.now())); } catch (_) {}
      if (res.status === 304) {
        return { ok: true, status: 304, skipped: true, reason: 'etag_match' };
      }
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) return { ok: false, error: 'auth_expired', status: res.status };
        return { ok: false, error: 'http_' + res.status };
      }

      const newEtag = res.headers.get('ETag') || '';
      const versionHdr = res.headers.get('X-Model-Version') || '';
      const buf = await res.arrayBuffer();
      if (!buf || buf.byteLength < 1024) {
        return { ok: false, error: 'invalid_payload', size: buf && buf.byteLength };
      }

      // main process로 파일 쓰기 위임
      const api = global.api || null;
      if (!api || typeof api.cloudWriteTraineddata !== 'function') {
        return { ok: false, error: 'ipc_unavailable' };
      }
      const writeRes = await api.cloudWriteTraineddata({
        bytes: buf,
        version: versionHdr || null
      });
      if (!writeRes || !writeRes.ok) {
        return { ok: false, error: (writeRes && writeRes.error) || 'write_failed' };
      }

      try {
        if (newEtag) localStorage.setItem(ETAG_KEY, newEtag);
        if (versionHdr) localStorage.setItem(MODEL_VERSION_KEY, versionHdr);
      } catch (_) {}

      return {
        ok: true,
        status: 200,
        etag: newEtag,
        version: versionHdr || null,
        written: writeRes.path || true,
        size: buf.byteLength
      };
    } catch (e) {
      return { ok: false, error: e && e.message || 'fetch_failed' };
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 3) getStats
  // ─────────────────────────────────────────────────────────────────
  async function getStats(period) {
    if (!_isAuthed()) return { ok: false, skipped: true, reason: 'not_authed' };
    const p = period || '7d';
    try {
      const res = await fetch(_baseUrl() + '/stats?period=' + encodeURIComponent(p), {
        method: 'GET',
        headers: Object.assign({ 'Accept': 'application/json' }, _authHeaders())
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) return { ok: false, error: 'auth_expired' };
        return { ok: false, error: 'http_' + res.status };
      }
      const json = await res.json().catch(() => null);
      return { ok: true, stats: json };
    } catch (e) {
      return { ok: false, error: e && e.message || 'fetch_failed' };
    }
  }

  function getModelVersion() {
    try { return localStorage.getItem(MODEL_VERSION_KEY) || null; } catch (_) { return null; }
  }

  global.CloudSync = {
    uploadSample,
    downloadLatestTraineddata,
    getStats,
    getModelVersion,
    isSyncEnabled,
    setSyncEnabled,
    getDayQuota,
    // constants exposed for UI
    REGION_THROTTLE_MS,
    DAILY_SAMPLE_CAP,
    DAILY_BYTE_CAP,
    TRAINEDDATA_INTERVAL_MS,
    _baseUrl
  };
})(typeof window !== 'undefined' ? window : this);
