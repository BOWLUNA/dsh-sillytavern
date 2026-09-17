/**
 * Verify every package's browser declaration against the platform's own
 * parser, in process, with no server.
 *
 * Why this exists rather than a boot test: this machine has ~1.6 GB of RAM and
 * the running harness already holds a few hundred of them. Booting a second
 * full web instance to check a declaration is how the previous attempt took the
 * session down. The parser below is the same code the running host uses to read
 * a package's `dsh.client` field — the node half's Loader scan and this share
 * one validator — so calling it directly is not a simulation.
 *
 * Three things are checked per package:
 *
 *   1. `dsh.client` parses through the platform's `parseDshClient`. A malformed
 *      member throws there, so this is the real acceptance test.
 *   2. The package actually ships the bundle the declaration promises, at the
 *      `./client` export. The platform fails activation loudly when `lib/client.js`
 *      is missing, so the gate reports it earlier.
 *   3. Every module the built bundle `require`s is either part of the page's
 *      frozen baseline or declared in `dsh.client.external`. Composition rejects
 *      undeclared requests, which is a page-load failure — the worst possible
 *      place to find one.
 *
 * Run: node tools/verify-client-manifest.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SEED_MODULES } from './seed-modules.mjs'
import { resolveDshInstall } from './resolve-platform.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(here, '..')
const require = createRequire(import.meta.url)

/**
 * Load the platform's browser-safe contract module in Node and return its
 * exports.
 *
 * The file is a module-loader bundle: it registers a factory through
 * `window.__ModuleLoader__.load` and returns nothing. Supplying a stub
 * `window`, then invoking the captured factory with a `require` that reports
 * what it was asked for, is enough to reach the pure parsing helpers.
 */
function loadPlatformContract() {
  const dsh = resolveDshInstall()
  const bundlePath = join(
    dsh, 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'client.js',
  )
  if (!existsSync(bundlePath)) {
    throw new Error(`the platform's client-modules bundle is missing at ${bundlePath}`)
  }

  const source = readFileSync(bundlePath, 'utf8')
  const registered = new Map()
  const fakeWindow = {
    __ModuleLoader__: {
      load: (entry) => {
        if (entry && typeof entry.id === 'string' && typeof entry.factory === 'function') {
          registered.set(entry.id, entry.factory)
        }
      },
    },
  }

  // eslint-disable-next-line no-new-func
  new Function('window', source)(fakeWindow)

  const factory = registered.get('@deepseek-ai/dsh-client-modules')
  if (factory === undefined) {
    throw new Error('the client-modules bundle registered no factory for its own id')
  }

  const requested = []
  const exports = factory((specifier) => {
    requested.push(specifier)
    throw new Error(`the platform contract module unexpectedly required "${specifier}"`)
  })

  return { exports, requested }
}

/** Every package directory under `packages/`. */
function packageDirs() {
  const root = join(workspaceRoot, 'packages')
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((dir) => existsSync(join(dir, 'package.json')))
}

/**
 * Module specifiers the built browser bundle requires at runtime.
 *
 * Reads the artifact rather than the source: this is precisely the check the
 * build's purity gate cannot make, because the gate sees imports while this
 * sees what actually survived bundling.
 */
function bundleRequires(bundlePath) {
  const source = readFileSync(bundlePath, 'utf8')
  const found = new Set()
  const pattern = /require\(\s*["']([^"']+)["']\s*\)/g
  let match
  while ((match = pattern.exec(source)) !== null) found.add(match[1])
  return [...found]
}

const BASELINE = new Set(SEED_MODULES)

function main() {
  const { exports: platform, requested } = loadPlatformContract()
  if (typeof platform.parseDshClient !== 'function') {
    throw new Error(
      'the platform contract module no longer exports `parseDshClient`. '
      + `Exports seen: ${Object.keys(platform).join(', ') || '(none)'}`,
    )
  }

  const failures = []
  let checked = 0

  for (const dir of packageDirs()) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const pkgName = manifest.name
    const clientField = manifest.dsh?.client

    if (clientField === undefined) {
      console.log(`—  ${pkgName}: no browser half declared, skipped`)
      continue
    }

    checked += 1
    const problems = []

    // 1. The platform's own parser accepts the declaration.
    let parsed
    try {
      parsed = platform.parseDshClient(pkgName, clientField)
    } catch (error) {
      problems.push(`dsh.client rejected by the platform parser: ${error.message}`)
    }
    if (parsed === undefined) problems.push('dsh.client parsed to undefined')

    // 2. The bundle the declaration promises exists where it is promised.
    const clientExport = manifest.exports?.['./client']
    if (clientExport === undefined) {
      problems.push('no "./client" export, so the bundle is unreachable')
    }
    const bundlePath = clientExport?.default ?? clientExport?.import ?? clientExport
    if (typeof bundlePath !== 'string') {
      problems.push('the "./client" export does not resolve to a path')
    } else {
      const absolute = join(dir, bundlePath)
      if (!existsSync(absolute)) {
        problems.push(`the built bundle is missing at ${bundlePath} (run the build first)`)
      } else {
        // 3. Nothing the bundle requires falls outside baseline + external.
        const declared = new Set([...(parsed?.external ?? [])])
        for (const specifier of bundleRequires(absolute)) {
          if (BASELINE.has(specifier) || declared.has(specifier)) continue
          problems.push(
            `the bundle requires "${specifier}", which is neither in the page baseline `
            + 'nor declared in dsh.client.external — composition rejects this at page load',
          )
        }
        const requires = bundleRequires(absolute)
        console.log(
          `✓  ${pkgName}: platform=${parsed?.platform}, `
          + `external=${declared.size === 0 ? '(none)' : [...declared].join(', ')}, `
          + `bundle requires ${requires.length === 0 ? 'nothing' : requires.join(', ')}`,
        )
      }
    }

    if (problems.length > 0) failures.push({ pkgName, problems })
  }

  if (requested.length > 0) {
    console.log(`\nnote: the contract module required ${[...new Set(requested)].join(', ')}`)
  }

  if (failures.length > 0) {
    console.error('\nclient manifest verification FAILED:')
    for (const { pkgName, problems } of failures) {
      console.error(`\n  ${pkgName}`)
      for (const problem of problems) console.error(`    - ${problem}`)
    }
    process.exitCode = 1
    return
  }

  console.log(`\nclient manifests OK (${checked} package${checked === 1 ? '' : 's'} with a browser half)`)
}

main()
