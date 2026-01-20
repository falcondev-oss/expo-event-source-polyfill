import { defineConfig } from 'tsdown'

export default defineConfig({
  outDir: 'dist/',
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  checks: {
    legacyCjs: false,
  },
})
