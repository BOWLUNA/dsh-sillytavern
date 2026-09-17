/**
 * Calling the host from the browser half.
 *
 * The client bundle may value-import only the page's baseline modules, and
 * `@deepseek-ai/dsh-client-connection` is not one of them — it arrives as another
 * plugin's bundle, not as part of the frozen table. So the connection is reached
 * as a **cordis service** through `ctx.get('connection')`, which needs no import
 * at all, and the slice of its shape this project uses is declared here once
 * rather than cast at every call site.
 *
 * Shared by both browser halves for the usual reason: the legacy project kept
 * two copies of this kind of file and had to hold them in step by hand.
 *
 * The payload shape is `{ args }`. That is not a convention we invented: it is
 * what the gateway's plugin endpoints expect, and the legacy project recorded it
 * after getting it wrong ("插件 RPC 载荷是 `{args}`").
 *
 * @module @dsh-tavern/contracts/client-rpc
 */

/** The logical channel every gateway endpoint rides on. */
const CHANNEL = '/api'

/** Result envelope the carrier returns; `ok: false` is a rejected call, not a throw. */
export type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** The part of the client connection service this plugin uses. */
export interface ClientConnection {
  readonly rpc: {
    call(
      channel: string,
      endpoint: string,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<RpcResult<unknown>>
  }
}

/** A host rejection, carrying the gateway's own code. */
export class RemoteCallError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RemoteCallError'
    this.code = code
  }
}

/**
 * Resolve the client `connection` service, or explain why it is missing.
 *
 * Same reasoning as `resolveSlots`: the client registry guards service reads, so
 * a missing entry in the module's `inject` array produces *no error* — the
 * service simply is not there. The diagnostic names that, because the symptom is
 * otherwise indistinguishable from a host-side fault.
 */
export function resolveConnection(
  get: (name: string) => unknown,
  pluginName: string,
): ClientConnection | null {
  const connection = get('connection')
  const rpc = (connection as ClientConnection | undefined)?.rpc
  if (connection === undefined || connection === null || rpc === undefined || typeof rpc.call !== 'function') {
    console.warn(
      `[${pluginName}] the client 'connection' service is unavailable. `
      + 'This plugin declares `inject = [\'slots\', \'connection\']`; without it the registry '
      + 'refuses the read silently. '
      + `Got: ${connection === undefined ? 'service absent' : typeof connection}`,
    )
    return null
  }
  return connection as ClientConnection
}

/**
 * Call one endpoint of this plugin's namespace.
 *
 * @throws {RemoteCallError} on a host rejection, so callers can branch on `code`
 *   — a validation rejection and a transport failure want different UI.
 */
export async function callRemote<T>(
  connection: ClientConnection,
  namespace: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await connection.rpc.call(CHANNEL, `${namespace}/${method}`, { args })
  if (!result.ok) throw new RemoteCallError(result.error.code, result.error.message)
  return result.value as T
}

/** A message for a human, from anything that might be thrown. */
export function describeError(error: unknown): string {
  if (error instanceof RemoteCallError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}
