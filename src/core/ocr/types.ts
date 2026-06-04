/**
 * OCR core type contracts — environment-agnostic.
 *
 * The entire recognition pipeline operates on plain data structures (no canvas,
 * no DOM, no Node). In the browser, an `RgbaImage` is produced from a canvas via
 * `ctx.getImageData()`; in tests it is decoded from a PNG via pngjs. This is what
 * makes the OCR logic fully unit-testable against the 1,300+ captured game samples
 * without a running game.
 */

/** RGBA pixel buffer. `data.length === width * height * 4`. */
export interface RgbaImage {
  readonly width: number
  readonly height: number
  /** RGBA, row-major, 0..255. */
  readonly data: Uint8ClampedArray | Uint8Array
}

/** 1 = ink (text), 0 = background. `data.length === width * height`. */
export interface BinaryMask {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

/** Grayscale buffer, 0..255, one byte per pixel. `data.length === width * height`. */
export interface GrayImage {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array
}

export type RegionKind = 'mp' | 'exp' | 'level' | 'adena'

/** Half-open glyph bounding box within a mask: [x0, x1) x [y0, y1). */
export interface GlyphBox {
  x0: number
  x1: number
  y0: number
  y1: number
}

/** How a region value was obtained, in priority order of trust. */
export type RecognitionSource =
  | 'bar-pixel' // MP bar fill measurement — ~100% accurate, no OCR
  | 'user-template' // user-learned digit templates — primary numeric path
  | 'base-template' // bundled pixel-font templates — bootstrap only
  | 'tesseract' // generic OCR — bootstrap only
  | 'vision' // cloud Vision cross-check — novel/ambiguous frames only
  | 'manual' // user typed it
  | 'none'

/** Per-glyph recognition detail. `runnerUp` feeds the confusion-aware tracker. */
export interface GlyphConfidence {
  char: string
  confidence: number // 0..1
  runnerUp: string | null
  runnerUpConfidence: number
  box: GlyphBox
}

/** Parsed numeric payload, discriminated by region. */
export type ParsedValue =
  | { kind: 'mp'; cur: number; max: number }
  | { kind: 'exp'; pct: number } // 0..100 (e.g. 58.6840)
  | { kind: 'level'; level: number }
  | { kind: 'adena'; amount: number }

/** Output of recognizing one region for one frame. */
export interface RecognitionResult {
  region: RegionKind
  /** Raw recognized character string, e.g. "121/235", "58.6840", "8414". null = unreadable. */
  raw: string | null
  /** Parsed numeric form. null = could not parse / rejected. */
  value: ParsedValue | null
  /** Aggregate confidence 0..1. */
  confidence: number
  source: RecognitionSource
  /** Per-glyph breakdown (template paths only). */
  glyphs?: GlyphConfidence[]
  /** Human-readable note for the diagnostics drawer. */
  note?: string
}

/** A single digit/symbol template at native pixel resolution. */
export interface GlyphTemplate {
  char: string
  width: number
  height: number
  /** Grayscale 0..255, row-major, length = width*height. */
  data: Uint8Array
}

/** Result of matching one segmented glyph against a template set. */
export interface MatchResult {
  char: string
  confidence: number // 0..1 (1 = exact)
  distance: number // raw normalized distance (lower = better)
  runnerUp: string | null
  runnerUpConfidence: number
}

/** Alphabet a region can contain — constrains the matcher and parser. */
export const REGION_ALPHABET: Record<RegionKind, string[]> = {
  mp: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '/'],
  exp: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.'],
  level: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
  adena: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ',']
}
