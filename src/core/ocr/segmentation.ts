/**
 * Glyph segmentation by connected-components (CCL) with x-overlap merging and a
 * width-based split fallback.
 *
 * This replaces the v2.x equal-width splitting (`charWidth = (x1-x0)/length`) —
 * the dominant source of 0-8 / 4-9 / 6-8 confusion, because a single column of
 * kerning/anti-alias drift sliced one digit's ink into its neighbour's cell at
 * BOTH match time and (permanently) learn time.
 *
 * Why CCL over pure column projection: in a pixel font each digit is one connected
 * blob, so CCL is immune to the internal column gaps that make projection
 * over-split, and to the 1px ink bridges that make it under-split. Vertically
 * split strokes (thresholding artefacts) are merged back by x-overlap; the rare
 * genuinely-touching pair is split by the estimated glyph width.
 */
import type { BinaryMask, GlyphBox } from './types'
import { cropMask, inkBounds } from './imaging'

export interface SegmentOptions {
  /** Drop components with fewer than this many ink pixels (noise). Default 3. */
  minGlyphArea?: number
  /** Merge two components if the smaller's x-span overlaps the other by >= this. Default 0.5. */
  mergeOverlap?: number
  /** Split a glyph wider than estGlyphWidth * this. Default 1.5. 0 disables. */
  wideSplitRatio?: number
  /** Typical digit aspect (width/height) used to estimate glyph width. Default 0.62. */
  glyphAspect?: number
  /** Drop border-touching components this narrow (crop slivers). Default 3. */
  edgeSliver?: number
}

export interface Glyph {
  box: GlyphBox
  mask: BinaryMask
}

interface Component {
  x0: number
  y0: number
  x1: number
  y1: number
  area: number
}

/** 8-connectivity connected components via iterative flood fill. */
export function connectedComponents(mask: BinaryMask, minArea = 1): Component[] {
  const { width, height, data } = mask
  const seen = new Uint8Array(width * height)
  const comps: Component[] = []
  const stack: number[] = []
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || seen[start]) continue
    let x0 = width
    let y0 = height
    let x1 = -1
    let y1 = -1
    let area = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const idx = stack.pop()!
      const x = idx % width
      const y = (idx / width) | 0
      area++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          const ni = ny * width + nx
          if (data[ni] && !seen[ni]) {
            seen[ni] = 1
            stack.push(ni)
          }
        }
      }
    }
    if (area >= minArea) comps.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, area })
  }
  return comps
}

function xOverlap(a: Component, b: Component): number {
  return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
}

function median(values: number[]): number {
  if (!values.length) return 0
  const s = [...values].sort((p, q) => p - q)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

export function segmentGlyphs(mask: BinaryMask, opts: SegmentOptions = {}): Glyph[] {
  const minArea = opts.minGlyphArea ?? 3
  const mergeOverlap = opts.mergeOverlap ?? 0.5
  const wideRatio = opts.wideSplitRatio ?? 1.5
  const glyphAspect = opts.glyphAspect ?? 0.62
  const edgeSliver = opts.edgeSliver ?? 3

  let comps = connectedComponents(mask, minArea)
  // Drop thin slivers touching the left/right crop edge (capture artefacts).
  comps = comps.filter(
    (c) => !((c.x0 === 0 || c.x1 === mask.width) && c.x1 - c.x0 <= edgeSliver)
  )
  if (!comps.length) return []
  comps.sort((a, b) => a.x0 + a.x1 - (b.x0 + b.x1))

  // Merge components whose x-spans overlap heavily (a digit split vertically by
  // thresholding) into one glyph box. Side-by-side digits barely overlap and stay
  // separate.
  const groups: Component[] = []
  for (const c of comps) {
    const last = groups[groups.length - 1]
    if (last) {
      const ov = xOverlap(last, c)
      const minW = Math.min(last.x1 - last.x0, c.x1 - c.x0)
      if (minW > 0 && ov >= mergeOverlap * minW) {
        last.x0 = Math.min(last.x0, c.x0)
        last.y0 = Math.min(last.y0, c.y0)
        last.x1 = Math.max(last.x1, c.x1)
        last.y1 = Math.max(last.y1, c.y1)
        last.area += c.area
        continue
      }
    }
    groups.push({ ...c })
  }

  // Width-based split for genuinely touching digits (one wide blob).
  let boxes: GlyphBox[] = groups.map((g) => ({ x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 }))
  if (wideRatio > 0 && boxes.length) {
    const widths = boxes.map((b) => b.x1 - b.x0)
    const med = median(widths)
    const estGlyph = Math.max(med * 0.7, mask.height * glyphAspect)
    const split: GlyphBox[] = []
    for (const b of boxes) {
      const w = b.x1 - b.x0
      if (estGlyph > 0 && w > estGlyph * wideRatio) {
        const parts = Math.max(2, Math.round(w / estGlyph))
        for (let i = 0; i < parts; i++) {
          const a = b.x0 + Math.round((w * i) / parts)
          const e = b.x0 + Math.round((w * (i + 1)) / parts)
          if (e > a) split.push({ x0: a, y0: b.y0, x1: e, y1: b.y1 })
        }
      } else {
        split.push(b)
      }
    }
    boxes = split
  }

  // Tighten each box to its own ink and emit left-to-right.
  const glyphs: Glyph[] = []
  for (const b of boxes) {
    const slice = cropMask(mask, b)
    const bounds = inkBounds(slice)
    if (!bounds) continue
    const tight = cropMask(slice, bounds)
    glyphs.push({
      box: { x0: b.x0 + bounds.x0, y0: b.y0 + bounds.y0, x1: b.x0 + bounds.x1, y1: b.y0 + bounds.y1 },
      mask: tight
    })
  }
  glyphs.sort((a, b) => a.box.x0 - b.box.x0)
  return glyphs
}
