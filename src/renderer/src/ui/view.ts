/**
 * View contract shared by the app shell and every feature view.
 *
 * A view owns a DOM subtree (`el`), renders FROM the store on `update(state)`,
 * and never reads application state back out of its inputs. The shell builds the
 * shared context, mounts views, and calls `update` on each store change + a
 * low-frequency render tick (for the live countdown).
 */
import type { AppStore, AppState } from '../state/store'
import type { DetectionController } from '../ocr/detection'
import type { MpTimer } from '../timer/mp-timer'
import type { IpcApi } from '@shared/ipc-contract'

/** Imperative actions the shell exposes to views (start/pause/reset, region pick…). */
export interface AppActions {
  startPause(): void
  reset(): void
  setCompact(on: boolean): void
  /** Pick an OCR region for a target ('mp' | 'mpBar' | 'exp' | 'level' | 'adena' | 'game'). */
  pickRegion(target: string): Promise<void>
  /** Re-anchor the MP countdown (call after manual config edits). */
  recomputeTimer(): void
}

export interface ViewContext {
  app: AppStore
  api: IpcApi
  detection: DetectionController
  timer: MpTimer
  actions: AppActions
  /** Live wall-clock ms, refreshed each render tick (kept out of pure core). */
  now(): number
}

export interface View {
  el: HTMLElement
  update(state: AppState): void
  destroy?(): void
}

export type ViewFactory = (ctx: ViewContext) => View
