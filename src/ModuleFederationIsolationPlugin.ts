import path from 'path'
import fs from 'fs'
import {
  Compiler,
  RuntimeGlobals,
  RuntimeModule,
  Template,
  Module,
  NormalModule,
  ModuleGraph,
} from 'webpack'
import { validate } from 'schema-utils'
import semverSatisfies from 'semver/functions/satisfies'

const PLUGIN_NAME = 'ModuleFederationIsolationPlugin'

enum StateStrategy {
  UseOrigin = 'use-origin',
  UseIsolated = 'use-isolated',
  UseOwn = 'use-own',
}

type PluginOptions = {
  entry: string | string[]
  stateStrategy: StateStrategy
  sharedDependencies: Record<
    string,
    {
      instanceStateStrategy: StateStrategy
    }
  >
}

type PackageInfo = {
  name: string
  version: string
  rangesIn: string[]
  notInsightedDependencies: Record<string, string>
}

interface ConcatenatedModule extends Module {
  rootModule: Module
}

type Manifest = {
  packages: Record<
    string,
    Record<
      string,
      {
        semverRangesIn: string[]
        modulePathToModuleId: Record<string, WebpackModuleId>
      }
    >
  >
  sharedModuleRedirections: Record<WebpackModuleId, ManifestSharedModuleRedirection>
}

type ManifestSharedModuleRedirection = {
  moduleIdToRedirectTo: WebpackModuleId
}

export type WebpackModuleId = string | number

export type SizeOptimizedManifest = {
  pre: string[]
  pkg: Record<string, Record<string, [string[], Record<string, WebpackModuleId>]>>
  red: Record<WebpackModuleId, SizeOptimizedSharedModuleRedirection>
}

export type SizeOptimizedSharedModuleRedirection = {
  mid: WebpackModuleId
}

const PLUGIN_OPTIONS_SCHEMA = {
  type: 'object',
  properties: {
    entry: {
      anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    },
    stateStrategy: {
      type: 'string',
      enum: Object.values(StateStrategy),
    },
    sharedDependencies: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          stateStrategy: {
            type: 'string',
            enum: Object.values(StateStrategy),
          },
        },
      },
    },
  },
  additionalProperties: false,
}

const instanceStateStrategyPriority: Record<StateStrategy, number> = {
  [StateStrategy.UseOrigin]: 0,
  [StateStrategy.UseIsolated]: 10,
  [StateStrategy.UseOwn]: 20,
}

class ModuleFederationIsolationInfoModule extends RuntimeModule {
  constructor(private manifest: Manifest) {
    super('mf isolation runtime', RuntimeModule.STAGE_ATTACH)
  }

  getSizeOptimizedManifest(manifest: Manifest): SizeOptimizedManifest {
    const prefixToIndex: Record<string, number> = {}
    const sizeOptimizedManifest: SizeOptimizedManifest = {
      pre: [],
      pkg: {},
      red: Object.entries(manifest.sharedModuleRedirections).reduce(
        (acc, [moduleId, redirection]) => {
          acc[moduleId] = {
            mid: redirection.moduleIdToRedirectTo,
          }
          return acc
        },
        {} as Record<WebpackModuleId, SizeOptimizedSharedModuleRedirection>,
      ),
    }

    const rawManifestPrefixes = sizeOptimizedManifest.pre
    const rawManifestPackages = sizeOptimizedManifest.pkg

    for (const packageName of Object.keys(manifest.packages)) {
      if (!rawManifestPackages[packageName]) {
        rawManifestPackages[packageName] = {}
      }

      const packageVersions = manifest.packages[packageName]
      for (const version of Object.keys(packageVersions)) {
        const minifiedModulePathToModuleId: Record<string, WebpackModuleId> = {}

        Object.entries(packageVersions[version].modulePathToModuleId).forEach(
          ([modulePath, moduleId]) => {
            const modulePathNoLoaderNoQuery = modulePath.split(/[!?]/)[0]
            const lastSlashIndex = modulePathNoLoaderNoQuery.lastIndexOf('/')
            if (lastSlashIndex === -1) {
              minifiedModulePathToModuleId[modulePath] = moduleId
              return
            }

            const prefix = modulePath.slice(0, lastSlashIndex)
            const suffix = modulePath.slice(lastSlashIndex + 1)
            if (!prefixToIndex[prefix]) {
              prefixToIndex[prefix] = rawManifestPrefixes.length
              rawManifestPrefixes.push(prefix)
            }

            minifiedModulePathToModuleId[`${prefixToIndex[prefix]}/${suffix}`] = moduleId
          },
        )

        rawManifestPackages[packageName][version] = [
          packageVersions[version].semverRangesIn,
          minifiedModulePathToModuleId,
        ]
      }
    }

    return sizeOptimizedManifest
  }

  generate(): string {
    const sizeOptimizedManifest = this.getSizeOptimizedManifest(this.manifest)

    return Template.asString([
      `${RuntimeGlobals.require}.federation = ${RuntimeGlobals.require}.federation || {};`,
      `${RuntimeGlobals.require}.federation.isolation = ${JSON.stringify(sizeOptimizedManifest)};`,
    ])
  }
}

export class ModuleFederationIsolationPlugin {
  private options: PluginOptions
  private remoteEntriesToApply: Set<string> = new Set()
  private remoteEntryIndex = 0

  constructor(userOptions: Partial<PluginOptions> = {}) {
    validate(PLUGIN_OPTIONS_SCHEMA as any, userOptions, {
      name: PLUGIN_NAME,
    })

    this.options = {
      // Empty means we apply the plugin to all remote entries
      entry: '',
      stateStrategy: StateStrategy.UseIsolated,
      sharedDependencies: {},
      ...userOptions,
    }

    let maximumInstanceStateStrategyRequired = this.options.stateStrategy
    for (const sharedDependency of Object.values(this.options.sharedDependencies)) {
      if (
        instanceStateStrategyPriority[sharedDependency.instanceStateStrategy] >
        instanceStateStrategyPriority[maximumInstanceStateStrategyRequired]
      ) {
        maximumInstanceStateStrategyRequired = sharedDependency.instanceStateStrategy
      }
    }

    const remoteEntriesToApply = new Set<string>()
    if (this.options.entry) {
      if (typeof this.options.entry === 'string') {
        remoteEntriesToApply.add(this.options.entry)
      } else {
        this.options.entry.forEach((entry) => remoteEntriesToApply.add(entry))
      }
    }
  }

  createRuntimePlugin(compiler: Compiler): string {
    const isolationFolderPath = path.resolve(
      compiler.context,
      'node_modules',
      '.federation',
      'isolation',
    )
    fs.mkdirSync(isolationFolderPath, { recursive: true })

    const runtimePluginPath = path.resolve(
      isolationFolderPath,
      `mfiruntime${this.remoteEntryIndex}.js`,
    )
    fs.writeFileSync(
      runtimePluginPath,
      Template.asString([
        `const { createMfiRuntimePlugin } = require('${path.resolve(
          __dirname,
          'ModuleFederationIsolationRuntimePlugin',
        )}');`,
        `module.exports = createMfiRuntimePlugin(${JSON.stringify({
          stateStrategy: this.options.stateStrategy,
          sharedDependencies: this.options.sharedDependencies,
        })});`,
      ]),
    )

    this.remoteEntryIndex++
    return runtimePluginPath
  }

  injectRuntimePlugins(compiler: Compiler): void {
    compiler.options.plugins?.forEach((plugin) => {
      if (!plugin) {
        return
      }

      if (plugin.constructor.name === 'ModuleFederationPlugin') {
        const moduleFederationPlugin = plugin as any
        if (!moduleFederationPlugin._options) {
          return
        }

        const moduleFederationPluginOptions = moduleFederationPlugin._options
        const remoteEntryName = moduleFederationPluginOptions.name ?? 'remoteEntry'

        if (!this.remoteEntriesToApply.size || this.remoteEntriesToApply.has(remoteEntryName)) {
          const runtimePluginPath = this.createRuntimePlugin(compiler)
          moduleFederationPluginOptions.runtimePlugins =
            moduleFederationPluginOptions.runtimePlugins || []
          moduleFederationPluginOptions.runtimePlugins.push(runtimePluginPath)
        }
      }
    })
  }

  disableConflictingConfiguration(compiler: Compiler): void {
    const originalMangleExports = compiler.options?.optimization?.mangleExports

    compiler.hooks.afterEnvironment.tap(PLUGIN_NAME, () => {
      // Disable export mangling
      if (compiler.options.optimization.mangleExports !== false) {
        if (originalMangleExports !== undefined) {
          compiler
            .getInfrastructureLogger(PLUGIN_NAME)
            .warn('Export mangling has been disabled to ensure stable export naming')
        }

        compiler.options.optimization.mangleExports = false
      }
    })
  }

  getPackageJsonPathForModulePath(modulePath: string): string | null {
    if (!modulePath) {
      return null
    }

    let currentRelativeDir = path.dirname(modulePath)
    let packageJsonPath = null
    while (currentRelativeDir !== '.') {
      const possiblePackageJsonPath = path.join(currentRelativeDir, 'package.json')
      if (fs.existsSync(possiblePackageJsonPath)) {
        packageJsonPath = possiblePackageJsonPath
        break
      } else {
        const nextRelativeDir = path.dirname(currentRelativeDir)
        if (nextRelativeDir === currentRelativeDir) {
          break
        }
        currentRelativeDir = nextRelativeDir
      }
    }

    return packageJsonPath
  }

  getPackageInfo(
    packageJsonPath: string,
    packageInfoMap: Record<string, PackageInfo>,
  ): PackageInfo | undefined {
    if (packageInfoMap[packageJsonPath]) {
      return packageInfoMap[packageJsonPath]
    }

    const descriptionFileContent = require(packageJsonPath)
    if (!descriptionFileContent?.name || !descriptionFileContent?.version) {
      return
    }

    const packageName = descriptionFileContent.name
    const packageVersion = descriptionFileContent.version
    const packageDependencies = descriptionFileContent.dependencies || {}
    const packageDevDependencies = descriptionFileContent.devDependencies || {}
    const packagePeerDependencies = descriptionFileContent.peerDependencies || {}

    const notInsightedDependencies: Record<string, string> = {
      ...packageDependencies,
      ...packageDevDependencies,
      ...packagePeerDependencies,
    }

    packageInfoMap[packageJsonPath] = {
      name: packageName,
      version: packageVersion,
      rangesIn: [],
      notInsightedDependencies,
    }

    return packageInfoMap[packageJsonPath]
  }

  getNormalizedDependencyRange(dependencyRange: string, packageInfo: PackageInfo): string {
    if (dependencyRange.startsWith('file:') || dependencyRange.startsWith('link:')) {
      return packageInfo.version
    }

    if (dependencyRange.startsWith('workspace:')) {
      return dependencyRange.slice('workspace:'.length)
    }

    return dependencyRange
  }

  tryToInsightDependencies(
    moduleGraph: ModuleGraph,
    module: Module,
    modulePackageInfo: PackageInfo,
    packageInfoMap: Record<string, PackageInfo>,
  ): void {
    const dependencies = moduleGraph.getOutgoingConnections(module)
    for (const dependency of dependencies) {
      const dependencyModule = dependency.module
      if (!dependencyModule || dependencyModule.constructor.name !== 'NormalModule') {
        continue
      }

      const normalModule = dependencyModule as NormalModule
      const dependencyPackageJsonPath = normalModule.resourceResolveData?.descriptionFilePath
      if (!dependencyPackageJsonPath) {
        continue
      }

      const dependencyPackageInfo = this.getPackageInfo(dependencyPackageJsonPath, packageInfoMap)
      if (!dependencyPackageInfo) {
        continue
      }

      const dependencyRangeSpecifiedInParentModule =
        modulePackageInfo.notInsightedDependencies[dependencyPackageInfo.name]
      if (dependencyRangeSpecifiedInParentModule) {
        const normalizedDependencyRange = this.getNormalizedDependencyRange(
          dependencyRangeSpecifiedInParentModule,
          dependencyPackageInfo,
        )

        if (semverSatisfies(dependencyPackageInfo.version, normalizedDependencyRange)) {
          // If dependency version does not satisfy the range, chances are it's a linked dependency
          // or the resolution was forced by the user, so we don't want to include a "non used" range
          dependencyPackageInfo.rangesIn.push(normalizedDependencyRange)
        }
        delete modulePackageInfo.notInsightedDependencies[dependencyPackageInfo.name]
      }
    }
  }

  gatherModuleInfoAndAttachToRuntime(compiler: Compiler): void {
    compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
      const manifest: Manifest = {
        packages: {},
        sharedModuleRedirections: {},
      }
      const packageInfoByPackageJsonPath: Record<string, PackageInfo> = {}

      compilation.hooks.afterOptimizeModuleIds.tap(PLUGIN_NAME, () => {
        compilation.modules.forEach((module) => {
          const moduleId = compilation.chunkGraph.getModuleId(module)
          if (moduleId === null) {
            return
          }

          if (module.constructor.name === 'ConsumeSharedModule') {
            const referencedModule = compilation.moduleGraph.getModule(
              module.blocks?.[0]?.dependencies?.[0] || module.dependencies?.[0],
            )
            if (!referencedModule || referencedModule.constructor.name !== 'NormalModule') {
              return
            }

            const referencedModuleId = compilation.chunkGraph.getModuleId(referencedModule)
            if (referencedModuleId === null) {
              return
            }

            manifest.sharedModuleRedirections[moduleId] = {
              moduleIdToRedirectTo: referencedModuleId,
            }
            return
          }

          while (module.constructor.name === 'ConcatenatedModule') {
            module = (module as ConcatenatedModule).rootModule
          }

          if (module.constructor.name !== 'NormalModule') {
            return
          }

          const normalModule = module as NormalModule
          const moduleFullPath = normalModule.resourceResolveData?.path
          if (!moduleFullPath) {
            return
          }

          const associatedPackageJsonPath = this.getPackageJsonPathForModulePath(moduleFullPath)
          if (!associatedPackageJsonPath) {
            return
          }

          const packageInfo = this.getPackageInfo(
            associatedPackageJsonPath,
            packageInfoByPackageJsonPath,
          )
          if (!packageInfo) {
            return
          }

          this.tryToInsightDependencies(
            compilation.moduleGraph,
            normalModule,
            packageInfo,
            packageInfoByPackageJsonPath,
          )

          // We don't want to include modules from the project's package.json
          if (associatedPackageJsonPath === path.join(compiler.context, 'package.json')) {
            return
          }

          let moduleRelativePath = path.relative(
            path.dirname(associatedPackageJsonPath),
            moduleFullPath,
          )

          const moduleFullId = normalModule.identifier()
          if (moduleFullId.includes('!')) {
            const loaderQuery = normalModule.loaders
              .map((loader) => {
                const loaderPackageJsonPath = this.getPackageJsonPathForModulePath(loader.loader)
                if (!loaderPackageJsonPath) {
                  return null
                }

                const loaderPackageInfo = this.getPackageInfo(
                  loaderPackageJsonPath,
                  packageInfoByPackageJsonPath,
                )
                if (!loaderPackageInfo) {
                  return null
                }

                const loaderModuleRelativePath = path.relative(
                  path.dirname(loaderPackageJsonPath),
                  loader.loader,
                )
                const loaderOptions = loader.options ? `?${JSON.stringify(loader.options)}` : '!'
                return `${loaderPackageInfo.name}@${loaderModuleRelativePath}${loaderOptions}`
              })
              .filter(Boolean)

            // Hint: using question mark instead of exclamation unifies the query string
            // and allows easier splitting
            moduleRelativePath = `${moduleRelativePath}?${loaderQuery.join('?')}`
          }

          if (normalModule.resourceResolveData?.query) {
            // Hint: resourceResolveData.query already begins with a question mark
            moduleRelativePath += normalModule.resourceResolveData.query
          }

          if (!manifest.packages[packageInfo.name]) {
            manifest.packages[packageInfo.name] = {}
          }
          if (!manifest.packages[packageInfo.name][packageInfo.version]) {
            manifest.packages[packageInfo.name][packageInfo.version] = {
              modulePathToModuleId: {},
              semverRangesIn: [],
            }
          }
          if (
            manifest.packages[packageInfo.name][packageInfo.version].modulePathToModuleId[
              moduleRelativePath
            ]
          ) {
            compiler
              .getInfrastructureLogger(PLUGIN_NAME)
              .warn(
                `Module ${moduleRelativePath} from package ${packageInfo.name}@${packageInfo.version} was found duplicated and will be ignored`,
              )
            return
          }

          manifest.packages[packageInfo.name][packageInfo.version].modulePathToModuleId[
            moduleRelativePath
          ] = moduleId
        })

        Object.values(packageInfoByPackageJsonPath).forEach(({ name, version, rangesIn }) => {
          const existingEntry = manifest.packages?.[name]?.[version]
          if (!existingEntry) {
            return
          }

          existingEntry.semverRangesIn = [
            ...new Set([...existingEntry.semverRangesIn, ...rangesIn]),
          ]
        })
      })

      compilation.hooks.afterOptimizeChunkIds.tap(PLUGIN_NAME, (chunks) => {
        for (const chunk of chunks) {
          if (
            chunk.hasRuntime() &&
            (!this.remoteEntriesToApply.size ||
              (chunk.name && this.remoteEntriesToApply.has(chunk.name)))
          ) {
            compilation.addRuntimeModule(chunk, new ModuleFederationIsolationInfoModule(manifest))
          }
        }
      })
    })
  }

  apply(compiler: Compiler): void {
    this.disableConflictingConfiguration(compiler)
    this.injectRuntimePlugins(compiler)
    this.gatherModuleInfoAndAttachToRuntime(compiler)
  }
}
