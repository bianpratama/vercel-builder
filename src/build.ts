import path from 'path'

import { createLambda, BuildOptions, download, File, FileBlob, FileFsRef, glob, getNodeVersion, getSpawnOptions, Lambda, runNpmInstall, runPackageJsonScript } from '@vercel/build-utils'
import type { Route } from '@vercel/routing-utils'
import consola from 'consola'
import fs from 'fs-extra'
import resolveFrom from 'resolve-from'
import { gte, gt } from 'semver'

import { copyBuildFiles, endStep, exec, getNuxtConfig, getNuxtConfigName, globAndPrefix, MutablePackageJson, prepareNodeModules, preparePkgForProd, readJSON, startStep, validateEntrypoint } from './utils'
import { prepareTypescriptEnvironment, compileTypescriptBuildFiles, JsonOptions } from './typescript'

interface BuilderOutput {
  watch?: string[];
  output: Record<string, Lambda | File | FileFsRef>;
  routes: Route[];
}

interface NuxtBuilderConfig {
  maxDuration?: number
  memory?: number
  tscOptions?: JsonOptions
  generateStaticRoutes?: boolean
  includeFiles?: string[] | string
  serverFiles?: string[]
  internalServer?: boolean
  app?: string
  buildFiles?: string[]
}

export async function build (opts: BuildOptions & { config: NuxtBuilderConfig }): Promise<BuilderOutput> {
  const { files, entrypoint, workPath, config = {}, meta = {} } = opts
  // ---------------- Debugging context --------------
  consola.log('🚀 Running with @prata.ma/vercel-builder version', require('../package.json').version)

  // ----------------- Prepare build -----------------
  startStep('Prepare build')

  // Validate entrypoint
  validateEntrypoint(entrypoint)

  // Get current app -> xxx
  const currentApp = config.app as string
  consola.log('💡 Current app:', currentApp)

  // Get Nuxt directory -> apps/xxx
  const entrypointDir = path.dirname(entrypoint)
  consola.log('📁 Entry point directory:', entrypointDir)

  // Get Nuxt path -> vercel/workpath0/apps/xxx
  const entrypointPath = path.join(workPath, entrypointDir)
  consola.log('📁 Entry point path', entrypointPath)

  // Get root path
  const rootPath = workPath
  consola.log('📁 Root path:', rootPath)

  // Get folder where we'll store node_modules
  const modulesPath = path.join(entrypointPath, 'node_modules')
  consola.log('📁 Modules path:', modulesPath)

  // Create a real filesystem
  consola.log('⏳ Downloading files...')
  await download(files, workPath, meta)

  // Change current working directory to rootPath
  process.chdir(rootPath)
  consola.log('📁 Working directory:', process.cwd())

  if (config.buildFiles) {
    await copyBuildFiles(config.buildFiles, rootPath, entrypointPath)
  }

  process.chdir(entrypointPath)
  consola.log('📁 Working directory:', process.cwd())

  // Read package.json
  let pkg: MutablePackageJson
  try {
    pkg = await readJSON('package.json')
  } catch (e) {
    throw new Error(`Can not read package.json from ${entrypointPath}`)
  }

  // Node version
  const nodeVersion = await getNodeVersion(entrypointPath, undefined, {}, meta)
  const spawnOpts = getSpawnOptions(meta, nodeVersion)

  // Prepare TypeScript environment if required.
  const usesTypescript = (pkg.devDependencies && Object.keys(pkg.devDependencies).includes('@nuxt/typescript-build')) || (pkg.dependencies && Object.keys(pkg.dependencies).includes('@nuxt/typescript'))
  const needsTypescriptBuild = getNuxtConfigName(entrypointPath) === 'nuxt.config.ts'

  if (usesTypescript) {
    consola.log('💡 Using Typescript...')
    await prepareTypescriptEnvironment({
      pkg, spawnOpts, rootDir: entrypointPath
    })
  }

  // Write .npmrc
  if (process.env.NPM_AUTH_TOKEN) {
    consola.log('Found NPM_AUTH_TOKEN in environment, creating .npmrc')
    await fs.writeFile('.npmrc', `//registry.npmjs.org/:_authToken=${process.env.NPM_AUTH_TOKEN}`)
  }

  // Write .yarnclean
  if (!fs.existsSync('../.yarnclean')) {
    await fs.copyFile(path.join(__dirname, '../.yarnclean'), '.yarnclean')
  }

  // Cache dir
  const cachePath = path.resolve(entrypointPath, '.vercel_cache')
  await fs.mkdirp(cachePath)

  const yarnCachePath = path.join(cachePath, 'yarn')
  await fs.mkdirp(yarnCachePath)

  // ----------------- Install devDependencies -----------------
  startStep('Install devDependencies')

  // Prepare node_modules
  await prepareNodeModules(entrypointPath, 'node_modules_dev')

  // Install all dependencies
  await runNpmInstall(entrypointPath, [
    '--prefer-offline',
    '--frozen-lockfile',
    '--non-interactive',
    '--production=false',
    `--modules-folder=${modulesPath}`,
    `--cache-folder=${yarnCachePath}`
  ], { ...spawnOpts, env: { ...spawnOpts.env, NODE_ENV: 'development' } }, meta)

  // ----------------- Pre build -----------------
  if (pkg.scripts && Object.keys(pkg.scripts).includes('now-build')) {
    startStep('Pre build')
    await runPackageJsonScript(entrypointPath, 'now-build', spawnOpts)
  }

  // ----------------- Nuxt build -----------------
  startStep('Nuxt build')

  let compiledTypescriptFiles: { [filePath: string]: FileFsRef } = {}
  if (needsTypescriptBuild) {
    const { tscOptions } = config
    compiledTypescriptFiles = await compileTypescriptBuildFiles({ rootPath, entrypointPath, entrypointDir, spawnOpts, tscOptions })
  }

  // Read nuxt.config.js
  const nuxtConfigName = 'nuxt.config.js'
  const nuxtConfigFile = getNuxtConfig(entrypointPath, nuxtConfigName)

  consola.log('⚙️  Nuxt configuration:')
  consola.log(nuxtConfigFile)

  // Read options from nuxt.config.js otherwise set sensible defaults
  const staticDir = (nuxtConfigFile.dir && nuxtConfigFile.dir.static) ? nuxtConfigFile.dir.static : 'static'
  consola.log('📁 Static directory:', staticDir)

  const publicPath = ((nuxtConfigFile.build && nuxtConfigFile.build.publicPath) ? nuxtConfigFile.build.publicPath : '/_nuxt/').replace(/^\//, '')
  consola.log('📁 Public directory:', publicPath)

  const buildDir = nuxtConfigFile.buildDir ? path.relative(entrypointPath, nuxtConfigFile.buildDir) : '.nuxt'
  consola.log('📁 Build directory:', buildDir)

  const srcDir = nuxtConfigFile.srcDir ? path.relative(entrypointPath, nuxtConfigFile.srcDir) : '.'
  consola.log('📁 Source directory:', srcDir)

  const lambdaName = nuxtConfigFile.lambdaName ? nuxtConfigFile.lambdaName : 'index'
  consola.log('💡 Lambda name:', lambdaName)

  const usesServerMiddleware = config.internalServer !== undefined ? config.internalServer : !!nuxtConfigFile.serverMiddleware

  // const nuxtConfigFilePath = path.join(entrypointPath, 'nuxt.config.js')
  const nuxtConfigFilePath = path.join(entrypointDir, 'nuxt.config.js')
  consola.log('💡 Nuxt configuration path:', nuxtConfigFilePath)

  // if (!fs.existsSync(nuxtConfigFilePath)) {
  //   consola.error('Nuxt configuration file not exists!')
  // } else {
  //   consola.success('Nuxt configuration file exists!')
  // }

  // process.chdir(entrypointPath)

  await exec('nuxt', [
    'build',
    '--standalone',
    '--no-lock', // #19
    `--config-file "${nuxtConfigName}"`
  ], spawnOpts)

  if (config.generateStaticRoutes) {
    await exec('nuxt', [
      'generate',
      '--no-build',
      '--no-lock', // #19
      `--config-file "${nuxtConfigName}"`
    ], spawnOpts)
  }

  // ----------------- Install dependencies -----------------
  startStep('Install dependencies')

  // process.chdir(rootPath)

  // Use node_modules_prod
  await prepareNodeModules(entrypointPath, 'node_modules_prod')

  // Only keep core dependency
  const nuxtDep = preparePkgForProd(pkg)
  await fs.writeJSON('package.json', pkg)

  await runNpmInstall(entrypointPath, [
    '--prefer-offline',
    '--pure-lockfile',
    '--non-interactive',
    '--production=true',
    `--modules-folder=${modulesPath}`,
    `--cache-folder=${yarnCachePath}`
  ], {
    ...spawnOpts,
    env: {
      ...spawnOpts.env,
      NPM_ONLY_PRODUCTION: 'true'
    }
  }, meta)

  // Validate nuxt version
  const nuxtPkg = require(resolveFrom(entrypointPath, `@nuxt/core${nuxtDep.suffix}/package.json`))
  if (!gte(nuxtPkg.version, '2.4.0')) {
    throw new Error(`nuxt >= 2.4.0 is required, detected version ${nuxtPkg.version}`)
  }
  if (gt(nuxtPkg.version, '3.0.0')) {
    consola.warn('WARNING: nuxt >= 3.0.0 is not tested against this builder!')
  }

  // Cleanup .npmrc
  if (process.env.NPM_AUTH_TOKEN) {
    await fs.unlink('.npmrc')
  }

  // ----------------- Collect artifacts -----------------
  startStep('Collect artifacts')

  // Static files
  const staticFiles = await glob('**', path.join(entrypointPath, srcDir, staticDir))
  consola.log('🗂  staticFiles', staticFiles)

  // process.chdir(entrypointPath)

  // const buildPath = path.join(rootPath, '.nuxt', currentApp)
  // const buildDir2 = path.join('.nuxt', currentApp)

  // Client dist files
  const clientDistDir = path.join(entrypointPath, buildDir, 'dist/client')
  consola.log('📁 Client dist path:', clientDistDir)
  const clientDistFiles = await globAndPrefix('**', clientDistDir, publicPath)
  consola.log('🗂  clientDistFiles', clientDistFiles)

  // Server dist files
  const serverDistDir = path.join(entrypointPath, buildDir, 'dist/server')
  consola.log('📁 Server dist path:', serverDistDir)
  const serverDistFiles = await globAndPrefix('**', serverDistDir, path.join('.nuxt', 'dist/server'))
  consola.log('🗂  serverDistFiles', serverDistFiles)

  // Generated static files
  const generatedDir = path.join(entrypointPath, 'dist')
  const generatedPagesFiles = config.generateStaticRoutes ? await globAndPrefix('**/*.*', generatedDir, './') : {}

  // node_modules_prod
  const nodeModulesDir = path.join(entrypointPath, 'node_modules_prod')
  const nodeModules = await globAndPrefix('**', nodeModulesDir, 'node_modules')

  // Lambdas
  const lambdas: Record<string, Lambda> = {}

  const launcherPath = path.join(__dirname, 'launcher.js')
  const launcherSrc = (await fs.readFile(launcherPath, 'utf8'))
    .replace(/__NUXT_SUFFIX__/g, nuxtDep.suffix)
    .replace(/__NUXT_CONFIG__/g, './' + nuxtConfigName)
    .replace(/\/\* __ENABLE_INTERNAL_SERVER__ \*\/ *true/g, String(usesServerMiddleware))

  const launcherFiles = {
    'vercel__launcher.js': new FileBlob({ data: launcherSrc }),
    'vercel__bridge.js': new FileFsRef({ fsPath: require('@vercel/node-bridge') }),
    [nuxtConfigName]: new FileFsRef({ fsPath: path.resolve(entrypointPath, nuxtConfigName) }),
    ...serverDistFiles,
    ...compiledTypescriptFiles,
    ...nodeModules
  }
  // consola.log('Launcher files:')
  // consola.log(launcherFiles)

  // Extra files to be included in lambda
  const serverFiles = [
    ...(Array.isArray(config.includeFiles) ? config.includeFiles : config.includeFiles ? [config.includeFiles] : []),
    ...(Array.isArray(config.serverFiles) ? config.serverFiles : []),
    'package.json'
  ]

  for (const pattern of serverFiles) {
    const files = await glob(pattern, entrypointPath)
    Object.assign(launcherFiles, files)
  }

  // lambdaName will be titled index, unless specified in nuxt.config.js
  lambdas[lambdaName] = await createLambda({
    handler: 'vercel__launcher.launcher',
    runtime: nodeVersion.runtime,
    files: launcherFiles,
    environment: {
      NODE_ENV: 'production'
    },
    //
    maxDuration: config.maxDuration,
    memory: config.memory
  })

  // await download(launcherFiles, rootPath)

  endStep()

  return {
    output: {
      ...lambdas,
      ...clientDistFiles,
      ...staticFiles,
      ...generatedPagesFiles
    },
    routes: [
      { src: `/${publicPath}.+`, headers: { 'Cache-Control': 'max-age=31557600' } },
      ...Object.keys(staticFiles).map(file => ({ src: `/${file}`, headers: { 'Cache-Control': 'max-age=31557600' } })),
      { handle: 'filesystem' },
      { src: '/(.*)', dest: '/index' }
    ]
  }
}
