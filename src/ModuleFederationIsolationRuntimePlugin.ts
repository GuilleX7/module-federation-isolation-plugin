import semverSatisfies from 'semver/functions/satisfies'
import type {
  SizeOptimizedManifest,
  SizeOptimizedSharedModuleRedirection,
  WebpackModuleId,
} from './ModuleFederationIsolationPlugin'

const PLUGIN_NAME = 'ModuleFederationIsolationPlugin'

export const enum RuntimeStateStrategy {
  UseOrigin = 0,
  Isolate = 10,
  ReuseOwn = 20,
}

export const enum RuntimeVerbosity {
  Unset = -1,
  None = 0,
  Warnings = 5,
  Debug = 10,
}

export type RuntimePluginOptions = {
  stateStrategy: RuntimeStateStrategy
  sharedDependencies: Record<
    string,
    {
      stateStrategy: RuntimeStateStrategy
    }
  >
  runtimeVerbosity: RuntimeVerbosity
}

declare global {
  let __webpack_require__: WebpackRequire
  let __webpack_modules__: Record<WebpackModuleId, WebpackModuleFactory>
}

type WebpackModuleFactory<T = unknown> = (this: T, module: WebpackModule, exports: T, require: WebpackRequire) => T

type WebpackModule<T = unknown> = {
  id: WebpackModuleId
  loaded: boolean
  exports: T
}

type RuntimeManifest = Omit<SizeOptimizedManifest, 'red'> & {
  red: Record<
    WebpackModuleId,
    {
      mid: SizeOptimizedSharedModuleRedirection['mid']
      webpackRequire: WebpackRequire | undefined
    }
  >
  midToUid: Record<WebpackModuleId, { pkgName: string; pkgVersion: string; modulePath: string }>
  pkgVersions: Record<string, [string, string[]][]>
  pkgMatch: Record<string, Record<string, string | null>>
  hostName: string
  initiated?: boolean
}

type WebpackRequire = {
  (moduleId: WebpackModuleId): WebpackModule['exports']
  c: Record<WebpackModuleId, WebpackModule>
  m: Record<WebpackModuleId, WebpackModuleFactory>
  federation: FederationRuntime
}

type FederationRuntime = {
  bundlerRuntime: FederationRuntimeBundlerRuntime
  isolation: RuntimeManifest
}

type FederationRuntimeBundlerRuntime = {
  consumes: (options: FederationRuntimeConsumesOptions) => void
}

type FederationRuntimeConsumesOptions = {
  moduleToHandlerMapping: Record<string, FederationRuntimeModuleToHandlerMapping>
}

interface FederationRuntimeModuleToHandlerMapping {
  shareInfo: FederationRuntimeShareInfo
  shareKey: string
  getter: FederationRuntimeDependencyGetter
}

interface FederationRuntimeShareInfo {
  shareConfig: FederationRuntimeSharedConfig
  scope: string[]
}

interface FederationRuntimeSharedConfig {
  singleton?: boolean
  requiredVersion: false | string
  eager?: boolean
  strictVersion?: boolean
}

interface FederationRuntimeDependencyLib {
  (): WebpackModule['exports']
}

interface FederationRuntimeDependencyGetter {
  (): Promise<FederationRuntimeDependencyLib>
  providedModuleId?: WebpackModuleId
}

interface FederationRuntimeDependency {
  from: string
  scope: string[]
  lib: FederationRuntimeDependencyLib | undefined
  loaded: boolean
  loading: Promise<() => WebpackModule['exports']>
  get: FederationRuntimeDependencyGetter
}

type FederationRuntimeHost = {
  name: string
  shareScopeMap: FederationRuntimeHostShareScopeMap
  __webpack_require__: WebpackRequire
}

type FederationRuntimeHostShareScopeMap = {
  [scope: string]: {
    [pkgName: string]: {
      [sharedVersion: string]: unknown
    }
  }
}

interface FederationRuntimeBeforeInitArgs {
  origin: FederationRuntimeHost
}

interface FederationRuntimeBeforeLoadShareArgs {
  origin: FederationRuntimeHost
  shareInfo: FederationRuntimeShareInfo
}

interface FederationRuntimeResolveShareArgs {
  pkgName: string
  version: string
  resolver: () => FederationRuntimeDependency
  scope: string
  GlobalFederation: {
    __INSTANCES__: ExtendedFederationHost[]
  }
}

interface FederationRuntimePlugin {
  name: string
  version: string
  beforeInit: (args: FederationRuntimeBeforeInitArgs) => FederationRuntimeBeforeInitArgs
  beforeLoadShare: (args: FederationRuntimeBeforeLoadShareArgs) => FederationRuntimeBeforeLoadShareArgs
  resolveShare: (args: FederationRuntimeResolveShareArgs) => FederationRuntimeResolveShareArgs
}

type ExtendedFederationHost = {
  name: string
  __webpack_require__: WebpackRequire
}

function initiateRuntimeManifestIfPresent(ownRequire: WebpackRequire): void {
  if (!ownRequire.federation.isolation || ownRequire.federation.isolation.initiated) {
    return
  }

  const manifest = ownRequire.federation.isolation
  manifest.initiated = true
  manifest.midToUid = {}
  manifest.pkgVersions = {}
  manifest.pkgMatch = {}

  const { pre, pkg, midToUid, pkgVersions } = manifest

  Object.entries(pkg).forEach(([packageName, packageVersions]) => {
    Object.entries(packageVersions).forEach(([packageVersion, packageData]) => {
      if (!pkgVersions[packageName]) {
        pkgVersions[packageName] = []
      }
      pkgVersions[packageName].push([packageVersion, packageData[0]])

      Object.entries(packageData[1]).forEach(([modulePath, moduleId]) => {
        let modulePathNoLoaderNoQuery = modulePath
        const firstQuestionMarkIndex = modulePath.indexOf('?')
        if (firstQuestionMarkIndex !== -1) {
          modulePathNoLoaderNoQuery = modulePath.slice(0, firstQuestionMarkIndex)
        }
        const firstSlashIndex = modulePathNoLoaderNoQuery.indexOf('/')
        if (firstSlashIndex !== -1) {
          delete packageData[1][modulePath]
          const preffix = modulePath.slice(0, firstSlashIndex)
          const suffix = modulePath.slice(firstSlashIndex + 1)
          modulePath = `${pre[parseInt(preffix)]}/${suffix}`
          packageData[1][modulePath] = moduleId
        }

        midToUid[moduleId] = {
          pkgName: packageName,
          pkgVersion: packageVersion,
          modulePath,
        }
      })
    })
  })
}

function patchModuleFactory(moduleFactory: WebpackModuleFactory, patchedRequire: WebpackRequire): WebpackModuleFactory {
  return (module: WebpackModule, exports: WebpackModule['exports']) => moduleFactory(module, exports, patchedRequire)
}

function createTranslationRequire(
  ownRequire: WebpackRequire,
  originalOriginRequire: WebpackRequire,
  isolationNamespace: string,
  strategy: RuntimeStateStrategy,
  log: (verbosity: RuntimeVerbosity, message: string) => void
): WebpackRequire {
  return new Proxy(originalOriginRequire, {
    apply(_, __, args: [WebpackModuleId]) {
      let [originModuleId] = args
      let originRequire = originalOriginRequire

      // If module is a consume shared module, redirect to the real module and host
      const possibleRedirection = originRequire.federation.isolation.red[originModuleId]
      if (possibleRedirection?.mid && possibleRedirection?.webpackRequire) {
        originModuleId = possibleRedirection.mid
        originRequire = possibleRedirection.webpackRequire
      }

      let ownModuleId: WebpackModuleId | null = null

      if (strategy === RuntimeStateStrategy.ReuseOwn) {
        const originUniversalModule = originRequire.federation.isolation.midToUid[originModuleId]
        if (originUniversalModule) {
          const originPackageUniversalId = `${originUniversalModule.pkgName}~${originUniversalModule.pkgVersion}`
          const originHostName = originRequire.federation.isolation.hostName

          let ownPackageVersion = ownRequire.federation.isolation.pkgMatch[originHostName]?.[originPackageUniversalId]
          if (ownPackageVersion === undefined) {
            ownPackageVersion = null
            const ownPackageVersions = ownRequire.federation.isolation.pkgVersions[originUniversalModule.pkgName]
            const originPackageVersions = originRequire.federation.isolation.pkgVersions[originUniversalModule.pkgName]
            const originPackageVersion = originPackageVersions.find(
              ([version]) => version === originUniversalModule.pkgVersion
            )

            // If a compatible module is already loaded, use it
            const ownPackageVersionCompatibleWithOriginPackage = ownPackageVersions?.find(([version]) => {
              return originPackageVersion?.[1].every((range) => semverSatisfies(version, range))
            })
            if (ownPackageVersionCompatibleWithOriginPackage) {
              const possibleOwnPackageVersion = ownPackageVersionCompatibleWithOriginPackage[0]
              const possibleOwnModuleId =
                ownRequire.federation.isolation.pkg[originUniversalModule.pkgName][possibleOwnPackageVersion][1][
                  originUniversalModule.modulePath
                ]
              if (ownRequire.c[possibleOwnModuleId]) {
                ownPackageVersion = possibleOwnPackageVersion
                log(
                  RuntimeVerbosity.Debug,
                  `[${isolationNamespace}] Using ${ownRequire.federation.isolation.hostName}'s ${originUniversalModule.pkgName}~${ownPackageVersion} as ${originHostName}'s ${originPackageUniversalId}`
                )
              }
            }

            if (ownPackageVersion === null) {
              // Try to check if origin module could be loaded in place of any own module that is not loaded
              const compatibleOwnPackageVersion = ownPackageVersions?.find(([_, rangesIn]) => {
                return rangesIn.every((range) => semverSatisfies(originUniversalModule.pkgVersion, range))
              })
              if (compatibleOwnPackageVersion) {
                const possibleOwnPackageVersion = compatibleOwnPackageVersion[0]
                const possibleOwnModuleId =
                  ownRequire.federation.isolation.pkg[originUniversalModule.pkgName][possibleOwnPackageVersion][1][
                    originUniversalModule.modulePath
                  ]
                if (!ownRequire.c[possibleOwnModuleId]) {
                  ownPackageVersion = possibleOwnPackageVersion
                  log(
                    RuntimeVerbosity.Debug,
                    `[${isolationNamespace}] Storing ${originHostName}'s ${originPackageUniversalId} as ${ownRequire.federation.isolation.hostName}'s ${originUniversalModule.pkgName}~${ownPackageVersion}`
                  )
                }
              }
            }

            ownRequire.federation.isolation.pkgMatch[originHostName] = {
              ...(ownRequire.federation.isolation.pkgMatch[originHostName] || {}),
              [originPackageUniversalId]: ownPackageVersion,
            }
          }

          if (ownPackageVersion !== null) {
            ownModuleId =
              ownRequire.federation.isolation.pkg[originUniversalModule.pkgName][ownPackageVersion][1][
                originUniversalModule.modulePath
              ] ?? null
          }
        }
      }

      const isolatedModuleId: WebpackModuleId = `${isolationNamespace}/${originModuleId}`
      ownModuleId = ownModuleId ?? isolatedModuleId
      log(RuntimeVerbosity.Debug, `[${isolationNamespace}] Translating ${originModuleId} -> ${ownModuleId}`)

      if (ownRequire.c[ownModuleId]) {
        // Module is already instantiated and copied to the own cache
        return ownRequire.c[ownModuleId].exports
      }

      if (originRequire.c[isolatedModuleId]) {
        // Module is still instantiating in the originRequire cache
        return originRequire.c[isolatedModuleId].exports
      }

      // Module is not in cache, create a new module instance
      originRequire.m[isolatedModuleId] = patchModuleFactory(
        originRequire.m[originModuleId],
        createTranslationRequire(ownRequire, originRequire, isolationNamespace, strategy, log)
      )
      originRequire(isolatedModuleId)

      // Move instantiated module and clean up the origin cache
      ownRequire.c[ownModuleId] = originRequire.c[isolatedModuleId]
      if (ownRequire !== originRequire || ownModuleId !== isolatedModuleId) {
        delete originRequire.c[isolatedModuleId]
        delete originRequire.m[isolatedModuleId]
      }
      return ownRequire.c[ownModuleId].exports
    },
  })
}

export function createMfiRuntimePlugin(options: RuntimePluginOptions): () => FederationRuntimePlugin {
  const log: (verbosity: RuntimeVerbosity, ...data: unknown[]) => void = (
    verbosity: RuntimeVerbosity,
    ...data: unknown[]
  ) => {
    if (options.runtimeVerbosity >= verbosity) {
      const logFunction = verbosity === RuntimeVerbosity.Debug ? console.debug : console.warn
      logFunction(...data)
    }
  }

  return function plugin(): FederationRuntimePlugin {
    const ownRequire = __webpack_require__
    let moduleToHandlerMapping: Record<WebpackModuleId, FederationRuntimeModuleToHandlerMapping> = {}

    initiateRuntimeManifestIfPresent(ownRequire)

    ownRequire.federation.bundlerRuntime.consumes = new Proxy(ownRequire.federation.bundlerRuntime.consumes, {
      apply: (target, thisArg, args) => {
        // Hack: intercept information about module to handler mapping
        // Discuss a way to provide the consumed module ID in resolveShare
        moduleToHandlerMapping = args[0].moduleToHandlerMapping
        Reflect.apply(target, thisArg, args)
      },
    })

    return {
      name: 'ModuleFederationIsolationRuntimePlugin',
      version: '0.0.1',
      beforeInit: (args) => {
        const ownHost = args.origin
        // Expose the __webpack_require__ function in the federation host
        if (!ownHost.__webpack_require__) {
          ownHost.__webpack_require__ = ownRequire
        } else if (ownHost.__webpack_require__ !== ownRequire) {
          log(
            RuntimeVerbosity.Warnings,
            `[mfi/${ownHost.name}] The __webpack_require__ function of the host ${ownHost.name} is already set. This may lead to unexpected behavior.`
          )
        }
        // Save the host name in the manifest
        ownRequire.federation.isolation.hostName = ownHost.name
        return args
      },
      beforeLoadShare: (args) => {
        // Identify the own consume shared module ID
        const ownConsumeSharedModuleEntry = Object.entries(moduleToHandlerMapping).find(
          ([_, consumeSharedModuleMapping]) =>
            args.shareInfo.shareConfig === consumeSharedModuleMapping.shareInfo.shareConfig
        )
        const ownConsumeSharedModuleId = ownConsumeSharedModuleEntry ? ownConsumeSharedModuleEntry[0] : null

        if (ownConsumeSharedModuleId !== null) {
          const patchedScopes: string[] = []

          // Create new scopes to identify the shared module later on in loadShare
          args.shareInfo.scope.forEach((scope) => {
            const patchedScope = `${ownConsumeSharedModuleId}/mfi/scope/${args.origin.name}/${scope}`
            patchedScopes.push(patchedScope)
            args.origin.shareScopeMap[patchedScope] = args.origin.shareScopeMap[scope]
          })

          return {
            ...args,
            shareInfo: {
              ...args.shareInfo,
              scope: patchedScopes,
            },
          }
        }

        return args
      },
      resolveShare: (args) => {
        const pkgName = args.pkgName
        const pkgVersion = args.version
        const stateStrategy = options.sharedDependencies[pkgName]
          ? options.sharedDependencies[pkgName].stateStrategy
          : options.stateStrategy

        const resolvedDependency = args.resolver()
        if (!resolvedDependency) {
          return args
        }

        args.resolver = () => ({
          ...resolvedDependency,
          lib: undefined,
          loaded: false,
          loading: Promise.resolve()
            .then(() => resolvedDependency.get())
            .then((originalFactory) => {
              // Mark the original factory as loaded
              resolvedDependency.lib = originalFactory
              resolvedDependency.loaded = true
              log(
                RuntimeVerbosity.Debug,
                `[mfi/${ownRequire.federation.isolation.hostName}] Loaded original factory for ${pkgName}@${pkgVersion} from ${resolvedDependency.from}`
              )
              return originalFactory
            })
            .then((originalFactory) => {
              const originHost = args.GlobalFederation.__INSTANCES__.find(
                (instance) => instance.name === resolvedDependency.from
              ) as ExtendedFederationHost

              if (!originHost) {
                log(
                  RuntimeVerbosity.Warnings,
                  `[mfi/${ownRequire.federation.isolation.hostName}] Could not find host named ${resolvedDependency.from}`
                )
                return originalFactory
              } else if (!originHost.__webpack_require__) {
                log(
                  RuntimeVerbosity.Warnings,
                  `[mfi/${ownRequire.federation.isolation.hostName}] Host ${resolvedDependency.from} is not using ${PLUGIN_NAME}`
                )
                return originalFactory
              }

              // Retrieve shared consume module ID from scope
              const scopeMfiMarkIndex = args.scope.indexOf('/mfi/scope/')
              if (scopeMfiMarkIndex === -1) {
                log(
                  RuntimeVerbosity.Warnings,
                  `[mfi/${ownRequire.federation.isolation.hostName}] Could not find MFI scope mark in scope '${args.scope}'`
                )
                return originalFactory
              }

              const ownConsumeSharedModuleId = args.scope.slice(0, scopeMfiMarkIndex)

              // Retrieve origin host require and provided module ID
              const originRequire = originHost.__webpack_require__
              let originModuleId = resolvedDependency.get.providedModuleId

              if (originModuleId === undefined) {
                // Fallback: attempt to match module exports
                const originModuleInstance = originalFactory()
                originModuleId = Object.entries(originRequire.c).find(
                  ([, { exports }]) => exports === originModuleInstance
                )?.[0]
              }

              if (originModuleId === undefined) {
                log(
                  RuntimeVerbosity.Warnings,
                  `[mfi/${ownRequire.federation.isolation.hostName}] Could not find module ID for ${ownConsumeSharedModuleId}`
                )
                return originalFactory
              }

              // Save the redirection in the own require cache
              log(
                RuntimeVerbosity.Debug,
                `[mfi/${ownRequire.federation.isolation.hostName}] Setting redirection ${ownConsumeSharedModuleId} -> ${originModuleId}`
              )
              ownRequire.federation.isolation.red[ownConsumeSharedModuleId] = {
                mid: originModuleId,
                webpackRequire: originRequire,
              }

              if (stateStrategy === RuntimeStateStrategy.UseOrigin) {
                return originalFactory
              }

              const patchedRequire = createTranslationRequire(
                ownRequire,
                originRequire,
                `mfi/${ownRequire.federation.isolation.hostName}/${pkgName}/${pkgVersion}`,
                stateStrategy,
                log
              )
              return () => patchedRequire(originModuleId as WebpackModuleId)
            }),
        })

        return args
      },
    }
  }
}
