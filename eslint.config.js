// @ts-check
import eslintConfig from '@louishaftmann/eslint-config'

export default eslintConfig({
  nuxt: false,
  tsconfigPath: './tsconfig.json',
}).append({
  ignores: ['node_modules/', 'dist/', 'pnpm-lock.yaml'],
})
