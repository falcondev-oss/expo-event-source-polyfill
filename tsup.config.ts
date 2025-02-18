import { defineConfig } from 'tsup'

export default defineConfig({
  outDir: 'dist/',
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
})
