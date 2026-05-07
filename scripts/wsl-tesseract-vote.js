#!/usr/bin/env node
// WSL tesseract ensemble 결과 + ocrSuggestion 4-way voting → 자동 라벨링
// 사용:
//   node scripts/wsl-tesseract-vote.js [--dry-run]
//
// 동작:
//   1. /tmp/ocr_batch/{mp,exp,adena}_results.tsv 읽기 (WSL 결과)
//   2. 각 sample 4-way vote (lineage psm7/8/13 + ocrSuggestion)
//   3. 채택: training-data/{region}/ 본 폴더로 이동 + .gt.txt 생성 + _pending 삭제
//   4. 폐기: training-data/_rejected_voting/{region}/ 으로 이동 (보존)

'use strict';
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const OCR_OUT = path.join(process.env.LOCALAPPDATA, 'Temp', 'lineage_ocr_batch');
const TRAINING = path.join(process.env.APPDATA, 'LineageMPTimer', 'training-data');
const PENDING = path.join(TRAINING, '_pending');
const REJECTED = path.join(TRAINING, '_rejected_voting');

function normalize(s, region) {
  if (!s) return null;
  // 공통: trim + 특수문자/공백 제거
  s = String(s).trim().replace(/[\s_'":;|]/g, '');
  if (!s) return null;

  if (region === 'mp') {
    const m = s.match(/^(\d+)\/(\d+)$/);
    if (!m) return null;
    const cur = parseInt(m[1], 10);
    const max = parseInt(m[2], 10);
    if (cur > max) return null;
    if (max !== 235 && max !== 242) return null;
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
    // | 또는 비숫자로 split → 가장 긴 3~7자리 token
    const tokens = s.split(/[^\d]+/).filter(t => t.length >= 3 && t.length <= 7);
    if (!tokens.length) return null;
    tokens.sort((a, b) => b.length - a.length);
    return tokens[0];
  }
  return null;
}

function vote(p7, p8, p13, ocrsugg, region) {
  const raw = [p7, p8, p13, ocrsugg];
  const norm = raw.map(s => normalize(s, region));
  const valid = norm.filter(Boolean);
  if (!valid.length) return { label: null, reason: 'no_valid', valid: [] };
  const cnt = {};
  for (const c of valid) cnt[c] = (cnt[c] || 0) + 1;
  const sorted = Object.entries(cnt).sort((a, b) => b[1] - a[1]);
  const [best, freq] = sorted[0];
  if (freq === 4) return { label: best, reason: 'unanimous_4', valid };
  if (freq === 3) return { label: best, reason: 'consensus_3', valid };
  if (freq === 2 && sorted.length === 1) return { label: best, reason: 'two_only_2', valid };
  // majority_2 (3+ valid + 2 majority) — 50% disagreement, 학습 노이즈 위험 → 폐기
  if (freq === 2) return { label: null, reason: 'majority_2_rejected', valid };
  // freq === 1 → all different
  return { label: null, reason: 'split', valid };
}

function safeLabel(s) {
  return String(s || '')
    .replace(/\//g, 'of')
    .replace(/\./g, 'p')
    .replace(/[^0-9A-Za-z_-]/g, '_')
    .slice(0, 32) || 'unlabeled';
}

function timestampStr() {
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}`;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

const stats = {
  mp: { accepted: 0, rejected: 0 },
  exp: { accepted: 0, rejected: 0 },
  adena: { accepted: 0, rejected: 0 },
};
const reasonStats = {};
const acceptanceByRegion = { mp: {}, exp: {}, adena: {} };

for (const region of ['mp', 'exp', 'adena']) {
  ensureDir(path.join(REJECTED, region));
  const tsv = path.join(OCR_OUT, `${region}_results.tsv`);
  if (!fs.existsSync(tsv)) {
    console.log(`[skip] ${region}: ${tsv} not found`);
    continue;
  }
  const lines = fs.readFileSync(tsv, 'utf-8').split('\n').filter(Boolean);
  console.log(`[${region}] processing ${lines.length} samples`);
  let i = 0;
  for (const line of lines) {
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const [base, ocrsugg, ensembleResult] = cols;
    const [p7, p8, p13] = (ensembleResult || '').split('|');

    const { label, reason } = vote(p7, p8, p13, ocrsugg, region);
    reasonStats[reason] = (reasonStats[reason] || 0) + 1;
    acceptanceByRegion[region][reason] = (acceptanceByRegion[region][reason] || 0) + 1;

    const srcPng = path.join(PENDING, region, base + '.png');
    const srcJson = path.join(PENDING, region, base + '.json');
    if (!fs.existsSync(srcPng)) {
      // 이미 처리됐거나 자동 캡처로 변경됨
      continue;
    }

    if (label) {
      // 채택
      stats[region].accepted++;
      if (DRY_RUN) {
        if (i < 5) console.log(`  [dry][${region}][${reason}] ${base} → ${label}`);
      } else {
        const dstDir = path.join(TRAINING, region);
        ensureDir(dstDir);
        const safe = safeLabel(label);
        const stamp = timestampStr();
        const dstBase = `${safe}_${stamp}_v2`;
        const dstPng = path.join(dstDir, dstBase + '.png');
        const dstGt = path.join(dstDir, dstBase + '.gt.txt');
        try {
          fs.copyFileSync(srcPng, dstPng);
          fs.writeFileSync(dstGt, label + '\n', 'utf-8');
          fs.unlinkSync(srcPng);
          if (fs.existsSync(srcJson)) fs.unlinkSync(srcJson);
        } catch (e) {
          console.error(`  [error] ${base}: ${e.message}`);
          stats[region].accepted--;
        }
      }
    } else {
      // 폐기
      stats[region].rejected++;
      if (!DRY_RUN) {
        const dstDir = path.join(REJECTED, region);
        try {
          fs.renameSync(srcPng, path.join(dstDir, base + '.png'));
          if (fs.existsSync(srcJson)) fs.renameSync(srcJson, path.join(dstDir, base + '.json'));
        } catch (e) {
          console.error(`  [error reject] ${base}: ${e.message}`);
        }
      }
    }
    i++;
  }
  console.log(`[${region}] done — accepted=${stats[region].accepted}, rejected=${stats[region].rejected}`);
}

console.log('\n===== Voting Summary =====');
console.log(JSON.stringify(stats, null, 2));
console.log('\n===== Reasons =====');
console.log(JSON.stringify(reasonStats, null, 2));
console.log('\n===== Reasons by Region =====');
console.log(JSON.stringify(acceptanceByRegion, null, 2));

const totalAcc = stats.mp.accepted + stats.exp.accepted + stats.adena.accepted;
const totalRej = stats.mp.rejected + stats.exp.rejected + stats.adena.rejected;
console.log(`\nTotal: accepted=${totalAcc}, rejected=${totalRej}, acceptance_rate=${(totalAcc/(totalAcc+totalRej)*100).toFixed(1)}%`);
if (DRY_RUN) console.log('\n(DRY-RUN: 실제 파일 이동 없음)');
