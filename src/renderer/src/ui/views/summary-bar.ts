/** Always-visible summary strip: MP, full-charge countdown, EXP/H, ADENA/H. */
import { h } from '../dom'
import { formatDuration } from '@core/domain/mp-engine'
import type { View, ViewContext } from '../view'

interface Chip {
  root: HTMLElement
  set(v: string, accent?: boolean): void
}

function chip(label: string): Chip {
  const value = h('span', { class: 'stat-chip__value' })
  const root = h('div', { class: 'stat-chip' }, h('span', { class: 'stat-chip__label' }, label), value)
  return {
    root,
    set(v, accent) {
      value.textContent = v
      value.classList.toggle('stat-chip__value--accent', !!accent)
    }
  }
}

export function createSummaryBar(ctx: ViewContext): View {
  const mp = chip('MP')
  const rem = chip('완충까지')
  const exph = chip('EXP/H')
  const adh = chip('아데나/H')
  const el = h('div', { class: 'summary-bar' }, mp.root, rem.root, exph.root, adh.root)

  return {
    el,
    update(state) {
      const c = state.persisted.mpConfig
      const now = ctx.now()
      const mpVal = ctx.timer.displayMp(c, now)
      const pct = c.maxMp > 0 ? Math.round((mpVal / c.maxMp) * 100) : 0
      mp.set(`${mpVal}/${c.maxMp} · ${pct}%`)
      rem.set(formatDuration(ctx.timer.remainingSeconds(c, now)), true)
      const s = state.runtime.trackerStats
      exph.set(s.expPerHour != null ? `+${s.expPerHour.toFixed(2)}%` : '—')
      adh.set(s.adenaPerHour != null ? `+${Math.round(s.adenaPerHour).toLocaleString('en-US')}` : '—')
    }
  }
}
