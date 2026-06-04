import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

const root = import.meta.dirname
const r = (p: string): string => resolve(root, p)

// electron-vite default outDirs (out/main, out/preload, out/renderer) are exactly
// what we want, so only entry inputs + aliases are configured here.
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: r('src/main/index.ts') }
      }
    },
    resolve: {
      alias: {
        '@shared': r('src/shared'),
        '@core': r('src/core')
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: r('src/preload/index.ts'),
          overlay: r('src/preload/overlay.ts')
        }
      }
    },
    resolve: {
      alias: { '@shared': r('src/shared') }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: {
          index: r('src/renderer/index.html'),
          overlay: r('src/renderer/overlay.html')
        }
      }
    },
    resolve: {
      alias: {
        '@core': r('src/core'),
        '@shared': r('src/shared'),
        '@': r('src/renderer/src')
      }
    }
  }
})
