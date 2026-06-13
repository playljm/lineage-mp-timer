/**
 * DIAGNOSTIC (do not delete — evidence artifact for the 2026-06-13 level/adena
 * recognition-failure investigation).
 *
 * Goal: with the ROI assumed CORRECT (we feed pre-cropped fixture PNGs straight
 * in), does recognizeRegion() actually produce a raw/value for `level` and
 * `adena`? This isolates the recognizer from the live ROI-derivation path
 * (ensureWindowRois), which is the OTHER suspect. EXP is included as the known-
 * good control: same code path, but the user reports EXP works in the field.
 *
 * Mirrors detection.ts:38,760 EXACTLY:
 *   baseTemplates = deserializeTemplates(base-templates.json)
 *   recognizeRegion({ region, image }, { baseTemplates, userTemplates: {} })
 * (userTemplates empty == a fresh install / a user who never trained — the
 * worst case the base templates must carry on their own.)
 */
import { describe, it } from 'vitest'
import baseTemplatesData from '@core/ocr/base-templates.json'
import {
  deserializeTemplates,
  type SerializedTemplateSet,
  type TemplateSet
} from '@core/ocr/template-matcher'
import { recognizeRegion } from '@core/ocr/recognizer'
import type { RegionKind } from '@core/ocr/types'
import { loadFixtures, type Fixture } from '../helpers/fixtures'

const baseTemplates: TemplateSet = deserializeTemplates(
  baseTemplatesData as unknown as SerializedTemplateSet
)
// Empty user template set — same shape detection.ts uses when nothing is trained.
// chars.length === 0 makes recognizer.effectiveSet fall through to base alone
// (the fresh-install / untrained-user path). canonW/H copied from base for typing.
const emptyUser: TemplateSet = {
  canonW: baseTemplates.canonW,
  canonH: baseTemplates.canonH,
  chars: []
}

function sample(fixtures: Fixture[], n: number): Fixture[] {
  if (fixtures.length <= n) return fixtures
  // Spread the sample across the corpus so we don't only see one burst.
  const step = fixtures.length / n
  const out: Fixture[] = []
  for (let i = 0; i < n; i++) out.push(fixtures[Math.floor(i * step)])
  return out
}

function diagnose(region: RegionKind, n: number): void {
  const all = loadFixtures(region)
  const fx = sample(all, n)
  // eslint-disable-next-line no-console
  console.log(`\n========== ${region.toUpperCase()} (${all.length} fixtures, sampling ${fx.length}) ==========`)
  let correct = 0
  let emptyRaw = 0
  for (const f of fx) {
    const r = recognizeRegion(
      { region, image: f.image },
      { baseTemplates, userTemplates: emptyUser }
    )
    const raw = r.raw
    const value = r.value ? JSON.stringify(r.value) : 'null'
    const ok = raw != null && raw === f.label
    if (ok) correct++
    if (raw == null || raw === '') emptyRaw++
    // eslint-disable-next-line no-console
    console.log(
      `  label=${f.label.padEnd(8)} raw=${JSON.stringify(raw).padEnd(14)} ` +
        `value=${value.padEnd(34)} conf=${r.confidence.toFixed(2)} src=${r.source}` +
        (ok ? '  ✓' : '  ✗')
    )
  }
  // eslint-disable-next-line no-console
  console.log(
    `  --> exact-raw accuracy ${((correct / fx.length) * 100).toFixed(0)}% (${correct}/${fx.length}); ` +
      `empty-raw (total miss) ${emptyRaw}/${fx.length}`
  )
}

describe('DBG level/adena recognition with correct ROI (fixtures in directly)', () => {
  it('level: 2-digit box', () => {
    diagnose('level', 8)
  })
  it('adena: comma / long digit string', () => {
    diagnose('adena', 8)
  })
  it('exp: control (known-good in the field)', () => {
    diagnose('exp', 8)
  })
})
