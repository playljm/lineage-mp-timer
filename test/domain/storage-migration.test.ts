/**
 * Schema migration tests — focuses on the v1→v2 window-capture fields. Ensures
 * existing (v1) users' persisted blobs keep their screen regions and gain the new
 * captureMode/windowId/windowTitle defaults without data loss.
 */
import { describe, it, expect } from 'vitest'
import { migrate, SCHEMA_VERSION } from '@core/domain/storage-schema'

describe('storage-schema migration v1 → v2 (window capture)', () => {
  it('defaults captureMode to screen and stamps the current schema version', () => {
    const v1 = {
      schemaVersion: 1,
      autoDetect: {
        mode: 'manual',
        mpRegion: { x: 10, y: 20, width: 100, height: 30, sourceId: 'screen:0:0', scaleFactor: 1 }
      }
    }
    const out = migrate(v1)
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
    expect(out.autoDetect.captureMode).toBe('screen')
    expect(out.autoDetect.windowId).toBeNull()
    expect(out.autoDetect.windowTitle).toBeNull()
    // v2 → v3 adds windowRoi overrides (all null = use auto-detection).
    expect(out.autoDetect.windowRoi).toEqual({
      mp: null,
      mpBar: null,
      exp: null,
      level: null,
      adena: null
    })
    // Existing screen region is preserved.
    expect(out.autoDetect.mpRegion).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 30,
      sourceId: 'screen:0:0',
      scaleFactor: 1
    })
  })

  it('preserves an explicit window-mode blob round-trip', () => {
    const v2 = {
      schemaVersion: 2,
      autoDetect: { captureMode: 'window', windowId: 'window:123:0', windowTitle: 'Lineage' }
    }
    const out = migrate(v2)
    expect(out.autoDetect.captureMode).toBe('window')
    expect(out.autoDetect.windowTitle).toBe('Lineage')
  })

  it('garbage input falls back to defaults (screen mode)', () => {
    const out = migrate(null)
    expect(out.autoDetect.captureMode).toBe('screen')
    expect(out.schemaVersion).toBe(SCHEMA_VERSION)
  })
})
