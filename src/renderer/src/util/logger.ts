/**
 * Central renderer logger: ring buffer + console mirror + subscribable stream +
 * text export. Exposed on `window.lmpLog` so a user can, from DevTools (F12):
 *   copy(lmpLog.export())   // copy the full log
 *   lmpLog.tail(30)         // inspect the last entries
 * The diagnostics drawer also renders the live tail and offers copy/save.
 *
 * This exists to make the live capture→OCR pipeline (which can't be unit-tested
 * against a real game) diagnosable from the field.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  t: number
  level: LogLevel
  tag: string
  msg: string
  data?: unknown
}

type Listener = (e: LogEntry) => void

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

function stamp(t: number): string {
  const d = new Date(t)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

class Logger {
  private buf: LogEntry[] = []
  private readonly max = 1500
  private readonly listeners = new Set<Listener>()
  consoleMirror = true

  log(level: LogLevel, tag: string, msg: string, data?: unknown): void {
    const entry: LogEntry = { t: Date.now(), level, tag, msg, data }
    this.buf.push(entry)
    if (this.buf.length > this.max) this.buf.shift()
    if (this.consoleMirror) {
      const fn = console[level] ?? console.log
      if (data !== undefined) fn(`[${tag}] ${msg}`, data)
      else fn(`[${tag}] ${msg}`)
    }
    for (const l of [...this.listeners]) l(entry)
  }

  debug(tag: string, msg: string, data?: unknown): void {
    this.log('debug', tag, msg, data)
  }
  info(tag: string, msg: string, data?: unknown): void {
    this.log('info', tag, msg, data)
  }
  warn(tag: string, msg: string, data?: unknown): void {
    this.log('warn', tag, msg, data)
  }
  error(tag: string, msg: string, data?: unknown): void {
    this.log('error', tag, msg, data)
  }

  onLog(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  tail(n = 200): LogEntry[] {
    return this.buf.slice(-n)
  }

  clear(): void {
    this.buf = []
  }

  /** Full log as plain text, newest last. */
  export(): string {
    const head = `Lineage MP Timer v3.0 diagnostic log\nexported ${stamp(Date.now())} · ${this.buf.length} entries\n${'-'.repeat(60)}\n`
    return (
      head +
      this.buf
        .map((e) => {
          const base = `${stamp(e.t)} ${e.level.toUpperCase().padEnd(5)} [${e.tag}] ${e.msg}`
          if (e.data === undefined) return base
          let extra: string
          try {
            extra = JSON.stringify(e.data)
          } catch {
            extra = String(e.data)
          }
          return `${base} | ${extra}`
        })
        .join('\n')
    )
  }
}

export const logger = new Logger()

// Expose for quick field debugging from the DevTools console.
if (typeof window !== 'undefined') {
  ;(window as unknown as { lmpLog: Logger }).lmpLog = logger
}
