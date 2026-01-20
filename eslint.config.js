// @ts-check
import eslintConfig from '@falcondev-oss/configs/eslint'

export default eslintConfig({
  nuxt: false,
  tsconfigPath: './tsconfig.json',
}).append({
  ignores: ['node_modules/', 'dist/', 'pnpm-lock.yaml'],
})
