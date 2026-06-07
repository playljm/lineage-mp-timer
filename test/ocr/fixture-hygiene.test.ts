import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RegionKind } from '@core/ocr/types'
import {
  loadFixtures,
  fixtureDir,
  fixtureTimestampMs,
  sessionHoldoutSplit
} from '../helpers/fixtures'

/**
 * Data/benchmark hygiene regressions (diagnosis RC-E / rankedFixPlan rank 7).
 *
 * 1. The adena "dunder" batch (`<a>__<rand>__<b>` names, 29 files) carries
 *    visually confirmed label-crop mismatches. It is preserved (not deleted)
 *    under test/fixtures/ocr/adena/_quarantine/ but must NEVER be loaded into
 *    the benchmark corpus again.
 * 2. The legacy `i % 2` split leaked same-session adjacent frames — and even
 *    identical labels — across train/test (measured: 95% of level and 84% of
 *    mp test labels also sat in train). sessionHoldoutSplit must keep every
 *    capture-session group and every identical-label cohort on ONE side.
 */
const REGIONS: RegionKind[] = ['mp', 'exp', 'level', 'adena']
const DUNDER = /__.+__/

describe('fixture corpus hygiene', () => {
  it('keeps the quarantined adena dunder batch preserved on disk', () => {
    const qDir = join(fixtureDir('adena'), '_quarantine')
    expect(existsSync(qDir)).toBe(true)
    const files = readdirSync(qDir)
    const pngs = files.filter((f) => f.endsWith('.png'))
    const gts = files.filter((f) => f.endsWith('.gt.txt'))
    // 29 mismatched pairs moved 2026-06-07 — data preserved, never deleted.
    expect(pngs.length).toBe(29)
    expect(gts.length).toBe(29)
    for (const p of pngs) expect(DUNDER.test(p)).toBe(true)
  })

  it('does not load quarantined fixtures (loadFixtures is non-recursive)', () => {
    const adena = loadFixtures('adena')
    expect(adena.length).toBeGreaterThan(0)
    for (const f of adena) {
      expect(DUNDER.test(f.name), `quarantined dunder fixture leaked back in: ${f.name}`).toBe(false)
    }
  })

  it('parses capture timestamps out of fixture names', () => {
    const a = fixtureTimestampMs('27p0604_20260503_020526_892')
    const b = fixtureTimestampMs('27p0604_20260503_020528_260')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(b! - a!).toBe(2000 - 892 + 260) // 2s apart minus/plus the ms parts
    expect(fixtureTimestampMs('0497__127__29_v2')).toBeNull() // dunder: no timestamp
    // _v2 suffix variants parse too
    expect(fixtureTimestampMs('126_20260509_231045_744_v2')).not.toBeNull()
  })

  for (const region of REGIONS) {
    it(`${region}: session holdout split leaks no labels and partitions cleanly`, () => {
      const all = loadFixtures(region)
      expect(all.length).toBeGreaterThan(0)
      const { train, test, groups } = sessionHoldoutSplit(all)

      // partition: every fixture lands on exactly one side
      expect(train.length + test.length).toBe(all.length)
      const names = new Set([...train, ...test].map((f) => f.name))
      expect(names.size).toBe(all.length)

      // groups partition too
      expect(groups.reduce((n, g) => n + g.length, 0)).toBe(all.length)

      // the core leak guard: no ground-truth label may sit on both sides
      const trainLabels = new Set(train.map((f) => f.label))
      const leaked = test.filter((f) => trainLabels.has(f.label))
      expect(
        leaked.map((f) => f.label),
        `labels leaked across the ${region} train/test split`
      ).toEqual([])

      // determinism: same input order-shuffled must give the same split
      const shuffled = [...all].reverse()
      const again = sessionHoldoutSplit(shuffled)
      expect(again.train.map((f) => f.name).sort()).toEqual(train.map((f) => f.name).sort())
      expect(again.test.map((f) => f.name).sort()).toEqual(test.map((f) => f.name).sort())
    })
  }
})
