import { describe, it, expect } from 'vitest'
import { parseRegionString } from '@core/ocr/parser'

describe('region parsing', () => {
  it('mp cur/max', () => {
    expect(parseRegionString('mp', '121/235')).toEqual({ kind: 'mp', cur: 121, max: 235 })
    expect(parseRegionString('mp', '0/320')).toEqual({ kind: 'mp', cur: 0, max: 320 })
  })

  it('exp keeps 4 decimals', () => {
    expect(parseRegionString('exp', '78.4747')).toEqual({ kind: 'exp', pct: 78.4747 })
  })

  it('exp drops a phantom trailing % glyph (5th decimal)', () => {
    // The "%" sign gets segmented and misread as a trailing decimal digit;
    // EXP is a fixed 4-decimal percent, so the extra is truncated.
    expect(parseRegionString('exp', '78.47472')).toEqual({ kind: 'exp', pct: 78.4747 })
  })

  it('exp drops multiple phantom trailing glyphs ("%" → several blobs)', () => {
    // Real user case: a wide auto-ROI captured "79.3390%" and the "%" segmented into
    // three junk digits → raw "79.3390232". Truncating to 4 decimals recovers 79.3390.
    expect(parseRegionString('exp', '79.3390232')).toEqual({ kind: 'exp', pct: 79.339 })
  })

  it('level 1..99', () => {
    expect(parseRegionString('level', '32')).toEqual({ kind: 'level', level: 32 })
    expect(parseRegionString('level', '199')).toBeNull()
  })

  it('adena strips separators', () => {
    expect(parseRegionString('adena', '8,414')).toEqual({ kind: 'adena', amount: 8414 })
  })
})
