/**
 * Shared dual-face build for the tavern plugin packages.
 *
 *   lib/index.js   host half  — Node ESM, every `@deepseek-ai/*` left external
 *   lib/client.js  browser half — CJS closure loaded through
 *                              `window.__ModuleLoader__.load`
 *
 * The host half must keep platform packages external: the host plugin tree
 * shares one cordis/DSH instance, and bundling a second copy would fork
 * Service and Context identity. The client half must resolve *only* against
 * the shell's frozen module table (see ./seed-modules.mjs) for the same reason.
 *
 * Not in the seed table => build error. That is the point.
 */

import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import { SEED_MODULES } from './seed-modules.mjs'

/**
 * Build one plugin package's dual-face artifact.
 * @param {{ pluginName: string, entryHost?: string, entryClient?: string }} options
 *   `pluginName` is the npm package name; it is also the module-loader id and
 *   the CSS dedup tag, which is why it must stay stable across releases.
 */
export async function buildPlugin(options) {
  const {
    pluginName,
    entryHost = 'src/index.ts',
    entryClient = 'src/client/index.tsx',
  } = options
  const cssTag = `${pluginName}-css`

  /** Purity gate: only seed-table modules may resolve inside the client bundle. */
  const clientPurity = {
    name: 'dsh-client-bundle-purity',
    setup(buildCtx) {
      buildCtx.onResolve({ filter: /^@deepseek-ai\// }, (args) => {
        if (SEED_MODULES.includes(args.path)) return null
        return {
          errors: [{
            text: `client bundle purity: "${args.path}" is not in the shell module table. `
              + 'Cross-plugin collaboration goes through cordis services; everything else must be a type-only import. '
              + 'See tools/seed-modules.mjs.',
          }],
        }
      })
    },
  }

  /**
   * Inline stylesheets: a `.module.css` import injects its text as one
   * `<style data-plugin>` tag when the factory executes. Class names stay
   * global, so every selector is plugin-prefixed by convention.
   */
  const inlineCss = {
    name: 'dsh-inline-css',
    setup(buildCtx) {
      buildCtx.onLoad({ filter: /\.module\.css$/ }, async (args) => {
        const css = await readFile(args.path, 'utf8')
        return {
          contents: `const css = ${JSON.stringify(css)};`
            + ` if (typeof document !== 'undefined' && document.querySelector(${JSON.stringify(`style[data-plugin-css="${cssTag}"]`)}) === null) {`
            + ` const tag = document.createElement('style');`
            + ` tag.dataset.plugin = ${JSON.stringify(pluginName)};`
            + ` tag.dataset.pluginCss = ${JSON.stringify(cssTag)};`
            + ` tag.textContent = css; document.head.appendChild(tag); }`
            + ' export default {};',
          loader: 'js',
        }
      })
    },
  }

  /**
   * Host half: every `@deepseek-ai/*` and `zod` stays external.
   *
   * `@deepseek-ai/*` must stay external because the host plugin tree shares one
   * cordis/DSH instance, and bundling a second copy would fork Service and
   * Context identity.
   *
   * `zod` stays external for a different reason: it is a real dependency of
   * this package, so the runtime resolves it from the installed tree, once.
   * Bundling it would put a ~700 KB private copy into every plugin artifact and
   * leave two schema implementations in one process.
   */
  const hostExternals = {
    name: 'dsh-host-externals',
    setup(buildCtx) {
      buildCtx.onResolve({ filter: /^@deepseek-ai\/|^zod(\/|$)/ }, (args) => ({ path: args.path, external: true }))
    },
  }

  await build({
    entryPoints: [entryHost],
    outfile: 'lib/index.js',
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    plugins: [hostExternals],
    sourcemap: true,
    logLevel: 'warning',
  })

  await build({
    entryPoints: [entryClient],
    outfile: 'lib/client.js',
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: SEED_MODULES,
    plugins: [clientPurity, inlineCss],
    // Stated explicitly rather than inherited from tsconfig, so the client
    // transform cannot silently change with an unrelated compiler option.
    jsx: 'automatic',
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    sourcemap: true,
    logLevel: 'warning',
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pluginName)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
    },
    footer: { js: 'return module.exports; } });' },
  })

  console.log(`${pluginName} built: lib/index.js (host), lib/client.js (browser)`)
}
