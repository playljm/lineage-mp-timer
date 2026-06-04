/**
 * Digit/symbol template matcher.
 *
 * A template is the *average occupancy* (0..1 per cell) of many tight glyph masks
 * for one character, normalized to a canonical grid. Matching compares a
 * segmented glyph's normalized mask to each template by mean absolute difference,
 * with a small aspect-ratio prior. Because segmentation (not equal-width division)
 * feeds tight, correctly-bounded glyphs, the same-font score gaps are large and
 * stable — the opposite of the v2.x razor-thin grayscale ties.
 *
 * The same structure backs both the bundled "base" templates and per-user learned
 * templates; the recognizer decides priority. Once a character is user-learned the
 * recognizer never falls back to base for it (the v2.x fallback hole is closed).
 */
import type { BinaryMask, MatchResult } from './types'
import { resampleMask, countInk, inkBounds, cropMask } from './imaging'

export const CANON_W = 16
export const CANON_H = 24

export interface CharTemplate {
  char: string
  /** Mean occupancy 0..255 over CANON_W*CANON_H cells, row-major. */
  grid: Uint8Array
  samples: number
  /** Mean native aspect (width/height) — a width prior for 1 vs 8, / vs 0, etc. */
  meanAspect: number
}

export interface TemplateSet {
  canonW: number
  canonH: number
  chars: CharTemplate[]
}

function aspectOf(mask: BinaryMask): number {
  return mask.height > 0 ? mask.width / mask.height : 1
}

/** Normalize a glyph mask to the canonical grid as 0/1 occupancy (re-tightens defensively). */
export function normalizeGlyph(mask: BinaryMask, canonW = CANON_W, canonH = CANON_H): Uint8Array {
  const bounds = inkBounds(mask)
  if (!bounds) return new Uint8Array(canonW * canonH)
  const tight = cropMask(mask, bounds)
  return resampleMask(tight, canonW, canonH).data
}

export class TemplateBuilder {
  private readonly acc = new Map<string, { sum: Float64Array; count: number; aspect: number }>()
  constructor(
    readonly canonW = CANON_W,
    readonly canonH = CANON_H
  ) {}

  add(char: string, tightMask: BinaryMask): void {
    if (countInk(tightMask) === 0) return
    const norm = normalizeGlyph(tightMask, this.canonW, this.canonH)
    let entry = this.acc.get(char)
    if (!entry) {
      entry = { sum: new Float64Array(this.canonW * this.canonH), count: 0, aspect: 0 }
      this.acc.set(char, entry)
    }
    for (let i = 0; i < norm.length; i++) entry.sum[i]! += norm[i]!
    entry.count++
    entry.aspect += aspectOf(tightMask)
  }

  finalize(): TemplateSet {
    const chars: CharTemplate[] = []
    for (const [char, entry] of this.acc) {
      const grid = new Uint8Array(entry.sum.length)
      for (let i = 0; i < grid.length; i++) grid[i] = Math.round((entry.sum[i]! / entry.count) * 255)
      chars.push({
        char,
        grid,
        samples: entry.count,
        meanAspect: entry.aspect / entry.count
      })
    }
    chars.sort((a, b) => a.char.localeCompare(b.char))
    return { canonW: this.canonW, canonH: this.canonH, chars }
  }
}

export interface MatchOptions {
  /** Restrict candidates to these characters (region alphabet). */
  allowed?: ReadonlySet<string> | string[]
  /** Weight of the aspect-ratio prior (0..~0.5). Default 0.15. */
  aspectWeight?: number
}

/** Match one tight glyph mask against a template set. */
export function matchGlyph(
  tightMask: BinaryMask,
  set: TemplateSet,
  opts: MatchOptions = {}
): MatchResult {
  const allowed =
    opts.allowed instanceof Set
      ? opts.allowed
      : opts.allowed
        ? new Set(opts.allowed)
        : null
  const aspectWeight = opts.aspectWeight ?? 0.15
  const norm = normalizeGlyph(tightMask, set.canonW, set.canonH)
  const aspect = aspectOf(tightMask)
  const cells = set.canonW * set.canonH

  let best: { char: string; score: number } | null = null
  let runner: { char: string; score: number } | null = null

  for (const tpl of set.chars) {
    if (allowed && !allowed.has(tpl.char)) continue
    let diff = 0
    const g = tpl.grid
    for (let i = 0; i < cells; i++) {
      const t = g[i]! / 255
      const s = norm[i]! // 0 or 1
      diff += s >= 1 ? 1 - t : t
    }
    const pixelScore = 1 - diff / cells
    const aspectPenalty = aspectWeight * Math.min(1, Math.abs(aspect - tpl.meanAspect))
    const score = pixelScore - aspectPenalty
    if (!best || score > best.score) {
      runner = best
      best = { char: tpl.char, score }
    } else if (!runner || score > runner.score) {
      runner = { char: tpl.char, score }
    }
  }

  if (!best) {
    return { char: '', confidence: 0, distance: 1, runnerUp: null, runnerUpConfidence: 0 }
  }
  return {
    char: best.char,
    confidence: Math.max(0, Math.min(1, best.score)),
    distance: 1 - best.score,
    runnerUp: runner?.char ?? null,
    runnerUpConfidence: runner ? Math.max(0, Math.min(1, runner.score)) : 0
  }
}

// ---- serialization (base-templates.json + per-user localStorage) ----

interface SerializedChar {
  char: string
  samples: number
  meanAspect: number
  grid: string // base64
}
export interface SerializedTemplateSet {
  canonW: number
  canonH: number
  chars: SerializedChar[]
}

// Pure base64 (no btoa/Buffer) so the core typechecks under both the DOM and the
// node lib configs without depending on environment globals.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToB64(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let nbits = 0
  for (let i = 0; i < bytes.length; i++) {
    bits = (bits << 8) | bytes[i]!
    nbits += 8
    while (nbits >= 6) {
      nbits -= 6
      out += B64[(bits >> nbits) & 63]
    }
  }
  if (nbits > 0) out += B64[(bits << (6 - nbits)) & 63]
  while (out.length % 4) out += '='
  return out
}

function b64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8))
  let bits = 0
  let nbits = 0
  let p = 0
  for (let i = 0; i < clean.length; i++) {
    bits = (bits << 6) | B64.indexOf(clean[i]!)
    nbits += 6
    if (nbits >= 8) {
      nbits -= 8
      out[p++] = (bits >> nbits) & 0xff
    }
  }
  return out
}

export function serializeTemplates(set: TemplateSet): SerializedTemplateSet {
  return {
    canonW: set.canonW,
    canonH: set.canonH,
    chars: set.chars.map((c) => ({
      char: c.char,
      samples: c.samples,
      meanAspect: c.meanAspect,
      grid: bytesToB64(c.grid)
    }))
  }
}

export function deserializeTemplates(s: SerializedTemplateSet): TemplateSet {
  return {
    canonW: s.canonW,
    canonH: s.canonH,
    chars: s.chars.map((c) => ({
      char: c.char,
      samples: c.samples,
      meanAspect: c.meanAspect,
      grid: b64ToBytes(c.grid)
    }))
  }
}

/** Merge two sets (e.g. user over base). Characters in `primary` win outright. */
export function mergeTemplateSets(primary: TemplateSet, fallback: TemplateSet): TemplateSet {
  const byChar = new Map<string, CharTemplate>()
  for (const c of fallback.chars) byChar.set(c.char, c)
  for (const c of primary.chars) byChar.set(c.char, c)
  return {
    canonW: primary.canonW,
    canonH: primary.canonH,
    chars: [...byChar.values()].sort((a, b) => a.char.localeCompare(b.char))
  }
}
