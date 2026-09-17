/**
 * Access to the typert registry, declared once.
 *
 * The platform's own type for `ctx.typert` — `TypertRegistryContract` in
 * `@deepseek-ai/dsh-typert-protocol` — describes only the read side (`local`,
 * `remotes`, `lookups`, `contexts`). The live service also exposes the write
 * side, which the host's own service directory reports as:
 *
 *     register(contribution: TypertContribution): TypertDisposer
 *
 * Rather than widen a platform type with a cast at each call site, the one method
 * used is named here, once, behind a runtime guard — and shared, because both
 * plugins register descriptors.
 *
 * @module @dsh-tavern/contracts/typert
 */

import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry'

/** The slice of the typert registry this project uses. */
export interface TypertRegistry {
  register(contribution: TypertContribution): () => Promise<void>
}

/**
 * Resolve the typert registry, or say precisely what is wrong.
 *
 * A missing platform API means a dsh version this project has not been checked
 * against, and it should say so once at mount rather than failing per request
 * with an opaque 500.
 */
export function requireTypertRegistry(ctx: { typert?: unknown }, pluginName: string): TypertRegistry {
  const registry = ctx.typert as unknown as TypertRegistry | undefined
  if (registry === undefined || registry === null || typeof registry.register !== 'function') {
    throw new Error(
      `${pluginName}: the platform exposes no usable \`typert.register\`. `
      + 'This plugin targets @deepseek-ai/dsh 0.1.6-alpha.1, where the typert service declares '
      + '`register(contribution)`. '
      + `Got: ${registry === undefined ? 'service absent' : typeof registry}.`,
    )
  }
  return registry
}
