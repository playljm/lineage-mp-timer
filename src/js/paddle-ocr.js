/**
 * PaddleOCR wrapper — window.paddlejs.ocr UMD를 감싸 tesseract와 호환되는 인터페이스 제공
 * 모델은 첫 init() 시 CDN(paddlejs.bj.bcebos.com)에서 다운로드 — 첫 실행 시 인터넷 필요
 *
 * Usage:
 *   await MpPaddle.init();
 *   const r = await MpPaddle.recognize(canvas);  // { text, confidence }
 */
(function (global) {
  'use strict';

  let initPromise = null;
  let ready = false;
  let lastError = null;

  function getPaddleOcr() {
    return (global.paddlejs && global.paddlejs.ocr) || null;
  }

  async function init() {
    if (ready) return true;
    if (initPromise) return initPromise;

    const ocr = getPaddleOcr();
    if (!ocr) {
      lastError = new Error('paddlejs.ocr UMD가 로드되지 않음 (script tag 누락 가능)');
      throw lastError;
    }

    initPromise = (async () => {
      try {
        console.log('[PaddleOCR] init 시작 (모델 다운로드 — 첫 실행 시 ~30MB)');
        const t0 = Date.now();
        await ocr.init();
        console.log('[PaddleOCR] init 완료 (' + (Date.now() - t0) + 'ms)');
        ready = true;
        return true;
      } catch (e) {
        lastError = e;
        initPromise = null;  // 다음 호출 시 재시도 허용
        console.error('[PaddleOCR] init 실패:', e);
        throw e;
      }
    })();
    return initPromise;
  }

  function isReady() { return ready; }
  function getLastError() { return lastError; }

  // Canvas → HTMLImageElement 변환 (paddle은 HTMLCanvasElement에서 검출 0개 반환하는 버그가 있음)
  function canvasToImage(canvas) {
    return new Promise((resolve, reject) => {
      try {
        const dataUrl = canvas.toDataURL('image/png');
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('canvas → Image 변환 실패'));
        img.src = dataUrl;
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Canvas/Image에서 텍스트 인식
   * @param {HTMLCanvasElement|HTMLImageElement} input
   * @returns {Promise<{ text: string, confidence: number, raw: any }>}
   */
  async function recognize(input) {
    if (!ready) await init();
    const ocr = getPaddleOcr();
    if (!ocr) throw new Error('PaddleOCR 미초기화');

    // paddle은 HTMLImageElement만 처리 — canvas는 자동 변환
    let img = input;
    if (input instanceof HTMLCanvasElement) {
      img = await canvasToImage(input);
    }

    const t0 = Date.now();
    const res = await ocr.recognize(img);
    const elapsed = Date.now() - t0;
    // res 구조: { text: string|string[], points: [...] } 추정 — 실제 형태는 디버깅 필요
    let textArr = [];
    if (res) {
      if (Array.isArray(res.text)) textArr = res.text;
      else if (typeof res.text === 'string') textArr = [res.text];
      // 폴백: res 자체가 string인 경우
      else if (typeof res === 'string') textArr = [res];
    }
    const text = textArr.filter((x) => x).join(' ').trim();
    console.log('[PaddleOCR] recognize result:', {
      text,
      elapsed,
      rawTextField: res && res.text,
      rawPointsLen: res && res.points && res.points.length,
      rawKeys: res ? Object.keys(res) : null,
      rawSample: JSON.stringify(res).slice(0, 500)
    });
    // PaddleOCR는 confidence를 직접 안 줌 — 텍스트 존재 여부로 90/0 단순 매핑
    const confidence = text.length > 0 ? 90 : 0;
    return { text, confidence, raw: res };
  }

  global.MpPaddle = {
    init,
    isReady,
    getLastError,
    recognize
  };
})(window);
