import semverSatisfies from 'semver/functions/satisfies'
import type {
  SizeOptimizedManifest,
  SizeOptimizedSharedModuleRedirection,
  WebpackModuleId,
} from './ModuleFederationIsolationPlugin'

const PLUGIN_NAME = 'ModuleFederationIsolationPlugin'

type StateStrategy = 'use-origin' | 'use-isolated' | 'use-own'

type RuntimePluginOptions = {
  stateStrategy: StateStrategy
  sharedDependencies: Record<
    string,
    {
      stateStrategy: StateStrategy
    }
  >
}

declare global {
  let __webpack_require__: WebpackRequire
  let __webpack_modules__: Record<WebpackModuleId, WebpackModuleFactory>
}

interface WebpackModuleFactory<T = unknown> {
  (this: T, module: WebpackModule, exports: T, require: WebpackRequire): T
}

type WebpackModule<T = unknown> = {
  id: WebpackModuleId
  loaded: boolean
  exports: T
}

type RuntimeSharedModuleRedirection = SizeOptimizedSharedModuleRedirection & {
  // If missing, the redirection is not known at the time
  originRequire?: WebpackRequire
}

type RuntimeManifest = Pick<SizeOptimizedManifest, 'pkg' | 'pre'> & {
  // If null, the redirection couldn't be resolved (i.e. the host that shared the dependency
  // is not using the plugin)
  red: Record<WebpackModuleId, RuntimeSharedModuleRedirection | null>
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
  federation: {
    isolation: RuntimeManifest
  }
}

interface FederationRuntimeDependencyLib {
  (): WebpackModule['exports']
}

interface FederationRuntimeDependencyGetter {
  (): Promise<FederationRuntimeDependencyLib>
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
  __webpack_require__: WebpackRequire
}

interface FederationRuntimeBeforeInitArgs {
  origin: FederationRuntimeHost
}

interface FederationRuntimeResolveShareArgs {
  pkgName: string
  version: string
  resolver: () => FederationRuntimeDependency
  GlobalFederation: {
    __INSTANCES__: ExtendedFederationHost[]
  }
}

interface FederationRuntimePlugin {
  name: string
  version: string
  beforeInit: (args: FederationRuntimeBeforeInitArgs) => FederationRuntimeBeforeInitArgs
  resolveShare: (args: FederationRuntimeResolveShareArgs) => FederationRuntimeResolveShareArgs
}

type ExtendedFederationHost = {
  name: string
  __webpack_require__: WebpackRequire
}

interface WebpackRequirePatcher {
  (
    ownRequire: WebpackRequire,
    originalOriginRequire: WebpackRequire,
    isolationNamespace: string,
  ): WebpackRequire
}

function patchModuleFactory(
  moduleFactory: WebpackModuleFactory,
  patchedRequire: WebpackRequire,
): WebpackModuleFactory {
  return new Proxy(moduleFactory, {
    apply(target, thisArg, args) {
      const [moduleArg, exportsArg] = args
      return target.apply(thisArg, [moduleArg, exportsArg, patchedRequire])
    },
  })
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

        midToUid[moduleId] = { pkgName: packageName, pkgVersion: packageVersion, modulePath }
      })
    })
  })
}

function updateSharedModuleRedirections(
  runtimeManifest: RuntimeManifest,
  pkgName: string,
  pkgVersion: string,
  newRedirection: RuntimeSharedModuleRedirection | null,
): void {
  Object.entries(runtimeManifest.red).forEach(([moduleId, redirectionData]) => {
    if (!redirectionData || redirectionData.originRequire) {
      return
    }

    const { pkgName: redirectionPkgName, pkgVersion: redirectionPkgVersion } =
      runtimeManifest.midToUid[redirectionData.mid]

    if (redirectionPkgName === pkgName && redirectionPkgVersion === pkgVersion) {
      runtimeManifest.red[moduleId] = newRedirection
    }
  })
}

function createIsolationRequire(
  ownRequire: WebpackRequire,
  originalOriginRequire: WebpackRequire,
  isolationNamespace: string,
): WebpackRequire {
  return new Proxy(originalOriginRequire, {
    apply(_, thisArg, args) {
      let [originModuleId] = args
      let originRequire = originalOriginRequire

      // If module is a consume shared module, redirect to the real module and host
      const possibleRedirection = originRequire.federation.isolation.red[originModuleId]
      if (possibleRedirection) {
        originModuleId = possibleRedirection.mid
        originRequire = possibleRedirection.originRequire ?? originRequire
      }

      const isolatedModuleId: WebpackModuleId = `${isolationNamespace}/${originModuleId}`
      if (ownRequire.c[isolatedModuleId]) {
        // Module is already instantiated and copied to the own cache
        return ownRequire.c[isolatedModuleId].exports
      }

      if (originRequire.c[isolatedModuleId]) {
        // Module is still instantiating in the originRequire cache
        return originRequire.c[isolatedModuleId].exports
      }

      // Module is not in cache, create a new module instance
      originRequire.m[isolatedModuleId] = patchModuleFactory(
        originRequire.m[originModuleId],
        createIsolationRequire(ownRequire, originRequire, isolationNamespace),
      )
      originRequire.apply(thisArg, [isolatedModuleId])

      // Move instantiated module and clean up the origin cache
      ownRequire.c[isolatedModuleId] = originRequire.c[isolatedModuleId]
      if (ownRequire !== originRequire) {
        delete originRequire.c[isolatedModuleId]
        delete originRequire.m[isolatedModuleId]
      }
      return ownRequire.c[isolatedModuleId].exports
    },
  })
}

function createTranslationRequire(
  ownRequire: WebpackRequire,
  originalOriginRequire: WebpackRequire,
  isolationNamespace: string,
): WebpackRequire {
  return new Proxy(originalOriginRequire, {
    apply(_, thisArg, args) {
      let [originModuleId] = args
      let originRequire = originalOriginRequire

      // If module is a consume shared module, redirect to the real module and host
      const possibleRedirection = originRequire.federation.isolation.red[originModuleId]
      if (possibleRedirection) {
        originModuleId = possibleRedirection.mid
        originRequire = possibleRedirection.originRequire ?? originRequire
      }

      let ownModuleId: WebpackModuleId | undefined = undefined

      const originUniversalModule = originRequire.federation.isolation.midToUid[originModuleId]

      if (originUniversalModule) {
        const originPackageUniversalId = `${originUniversalModule.pkgName}~${originUniversalModule.pkgVersion}`
        const originHostName = originRequire.federation.isolation.hostName

        let ownPackageVersion =
          ownRequire.federation.isolation.pkgMatch[originHostName]?.[originPackageUniversalId]

        if (ownPackageVersion === undefined) {
          ownPackageVersion =
            ownRequire.federation.isolation.pkgVersions[originUniversalModule.pkgName]?.find(
              ([, rangesIn]) =>
                rangesIn.every((range) => semverSatisfies(originUniversalModule.pkgVersion, range)),
            )?.[0] ?? null

          ownRequire.federation.isolation.pkgMatch[originHostName] = {
            ...(ownRequire.federation.isolation.pkgMatch[originHostName] || {}),
            [originPackageUniversalId]: ownPackageVersion,
          }
        }

        if (ownPackageVersion !== null) {
          ownModuleId =
            ownRequire.federation.isolation.pkg[originUniversalModule.pkgName][
              ownPackageVersion
            ][1][originUniversalModule.modulePath]
        }
      }

      if (ownModuleId && ownRequire.c[ownModuleId]) {
        // Module is already instantiated and copied to the own cache
        return ownRequire.c[ownModuleId].exports
      }

      const isolatedModuleId: WebpackModuleId = `${isolationNamespace}/${originModuleId}`
      ownModuleId = ownModuleId ?? isolatedModuleId

      if (originRequire.c[isolatedModuleId]) {
        // Module is still instantiating in the originRequire cache
        return originRequire.c[isolatedModuleId].exports
      }

      // Module is not in cache, create a new module instance
      originRequire.m[isolatedModuleId] = patchModuleFactory(
        originRequire.m[originModuleId],
        createTranslationRequire(ownRequire, originRequire, isolationNamespace),
      )
      originRequire.apply(thisArg, [isolatedModuleId])

      // Move instantiated module and clean up the origin cache
      ownRequire.c[ownModuleId] = originRequire.c[isolatedModuleId]
      if (ownRequire !== originRequire) {
        delete originRequire.c[isolatedModuleId]
        delete originRequire.m[isolatedModuleId]
      }
      return ownRequire.c[ownModuleId].exports
    },
  })
}

export function createMfiRuntimePlugin(
  options: RuntimePluginOptions,
): () => FederationRuntimePlugin {
  return function plugin(): FederationRuntimePlugin {
    const ownRequire = __webpack_require__

    initiateRuntimeManifestIfPresent(ownRequire)

    return {
      name: 'ModuleFederationIsolationRuntimePlugin',
      version: '2.0.0',
      beforeInit: (args) => {
        const ownHost = args.origin
        // Expose the __webpack_require__ function in the federation host
        if (!ownHost.__webpack_require__) {
          ownHost.__webpack_require__ = ownRequire
        } else if (ownHost.__webpack_require__ !== ownRequire) {
          console.warn(
            `[${PLUGIN_NAME}] The __webpack_require__ function of the host ${ownHost.name} is already set. This may lead to unexpected behavior.`,
          )
        }
        // Save the host name in the manifest
        ownRequire.federation.isolation.hostName = ownHost.name
        return args
      },
      resolveShare: (args) => {
        const pkgName = args.pkgName
        const pkgVersion = args.version

        let stateStrategy = options.stateStrategy
        if (options.sharedDependencies[pkgName]) {
          stateStrategy = options.sharedDependencies[pkgName].stateStrategy
        }

        const resolvedDependency = args.resolver()
        if (!resolvedDependency) {
          return args
        }

        args.resolver = () => ({
          ...resolvedDependency,
          scope: [ownRequire.federation.isolation.hostName],
          lib: undefined,
          loaded: false,
          loading: Promise.resolve()
            .then(() => resolvedDependency.get())
            .then((originalFactory) => {
              // Mark the original factory as loaded
              resolvedDependency.lib = originalFactory
              resolvedDependency.loaded = true
              return originalFactory
            })
            .then((originalFactory) => {
              const originHost = args.GlobalFederation.__INSTANCES__.find(
                (instance) => instance.name === resolvedDependency.from,
              ) as ExtendedFederationHost

              if (!originHost) {
                console.warn(
                  `[${PLUGIN_NAME}] Could not find host named ${resolvedDependency.from}`,
                )
                updateSharedModuleRedirections(
                  ownRequire.federation.isolation,
                  pkgName,
                  pkgVersion,
                  null,
                )
                return originalFactory
              } else if (!originHost.__webpack_require__) {
                console.warn(
                  `[${PLUGIN_NAME}] Host ${resolvedDependency.from} is not using ${PLUGIN_NAME}`,
                )
                updateSharedModuleRedirections(
                  ownRequire.federation.isolation,
                  pkgName,
                  pkgVersion,
                  null,
                )
                return originalFactory
              }

              const originRequire = originHost.__webpack_require__
              const originModuleInstance = originalFactory()
              const originModuleId = Object.entries(originRequire.c).find(
                ([, { exports }]) => exports === originModuleInstance,
              )?.[0]
              if (!originModuleId) {
                console.warn(
                  `[ModuleFederationIsolationRuntime] Could not find the module ID for the ${pkgName} entrypoint in the ${resolvedDependency.from} host cache`,
                )
                updateSharedModuleRedirections(
                  ownRequire.federation.isolation,
                  pkgName,
                  pkgVersion,
                  null,
                )
                return originalFactory
              }

              updateSharedModuleRedirections(ownRequire.federation.isolation, pkgName, pkgVersion, {
                mid: originModuleId,
                originRequire,
              })

              if (stateStrategy === 'use-origin') {
                return originalFactory
              }

              const createPatchedRequire: WebpackRequirePatcher =
                stateStrategy === 'use-isolated' ? createIsolationRequire : createTranslationRequire

              const patchedRequire = createPatchedRequire(
                ownRequire,
                originRequire,
                `mfi/${ownRequire.federation.isolation.hostName}/${pkgName}/${pkgVersion}`,
              )
              return () => patchedRequire(originModuleId)
            }),
        })

        return args
      },
    }
  }
}
