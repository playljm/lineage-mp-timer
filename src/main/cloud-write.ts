/**
 * Atomic install/rollback of a cloud-synced `lineage.traineddata`.
 *
 * The destination is `app.getPath('userData')/tessdata`, which stays writable in
 * packaged builds (the app's install dir under `resources/` is not). The write
 * is atomic — bytes land in a `.tmp` sibling and are `rename`d into place — and
 * the previous file is preserved as `lineage.previous.traineddata` so a freshly
 * installed model that fails downstream validation can be rolled back.
 *
 * The renderer hands us an `ArrayBuffer`; we validate a minimum length to reject
 * truncated/empty downloads before touching the live file.
 */

import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

/** A traineddata smaller than this is almost certainly a corrupt download. */
const MIN_TRAINEDDATA_BYTES = 1024

const TARGET_NAME = 'lineage.traineddata'
const PREVIOUS_NAME = 'lineage.previous.traineddata'
const FAILED_NAME = 'lineage.failed.traineddata'

function tessdataDir(): string {
  return join(app.getPath('userData'), 'tessdata')
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * Atomically install a new traineddata, backing up the current one.
 *
 * @param bytes Raw traineddata payload from the renderer.
 * @returns `{ ok: true }` on success, else `{ ok: false, error }` with a stable
 *   machine-readable error code (`invalid_bytes`, `io_error`).
 */
export async function cloudWriteTraineddata(
  bytes: ArrayBuffer
): Promise<{ ok: boolean; error?: string }> {
  if (!bytes || bytes.byteLength < MIN_TRAINEDDATA_BYTES) {
    return { ok: false, error: 'invalid_bytes' }
  }

  try {
    const dir = tessdataDir()
    await mkdir(dir, { recursive: true })

    const targetPath = join(dir, TARGET_NAME)
    const previousPath = join(dir, PREVIOUS_NAME)
    const tmpPath = `${targetPath}.tmp`

    // Stage the new bytes off to the side first.
    await writeFile(tmpPath, Buffer.from(bytes))

    // Preserve the current model as `.previous` for rollback. A backup failure
    // is non-fatal: we proceed with the install but rollback won't be possible.
    if (await exists(targetPath)) {
      try {
        if (await exists(previousPath)) await rm(previousPath, { force: true })
        await rename(targetPath, previousPath)
      } catch {
        /* backup failed — continue without rollback capability */
      }
    }

    await rename(tmpPath, targetPath)
    return { ok: true }
  } catch {
    return { ok: false, error: 'io_error' }
  }
}

/**
 * Restore the previously installed traineddata.
 *
 * The currently-installed (failed) model is moved aside to
 * `lineage.failed.traineddata` before the `.previous` backup is promoted back.
 *
 * @returns `{ ok: true }` when a backup existed and was restored, else
 *   `{ ok: false }`.
 */
export async function cloudRollbackTraineddata(): Promise<{ ok: boolean }> {
  try {
    const dir = tessdataDir()
    const targetPath = join(dir, TARGET_NAME)
    const previousPath = join(dir, PREVIOUS_NAME)
    const failedPath = join(dir, FAILED_NAME)

    if (!(await exists(previousPath))) return { ok: false }

    if (await exists(targetPath)) {
      try {
        if (await exists(failedPath)) await rm(failedPath, { force: true })
        await rename(targetPath, failedPath)
      } catch {
        /* keep going — restoring the good model matters more */
      }
    }

    await rename(previousPath, targetPath)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}
