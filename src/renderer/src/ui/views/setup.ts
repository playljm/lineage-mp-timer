/**
 * Setup view — the single consolidated configuration surface. It replaces the
 * v2.x split between the input form, the preset panel, and the separate
 * developer-console OCR tab: every character/MP input, preset, OCR/auto-detect
 * control, item-drop ledger, and ALL diagnostics now live here in five cards.
 *
 * Like every view it renders FROM the store and writes back through the store
 * (`ctx.app.setMpConfig` / `setTracker` / `store.set`). Listeners are wired once
 * in the factory; `update(state)` only pushes fresh values into existing nodes.
 */
import { h, clear } from '../dom'
import { LOCATION_LABEL, STATE_LABEL, type LocationKind, type MovementState } from '@core/domain/mp-engine'
import type { View, ViewContext } from '../view'
import type { AppState } from '../../state/store'
import type {
  MpConfigState,
  CaptureRegion,
  ItemEntry,
  AutoDetectState,
  CaptureMode,
  WindowRoiOverrides,
  WindowRoiBox
} from '@core/domain/storage-schema'
import type { WindowInfo } from '@shared/ipc-contract'
import type { DetectionEvent } from '../../ocr/detection'
import { logger } from '../../util/logger'
import { parseRegionString, formatParsed } from '@core/ocr/parser'
import type { ParsedValue } from '@core/ocr/types'

/** The `autoDetect` fields that hold a pickable capture region. */
type RegionKey = keyof Pick<
  AutoDetectState,
  'mpRegion' | 'mpBarRegion' | 'expRegion' | 'levelRegion' | 'adenaRegion' | 'gameRegion'
>

/** Region picker targets, paired with the persisted `autoDetect` field each one fills. */
const REGION_TARGETS: ReadonlyArray<{
  target: 'mp' | 'mpBar' | 'exp' | 'level' | 'adena' | 'game'
  key: RegionKey
  label: string
}> = [
  { target: 'mp', key: 'mpRegion', label: 'MP 숫자' },
  { target: 'mpBar', key: 'mpBarRegion', label: 'MP 바' },
  { target: 'exp', key: 'expRegion', label: 'EXP' },
  { target: 'level', key: 'levelRegion', label: '레벨' },
  { target: 'adena', key: 'adenaRegion', label: '아데나' },
  { target: 'game', key: 'gameRegion', label: '게임 화면' }
]

/** localStorage key for user-learned digit templates (shared with DetectionController). */
const USER_TEMPLATE_KEY = 'lmp.userTemplates.v3'

/** Max diagnostic events kept in the ring buffer rendered by the advanced drawer. */
const DIAG_RING = 15

/** A labelled number field bound to a numeric `mpConfig` key. */
interface NumField {
  root: HTMLElement
  input: HTMLInputElement
}

function numField(
  label: string,
  opts: { min?: number; max?: number; step?: number },
  onChange: (value: number) => void
): NumField {
  const input = h('input', {
    type: 'number',
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 1,
    oninput: () => onChange(input.valueAsNumber)
  })
  const root = h('div', { class: 'field' }, h('label', {}, label), input)
  return { root, input }
}

/** A design-system toggle whose checked state is driven from the store in `update`. */
interface ToggleField {
  root: HTMLElement
  set(checked: boolean): void
}

function toggleField(label: string, onChange: (checked: boolean) => void): ToggleField {
  const root = h('button', {
    class: 'toggle',
    type: 'button',
    role: 'switch',
    'aria-checked': 'false',
    onclick: () => {
      const next = root.getAttribute('aria-checked') !== 'true'
      root.setAttribute('aria-checked', String(next))
      onChange(next)
    }
  },
    h('span', { class: 'toggle__track' }, h('span', { class: 'toggle__thumb' })),
    h('span', {}, label)
  )
  return {
    root,
    set(checked) {
      root.setAttribute('aria-checked', String(checked))
    }
  }
}

/** A labelled `<select>` whose value is pushed from the store in `update`. */
function selectField<T extends string>(
  label: string,
  options: ReadonlyArray<{ value: T; label: string }>,
  onChange: (value: T) => void
): { root: HTMLElement; select: HTMLSelectElement } {
  const select = h('select', {
    onchange: () => onChange(select.value as T)
  }, ...options.map((o) => h('option', { value: o.value }, o.label)))
  const root = h('div', { class: 'field' }, h('label', {}, label), select)
  return { root, select }
}

export function createSetupView(ctx: ViewContext): View {
  const { app, actions, detection } = ctx

  // Per-region freshest OCR output mirrored into the learn rows: `latestRaw` is the
  // exact segmented string (used to prefill non-EXP rows so the glyph count matches
  // at learn time), `latestNorm` is the parsed/normalized value (shown in the hint
  // and used to prefill EXP, whose trailing "%" the learn path slices off).
  type LRegion = 'mp' | 'exp' | 'level' | 'adena'
  const latestRaw: Partial<Record<LRegion, string | null>> = {}
  /** Normalized (parsed) value per region — the clean value the user actually wants. */
  const latestNorm: Partial<Record<LRegion, string | null>> = {}
  /** Whether the latest OCR observation for the region was ACCEPTED (adopted) or rejected/locked. */
  const lastAccepted: Partial<Record<LRegion, boolean>> = {}
  const rawHints: Partial<Record<LRegion, HTMLElement>> = {}

  /** The value the app is actually USING for a region (tracker/mpConfig), as a string. */
  function usedValueFor(region: LRegion): string {
    const s = app.get().persisted
    if (region === 'mp') return `${s.mpConfig.curMp}/${s.mpConfig.maxMp}`
    const t = s.tracker.current
    if (region === 'exp') return `${t.exp.toFixed(4)}%`
    if (region === 'level') return String(t.level)
    return t.adena.toLocaleString('en-US')
  }

  /**
   * Compose the learn-row hint to show the value the app actually USES — not the raw
   * OCR string. When the latest OCR read was rejected/locked (e.g. a manually-typed
   * value is pinned, or the ROI misreads), also surface the ignored OCR read so the
   * user can still see what the camera reads while diagnosing.
   */
  function updateHint(region: LRegion): void {
    const hint = rawHints[region]
    if (!hint) return
    const used = usedValueFor(region)
    const raw = latestRaw[region]
    if (lastAccepted[region]) {
      hint.textContent = `인식: ${used}` // accepted → used value IS the OCR value
    } else if (raw != null && raw !== '') {
      hint.textContent = `사용: ${used} · OCR ${raw}(무시)`
    } else {
      hint.textContent = `사용: ${used}`
    }
    hint.title = raw == null ? '' : `원본 OCR: ${raw}`
  }

  /** Commit an mpConfig patch and re-anchor the countdown. */
  const patchMp = (patch: Partial<MpConfigState>): void => {
    app.setMpConfig(patch)
    actions.recomputeTimer()
  }

  // -------------------------------------------------------------------------
  // 1) 캐릭터 / MP
  // -------------------------------------------------------------------------
  const fMaxMp = numField('최대 MP', { min: 1 }, (v) => patchMp({ maxMp: Number.isFinite(v) ? v : 1 }))
  const fCurMp = numField('현재 MP', { min: 0 }, (v) => patchMp({ curMp: Number.isFinite(v) ? v : 0 }))
  const fWis = numField('WIS', { min: 1, max: 30 }, (v) => patchMp({ wis: Number.isFinite(v) ? v : 15 }))

  const tBluePotion = toggleField('파란물약', (on) => patchMp({ useBluePotion: on }))
  const tMeditation = toggleField('메디테이션', (on) => patchMp({ useMeditation: on }))
  const tCrystalStaff = toggleField('수정 지팡이', (on) => patchMp({ hasCrystalStaff: on }))

  const locationOptions: ReadonlyArray<{ value: LocationKind; label: string }> = [
    { value: 'field', label: LOCATION_LABEL.field },
    { value: 'tavern', label: LOCATION_LABEL.tavern },
    { value: 'dungeon', label: LOCATION_LABEL.dungeon },
    { value: 'custom', label: LOCATION_LABEL.custom }
  ]
  const fLocation = selectField('위치', locationOptions, (v) => patchMp({ location: v }))
  const fCustomBonus = numField('직접 입력 보너스 (MP/틱)', { min: -20, max: 50 }, (v) =>
    patchMp({ customLocationBonus: Number.isFinite(v) ? v : 0 })
  )

  const stateOptions: ReadonlyArray<{ value: MovementState; label: string }> = [
    { value: 'standing', label: STATE_LABEL.standing },
    { value: 'moving', label: STATE_LABEL.moving },
    { value: 'combat', label: STATE_LABEL.combat },
    { value: 'blocked', label: STATE_LABEL.blocked }
  ]
  const fState = selectField('상태', stateOptions, (v) => patchMp({ state: v }))

  const characterCard = h('section', { class: 'card' },
    h('div', { class: 'card__title' }, '캐릭터 / MP'),
    h('div', { class: 'form-grid' }, fMaxMp.root, fCurMp.root, fWis.root),
    h('div', { class: 'row' }, tBluePotion.root, tMeditation.root, tCrystalStaff.root),
    h('div', { class: 'form-grid' }, fLocation.root, fCustomBonus.root, fState.root)
  )

  // -------------------------------------------------------------------------
  // 2) 프리셋
  // -------------------------------------------------------------------------
  /** Subset of mpConfig captured by "현재 설정 저장" (countdown-affecting fields). */
  const presetSubset = (c: MpConfigState): Partial<MpConfigState> => ({
    maxMp: c.maxMp,
    wis: c.wis,
    useBluePotion: c.useBluePotion,
    useMeditation: c.useMeditation,
    hasCrystalStaff: c.hasCrystalStaff,
    location: c.location,
    customLocationBonus: c.customLocationBonus,
    state: c.state
  })

  const savePreset = (): void => {
    const name = window.prompt('프리셋 이름')?.trim()
    if (!name) return
    const config = presetSubset(app.get().persisted.mpConfig)
    app.store.set((prev) => ({
      persisted: { ...prev.persisted, presets: [...prev.persisted.presets, { name, config }] }
    }))
  }

  const presetList = h('div', { class: 'row' })
  const presetCard = h('section', { class: 'card' },
    h('div', { class: 'card__title' }, '프리셋'),
    h('div', { class: 'row' },
      h('button', { class: 'btn btn--primary btn--sm', onclick: savePreset }, '현재 설정 저장')
    ),
    presetList
  )

  function renderPresets(state: AppState): void {
    clear(presetList)
    const { presets } = state.persisted
    if (presets.length === 0) {
      presetList.appendChild(h('span', { class: 'tick-info' }, '저장된 프리셋이 없습니다.'))
      return
    }
    presets.forEach((preset, index) => {
      const apply = h('button', {
        class: 'btn btn--sm',
        onclick: () => {
          app.setMpConfig(preset.config)
          actions.recomputeTimer()
        }
      }, preset.name)
      const remove = h('button', {
        class: 'btn btn--ghost btn--sm',
        title: '삭제',
        'aria-label': `${preset.name} 삭제`,
        onclick: () => {
          app.store.set((prev) => ({
            persisted: {
              ...prev.persisted,
              presets: prev.persisted.presets.filter((_, i) => i !== index)
            }
          }))
        }
      }, '✕')
      presetList.appendChild(h('span', { class: 'row' }, apply, remove))
    })
  }

  // -------------------------------------------------------------------------
  // 3) 화면 인식 (OCR) — consolidated, replaces the v2.x developer console
  // -------------------------------------------------------------------------
  const tDetectMode = toggleField('자동 인식 모드', (on) => {
    app.store.set((prev) => ({
      persisted: {
        ...prev.persisted,
        autoDetect: { ...prev.persisted.autoDetect, mode: on ? 'auto' : 'manual' }
      }
    }))
  })

  /** Per-target row: a status dot, label + coords, and a "영역 지정" button. */
  interface RegionRow {
    root: HTMLElement
    dot: HTMLElement
    coords: HTMLElement
  }
  const regionRows = new Map<RegionKey, RegionRow>()
  const regionGrid = h('div', { class: 'form-grid' })
  for (const { target, key, label } of REGION_TARGETS) {
    const dot = h('span', { class: 'dot dot--off' })
    const coords = h('span', { class: 'tick-info' }, '미지정')
    const pick = h('button', {
      class: 'btn btn--sm',
      onclick: () => {
        void actions.pickRegion(target).catch((err) => console.error('[setup.pickRegion]', err))
      }
    }, '영역 지정')
    const root = h('div', { class: 'field' },
      h('label', {}, h('span', { class: 'row' }, dot, label)),
      h('div', { class: 'row' }, pick, coords)
    )
    regionGrid.appendChild(root)
    regionRows.set(key, { root, dot, coords })
  }

  // --- capture mode: screen region vs game window (auto-detect) ---
  const captureModeOptions: ReadonlyArray<{ value: CaptureMode; label: string }> = [
    { value: 'screen', label: '화면 영역 (수동 지정)' },
    { value: 'window', label: '게임 창 (자동 인식)' }
  ]
  const fCaptureMode = selectField<CaptureMode>('캡처 방식', captureModeOptions, (mode) => {
    app.store.set((prev) => ({
      persisted: { ...prev.persisted, autoDetect: { ...prev.persisted.autoDetect, captureMode: mode } }
    }))
    applyCaptureModeUi(mode)
    if (mode === 'window') void refreshWindows()
    maybeRestartDetection()
  })

  // Game-window picker (window mode only).
  const windowSelect = h('select', {
    onchange: () => {
      const opt = windowSelect.selectedOptions[0]
      const id = windowSelect.value || null
      const title = opt ? (opt.dataset.title ?? opt.textContent ?? '') : ''
      app.store.set((prev) => ({
        persisted: {
          ...prev.persisted,
          autoDetect: { ...prev.persisted.autoDetect, windowId: id, windowTitle: title || null }
        }
      }))
      windowStatus.textContent = title ? `선택됨: ${title}` : ''
      maybeRestartDetection()
    }
  }) as HTMLSelectElement
  const windowStatus = h('span', { class: 'tick-info' }, '')
  const btnRefreshWin = h('button', { class: 'btn btn--sm', onclick: () => void refreshWindows() }, '🔄 목록 새로고침')
  const btnRematchWin = h('button', { class: 'btn btn--sm btn--ghost', onclick: () => void rematchWindow() }, '재매칭')

  const windowSection = h('div', { class: 'tab-pane' },
    h('div', { class: 'tick-info' }, '게임 창을 한 번 선택하면 제목으로 자동 재매칭됩니다 — 모니터와 무관, 창을 다른 모니터로 옮겨도 OK. 게임은 창/테두리없음 모드로 실행하세요(전체화면 독점은 검은 화면).'),
    h('div', { class: 'field' }, h('label', {}, '게임 창'), windowSelect),
    h('div', { class: 'row' }, btnRefreshWin, btnRematchWin, windowStatus)
  )

  const LINEAGE_RE = /lineage|리니지/i

  function applyCaptureModeUi(mode: CaptureMode): void {
    const win = mode === 'window'
    windowSection.style.display = win ? '' : 'none'
    roiEditor.style.display = win ? '' : 'none'
    regionGrid.style.display = win ? 'none' : ''
  }

  async function refreshWindows(): Promise<void> {
    windowStatus.textContent = '창 목록 불러오는 중…'
    let wins: WindowInfo[] = []
    try {
      wins = await ctx.api.listWindows()
    } catch {
      windowStatus.textContent = '창 목록을 불러올 수 없습니다 (Electron 외 환경?)'
      return
    }
    clear(windowSelect)
    if (wins.length === 0) {
      windowStatus.textContent = '캡처 가능한 창이 없습니다 (게임 실행 + 창모드 확인)'
      return
    }
    for (const w of wins) {
      const o = h('option', { value: w.id }, w.title) as HTMLOptionElement
      o.dataset.title = w.title
      windowSelect.appendChild(o)
    }
    const saved = app.get().persisted.autoDetect.windowTitle
    const pick =
      (saved ? wins.find((w) => w.title === saved) : undefined) ??
      wins.find((w) => LINEAGE_RE.test(w.title)) ??
      wins[0]
    if (pick) {
      windowSelect.value = pick.id
      const autoMatched = !saved && LINEAGE_RE.test(pick.title)
      app.store.set((prev) => ({
        persisted: {
          ...prev.persisted,
          autoDetect: { ...prev.persisted.autoDetect, windowId: pick.id, windowTitle: pick.title }
        }
      }))
      windowStatus.textContent = autoMatched ? `자동 매칭: ${pick.title}` : `선택됨: ${pick.title}`
    }
  }

  async function rematchWindow(): Promise<void> {
    const title = app.get().persisted.autoDetect.windowTitle ?? ''
    windowStatus.textContent = '재매칭 중…'
    try {
      const res = await ctx.api.resolveWindowSource(title)
      if (res) {
        app.store.set((prev) => ({
          persisted: {
            ...prev.persisted,
            autoDetect: {
              ...prev.persisted.autoDetect,
              windowId: res.sourceId,
              windowTitle: prev.persisted.autoDetect.windowTitle || res.title
            }
          }
        }))
        windowStatus.textContent = `재매칭 OK: ${res.title}`
      } else {
        windowStatus.textContent = '재매칭 실패 — 목록에서 직접 선택하세요'
      }
    } catch {
      windowStatus.textContent = '재매칭 불가 (Electron 외 환경)'
    }
  }

  /** Restart the detection loop so a capture-source change takes effect immediately. */
  function maybeRestartDetection(): void {
    if (!detection.running) return
    detection.stop()
    void detection.start().catch((err) => console.error('[setup.detect.restart]', err))
  }

  /** One-time auto-load of the window list when the view first renders in window mode. */
  let windowsInitialized = false

  // --- manual ROI editor (window mode): draw ROI boxes on a window snapshot ----
  // The snapshot is the window's native-resolution frame, so it is shown at 1:1 in a
  // scrollable viewport and box coords ARE window-frame physical px (no scaling) —
  // exactly what captureRegion crops. Overrides win over auto-detection.
  const ROI_REGIONS: ReadonlyArray<{ value: keyof WindowRoiOverrides; label: string }> = [
    { value: 'mp', label: 'MP 숫자' },
    { value: 'mpBar', label: 'MP 바' },
    { value: 'exp', label: 'EXP' },
    { value: 'level', label: '레벨' },
    { value: 'adena', label: '아데나' }
  ]
  let roiActiveRegion: keyof WindowRoiOverrides = 'exp'
  let roiFrame: { width: number; height: number } | null = null

  const fRoiRegion = selectField<keyof WindowRoiOverrides>('지정할 항목', ROI_REGIONS, (v) => {
    roiActiveRegion = v
    drawRoiBoxes()
  })
  const roiStatus = h('span', { class: 'tick-info' }, '게임 화면을 먼저 불러오세요')
  const roiOverrideStatus = h('span', { class: 'tick-info' }, '')
  const btnLoadFrame = h('button', { class: 'btn btn--sm btn--primary', onclick: () => void loadRoiFrame() }, '📷 게임 화면 불러오기')
  const btnClearRoi = h('button', { class: 'btn btn--sm btn--ghost', onclick: () => clearRoi() }, '선택 영역 자동으로')
  fRoiRegion.select.value = roiActiveRegion

  const roiImg = h('img', { alt: '게임 화면', draggable: false, style: { display: 'block', maxWidth: 'none', userSelect: 'none' } })
  const roiBoxLayer = h('div', { style: { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none' } })
  const roiStage = h('div', { style: { position: 'relative', width: 'max-content' } }, roiImg, roiBoxLayer)
  const roiViewport = h('div', {
    style: {
      overflow: 'auto',
      maxHeight: '380px',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-sm)',
      background: 'var(--bg)',
      cursor: 'crosshair'
    }
  }, roiStage)

  const roiEditor = h('details', { class: 'drawer' },
    h('summary', {}, '🎯 영역 직접 지정 (정밀)'),
    h('div', { class: 'stack' },
      h('div', { class: 'tick-info' }, '게임 화면을 불러온 뒤, 항목을 고르고 이미지 위에서 영역을 드래그하세요. 지정한 영역은 자동 검출 대신 그대로 사용됩니다 (숫자에 딱 맞게, %·여백 제외). 이후 「보정·학습」에서 글자를 가르치면 더 정확해집니다.'),
      h('div', { class: 'row' }, fRoiRegion.root, btnLoadFrame, btnClearRoi),
      h('div', { class: 'row' }, roiOverrideStatus),
      h('div', { class: 'row' }, roiStatus),
      roiViewport
    )
  )

  function updateRoiOverrideStatus(): void {
    const ov = app.get().persisted.autoDetect.windowRoi
    const set = ROI_REGIONS.filter((r) => ov[r.value]).map((r) => r.label)
    roiOverrideStatus.textContent = set.length
      ? `직접 지정됨: ${set.join(', ')}`
      : '직접 지정된 영역 없음 (자동 검출 사용)'
  }

  function labelForRoi(region: keyof WindowRoiOverrides): string {
    return ROI_REGIONS.find((r) => r.value === region)?.label ?? region
  }

  async function loadRoiFrame(): Promise<void> {
    roiStatus.textContent = '불러오는 중…'
    const frame = await detection.captureWindowFrame().catch(() => null)
    if (!frame) {
      roiStatus.textContent = '게임 화면을 불러오지 못했습니다 (게임 창 선택/실행 확인)'
      return
    }
    roiFrame = { width: frame.width, height: frame.height }
    roiImg.onload = (): void => drawRoiBoxes()
    roiImg.src = frame.dataUrl
    roiStatus.textContent = `불러옴 (${frame.width}×${frame.height}). 항목 선택 후 드래그하세요`
    drawRoiBoxes()
  }

  function saveRoi(region: keyof WindowRoiOverrides, box: WindowRoiBox | null): void {
    app.store.set((prev) => ({
      persisted: {
        ...prev.persisted,
        autoDetect: {
          ...prev.persisted.autoDetect,
          windowRoi: { ...prev.persisted.autoDetect.windowRoi, [region]: box }
        }
      }
    }))
    detection.forceRoiRefresh()
    drawRoiBoxes()
    updateRoiOverrideStatus()
  }

  function clearRoi(): void {
    saveRoi(roiActiveRegion, null)
    roiStatus.textContent = `${labelForRoi(roiActiveRegion)} 자동 검출로 되돌림`
  }

  function drawRoiBoxes(): void {
    clear(roiBoxLayer)
    if (!roiFrame) return
    const ov = app.get().persisted.autoDetect.windowRoi
    for (const { value, label } of ROI_REGIONS) {
      const b = ov[value]
      if (!b) continue
      const active = value === roiActiveRegion
      const color = active ? 'var(--accent)' : 'var(--color-info)'
      const box = h('div', {
        style: {
          position: 'absolute',
          left: `${b.x}px`,
          top: `${b.y}px`,
          width: `${b.width}px`,
          height: `${b.height}px`,
          border: `2px solid ${color}`,
          background: active ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
          boxSizing: 'border-box',
          pointerEvents: 'none'
        }
      }, h('span', {
        style: {
          position: 'absolute',
          top: '-15px',
          left: '0',
          fontSize: '10px',
          lineHeight: '1',
          color,
          whiteSpace: 'nowrap',
          textShadow: '0 0 3px #000'
        }
      }, label))
      roiBoxLayer.appendChild(box)
    }
  }

  // Drag-to-draw a rectangle for the active region (coords are frame px @ 1:1).
  let roiDrawing = false
  let roiStartX = 0
  let roiStartY = 0
  let roiRubber: HTMLElement | null = null

  function roiImgPoint(e: MouseEvent): { x: number; y: number } {
    const r = roiImg.getBoundingClientRect()
    const fw = roiFrame?.width ?? r.width
    const fh = roiFrame?.height ?? r.height
    return {
      x: Math.round(Math.max(0, Math.min(fw, e.clientX - r.left))),
      y: Math.round(Math.max(0, Math.min(fh, e.clientY - r.top)))
    }
  }

  const onRoiDown = (e: MouseEvent): void => {
    if (!roiFrame || e.button !== 0) return
    e.preventDefault()
    roiDrawing = true
    const p = roiImgPoint(e)
    roiStartX = p.x
    roiStartY = p.y
    roiRubber = h('div', {
      style: {
        position: 'absolute',
        left: `${p.x}px`,
        top: `${p.y}px`,
        width: '0',
        height: '0',
        border: '2px dashed var(--accent)',
        background: 'color-mix(in srgb, var(--accent) 20%, transparent)',
        boxSizing: 'border-box',
        pointerEvents: 'none'
      }
    })
    roiBoxLayer.appendChild(roiRubber)
  }
  const onRoiMove = (e: MouseEvent): void => {
    if (!roiDrawing || !roiRubber) return
    const p = roiImgPoint(e)
    const x = Math.min(p.x, roiStartX)
    const y = Math.min(p.y, roiStartY)
    roiRubber.style.left = `${x}px`
    roiRubber.style.top = `${y}px`
    roiRubber.style.width = `${Math.abs(p.x - roiStartX)}px`
    roiRubber.style.height = `${Math.abs(p.y - roiStartY)}px`
  }
  const onRoiUp = (e: MouseEvent): void => {
    if (!roiDrawing) return
    roiDrawing = false
    const p = roiImgPoint(e)
    const x = Math.min(p.x, roiStartX)
    const y = Math.min(p.y, roiStartY)
    const w = Math.abs(p.x - roiStartX)
    const hgt = Math.abs(p.y - roiStartY)
    if (roiRubber) {
      roiRubber.remove()
      roiRubber = null
    }
    if (w >= 4 && hgt >= 4) {
      saveRoi(roiActiveRegion, { x, y, width: w, height: hgt })
      roiStatus.textContent = `${labelForRoi(roiActiveRegion)} 지정됨: ${w}×${hgt} @ (${x}, ${y})`
    }
  }
  roiStage.addEventListener('mousedown', onRoiDown)
  window.addEventListener('mousemove', onRoiMove)
  window.addEventListener('mouseup', onRoiUp)

  const tUseMpBar = toggleField('MP 바 픽셀 모드', (on) => {
    app.store.set((prev) => ({
      persisted: {
        ...prev.persisted,
        autoDetect: { ...prev.persisted.autoDetect, useMpBar: on }
      }
    }))
  })

  const fIntervalMs = numField('인식 간격 (ms)', { min: 300, step: 100 }, (v) => {
    const intervalMs = Number.isFinite(v) ? Math.max(300, v) : 1000
    app.store.set((prev) => ({
      persisted: { ...prev.persisted, autoDetect: { ...prev.persisted.autoDetect, intervalMs } }
    }))
  })
  const fStability = numField('안정성 횟수', { min: 1, max: 20 }, (v) => {
    const stabilityRequired = Number.isFinite(v) ? Math.max(1, v) : 3
    app.store.set((prev) => ({
      persisted: { ...prev.persisted, autoDetect: { ...prev.persisted.autoDetect, stabilityRequired } }
    }))
  })

  const detectStatus = h('span', { class: 'tick-info' }, '정지됨')
  const btnDetect = h('button', { class: 'btn btn--primary', onclick: () => toggleDetection() }, '▶ 자동 인식 시작')

  function toggleDetection(): void {
    const enabled = !app.get().persisted.autoDetect.enabled
    app.store.set((prev) => ({
      persisted: { ...prev.persisted, autoDetect: { ...prev.persisted.autoDetect, enabled } }
    }))
    if (enabled) void detection.start().catch((err) => console.error('[setup.detect.start]', err))
    else detection.stop()
  }

  const ocrCard = h('section', { class: 'card' },
    h('div', { class: 'card__title' }, '화면 인식 (OCR)'),
    h('div', { class: 'row' }, tDetectMode.root),
    h('div', { class: 'form-grid' }, fCaptureMode.root),
    windowSection,
    roiEditor,
    regionGrid,
    h('div', { class: 'row' }, tUseMpBar.root),
    h('div', { class: 'tick-info' }, 'MP 바 픽셀 모드는 가장 정확한 MP 인식 소스입니다.'),
    h('div', { class: 'form-grid' }, fIntervalMs.root, fStability.root),
    h('div', { class: 'row' }, btnDetect, detectStatus)
  )

  // -------------------------------------------------------------------------
  // 4) 아이템 판매 합산
  // -------------------------------------------------------------------------
  const patchItem = (id: string, patch: Partial<ItemEntry>): void => {
    app.store.set((prev) => ({
      persisted: {
        ...prev.persisted,
        items: prev.persisted.items.map((it) => (it.id === id ? { ...it, ...patch } : it))
      }
    }))
  }

  const itemRows = h('div', { class: 'tab-pane' })
  const itemTotal = h('span', { class: 'stat-chip__value stat-chip__value--accent' }, '0')
  const btnAddAdena = h('button', { class: 'btn btn--sm', onclick: () => addToAdena() }, '아데나에 더하기')

  function totalOf(items: readonly ItemEntry[]): number {
    return items.reduce((sum, it) => sum + it.price * it.qty, 0)
  }

  function addToAdena(): void {
    const total = totalOf(app.get().persisted.items)
    if (total <= 0) return
    const current = app.get().persisted.tracker.current
    app.setTracker({ current: { ...current, adena: current.adena + total } })
  }

  const itemCard = h('section', { class: 'card' },
    h('div', { class: 'card__title' }, '아이템 판매 합산'),
    itemRows,
    h('div', { class: 'row' },
      h('div', { class: 'stat-chip' }, h('span', { class: 'stat-chip__label' }, '합계 (아데나)'), itemTotal),
      btnAddAdena
    )
  )

  /** Per-item editable inputs, keyed by id so `update` can re-sync values. */
  interface ItemFieldRow {
    root: HTMLElement
    name: HTMLInputElement
    price: HTMLInputElement
    qty: HTMLInputElement
  }
  const itemFieldRows = new Map<string, ItemFieldRow>()

  function buildItemRows(items: readonly ItemEntry[]): void {
    clear(itemRows)
    itemFieldRows.clear()
    for (const it of items) {
      const name = h('input', {
        type: 'text',
        value: it.name,
        oninput: () => patchItem(it.id, { name: name.value })
      })
      const price = h('input', {
        type: 'number',
        min: 0,
        value: String(it.price),
        oninput: () => patchItem(it.id, { price: Number.isFinite(price.valueAsNumber) ? price.valueAsNumber : 0 })
      })
      const qty = h('input', {
        type: 'number',
        min: 0,
        value: String(it.qty),
        oninput: () => patchItem(it.id, { qty: Number.isFinite(qty.valueAsNumber) ? qty.valueAsNumber : 0 })
      })
      const root = h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', {}, '이름'), name),
        h('div', { class: 'field' }, h('label', {}, '가격'), price),
        h('div', { class: 'field' }, h('label', {}, '수량'), qty)
      )
      itemRows.appendChild(root)
      itemFieldRows.set(it.id, { root, name, price, qty })
    }
  }

  /** Rebuild item rows only when the set of item ids changes (avoids clobbering focus). */
  let itemIdsKey = ''
  function syncItems(items: readonly ItemEntry[]): void {
    const key = items.map((i) => i.id).join('|')
    if (key !== itemIdsKey) {
      itemIdsKey = key
      buildItemRows(items)
    } else {
      for (const it of items) {
        const row = itemFieldRows.get(it.id)
        if (!row) continue
        if (document.activeElement !== row.name) row.name.value = it.name
        if (document.activeElement !== row.price) row.price.value = String(it.price)
        if (document.activeElement !== row.qty) row.qty.value = String(it.qty)
      }
    }
    itemTotal.textContent = totalOf(items).toLocaleString('en-US')
  }

  // -------------------------------------------------------------------------
  // 5) 고급 · 진단 (collapsed drawer; ALL diagnostics live here)
  // -------------------------------------------------------------------------
  const diagRing: DetectionEvent[] = []
  const diagLog = h('div', {
    style: {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-xs)',
      whiteSpace: 'pre-wrap',
      maxHeight: '220px',
      overflowY: 'auto'
    }
  })

  function renderDiagLog(): void {
    clear(diagLog)
    if (diagRing.length === 0) {
      diagLog.appendChild(h('div', { class: 'tick-info' }, '아직 인식 이벤트가 없습니다.'))
      return
    }
    for (const e of diagRing) {
      const ok = e.accepted ? 'OK ' : 'rej'
      const raw = e.raw == null ? '∅' : e.raw
      const line = `[${ok}] ${e.region.padEnd(5)} raw=${raw} post=${e.posterior.toFixed(2)} (${e.reason})`
      diagLog.appendChild(
        h('div', { class: e.accepted ? 'stat-chip__value--accent' : undefined }, line)
      )
    }
  }

  const offDetect = detection.onEvent((e) => {
    diagRing.push(e)
    if (diagRing.length > DIAG_RING) diagRing.shift()
    renderDiagLog()
    // Track the freshest OCR output; the hint shows the value the app actually USES
    // (so a pinned/typed value matches what's displayed), with the ignored OCR read
    // surfaced for diagnosis. `latestRaw` also feeds the 인식값↩ prefill.
    latestRaw[e.region] = e.raw
    latestNorm[e.region] = e.value ? formatParsed(e.value) : null
    lastAccepted[e.region] = e.accepted
    updateHint(e.region)
  })

  // 0-9 user-learned-digit grid placeholder.
  const digitGrid = h('div', { class: 'row' })
  function renderDigitGrid(): void {
    clear(digitGrid)
    const learned = loadLearnedDigits()
    for (let d = 0; d <= 9; d++) {
      digitGrid.appendChild(
        h('span', {
          class: learned.has(String(d)) ? 'badge' : 'tick-info',
          title: learned.has(String(d)) ? `${d} 학습됨` : `${d} 미학습`
        }, String(d))
      )
    }
  }

  function loadLearnedDigits(): Set<string> {
    const learned = new Set<string>()
    try {
      const raw = localStorage.getItem(USER_TEMPLATE_KEY)
      if (!raw) return learned
      const parsed = JSON.parse(raw) as unknown
      collectChars(parsed, learned)
    } catch {
      // Malformed/absent templates -> treat every digit as not-learned.
    }
    return learned
  }

  /** Walk an arbitrary serialized template payload, harvesting any 0-9 `char` keys. */
  function collectChars(node: unknown, out: Set<string>): void {
    if (Array.isArray(node)) {
      for (const item of node) collectChars(item, out)
      return
    }
    if (node && typeof node === 'object') {
      const rec = node as Record<string, unknown>
      const char = rec['char']
      if (typeof char === 'string' && char.length === 1 && char >= '0' && char <= '9') out.add(char)
      for (const value of Object.values(rec)) collectChars(value, out)
    }
  }

  // Full diagnostic-log toolbar (exports the central logger: capture warnings,
  // source open results, per-region recognize detail — everything needed to
  // diagnose the live pipeline).
  const logStatus = h('span', { class: 'tick-info' }, '')
  const copyBtn = h('button', { class: 'btn btn--sm', onclick: copyLog }, '로그 복사')
  const saveBtn = h('button', { class: 'btn btn--sm', onclick: saveLog }, '로그 저장(파일)')
  const clearBtn = h('button', { class: 'btn btn--sm btn--ghost', onclick: () => { logger.clear(); logStatus.textContent = '로그 지움' } }, '지우기')

  async function copyLog(): Promise<void> {
    try {
      await navigator.clipboard.writeText(logger.export())
      logStatus.textContent = '클립보드에 복사됨 ✓ (붙여넣어 공유)'
    } catch {
      logStatus.textContent = '복사 실패 — F12 콘솔에서 copy(lmpLog.export())'
    }
  }
  async function saveLog(): Promise<void> {
    try {
      const res = await ctx.api.saveDiagnosticReport(logger.export())
      logStatus.textContent = res.ok && res.path ? `저장됨: ${res.path}` : '저장 실패'
    } catch {
      logStatus.textContent = '저장 사용 불가 (Electron 외 환경)'
    }
  }

  const diagDrawer = h('details', { class: 'drawer card' },
    h('summary', {}, '고급 · 진단'),
    h('div', { class: 'tab-pane' },
      h('div', { class: 'row' }, copyBtn, saveBtn, clearBtn, logStatus),
      h('div', { class: 'tick-info' }, 'F12 콘솔에서 copy(lmpLog.export()) 로도 복사 가능'),
      h('div', { class: 'card__title' }, '최근 인식 로그'),
      diagLog,
      h('div', { class: 'card__title' }, '유저 학습 디지트 (0-9)'),
      digitGrid
    )
  )
  renderDiagLog()
  renderDigitGrid()

  // -------------------------------------------------------------------------
  // 보정 · 학습 (MP bar calibration + per-region manual entry that teaches the font)
  // -------------------------------------------------------------------------
  const calibStatus = h('span', { class: 'tick-info' }, '')
  const calibBtn = h('button', { class: 'btn btn--sm', onclick: doCalibrate }, '📊 MP 바 100% 보정')

  async function doCalibrate(): Promise<void> {
    calibStatus.textContent = '보정 중…'
    const res = await detection.calibrateMpBar()
    calibStatus.textContent = res.ok ? `보정 완료 (${res.fullColumns} cols)` : `실패: ${res.note ?? ''}`
  }

  function applyToStore(v: ParsedValue): void {
    if (v.kind === 'mp') {
      app.setMpConfig({ curMp: v.cur })
      return
    }
    const cur = app.get().persisted.tracker.current
    const next =
      v.kind === 'exp'
        ? { ...cur, exp: v.pct }
        : v.kind === 'level'
          ? { ...cur, level: v.level }
          : { ...cur, adena: v.amount }
    app.setTracker({ current: next })
    app.ingestSample({ t: Date.now(), expPct: next.exp, adena: next.adena, level: next.level })
  }

  /** A manual-entry row: applies the value immediately AND learns the user's glyphs. */
  function learnRow(region: LRegion, label: string, placeholder: string): HTMLElement {
    const input = h('input', { type: 'text', placeholder, style: { flex: '1', minWidth: '110px' } })
    const status = h('span', { class: 'tick-info' }, '')
    const hint = h('span', { class: 'tick-info' }, '인식: —')
    rawHints[region] = hint
    const fillBtn = h('button', {
      class: 'btn btn--sm btn--ghost',
      title: '현재 인식값을 입력칸에 채웁니다 (틀린 자리만 고치세요)',
      onclick: () => {
        // EXP: fill the NORMALIZED value — the learn path slices the trailing "%"
        // blobs (leftmost-N), so a clean "79.3390" still learns correctly.
        // Other regions: fill the RAW string so its glyph count (incl. separators
        // like "," / "/") matches segmentation at learn time; normalizing would
        // strip them and trip the strict learn guard.
        const v =
          region === 'exp'
            ? latestNorm[region] ?? latestRaw[region]
            : latestRaw[region] ?? latestNorm[region]
        if (v) input.value = v
      }
    }, '인식값↩')
    const applyBtn = h('button', { class: 'btn btn--sm btn--primary', onclick: apply }, '적용 & 학습')

    async function apply(): Promise<void> {
      const text = input.value.trim()
      const parsed = parseRegionString(region, text)
      if (!parsed) {
        status.textContent = '형식 오류'
        return
      }
      applyToStore(parsed)
      detection.forceValue(region, parsed, Date.now())
      actions.recomputeTimer()
      // The typed value is now pinned (used) — reflect it in the hint immediately.
      lastAccepted[region] = false
      updateHint(region)
      if (region === 'mp') {
        status.textContent = '적용됨 (MP는 바 보정 권장)'
        return
      }
      status.textContent = '학습 중…'
      const res = await detection.learnRegion(region, text)
      const commaHint = region === 'adena' ? ' (화면에 쉼표가 있으면 쉼표까지: 예 31,525)' : ''
      if (res.ok) {
        status.textContent = `적용 + 학습됨 (${res.learned}글자)`
      } else if (region === 'level') {
        // Level is hard to auto-localize (the ROI over-segments). The manual value
        // is applied and STICKS — OCR misreads are rejected, never overwriting it.
        status.textContent = '레벨 적용됨 · 수동값 유지 (자동 인식이 어려운 항목)'
      } else {
        // Manual value is applied and pinned; learning the glyphs just failed (the
        // ROI/label glyph counts differ). Show the real reason — don't claim "정상".
        status.textContent = `적용됨 · 수동값 유지 (학습 실패: ${res.note ?? ''})${commaHint}`
      }
    }

    return h('div', { class: 'stack stack--tight' },
      h('div', { class: 'row' },
        h('span', { class: 'stat-chip__label', style: { minWidth: '48px' } }, label),
        input,
        fillBtn,
        applyBtn
      ),
      h('div', { class: 'row' }, status, hint)
    )
  }

  const learnCard = h('section', { class: 'card' },
    h('div', { class: 'card__title' }, '보정 · 학습 (정확도 ↑)'),
    h('div', { class: 'stack' },
      h('div', { class: 'row' }, calibBtn, calibStatus),
      h('div', { class: 'tick-info' }, 'MP가 가득 찼을 때 「MP 바 100% 보정」을 누르면 MP가 100% 정확해집니다.'),
      h('div', { class: 'tick-info' }, '학습: 「인식값↩」로 현재 인식값을 불러와 화면과 비교 → 틀린 자리만 고치고 「적용 & 학습」.'),
      learnRow('mp', 'MP', '예: 0/320'),
      learnRow('exp', 'EXP', '예: 78.3638'),
      learnRow('level', '레벨', '예: 32'),
      learnRow('adena', '아데나', '예: 12345')
    )
  )

  // -------------------------------------------------------------------------
  // assembly
  // -------------------------------------------------------------------------
  const el = h('div', { class: 'setup' },
    characterCard,
    presetCard,
    ocrCard,
    learnCard,
    itemCard,
    diagDrawer
  )

  /** Format a region as "WxH @ (x, y)" or "미지정" when unset. */
  function formatRegion(region: CaptureRegion | null): string {
    if (!region) return '미지정'
    return `${region.width}x${region.height} @ (${region.x}, ${region.y})`
  }

  return {
    el,
    update(state) {
      const c = state.persisted.mpConfig
      const ad = state.persisted.autoDetect

      // 1) character/MP — only push when not actively edited, to keep caret stable.
      if (document.activeElement !== fMaxMp.input) fMaxMp.input.value = String(c.maxMp)
      if (document.activeElement !== fCurMp.input) fCurMp.input.value = String(c.curMp)
      if (document.activeElement !== fWis.input) fWis.input.value = String(c.wis)
      tBluePotion.set(c.useBluePotion)
      tMeditation.set(c.useMeditation)
      tCrystalStaff.set(c.hasCrystalStaff)
      fLocation.select.value = c.location
      if (document.activeElement !== fCustomBonus.input) {
        fCustomBonus.input.value = String(c.customLocationBonus)
      }
      fState.select.value = c.state

      // 2) presets
      renderPresets(state)

      // 3) OCR
      tDetectMode.set(ad.mode === 'auto')
      fCaptureMode.select.value = ad.captureMode
      applyCaptureModeUi(ad.captureMode)
      // Auto-load the window list once if we start up already in window mode.
      if (ad.captureMode === 'window' && !windowsInitialized) {
        windowsInitialized = true
        void refreshWindows()
      }
      if (ad.captureMode === 'window' && ad.windowTitle && windowStatus.textContent === '') {
        windowStatus.textContent = `선택됨: ${ad.windowTitle}`
      }
      for (const { key } of REGION_TARGETS) {
        const row = regionRows.get(key)
        if (!row) continue
        const region = ad[key]
        row.dot.className = region ? 'dot dot--ok' : 'dot dot--off'
        row.coords.textContent = formatRegion(region)
      }
      tUseMpBar.set(ad.useMpBar)
      if (document.activeElement !== fIntervalMs.input) fIntervalMs.input.value = String(ad.intervalMs)
      if (document.activeElement !== fStability.input) fStability.input.value = String(ad.stabilityRequired)
      btnDetect.textContent = ad.enabled ? '■ 정지' : '▶ 자동 인식 시작'
      detectStatus.textContent = !detection.running
        ? '정지됨'
        : ad.captureMode === 'window' && !detection.hasWindowSource()
          ? '게임 창 탐색 중…'
          : '실행 중'

      // 4) items
      syncItems(state.persisted.items)

      // 5) learn-row hints reflect the value the app actually uses (kept fresh even
      //    without a new OCR event, e.g. right after a manual apply).
      updateHint('mp')
      updateHint('exp')
      updateHint('level')
      updateHint('adena')

      // 6) ROI editor: show which regions have a manual override.
      updateRoiOverrideStatus()
    },
    destroy() {
      offDetect()
      window.removeEventListener('mousemove', onRoiMove)
      window.removeEventListener('mouseup', onRoiUp)
    }
  }
}
