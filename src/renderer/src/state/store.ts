/**
 * Tiny reactive store (renderer) + the app-wide AppStore.
 *
 * Browser-only: this file lives in the renderer and may touch `localStorage`.
 * It is the single source of truth that replaces the v2.x "DOM-as-anchor"
 * anti-pattern: OCR results and manual user input both *write to the store*, and
 * every view renders *from* the store. Nothing reads the current value back out
 * of an `<input>` to decide application state.
 *
 * Persistence: the AppStore serialises a {@link PersistedState} via the pure
 * `@core/domain/storage-schema` module and writes it to `localStorage` on every
 * change, debounced. Loading runs the same module's `migrate()` so old/garbage
 * payloads are repaired into a fully-typed shape.
 */

import {
  DEFAULT_STATE,
  migrate,
  type PersistedState
} from '@core/domain/storage-schema'
import {
  SessionTracker,
  type SessionSample,
  type SessionStats
} from '@core/domain/session-tracker'

/** A partial patch or an updater function over the current state. */
export type StorePatch<T> = Partial<T> | ((prev: T) => Partial<T>)

/** Subscriber notified after each committed change. */
export type StoreListener<T> = (state: T) => void

/** Unsubscribe handle returned by {@link Store.subscribe}. */
export type Unsubscribe = () => void

/** Minimal reactive store contract. */
export interface Store<T> {
  /** Current immutable snapshot. */
  get(): T
  /** Shallow-merge a patch (or updater result) and notify subscribers. */
  set(patch: StorePatch<T>): void
  /** Subscribe to changes; returns an unsubscribe handle. */
  subscribe(fn: StoreListener<T>): Unsubscribe
  /**
   * Subscribe to a derived slice. `fn` runs only when the selected value changes
   * (by `Object.is`). Returns an unsubscribe handle.
   */
  select<S>(selector: (state: T) => S, fn: StoreListener<S>): Unsubscribe
}

/**
 * Create a minimal reactive store over an initial value. Shallow merge on `set`,
 * `Object.is`-gated `select`, synchronous notification.
 */
export function createStore<T extends object>(initial: T): Store<T> {
  let state: T = initial
  const listeners = new Set<StoreListener<T>>()

  const get = (): T => state

  const set = (patch: StorePatch<T>): void => {
    const partial = typeof patch === 'function' ? patch(state) : patch
    state = { ...state, ...partial }
    for (const fn of [...listeners]) fn(state)
  }

  const subscribe = (fn: StoreListener<T>): Unsubscribe => {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  }

  const select = <S>(selector: (state: T) => S, fn: StoreListener<S>): Unsubscribe => {
    let prev = selector(state)
    return subscribe((next) => {
      const sel = selector(next)
      if (!Object.is(sel, prev)) {
        prev = sel
        fn(sel)
      }
    })
  }

  return { get, set, subscribe, select }
}

/** localStorage key for the unified persisted blob (replaces the seven v2.x keys). */
export const STORAGE_KEY = 'lmp.state.v3'

/** Default debounce window (ms) for persistence writes. */
const DEFAULT_PERSIST_DEBOUNCE_MS = 250

/** Minimal localStorage-shaped contract so the store is testable without a DOM. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Options for {@link createAppStore}. */
export interface AppStoreOptions {
  /** Storage backend; defaults to `window.localStorage` when available. */
  storage?: StorageLike | null
  /** Persistence debounce in ms. Default 250. */
  persistDebounceMs?: number
  /** Schedule a debounced flush. Defaults to `setTimeout`. */
  scheduler?: (fn: () => void, ms: number) => void
}

/** Live, derived runtime values not part of the persisted blob. */
export interface RuntimeState {
  /** Whether the MP fill timer is currently running. */
  timerRunning: boolean
  /** Latest derived session metrics. */
  trackerStats: SessionStats
}

/**
 * App-wide store: a {@link PersistedState} source of truth plus live runtime
 * fields, persisted to localStorage (debounced) through the pure storage-schema
 * module. OCR and user input both call the mutation helpers below.
 */
export interface AppStore {
  /** Underlying reactive store of the full app state. */
  readonly store: Store<AppState>
  /** Current snapshot. */
  get(): AppState
  /** Subscribe to any change. */
  subscribe(fn: StoreListener<AppState>): Unsubscribe
  /** Subscribe to a derived slice. */
  select<S>(selector: (state: AppState) => S, fn: StoreListener<S>): Unsubscribe

  /** Patch the persisted MP config (cur/max MP, wis, buffs, …). */
  setMpConfig(patch: Partial<AppState['persisted']['mpConfig']>): void
  /** Patch the persisted tracker counters/settings. */
  setTracker(patch: Partial<AppState['persisted']['tracker']>): void
  /** Replace the theme. */
  setTheme(theme: AppState['persisted']['theme']): void
  /** Patch UI settings. */
  setUi(patch: Partial<AppState['persisted']['ui']>): void
  /** Set the timer running flag (runtime-only, not persisted). */
  setTimerRunning(running: boolean): void

  /** Feed one timestamped tracker sample; recomputes derived stats. */
  ingestSample(sample: SessionSample): void
  /** Underlying tracker (for advanced callers/tests). */
  readonly tracker: SessionTracker

  /** Force an immediate (non-debounced) persistence flush. */
  flush(): void
}

/** The full in-memory application state. */
export interface AppState {
  persisted: PersistedState
  runtime: RuntimeState
}

function resolveStorage(opt?: StorageLike | null): StorageLike | null {
  if (opt !== undefined) return opt
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    // Access can throw (e.g. disabled cookies); fall through to null.
  }
  return null
}

/** Load + migrate persisted state from storage, falling back to defaults. */
export function loadPersisted(storage: StorageLike | null): PersistedState {
  if (!storage) return migrate(DEFAULT_STATE)
  let raw: string | null = null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    raw = null
  }
  if (raw == null) return migrate(DEFAULT_STATE)
  try {
    return migrate(JSON.parse(raw) as unknown)
  } catch {
    return migrate(DEFAULT_STATE)
  }
}

/**
 * Construct the app store. Wires a {@link SessionTracker} (window/idle settings
 * sourced from the persisted tracker) into the store and persists on change.
 */
export function createAppStore(options: AppStoreOptions = {}): AppStore {
  const storage = resolveStorage(options.storage)
  const debounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS
  const schedule =
    options.scheduler ??
    ((fn: () => void, ms: number): void => {
      setTimeout(fn, ms)
    })

  const persisted = loadPersisted(storage)
  const tracker = new SessionTracker({
    windowMs: persisted.tracker.windowMs,
    idleGapMs: persisted.tracker.idleGapMs
  })
  // Seed the tracker from persisted start/current so derived stats survive reload.
  if (persisted.tracker.startedAt != null) {
    const { startedAt, start, current } = persisted.tracker
    tracker.ingest({ t: startedAt, expPct: start.exp, adena: start.adena, level: start.level })
    if (current) {
      tracker.ingest({
        t: startedAt + 1,
        expPct: current.exp,
        adena: current.adena,
        level: current.level
      })
    }
  }

  const store = createStore<AppState>({
    persisted,
    runtime: {
      timerRunning: false,
      trackerStats: tracker.stats()
    }
  })

  let pendingFlush = false
  const writeNow = (): void => {
    pendingFlush = false
    if (!storage) return
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(store.get().persisted))
    } catch {
      // Quota/serialisation failures are non-fatal for the UI.
    }
  }
  const scheduleFlush = (): void => {
    if (pendingFlush) return
    pendingFlush = true
    schedule(writeNow, debounceMs)
  }

  const patchPersisted = (patch: Partial<PersistedState>): void => {
    store.set((prev) => ({ persisted: { ...prev.persisted, ...patch } }))
    scheduleFlush()
  }

  const setMpConfig: AppStore['setMpConfig'] = (patch) => {
    patchPersisted({ mpConfig: { ...store.get().persisted.mpConfig, ...patch } })
  }

  const setTracker: AppStore['setTracker'] = (patch) => {
    const next = { ...store.get().persisted.tracker, ...patch }
    patchPersisted({ tracker: next })
  }

  const setTheme: AppStore['setTheme'] = (theme) => {
    patchPersisted({ theme })
  }

  const setUi: AppStore['setUi'] = (patch) => {
    patchPersisted({ ui: { ...store.get().persisted.ui, ...patch } })
  }

  const setTimerRunning: AppStore['setTimerRunning'] = (running) => {
    store.set((prev) => ({ runtime: { ...prev.runtime, timerRunning: running } }))
  }

  const ingestSample: AppStore['ingestSample'] = (sample) => {
    tracker.ingest(sample)
    const stats = tracker.stats()
    // Mirror the freshest sample into persisted `current` so a reload keeps it.
    const cur = { level: sample.level, exp: sample.expPct, adena: sample.adena }
    store.set((prev) => ({
      persisted: { ...prev.persisted, tracker: { ...prev.persisted.tracker, current: cur } },
      runtime: { ...prev.runtime, trackerStats: stats }
    }))
    scheduleFlush()
  }

  const flush: AppStore['flush'] = () => {
    writeNow()
  }

  return {
    store,
    get: store.get,
    subscribe: store.subscribe,
    select: store.select,
    setMpConfig,
    setTracker,
    setTheme,
    setUi,
    setTimerRunning,
    ingestSample,
    tracker,
    flush
  }
}
