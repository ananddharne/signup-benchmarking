import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/acceptance/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 30_000,
  },
})
