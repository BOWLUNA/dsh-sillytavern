/**
 * The browser module table — the ONLY modules a client bundle may value-import.
 *
 * This list is a measurement, not a preference. It was read out of the running
 * web shell's own bundle:
 *
 *   F=node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js
 *   grep -o -E '@deepseek-ai/[a-zA-Z0-9._-]+' "$F" | sort -u
 *
 * (plus the four React ids the shell mounts, which appear as bare `react`
 * specifiers rather than scoped ones).
 *
 * Why this matters more than it looks: the loader resolves a client bundle
 * against this frozen table. A value import that is not in it fails **at page
 * load**, taking the whole plugin apply with it — not at build time. So the
 * build is where we refuse it.
 *
 * Two ids the legacy project depended on are NOT here and must never come
 * back: `@deepseek-ai/dsh-client-web-react` and `@deepseek-ai/dsh-client-runtime`.
 * They existed in the older dsh the legacy code was written against and are
 * gone in 0.1.6-alpha.1. Anything needing their functionality now goes through
 * `react` directly, `@deepseek-ai/dsh-client-store`, or a slot.
 *
 * Re-verify after every dsh upgrade: same command, same expectation.
 */
export const SEED_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]
