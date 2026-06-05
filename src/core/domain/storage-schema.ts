/**
 * Persisted application state — typed shape, defaults, and versioned migration.
 *
 * Pure, dependency-free, DOM-free AND node-free. This is the single source of
 * truth for everything the renderer stores in localStorage (the v2.x code spread
 * the same data across seven ad-hoc keys: `lmp.presets.v1`, `lmp.settings.v1`,
 * `lmp.last.v1`, `lmp.tracker.v1`, `lmp.hotkeys.v1`, `lmp.items.v1`,
 * `lmp.autoDetect.v1`).
 *
 * Migration model (v3.0):
 *   The v2.x loaders accumulated ~10 ad-hoc boolean flags (`_engineMigratedToHybrid`,
 *   `_roiInvalidatedFor160`, `_roiInvalidatedFor162`, `_roiInvalidatedFor163`,
 *   `_roiInvalidatedFor164`, `_roiInvalidatedFor181`, `_barModeMigratedToOcr`, …)
 *   to make each one-shot data fix idempotent. That is replaced here by a single
 *   integer `schemaVersion` plus an ordered list of migration steps. `migrate()`
 *   runs every step whose target version is greater than the stored version, in
 *   order, then stamps the state with the current {@link SCHEMA_VERSION}. Each
 *   step therefore runs exactly once per install, with no per-flag bookkeeping.
 */

import type { MovementState, LocationKind } from './mp-engine'
import type { RegionKind } from '../ocr/types'

/** Current persisted schema version. Bump and add a migration when the shape changes. */
export const SCHEMA_VERSION = 3 as const

/** Theme identifiers carried over from v2.x settings. */
export type ThemeName = 'green' | 'amber' | 'blue' | 'mono'

/** MP engine configuration as persisted (superset of {@link MpConfig}). */
export interface MpConfigState {
  curMp: number
  maxMp: number
  wis: number
  useBluePotion: boolean
  useMeditation: boolean
  hasCrystalStaff: boolean
  location: LocationKind
  customLocationBonus: number
  state: MovementState
  /** Target fill percent (1..100). */
  targetPct: number
}

/** Tracker session counters + behaviour settings. */
export interface TrackerState {
  /** Whether a session is currently running. */
  active: boolean
  /** Session start epoch ms, or null when idle. */
  startedAt: number | null
  start: { level: number; exp: number; adena: number }
  current: { level: number; exp: number; adena: number }
  /** Sliding-window width in ms for rate/ETA fits (0 = full session). */
  windowMs: number
  /** Gaps longer than this (ms) are treated as idle and excluded (0 = disabled). */
  idleGapMs: number
}

/** A single global/window hotkey binding. */
export interface HotkeyBinding {
  accel: string
  enabled: boolean
  scope: 'global' | 'window'
  label: string
}

/** Named set of hotkey bindings. */
export interface HotkeyState {
  alwaysOnTop: HotkeyBinding
  toggleHide: HotkeyBinding
  startPause: HotkeyBinding
  reset: HotkeyBinding
}

/** A tracked hunt item (loot value bookkeeping). */
export interface ItemEntry {
  id: string
  name: string
  price: number
  qty: number
}

/** A user-drawn ROI box in WINDOW-FRAME physical pixels (window-capture override). */
export interface WindowRoiBox {
  x: number
  y: number
  width: number
  height: number
}

/** Per-region manual ROI overrides for window mode (null = use auto-detection). */
export interface WindowRoiOverrides {
  mp: WindowRoiBox | null
  mpBar: WindowRoiBox | null
  exp: WindowRoiBox | null
  level: WindowRoiBox | null
  adena: WindowRoiBox | null
}

/** A screen-space capture region for OCR. */
export interface CaptureRegion {
  x: number
  y: number
  width: number
  height: number
  sourceId?: string | null
  displayId?: string | null
  displayLabel?: string | null
  scaleFactor?: number
}

export type OcrEngineMode = 'tesseract' | 'paddle' | 'hybrid'
export type AutoDetectMode = 'manual' | 'auto'
/**
 * Capture source kind:
 * - `screen`: capture a monitor + a user-picked region (legacy default).
 * - `window`: capture the game WINDOW by title — monitor-independent; ROIs are
 *   window-relative and auto-derived by the ROI detector. Solves the dual-monitor
 *   / DPI fragility because there is no screen-to-source matching to get wrong.
 */
export type CaptureMode = 'screen' | 'window'

/** OCR / auto-detect configuration (port of the v2.x autoDetect blob). */
export interface AutoDetectState {
  enabled: boolean
  sourceId: string | null
  displayId: string | null
  displayLabel: string | null
  scaleFactor: number
  confidenceThreshold: number
  intervalMs: number
  preprocess: boolean
  autoStart: boolean
  autoStartTracker: boolean
  stabilityRequired: number
  ocrEngine: OcrEngineMode
  mpSingleNumber: boolean
  showPreview: boolean
  mpRegion: CaptureRegion | null
  mpBarRegion: CaptureRegion | null
  useMpBar: boolean
  mpBarMaxX: number
  mpBarRefColor: { r: number; g: number; b: number } | null
  expRegion: CaptureRegion | null
  levelRegion: CaptureRegion | null
  adenaRegion: CaptureRegion | null
  levelOffset: number
  mode: AutoDetectMode
  gameRegion: CaptureRegion | null
  roiCacheMaxAge: number
  roiFailThreshold: number
  /** Capture source kind. `window` captures the game window by title (monitor-independent). */
  captureMode: CaptureMode
  /** Last-resolved window capture source id (`window:HWND:0`) — volatile, re-resolved by title each start. */
  windowId: string | null
  /** Saved game-window title — the STABLE key used to re-resolve {@link windowId}. */
  windowTitle: string | null
  /** Manual ROI overrides (window-frame px) — take precedence over auto-detection in window mode. */
  windowRoi: WindowRoiOverrides
}

/** Misc UI/runtime settings (port of the v2.x settings blob). */
export interface UiSettings {
  sound: boolean
  toast: boolean
  minimizeOnClose: boolean
  alwaysOnTop: boolean
  volume: number
  expAutoFormatDelayMs: number
  compactMode: boolean
}

/** A saved MP configuration preset. */
export interface PresetEntry {
  name: string
  config: Partial<MpConfigState>
}

/** Full persisted application state. */
export interface PersistedState {
  /** Integer schema version; drives {@link migrate}. */
  schemaVersion: number
  mpConfig: MpConfigState
  tracker: TrackerState
  hotkeys: HotkeyState
  items: ItemEntry[]
  presets: PresetEntry[]
  autoDetect: AutoDetectState
  ui: UiSettings
  theme: ThemeName
}

/** Default hotkey bindings (Korean labels preserved from v2.x). */
export const DEFAULT_HOTKEYS: HotkeyState = {
  alwaysOnTop: { accel: 'F1', enabled: true, scope: 'global', label: '항상 위' },
  toggleHide: { accel: 'F2', enabled: true, scope: 'global', label: '창 숨기기' },
  startPause: { accel: 'Space', enabled: true, scope: 'window', label: '타이머 시작/정지' },
  reset: { accel: 'R', enabled: true, scope: 'window', label: '타이머 리셋' }
}

/** Default hunt items (Korean names preserved from v2.x). */
export const DEFAULT_ITEMS: ItemEntry[] = [
  { id: 'it-minil', name: '미늘갑옷', price: 10000, qty: 0 },
  { id: 'it-magic', name: '마력의 지팡이', price: 4500, qty: 0 },
  { id: 'it-greataxe', name: '대형 도끼', price: 6500, qty: 0 },
  { id: 'it-bronze', name: '청동판금갑옷', price: 8000, qty: 0 }
]

/** Default OCR / auto-detect configuration. */
export const DEFAULT_AUTO_DETECT: AutoDetectState = {
  enabled: false,
  sourceId: null,
  displayId: null,
  displayLabel: null,
  scaleFactor: 1,
  confidenceThreshold: 0,
  intervalMs: 1000,
  preprocess: true,
  autoStart: false,
  autoStartTracker: false,
  stabilityRequired: 3,
  ocrEngine: 'hybrid',
  mpSingleNumber: true,
  showPreview: true,
  mpRegion: null,
  mpBarRegion: null,
  useMpBar: false,
  mpBarMaxX: 0,
  mpBarRefColor: null,
  expRegion: null,
  levelRegion: null,
  adenaRegion: null,
  levelOffset: 0,
  mode: 'manual',
  gameRegion: null,
  roiCacheMaxAge: 300,
  roiFailThreshold: 5,
  captureMode: 'screen',
  windowId: null,
  windowTitle: null,
  windowRoi: { mp: null, mpBar: null, exp: null, level: null, adena: null }
}

/** Default UI settings. */
export const DEFAULT_UI: UiSettings = {
  sound: true,
  toast: true,
  minimizeOnClose: false,
  alwaysOnTop: false,
  volume: 0.5,
  expAutoFormatDelayMs: 3000,
  compactMode: false
}

/** Default MP engine configuration. */
export const DEFAULT_MP_CONFIG: MpConfigState = {
  curMp: 0,
  maxMp: 1,
  wis: 15,
  useBluePotion: true,
  useMeditation: true,
  hasCrystalStaff: false,
  location: 'field',
  customLocationBonus: 0,
  state: 'standing',
  targetPct: 100
}

/** Default tracker state. */
export const DEFAULT_TRACKER: TrackerState = {
  active: false,
  startedAt: null,
  start: { level: 1, exp: 0, adena: 0 },
  current: { level: 1, exp: 0, adena: 0 },
  windowMs: 0,
  idleGapMs: 0
}

/** The canonical default state for a fresh install. */
export const DEFAULT_STATE: PersistedState = {
  schemaVersion: SCHEMA_VERSION,
  mpConfig: { ...DEFAULT_MP_CONFIG },
  tracker: structuredCloneTracker(DEFAULT_TRACKER),
  hotkeys: structuredCloneHotkeys(DEFAULT_HOTKEYS),
  items: DEFAULT_ITEMS.map((i) => ({ ...i })),
  presets: [],
  autoDetect: { ...DEFAULT_AUTO_DETECT },
  ui: { ...DEFAULT_UI },
  theme: 'green'
}

/** A single ordered migration step. `to` is the schema version it produces. */
export interface Migration {
  /** Target schema version this step upgrades the state to. */
  to: number
  /** Short human description of what the step does. */
  description: string
  /** Transform the loosely-typed state in place / returning the next shape. */
  apply: (state: Record<string, unknown>) => Record<string, unknown>
}

/**
 * Ordered migration list. To evolve the schema: add a step with `to = next
 * version`, bump {@link SCHEMA_VERSION}, and never reorder or mutate prior steps.
 *
 * The v2.x one-shot data fixes (paddle->hybrid engine promotion, the five
 * `cachedROIs` invalidations, the bar-mode->OCR switch, the legacy `region` ->
 * `mpRegion` rename) are intentionally NOT replayed here: v3.0 starts from a
 * clean typed shape and drops the transient ROI cache entirely, so they have no
 * v3 equivalent. The list begins empty at version 1 and grows from here.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    to: 2,
    description: 'add autoDetect.captureMode/windowId/windowTitle (window-capture mode)',
    apply: (state) => {
      const ad = isObject(state['autoDetect']) ? { ...(state['autoDetect'] as object) } : {}
      const rec = ad as Record<string, unknown>
      if (rec['captureMode'] === undefined) rec['captureMode'] = 'screen'
      if (rec['windowId'] === undefined) rec['windowId'] = null
      if (rec['windowTitle'] === undefined) rec['windowTitle'] = null
      return { ...state, autoDetect: rec }
    }
  },
  {
    to: 3,
    description: 'add autoDetect.windowRoi (manual window-mode ROI overrides)',
    apply: (state) => {
      const ad = isObject(state['autoDetect']) ? { ...(state['autoDetect'] as object) } : {}
      const rec = ad as Record<string, unknown>
      if (rec['windowRoi'] === undefined) {
        rec['windowRoi'] = { mp: null, mpBar: null, exp: null, level: null, adena: null }
      }
      return { ...state, autoDetect: rec }
    }
  }
]

function structuredCloneTracker(t: TrackerState): TrackerState {
  return {
    active: t.active,
    startedAt: t.startedAt,
    start: { ...t.start },
    current: { ...t.current },
    windowMs: t.windowMs,
    idleGapMs: t.idleGapMs
  }
}

function structuredCloneHotkeys(h: HotkeyState): HotkeyState {
  return {
    alwaysOnTop: { ...h.alwaysOnTop },
    toggleHide: { ...h.toggleHide },
    startPause: { ...h.startPause },
    reset: { ...h.reset }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function str<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

const LOCATIONS: readonly LocationKind[] = ['field', 'tavern', 'dungeon', 'custom']
const STATES: readonly MovementState[] = ['standing', 'moving', 'combat', 'blocked']
const THEMES: readonly ThemeName[] = ['green', 'amber', 'blue', 'mono']
const ENGINES: readonly OcrEngineMode[] = ['tesseract', 'paddle', 'hybrid']
const DETECT_MODES: readonly AutoDetectMode[] = ['manual', 'auto']
const CAPTURE_MODES: readonly CaptureMode[] = ['screen', 'window']
const REGION_KINDS: readonly RegionKind[] = ['mp', 'exp', 'level', 'adena']

/**
 * Validate, default-fill, and version-migrate arbitrary persisted input into a
 * fully-typed {@link PersistedState}. Never throws: unknown/garbage input yields
 * {@link DEFAULT_STATE}. Applies every pending migration in order, then coerces
 * each section against its defaults so missing/typo'd fields are repaired.
 */
export function migrate(raw: unknown): PersistedState {
  if (!isObject(raw)) return cloneDefault()

  // Run ordered migrations from the stored version up to current.
  let work: Record<string, unknown> = { ...raw }
  const fromVersion = num(work['schemaVersion'], 0)
  for (const m of MIGRATIONS) {
    if (m.to > fromVersion) work = m.apply(work)
  }

  return coerceState(work)
}

function cloneDefault(): PersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    mpConfig: { ...DEFAULT_MP_CONFIG },
    tracker: structuredCloneTracker(DEFAULT_TRACKER),
    hotkeys: structuredCloneHotkeys(DEFAULT_HOTKEYS),
    items: DEFAULT_ITEMS.map((i) => ({ ...i })),
    presets: [],
    autoDetect: { ...DEFAULT_AUTO_DETECT },
    ui: { ...DEFAULT_UI },
    theme: 'green'
  }
}

function coerceState(work: Record<string, unknown>): PersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    mpConfig: coerceMpConfig(work['mpConfig']),
    tracker: coerceTracker(work['tracker']),
    hotkeys: coerceHotkeys(work['hotkeys']),
    items: coerceItems(work['items']),
    presets: coercePresets(work['presets']),
    autoDetect: coerceAutoDetect(work['autoDetect']),
    ui: coerceUi(work['ui']),
    theme: str(work['theme'], THEMES, 'green')
  }
}

function coerceMpConfig(v: unknown): MpConfigState {
  if (!isObject(v)) return { ...DEFAULT_MP_CONFIG }
  return {
    curMp: num(v['curMp'], DEFAULT_MP_CONFIG.curMp),
    maxMp: num(v['maxMp'], DEFAULT_MP_CONFIG.maxMp),
    wis: num(v['wis'], DEFAULT_MP_CONFIG.wis),
    useBluePotion: bool(v['useBluePotion'], DEFAULT_MP_CONFIG.useBluePotion),
    useMeditation: bool(v['useMeditation'], DEFAULT_MP_CONFIG.useMeditation),
    hasCrystalStaff: bool(v['hasCrystalStaff'], DEFAULT_MP_CONFIG.hasCrystalStaff),
    location: str(v['location'], LOCATIONS, DEFAULT_MP_CONFIG.location),
    customLocationBonus: num(v['customLocationBonus'], DEFAULT_MP_CONFIG.customLocationBonus),
    state: str(v['state'], STATES, DEFAULT_MP_CONFIG.state),
    targetPct: num(v['targetPct'], DEFAULT_MP_CONFIG.targetPct)
  }
}

function coerceCounters(
  v: unknown,
  fallback: { level: number; exp: number; adena: number }
): { level: number; exp: number; adena: number } {
  if (!isObject(v)) return { ...fallback }
  return {
    level: num(v['level'], fallback.level),
    exp: num(v['exp'], fallback.exp),
    adena: num(v['adena'], fallback.adena)
  }
}

function coerceTracker(v: unknown): TrackerState {
  if (!isObject(v)) return structuredCloneTracker(DEFAULT_TRACKER)
  const startedAt = v['startedAt']
  return {
    active: bool(v['active'], DEFAULT_TRACKER.active),
    startedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : null,
    start: coerceCounters(v['start'], DEFAULT_TRACKER.start),
    current: coerceCounters(v['current'], DEFAULT_TRACKER.current),
    windowMs: num(v['windowMs'], DEFAULT_TRACKER.windowMs),
    idleGapMs: num(v['idleGapMs'], DEFAULT_TRACKER.idleGapMs)
  }
}

function coerceHotkey(v: unknown, fallback: HotkeyBinding): HotkeyBinding {
  if (!isObject(v)) return { ...fallback }
  return {
    accel: typeof v['accel'] === 'string' ? v['accel'] : fallback.accel,
    enabled: bool(v['enabled'], fallback.enabled),
    scope: str(v['scope'], ['global', 'window'] as const, fallback.scope),
    label: typeof v['label'] === 'string' ? v['label'] : fallback.label
  }
}

function coerceHotkeys(v: unknown): HotkeyState {
  if (!isObject(v)) return structuredCloneHotkeys(DEFAULT_HOTKEYS)
  return {
    alwaysOnTop: coerceHotkey(v['alwaysOnTop'], DEFAULT_HOTKEYS.alwaysOnTop),
    toggleHide: coerceHotkey(v['toggleHide'], DEFAULT_HOTKEYS.toggleHide),
    startPause: coerceHotkey(v['startPause'], DEFAULT_HOTKEYS.startPause),
    reset: coerceHotkey(v['reset'], DEFAULT_HOTKEYS.reset)
  }
}

function coerceItems(v: unknown): ItemEntry[] {
  if (!Array.isArray(v) || v.length === 0) return DEFAULT_ITEMS.map((i) => ({ ...i }))
  const out: ItemEntry[] = []
  for (const raw of v) {
    if (!isObject(raw)) continue
    if (typeof raw['id'] !== 'string' || typeof raw['name'] !== 'string') continue
    out.push({
      id: raw['id'],
      name: raw['name'],
      price: num(raw['price'], 0),
      qty: num(raw['qty'], 0)
    })
  }
  return out.length > 0 ? out : DEFAULT_ITEMS.map((i) => ({ ...i }))
}

function coercePresets(v: unknown): PresetEntry[] {
  if (!Array.isArray(v)) return []
  const out: PresetEntry[] = []
  for (const raw of v) {
    if (!isObject(raw) || typeof raw['name'] !== 'string') continue
    const config = isObject(raw['config']) ? (raw['config'] as Partial<MpConfigState>) : {}
    out.push({ name: raw['name'], config })
  }
  return out
}

function coerceRegion(v: unknown): CaptureRegion | null {
  if (!isObject(v)) return null
  const region: CaptureRegion = {
    x: num(v['x'], 0),
    y: num(v['y'], 0),
    width: num(v['width'], 0),
    height: num(v['height'], 0)
  }
  if (typeof v['sourceId'] === 'string') region.sourceId = v['sourceId']
  if (typeof v['displayId'] === 'string') region.displayId = v['displayId']
  if (typeof v['displayLabel'] === 'string') region.displayLabel = v['displayLabel']
  if (typeof v['scaleFactor'] === 'number') region.scaleFactor = v['scaleFactor']
  return region
}

function coerceRefColor(v: unknown): { r: number; g: number; b: number } | null {
  if (!isObject(v)) return null
  return { r: num(v['r'], 0), g: num(v['g'], 0), b: num(v['b'], 0) }
}

function coerceAutoDetect(v: unknown): AutoDetectState {
  if (!isObject(v)) return { ...DEFAULT_AUTO_DETECT }
  const d = DEFAULT_AUTO_DETECT
  return {
    enabled: bool(v['enabled'], d.enabled),
    sourceId: typeof v['sourceId'] === 'string' ? v['sourceId'] : d.sourceId,
    displayId: typeof v['displayId'] === 'string' ? v['displayId'] : d.displayId,
    displayLabel: typeof v['displayLabel'] === 'string' ? v['displayLabel'] : d.displayLabel,
    scaleFactor: num(v['scaleFactor'], d.scaleFactor),
    confidenceThreshold: num(v['confidenceThreshold'], d.confidenceThreshold),
    intervalMs: num(v['intervalMs'], d.intervalMs),
    preprocess: bool(v['preprocess'], d.preprocess),
    autoStart: bool(v['autoStart'], d.autoStart),
    autoStartTracker: bool(v['autoStartTracker'], d.autoStartTracker),
    stabilityRequired: num(v['stabilityRequired'], d.stabilityRequired),
    ocrEngine: str(v['ocrEngine'], ENGINES, d.ocrEngine),
    mpSingleNumber: bool(v['mpSingleNumber'], d.mpSingleNumber),
    showPreview: bool(v['showPreview'], d.showPreview),
    mpRegion: coerceRegion(v['mpRegion']),
    mpBarRegion: coerceRegion(v['mpBarRegion']),
    useMpBar: bool(v['useMpBar'], d.useMpBar),
    mpBarMaxX: num(v['mpBarMaxX'], d.mpBarMaxX),
    mpBarRefColor: coerceRefColor(v['mpBarRefColor']),
    expRegion: coerceRegion(v['expRegion']),
    levelRegion: coerceRegion(v['levelRegion']),
    adenaRegion: coerceRegion(v['adenaRegion']),
    levelOffset: num(v['levelOffset'], d.levelOffset),
    mode: str(v['mode'], DETECT_MODES, d.mode),
    gameRegion: coerceRegion(v['gameRegion']),
    roiCacheMaxAge: num(v['roiCacheMaxAge'], d.roiCacheMaxAge),
    roiFailThreshold: num(v['roiFailThreshold'], d.roiFailThreshold),
    captureMode: str(v['captureMode'], CAPTURE_MODES, d.captureMode),
    windowId: typeof v['windowId'] === 'string' ? v['windowId'] : d.windowId,
    windowTitle: typeof v['windowTitle'] === 'string' ? v['windowTitle'] : d.windowTitle,
    windowRoi: coerceWindowRoi(v['windowRoi'])
  }
}

function coerceRoiBox(v: unknown): WindowRoiBox | null {
  if (!isObject(v)) return null
  const x = num(v['x'], NaN)
  const y = num(v['y'], NaN)
  const width = num(v['width'], NaN)
  const height = num(v['height'], NaN)
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

function coerceWindowRoi(v: unknown): WindowRoiOverrides {
  const o = isObject(v) ? v : {}
  return {
    mp: coerceRoiBox(o['mp']),
    mpBar: coerceRoiBox(o['mpBar']),
    exp: coerceRoiBox(o['exp']),
    level: coerceRoiBox(o['level']),
    adena: coerceRoiBox(o['adena'])
  }
}

function coerceUi(v: unknown): UiSettings {
  if (!isObject(v)) return { ...DEFAULT_UI }
  const d = DEFAULT_UI
  return {
    sound: bool(v['sound'], d.sound),
    toast: bool(v['toast'], d.toast),
    minimizeOnClose: bool(v['minimizeOnClose'], d.minimizeOnClose),
    alwaysOnTop: bool(v['alwaysOnTop'], d.alwaysOnTop),
    volume: num(v['volume'], d.volume),
    expAutoFormatDelayMs: num(v['expAutoFormatDelayMs'], d.expAutoFormatDelayMs),
    compactMode: bool(v['compactMode'], d.compactMode)
  }
}

/** The OCR region kinds a {@link CaptureRegion} can describe (re-exported for callers). */
export { REGION_KINDS }
