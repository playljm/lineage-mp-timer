/**
 * Minimal hyperscript DOM helper. Keeps the views declarative without pulling in
 * a framework — the renewal is intentionally vanilla TS + Vite.
 */

type Child = Node | string | number | null | undefined | false
type Props = Record<string, unknown>

/** Create an element with props/attributes/handlers and children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue
    if (key === 'class') el.className = String(value)
    else if (key === 'dataset') Object.assign(el.dataset, value as Record<string, string>)
    else if (key === 'style' && typeof value === 'object')
      Object.assign(el.style, value as Partial<CSSStyleDeclaration>)
    else if (key.startsWith('on') && typeof value === 'function')
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    else if (key in el) (el as unknown as Record<string, unknown>)[key] = value
    else el.setAttribute(key, String(value))
  }
  append(el, children)
  return el
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c)
  }
}

export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild)
}

/** Query helper that throws if the element is missing (fail fast on typos). */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

/** Accessible toggle switch built from the design-system .toggle component. */
export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const root = h('button', {
    class: 'toggle',
    type: 'button',
    role: 'switch',
    'aria-checked': String(checked)
  },
    h('span', { class: 'toggle__track' }, h('span', { class: 'toggle__thumb' })),
    h('span', {}, label)
  )
  root.addEventListener('click', () => {
    const next = root.getAttribute('aria-checked') !== 'true'
    root.setAttribute('aria-checked', String(next))
    onChange(next)
  })
  return root
}
