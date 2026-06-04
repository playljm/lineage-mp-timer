import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const root = import.meta.dirname
const r = (p: string): string => resolve(root, p)

export default defineConfig({
  resolve: {
    alias: {
      '@core': r('src/core'),
      '@shared': r('src/shared')
    }
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 30000
  }
})
