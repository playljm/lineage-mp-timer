/**
 * Lineage Classic MP natural-recovery engine.
 *
 * Pure, dependency-free. Behaviour-preserving TypeScript port of the proven
 * v2.x engine.js (its unit tests are carried over verbatim in
 * test/domain/mp-engine.test.ts). Game-formula constants are unchanged.
 *
 * Formula provenance:
 * - Tick period: standing 16s / moving 32s / combat 64s
 * - WIS base recovery: <=14 -> 1, then 1 + floor((WIS-13)/2)
 *   (15-16=2, 17-18=3, 19-20=4, +1 per 2 WIS)
 * - Blue potion: +max(1, WIS-10) MP/tick (600s)
 * - Meditation: +5 MP/tick (640s, standing only)
 * - Tavern/Agatha +2, Singing/Hidden-valley +3, Dungeon -3
 * - Crystal staff: +10 MP/tick
 * - Hunger/overweight: no recovery (blocked)
 */

export type MovementState = 'standing' | 'moving' | 'combat' | 'blocked'
export type LocationKind = 'field' | 'tavern' | 'dungeon' | 'custom'

export interface MpConfig {
  wis?: number
  useBluePotion?: boolean
  useMeditation?: boolean
  hasCrystalStaff?: boolean
  location?: LocationKind
  customLocationBonus?: number | string
  state?: MovementState
}

export interface BreakdownItem {
  key: 'base' | 'potion' | 'meditation' | 'location' | 'staff'
  label: string
  value: number
}

export interface Breakdown {
  items: BreakdownItem[]
  total: number
  interval: number
}

export const TICK_BASE = 16
export const TICK_MULTIPLIER: Record<MovementState, number> = {
  standing: 1,
  moving: 2,
  combat: 4,
  blocked: 1
}

export const LOCATION_BONUS: Record<'field' | 'tavern' | 'dungeon', number> = {
  field: 0,
  tavern: 2,
  dungeon: -3
}

export const LOCATION_LABEL: Record<LocationKind, string> = {
  field: '일반 필드',
  tavern: '여관',
  dungeon: '마법사 30Q 던전 (페널티)',
  custom: '직접 입력'
}

export const STATE_LABEL: Record<MovementState, string> = {
  standing: '정지',
  moving: '이동',
  combat: '전투',
  blocked: '회복 불가 (배고픔/과중)'
}

export const BLUE_POTION_DURATION = 600
export const MEDITATION_DURATION = 640
export const MEDITATION_BONUS = 5
export const CRYSTAL_STAFF_BONUS = 10

export function calculateBaseTickRecovery(wis: number): number {
  if (!Number.isFinite(wis) || wis < 1) return 1
  if (wis <= 14) return 1
  return 1 + Math.floor((wis - 13) / 2)
}

export function calculateBluePotionBonus(wis: number): number {
  if (!Number.isFinite(wis)) return 1
  return Math.max(1, wis - 10)
}

export function calculateLocationBonus(
  location: LocationKind | undefined,
  customBonus?: number | string
): number {
  if (location === 'custom') {
    const v = typeof customBonus === 'number' ? customBonus : parseInt(String(customBonus), 10)
    if (!Number.isFinite(v)) return 0
    return Math.max(-20, Math.min(50, v))
  }
  if (location === 'field' || location === 'tavern' || location === 'dungeon') {
    return LOCATION_BONUS[location]
  }
  return 0
}

export function calculateTickInterval(state: MovementState): number {
  return TICK_BASE * (TICK_MULTIPLIER[state] ?? 1)
}

export function calculateTickRecovery(config: MpConfig = {}): number {
  const {
    wis = 15,
    useBluePotion = true,
    useMeditation = true,
    hasCrystalStaff = false,
    location = 'field',
    customLocationBonus = 0,
    state = 'standing'
  } = config

  if (state === 'blocked') return 0

  let recovery = calculateBaseTickRecovery(wis)
  if (useBluePotion) recovery += calculateBluePotionBonus(wis)
  if (useMeditation && state === 'standing') recovery += MEDITATION_BONUS
  recovery += calculateLocationBonus(location, customLocationBonus)
  if (hasCrystalStaff) recovery += CRYSTAL_STAFF_BONUS

  return Math.max(1, recovery)
}

/** Seconds to full MP. `blocked` or non-positive recovery -> Infinity. */
export function calculateFullMpTime(currentMp: number, maxMp: number, config: MpConfig = {}): number {
  const max = Math.max(0, Number(maxMp) || 0)
  const cur = Math.max(0, Math.min(Number(currentMp) || 0, max))
  if (max <= 0) return 0
  if (cur >= max) return 0
  if (config.state === 'blocked') return Infinity

  const recovery = calculateTickRecovery(config)
  if (recovery <= 0) return Infinity

  const interval = calculateTickInterval(config.state ?? 'standing')
  const ticks = Math.ceil((max - cur) / recovery)
  return ticks * interval
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '∞'
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(h)}:${pad(m)}:${pad(sec)}`
}

export function formatCompletionTime(seconds: number, now: Date = new Date()): string {
  if (!Number.isFinite(seconds)) return '--:--:--'
  const then = new Date(now.getTime() + seconds * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const sameDay = then.getDate() === now.getDate() && then.getMonth() === now.getMonth()
  const base = `${pad(then.getHours())}:${pad(then.getMinutes())}:${pad(then.getSeconds())}`
  // v3.0: surface day rollover for long fills instead of silently wrapping.
  return sameDay ? base : `+1d ${base}`
}

export function breakdown(config: MpConfig = {}): Breakdown {
  const {
    wis = 15,
    useBluePotion = true,
    useMeditation = true,
    hasCrystalStaff = false,
    location = 'field',
    customLocationBonus = 0,
    state = 'standing'
  } = config

  const items: BreakdownItem[] = []
  items.push({ key: 'base', label: `기본 (WIS ${wis})`, value: calculateBaseTickRecovery(wis) })
  if (useBluePotion) {
    items.push({ key: 'potion', label: '파란물약', value: calculateBluePotionBonus(wis) })
  }
  if (useMeditation && state === 'standing') {
    items.push({ key: 'meditation', label: '메디테이션', value: MEDITATION_BONUS })
  }
  const locBonus = calculateLocationBonus(location, customLocationBonus)
  if (locBonus !== 0) {
    const label = location === 'custom' ? '직접 입력 위치' : LOCATION_LABEL[location] || location
    items.push({ key: 'location', label, value: locBonus })
  }
  if (hasCrystalStaff) {
    items.push({ key: 'staff', label: '수정 지팡이', value: CRYSTAL_STAFF_BONUS })
  }

  const total = Math.max(
    1,
    items.reduce((a, b) => a + b.value, 0)
  )
  const interval = calculateTickInterval(state)
  return { items, total, interval }
}

export const MpEngine = {
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
} as const
