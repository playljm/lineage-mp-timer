/**
 * Monitor view — the primary screen. Visual hierarchy: the full-charge countdown
 * is the single hero, the MP gauge is secondary, and per-tick/breakdown/session
 * stats are supporting chips. Renders entirely from the store.
 */
import { h, clear } from '../dom'
import { breakdown, formatDuration, formatCompletionTime } from '@core/domain/mp-engine'
import { toMpConfig } from '../../timer/mp-timer'
import type { View, ViewContext } from '../view'
import type { AppState } from '../../state/store'

function stat(label: string): { root: HTMLElement; v: HTMLElement } {
  const v = h('span', { class: 'stat-chip__value' })
  const root = h('div', { class: 'stat-chip' }, h('span', { class: 'stat-chip__label' }, label), v)
  return { root, v }
}

export function createMonitorView(ctx: ViewContext): View {
  const { actions, timer } = ctx

  const hero = h('div', { class: 'hero-countdown', 'aria-live': 'polite' }, '00:00:00')
  const heroSub = h('div', { class: 'hero-sub' }, '완충 예상 시각 —')

  const gaugeFill = h('div', { class: 'gauge__fill' })
  const gaugeText = h('div', { class: 'gauge__text' }, '0 / 0')
  const gauge = h('div', { class: 'gauge', role: 'progressbar' }, gaugeFill, gaugeText)

  const btnStart = h('button', { class: 'btn btn--primary', onclick: () => actions.startPause() }, '시작')
  const btnReset = h('button', { class: 'btn', onclick: () => actions.reset() }, '리셋')
  const tickInfo = h('div', { class: 'tick-info' })

  const breakdownRow = h('div', { class: 'breakdown' })

  const lv = stat('레벨')
  const exp = stat('EXP')
  const exph = stat('EXP/H')
  const lvEta = stat('레벨업 ETA')
  const next1 = stat('다음 1%')
  const adena = stat('아데나')
  const adh = stat('아데나/H')
  const elapsed = stat('경과')

  const el = h('div', { class: 'monitor' },
    h('section', { class: 'card hero-card' },
      h('div', { class: 'card__title' }, 'MP 완충 카운트다운'),
      hero,
      heroSub,
      gauge,
      h('div', { class: 'controls' }, btnStart, btnReset),
      tickInfo,
      breakdownRow
    ),
    h('section', { class: 'card' },
      h('div', { class: 'card__title' }, '세션 트래커'),
      h('div', { class: 'tracker-grid' },
        lv.root, exp.root, exph.root, lvEta.root, next1.root, adena.root, adh.root, elapsed.root
      )
    )
  )

  function renderBreakdown(state: AppState): void {
    clear(breakdownRow)
    const bd = breakdown(toMpConfig(state.persisted.mpConfig))
    for (const item of bd.items) {
      breakdownRow.appendChild(
        h('span', { class: 'badge' }, `${item.label} +${item.value}`)
      )
    }
    breakdownRow.appendChild(h('span', { class: 'badge' }, `합계 ${bd.total}/${bd.interval}s`))
  }

  return {
    el,
    update(state) {
      const c = state.persisted.mpConfig
      const now = ctx.now()
      const remaining = timer.remainingSeconds(c, now)
      hero.textContent = formatDuration(remaining)
      heroSub.textContent =
        Number.isFinite(remaining) && remaining > 0
          ? `완충 예상 ${formatCompletionTime(remaining, new Date(now))}`
          : c.curMp >= c.maxMp
            ? '완충 완료'
            : '회복 불가'

      const pct = c.maxMp > 0 ? Math.min(100, (c.curMp / c.maxMp) * 100) : 0
      gaugeFill.style.width = `${pct}%`
      gaugeText.textContent = `${c.curMp} / ${c.maxMp}  ·  ${Math.round(pct)}%`
      gauge.setAttribute('aria-valuenow', String(Math.round(pct)))

      btnStart.textContent = timer.running ? '일시정지' : '시작'
      tickInfo.textContent = `${c.state} · WIS ${c.wis}`
      renderBreakdown(state)

      const s = state.runtime.trackerStats
      lv.v.textContent = String(c.curMp >= 0 ? state.persisted.tracker.current.level : 1)
      exp.v.textContent = `${state.persisted.tracker.current.exp.toFixed(2)}%`
      exph.v.textContent = s.expPerHour != null ? `+${s.expPerHour.toFixed(2)}%` : '—'
      lvEta.v.textContent = s.levelUpEta != null ? formatDuration(s.levelUpEta) : '—'
      next1.v.textContent = s.next1PctEta != null ? formatDuration(s.next1PctEta) : '—'
      adena.v.textContent = state.persisted.tracker.current.adena.toLocaleString('en-US')
      adh.v.textContent = s.adenaPerHour != null ? `+${Math.round(s.adenaPerHour).toLocaleString('en-US')}` : '—'
      elapsed.v.textContent = formatDuration(s.elapsed / 1000)
    }
  }
}
