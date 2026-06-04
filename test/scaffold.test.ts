import { describe, it, expect } from 'vitest'
import { loadFixtures, hasFixtures } from './helpers/fixtures'
import type { RegionKind } from '@core/ocr/types'

describe('scaffold + fixtures', () => {
  const regions: RegionKind[] = ['mp', 'exp', 'level', 'adena']

  for (const region of regions) {
    it(`loads ${region} fixtures with labels and valid pixel buffers`, () => {
      expect(hasFixtures(region)).toBe(true)
      const fx = loadFixtures(region, 5)
      expect(fx.length).toBeGreaterThan(0)
      const f = fx[0]!
      expect(f.label.length).toBeGreaterThan(0)
      expect(f.image.width).toBeGreaterThan(0)
      expect(f.image.height).toBeGreaterThan(0)
      expect(f.image.data.length).toBe(f.image.width * f.image.height * 4)
    })
  }

  it('mp labels look like cur/max', () => {
    const fx = loadFixtures('mp', 20)
    expect(fx.some((f) => /\d+\/\d+/.test(f.label))).toBe(true)
  })
})
