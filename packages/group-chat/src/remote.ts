/**
 * The Remote descriptor table: the browser half's contract with the host.
 *
 * `typert` validates nothing on its own and generates nothing for an out-of-tree
 * package, so a plugin declares its invocations explicitly. That is fine — it is
 * also the reason `wire.ts` has to exist, because the descriptor says *how* to
 * transport arguments, never what they may contain.
 *
 * ## Why descriptors are built from a table rather than written out
 *
 * A descriptor names a method and lists its parameters in order. If either drifts
 * from the implementation, the failure is a malformed call at runtime, not a
 * compile error. Generating them from one table keeps the two sides adjacent, and
 * `tests/remote.test.ts` asserts the table and the class still agree — parameter
 * count included, because getting that wrong is exactly the kind of mistake that
 * only shows up in the browser.
 *
 * ## The decorator path is unavailable, deliberately
 *
 * `@Remote` exists, and the legacy project avoided it for a good reason: bundling
 * a decorated method renames its parameters, and the decorator's source-mode
 * parameter extraction then reads names that are no longer there. We have a
 * second reason — the compiler here is Node's type stripper, which erases types
 * and refuses decorator syntax outright. Explicit descriptors it is.
 *
 * @module dsh-group-chat/remote
 */

import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'

/** Wire namespace. Also the service key, which is the default. */
export const NAMESPACE = 'groupChat'

function direct(method: string, parameters: readonly string[]): InvocationDescriptor {
  return {
    id: `dsh-group-chat#${method}`,
    service: NAMESPACE,
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

/**
 * Every exported method, with its business parameters.
 *
 * Everything crosses as JSON, and results must be JSON-lossless: the gateway
 * rejects a value containing `undefined`, so a host method must return `null` (or
 * omit a key) rather than leave a hole. The legacy project learned this as
 * "#4 RPC 结果必须 JSON 无损（undefined 字段会被网关拒绝）", and it is the reason
 * the room summary below spells out every field.
 */
export const GROUP_CHAT_REMOTES: readonly InvocationDescriptor[] = [
  direct('ping', []),
  direct('roomCount', []),
  direct('listRooms', []),
  direct('getRoom', ['roomId']),
  direct('createRoom', ['config']),
  direct('deleteRoom', ['roomId']),
  direct('listMembers', ['roomId']),
  direct('addMember', ['roomId', 'config']),
  direct('removeMember', ['roomId', 'memberId']),
  direct('startGroup', ['roomId']),
  direct('stopGroup', ['roomId']),
  direct('pauseGroup', ['roomId']),
  direct('resumeGroup', ['roomId']),
  direct('pickSpeaker', ['roomId', 'memberId']),
  direct('rerollTake', ['roomId', 'memberId', 'turnId']),
  direct('getRoomState', ['roomId']),
]
