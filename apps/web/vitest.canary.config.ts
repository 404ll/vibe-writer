import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.canary.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})
