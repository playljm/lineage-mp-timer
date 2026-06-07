/**
 * mergeTemplateSetsWeighted — the repeat-teaching accumulation semantics that
 * replaced last-writer-wins in learnFromCapture (P7).
 *
 * Why: mergeTemplateSets REPLACES a char outright, so teaching the same digit N
 * times kept only the last single capture — none of the statistical strength a
 * multi-sample average has (measured: a 248-sample average beat single-capture
 * templates by +5.4pp on the v2 corpus). The weighted merge blends overlapping
 * chars cell-wise by sample count while flooring the fresh teaching's weight at
 * 50% so "re-teach to immediately correct a bad template" still works.
 */
import { describe, it, expect } from 'vitest'
import { mergeTemplateSetsWeighted } from '@core/ocr/learn'
import { CANON_W, CANON_H, type CharTemplate, type TemplateSet } from '@core/ocr/template-matcher'

const CELLS = CANON_W * CANON_H

function tpl(char: string, fill: number, samples: number, meanAspect = 0.7): CharTemplate {
  return { char, grid: new Uint8Array(CELLS).fill(fill), samples, meanAspect }
}

function set(...chars: CharTemplate[]): TemplateSet {
  return { canonW: CANON_W, canonH: CANON_H, chars }
}

describe('mergeTemplateSetsWeighted', () => {
  it('keeps chars unique to either side unchanged', () => {
    const merged = mergeTemplateSetsWeighted(set(tpl('1', 200, 3)), set(tpl('2', 100, 5)))
    expect(merged.chars.map((c) => c.char)).toEqual(['1', '2'])
    expect(merged.chars.find((c) => c.char === '1')!.grid[0]).toBe(200)
    expect(merged.chars.find((c) => c.char === '1')!.samples).toBe(3)
    expect(merged.chars.find((c) => c.char === '2')!.grid[0]).toBe(100)
  })

  it('blends overlapping chars by sample count and accumulates samples', () => {
    // primary 3 samples vs fallback 1 → w = max(0.5, 3/4) = 0.75
    const merged = mergeTemplateSetsWeighted(
      set(tpl('7', 200, 3, 0.8)),
      set(tpl('7', 100, 1, 0.4))
    )
    const c = merged.chars[0]!
    expect(c.grid[0]).toBe(Math.round(0.75 * 200 + 0.25 * 100)) // 175
    expect(c.samples).toBe(4)
    expect(c.meanAspect).toBeCloseTo(0.75 * 0.8 + 0.25 * 0.4, 10)
  })

  it('floors the fresh teaching at 50% even against a huge average (re-teach UX)', () => {
    // 1 new sample vs 300 accumulated: proportional weight would be ~0.3% — the
    // floor guarantees the correction still moves the template half-way.
    const merged = mergeTemplateSetsWeighted(
      set(tpl('4', 255, 1)),
      set(tpl('4', 1, 300))
    )
    const c = merged.chars[0]!
    expect(c.grid[0]).toBe(128) // round(0.5*255 + 0.5*1)
    expect(c.samples).toBe(301)
  })

  it('honours a custom minPrimaryWeight', () => {
    const merged = mergeTemplateSetsWeighted(
      set(tpl('4', 255, 1)),
      set(tpl('4', 0, 999)),
      { minPrimaryWeight: 0.25 }
    )
    expect(merged.chars[0]!.grid[0]).toBe(Math.round(0.25 * 255)) // 64
  })

  it('repeat teaching is monotone: each pass pulls further toward the taught shape', () => {
    let acc = set(tpl('9', 0, 1))
    const values: number[] = []
    for (let i = 0; i < 3; i++) {
      acc = mergeTemplateSetsWeighted(set(tpl('9', 255, 1)), acc)
      values.push(acc.chars[0]!.grid[0]!)
    }
    expect(values[0]!).toBe(128) // ≥50% on first re-teach
    expect(values[1]!).toBeGreaterThan(values[0]!) // ≥75%
    expect(values[2]!).toBeGreaterThan(values[1]!)
  })

  it('falls back to replace-merge when canonical grids differ', () => {
    const odd: TemplateSet = { canonW: 8, canonH: 8, chars: [
      { char: '5', grid: new Uint8Array(64).fill(9), samples: 2, meanAspect: 0.5 }
    ] }
    const merged = mergeTemplateSetsWeighted(odd, set(tpl('5', 100, 10)))
    // primary wins outright (mergeTemplateSets semantics), no cell-wise mixing
    expect(merged.canonW).toBe(8)
    expect(merged.chars[0]!.grid.length).toBe(64)
    expect(merged.chars[0]!.samples).toBe(2)
  })
})
