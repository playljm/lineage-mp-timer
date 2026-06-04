/** Maps the persisted ThemeName onto a design-system theme class on <body>. */
import type { ThemeName } from '@core/domain/storage-schema'

const THEME_CLASS: Record<ThemeName, string> = {
  green: 'theme-emerald',
  amber: 'theme-amber',
  blue: 'theme-cyan',
  mono: 'theme-mono'
}

const ALL = Object.values(THEME_CLASS)

export const THEME_OPTIONS: { value: ThemeName; label: string }[] = [
  { value: 'green', label: '에메랄드' },
  { value: 'blue', label: '시안' },
  { value: 'amber', label: '앰버' },
  { value: 'mono', label: '모노' }
]

export function applyTheme(name: ThemeName): void {
  document.body.classList.remove(...ALL)
  document.body.classList.add(THEME_CLASS[name] ?? THEME_CLASS.green)
}
