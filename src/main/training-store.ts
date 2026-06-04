/**
 * Training-data IO for the Tesseract LSTM fine-tuning workflow.
 *
 * Layout (all under `app.getPath('userData')/training-data`, which is writable in
 * packaged builds — unlike the project tree):
 *
 *   training-data/{mp,exp,level,adena}/<safeLabel>_<stamp>.png
 *   training-data/{mp,exp,level,adena}/<safeLabel>_<stamp>.gt.txt   (LSTM ground truth)
 *   training-data/_pending/{region}/<stamp>__<safeOcr>.png
 *   training-data/_pending/{region}/<stamp>__<safeOcr>.json         (OCR metadata)
 *
 * A "labelled" sample is ground truth ready for `lstm.train`. A "pending" sample
 * is auto-captured for later human labelling. All IO is async (`fs/promises`).
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { RegionKind } from '@core/ocr/types'
import type { PendingSample, TrainingSample } from '@shared/ipc-contract'

const TRAINING_REGIONS: readonly RegionKind[] = ['mp', 'exp', 'level', 'adena']

function isRegion(value: unknown): value is RegionKind {
  return typeof value === 'string' && (TRAINING_REGIONS as readonly string[]).includes(value)
}

function trainingRoot(): string {
  return join(app.getPath('userData'), 'training-data')
}

function trainingDir(region: RegionKind): string {
  return join(trainingRoot(), region)
}

function pendingDir(region: RegionKind): string {
  return join(trainingRoot(), '_pending', region)
}

/** Sanitise a label into a filesystem-safe stem (max 32 chars). */
function safeLabel(value: string): string {
  const cleaned = value
    .replace(/\//g, 'of')
    .replace(/\./g, 'p')
    .replace(/[^0-9A-Za-z_-]/g, '_')
    .slice(0, 32)
  return cleaned || 'unlabeled'
}

/** Sortable, collision-resistant timestamp: `YYYYMMDD_HHMMSS_mmm`. */
function timestampStr(now: number): string {
  const d = new Date(now)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const p3 = (n: number): string => String(n).padStart(3, '0')
  return (
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}` +
    `_${p3(d.getMilliseconds())}`
  )
}

/** Decode a `data:image/(png|jpeg);base64,...` URL into raw bytes. */
function decodeDataUrl(dataUrl: string): Buffer | null {
  const m = /^data:image\/(?:png|jpeg|jpg);base64,(.+)$/.exec(dataUrl)
  if (!m) return null
  return Buffer.from(m[1], 'base64')
}

/**
 * Persist a fully-labelled sample (PNG + `.gt.txt` ground truth).
 *
 * @param sample Region, PNG data URL and ground-truth label.
 * @param now    Wall-clock timestamp (ms) supplied by the caller.
 * @returns `{ ok, path }` where `path` is the written PNG, or `{ ok: false }`.
 */
export async function saveTrainingSample(
  sample: TrainingSample,
  now: number
): Promise<{ ok: boolean; path?: string }> {
  if (!isRegion(sample.region)) return { ok: false }
  const bytes = decodeDataUrl(sample.dataUrl)
  if (!bytes) return { ok: false }
  if (typeof sample.label !== 'string' || !sample.label.trim()) return { ok: false }

  try {
    const dir = trainingDir(sample.region)
    await mkdir(dir, { recursive: true })
    const base = `${safeLabel(sample.label)}_${timestampStr(now)}`
    const pngPath = join(dir, `${base}.png`)
    const gtPath = join(dir, `${base}.gt.txt`)
    await writeFile(pngPath, bytes)
    await writeFile(gtPath, `${sample.label.trim()}\n`, 'utf8')
    return { ok: true, path: pngPath }
  } catch {
    return { ok: false }
  }
}

/**
 * Persist an unlabelled (pending) sample for later human labelling.
 *
 * Stores the PNG plus a JSON sidecar holding the OCR suggestion and metadata.
 *
 * @param sample Region, PNG data URL and (optional) OCR proposal in `ocr`.
 * @param now    Wall-clock timestamp (ms) supplied by the caller.
 */
export async function savePendingSample(
  sample: TrainingSample,
  now: number
): Promise<{ ok: boolean; path?: string }> {
  if (!isRegion(sample.region)) return { ok: false }
  const bytes = decodeDataUrl(sample.dataUrl)
  if (!bytes) return { ok: false }

  try {
    const dir = pendingDir(sample.region)
    await mkdir(dir, { recursive: true })
    const stamp = timestampStr(now)
    const safeOcr = sample.ocr ? safeLabel(sample.ocr) : 'noocr'
    const base = `${stamp}__${safeOcr}`
    const pngPath = join(dir, `${base}.png`)
    const jsonPath = join(dir, `${base}.json`)
    await writeFile(pngPath, bytes)
    await writeFile(
      jsonPath,
      JSON.stringify(
        {
          region: sample.region,
          ocr: sample.ocr ?? null,
          confidence: sample.confidence ?? null,
          capturedAt: new Date(now).toISOString()
        },
        null,
        2
      ),
      'utf8'
    )
    return { ok: true, path: pngPath }
  } catch {
    return { ok: false }
  }
}

interface ListPendingOptions {
  region?: RegionKind
  includeImage?: boolean
  limit?: number
}

/**
 * List pending (unlabelled) samples, oldest first.
 *
 * @param opts.region       Restrict to one region; otherwise scan all four.
 * @param opts.includeImage Inline the PNG as a base64 data URL (`imageDataUrl`).
 * @param opts.limit        Cap the number of returned samples (pagination).
 * @returns Pending samples sorted by capture time ascending.
 */
export async function listPendingSamples(opts?: ListPendingOptions): Promise<PendingSample[]> {
  const regions: readonly RegionKind[] =
    opts?.region && isRegion(opts.region) ? [opts.region] : TRAINING_REGIONS
  const limit = typeof opts?.limit === 'number' && opts.limit > 0 ? opts.limit : Infinity
  const includeImage = opts?.includeImage === true

  const out: PendingSample[] = []
  for (const region of regions) {
    if (out.length >= limit) break
    const dir = pendingDir(region)
    let files: string[]
    try {
      files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.png')).sort()
    } catch {
      continue
    }

    for (const file of files) {
      if (out.length >= limit) break
      const base = file.replace(/\.png$/i, '')
      const pngPath = join(dir, file)

      let ocr: string | undefined
      try {
        const raw = await readFile(join(dir, `${base}.json`), 'utf8')
        const meta = JSON.parse(raw) as { ocr?: unknown }
        if (typeof meta.ocr === 'string') ocr = meta.ocr
      } catch {
        /* missing/corrupt sidecar — leave ocr undefined */
      }

      const sample: PendingSample = { region, file: pngPath, ocr }
      if (includeImage) {
        try {
          const png = await readFile(pngPath)
          sample.imageDataUrl = `data:image/png;base64,${png.toString('base64')}`
        } catch {
          /* skip image inlining on read error */
        }
      }
      out.push(sample)
    }
  }

  return out
}
