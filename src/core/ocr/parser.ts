/**
 * Region string -> ParsedValue. Tolerant of OCR noise (stray separators, spaces)
 * but conservative: returns null rather than guessing when a value is implausible.
 */
import type { ParsedValue, RegionKind } from './types'

/** Optional context that tightens validation when the caller knows more. */
export interface ParseContext {
  /** Known max MP — validates no-slash MP parses (cur-only) for plausibility. */
  maxMp?: number
}

export function parseRegionString(
  region: RegionKind,
  raw: string | null,
  ctx?: ParseContext
): ParsedValue | null {
  if (!raw) return null
  const s = raw.trim()
  switch (region) {
    case 'mp':
      return parseMp(s, ctx?.maxMp)
    case 'exp':
      return parseExp(s)
    case 'level':
      return parseLevel(s)
    case 'adena':
      return parseAdena(s)
  }
}

function digits(s: string): string {
  return s.replace(/[^0-9]/g, '')
}

/**
 * A no-slash MP parse (cur-only, '/' never recognized) is plausible only when
 * `cur <= maxMp * MP_NO_SLASH_MAX_FACTOR`. Live evidence: the tiny "cur/max" text
 * misreads as digit soup ("000000", "6610068380") whose '/' is NEVER matched —
 * without a max-context check these become tracker observations (cur=0 anchor
 * takeover / cur=6.6e9).
 */
export const MP_NO_SLASH_MAX_FACTOR = 2

/**
 * Confidence multiplier applied to no-slash MP parses by the live pipeline. A
 * missing '/' separator means the read is structurally suspect (the real HUD always
 * renders "cur/max"), so the tracker should need much stronger evidence to accept.
 */
export const MP_NO_SLASH_CONFIDENCE_PENALTY = 0.6

/**
 * Conservative gate for a no-slash MP parse against a known maxMp:
 *  - `cur > maxMp × 2` → implausible, drop the value entirely (`ok: false`);
 *  - otherwise keep it but dampen confidence by {@link MP_NO_SLASH_CONFIDENCE_PENALTY}.
 * With `maxMp <= 0` (unknown) only the penalty applies.
 */
export function assessNoSlashMp(
  cur: number,
  confidence: number,
  maxMp: number
): { ok: boolean; confidence: number } {
  if (maxMp > 0 && cur > maxMp * MP_NO_SLASH_MAX_FACTOR) return { ok: false, confidence: 0 }
  return { ok: true, confidence: confidence * MP_NO_SLASH_CONFIDENCE_PENALTY }
}

function parseMp(s: string, maxMp?: number): ParsedValue | null {
  const m = s.match(/(\d+)\s*\/\s*(\d+)/)
  if (m) {
    const cur = parseInt(m[1]!, 10)
    const max = parseInt(m[2]!, 10)
    if (Number.isFinite(cur) && Number.isFinite(max) && max > 0 && cur <= max * 2) {
      return { kind: 'mp', cur: Math.min(cur, max), max }
    }
    return null
  }
  // No slash recognized: treat as current only (max filled in by caller's anchor).
  // With a maxMp context, an implausibly large cur is rejected outright.
  const d = digits(s)
  if (!d) return null
  const cur = parseInt(d, 10)
  if (!Number.isFinite(cur)) return null
  if (maxMp != null && maxMp > 0 && cur > maxMp * MP_NO_SLASH_MAX_FACTOR) return null
  return { kind: 'mp', cur, max: 0 }
}

/** Lineage Classic EXP is always displayed as XX.XXXX (exactly 4 decimals). */
const EXP_DECIMALS = 4

function parseExp(s: string): ParsedValue | null {
  // Label form: "58.6840" (percent with 4 decimals). Accept missing dot too.
  const m = s.match(/(\d+)\.(\d+)/)
  let pct: number
  if (m) {
    // Drop any decimals beyond 4: the trailing "%" glyph gets segmented and
    // misread as an extra decimal digit (e.g. real "78.4747" -> "78.47472").
    // EXP is a fixed 4-decimal percent, so truncating is the correct repair.
    const dec = m[2]!.length > EXP_DECIMALS ? m[2]!.slice(0, EXP_DECIMALS) : m[2]!
    pct = parseFloat(`${m[1]}.${dec}`)
  } else {
    const d = digits(s)
    if (!d) return null
    // e.g. "586840" -> 58.6840 ; "27" -> 27 ; heuristic only used as last resort.
    pct = d.length > 2 ? parseFloat(`${d.slice(0, 2)}.${d.slice(2, 2 + EXP_DECIMALS)}`) : parseFloat(d)
  }
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null
  return { kind: 'exp', pct }
}

function parseLevel(s: string): ParsedValue | null {
  const d = digits(s)
  if (!d) return null
  const level = parseInt(d, 10)
  if (!Number.isFinite(level) || level < 1 || level > 99) return null
  return { kind: 'level', level }
}

function parseAdena(s: string): ParsedValue | null {
  const d = digits(s)
  if (!d) return null
  const amount = parseInt(d, 10)
  if (!Number.isFinite(amount) || amount < 0) return null
  return { kind: 'adena', amount }
}

/** Canonical string form of a parsed value, for equality checks / display. */
export function formatParsed(v: ParsedValue | null): string {
  if (!v) return ''
  switch (v.kind) {
    case 'mp':
      return v.max > 0 ? `${v.cur}/${v.max}` : `${v.cur}`
    case 'exp':
      return v.pct.toFixed(4)
    case 'level':
      return String(v.level)
    case 'adena':
      return String(v.amount)
  }
}

/** Compare two parsed values for benchmark equality (exp compared to 4 decimals). */
export function parsedEquals(a: ParsedValue | null, b: ParsedValue | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false
  switch (a.kind) {
    case 'mp':
      return b.kind === 'mp' && a.cur === b.cur && a.max === b.max
    case 'exp':
      return b.kind === 'exp' && Math.abs(a.pct - b.pct) < 0.00005
    case 'level':
      return b.kind === 'level' && a.level === b.level
    case 'adena':
      return b.kind === 'adena' && a.amount === b.amount
  }
}
