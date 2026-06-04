/**
 * Region recognizer — the priority chain that ties the OCR core together.
 *
 * Order of trust (per the renewal design):
 *   1. MP bar-pixel measurement     (when a bar ROI + calibration exist) — ~100%
 *   2. user-learned digit templates (merged over base; learned chars win outright)
 *   3. bundled base templates        (bootstrap)
 * Tesseract / cloud-vision are app-level fallbacks layered on top by the live
 * pipeline; they are intentionally NOT in the pure core.
 *
 * Merging user over base closes the v2.x "fallback hole": once a character is
 * user-learned, base templates for that character are replaced, never mixed in.
 */
import type { ParsedValue, RecognitionResult, RegionKind, RgbaImage } from './types'
import { recognizeImage } from './text-recognizer'
import { parseRegionString } from './parser'
import { mergeTemplateSets, type TemplateSet } from './template-matcher'
import { barFillToMp, type BarCalibration, type BarFillOptions } from './bar-fill'

export interface RecognizerConfig {
  /** Bundled bootstrap templates (required). */
  baseTemplates: TemplateSet
  /** Per-user learned templates (optional). Merged over base. */
  userTemplates?: TemplateSet | null
  /** Confidence below which a template read is considered unreliable. Default 0.55. */
  minConfidence?: number
}

export interface RecognizeInput {
  region: RegionKind
  /** The text ROI (the numeric crop). */
  image: RgbaImage
  /** Optional MP bar ROI — enables bar-pixel measurement for MP. */
  barImage?: RgbaImage
  /** Known max MP (required for bar-pixel -> cur). */
  maxMp?: number
  /** MP bar calibration (from a one-time 100% capture). */
  barCalibration?: BarCalibration
  barOptions?: BarFillOptions
}

function effectiveSet(cfg: RecognizerConfig): { set: TemplateSet; usedUser: boolean } {
  if (cfg.userTemplates && cfg.userTemplates.chars.length > 0) {
    return { set: mergeTemplateSets(cfg.userTemplates, cfg.baseTemplates), usedUser: true }
  }
  return { set: cfg.baseTemplates, usedUser: false }
}

export function recognizeRegion(input: RecognizeInput, cfg: RecognizerConfig): RecognitionResult {
  const { region } = input
  const minConfidence = cfg.minConfidence ?? 0.55

  // 1) MP bar-pixel — the most reliable MP source.
  if (region === 'mp' && input.barImage && input.barCalibration && input.maxMp && input.maxMp > 0) {
    const cur = barFillToMp(input.barImage, input.maxMp, input.barCalibration, input.barOptions)
    const value: ParsedValue = { kind: 'mp', cur, max: input.maxMp }
    return {
      region,
      raw: `${cur}/${input.maxMp}`,
      value,
      confidence: 0.95,
      source: 'bar-pixel',
      note: 'MP bar pixel measurement'
    }
  }

  // 2/3) Template recognition (user merged over base, or base alone).
  const { set, usedUser } = effectiveSet(cfg)
  const rec = recognizeImage(input.image, set, region)
  const value = parseRegionString(region, rec.text)
  const source = usedUser ? 'user-template' : 'base-template'

  return {
    region,
    raw: rec.text || null,
    value,
    confidence: value ? rec.meanConfidence : Math.min(rec.meanConfidence, minConfidence * 0.5),
    source,
    glyphs: rec.glyphs,
    note: value ? undefined : 'parse failed or low confidence'
  }
}
