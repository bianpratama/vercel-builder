import { resolve } from 'path'
import thing from './another'

module.exports = {
  env: {
    thing
  },
  rootDir: resolve(__dirname, '../..'),
  buildDir: resolve(__dirname, '.nuxt'),
  srcDir: __dirname,
  buildModules: ['@nuxt/typescript-build'],
  modules: ['~/modules/module.ts'],
  build: {
    extend (config: any) {
      config.resolve.alias.base = resolve(__dirname, '../../base')
      config.resolve.alias['@base'] = resolve(__dirname, '../../base')
    }
  },
  typescript: {
    typeCheck: {
      typescript: {
        configFile: resolve(__dirname, './tsconfig.json')
      }
    }
  }
}
