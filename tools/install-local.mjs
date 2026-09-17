/**
 * Install these plugins into a dsh profile, locally, without a registry.
 *
 * Why a script and not `dsh plugin add`: that command forwards to pnpm, and pnpm
 * does not follow `workspace:*` dependencies when the target is not a workspace
 * member. The aggregate's bundle patch inserts a row named `dsh-group-chat`, so
 * installing only `dsh-tavern` produces a profile where that row cannot resolve
 * — a boot failure that looks like a broken plugin rather than a missing
 * dependency.
 *
 * ## Why the packages are COPIED, not symlinked
 *
 * This is not a preference; a symlink does not work. The loader imports a row by
 * the package's **real path**. A symlink into the checkout makes that real path
 * the checkout, so Node resolves the host half's `@deepseek-ai/*` imports by
 * walking up from the checkout — where no platform package exists, deliberately
 * (see `autoInstallPeers: false`). The boot dies with:
 *
 *   Cannot find package '@deepseek-ai/cordis' imported from
 *   <checkout>/packages/group-chat/lib/index.js
 *
 * Copying the built package into `<profile>/node_modules/<name>` puts the real
 * path inside the profile, where resolution walks up into the profile's own
 * platform fallback and finds the single shared instance. Measured, not assumed:
 * the same profile that failed on a symlink boots clean on a copy.
 *
 * The cost of copying is that a rebuild needs the installer re-run. That is the
 * right trade — a fast dev loop is worth nothing if the thing never boots.
 *
 * The script sets `dsh.profile.bundles` to exactly ONE entry point. That matters
 * too: both packages declare a row with id `group-chat`, and a composition tree
 * holds one row per id, so listing both as bundles is a duplicate, not a merge.
 *
 * It is idempotent and it never touches the profile's own `cordis.patch.yml`.
 *
 *   node tools/install-local.mjs --home ~/.dsh --profile lab
 *   node tools/install-local.mjs --entry dsh-group-chat --dry-run
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(here, '..')

/** The two plugin packages, and which one may be the bundle entry point. */
const PACKAGES = {
  'dsh-tavern': join(workspaceRoot, 'packages', 'tavern'),
  'dsh-group-chat': join(workspaceRoot, 'packages', 'group-chat'),
}

/**
 * Packages the profile must be able to resolve, per entry point.
 *
 * `dsh.profile.bundles` lists **package names** — not the row ids a bundle patch
 * inserts. The two differ here (`dsh-tavern` is the package, `tavern` is its
 * row), and mixing them up writes a bundle list the profile cannot resolve.
 */
const ENTRY_REQUIRES = {
  'dsh-tavern': ['dsh-tavern', 'dsh-group-chat'],
  'dsh-group-chat': ['dsh-group-chat'],
}

function parseArgs(argv) {
  const options = { home: process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh'), profile: 'web', entry: 'dsh-tavern', dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--home') options.home = argv[++i]
    else if (arg === '--profile') options.profile = argv[++i]
    else if (arg === '--entry') options.entry = argv[++i]
    else if (arg === '--dry-run') options.dryRun = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (!(options.entry in ENTRY_REQUIRES)) {
    throw new Error(`--entry must be one of ${Object.keys(ENTRY_REQUIRES).join(' | ')}, got ${options.entry}`)
  }
  if (options.home === undefined || options.profile === undefined) {
    throw new Error('--home and --profile must have values')
  }
  return options
}

/** Files a built package needs at runtime; `README.md` is optional. */
const SHIPPED = ['package.json', 'cordis.patch.yml', 'lib', 'README.md']

/**
 * Copy one built package into the profile's `node_modules`, replacing whatever
 * was there. See the header for why this cannot be a symlink.
 *
 * @returns the number of files copied, for the install report.
 */
function installPackage(modulesDir, name, source) {
  const target = join(modulesDir, name)
  if (existsSync(target)) rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  let files = 0
  for (const entry of SHIPPED) {
    const from = join(source, entry)
    if (!existsSync(from)) {
      if (entry === 'README.md') continue
      throw new Error(`${name} has no ${entry}; run the build first (pnpm run build)`)
    }
    cpSync(from, join(target, entry), { recursive: true })
    files += 1
  }
  return files
}

function main() {
  const { home, profile, entry, dryRun } = parseArgs(process.argv.slice(2))
  const profileDir = join(resolve(home), 'profiles', profile)
  const manifestPath = join(profileDir, 'package.json')

  if (!existsSync(manifestPath)) {
    throw new Error(
      `no profile at ${profileDir}.\n`
      + `Create it first, e.g.:  DSH_HOME=${resolve(home)} dsh --profile ${profile} --from-default-profile web --dump-config`,
    )
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const wanted = ENTRY_REQUIRES[entry]

  // Dependencies: both packages, as links to this checkout.
  const dependencies = { ...(manifest.dependencies ?? {}) }
  for (const name of Object.keys(PACKAGES)) {
    const dir = PACKAGES[name]
    if (!existsSync(join(dir, 'package.json'))) throw new Error(`missing package ${name} at ${dir}`)
    // Recorded as a local path for the record. It is NOT what the loader uses:
    // the loader imports the row from the profile's node_modules, which is why
    // the copy below is the part that matters. Note also that re-running pnpm in
    // the profile can replace that copy with a symlink — re-run this script if
    // the boot then fails on a platform package.
    if (wanted.includes(name)) dependencies[name] = `file:${dir}`
  }

  // Bundles: keep the platform entries, drop any of ours, append exactly one.
  const ours = new Set(Object.keys(PACKAGES))
  const existing = manifest.dsh?.profile?.bundles ?? []
  const bundles = [...existing.filter((name) => !ours.has(name)), entry]

  const removed = existing.filter((name) => ours.has(name) && name !== entry)
  const next = {
    ...manifest,
    dependencies,
    dsh: {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles },
    },
  }

  // node_modules must resolve every package the bundles reach, not only the entry.
  const modulesDir = join(profileDir, 'node_modules')
  const needed = [...wanted]

  console.log(`profile      : ${profileDir}`)
  console.log(`entry bundle : ${entry}`)
  console.log(`dependencies : ${wanted.join(', ')}`)
  console.log(`bundles      : ${bundles.join(', ')}`)
  if (removed.length > 0) {
    console.log(`dropped from bundles (would duplicate a row): ${removed.join(', ')}`)
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written')
    return
  }

  mkdirSync(modulesDir, { recursive: true })
  for (const name of needed) {
    const files = installPackage(modulesDir, name, PACKAGES[name])
    console.log(`installed    : node_modules/${name}  (${files} entries copied from ${PACKAGES[name]})`)
  }

  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`wrote        : ${manifestPath}`)

  console.log(
    '\nNext: restart dsh for the profile to recompose.\n'
    + 'Both packages ship a browser half, so a page refresh alone is not enough —\n'
    + 'the client module graph is composed at boot.\n'
    + 'The packages are COPIED, not linked: re-run this script after every rebuild.',
  )
}

try {
  main()
} catch (error) {
  // A tool should tell the operator what to do next, not where it threw.
  console.error(`install-local: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
