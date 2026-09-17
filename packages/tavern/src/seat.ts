/**
 * The seat's decision logic, without the platform.
 *
 * `mount` has to touch the host — it registers a prompt context — and the
 * service that owns it extends a platform class, so anything living there can
 * only be tested with a real dsh. This module is the part that actually decides
 * what a room's members see: which books apply, what the scan produces, and what
 * the renderer is allowed to receive.
 *
 * Keeping it separate is the same split as `MemberRuntime` in group-chat: the
 * platform-touching edge is one thin function, and everything that can be wrong
 * in an interesting way is behind a plain function boundary.
 *
 * @module dsh-tavern/seat
 */

import { sanitizePromptText } from '@dsh-tavern/contracts'
import { builtinKeyMacros, scan } from './lorebook.ts'
import type { Book as EngineBook, Entry as EngineEntry, ScanResult } from './lorebook.ts'
import type { BookRecord } from './schema.ts'

/** Everything a seat needs besides the conversation. */
export interface SeatInput {
  /** Every book that exists. Filtering by binding happens here. */
  readonly books: readonly BookRecord[]
  /** The book ids bound to the targets in question, unioned across owners. */
  readonly boundBookIds: readonly string[]
  readonly macros: Readonly<Record<string, string>>
  readonly contextTokens: number
  readonly random: () => number
}

/** The engine's view of one stored book. */
export function toEngineBook(record: BookRecord): EngineBook {
  return {
    bookId: record.bookId,
    name: record.name,
    enabled: record.enabled,
    entries: record.entries as readonly EngineEntry[],
    settings: record.settings,
  }
}

/**
 * Key macros: the consumer's values first, then the built-ins.
 *
 * The consumer's names win, so a room can supply `{{char}}` meaning *this
 * member* without the built-in layer having an opinion about it.
 */
export function seatKeyMacros(
  macros: Readonly<Record<string, string>>,
  random: () => number,
): (key: string) => string {
  const builtins = builtinKeyMacros({ random })
  return (key: string): string => {
    const supplied = key.replace(/\{\{([^{}]*)\}\}/g, (whole, body: string) => {
      const name = body.trim()
      return Object.hasOwn(macros, name) ? (macros[name] ?? whole) : whole
    })
    return builtins(supplied)
  }
}

/**
 * The raw scan for one assembly, or `null` when no book applies.
 *
 * The scan only sees **enabled books that are actually bound** — a disabled book
 * contributes nothing, which is what "disabled" has to mean.
 *
 * Exposed separately from `seatText` because the injection tester needs the
 * trace, not just the text: an author's question is almost never "what did it
 * produce" but "why did *this entry* not fire".
 */
export function seatScan(input: SeatInput, messages: readonly string[]): ScanResult | null {
  const bound = new Set(input.boundBookIds)
  const books = input.books
    .filter((book) => bound.has(book.bookId) && book.enabled)
    .map(toEngineBook)

  if (books.length === 0) return null

  return scan({
    books,
    messages,
    contextTokens: input.contextTokens,
    expandKey: seatKeyMacros(input.macros, input.random),
    random: input.random,
    traceAll: true,
  })
}

/**
 * The text this seat contributes for one assembly, or `''` for nothing.
 *
 * The result passes through `sanitizePromptText`, because entry content is
 * user-authored text on its way into a prompt section, where an unregistered
 * `{{…}}` makes every request fail. The tester shows the *unsanitised* text for
 * the same reason a compiler shows you the line it is complaining about, and
 * this function shows the sanitised text for the same reason it does not hand
 * that line to the linker.
 */
export function seatText(input: SeatInput, messages: readonly string[]): string {
  const result = seatScan(input, messages)
  if (result === null || result.text === '') return ''
  return sanitizePromptText(result.text, input.macros)
}
