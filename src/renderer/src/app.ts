/**
 * Renderer application shell. Owns the AppStore, DetectionController and MpTimer,
 * builds the titlebar + 3-tab IA (Monitor / Setup / Settings) + summary bar +
 * compact HUD, mounts the feature views, and drives a render tick for the live
 * countdown. Everything renders FROM the store.
 */
import { createAppStore, type AppState } from './state/store'
import { DetectionController } from './ocr/detection'
import { MpTimer } from './timer/mp-timer'
import { applyTheme } from './ui/theme'
import { h, byId, clear } from './ui/dom'
import { api } from './platform/api'
import type { AppActions, View, ViewContext } from './ui/view'
import { createMonitorView } from './ui/views/monitor'
import { createSetupView } from './ui/views/setup'
import { createSettingsView } from './ui/views/settings'
import { createSummaryBar } from './ui/views/summary-bar'
import { createCompactView } from './ui/views/compact'
import type { ParsedValue } from '@core/ocr/types'

type TabId = 'monitor' | 'setup' | 'settings'

export function bootApp(rootEl: HTMLElement): void {
  const app = createAppStore()
  const detection = new DetectionController(app)
  const timer = new MpTimer()

  applyTheme(app.get().persisted.theme)

  // --- imperative actions exposed to views ---
  const actions: AppActions = {
    startPause() {
      const running = !timer.running
      if (running) timer.start(app.get().persisted.mpConfig, Date.now())
      else timer.pause()
      app.setTimerRunning(running)
    },
    reset() {
      timer.pause()
      app.setTimerRunning(false)
      app.setMpConfig({ curMp: 0 })
      timer.recompute(app.get().persisted.mpConfig, Date.now())
    },
    setCompact(on: boolean) {
      app.setUi({ compactMode: on })
      document.body.classList.toggle('compact-mode', on)
      void api.setCompact(on).catch(() => {})
    },
    async pickRegion(target: string) {
      await pickRegion(target)
    },
    recomputeTimer() {
      timer.recompute(app.get().persisted.mpConfig, Date.now())
    }
  }

  const ctx: ViewContext = { app, api, detection, timer, actions, now: () => Date.now() }

  timer.onComplete = () => {
    const ui = app.get().persisted.ui
    if (ui.toast) void api.notifyComplete({ title: 'MP 완충', body: 'MP가 가득 찼습니다.' }).catch(() => {})
    if (ui.sound) playChime(ui.volume)
  }

  // --- region picker: pick on a display, store the region for a target ---
  async function pickRegion(target: string): Promise<void> {
    try {
      const ad = app.get().persisted.autoDetect
      const res = await api.startRegionSelect(ad.displayId ?? undefined)
      if (!res) return
      const region = {
        x: res.region.x,
        y: res.region.y,
        width: res.region.width,
        height: res.region.height,
        sourceId: res.sourceId,
        displayId: res.displayId,
        scaleFactor: res.scaleFactor
      }
      const key =
        target === 'mpBar'
          ? 'mpBarRegion'
          : target === 'game'
            ? 'gameRegion'
            : (`${target}Region` as const)
      app.store.set((prev) => ({
        persisted: {
          ...prev.persisted,
          autoDetect: { ...prev.persisted.autoDetect, [key]: region }
        }
      }))
    } catch (err) {
      console.error('[pickRegion]', err)
    }
  }

  // --- shell DOM ---
  clear(rootEl)
  rootEl.classList.add('app-shell')

  const titlebar = buildTitlebar(ctx)
  const summary = createSummaryBar(ctx)
  const tabsNav = h('nav', { class: 'tabs', role: 'tablist' })
  const panes = h('div', { class: 'panes' })

  const monitor = createMonitorView(ctx)
  const setup = createSetupView(ctx)
  const settings = createSettingsView(ctx)
  const views: Record<TabId, View> = { monitor, setup, settings }
  const labels: Record<TabId, string> = { monitor: '모니터', setup: '설정·OCR', settings: '환경설정' }

  let activeTab: TabId = 'monitor'
  const tabButtons: Record<TabId, HTMLButtonElement> = {} as Record<TabId, HTMLButtonElement>

  ;(Object.keys(views) as TabId[]).forEach((id) => {
    const btn = h('button', {
      class: 'tab',
      role: 'tab',
      id: `tab-btn-${id}`,
      'aria-selected': String(id === activeTab),
      'aria-controls': `pane-${id}`,
      onclick: () => selectTab(id)
    }, labels[id])
    tabButtons[id] = btn
    tabsNav.appendChild(btn)
    const pane = views[id].el
    pane.id = `pane-${id}`
    pane.setAttribute('role', 'tabpanel')
    pane.classList.add('tab-pane')
    if (id !== activeTab) pane.hidden = true
    panes.appendChild(pane)
  })

  function selectTab(id: TabId): void {
    activeTab = id
    ;(Object.keys(views) as TabId[]).forEach((t) => {
      tabButtons[t].setAttribute('aria-selected', String(t === id))
      views[t].el.hidden = t !== id
    })
    views[id].update(app.get())
  }

  rootEl.append(titlebar, summary.el, tabsNav, panes)

  // --- compact HUD (separate overlay layer) ---
  const compact = createCompactView(ctx)
  compact.el.id = 'compact-hud'
  document.body.appendChild(compact.el)
  document.body.classList.toggle('compact-mode', app.get().persisted.ui.compactMode)

  // --- render: store changes + a 250ms tick for the countdown ---
  function renderAll(state: AppState): void {
    summary.update(state)
    compact.update(state)
    views[activeTab].update(state)
  }
  app.subscribe((state) => {
    // Re-anchor countdown whenever MP config changes.
    timer.recompute(state.persisted.mpConfig, Date.now())
    renderAll(state)
  })
  window.setInterval(() => renderAll(app.get()), 250)

  // --- detection event hook (for diagnostics drawer in Setup) ---
  detection.onEvent(() => {
    /* views read latest via store; drawer subscribes separately if needed */
  })

  // --- global hotkeys (window scope) ---
  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) return
    const hk = app.get().persisted.hotkeys
    if (e.key === ' ' && hk.startPause.enabled) {
      e.preventDefault()
      actions.startPause()
    } else if ((e.key === 'r' || e.key === 'R') && hk.reset.enabled) {
      actions.reset()
    } else if (e.key === 'F3') {
      e.preventDefault()
      actions.setCompact(!app.get().persisted.ui.compactMode)
    }
  })

  // Auto-resume detection if it was enabled.
  if (app.get().persisted.autoDetect.enabled) {
    void detection.start().catch((err) => console.error('[detect.start]', err))
  }

  // Initial render.
  selectTab('monitor')
  renderAll(app.get())
}

function buildTitlebar(ctx: ViewContext): HTMLElement {
  const { api: ipc, actions, app } = ctx
  const iconBtn = (label: string, title: string, onClick: () => void): HTMLButtonElement =>
    h('button', { class: 'btn btn--icon btn--ghost', title, 'aria-label': title, onclick: onClick }, label)

  return h('header', { class: 'titlebar' },
    h('span', { class: 'titlebar__title' }, '🗡️ Lineage MP Timer ', h('small', {}, 'v3.0')),
    h('div', { class: 'titlebar__actions' },
      iconBtn('📦', '컴팩트 모드 (F3)', () => actions.setCompact(!app.get().persisted.ui.compactMode)),
      iconBtn('📌', '항상 위', () => {
        const next = !app.get().persisted.ui.alwaysOnTop
        app.setUi({ alwaysOnTop: next })
        void ipc.setAlwaysOnTop(next).catch(() => {})
      }),
      iconBtn('—', '최소화', () => void ipc.minimizeWindow().catch(() => {})),
      iconBtn('✕', '닫기', () => void ipc.closeWindow().catch(() => {}))
    )
  )
}

function playChime(volume: number): void {
  try {
    const AudioCtx = window.AudioContext
    const ac = new AudioCtx()
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.value = Math.max(0, Math.min(1, volume)) * 0.2
    osc.connect(gain).connect(ac.destination)
    osc.start()
    osc.stop(ac.currentTime + 0.25)
  } catch {
    /* audio optional */
  }
}

export type { ParsedValue }
