/**
 * Resolves on-disk locations for the bundled Tesseract runtime.
 *
 * Two layouts exist:
 * - packaged: assets are copied under `process.resourcesPath/tesseract/*`
 *   (see electron-builder `extraResources` in package.json).
 * - dev: assets are loaded straight from `node_modules` + `build/tessdata`,
 *   which keeps the app working in CDN-blocked environments.
 *
 * Paths are returned as `file://` URLs because tesseract.js consumes them as
 * URLs in the renderer. When the dev layout is incomplete we return nulls so the
 * renderer can fall back to the CDN.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import type { ResourcePaths } from '@shared/ipc-contract'

const EMPTY: ResourcePaths = { workerPath: null, corePath: null, langPath: null }

function toUrl(p: string): string {
  return pathToFileURL(p).href
}

/**
 * Resolve worker/core/lang locations for the active runtime layout.
 *
 * @returns A {@link ResourcePaths} with `file://` URLs, or all-null when the
 *   dev layout is missing files (signals the renderer to use the CDN).
 */
export function getResourcePaths(): ResourcePaths {
  try {
    if (app.isPackaged) {
      const tessBase = join(process.resourcesPath, 'tesseract')
      if (!existsSync(tessBase)) return EMPTY
      return {
        workerPath: toUrl(join(tessBase, 'worker.min.js')),
        corePath: toUrl(join(tessBase, 'core')),
        langPath: toUrl(join(tessBase, 'tessdata'))
      }
    }

    // dev: load directly from the project tree.
    const projectRoot = app.getAppPath()
    const workerPath = join(projectRoot, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js')
    const corePath = join(projectRoot, 'node_modules', 'tesseract.js-core')
    const langPath = join(projectRoot, 'build', 'tessdata')
    if (!existsSync(workerPath) || !existsSync(corePath) || !existsSync(langPath)) {
      return EMPTY
    }
    return {
      workerPath: toUrl(workerPath),
      corePath: toUrl(corePath),
      langPath: toUrl(langPath)
    }
  } catch {
    return EMPTY
  }
}
