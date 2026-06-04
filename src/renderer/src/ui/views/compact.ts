/**
 * Compact always-on-top HUD. Glanceable during gameplay: a hero countdown plus a
 * small configurable set of stats (default: MP%, EXP/H, ADENA/H, level-up ETA).
 * Larger tabular type, no emoji labels — the v2.x 12-metric grid was unreadable.
 */
import { h } from '../dom'
import { formatDuration } from '@core/domain/mp-engine'
import type { View, ViewContext } from '../view'

function cell(label: string): { root: HTMLElement; v: HTMLElement } {
  const v = h('span', { class: 'compact__v' })
  const root = h('div', { class: 'compact__cell' }, h('span', { class: 'compact__l' }, label), v)
  return { root, v }
}

export function createCompactView(ctx: ViewContext): View {
  const hero = h('div', { class: 'compact__hero' })
  const mp = cell('MP')
  const exph = cell('EXP/H')
  const adh = cell('아데나/H')
  const lvEta = cell('레벨업')

  const el = h('div', { class: 'compact' },
    h('div', { class: 'compact__heroWrap' }, h('span', { class: 'compact__l' }, '완충까지'), hero),
    h('div', { class: 'compact__grid' }, mp.root, exph.root, adh.root, lvEta.root)
  )

  return {
    el,
    update(state) {
      const c = state.persisted.mpConfig
      hero.textContent = formatDuration(ctx.timer.remainingSeconds(c, ctx.now()))
      const pct = c.maxMp > 0 ? Math.round((c.curMp / c.maxMp) * 100) : 0
      mp.v.textContent = `${pct}%`
      const s = state.runtime.trackerStats
      exph.v.textContent = s.expPerHour != null ? `+${s.expPerHour.toFixed(2)}%` : '—'
      adh.v.textContent = s.adenaPerHour != null ? `+${Math.round(s.adenaPerHour).toLocaleString('en-US')}` : '—'
      lvEta.v.textContent = s.levelUpEta != null ? formatDuration(s.levelUpEta) : '—'
    }
  }
}
