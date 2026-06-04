/**
 * Loads the captured game-ROI PNGs + ground-truth labels into environment-agnostic
 * RgbaImage structures, so the OCR core can be benchmarked against real samples
 * without a running game.
 *
 * Fixture layout: test/fixtures/ocr/<region>/<name>.png + <name>.gt.txt
 *   mp    label e.g. "121/235"
 *   exp   label e.g. "58.6840"
 *   level label e.g. "28"
 *   adena label e.g. "8414"
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import type { RgbaImage, RegionKind } from '@core/ocr/types'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = join(here, '..', 'fixtures', 'ocr')

export function loadPngAsRgba(path: string): RgbaImage {
  const png = PNG.sync.read(readFileSync(path))
  return {
    width: png.width,
    height: png.height,
    data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length)
  }
}

export interface Fixture {
  name: string
  region: RegionKind
  pngPath: string
  label: string
  image: RgbaImage
}

export function fixtureDir(region: RegionKind): string {
  return join(FIXTURE_ROOT, region)
}

export function loadFixtures(region: RegionKind, limit?: number): Fixture[] {
  const dir = fixtureDir(region)
  if (!existsSync(dir)) return []
  const gts = readdirSync(dir).filter((f) => f.endsWith('.gt.txt'))
  const out: Fixture[] = []
  for (const gt of gts) {
    const base = gt.slice(0, -'.gt.txt'.length)
    const pngPath = join(dir, base + '.png')
    if (!existsSync(pngPath)) continue
    const label = readFileSync(join(dir, gt), 'utf8').trim()
    if (!label) continue
    out.push({ name: base, region, pngPath, label, image: loadPngAsRgba(pngPath) })
    if (limit && out.length >= limit) break
  }
  return out
}

export function hasFixtures(region: RegionKind): boolean {
  return existsSync(fixtureDir(region)) && readdirSync(fixtureDir(region)).some((f) => f.endsWith('.gt.txt'))
}
