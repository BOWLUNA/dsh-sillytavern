/**
 * The tavern's Remote descriptor table.
 *
 * Same reasoning as group-chat's: no code generation for an out-of-tree package,
 * and the `@Remote` decorator is unavailable to a compiler that erases types
 * and rejects decorator syntax. So the invocations are stated explicitly, and
 * their correspondence to the class is checked from a browser by the round-trip
 * in `tools/browser-verify.mjs`.
 *
 * @module dsh-tavern/remote
 */

import { SERVICE } from '@dsh-tavern/contracts'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

/** Wire namespace. Distinct from the Cordis service key, which is `SERVICE.ContextSeat`. */
export const NAMESPACE = 'tavern'

/**
 * Prompt-context order for world info.
 *
 * Chosen to sit after a member's persona and before any post-history
 * instruction, which is where a reader expects background to be. It is a
 * constant rather than a literal so the seat can be moved in one place.
 */
export const LOREBOOK_ORDER = 40

function direct(method: string, parameters: readonly string[]): InvocationDescriptor {
  return {
    id: `dsh-tavern#${method}`,
    // The gateway resolves this as a Cordis service key, and the key is
    // `tavernContextSeat` — the wire namespace is a separate field. Getting them
    // the same by accident is why group-chat works and this did not:
    // `active Service "tavern" is unavailable`, found by a real call from a
    // browser and by nothing earlier.
    service: SERVICE.ContextSeat,
    namespace: NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: parameters.map((name) => ({
      name,
      wire: name,
      source: 'json' as const,
      codec: { mode: 'src-json' as const },
    })),
    result: { mode: 'src-json' },
  }
}

export const TAVERN_REMOTES: readonly InvocationDescriptor[] = [
  direct('ping', []),
  direct('listBooks', []),
  direct('getBook', ['bookId']),
  direct('readBook', ['bookId']),
  direct('createBook', ['config']),
  direct('updateBook', ['bookId', 'patch']),
  direct('deleteBook', ['bookId']),
  direct('previewScan', ['bookIds', 'messages', 'contextTokens']),
  direct('listBindings', []),
  direct('addBinding', ['targetId', 'bookId']),
  direct('removeBinding', ['targetId', 'bookId']),
  direct('setUserBinding', ['targetId', 'bookIds']),
]
