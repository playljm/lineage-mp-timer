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
import { cropMask, inkBounds, countInk } from './imaging'

/**
 * Post-segmentation junk-glyph filter (opt-in, currently adena-only via
 * defaultSegmentOptions). The adena crop systematically contains non-text junk
 * the base CCL pass cannot tell from digits: a right-side inventory-UI fragment
 * (13x35px — far wider than edgeSliver=3 catches), small noise blobs, and
 * partial-width gray bands. Filters are RELATIVE to the sibling glyphs' medians
 * so they self-scale with the crop:
 *  - edge-touching AND width < edgeWidthRatio x median width  (UI fragment at the
 *    crop border; the width condition keeps a legitimate first/last digit that
 *    merely touches a tight crop — digits are >= median width, fragments are
 *    narrower. 0.7 was measured TOO lax: the 13px inventory fragment survives it
 *    and starves adena template learning, used 12/55 vs 27/55 at 1.0; accuracy
 *    58.2% -> 67.3%. Unconditional removal (ratio 99) adds nothing over 1.0),
 *  - height < minHeightRatio x median height                  (flat noise blob),
 *  - ink   < minInkRatio   x median ink                       (sparse speckle).
 */
export interface JunkFilterOptions {
  /** Edge-touching glyphs narrower than this x median width are junk. Default 1.0. */
  edgeWidthRatio?: number
  /** Glyphs shorter than this x median height are junk. Default 0.5. */
  minHeightRatio?: number
  /** Glyphs with less ink than this x median ink are junk. Default 0.25. */
  minInkRatio?: number
}

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
  /** Median-relative junk-glyph filter (see JunkFilterOptions). Off by default. */
  junkFilter?: boolean | JunkFilterOptions
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
  // Drop flat horizontal slivers (UI chrome: level-box borders/underlines, gauge
  // bands) BEFORE x-overlap merging — these chrome pieces chain-merge real digits
  // into a single mega-glyph (measured: level 28 -> one x[0,42)y[0,48) box).
  // Glyph shapes are safe by construction: '.' is roughly square (w ≈ h) and
  // '/' / '1' are taller than wide, so neither satisfies w > 3h at sliver height.
  // (A top/bottom-30% border-BLOCK filter was also evaluated here per the
  // diagnosis rank-5 option: it changed no region's accuracy — the only glyph it
  // targets, the chrome-fused '8', spans y[11,48) and escapes any band-confined
  // component filter — so it is intentionally NOT kept.)
  const sliverMaxH = Math.max(2, 0.08 * mask.height)
  comps = comps.filter((c) => {
    const w = c.x1 - c.x0
    const h = c.y1 - c.y0
    return !(h <= sliverMaxH && w > 3 * h)
  })
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
    const medW = median(widths)
    // Split TRIGGER: estimate the glyph width from the boxes' median INK height
    // (y1-y0), NOT mask.height — the working mask carries ~46% vertical padding
    // (exp: ink rows 26 of 48), which inflated the height term 1.85x and let
    // touching digit pairs escape (measured: '4X' blob w=41 < threshold 44.6).
    // Dots ('.', ',') are height outliers that would drag the median down and
    // over-split normal digits when few boxes exist, so only digit-stature boxes
    // (h >= half the tallest) contribute to the height estimate.
    const heights = boxes.map((b) => b.y1 - b.y0)
    const maxH = Math.max(...heights)
    const medInkH = median(heights.filter((h) => h >= 0.5 * maxH))
    const estGlyph = Math.max(medW * 0.7, medInkH * glyphAspect)
    const split: GlyphBox[] = []
    for (const b of boxes) {
      const w = b.x1 - b.x0
      if (estGlyph > 0 && w > estGlyph * wideRatio) {
        // PART COUNT uses a separate estimate: with >= 3 boxes the median box
        // width is dominated by clean single digits and is the best per-digit
        // width (measured: parts=round(41/20)=2 cuts at 90.5 vs true boundary
        // 90/91). The trigger estimate would over-split (round(41/16.1)=3).
        // With < 3 boxes the median IS (or includes) the wide blob, so fall
        // back to the trigger estimate.
        const partW = boxes.length >= 3 ? medW : estGlyph
        const parts = Math.max(2, Math.round(w / partW))
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
  if (opts.junkFilter) {
    return filterJunkGlyphs(glyphs, mask.width, opts.junkFilter === true ? {} : opts.junkFilter)
  }
  return glyphs
}

/**
 * Median-relative junk-glyph filter (see JunkFilterOptions). Medians are taken
 * over the UNfiltered glyph list, so one junk fragment among several digits
 * cannot drag the reference toward itself.
 */
export function filterJunkGlyphs(
  glyphs: Glyph[],
  maskWidth: number,
  opts: JunkFilterOptions = {}
): Glyph[] {
  if (glyphs.length < 2) return glyphs
  const edgeWidthRatio = opts.edgeWidthRatio ?? 1.0
  const minHeightRatio = opts.minHeightRatio ?? 0.5
  const minInkRatio = opts.minInkRatio ?? 0.25
  const medW = median(glyphs.map((g) => g.mask.width))
  const medH = median(glyphs.map((g) => g.mask.height))
  const medInk = median(glyphs.map((g) => countInk(g.mask)))
  return glyphs.filter((g) => {
    const touchesEdge = g.box.x0 <= 1 || g.box.x1 >= maskWidth - 1
    if (touchesEdge && g.mask.width < edgeWidthRatio * medW) return false
    if (g.mask.height < minHeightRatio * medH) return false
    if (countInk(g.mask) < minInkRatio * medInk) return false
    return true
  })
}
