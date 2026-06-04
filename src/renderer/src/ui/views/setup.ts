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
  AutoDetectState
} from '@core/domain/storage-schema'
import type { DetectionEvent } from '../../ocr/detection'
import { logger } from '../../util/logger'
import { parseRegionString } from '@core/ocr/parser'
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

  // Latest raw OCR string per region + the hint nodes that mirror it live, so the
  // learn rows can pre-fill the input with what the recognizer actually segmented
  // (guaranteeing the glyph-count matches at learn time).
  type LRegion = 'mp' | 'exp' | 'level' | 'adena'
  const latestRaw: Partial<Record<LRegion, string | null>> = {}
  const rawHints: Partial<Record<LRegion, HTMLElement>> = {}

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
    // Mirror the freshest recognized string into the matching learn-row hint.
    latestRaw[e.region] = e.raw
    const hint = rawHints[e.region]
    if (hint) hint.textContent = e.raw == null ? '인식: —' : `인식: ${e.raw}`
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
    const input = h('input', { type: 'text', placeholder })
    const status = h('span', { class: 'tick-info' }, '')
    const hint = h('span', { class: 'tick-info', title: '현재 자동 인식값 — 길이를 맞추려면 이 값을 불러와 틀린 자리만 고치세요' }, '인식: —')
    rawHints[region] = hint
    const fillBtn = h('button', {
      class: 'btn btn--sm btn--ghost',
      title: '현재 인식값을 입력칸에 채웁니다 (길이 일치 보장)',
      onclick: () => {
        const r = latestRaw[region]
        if (r) input.value = r
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
      if (region === 'mp') {
        status.textContent = '적용됨 (MP는 바 보정 권장)'
        return
      }
      status.textContent = '학습 중…'
      const res = await detection.learnRegion(region, text)
      status.textContent = res.ok ? `적용 + 학습됨 (${res.learned}글자)` : `적용됨 · 학습실패: ${res.note ?? ''}`
    }

    return h('div', { class: 'row' },
      h('span', { class: 'stat-chip__label', style: { minWidth: '52px' } }, label),
      input,
      fillBtn,
      applyBtn,
      status,
      hint
    )
  }

  const learnCard = h('section', { class: 'card' },
    h('div', { class: 'card__title' }, '보정 · 학습 (정확도 ↑)'),
    h('div', { class: 'row' }, calibBtn, calibStatus),
    h('div', { class: 'tick-info' }, 'MP가 가득 찼을 때 「MP 바 100% 보정」을 누르면 MP가 100% 정확해집니다.'),
    h('div', { class: 'tick-info' }, '학습: 「인식값↩」로 현재 인식값을 불러와 화면과 비교 → 틀린 자리만 고치고 「적용 & 학습」.'),
    h('div', { class: 'tick-info' }, '글자수가 안 맞으면(예: 분할 8 ≠ 입력 7) 해당 영역을 숫자에만 딱 맞게(%/여백 제외) 다시 지정하세요.'),
    learnRow('mp', 'MP', '예: 0/320'),
    learnRow('exp', 'EXP', '예: 78.3638'),
    learnRow('level', '레벨', '예: 32'),
    learnRow('adena', '아데나', '예: 12345')
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
      detectStatus.textContent = detection.running ? '실행 중' : '정지됨'

      // 4) items
      syncItems(state.persisted.items)
    },
    destroy() {
      offDetect()
    }
  }
}
