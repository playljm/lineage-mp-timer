/**
 * dbg-mp-frontedge — 실기 프레임에서 MP 바 채움 측정이 왜 저-MP 에서 크게 낮게
 * 읽히는지(실제 30→17, 50→31, near-full 은 정확) 직접 관찰. 동일 프레임의
 * "cur/max 텍스트(=실제값)"와 바-픽셀 측정을 함께 덤프해 ground-truth 대조.
 *
 * 입력: C:/dev/tmp/lc-mp-low.png (capture-window.ps1 -ProcName LC). 없으면 skip.
 * 사용자 보정값: fullColumns=252, refColor=rgb(121,124,150), maxMp=327.
 */
import { describe, it } from 'vitest'
import { existsSync } from 'node:fs'
import { loadPngAsRgba } from '../helpers/fixtures'
import { detectGameUiScaled } from '@core/ocr/roi-detector'
import { recognizeRegion } from '@core/ocr/recognizer'
import baseTemplatesData from '@core/ocr/base-templates.json'
import { deserializeTemplates, type SerializedTemplateSet, type TemplateSet } from '@core/ocr/template-matcher'
import {
  computeBarFill,
  detectGaugeRowBand,
  detectFillColor,
  detectEmptyColor,
  cropRows,
  type Rgb,
  type RowBand
} from '@core/ocr/bar-fill'
import { cropImage } from '@core/ocr/imaging'
import type { RgbaImage } from '@core/ocr/types'

const FRAME = 'C:/dev/tmp/game-110.png'
const CAL = { fullColumns: 252, fillColor: { r: 121, g: 124, b: 150 } as Rgb }
const MAX_MP = 327

function dist(a: Rgb, r: number, g: number, b: number): number {
  return Math.round(Math.sqrt((a.r - r) ** 2 + (a.g - g) ** 2 + (a.b - b) ** 2))
}

function blueMaskAscii(img: RgbaImage, label: string, maxCols = 130): void {
  const { width, height, data } = img
  const stepX = Math.max(1, Math.floor(width / maxCols))
  console.log(`\n-- ${label}: blue-mask (b>max(r,g)+8) ${width}x${height} xstep=${stepX} --`)
  for (let y = 0; y < height; y++) {
    let row = ''
    for (let x = 0; x < width; x += stepX) {
      const p = (y * width + x) * 4
      const r = data[p]!
      const g = data[p + 1]!
      const b = data[p + 2]!
      row += b > Math.max(r, g) + 8 ? '#' : '.'
    }
    console.log(`y${String(y).padStart(2)} ${row}`)
  }
}

/** Brightness mask — shows white text (the "cur/max" overlay) so we can read the value. */
function brightMaskAscii(img: RgbaImage, label: string, maxCols = 130): void {
  const { width, height, data } = img
  const stepX = Math.max(1, Math.floor(width / maxCols))
  console.log(`\n-- ${label}: bright-mask (lum>180) ${width}x${height} xstep=${stepX} --`)
  for (let y = 0; y < height; y++) {
    let row = ''
    for (let x = 0; x < width; x += stepX) {
      const p = (y * width + x) * 4
      const lum = 0.299 * data[p]! + 0.587 * data[p + 1]! + 0.114 * data[p + 2]!
      row += lum > 180 ? '#' : '.'
    }
    console.log(`y${String(y).padStart(2)} ${row}`)
  }
}

describe('dbg-mp-frontedge: 실기 저-MP 프레임 바 측정 vs 텍스트(실제값)', () => {
  it('채움 영역 컬럼별 덤프 + 텍스트 ground-truth', () => {
    if (!existsSync(FRAME)) {
      console.log(`frame ${FRAME} 없음 — skip`)
      return
    }
    const frame = loadPngAsRgba(FRAME)
    console.log(`frame ${frame.width}x${frame.height}`)
    const det = detectGameUiScaled(frame)
    const mp = det.anchors.mp
    const hp = det.anchors.hp
    console.log(`anchors: mp=${mp ? `(${mp.x},${mp.y},${mp.width}x${mp.height})` : 'null'} hp=${hp ? `(${hp.x},${hp.y},${hp.width}x${hp.height})` : 'null'}`)
    console.log(`textRois.mp=${det.textRois.mp ? JSON.stringify(det.textRois.mp) : 'null'}`)
    if (!mp) return

    // ── MP TEXT (ground truth): recognize + bright mask.
    if (det.textRois.mp) {
      const t = det.textRois.mp
      const tImg = cropImage(frame, { x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1 })
      const baseTemplates: TemplateSet = deserializeTemplates(baseTemplatesData as unknown as SerializedTemplateSet)
      const rec = recognizeRegion({ region: 'mp', image: tImg }, { baseTemplates, userTemplates: null })
      console.log(`\n*** MP TEXT recognize: raw="${rec.raw}" value=${JSON.stringify(rec.value)} conf=${rec.confidence.toFixed(2)} ***`)
      brightMaskAscii(tImg, 'MP TEXT ROI', 120)
    }

    // ── MP BAR: exactly as detection.ts builds it.
    const barW = Math.max(mp.width, hp ? hp.width : 0)
    const bar = cropImage(frame, { x0: mp.x, y0: mp.y, x1: mp.x + barW, y1: mp.y + mp.height })
    console.log(`\nbar ROI ${bar.width}x${bar.height} @ (${mp.x},${mp.y})`)
    blueMaskAscii(bar, 'BAR ROI', bar.width) // 1 char/col

    const autoBand: RowBand | null = detectGaugeRowBand(bar)
    console.log(`\ngauge row band (auto): ${autoBand ? `rows ${autoBand.y0}..${autoBand.y1 - 1}` : 'null'} — FORCING rows 0..6 (live calibration band)`)
    const band: RowBand = { y0: 0, y1: 7 } // replicate the live calibration-shrunk 7px band
    const work = cropRows(bar, band)

    const auto = detectFillColor(work)
    const empty = detectEmptyColor(work, CAL.fillColor)
    console.log(`refColor: calibrated=rgb(121,124,150) auto=${auto ? `rgb(${auto.r.toFixed(0)},${auto.g.toFixed(0)},${auto.b.toFixed(0)})` : 'null'}`)
    console.log(`emptyColor=${empty ? `rgb(${empty.r.toFixed(0)},${empty.g.toFixed(0)},${empty.b.toFixed(0)})` : 'ABSOLUTE'}`)

    const res = computeBarFill(work, { refColor: CAL.fillColor })
    const cur = Math.round((MAX_MP * res.filledColumns) / CAL.fullColumns)
    console.log(`computeBarFill(calibrated ref): filled=${res.filledColumns}/${res.totalColumns} → cur=${cur}`)
    // Per-column band profile: blue-dom rows vs distance-fill rows, to see where the
    // gauge truly ends and whether blue-dominance over-reads into the track.
    {
      const { width: bw, height: bh, data: bd } = work
      let bdcells = ''
      let dfcells = ''
      let lastBlue = -1
      let lastDist = -1
      for (let x = 0; x < bw; x++) {
        let blue = 0
        let distc = 0
        for (let y = 0; y < bh; y++) {
          const p = (y * bw + x) * 4
          const r = bd[p]!, g = bd[p + 1]!, b = bd[p + 2]!
          if (b > Math.max(r, g) + 8) blue++
          if ((CAL.fillColor.r - r) ** 2 + (CAL.fillColor.g - g) ** 2 + (CAL.fillColor.b - b) ** 2 <= 70 * 70) distc++
        }
        bdcells += blue >= 3 ? '#' : blue > 0 ? '+' : '.'
        dfcells += distc >= 3 ? '#' : distc > 0 ? '+' : '.'
        if (blue >= 3) lastBlue = x
        if (distc >= 3) lastDist = x
      }
      console.log(`band blue-dom≥3 per col (last=${lastBlue}):\n${bdcells}`)
      console.log(`band dist-fill≥3 per col (last=${lastDist}):\n${dfcells}`)
    }
    const resAuto = auto ? computeBarFill(work, { refColor: auto }) : null
    if (resAuto) console.log(`computeBarFill(auto ref):       filled=${resAuto.filledColumns} → cur=${Math.round((MAX_MP * resAuto.filledColumns) / CAL.fullColumns)}`)

    // ── Column-by-column over the fill+front region (band rows), calibrated ref.
    const { width, height, data } = work
    const tol2 = 70 * 70
    const need = Math.max(1, Math.floor(height * 0.5))
    const midY = Math.floor(height / 2)
    const from = 80
    const to = Math.min(125, width - 1)
    console.log(`\nband ${width}x${height}. cols ${from}..${to} (measured front=${res.filledColumns}). per-row category counts:`)
    console.log(`x   blue white gray  | blueOrWhite (proposed full-height fill)`)
    for (let x = from; x <= to; x++) {
      let blue = 0, white = 0, gray = 0
      for (let y = 0; y < height; y++) {
        const p = (y * width + x) * 4
        const r = data[p]!, g = data[p + 1]!, b = data[p + 2]!
        const isBlue = b > Math.max(r, g) + 8
        const lm = 0.299 * r + 0.587 * g + 0.114 * b
        const isWhite = lm > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 22
        if (isBlue) blue++
        else if (isWhite) white++
        else gray++
      }
      const bw = blue + white
      console.log(`${String(x).padStart(3)}  ${blue}     ${white}     ${gray}    | ${bw}/${height} ${bw >= height ? 'FILL' : '.'}`)
    }
  })
})
