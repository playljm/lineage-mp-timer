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
  // NOTE: readdirSync without { recursive } lists direct children only, so
  // quarantined sub-folders (e.g. adena/_quarantine/ holding the dunder-named
  // label-crop-mismatch batch) are intentionally NOT loaded. Keep it that way.
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

// ---------------------------------------------------------------------------
// Session-aware train/test holdout
//
// The legacy `i % 2` split leaked sessions: readdirSync returns names in
// lexicographic order, so adjacent frames of the SAME capture burst (often the
// same on-screen value, pixel-near-identical crops) alternated into train and
// test. Measured leak before this helper existed: 95% of level test labels and
// 84% of mp test labels also appeared in train (diagnosis RC-E), inflating
// every reported accuracy. This helper splits by capture-session groups so a
// whole burst (and every fixture sharing a ground-truth label) lands entirely
// on one side.
// ---------------------------------------------------------------------------

/**
 * Extracts the capture timestamp encoded in fixture file names of the form
 * `<label>_<YYYYMMDD>_<HHMMSS>_<ms>[_v2]` and returns it as epoch-style
 * milliseconds (UTC interpretation — only relative distances matter).
 * Returns null for names without a timestamp (e.g. the dunder batches).
 */
export function fixtureTimestampMs(name: string): number | null {
  const m = /(\d{8})_(\d{6})(?:_(\d{1,3}))?(?:_v2)?$/.exec(name)
  if (!m) return null
  const d = m[1]
  const t = m[2]
  const ms = m[3] ? Number(m[3]) : 0
  return (
    Date.UTC(
      Number(d.slice(0, 4)),
      Number(d.slice(4, 6)) - 1,
      Number(d.slice(6, 8)),
      Number(t.slice(0, 2)),
      Number(t.slice(2, 4)),
      Number(t.slice(4, 6))
    ) + ms
  )
}

export interface SessionSplit<T> {
  train: T[]
  test: T[]
  /** Final session groups (each group fully on one side), for diagnostics. */
  groups: T[][]
}

/** Default burst gap: frames closer than this are the same capture session. */
export const SESSION_GAP_MS = 30_000

/**
 * Splits fixtures into train/test by SESSION GROUPS instead of `i % 2`:
 *  1. fixtures whose filename timestamps are within `gapMs` of the previous
 *     frame chain into one temporal session (transitive), and
 *  2. fixtures sharing the exact same ground-truth label are merged into one
 *     group regardless of time (identical label == identical rendered string,
 *     i.e. a pure memorization leak if it straddled the split).
 * Groups are then assigned greedily (largest first, deterministic name
 * tie-break) to whichever side currently holds fewer fixtures, train first —
 * so train/test sizes stay as balanced as the group structure allows and the
 * assignment is stable across runs/platforms.
 */
export function sessionHoldoutSplit<T extends { name: string; label: string }>(
  fixtures: T[],
  gapMs: number = SESSION_GAP_MS
): SessionSplit<T> {
  const items = [...fixtures].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const parent = items.map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b)
  }

  // 1) temporal chaining within gapMs
  const timed = items
    .map((f, i) => ({ i, ts: fixtureTimestampMs(f.name) }))
    .filter((x): x is { i: number; ts: number } => x.ts !== null)
    .sort((a, b) => a.ts - b.ts)
  for (let k = 1; k < timed.length; k++) {
    if (timed[k].ts - timed[k - 1].ts <= gapMs) union(timed[k - 1].i, timed[k].i)
  }

  // 2) identical-label merge
  const byLabel = new Map<string, number[]>()
  items.forEach((f, i) => {
    const arr = byLabel.get(f.label)
    if (arr) arr.push(i)
    else byLabel.set(f.label, [i])
  })
  for (const idxs of byLabel.values()) {
    for (let k = 1; k < idxs.length; k++) union(idxs[0], idxs[k])
  }

  // 3) collect groups, deterministic order: size desc, then first name asc
  const byRoot = new Map<number, number[]>()
  items.forEach((_, i) => {
    const r = find(i)
    const arr = byRoot.get(r)
    if (arr) arr.push(i)
    else byRoot.set(r, [i])
  })
  const groups = [...byRoot.values()]
    .map((g) => g.sort((a, b) => a - b))
    .sort((a, b) => b.length - a.length || (items[a[0]].name < items[b[0]].name ? -1 : 1))

  // 4) greedy balanced assignment (train gets ties, so train >= test)
  const train: T[] = []
  const test: T[] = []
  const outGroups: T[][] = []
  for (const g of groups) {
    const side = train.length <= test.length ? train : test
    const members = g.map((i) => items[i])
    side.push(...members)
    outGroups.push(members)
  }
  return { train, test, groups: outGroups }
}
