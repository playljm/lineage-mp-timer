#!/usr/bin/env node
// v2 enhanced voting: paddle dominant + temporal coherence + 자릿수 sanity
//
// 사용:
//   node scripts/wsl-tesseract-vote-v2.js [--dry-run]
//
// 동작:
//   1. _pending + _rejected_voting 의 PNG 모두 검토
//   2. lineage_ocr_batch TSV 결과 활용 (이전 batch OCR)
//   3. v2 알고리즘:
//      a) paddle dominant — paddle 결과 sane + tess 무효 → paddle 채택
//      b) tess majority — tess 3 ensemble 중 2개 이상 일치 + sane → 채택
//      c) paddle/tess 자릿수 일치 — 자릿수 같으면 더 신뢰
//      d) paddle vs tess 정수부 일치 → 채택 (소수부 confusion 허용)
//   4. 채택분 → training-data/{region}/ 본 폴더 + .gt.txt
//   5. _rejected_voting의 채택 PNG는 다시 본 폴더로 복원

'use strict';
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const OCR_OUT = path.join(process.env.LOCALAPPDATA, 'Temp', 'lineage_ocr_batch');
const TRAINING = path.join(process.env.APPDATA, 'LineageMPTimer', 'training-data');
const PENDING = path.join(TRAINING, '_pending');
const REJECTED_V1 = path.join(TRAINING, '_rejected_voting');

function normalize(s, region) {
  if (!s) return null;
  s = String(s).trim().replace(/[\s_'":;|]/g, '');
  if (!s) return null;
  if (region === 'mp') {
    const m = s.match(/^(\d+)\/(\d+)$/);
    if (!m) return null;
    const cur = parseInt(m[1], 10);
    const max = parseInt(m[2], 10);
    if (cur > max) return null;
    if (max < 50 || max > 999) return null;  // [v2] 완화: 50~999 (235/242 이외도 허용)
    return `${cur}/${max}`;
  }
  if (region === 'exp') {
    s = s.replace(/,/g, '.').replace(/\.+$/, '').replace(/^\.+/, '');
    if (!/^\d+\.\d+$/.test(s)) return null;
    const [intStr, decStr] = s.split('.');
    const intPart = parseInt(intStr, 10);
    if (intPart >= 100) return null;
    if (decStr.length < 1 || decStr.length > 6) return null;
    return s;
  }
  if (region === 'adena') {
    const tokens = s.split(/[^\d]+/).filter(t => t.length >= 3 && t.length <= 7);
    if (!tokens.length) return null;
    tokens.sort((a, b) => b.length - a.length);
    return tokens[0];
  }
  return null;
}

function digitCount(s, region) {
  if (region === 'adena') return s.length;
  if (region === 'exp') return s.split('.')[0].length;
  if (region === 'mp') {
    const m = s.match(/^(\d+)\/(\d+)$/);
    return m ? m[1].length : 0;
  }
  return 0;
}

// v2 vote algorithm
function voteV2(p7, p8, p13, ocrsugg, region) {
  const tessRaw = [p7, p8, p13];
  const tessNorm = tessRaw.map(s => normalize(s, region));
  const paddleNorm = normalize(ocrsugg, region);

  // tess 3개 다수결 (만장일치 또는 2/3)
  const tessCnt = {};
  for (const t of tessNorm) if (t) tessCnt[t] = (tessCnt[t] || 0) + 1;
  const tessSorted = Object.entries(tessCnt).sort((a, b) => b[1] - a[1]);
  const tessTop = tessSorted[0] || [null, 0];
  const tessTopVal = tessTop[0];
  const tessTopFreq = tessTop[1];

  // 1. 만장일치 (paddle + tess 3 모두 일치)
  if (paddleNorm && tessTopFreq === 3 && paddleNorm === tessTopVal) {
    return { label: paddleNorm, reason: 'unanimous_4', confidence: 100 };
  }

  // 2. tess 3 합의 (만장일치 paddle 다름) → tess 채택
  if (tessTopFreq === 3) {
    return { label: tessTopVal, reason: 'tess_unanimous_3', confidence: 90 };
  }

  // 3. paddle + tess 2/3 일치 → 채택
  if (paddleNorm && tessTopFreq === 2 && paddleNorm === tessTopVal) {
    return { label: paddleNorm, reason: 'paddle_plus_tess2', confidence: 85 };
  }

  // 4. tess 2/3 일치 + paddle 무효 → tess 채택
  if (tessTopFreq === 2 && !paddleNorm) {
    return { label: tessTopVal, reason: 'tess2_paddle_none', confidence: 75 };
  }

  // 5. [v2 NEW] paddle + tess 자릿수 일치 (값 다름) — 자릿수 dominant
  //    paddle "67144" + tess "17144" 같은 케이스 — 둘 다 5자리, 정수부 일치, 소수부 confusion만
  //    paddle dominant heuristic 적용
  if (paddleNorm && tessTopFreq >= 1) {
    const pDig = digitCount(paddleNorm, region);
    const tDig = digitCount(tessTopVal, region);
    if (pDig === tDig && pDig >= 3) {
      // [v2] paddle은 일반적으로 자연 이미지에 강함 — paddle 우선
      return { label: paddleNorm, reason: 'paddle_dominant_digit_match', confidence: 70 };
    }
  }

  // 6. [v2 NEW] paddle 단독 sane (tess 모두 무효) → paddle 채택 (이전엔 폐기)
  if (paddleNorm && tessNorm.every(t => !t)) {
    return { label: paddleNorm, reason: 'paddle_only_sane', confidence: 65 };
  }

  // 7. paddle/tess 둘 다 무효
  if (!paddleNorm && tessTopFreq < 2) {
    return { label: null, reason: 'no_valid', confidence: 0 };
  }

  // 8. 2-2 split (paddle vs tess majority 다름) → 폐기 (학습 노이즈)
  return { label: null, reason: 'split_rejected', confidence: 0 };
}

function safeLabel(s) {
  return String(s || '')
    .replace(/\//g, 'of')
    .replace(/\./g, 'p')
    .replace(/[^0-9A-Za-z_-]/g, '_')
    .slice(0, 32) || 'unlabeled';
}

function main() {
  const stats = { total: 0, byRegion: {}, byReason: {} };

  for (const region of ['mp', 'exp', 'adena']) {
    stats.byRegion[region] = { accepted: 0, rejected: 0, restored: 0, total: 0 };
    const tsvPath = path.join(OCR_OUT, `${region}_results.tsv`);
    if (!fs.existsSync(tsvPath)) {
      console.warn(`[${region}] TSV not found: ${tsvPath} — skip`);
      continue;
    }
    const lines = fs.readFileSync(tsvPath, 'utf8').trim().split('\n');
    stats.byRegion[region].total = lines.length;

    for (const line of lines) {
      const [base, ocrsugg, ensemble] = line.split('\t');
      if (!base) continue;
      const [p7, p8, p13] = (ensemble || '').split('|');
      const result = voteV2(p7, p8, p13, ocrsugg, region);
      stats.byReason[result.reason] = (stats.byReason[result.reason] || 0) + 1;

      if (result.label) {
        // PNG 위치 찾기 (_pending 또는 _rejected_voting)
        const candidates = [
          path.join(PENDING, region, `${base}.png`),
          path.join(REJECTED_V1, region, `${base}.png`)
        ];
        const srcPng = candidates.find(p => fs.existsSync(p));
        if (!srcPng) continue;

        const srcJson = srcPng.replace(/\.png$/, '.json');
        const dstDir = path.join(TRAINING, region);
        const labelSafe = safeLabel(result.label);
        const dstBase = `${labelSafe}__${base.split('_').slice(-3).join('_')}_v2`;
        const dstPng = path.join(dstDir, `${dstBase}.png`);
        const dstGt = path.join(dstDir, `${dstBase}.gt.txt`);

        if (DRY_RUN) {
          console.log(`[${region}] ${base} → ${result.label} (${result.reason}, conf ${result.confidence})`);
        } else {
          if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
          fs.copyFileSync(srcPng, dstPng);
          fs.writeFileSync(dstGt, result.label, 'utf8');
          // 원본 삭제 (_pending 또는 _rejected_voting에서)
          try { fs.unlinkSync(srcPng); } catch (_) {}
          if (fs.existsSync(srcJson)) try { fs.unlinkSync(srcJson); } catch (_) {}
          if (srcPng.includes('_rejected_voting')) stats.byRegion[region].restored++;
          stats.byRegion[region].accepted++;
        }
      } else {
        stats.byRegion[region].rejected++;
      }
    }
  }

  stats.total = Object.values(stats.byRegion).reduce((s, r) => s + r.accepted, 0);

  console.log('\n===== v2 Voting Results =====');
  console.log(JSON.stringify(stats.byRegion, null, 2));
  console.log('\n===== Reasons =====');
  console.log(JSON.stringify(stats.byReason, null, 2));
  const totalProcessed = Object.values(stats.byRegion).reduce((s, r) => s + r.total, 0);
  const acc = totalProcessed > 0 ? (stats.total / totalProcessed * 100).toFixed(1) : '0';
  console.log(`\nTotal: accepted=${stats.total}, processed=${totalProcessed}, acceptance=${acc}%`);
}

main();
