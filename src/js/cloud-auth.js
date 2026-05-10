/**
 * cloud-auth.js — ramin.co.kr Lineage Hub 인증 헬퍼 (v2.0.0 P3)
 *
 * 역할:
 *   - cloud token 보관/조회 (localStorage `lmp.cloudToken` + `lmp.cloudUserEmail`)
 *   - BrowserWindow modal 로그인 (Electron main 측 IPC: cloud-login)
 *   - fallback: 사용자가 token을 직접 텍스트로 입력
 *
 * 토큰 보관 정책:
 *   - 평문 X. 간단한 base64 인코딩 (XOR-style 비공개 키 적용)
 *   - 민감도가 매우 높지 않음 (개인 사냥 통계 + 학습 데이터 업로드 권한)
 *   - 더 강력한 보호가 필요하면 Electron safeStorage로 마이그레이션 (TODO P4)
 *
 * 의존성: window.api (cloudLoginPopup, cloudClearCookies)
 *         optional — fallback은 prompt() 사용
 */
(function (global) {
  'use strict';

  const TOKEN_KEY = 'lmp.cloudToken';
  const EMAIL_KEY = 'lmp.cloudUserEmail';
  const PROFILE_KEY = 'lmp.cloudProfile';

  // 단순 obfuscation key — 평문 보관 회피용. 보안 X (소스에 노출됨).
  // 토큰을 localStorage에서 직접 긁어서 재사용하기 어렵게 하는 방어선.
  const _OBF_KEY = 'lmp-cloud-' + (typeof navigator !== 'undefined' ? (navigator.userAgent || 'ua').slice(0, 8) : 'srv');

  function _obfuscate(s) {
    if (!s) return '';
    try {
      let out = '';
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i) ^ _OBF_KEY.charCodeAt(i % _OBF_KEY.length);
        out += String.fromCharCode(c);
      }
      // base64 (utf-safe)
      return btoa(unescape(encodeURIComponent(out)));
    } catch (_) { return ''; }
  }

  function _deobfuscate(s) {
    if (!s) return '';
    try {
      const raw = decodeURIComponent(escape(atob(s)));
      let out = '';
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i) ^ _OBF_KEY.charCodeAt(i % _OBF_KEY.length);
        out += String.fromCharCode(c);
      }
      return out;
    } catch (_) { return ''; }
  }

  function setToken(token, email) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, _obfuscate(String(token)));
      else localStorage.removeItem(TOKEN_KEY);
      if (email) localStorage.setItem(EMAIL_KEY, String(email));
    } catch (_) { /* ignore */ }
  }

  function getCloudToken() {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const t = _deobfuscate(raw);
      return t || null;
    } catch (_) { return null; }
  }

  function getCloudEmail() {
    try { return localStorage.getItem(EMAIL_KEY) || null; } catch (_) { return null; }
  }

  function isCloudAuthed() {
    const t = getCloudToken();
    return typeof t === 'string' && t.length >= 8;
  }

  function getCloudProfile() {
    try {
      const raw = localStorage.getItem(PROFILE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function setCloudProfile(profile) {
    try {
      if (profile) localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
      else localStorage.removeItem(PROFILE_KEY);
    } catch (_) { /* ignore */ }
  }

  /**
   * BrowserWindow modal 또는 token 직접 입력으로 로그인.
   * @returns {Promise<{ok: boolean, email?: string, error?: string}>}
   */
  async function cloudLogin() {
    const api = global.api || null;
    // 1순위: Electron BrowserWindow modal (window.api.cloudLoginPopup)
    if (api && typeof api.cloudLoginPopup === 'function') {
      try {
        const r = await api.cloudLoginPopup();
        if (r && r.ok && r.token) {
          setToken(r.token, r.email || '');
          if (r.profile) setCloudProfile(r.profile);
          return { ok: true, email: r.email || '' };
        }
        if (r && r.cancelled) return { ok: false, error: 'cancelled' };
        return { ok: false, error: (r && r.error) || 'no_token' };
      } catch (e) {
        // modal IPC 실패 → fallback to manual token entry
        console.warn('[cloud-auth] modal login failed, fallback to manual:', e && e.message);
      }
    }
    // 2순위: 사용자 직접 token 입력 (시작 단계용)
    return cloudLoginManual();
  }

  /**
   * Manual token entry — prompt()로 토큰 직접 입력.
   * 사용자가 ramin.co.kr 웹에서 로그인 후 개발자 도구로 token을 복사해 붙여넣는 시나리오.
   */
  async function cloudLoginManual() {
    try {
      const token = (typeof prompt === 'function')
        ? prompt('ramin.co.kr 인증 토큰을 입력하세요\n(웹에서 로그인 후 개발자 도구 → Application → Cookies → session_token 값 복사)')
        : null;
      if (!token || !token.trim()) return { ok: false, error: 'cancelled' };
      const email = (typeof prompt === 'function')
        ? (prompt('이메일 (선택, 표시용)') || '')
        : '';
      setToken(token.trim(), email.trim());
      return { ok: true, email: email.trim() };
    } catch (e) {
      return { ok: false, error: e && e.message || 'manual_failed' };
    }
  }

  /**
   * 로그아웃 — 로컬 토큰 삭제. 서버 세션은 영향 없음 (token TTL 후 자연 만료).
   */
  async function cloudLogout() {
    setToken(null, null);
    setCloudProfile(null);
    try { localStorage.removeItem(EMAIL_KEY); } catch (_) {}
    // Electron 측 cookie partition 정리 (다음 로그인 시 fresh state)
    const api = global.api || null;
    if (api && typeof api.cloudClearCookies === 'function') {
      try { await api.cloudClearCookies(); } catch (_) { /* ignore */ }
    }
    return { ok: true };
  }

  /**
   * fetch용 인증 헤더 빌더.
   * @returns {object} { 'Authorization'?: string, 'Cookie'?: string }
   */
  function buildAuthHeaders() {
    const t = getCloudToken();
    if (!t) return {};
    return { 'Authorization': 'Bearer ' + t };
  }

  // ─────────────────────────────────────────────────────────────────
  // [v2.0.0 P3+] getDebugInfo — 진단 패널/AI 분석용 토큰/세션 상태
  //   ⚠ 평문 토큰 노출 X — length만 표시
  // ─────────────────────────────────────────────────────────────────
  const LAST_LOGIN_RESULT_KEY = 'lmp.cloudAuth.lastResult';
  function _recordLoginResult(result) {
    try { localStorage.setItem(LAST_LOGIN_RESULT_KEY, String(result || '')); } catch (_) {}
  }
  function getDebugInfo() {
    const t = getCloudToken();
    let lastResult = null;
    try { lastResult = localStorage.getItem(LAST_LOGIN_RESULT_KEY) || null; } catch (_) {}
    return {
      isAuthed: isCloudAuthed(),
      hasToken: !!t,
      tokenLength: (typeof t === 'string') ? t.length : 0,
      userEmail: getCloudEmail(),
      profile: getCloudProfile(),
      cookieDomain: 'ramin.co.kr (Electron BrowserWindow modal)',
      lastLoginAttemptResult: lastResult
    };
  }

  // wrap cloudLogin/cloudLogout to record lastResult (진단용 history)
  const _origCloudLogin = cloudLogin;
  async function cloudLoginWithRecord() {
    try {
      const r = await _origCloudLogin();
      _recordLoginResult(r && r.ok ? 'ok' : ('fail:' + (r && r.error || 'unknown')));
      return r;
    } catch (e) {
      _recordLoginResult('exception:' + (e && e.message || 'unknown'));
      throw e;
    }
  }

  global.CloudAuth = {
    cloudLogin: cloudLoginWithRecord,
    cloudLoginManual,
    cloudLogout,
    getCloudToken,
    getCloudEmail,
    getCloudProfile,
    setCloudProfile,
    isCloudAuthed,
    buildAuthHeaders,
    getDebugInfo,
    // exposed for testing / debug
    _setToken: setToken
  };
})(typeof window !== 'undefined' ? window : this);
