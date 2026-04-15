/**
 * Lineage Classic MP Recovery Engine
 *
 * 순수 계산 모듈 - DOM/Electron 의존성 없음. Browser + Node 모두 사용 가능.
 *
 * 공식 근거:
 * - 기본 틱: 정지 16s / 이동 32s / 전투 64s
 * - WIS 기본 회복량: 14↓=1, 15-16=2, 17-18=3, 이후 WIS 2당 +1
 * - 파란물약: +max(1, WIS-10) MP/틱, 600s 지속
 * - 메디테이션: +5 MP/틱, 640s, 정지 상태만
 * - 여관/아가타: +2, 싱잉/히든밸리: +3, 던전: -3
 * - 수정 지팡이: +10 MP/틱
 * - 배고픔/과중: 회복 불가
 */
(function (global) {
  'use strict';

  const TICK_BASE = 16;
  const TICK_MULTIPLIER = {
    standing: 1,
    moving: 2,
    combat: 4
  };

  // 검증된 위치만 (기타는 직접 입력으로 대체)
  const LOCATION_BONUS = {
    field: 0,
    tavern: 2,
    dungeon: -3
  };

  const LOCATION_LABEL = {
    field: '일반 필드',
    tavern: '여관',
    dungeon: '마법사 30Q 던전 (페널티)',
    custom: '직접 입력'
  };

  const STATE_LABEL = {
    standing: '정지',
    moving: '이동',
    combat: '전투',
    blocked: '회복 불가 (배고픔/과중)'
  };

  const BLUE_POTION_DURATION = 600;
  const MEDITATION_DURATION = 640;
  const MEDITATION_BONUS = 5;
  const CRYSTAL_STAFF_BONUS = 10;

  function calculateBaseTickRecovery(wis) {
    if (!Number.isFinite(wis) || wis < 1) return 1;
    if (wis <= 14) return 1;
    return 1 + Math.floor((wis - 13) / 2);
  }

  function calculateBluePotionBonus(wis) {
    if (!Number.isFinite(wis)) return 1;
    return Math.max(1, wis - 10);
  }

  function calculateLocationBonus(location, customBonus) {
    if (location === 'custom') {
      const v = parseInt(customBonus, 10);
      if (!Number.isFinite(v)) return 0;
      return Math.max(-20, Math.min(50, v));
    }
    return LOCATION_BONUS[location] ?? 0;
  }

  function calculateTickInterval(state) {
    const mult = TICK_MULTIPLIER[state] ?? 1;
    return TICK_BASE * mult;
  }

  function calculateTickRecovery(config) {
    const cfg = config || {};
    const {
      wis = 15,
      useBluePotion = true,
      useMeditation = true,
      hasCrystalStaff = false,
      location = 'field',
      customLocationBonus = 0,
      state = 'standing'
    } = cfg;

    if (state === 'blocked') return 0;

    let recovery = calculateBaseTickRecovery(wis);
    if (useBluePotion) recovery += calculateBluePotionBonus(wis);
    if (useMeditation && state === 'standing') recovery += MEDITATION_BONUS;
    recovery += calculateLocationBonus(location, customLocationBonus);
    if (hasCrystalStaff) recovery += CRYSTAL_STAFF_BONUS;

    return Math.max(1, recovery);
  }

  /**
   * 완충까지 필요한 총 시간 (초)
   * blocked 상태는 Infinity 반환
   */
  function calculateFullMpTime(currentMp, maxMp, config) {
    const cur = Math.max(0, Math.min(Number(currentMp) || 0, Number(maxMp) || 0));
    const max = Math.max(0, Number(maxMp) || 0);
    if (max <= 0) return 0;
    if (cur >= max) return 0;

    const cfg = config || {};
    if (cfg.state === 'blocked') return Infinity;

    const recovery = calculateTickRecovery(cfg);
    if (recovery <= 0) return Infinity;

    const interval = calculateTickInterval(cfg.state || 'standing');
    const needed = max - cur;
    const ticks = Math.ceil(needed / recovery);
    return ticks * interval;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return '∞';
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  }

  function formatCompletionTime(seconds, now = new Date()) {
    if (!Number.isFinite(seconds)) return '--:--:--';
    const then = new Date(now.getTime() + seconds * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(then.getHours())}:${pad(then.getMinutes())}:${pad(then.getSeconds())}`;
  }

  /**
   * 구성 요소별 회복량 분해 (UI 표시용)
   */
  function breakdown(config) {
    const cfg = config || {};
    const {
      wis = 15,
      useBluePotion = true,
      useMeditation = true,
      hasCrystalStaff = false,
      location = 'field',
      customLocationBonus = 0,
      state = 'standing'
    } = cfg;

    const items = [];
    items.push({ key: 'base', label: `기본 (WIS ${wis})`, value: calculateBaseTickRecovery(wis) });
    if (useBluePotion) {
      items.push({ key: 'potion', label: '파란물약', value: calculateBluePotionBonus(wis) });
    }
    if (useMeditation && state === 'standing') {
      items.push({ key: 'meditation', label: '메디테이션', value: MEDITATION_BONUS });
    }
    const locBonus = calculateLocationBonus(location, customLocationBonus);
    if (locBonus !== 0) {
      const label = location === 'custom' ? '직접 입력 위치' : (LOCATION_LABEL[location] || location);
      items.push({ key: 'location', label, value: locBonus });
    }
    if (hasCrystalStaff) {
      items.push({ key: 'staff', label: '수정 지팡이', value: CRYSTAL_STAFF_BONUS });
    }

    const total = Math.max(1, items.reduce((a, b) => a + b.value, 0));
    const interval = calculateTickInterval(state);
    return { items, total, interval };
  }

  const MpEngine = {
    TICK_BASE,
    TICK_MULTIPLIER,
    LOCATION_BONUS,
    LOCATION_LABEL,
    STATE_LABEL,
    BLUE_POTION_DURATION,
    MEDITATION_DURATION,
    MEDITATION_BONUS,
    CRYSTAL_STAFF_BONUS,
    calculateBaseTickRecovery,
    calculateBluePotionBonus,
    calculateLocationBonus,
    calculateTickInterval,
    calculateTickRecovery,
    calculateFullMpTime,
    formatDuration,
    formatCompletionTime,
    breakdown
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MpEngine;
  } else {
    global.MpEngine = MpEngine;
  }
})(typeof window !== 'undefined' ? window : globalThis);
