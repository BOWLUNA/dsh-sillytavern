/**
 * The one package that crosses between dsh-tavern and dsh-group-chat.
 *
 * It deliberately carries **both** runtime code and types:
 *
 *   - runtime code the two packages must agree on exactly — the id charset,
 *     the owner vocabulary, the loud-reject error;
 *   - types describing the seam one package exposes and the other consumes.
 *
 * The legacy project duplicated this kind of code into each package and then
 * had to keep the copies in lockstep by hand (`prompt-macros.ts` and `ui.tsx`
 * existed twice each, byte-for-byte). A shared package is the fix.
 *
 * It stays safe against the client purity gate because that gate guards
 * *platform module identity* — `@deepseek-ai/*` value imports, where a second
 * copy would fork cordis/DSH Service and Context identity. Ordinary shared
 * source carries no such identity and is simply bundled.
 */

export { sanitizePromptText } from './prompt-text.ts'
export * from './validate.ts'
export * from './typert.ts'

// ────────────────────────────────────────────────────────────────────────────
// Ownership — rule 1: who may write a row is data, not convention.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Every persisted row records which side owns it. Reads are free for all; a
 * write that would touch a row owned by someone else is rejected rather than
 * merged.
 *
 * This exists because of the legacy binding table: `setBinding` (whole-row,
 * user-facing) and `addBinding`/`removeBinding` (targeted, group lifecycle)
 * were both legal writers of the same table, and the conflict took two separate
 * audits across two packages to surface. The rule that finally worked — "the
 * lifecycle may only add and remove book ids it manages" — was enforced by
 * caller discipline. Encoding it as a field makes it checkable.
 */
export const Owner = {
  /** Written by the tavern package. */
  Tavern: 'tavern',
  /** Written by the group-chat package's lifecycle. */
  GroupChat: 'group-chat',
  /** Written by a human through an editor surface. */
  User: 'user',
} as const

export type Owner = (typeof Owner)[keyof typeof Owner]

export const OWNERS: readonly Owner[] = Object.values(Owner)

export function isOwner(value: unknown): value is Owner {
  return typeof value === 'string' && (OWNERS as readonly string[]).includes(value)
}

// ────────────────────────────────────────────────────────────────────────────
// Identity — one charset for every id that can reach durable storage.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Shared upper bounds.
 *
 * These live here rather than in each package because they are part of the
 * cross-package contract: the tavern side and the group-chat side both write
 * target ids and book ids into each other's rows, so a bound that disagreed
 * between them would let one side store a value the other rejects on read.
 */
export const LIMITS = {
  /** Id length, matching the upper bound encoded in {@link ID_CHARSET}. */
  id: 200,
  /** A display name. */
  name: 200,
  /** Free-form persona / scenario / prompt text. */
  text: 64 * 1024,
  /** Book ids bound to a single target by a single owner. */
  bindings: 100,
} as const

/**
 * The legacy engine keyed its activation table by a bare `entryId`, so two
 * bound books that both contained `entryId: "0"` silently ate each other. It
 * was found twice: once within a book, once across books. One charset plus one
 * composite-key helper removes the whole class.
 */
export const ID_CHARSET = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

export function isId(value: unknown): value is string {
  return typeof value === 'string' && ID_CHARSET.test(value)
}

/** Separator for composite keys. `\0` cannot occur in an id, so keys are injective. */
export const KEY_SEPARATOR = '\u0000'

export function compositeKey(...parts: readonly string[]): string {
  for (const part of parts) {
    if (part.includes(KEY_SEPARATOR)) {
      throw new RejectError('compositeKey', 'a key part contains the separator, which would alias two distinct keys')
    }
  }
  return parts.join(KEY_SEPARATOR)
}

// ────────────────────────────────────────────────────────────────────────────
// Rejection — rule 2: one error type, thrown loudly, never silently corrected.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The only error a boundary validator throws.
 *
 * The legacy project's reviews contain the word "silently" 26 times. Two of
 * those were data-corrupting: an unrecognised group `mode` silently became
 * `round-robin` (leaving ghost groups), and a misspelled book `scope` silently
 * became `global` — which injects into **every** session in the process. Loud
 * rejection is the fix, and it only holds if there is one type to catch.
 */
export class RejectError extends Error {
  readonly field: string
  readonly reason: string

  constructor(field: string, reason: string) {
    super(`${field}: ${reason}`)
    this.name = 'RejectError'
    this.field = field
    this.reason = reason
  }
}

export function reject(field: string, reason: string): never {
  throw new RejectError(field, reason)
}

export function isReject(error: unknown): error is RejectError {
  return error instanceof RejectError
}

// ────────────────────────────────────────────────────────────────────────────
// The seam — tavern offers it, group chat optionally consumes it.
// ────────────────────────────────────────────────────────────────────────────

/** A stored world-info book, as seen through the seam. */
export interface BookRef {
  readonly bookId: string
  readonly name: string
  readonly scope: 'global' | 'bound'
  readonly enabled: boolean
}

/**
 * The slice of an agent's context the seat needs.
 *
 * Structural rather than `Context`, for two reasons. It keeps this package free
 * of any platform import, so it can be bundled into a browser half without
 * pulling cordis in; and it makes the seam testable — a fake with one `context`
 * method is a complete stand-in, so `mount`'s behaviour can be verified without
 * an agent, a model, or a running host.
 */
export interface SeatHost {
  readonly systemPrompt: {
    /**
     * Register one prompt context. `text` is evaluated on every assembly, which
     * is what makes world info follow the conversation rather than freeze at
     * mount time.
     *
     * Note what the provider is *not* given: the platform's `AssembleContext`
     * carries only `{ scope, signal }` — no agent, no session, no messages. So a
     * provider that needs the conversation must close over a source, which is
     * why the mount request carries one.
     */
    context(input: {
      readonly name: string
      readonly order: number
      readonly text: string | ((context: unknown) => string)
    }): () => void
  }
}

/** Everything one mount needs. */
export interface SeatMountRequest {
  readonly host: SeatHost
  /** Targets whose bound books apply — typically a room id and a member id. */
  readonly targetIds: readonly string[]
  /** Values for `{{…}}` inside entry content. Unknown ones stay literal. */
  readonly macros?: Readonly<Record<string, string>>
  /**
   * The conversation to scan, newest first.
   *
   * Supplied by the consumer, not read here, because the consumer owns the
   * transcript and this side owns the books. A group-chat room knows how to
   * derive its own messages; the tavern has no business guessing.
   */
  readonly messages: () => readonly string[]
  /** Context token budget the book's percentage is taken against. */
  readonly contextTokens?: number
  /** Injected for deterministic tests. */
  readonly random?: () => number
}

/** What group chat needs from the tavern side, and nothing more. */
export interface ContextSeatSeam {
  /**
   * Attach this target's bound books to one agent's prompt assembly.
   * @returns a disposer that detaches them.
   */
  mount(request: SeatMountRequest): () => void

  addBinding(targetId: string, bookId: string): Promise<void>
  removeBinding(targetId: string, bookId: string): Promise<void>
  listBooks(): Promise<readonly BookRef[]>
}

export interface RoomRef {
  readonly roomId: string
  readonly name: string
  readonly sessionId: string
  readonly memberIds: readonly string[]
}

// ────────────────────────────────────────────────────────────────────────────
// The world-info wire shape — type-only, shared by both halves
// ────────────────────────────────────────────────────────────────────────────

/** `0` AND_ANY · `1` NOT_ALL · `2` NOT_ANY · `3` AND_ALL */
export type SecondaryLogic = 0 | 1 | 2 | 3

/**
 * One world-info entry, as it crosses the wire.
 *
 * Type-only on purpose. The host's authority is a zod schema, and the browser
 * half must not import it — zod is bundled into the host artifact and has no
 * business in a browser bundle. So the shape is declared once here, the host's
 * `readBook` is typed as returning it, and returning the schema-parsed records
 * is itself the compile-time check: if the two drift, the return statement stops
 * typechecking.
 */
export interface LorebookEntry {
  readonly entryId: string
  readonly keys: readonly string[]
  readonly secondaryKeys: readonly string[]
  readonly content: string
  readonly comment: string
  readonly constant: boolean
  readonly selective: boolean
  readonly selectiveLogic: SecondaryLogic
  readonly order: number
  readonly position: 'before' | 'after'
  readonly probability: number
  readonly useProbability: boolean
  readonly group: string
  readonly groupWeight: number
  readonly groupOverride: boolean
  readonly disable: boolean
  readonly ignoreBudget: boolean
  readonly scanDepth: number | null
  readonly caseSensitive: boolean | null
  readonly matchWholeWords: boolean | null
  readonly excludeRecursion: boolean
  readonly preventRecursion: boolean
}

/** One book's scan settings, as they cross the wire. Type-only, like the entry. */
export interface LorebookSettings {
  readonly scanDepth: number
  readonly budgetPercent: number
  /** Absolute byte cap; `0` means "no separate cap". */
  readonly budgetCap: number
  readonly caseSensitive: boolean
  readonly matchWholeWords: boolean
  readonly recursive: boolean
  readonly maxRecursionSteps: number
  readonly allowRegex: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// The room wire shape — one declaration, used by both halves.
// ────────────────────────────────────────────────────────────────────────────

/** How a room takes turns. */
export type RoomMode = 'round-robin' | 'free'

/** Where a room is in its lifecycle. */
export type RoomStatus = 'stopped' | 'running' | 'paused'

/**
 * A room as it crosses the wire.
 *
 * Declared here rather than twice — once in the host service and once in the
 * browser half — because two declarations of one shape is exactly how the legacy
 * project ended up maintaining byte-identical copies of `prompt-macros.ts` and
 * `ui.tsx` in two packages. The host's `toSummary` is typed as returning this, so
 * a drift between these literal unions and the host's own vocabulary becomes a
 * compile error rather than a runtime surprise.
 *
 * Every field is required on purpose: the gateway rejects a payload containing
 * `undefined`, so an optional field here would be a hole in the response.
 */
/**
 * A member as it crosses the wire.
 *
 * Persona fields are sent verbatim. The host stores what the user wrote; any
 * rewriting happens at prompt assembly, where it can be explained, rather than
 * on the way in, where it is invisible and lossy.
 */
export interface MemberSummary {
  readonly memberId: string
  readonly name: string
  readonly emoji: string
  readonly description: string
  readonly personality: string
  readonly scenario: string
  readonly greeting: string
}

export interface RoomSummary {
  readonly roomId: string
  readonly name: string
  readonly mode: RoomMode
  readonly status: RoomStatus
  readonly memberCount: number
  readonly maxRounds: number
  readonly hasSession: boolean
  readonly createdAt: number
}

/** Cordis service keys for the two seams. */
export const SERVICE = {
  /** Provided by dsh-tavern; consumed optionally by dsh-group-chat. */
  ContextSeat: 'tavernContextSeat',
  /** Provided by dsh-group-chat; consumed optionally by dsh-tavern. */
  GroupChat: 'groupChat',
} as const
