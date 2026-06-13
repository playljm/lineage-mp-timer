/**
 * Settings view — secondary screen for presentation + behaviour preferences.
 *
 * Sections: theme swatches, notification/behaviour toggles, hotkey rebinding, a
 * collapsed cloud-sync drawer, a collapsed OCR user-template import drawer
 * (paste the scripts/build-user-templates.ts artifact), and an info footer.
 * Like every view
 * it renders FROM the store and writes back through the {@link AppStore} mutation
 * helpers (`setTheme`/`setUi`/`store.set`) — nothing reads state out of an input.
 *
 * DOM is built once in the factory; `update(state)` only mutates existing nodes
 * (toggle checked-state, active swatch, hotkey accel labels). All `ctx.api.*`
 * calls are guarded with `.catch` so the non-electron preview degrades quietly.
 */
import { h } from '../dom'
import { THEME_OPTIONS, applyTheme } from '../theme'
import { DEFAULT_HOTKEYS, type ThemeName, type HotkeyState } from '@core/domain/storage-schema'
import {
  deserializeTemplates,
  mergeTemplateSets,
  serializeTemplates,
  type SerializedTemplateSet,
  type TemplateSet
} from '@core/ocr/template-matcher'
import { USER_TEMPLATE_KEY } from '../../ocr/detection'
import type { View, ViewContext } from '../view'
import type { AppState } from '../../state/store'
import type { HotkeyMap } from '@shared/ipc-contract'

/** The persisted UI-settings keys this view binds as on/off toggles. */
type UiToggleKey = 'sound' | 'toast' | 'minimizeOnClose' | 'alwaysOnTop'

/** Hotkey binding names, in display order. */
const HOTKEY_KEYS = ['alwaysOnTop', 'toggleHide', 'startPause', 'reset'] as const
type HotkeyKey = (typeof HOTKEY_KEYS)[number]

/** Toggle rows for the "알림 / 동작" card (Korean label + persisted UI key). */
const UI_TOGGLES: { key: UiToggleKey; label: string }[] = [
  { key: 'sound', label: '사운드' },
  { key: 'toast', label: '토스트 알림' },
  { key: 'minimizeOnClose', label: '닫을 때 트레이로' },
  { key: 'alwaysOnTop', label: '항상 위' }
]

/** Build a `{action: accel}` map of every currently-enabled global-scope binding. */
function globalHotkeyMap(hotkeys: HotkeyState): HotkeyMap {
  const map: HotkeyMap = {}
  for (const key of HOTKEY_KEYS) {
    const binding = hotkeys[key]
    if (binding.scope === 'global' && binding.enabled) map[key] = binding.accel
  }
  return map
}

/**
 * Translate a keydown into an Electron-style accelerator string
 * (e.g. `Ctrl+Shift+F1`, `Space`). Pure modifier presses yield `''`.
 */
function accelFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')
  const key = e.key
  if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return ''
  let main: string
  if (key === ' ') main = 'Space'
  else if (key === 'Escape') main = 'Esc'
  else if (key.length === 1) main = key.toUpperCase()
  else main = key
  parts.push(main)
  return parts.join('+')
}

/**
 * Validate pasted text as a SerializedTemplateSet (the scripts/build-user-templates.ts
 * artifact). Returns the DESERIALIZED set so the caller knows it round-trips through
 * exactly the path detection.ts loads it with.
 */
function parseUserTemplateJson(
  text: string
): { ok: true; set: TemplateSet } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'JSON 파싱 실패 — 파일 내용을 그대로 붙여넣었는지 확인하세요' }
  }
  const s = parsed as SerializedTemplateSet
  if (
    !s ||
    typeof s !== 'object' ||
    !Number.isInteger(s.canonW) ||
    s.canonW <= 0 ||
    !Number.isInteger(s.canonH) ||
    s.canonH <= 0 ||
    !Array.isArray(s.chars) ||
    s.chars.length === 0
  ) {
    return { ok: false, error: '템플릿 형식이 아닙니다 (canonW/canonH/chars 필요)' }
  }
  for (const c of s.chars) {
    if (
      !c ||
      typeof c.char !== 'string' ||
      c.char.length !== 1 ||
      typeof c.grid !== 'string' ||
      !Number.isFinite(c.samples) ||
      c.samples <= 0 ||
      !Number.isFinite(c.meanAspect) ||
      c.meanAspect <= 0
    ) {
      return { ok: false, error: `글자 항목이 손상되었습니다 (char/grid/samples/meanAspect)` }
    }
  }
  try {
    const set = deserializeTemplates(s)
    for (const c of set.chars) {
      if (c.grid.length !== s.canonW * s.canonH) {
        return { ok: false, error: `'${c.char}' 그리드 크기가 ${s.canonW}×${s.canonH}와 다릅니다` }
      }
    }
    return { ok: true, set }
  } catch {
    return { ok: false, error: '템플릿 디코딩 실패 (grid base64 손상?)' }
  }
}

export function createSettingsView(ctx: ViewContext): View {
  const { app, api, detection } = ctx

  // --- section 1: theme swatches -------------------------------------------
  const swatchByValue = new Map<ThemeName, HTMLButtonElement>()
  const swatchRow = h('div', { class: 'row' })
  for (const opt of THEME_OPTIONS) {
    const swatch = h('button', {
      class: 'btn btn--sm',
      type: 'button',
      'aria-pressed': 'false',
      dataset: { theme: opt.value },
      onclick: () => {
        app.setTheme(opt.value)
        applyTheme(opt.value)
      }
    }, opt.label)
    swatchByValue.set(opt.value, swatch)
    swatchRow.appendChild(swatch)
  }
  const themeCard = h('section', { class: 'card' },
    h('div', { class: 'card__title' }, '테마'),
    swatchRow
  )

  // --- section 2: notifications / behaviour --------------------------------
  const uiToggleByKey = new Map<UiToggleKey, HTMLButtonElement>()
  const togglesRow = h('div', { class: 'row' })
  for (const t of UI_TOGGLES) {
    const btn = h('button', {
      class: 'toggle',
      type: 'button',
      role: 'switch',
      'aria-checked': 'false',
      onclick: () => {
        const next = btn.getAttribute('aria-checked') !== 'true'
        app.setUi({ [t.key]: next })
        if (t.key === 'alwaysOnTop') void api.setAlwaysOnTop(next).catch(() => {})
      }
    },
      h('span', { class: 'toggle__track' }, h('span', { class: 'toggle__thumb' })),
      h('span', {}, t.label)
    )
    uiToggleByKey.set(t.key, btn)
    togglesRow.appendChild(btn)
  }

  const volumeInput = h('input', {
    type: 'range',
    min: '0',
    max: '1',
    step: '0.05',
    oninput: () => {
      const v = Number(volumeInput.value)
      if (Number.isFinite(v)) app.setUi({ volume: Math.min(1, Math.max(0, v)) })
    }
  })
  const volumeField = h('label', { class: 'field' },
    h('span', {}, '볼륨'),
    volumeInput
  )

  const behaviourCard = h('section', { class: 'card' },
    h('div', { class: 'card__title' }, '알림 / 동작'),
    togglesRow,
    h('div', { class: 'form-grid' }, volumeField)
  )

  // --- section 3: hotkeys ---------------------------------------------------
  interface HotkeyRow {
    label: HTMLElement
    rebind: HTMLButtonElement
    enable: HTMLButtonElement
  }
  const hotkeyRowByKey = new Map<HotkeyKey, HotkeyRow>()
  let capturing: HotkeyKey | null = null

  /** Persist a freshly-captured accel for `key`, re-registering globals as needed. */
  function commitAccel(key: HotkeyKey, accel: string): void {
    app.store.set((prev) => ({
      persisted: {
        ...prev.persisted,
        hotkeys: {
          ...prev.persisted.hotkeys,
          [key]: { ...prev.persisted.hotkeys[key], accel }
        }
      }
    }))
    syncGlobalHotkeys()
  }

  /** Flip the enabled flag for `key`, re-registering globals as needed. */
  function toggleEnabled(key: HotkeyKey): void {
    app.store.set((prev) => ({
      persisted: {
        ...prev.persisted,
        hotkeys: {
          ...prev.persisted.hotkeys,
          [key]: { ...prev.persisted.hotkeys[key], enabled: !prev.persisted.hotkeys[key].enabled }
        }
      }
    }))
    syncGlobalHotkeys()
  }

  /** Push the enabled global-scope bindings to the main process (guarded). */
  function syncGlobalHotkeys(): void {
    void api.setGlobalHotkeys(globalHotkeyMap(app.get().persisted.hotkeys)).catch(() => {})
  }

  /** Begin capturing the next keydown as the accel for `key`. */
  function beginCapture(key: HotkeyKey): void {
    capturing = key
    const row = hotkeyRowByKey.get(key)
    if (row) row.rebind.textContent = '키 입력…'
  }

  // One window-level capture listener; only active while `capturing` is set.
  const onKeydown = (e: KeyboardEvent): void => {
    if (capturing == null) return
    e.preventDefault()
    e.stopPropagation()
    const key = capturing
    capturing = null
    if (e.key === 'Escape') {
      // Cancel — leave the binding unchanged; update() restores the label.
      update(app.get())
      return
    }
    const accel = accelFromEvent(e)
    if (accel) commitAccel(key, accel)
    else update(app.get())
  }
  window.addEventListener('keydown', onKeydown, true)

  const hotkeyList = h('div', { class: 'settings-hotkeys' })
  for (const key of HOTKEY_KEYS) {
    const label = h('span', { class: 'stat-chip__label' })
    const rebind = h('button', {
      class: 'btn btn--sm',
      type: 'button',
      onclick: () => beginCapture(key)
    })
    const enable = h('button', {
      class: 'toggle',
      type: 'button',
      role: 'switch',
      'aria-checked': 'false',
      title: '사용/해제',
      onclick: () => toggleEnabled(key)
    },
      h('span', { class: 'toggle__track' }, h('span', { class: 'toggle__thumb' }))
    )
    hotkeyRowByKey.set(key, { label, rebind, enable })
    hotkeyList.appendChild(
      h('div', { class: 'row' }, label, rebind, enable)
    )
  }

  const restoreBtn = h('button', {
    class: 'btn btn--ghost btn--sm',
    type: 'button',
    onclick: () => {
      app.store.set((prev) => ({
        persisted: {
          ...prev.persisted,
          hotkeys: {
            alwaysOnTop: { ...DEFAULT_HOTKEYS.alwaysOnTop },
            toggleHide: { ...DEFAULT_HOTKEYS.toggleHide },
            startPause: { ...DEFAULT_HOTKEYS.startPause },
            reset: { ...DEFAULT_HOTKEYS.reset }
          }
        }
      }))
      syncGlobalHotkeys()
    }
  }, '기본값 복원')

  const hotkeyCard = h('section', { class: 'card' },
    h('div', { class: 'card__title' }, '단축키'),
    hotkeyList,
    h('div', { class: 'row' }, restoreBtn)
  )

  // --- section 4: cloud sync (collapsed drawer) ----------------------------
  const cloudStatus = h('span', { class: 'badge' }, '로그아웃됨')
  const cloudBtn = h('button', {
    class: 'btn btn--sm',
    type: 'button',
    onclick: () => {
      cloudStatus.textContent = '로그인 중…'
      void api.cloudLoginPopup()
        .then((res) => {
          cloudStatus.textContent = res.email ?? '로그인 실패'
        })
        .catch(() => {
          cloudStatus.textContent = '사용 불가'
        })
    }
  }, '로그인')

  const cloudCard = h('details', { class: 'drawer' },
    h('summary', {}, '클라우드 동기화'),
    h('div', { class: 'row' }, cloudBtn, cloudStatus),
    h('p', { class: 'stat-chip__label' },
      'OCR 학습 샘플이 클라우드에 업로드됩니다.'
    )
  )

  // --- section 5: OCR user templates (offline batch-learn import) ----------
  const tplStatus = h('span', { class: 'badge' })
  const tplMsg = h('p', { class: 'stat-chip__label' })
  const tplTextarea = h('textarea', {
    rows: 4,
    spellcheck: false,
    placeholder: 'out/user-templates.json 내용을 붙여넣으세요',
    style: { width: '100%', minHeight: '88px', resize: 'vertical' }
  })

  /** Reflect the currently-stored user template set on the status badge. */
  function refreshTplStatus(): void {
    try {
      const raw = localStorage.getItem(USER_TEMPLATE_KEY)
      if (!raw) {
        tplStatus.textContent = '유저 템플릿 없음'
        return
      }
      const set = deserializeTemplates(JSON.parse(raw) as SerializedTemplateSet)
      const samples = set.chars.reduce((a, c) => a + c.samples, 0)
      tplStatus.textContent = `활성: ${set.chars.length}글자 · ${samples}샘플`
    } catch {
      tplStatus.textContent = '저장본 손상 — 가져오기로 교체하세요'
    }
  }

  const tplImportBtn = h('button', {
    class: 'btn btn--sm btn--primary',
    type: 'button',
    onclick: () => {
      const text = tplTextarea.value.trim()
      if (!text) {
        tplMsg.textContent = '먼저 user-templates.json 내용을 붙여넣으세요'
        return
      }
      const res = parseUserTemplateJson(text)
      if (!res.ok) {
        tplMsg.textContent = `가져오기 실패: ${res.error}`
        return
      }
      // Imported chars win outright (they are big offline averages); chars the
      // user live-taught that the import does not cover are preserved.
      let final = res.set
      try {
        const existingRaw = localStorage.getItem(USER_TEMPLATE_KEY)
        if (existingRaw) {
          const existing = deserializeTemplates(JSON.parse(existingRaw) as SerializedTemplateSet)
          if (existing.canonW === res.set.canonW && existing.canonH === res.set.canonH) {
            final = mergeTemplateSets(res.set, existing)
          }
        }
      } catch {
        /* corrupt store: plain replace */
      }
      try {
        localStorage.setItem(USER_TEMPLATE_KEY, JSON.stringify(serializeTemplates(final)))
      } catch {
        tplMsg.textContent = '저장 실패 (localStorage)'
        return
      }
      detection.reloadUserTemplates()
      tplTextarea.value = ''
      tplMsg.textContent = `가져옴: ${res.set.chars.length}글자 (활성 ${final.chars.length}글자) — 즉시 인식에 반영됩니다`
      refreshTplStatus()
    }
  }, '가져오기')

  const tplResetBtn = h('button', {
    class: 'btn btn--ghost btn--sm',
    type: 'button',
    onclick: () => {
      localStorage.removeItem(USER_TEMPLATE_KEY)
      detection.reloadUserTemplates()
      tplMsg.textContent = '유저 템플릿을 비웠습니다 — 기본 템플릿으로 동작'
      refreshTplStatus()
    }
  }, '초기화')

  refreshTplStatus()
  const templateCard = h('details', { class: 'drawer' },
    h('summary', {}, 'OCR 유저 템플릿'),
    h('div', { class: 'row' }, tplStatus),
    tplTextarea,
    h('div', { class: 'row' }, tplImportBtn, tplResetBtn),
    tplMsg,
    h('p', { class: 'stat-chip__label' },
      '오프라인 일괄 학습 산출물(out/user-templates.json — npm run templates:user로 생성)을 붙여넣어 적용합니다. ' +
        '가져온 글자는 기본 템플릿보다 우선하며, 보정·학습 탭의 수동 학습으로 언제든 덮어쓸 수 있습니다.'
    )
  )

  // --- section 6: info ------------------------------------------------------
  const devtoolsBtn = h('button', {
    class: 'btn btn--ghost btn--sm',
    type: 'button',
    onclick: () => void api.toggleDevtools().catch(() => {})
  }, 'DevTools')

  const infoCard = h('section', { class: 'card' },
    h('div', { class: 'card__title' }, '정보'),
    h('div', { class: 'stat-chip__value' }, 'Lineage MP Timer v3.1.4'),
    h('p', { class: 'stat-chip__label' }, 'prefers-reduced-motion 설정을 존중합니다.'),
    h('div', { class: 'row' }, devtoolsBtn)
  )

  const el = h('div', { class: 'settings' },
    themeCard,
    behaviourCard,
    hotkeyCard,
    cloudCard,
    templateCard,
    infoCard
  )

  /** Reflect persisted theme/ui/hotkeys onto the pre-built DOM. */
  function update(state: AppState): void {
    const { ui, theme, hotkeys } = state.persisted

    // Theme: highlight the active swatch.
    for (const [value, swatch] of swatchByValue) {
      const active = value === theme
      swatch.setAttribute('aria-pressed', String(active))
      swatch.classList.toggle('btn--primary', active)
    }

    // UI toggles + volume.
    for (const [key, btn] of uiToggleByKey) {
      btn.setAttribute('aria-checked', String(ui[key]))
    }
    if (document.activeElement !== volumeInput) volumeInput.value = String(ui.volume)

    // Hotkeys: accel labels + enabled state (skip the one being captured).
    for (const key of HOTKEY_KEYS) {
      const row = hotkeyRowByKey.get(key)
      if (!row) continue
      const binding = hotkeys[key]
      row.label.textContent = `${binding.label}${binding.scope === 'global' ? ' (전역)' : ''}`
      if (capturing !== key) row.rebind.textContent = binding.accel || '미지정'
      row.enable.setAttribute('aria-checked', String(binding.enabled))
    }
  }

  return {
    el,
    update,
    destroy() {
      window.removeEventListener('keydown', onKeydown, true)
    }
  }
}
