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
  // [v1.4.0+] 사용자 진단 (2026-05-06T12-27-50): "EXP 바가 HP 바보다 위에 있음" — 파티 멤버 HP 바
  //   채팅 빨간 텍스트 등 다른 빨간 객체가 HP로 잡혀 layout 검증 실패. 단일 best 대신 candidates 반환
  //   detectGameUI가 HP×EXP×ADENA combinatorial로 layout-consistent tuple 선택.
  function findHpBarCandidates(imageData, w, h) {
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
    // 가로로 긴 (width/height > 3) 후보 먼저, 그 외는 fallback (area DESC 유지)
    const wide = blobs.filter((b) => b.width / b.height > 3);
    const rest = blobs.filter((b) => b.width / b.height <= 3);
    return wide.concat(rest);
  }
  function findHpBar(imageData, w, h) {
    return findHpBarCandidates(imageData, w, h)[0] || null;
  }

  // MP 바: 파랑 (hue 200~245), sat>0.20, val>0.30
  // [v1.4.0+] 검증 결과 진짜 MP 바는 어두운 회색-파랑 — 임계값 더 관대하게
  // HP 기준 인접: y ∈ [hp.y-30, hp.y+30+hp.h], x > hp.x + hp.w + w*0.03
  function findMpBarCandidates(imageData, w, h, hpBar) {
    if (!hpBar) return [];
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
    // 채도 너무 높은 (선명한 순수 파랑/보라 = UI 강조 아이콘) 후순위 — 진짜 MP 바는 sat<=0.85
    const calm = blobs.filter((b) => b.avgSat <= 0.85);
    const sharp = blobs.filter((b) => b.avgSat > 0.85);
    return calm.concat(sharp);
  }
  function findMpBar(imageData, w, h, hpBar) {
    return findMpBarCandidates(imageData, w, h, hpBar)[0] || null;
  }

  // EXP 바: 오렌지 (hue 12~38), sat>0.55, val>0.4, x_rel<0.30, y_rel ∈ [0.65, 0.95]
  // [v1.4.0+] 검증 결과 사용자 게임 EXP 바는 hue 28 (더 노랑 톤), 위치도 yRel 0.76 부근
  // 기존 hue 15-25 + yRel 0.76-0.88 너무 엄격 → 완화
  function findExpBarCandidates(imageData, w, h) {
    const minArea = Math.max(15, Math.floor(w * h * 0.0005));
    const posFilter = (x, y, bw, bh) => {
      if (x > w * 0.30) return false;
      if (y < h * 0.65 || y > h * 0.95) return false;
      if (bw / Math.max(1, bh) < 2) return false;
      // [v1.5.1 fix] expBar 절대 최소 width — 너무 짧은 orange element는 expBar 아님
      //   사용자 진단 2026-05-07T15-11-42 (v1.5.0): width=58 후보가 expBar로 잘못 채택 → EXP/LEVEL textROI 모두 LV.29 박스 잡음
      //   정상 expBar는 width>=80 (보통 100~250)
      if (bw < 80) return false;
      return true;
    };
    const blobs = findColorBlobs(imageData, {
      hueMin: 12, hueMax: 38,
      satMin: 0.55, valMin: 0.4,
      minArea, posFilter
    });
    // [v1.5.4 fix] 진짜 EXP 진행 막대(얇은 가로 막대)와 텍스트 글자(LEV:29 같은 노란 텍스트)를 구분.
    //   사용자 진단 (2026-05-08T12-58-41 + 게임 스크린샷): EXP 진행 막대가 없는 게임 UI에서
    //   "LEV:29" 노란/오렌지 텍스트가 expBar로 false-positive 채택 (width 85, height 26, aspect 3.27).
    //   진짜 EXP 진행 막대 aspect 보통 5+ 이상 (얇고 김), 텍스트 글자는 보통 4 미만.
    //   해결: aspect>=5 + height<=12 후보 우선, 그 외(텍스트 의심)는 후순위.
    //   완전 reject 아닌 후순위 — 일부 게임 UI는 두꺼운 막대 가능성 보존.
    const slim = blobs.filter((b) => (b.width / Math.max(1, b.height) >= 5) && b.height <= 12);
    const thick = blobs.filter((b) => !((b.width / Math.max(1, b.height) >= 5) && b.height <= 12));
    return slim.concat(thick);
  }
  function findExpBar(imageData, w, h) {
    return findExpBarCandidates(imageData, w, h)[0] || null;
  }

  // ADENA 아이콘: 노랑 (hue 42~62), sat>0.55, val>0.4, x_rel>0.80, y_rel>0.80
  // [v1.4.0+] 검증 결과 ADENA 위치가 yRel 0.86 (인벤토리 슬롯 그리드 중간)
  // 기존 yRel>0.90 너무 엄격 → 0.80으로 완화
  function findAdenaIconCandidates(imageData, w, h) {
    const minArea = Math.max(10, Math.floor(w * h * 0.0002));
    const posFilter = (x, y, bw, bh) => {
      if (x < w * 0.80) return false;
      if (y < h * 0.80) return false;
      const ar = bw / Math.max(1, bh);
      if (ar < 0.5 || ar > 2.0) return false;
      return true;
    };
    return findColorBlobs(imageData, {
      hueMin: 42, hueMax: 62,
      satMin: 0.55, valMin: 0.4,
      minArea, posFilter
    });
  }
  function findAdenaIcon(imageData, w, h) {
    return findAdenaIconCandidates(imageData, w, h)[0] || null;
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
  // [v1.4.0+] ink density (edge pixel ratio) — 디지트 클러스터 자동 감지용
  //   인접 픽셀 휘도 차이가 큰 픽셀 비율 = 텍스트/edge 밀도
  //   균일한 검정/배경: 낮은 비율 / 디지트가 있는 영역: 높은 비율
  function inkScore(imageData, x, y, w, h) {
    if (!imageData || !imageData.data) return 0;
    const data = imageData.data;
    const fw = imageData.width;
    const fh = imageData.height;
    const xMin = Math.max(0, Math.floor(x));
    const yMin = Math.max(0, Math.floor(y));
    const xMax = Math.min(fw - 1, Math.floor(x + w));
    const yMax = Math.min(fh - 1, Math.floor(y + h));
    let edges = 0;
    let total = 0;
    for (let yy = yMin; yy < yMax; yy++) {
      for (let xx = xMin; xx < xMax; xx++) {
        const i = (yy * fw + xx) * 4;
        const lumC = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const lumR = (data[i + 4] + data[i + 5] + data[i + 6]) / 3;
        if (Math.abs(lumC - lumR) > 25) edges++;
        total++;
      }
    }
    return total > 0 ? edges / total : 0;
  }

  // [v1.4.0+] 사용자 진단 (2026-05-06T13-37-58 + 픽셀 분석):
  //   EXP가 0%에 가까우면 진행 막대가 거의 안 채워져 자동 탐지가 다른 객체를 EXP로 오인.
  //   해결: LV 텍스트 자체를 검출하여 막대 의존도 제거.
  // 좌측 미니 패널 영역에서 흰/베이지 픽셀 가로 라인을 검출하여 첫 번째 라인의
  // 좌측(LEV) + 우측(EXP%) cluster bounding box 반환.
  function findLevelTextLines(imageData, frameW, frameH) {
    if (!imageData || !imageData.data) return [];
    const data = imageData.data;
    const fw = imageData.width;
    const xMin = 0;
    const xMax = Math.floor(frameW * 0.20);
    const yMin = Math.floor(frameH * 0.75);
    const yMax = Math.floor(frameH * 0.95);
    const isText = (r, g, b) => {
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const lum = (r + g + b) / 3;
      const sat = max === 0 ? 0 : (max - min) / max;
      return lum > 180 && sat < 0.35;
    };
    // 행별 텍스트 픽셀 수
    const rowCounts = [];
    for (let y = yMin; y < yMax; y++) {
      let count = 0;
      for (let x = xMin; x < xMax; x++) {
        const i = (y * fw + x) * 4;
        if (isText(data[i], data[i+1], data[i+2])) count++;
      }
      rowCounts.push({ y, count });
    }
    // 텍스트 라인 그룹화 (count >= 15 + 인접 행)
    const lines = [];
    let lineStart = null;
    for (let i = 0; i < rowCounts.length; i++) {
      const c = rowCounts[i].count;
      if (c >= 15 && lineStart === null) lineStart = rowCounts[i].y;
      else if (c < 15 && lineStart !== null) {
        if (rowCounts[i].y - lineStart >= 8) {
          lines.push({ yStart: lineStart, yEnd: rowCounts[i].y - 1, height: rowCounts[i].y - lineStart });
        }
        lineStart = null;
      }
    }
    if (lineStart !== null) {
      const last = rowCounts[rowCounts.length - 1];
      lines.push({ yStart: lineStart, yEnd: last.y, height: last.y - lineStart });
    }
    // 각 라인에서 가로 cluster 검출
    for (const line of lines) {
      const colHits = new Array(xMax - xMin).fill(0);
      for (let y = line.yStart; y <= line.yEnd; y++) {
        for (let x = xMin; x < xMax; x++) {
          const i = (y * fw + x) * 4;
          if (isText(data[i], data[i+1], data[i+2])) colHits[x - xMin]++;
        }
      }
      const minColPixels = Math.max(1, Math.floor(line.height * 0.2));
      const clusters = [];
      let cs = null;
      for (let x = 0; x < colHits.length; x++) {
        if (colHits[x] >= minColPixels) {
          if (cs === null) cs = x;
        } else if (cs !== null) {
          // 글자 사이 작은 gap (3px) 무시
          let gapEnd = -1;
          for (let nx = x + 1; nx <= Math.min(x + 3, colHits.length - 1); nx++) {
            if (colHits[nx] >= minColPixels) { gapEnd = nx; break; }
          }
          if (gapEnd > 0) { x = gapEnd - 1; continue; }
          if (x - cs >= 8) clusters.push({ xStart: cs, xEnd: x - 1, width: x - cs });
          cs = null;
        }
      }
      if (cs !== null && colHits.length - cs >= 8) {
        clusters.push({ xStart: cs, xEnd: colHits.length - 1, width: colHits.length - cs });
      }
      line.clusters = clusters;
    }
    return lines;
  }

  function deriveTextROIs(anchors, frameW, frameH, imageData) {
    const { hpBar, mpBar, expBar, adenaIcon } = anchors;
    const rois = {};

    if (mpBar) {
      // [v1.4.3 fix] MP textROI 폭은 mpBar.width(파란 채워진 부분)에 종속되면 안 됨.
      //   사용자 진단 (2026-05-07T12-09-05 + 게임 화면): MP가 적을수록 게이지 채워짐 폭이 줄어
      //   "MP : 113/242" 텍스트 중 우측 부분이 ROI 밖으로 나가 OCR이 "71" 같은 일부만 인식.
      //   해결: HP textROI 폭(거의 항상 가득찬 게이지 폭) 또는 최소 200px과 max 사용.
      //   게임 디자인상 HP/MP 게이지 영역 폭은 동일.
      const mpFullWidth = Math.max(mpBar.width, hpBar ? hpBar.width : 0, 200);
      rois.mp = {
        x: Math.round(mpBar.x + 5),
        y: Math.round(mpBar.y),
        width: Math.round(Math.max(0, mpFullWidth - 5)),
        height: Math.round(mpBar.height)
      };
    }

    if (expBar) {
      // [v1.4.0+] 사용자 진단 (2026-05-06T13-37-58 + 픽셀 분석):
      //   EXP가 0%에 가까우면 막대 의존 탐지가 노이즈를 EXP로 오인.
      //   해결: 막대가 얇으면(height<12) findLevelTextLines로 좌측 미니 패널의
      //         LV 텍스트 라인을 직접 검출하여 ROI 도출. 막대 두꺼우면 기존 동작.
      const useExpand = expBar.height < 12;
      const expX_bar = Math.round(expBar.x + expBar.width * 0.45);
      // [v1.5.2 fix] expW_bar 최소 50px 보장 — validateROIs sanity (rois.exp.width<50) invalid 차단.
      //   사용자 진단 (2026-05-08T12-21-25): expBar.width=82 → 0.55*82=45.1 → invalid 도배.
      //   정상 expBar(width≥80) 케이스에서도 textROI 부족 가능 → 보정.
      const expW_bar = Math.max(50, Math.round(expBar.width * 0.55));
      const lvlX_bar = Math.round(expBar.x);
      const lvlW_bar = Math.max(30, Math.round(expBar.width * 0.4));
      if (useExpand && imageData) {
        // 1차: LV 텍스트 라인 검출 시도 (좌측 미니 패널)
        const textLines = findLevelTextLines(imageData, frameW, frameH);
        // [v1.5.9 MED-1] 2개 이상 cluster + 충분한 gap (>20px) 검증.
        //   진단 2026-05-08T14-41-55: 좌측 한글 텍스트 cluster들이 모두 인접해 단일 단어로
        //   통합되는 케이스 → 폴백이 LEVEL 영역 재사용 → EXP/LEVEL ROI 겹침.
        //   해결: cluster 사이 최대 gap이 20px 이상인 라인만 정상 layout으로 인정.
        //         미달 시 막대 기반 fallback 분기로 자연 진입.
        const lvLine = textLines.find((l) => {
          if (!l.clusters || l.clusters.length < 2) return false;
          const sorted = l.clusters.slice().sort((a, b) => a.xStart - b.xStart);
          let maxGap = 0;
          for (let i = 1; i < sorted.length; i++) {
            const gap = sorted[i].xStart - sorted[i - 1].xEnd;
            if (gap > maxGap) maxGap = gap;
          }
          return maxGap > 20;
        });
        if (lvLine) {
          const PAD_Y = 4;
          // [v1.8.1] EXP/LEVEL textROI 좌우 padding 4→8 (정수부 "0" 손실 차단)
          //   사용자 진단 (2026-05-10 00:08): EXP "0.6401%" 미리보기에 ".6401%"만 — 정수부 "0" ROI 좌측 밖
          //   좌우 PAD 4→8 → 정수부 1자리 안전 캡처 + 안티앨리어싱 보호 강화
          const PAD_X = 8;
          const y = Math.max(0, lvLine.yStart - PAD_Y);
          const h = Math.min(frameH - y, lvLine.height + PAD_Y * 2);
          // 가장 좌측 cluster = Level, 가장 우측 cluster들의 통합 = EXP%
          const sorted = lvLine.clusters.slice().sort((a, b) => a.xStart - b.xStart);
          const leftMost = sorted[0];
          const rightMost = sorted[sorted.length - 1];
          // Level: 첫 cluster (LEV + 숫자) — 인접한 cluster 통합
          let lvlEnd = sorted[0].xEnd;
          for (let i = 1; i < sorted.length; i++) {
            if (sorted[i].xStart - lvlEnd <= 25) lvlEnd = sorted[i].xEnd;
            else break;
          }
          // EXP%: 우측 cluster들 통합 — Level cluster 끝 이후의 모든 cluster
          // [v1.5.9] cluster 분리 gap 10→20 (보수화). expStart_x 미발견 시 LEVEL cluster
          //   재사용 금지 (이전엔 rightMost.xStart 폴백 → LEVEL과 동일 영역 생성).
          //   진단 2026-05-08T14-41-55: 좌측 한글 텍스트 cluster들이 모두 인접 통합되어
          //   expStart_x=-1 → 폴백이 LEVEL 안 좌표 가리킴 → EXP/LEVEL ROI 영역 겹침.
          //   해결: 미발견 시 rois.exp = null → 호출부에서 region 갱신 skip.
          let expStart_x = -1;
          for (const c of sorted) {
            if (c.xStart > lvlEnd + 20) { expStart_x = c.xStart; break; }
          }
          rois.level = {
            x: Math.max(0, leftMost.xStart - PAD_X),
            y: y,
            width: (lvlEnd - leftMost.xStart) + PAD_X * 2,
            height: h
          };
          if (expStart_x >= 0) {
            rois.exp = {
              x: Math.max(0, expStart_x - PAD_X),
              y: y,
              width: (rightMost.xEnd - expStart_x) + PAD_X * 2,
              height: h
            };
          } else {
            // EXP cluster 분리 실패 — null 반환 (호출부에서 region 갱신 skip + 안내)
            rois.exp = null;
          }
        } else {
          // 2차 fallback: 막대 위/아래 후보 inkScore 검색 (이전 fix)
          const TEXT_H = Math.max(18, Math.round(expBar.height * 4));
          function overlapsHp(roiY, roiH) {
            if (!hpBar) return false;
            return Math.min(roiY + roiH, hpBar.y + hpBar.height) - Math.max(roiY, hpBar.y) > 0;
          }
          const yCands = [];
          const step = Math.max(6, Math.floor(TEXT_H / 3));
          for (let dy = -TEXT_H * 3; dy <= -TEXT_H + 2; dy += step) {
            const y2 = expBar.y + dy;
            if (y2 >= 0 && y2 + TEXT_H <= frameH) yCands.push(y2);
          }
          for (let dy = expBar.height + 1; dy <= TEXT_H * 4; dy += step) {
            const y2 = expBar.y + dy;
            if (y2 >= 0 && y2 + TEXT_H <= frameH) yCands.push(y2);
          }
          let bestY = null, bestScore = -1;
          for (const y of yCands) {
            if (overlapsHp(y, TEXT_H)) continue;
            const s = inkScore(imageData, expX_bar, y, expW_bar, TEXT_H);
            if (s > bestScore) { bestScore = s; bestY = y; }
          }
          if (bestY === null) bestY = Math.max(0, expBar.y - TEXT_H - 1);
          rois.exp   = { x: expX_bar, y: Math.round(bestY), width: expW_bar, height: TEXT_H };
          rois.level = { x: lvlX_bar, y: Math.round(bestY), width: lvlW_bar, height: TEXT_H };
        }
      } else {
        // 막대 두꺼움 — 텍스트 포함 가정, 자체 사용
        // [v1.5.4 fix] 그러나 expBar 후보가 사실 텍스트 글자 자체(예: 노란/오렌지 LV:29 글자)일 수도
        //   사용자 진단 (2026-05-08T12-58-41 + 게임 스크린샷): EXP 진행 막대가 없는 게임 UI에서
        //   "LEV:29" 텍스트 글자가 expBar로 false-positive 채택 → 단순 0.4/0.55 분할이 글자 절단
        //   → LEVEL "LEW" + EXP ":29" misread.
        //   해결: useExpand=false 분기에서도 findLevelTextLines를 먼저 시도하고, 2개 이상 cluster가
        //   잡히고 두 cluster 사이 충분한 gap(>20px)이 있으면 텍스트 라인 기반 ROI 채택.
        //   실패 시 기존 단순 분할로 fallback.
        let usedTextLine = false;
        if (imageData) {
          const textLines = findLevelTextLines(imageData, frameW, frameH);
          // expBar 근처 y 라인 우선 (expBar.y±20px 안에 있는 라인 채택)
          const nearLines = textLines.filter((l) => Math.abs(l.yStart - expBar.y) <= 30);
          const candLine = nearLines.find((l) => l.clusters && l.clusters.length >= 2)
            || textLines.find((l) => l.clusters && l.clusters.length >= 2);
          if (candLine) {
            const sorted = candLine.clusters.slice().sort((a, b) => a.xStart - b.xStart);
            let lvlEnd = sorted[0].xEnd;
            for (let i = 1; i < sorted.length; i++) {
              if (sorted[i].xStart - lvlEnd <= 25) lvlEnd = sorted[i].xEnd;
              else break;
            }
            let expStart_x = -1;
            for (const c of sorted) {
              if (c.xStart > lvlEnd + 20) { expStart_x = c.xStart; break; }
            }
            // gap이 20px 이상 명확히 분리된 케이스에만 채택 — 그 외엔 false split 위험
            if (expStart_x > 0) {
              const PAD_Y = 4, PAD_X = 6;  // [v1.8.1] 2→6 (정수부 "0" 손실 차단)
              const y = Math.max(0, candLine.yStart - PAD_Y);
              const h = Math.min(frameH - y, candLine.height + PAD_Y * 2);
              const rightMost = sorted[sorted.length - 1];
              rois.level = {
                x: Math.max(0, sorted[0].xStart - PAD_X),
                y: y,
                width: (lvlEnd - sorted[0].xStart) + PAD_X * 2,
                height: h
              };
              rois.exp = {
                x: Math.max(0, expStart_x - PAD_X),
                y: y,
                width: (rightMost.xEnd - expStart_x) + PAD_X * 2,
                height: h
              };
              usedTextLine = true;
            }
          }
        }
        if (!usedTextLine) {
          rois.exp   = { x: expX_bar, y: Math.round(expBar.y), width: expW_bar, height: Math.round(expBar.height) };
          rois.level = { x: lvlX_bar, y: Math.round(expBar.y), width: lvlW_bar, height: Math.round(expBar.height) };
        }
      }
    }

    if (adenaIcon) {
      // [v1.4.0+] 가로 / 세로 레이아웃 자동 감지 (사용자 진단 2026-05-05T13-39-30)
      //   가로: [icon][digits]   — 일반적
      //   세로: [icon] / [digits] — 일부 사용자 UI (digits이 icon 아래)
      //   해결: 두 후보 영역의 ink density (edge pixel 비율) 비교
      //         below가 right 대비 명확히(1.3배) 더 텍스트 같으면 세로 채택, 아니면 가로 default
      // [v1.5.8] 5자리+콤마(22,974) 보장을 위해 belowCand 최소폭 50→80 상향.
      //   진단 2026-05-08T14-05-41: 5자리 ADENA를 width 64px ROI(클램프됨)로 잡아
      //   "22,974"를 "2,274"로 자릿수 손실 misread. rightCand는 이미 90 보장.
      // [v1.5.11] 사용자 진단 2026-05-08T15-28-12: 게임 영역 우측 가장자리에서 frame 클램프 심각.
      //   사용자 요청 "중앙으로 잡아라" — rightCand x 시작점을 아이콘 끝(+3)에서 아이콘 중심(0.5)으로
      //   이동 → 동일 frameW에서 우측 여유 ~2배 확보. 5자리 콤마없음(39517) 환경 OCR 가능.
      const rightCand = {
        x: Math.round(adenaIcon.x + adenaIcon.width * 0.5),
        y: Math.round(adenaIcon.y + adenaIcon.height * 0.1),
        width: Math.max(100, Math.round(adenaIcon.width * 2.8)),
        height: Math.round(adenaIcon.height * 0.8)
      };
      // [v1.6.4] belowCand height 축소 — 글자 한 줄만 (다음 UI 라인 제외)
      //   v1.6.3 height *0.75 (=23px) → 사용자 스크린샷 (2026-05-09 20:59): 미리보기에 글자 + 가로선 잔상
      //   원인: 글자 ~14px + 9px 여유 → ROI 안에 다음 UI 라인의 가로 노이즈도 포함
      //   해결: y *0.88→*0.83 (윗쪽 1.5px 더 확보) + height *0.75→*0.55 (~17px, 글자 + 위아래 2px)
      //   x는 -20 유지 (좌측 시프트 효과적)
      const belowCand = {
        x: Math.max(0, Math.round(adenaIcon.x - 20)),
        y: Math.round(adenaIcon.y + adenaIcon.height * 0.83),
        width: Math.max(100, Math.round(adenaIcon.width * 2.8)),
        height: Math.max(18, Math.round(adenaIcon.height * 0.55))
      };
      let chosen = rightCand;
      if (imageData) {
        const rs = inkScore(imageData, rightCand.x, rightCand.y, rightCand.width, rightCand.height);
        const bs = inkScore(imageData, belowCand.x, belowCand.y, belowCand.width, belowCand.height);
        if (bs > rs * 1.3) chosen = belowCand;
      }
      rois.adena = chosen;
    }

    // 경계 클램프 — 모든 ROI를 frameW로 클램프
    // [v1.4.2 fix] 사용자 진단 (2026-05-07T08-17-51): 게임창이 모니터 우측 가장자리에 가까이 있어
    //   ADENA textROI 우측 100px이 모니터 밖 = 캡처 검정 픽셀 → OCR "???" 실패.
    //   v1.4.0 b20407a "ADENA 우측 overflow 허용" 가정(captureStream이 모니터 전체)이
    //   듀얼 모니터 / 우측 가장자리 게임창 환경에선 깨짐. 모든 ROI를 frameW로 클램프하고
    //   ADENA는 width<50px이 되면 별도 issue로 사용자에게 게임 영역 확장 안내.
    // [v1.5.8] 클램프 발생 사실을 _clipped/_intendedWidth로 기록 → validateROIs에서
    //   "단순 폭 부족"과 "frame 경계 초과로 잘림"을 구분해 명시 메시지 출력.
    for (const k of Object.keys(rois)) {
      const r = rois[k];
      // [v1.5.9] rois.exp 가 null 일 수 있음 (cluster 분리 실패) — skip
      if (!r) continue;
      const intendedWidth = r.width;
      const intendedHeight = r.height;
      if (r.x < 0) { r.width += r.x; r.x = 0; }
      if (r.y < 0) { r.height += r.y; r.y = 0; }
      if (r.x + r.width > frameW) r.width = frameW - r.x;
      if (r.y + r.height > frameH) r.height = frameH - r.y;
      if (r.width < 0) r.width = 0;
      if (r.height < 0) r.height = 0;
      if (r.width < intendedWidth || r.height < intendedHeight) {
        r._clipped = true;
        r._intendedWidth = intendedWidth;
        r._intendedHeight = intendedHeight;
      }
    }

    return rois;
  }

  // =========================================================================
  // 8. ROI 검증
  // =========================================================================
  function validateROIs(rois, anchors, frameW, frameH) {
    const issues = [];
    const adenaOnlyIssues = [];

    const checkRoi = (name, r) => {
      const push = (msg) => {
        if (name === 'adena') adenaOnlyIssues.push(msg);
        else issues.push(msg);
      };
      if (!r) { push(`${name} ROI 누락`); return false; }
      if (r.width <= 10 || r.height <= 5) {
        push(`${name} ROI 너무 작음 (${r.width}x${r.height})`);
        return false;
      }
      // [v1.4.2 fix] 모든 ROI는 frameW 내. ADENA가 frameW 우측 가장자리에 너무 가까워
      //   클램프 후 width가 부족하면 별도 issue (게임 영역 우측 확장 권장).
      if (r.x < 0 || r.y < 0 || r.x + r.width > frameW || r.y + r.height > frameH) {
        push(`${name} ROI 경계 초과`);
        return false;
      }
      // [v1.5.8] 5자리+콤마 ADENA(예: "22,974") 보장. 임계 50→80 상향.
      //   _clipped 플래그가 있으면 "frame 경계로 잘림" 명시 메시지 (정확한 확장 폭 안내).
      // [v1.5.11] 사용자 환경(콤마없음 5자리 "39517")에서 60~70px도 OCR 가능 → 임계 80→50 완화.
      //   콤마있는 6자리 "22,974" 케이스는 _clipped 메시지로 별도 안내.
      if (name === 'adena' && r.width < 50) {
        if (r._clipped && r._intendedWidth) {
          const need = r._intendedWidth - r.width + 10;
          adenaOnlyIssues.push(`ADENA ROI 우측 클램프 (의도 ${r._intendedWidth}px → ${r.width}px) — 게임 영역을 우측으로 ${need}px 이상 확장해주세요`);
        } else {
          adenaOnlyIssues.push(`ADENA ROI 폭 부족 (${r.width}px<50) — 게임 영역을 우측으로 넓게 다시 지정해주세요`);
        }
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
      // [v1.4.0+] 사용자 진단 (2026-05-06T12-41-26): 진짜 사용자 게임에서 EXP 바가 HP 바 8px 위에 있음.
      //   캐릭터 정보 패널 layout(EXP 위, HP/MP 아래)도 표준 리니지 클래식 UI의 한 형태.
      //   기존 "EXP가 HP 아래" 절대 가정은 잘못 — 같은 패널 안 인접도로 완화.
      const yDist = Math.abs(expBar.y - hpBar.y);
      const tolerance = (hpBar.height + expBar.height) * 4 + 30;
      if (yDist > tolerance) {
        issues.push(`EXP 바가 HP 바와 너무 멀리 있음 (${yDist}px > ${tolerance}px)`);
      }
    }
    if (expBar && adenaIcon && rois.exp && rois.adena) {
      if (rois.adena.x <= rois.exp.x) {
        issues.push('ADENA가 EXP 좌측에 있음');
      }
    }

    // [v1.5.1 fix] expBar width sanity — 너무 짧으면 다른 orange element 오인 가능성
    //   사용자 진단 2026-05-07T15-11-42 (v1.5.0): expBar.width=58px → EXP textROI w=32, LEVEL textROI w=23
    //   결과: EXP/LEVEL 모두 같은 LV.29 박스 부분만 분리해서 캡처 → OCR catastrophic.
    //   정상 expBar는 width>=80 (보통 100~250). 너무 작으면 invalid 처리해 cache 재탐지 유도.
    if (expBar && expBar.width < 80) {
      issues.push(`expBar 후보 너무 짧음 (${expBar.width}px<80) — orange element 오인 가능성`);
    }
    // EXP/LEVEL textROI width 최소 — expBar.width의 0.4/0.55 비율로 도출되므로 expBar 검증 보완
    if (rois.exp && rois.exp.width < 50) {
      issues.push(`EXP textROI 폭 너무 좁음 (${rois.exp.width}px<50)`);
    }
    if (rois.level && rois.level.width < 30) {
      issues.push(`LEVEL textROI 폭 너무 좁음 (${rois.level.width}px<30)`);
    }

    // [v1.4.2 fix] ADENA 단독 issue(폭 부족 등)는 valid에 영향 X — MP/EXP/LEVEL은 정상 사용 가능.
    //   호출자(app.js ensureAutoModeROIs)는 result.okAdena=false면 ADENA region만 비우고
    //   나머지 ROI는 그대로 사용. 사용자에게는 throttled 안내.
    return {
      valid: issues.length === 0,
      issues: [...issues, ...adenaOnlyIssues],
      adenaIssues: adenaOnlyIssues,
      okMp, okExp, okAdena
    };
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

    // [v1.4.0+] 사용자 진단 (2026-05-06T12-27-50): 단일 best 후보로는 파티 HP 바/채팅 빨간 텍스트 등
    //   비표준 UI 요소가 HP로 오인되어 layout 검증 실패. Multi-candidate combinatorial search로 강화.
    //   각 anchor의 top-K 후보를 가져와 layout-consistent tuple 첫 번째를 채택.
    const HP_TOP = 5, EXP_TOP = 5, ADENA_TOP = 5, MP_TOP = 3;
    const hpCands = findHpBarCandidates(imageData, w, h).slice(0, HP_TOP);
    const expCands = findExpBarCandidates(imageData, w, h).slice(0, EXP_TOP);
    const adenaCands = findAdenaIconCandidates(imageData, w, h).slice(0, ADENA_TOP);

    if (hpCands.length === 0) issues.push('HP 바 미탐지 (빨강)');
    if (expCands.length === 0) issues.push('EXP 바 미탐지 (오렌지)');
    if (adenaCands.length === 0) issues.push('ADENA 아이콘 미탐지 (노랑)');

    // Combinatorial layout 검증 — 첫 통과 tuple 채택
    let chosenHp = null, chosenMp = null, chosenExp = null, chosenAdena = null;
    let triedCombos = 0;
    outer:
    for (const hp of hpCands) {
      const mpCands = findMpBarCandidates(imageData, w, h, hp).slice(0, MP_TOP);
      for (const exp of expCands) {
        // [v1.4.0+] EXP 는 HP 위/아래 둘 다 valid (사용자 캐릭터 정보 패널 layout) — 인접도만 검증
        const yDist = Math.abs(exp.y - hp.y);
        const yTolerance = (hp.height + exp.height) * 4 + 30;
        if (yDist > yTolerance) continue;
        for (const mp of mpCands) {
          if (mp.x <= hp.x + hp.width) continue; // MP 는 HP 우측
          if (!validateNegativeSpace(imageData, hp, mp)) continue; // 황금 프레임 검증
          // ADENA: rois 좌표 기준 검증 — exp ROI 우측에 있어야
          for (const ad of adenaCands) {
            triedCombos++;
            const tentAnchors = { hpBar: hp, mpBar: mp, expBar: exp, adenaIcon: ad };
            const tentROIs = deriveTextROIs(tentAnchors, w, h, imageData);
            if (tentROIs.adena && tentROIs.exp && tentROIs.adena.x > tentROIs.exp.x) {
              chosenHp = hp; chosenMp = mp; chosenExp = exp; chosenAdena = ad;
              break outer;
            }
          }
        }
      }
    }

    // 통과 tuple 없으면 fallback — 기존 동작 유지 + 진단용 issue 기록
    if (!chosenHp) chosenHp = hpCands[0] || null;
    if (!chosenExp) chosenExp = expCands[0] || null;
    if (!chosenAdena) chosenAdena = adenaCands[0] || null;
    if (!chosenMp && chosenHp) {
      chosenMp = findMpBarCandidates(imageData, w, h, chosenHp)[0] || null;
    }
    if (!chosenMp) issues.push('MP 바 미탐지 (파랑)');

    // 통과 tuple 있었나? layout 모든 조건 만족 시 true
    const tupleFound = !!(chosenHp && chosenMp && chosenExp && chosenAdena
      && Math.abs(chosenExp.y - chosenHp.y) <= (chosenHp.height + chosenExp.height) * 4 + 30
      && chosenMp.x > chosenHp.x + chosenHp.width
      && validateNegativeSpace(imageData, chosenHp, chosenMp));
    if (!tupleFound && hpCands.length && expCands.length) {
      issues.push(`레이아웃 검증 통과 조합 없음 (HP×EXP×ADENA ${hpCands.length}×${expCands.length}×${adenaCands.length} 시도, ${triedCombos} 조합)`);
    }
    if (!tupleFound && chosenHp && chosenMp && !validateNegativeSpace(imageData, chosenHp, chosenMp)) {
      issues.push('HP/MP 사이 황금 프레임 미확인 (false positive 가능)');
    }

    const anchors = { hpBar: chosenHp, mpBar: chosenMp, expBar: chosenExp, adenaIcon: chosenAdena };
    const textROIs = deriveTextROIs(anchors, w, h, imageData);
    const validation = validateROIs(textROIs, anchors, w, h);
    issues.push(...validation.issues);

    return {
      anchors,
      textROIs,
      valid: !!(validation.valid && chosenHp && chosenMp && chosenExp && chosenAdena),
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
    findHpBarCandidates,
    findMpBar,
    findMpBarCandidates,
    findExpBar,
    findExpBarCandidates,
    findAdenaIcon,
    findAdenaIconCandidates,
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
