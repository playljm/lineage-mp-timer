/**
 * Lineage MP Timer v1.4.0 — Auto ROI Detector
 *
 * 게임 화면 캔버스에서 HP/MP/EXP/ADENA UI 요소를 자동 탐지한다.
 * 순수 이미지 분석 모듈 — DOM 의존성은 detectGameUI 진입점에서만 발생 (canvas.getContext).
 *
 * 알고리즘:
 *   1. RGB → HSV 변환
 *   2. HSV 임계값 마스크 (Uint8Array)
 *   3. 4-connectivity Connected Component Labeling (Union-Find rank + path compression)
 *   4. bounding box / area / 평균 HSV / aspect 필터
 *   5. anchor 기반 텍스트 ROI 도출
 *   6. cross-check 검증
 *
 * 시간 복잡도: O(N · α(N))   — α는 inverse Ackermann (≈ 상수)
 * 공간 복잡도: O(N)            — 마스크 1byte, 라벨 4byte, parent/rank 각 4byte
 *
 * SPEC: .omc/plans/v1.4.0-auto-detection.md (특히 v1.4.0-rev1 보정 노트)
 */
(function (global) {
  'use strict';

  // =========================================================================
  // 1. RGB → HSV 변환
  // =========================================================================
  /**
   * @returns {{h:number, s:number, v:number}} h: 0~360, s: 0~1, v: 0~1
   */
  function rgbToHsv(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d > 0) {
      if (max === rn)      h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else                 h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    const v = max;
    return { h, s, v };
  }

  // =========================================================================
  // 2. HSV 마스크 생성
  // =========================================================================
  /**
   * hue wrap-around 지원: hueMin > hueMax 이면 [0, hueMax] OR [hueMin, 360) 유효
   */
  function buildHsvMask(imageData, opts) {
    const { width: w, height: h, data } = imageData;
    const { hueMin, hueMax, satMin, valMin } = opts;
    const wraps = hueMin > hueMax;
    const mask = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const hsv = rgbToHsv(data[i], data[i + 1], data[i + 2]);
      const hueOk = wraps
        ? (hsv.h <= hueMax || hsv.h >= hueMin)
        : (hsv.h >= hueMin && hsv.h <= hueMax);
      if (hueOk && hsv.s >= satMin && hsv.v >= valMin) {
        mask[p] = 1;
      }
    }
    return mask;
  }

  // =========================================================================
  // 3. Union-Find (rank + path compression)
  // =========================================================================
  function ufFind(parent, x) {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    // path compression
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  }

  function ufUnion(parent, rank, a, b) {
    const ra = ufFind(parent, a);
    const rb = ufFind(parent, b);
    if (ra === rb) return ra;
    if (rank[ra] < rank[rb]) {
      parent[ra] = rb;
      return rb;
    } else if (rank[ra] > rank[rb]) {
      parent[rb] = ra;
      return ra;
    } else {
      parent[rb] = ra;
      rank[ra]++;
      return ra;
    }
  }

  // =========================================================================
  // 4. Connected Component Labeling (4-connectivity, 2-pass)
  // =========================================================================
  /**
   * 마스크에서 연결된 component를 찾아 bounding box / area / 평균 HSV 계산.
   * @returns {Array<{x,y,width,height,area,avgHue,avgSat}>} area 내림차순
   */
  function findColorBlobs(imageData, opts) {
    const { width: w, height: h, data } = imageData;
    const { minArea = 1, posFilter = null } = opts;
    const mask = buildHsvMask(imageData, opts);

    // 1-pass: provisional label + union
    const labels = new Int32Array(w * h);
    const parent = new Int32Array(w * h + 1);  // label 0은 미사용
    const rank = new Int32Array(w * h + 1);
    let nextLabel = 1;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!mask[idx]) continue;
        // 위쪽(N), 왼쪽(W) 이웃 검사 (4-connectivity 2-pass)
        const upIdx = y > 0 ? idx - w : -1;
        const lfIdx = x > 0 ? idx - 1 : -1;
        const upL = upIdx >= 0 ? labels[upIdx] : 0;
        const lfL = lfIdx >= 0 ? labels[lfIdx] : 0;

        if (upL === 0 && lfL === 0) {
          const nl = nextLabel++;
          parent[nl] = nl;
          labels[idx] = nl;
        } else if (upL !== 0 && lfL === 0) {
          labels[idx] = upL;
        } else if (upL === 0 && lfL !== 0) {
          labels[idx] = lfL;
        } else {
          // 둘 다 있으면 작은 라벨로 통일하고 union
          const merged = ufUnion(parent, rank, upL, lfL);
          labels[idx] = merged;
        }
      }
    }

    // 2-pass: root 라벨로 정규화하면서 통계 집계
    // root → { minX, minY, maxX, maxY, area, sumH, sumS, sinH, cosH }
    // hue는 원형 평균(sin/cos 합)으로 정확히 계산
    const stats = new Map();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const l = labels[idx];
        if (l === 0) continue;
        const root = ufFind(parent, l);
        labels[idx] = root;

        const di = idx * 4;
        const hsv = rgbToHsv(data[di], data[di + 1], data[di + 2]);
        const rad = hsv.h * Math.PI / 180;

        let s = stats.get(root);
        if (!s) {
          s = {
            minX: x, minY: y, maxX: x, maxY: y,
            area: 0, sumS: 0, sinH: 0, cosH: 0
          };
          stats.set(root, s);
        }
        if (x < s.minX) s.minX = x;
        if (y < s.minY) s.minY = y;
        if (x > s.maxX) s.maxX = x;
        if (y > s.maxY) s.maxY = y;
        s.area++;
        s.sumS += hsv.s;
        s.sinH += Math.sin(rad);
        s.cosH += Math.cos(rad);
      }
    }

    // bbox 계산 + minArea/posFilter/aspectRatio 필터
    const blobs = [];
    for (const s of stats.values()) {
      if (s.area < minArea) continue;
      const bx = s.minX;
      const by = s.minY;
      const bw = s.maxX - s.minX + 1;
      const bh = s.maxY - s.minY + 1;
      if (posFilter && !posFilter(bx, by, bw, bh)) continue;

      let avgHue = Math.atan2(s.sinH / s.area, s.cosH / s.area) * 180 / Math.PI;
      if (avgHue < 0) avgHue += 360;
      const avgSat = s.sumS / s.area;

      blobs.push({
        x: Math.round(bx),
        y: Math.round(by),
        width: Math.round(bw),
        height: Math.round(bh),
        area: s.area,
        avgHue,
        avgSat
      });
    }

    blobs.sort((a, b) => b.area - a.area);
    return blobs;
  }

  // =========================================================================
  // 5. 요소별 탐지 (SPEC v1.4.0-rev1 기준)
  // =========================================================================

  // HP 바: 빨강 (hue 350~20 wrap-around), sat>0.6, val>0.4, y_rel>0.6, 가로 세장형
  // [v1.4.0+] 사용자 진단 (2026-05-05T12-14-03 + 검증 스크립트): 게임 화면 HP가 hue 12 (오렌지에 가까운 빨강)
  // 기존 hue 355~5는 너무 엄격 → wrap 350~20으로 완화
  function findHpBar(imageData, w, h) {
    const minArea = Math.max(20, Math.floor(w * h * 0.0008));
    const posFilter = (x, y, bw, bh) => {
      if (y < h * 0.6) return false;
      if (bw < 10) return false;
      return true;
    };
    const blobs = findColorBlobs(imageData, {
      hueMin: 350, hueMax: 20, satMin: 0.6, valMin: 0.4,
      minArea, posFilter
    });
    // 가로로 긴 (width/height > 3) blob 우선
    const wide = blobs.filter((b) => b.width / b.height > 3);
    return wide.length > 0 ? wide[0] : (blobs[0] || null);
  }

  // MP 바: 파랑 (hue 200~245), sat>0.20, val>0.30
  // [v1.4.0+] 검증 결과 진짜 MP 바는 어두운 회색-파랑 — 임계값 더 관대하게
  // HP 기준 인접: y ∈ [hp.y-30, hp.y+30+hp.h], x > hp.x + hp.w + w*0.03
  function findMpBar(imageData, w, h, hpBar) {
    if (!hpBar) return null;
    const yMin = hpBar.y - 40;
    const yMax = hpBar.y + hpBar.height + 40;
    const xMin = hpBar.x + hpBar.width + Math.floor(w * 0.03);
    const minArea = Math.max(20, Math.floor(w * h * 0.0006));
    const posFilter = (x, y, bw, bh) => {
      if (y < yMin || y > yMax) return false;
      if (x < xMin) return false;
      if (bw / Math.max(1, bh) < 2.5) return false;
      return true;
    };
    // [v1.4.0+] 검증: 사용자 게임 MP 바 hue=248, sat=20% — 보라에 가까운 어두운 파랑
    //   기존 hue 200-245 + sat>0.20 너무 엄격 → hue 200-270 + sat>0.10
    const blobs = findColorBlobs(imageData, {
      hueMin: 200, hueMax: 270,
      satMin: 0.10, valMin: 0.25,
      minArea, posFilter
    });
    // 채도 너무 높은 (선명한 순수 파랑/보라 = UI 강조 아이콘) 제외 — 진짜 MP 바는 sat<=0.85
    const filtered = blobs.filter((b) => b.avgSat <= 0.85);
    return filtered.length > 0 ? filtered[0] : (blobs[0] || null);
  }

  // EXP 바: 오렌지 (hue 12~38), sat>0.55, val>0.4, x_rel<0.30, y_rel ∈ [0.65, 0.95]
  // [v1.4.0+] 검증 결과 사용자 게임 EXP 바는 hue 28 (더 노랑 톤), 위치도 yRel 0.76 부근
  // 기존 hue 15-25 + yRel 0.76-0.88 너무 엄격 → 완화
  function findExpBar(imageData, w, h) {
    const minArea = Math.max(15, Math.floor(w * h * 0.0005));
    const posFilter = (x, y, bw, bh) => {
      if (x > w * 0.30) return false;
      if (y < h * 0.65 || y > h * 0.95) return false;
      if (bw / Math.max(1, bh) < 2) return false;
      return true;
    };
    const blobs = findColorBlobs(imageData, {
      hueMin: 12, hueMax: 38,
      satMin: 0.55, valMin: 0.4,
      minArea, posFilter
    });
    return blobs[0] || null;
  }

  // ADENA 아이콘: 노랑 (hue 42~62), sat>0.55, val>0.4, x_rel>0.80, y_rel>0.80
  // [v1.4.0+] 검증 결과 ADENA 위치가 yRel 0.86 (인벤토리 슬롯 그리드 중간)
  // 기존 yRel>0.90 너무 엄격 → 0.80으로 완화
  function findAdenaIcon(imageData, w, h) {
    const minArea = Math.max(10, Math.floor(w * h * 0.0002));
    const posFilter = (x, y, bw, bh) => {
      if (x < w * 0.80) return false;
      if (y < h * 0.80) return false;
      const ar = bw / Math.max(1, bh);
      if (ar < 0.5 || ar > 2.0) return false;
      return true;
    };
    const blobs = findColorBlobs(imageData, {
      hueMin: 42, hueMax: 62,
      satMin: 0.55, valMin: 0.4,
      minArea, posFilter
    });
    return blobs[0] || null;
  }

  // =========================================================================
  // 6. Negative Space (황금 해골 프레임) 검증
  // =========================================================================
  /**
   * HP/MP 사이 영역에 갈색-금색 (hue 30~50, sat>0.4) 픽셀이 5%↑ 존재하는지 확인.
   * 채팅 빨강 + 장비 파랑 우연 인접 케이스를 reject 하기 위한 보조 검증.
   */
  function validateNegativeSpace(imageData, hpBar, mpBar) {
    if (!hpBar || !mpBar) return false;
    const xStart = hpBar.x + hpBar.width;
    const xEnd = mpBar.x;
    if (xEnd <= xStart) return false;
    const yStart = Math.min(hpBar.y, mpBar.y);
    const yEnd = Math.max(hpBar.y + hpBar.height, mpBar.y + mpBar.height);
    if (yEnd <= yStart) return false;

    const { width: w, data } = imageData;
    let total = 0;
    let hit = 0;
    for (let y = yStart; y < yEnd; y++) {
      for (let x = xStart; x < xEnd; x++) {
        const di = (y * w + x) * 4;
        const hsv = rgbToHsv(data[di], data[di + 1], data[di + 2]);
        total++;
        if (hsv.h >= 30 && hsv.h <= 50 && hsv.s >= 0.4) hit++;
      }
    }
    if (total === 0) return false;
    // [v1.4.0+] 5% → 3%로 완화 (사용자 게임 클라이언트 황금 프레임 채도 다양)
    return (hit / total) >= 0.03;
  }

  // =========================================================================
  // 7. Anchor → 텍스트 ROI 도출 (SPEC rev1 정확한 식)
  // =========================================================================
  function deriveTextROIs(anchors, frameW, frameH) {
    const { hpBar, mpBar, expBar, adenaIcon } = anchors;
    const rois = {};

    if (mpBar) {
      // mpTextROI: mpBar 영역 그대로 + 좌측 5px padding
      rois.mp = {
        x: Math.round(mpBar.x + 5),
        y: Math.round(mpBar.y),
        width: Math.round(Math.max(0, mpBar.width - 5)),
        height: Math.round(mpBar.height)
      };
    }

    if (expBar) {
      // expTextROI: expBar 위 같은 라인 우측 절반
      rois.exp = {
        x: Math.round(expBar.x + expBar.width * 0.45),
        y: Math.round(expBar.y),
        width: Math.round(expBar.width * 0.55),
        height: Math.round(expBar.height)
      };
      // levelTextROI: expBar 위 같은 라인 좌측 40%
      rois.level = {
        x: Math.round(expBar.x),
        y: Math.round(expBar.y),
        width: Math.round(expBar.width * 0.4),
        height: Math.round(expBar.height)
      };
    }

    if (adenaIcon) {
      // adenaTextROI: adenaIcon 우측
      // [v1.4.0+] 사용자 진단 (2026-05-05T13-07-29): gameRegion 우측 끝이 ADENA 아이콘 직후로 끝나는 경우
      //   frameW * 0.06 (76px)이 우측 클램프로 16px만 남음 → OCR "5"만 인식
      //   해결: width를 icon 기준(2.5배 또는 최소 90px)으로 결정 + 우측 클램프 면제 (consumer는 모니터 캡처 사용)
      rois.adena = {
        x: Math.round(adenaIcon.x + adenaIcon.width + frameW * 0.005),
        y: Math.round(adenaIcon.y + adenaIcon.height * 0.1),
        width: Math.max(90, Math.round(adenaIcon.width * 2.5)),
        height: Math.round(adenaIcon.height * 0.8)
      };
    }

    // 경계 클램프 — ADENA는 우측 overflow 허용 (gameRegion 외부도 captureStream에 있음)
    for (const k of Object.keys(rois)) {
      const r = rois[k];
      if (r.x < 0) { r.width += r.x; r.x = 0; }
      if (r.y < 0) { r.height += r.y; r.y = 0; }
      if (k !== 'adena' && r.x + r.width > frameW) r.width = frameW - r.x;
      if (r.y + r.height > frameH) r.height = frameH - r.y;
      if (r.width < 0) r.width = 0;
      if (r.height < 0) r.height = 0;
    }

    return rois;
  }

  // =========================================================================
  // 8. ROI 검증
  // =========================================================================
  function validateROIs(rois, anchors, frameW, frameH) {
    const issues = [];

    const checkRoi = (name, r) => {
      if (!r) { issues.push(`${name} ROI 누락`); return false; }
      if (r.width <= 10 || r.height <= 5) {
        issues.push(`${name} ROI 너무 작음 (${r.width}x${r.height})`);
        return false;
      }
      // [v1.4.0+] ADENA는 우측 overflow 허용 (consumer가 모니터 캡처 사용 — gameRegion 우측 외부 OK)
      const rightOver = (r.x + r.width > frameW) && name !== 'adena';
      if (r.x < 0 || r.y < 0 || rightOver || r.y + r.height > frameH) {
        issues.push(`${name} ROI 경계 초과`);
        return false;
      }
      return true;
    };

    const okMp = checkRoi('mp', rois.mp);
    const okExp = checkRoi('exp', rois.exp);
    checkRoi('level', rois.level);
    const okAdena = checkRoi('adena', rois.adena);

    // cross-check
    const { hpBar, mpBar, expBar, adenaIcon } = anchors;
    if (hpBar && mpBar) {
      if (mpBar.x <= hpBar.x + hpBar.width) {
        issues.push('MP 바가 HP 바 우측에 있지 않음');
      }
    }
    if (hpBar && expBar) {
      if (expBar.y <= hpBar.y) {
        issues.push('EXP 바가 HP 바보다 위에 있음');
      }
    }
    if (expBar && adenaIcon && rois.exp && rois.adena) {
      if (rois.adena.x <= rois.exp.x) {
        issues.push('ADENA가 EXP 좌측에 있음');
      }
    }

    return { valid: issues.length === 0, issues, okMp, okExp, okAdena };
  }

  // =========================================================================
  // 9. 메인 진입점
  // =========================================================================
  /**
   * @param {HTMLCanvasElement|ImageData} input — canvas 또는 ImageData 직접 입력
   * @returns {{anchors,textROIs,valid,issues}}
   */
  function detectGameUI(input) {
    let imageData;
    if (input && typeof input.getContext === 'function') {
      const ctx = input.getContext('2d');
      imageData = ctx.getImageData(0, 0, input.width, input.height);
    } else if (input && input.data && typeof input.width === 'number') {
      imageData = input;
    } else {
      return {
        anchors: {},
        textROIs: {},
        valid: false,
        issues: ['유효한 canvas 또는 ImageData 아님']
      };
    }

    const w = imageData.width;
    const h = imageData.height;
    const issues = [];

    const hpBar = findHpBar(imageData, w, h);
    if (!hpBar) issues.push('HP 바 미탐지 (빨강)');

    const mpBar = findMpBar(imageData, w, h, hpBar);
    if (!mpBar) issues.push('MP 바 미탐지 (파랑)');

    const expBar = findExpBar(imageData, w, h);
    if (!expBar) issues.push('EXP 바 미탐지 (오렌지)');

    const adenaIcon = findAdenaIcon(imageData, w, h);
    if (!adenaIcon) issues.push('ADENA 아이콘 미탐지 (노랑)');

    // negative space 검증 (HP/MP 모두 있을 때만)
    if (hpBar && mpBar) {
      if (!validateNegativeSpace(imageData, hpBar, mpBar)) {
        issues.push('HP/MP 사이 황금 프레임 미확인 (false positive 가능)');
      }
    }

    const anchors = { hpBar, mpBar, expBar, adenaIcon };
    const textROIs = deriveTextROIs(anchors, w, h);
    const validation = validateROIs(textROIs, anchors, w, h);
    issues.push(...validation.issues);

    return {
      anchors,
      textROIs,
      valid: !!(validation.valid && hpBar && mpBar && expBar && adenaIcon),
      issues
    };
  }

  // =========================================================================
  // Export
  // =========================================================================
  const RoiDetector = {
    detectGameUI,
    // 디버그/테스트용 export
    rgbToHsv,
    findColorBlobs,
    findHpBar,
    findMpBar,
    findExpBar,
    findAdenaIcon,
    validateNegativeSpace,
    deriveTextROIs,
    validateROIs
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RoiDetector;
  } else {
    global.RoiDetector = RoiDetector;
  }
})(typeof window !== 'undefined' ? window : globalThis);
