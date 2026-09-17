/**
 * The world-info engine.
 *
 * A pure function from (books, messages, budget) to (text, trace). No platform,
 * no I/O, no clock unless one is injected — which is what makes the semantics
 * testable at all, and they are the semantics that decide whether a character
 * says the right thing.
 *
 * ## Every rule below is a bug that shipped
 *
 * The legacy engine was 591 lines and 637 lines of tests, and the interesting
 * part is not the feature list — it is that almost every feature exists because
 * something went wrong without it:
 *
 *   - **Activation is keyed by `bookId + entryId`, never by `entryId`.** Two
 *     bound books that both contained `entryId: "0"` silently ate each other.
 *     Character cards routinely export `0,1,2…`, so this was the common case,
 *     not a corner. It was found twice — once within a book, once across books.
 *   - **Unresolved key macros stay literal.** Expanding an unknown macro to the
 *     empty string makes the key match *everything*, which is the loudest
 *     possible failure disguised as the quietest. Literal is the safe direction.
 *   - **An unsafe regular expression is refused, not executed.** A user-authored
 *     key is untrusted input; a catastrophic backtrack is a hung host.
 *   - **A group that activated is skipped in later recursion rounds**, and a
 *     group that lost stops competing in this one. Without it, recursion
 *     re-activates the same entries forever.
 *   - **Probability is re-rolled every round.** Legacy's SPEC calls this out
 *     explicitly, and the alternative — roll once and freeze — makes a recursive
 *     book deterministic in a way authors do not expect.
 *   - **Budget accounting includes the joining newline.** Byte caps that ignore
 *     separators are off by exactly the number of entries, which is the number
 *     that matters.
 *
 * ## The `\W` word-boundary rule
 *
 * Whole-word matching uses `(^|\W)key(\W|$)` rather than `\b`. In JavaScript,
 * `\w` is `[A-Za-z0-9_]`, so a CJK character *is* `\W`: the key `北京` therefore
 * matches inside `我在北京生活`, while `cat` does not match inside `concat`. That
 * is SillyTavern's behaviour and it is what authors expect; `\b` would break
 * every Chinese key.
 *
 * @module dsh-tavern/lorebook
 */

import { compositeKey } from '@dsh-tavern/contracts'
import isSafeRegex from 'safe-regex2'

// ────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ────────────────────────────────────────────────────────────────────────────

/** `0` AND_ANY · `1` NOT_ALL · `2` NOT_ANY · `3` AND_ALL */
export type SecondaryLogic = 0 | 1 | 2 | 3

export const SECONDARY_LOGIC = ['AND_ANY', 'NOT_ALL', 'NOT_ANY', 'AND_ALL'] as const

export interface Entry {
  readonly entryId: string
  readonly keys: readonly string[]
  readonly secondaryKeys: readonly string[]
  readonly content: string
  readonly comment: string
  /** Activate without any key matching. */
  readonly constant: boolean
  /** Whether `secondaryKeys` participate at all. */
  readonly selective: boolean
  readonly selectiveLogic: SecondaryLogic
  readonly order: number
  readonly position: 'before' | 'after'
  readonly probability: number
  readonly useProbability: boolean
  readonly group: string
  readonly groupWeight: number
  /** Within a group, the highest `order` wins outright instead of rolling. */
  readonly groupOverride: boolean
  readonly disable: boolean
  /** Included even when the budget is spent. */
  readonly ignoreBudget: boolean
  /** `null` inherits the book's setting. */
  readonly scanDepth: number | null
  readonly caseSensitive: boolean | null
  readonly matchWholeWords: boolean | null
  readonly excludeRecursion: boolean
  readonly preventRecursion: boolean
}

export interface BookSettings {
  readonly scanDepth: number
  readonly budgetPercent: number
  /** Absolute cap in bytes; `0` means no cap. */
  readonly budgetCap: number
  readonly caseSensitive: boolean
  readonly matchWholeWords: boolean
  readonly recursive: boolean
  readonly maxRecursionSteps: number
  readonly allowRegex: boolean
}

export interface Book {
  readonly bookId: string
  readonly name: string
  readonly enabled: boolean
  readonly entries: readonly Entry[]
  readonly settings: BookSettings
}

export const DEFAULT_SETTINGS: BookSettings = {
  scanDepth: 2,
  budgetPercent: 25,
  budgetCap: 0,
  caseSensitive: false,
  matchWholeWords: false,
  recursive: false,
  maxRecursionSteps: 0,
  allowRegex: true,
}

/** Every reason an entry did or did not activate. Kept exhaustive on purpose. */
export type TraceReason =
  | 'activated'
  | 'constant'
  | 'disabled'
  | 'no-keys'
  | 'key-miss'
  | 'secondary-failed'
  | 'unsafe-regex'
  | 'probability-failed'
  | 'group-lost'
  | 'group-already-activated'
  | 'budget-exceeded'
  | 'empty-body'

export interface TraceRecord {
  readonly bookId: string
  readonly entryId: string
  readonly reason: TraceReason
  /** Which round did this: `0` is the message scan, later rounds are recursion. */
  readonly round: number
  readonly matchedKeys: readonly string[]
  readonly matchedSecondaryKeys: readonly string[]
}

export interface ActivatedEntry {
  readonly bookId: string
  readonly bookName: string
  readonly entryId: string
  readonly content: string
  readonly order: number
  readonly position: 'before' | 'after'
  readonly round: number
}

export interface ScanInput {
  readonly books: readonly Book[]
  /** Messages, newest first — the order the depth window is taken in. */
  readonly messages: readonly string[]
  readonly contextTokens: number
  /**
   * Expands `{{…}}` inside keys. Must be total: a key it does not recognise comes
   * back unchanged, never empty. See `builtinKeyMacros`.
   */
  readonly expandKey?: (key: string) => string
  /** Injected for determinism. */
  readonly random?: () => number
  /** Hard cap on the returned text, in bytes. Whole entries only. */
  readonly maxOutputBytes?: number
  /** Trace every entry, or only the notable ones. */
  readonly traceAll?: boolean
  /**
   * Regular-expression safety gate. Defaults to `safe-regex2`, which is
   * conservative: it may refuse a pattern that would in fact have been fine.
   * Refusing too much is the safe direction — the alternative is a hung host on
   * user-authored input.
   */
  readonly isSafeRegex?: (source: string) => boolean
}

export interface ScanResult {
  readonly text: string
  readonly activated: readonly ActivatedEntry[]
  readonly trace: readonly TraceRecord[]
  /** Total bytes of activated content, before the output cap. */
  readonly activatedBytes: number
  readonly budgetBytes: number
  /** Entries dropped because the budget was spent. */
  readonly budgetExcluded: number
  /** True when the output cap dropped entries from the tail. */
  readonly outputLimited: boolean
  /** How many recursion rounds ran. */
  readonly rounds: number
}

// ────────────────────────────────────────────────────────────────────────────
// Keys
// ────────────────────────────────────────────────────────────────────────────

/**
 * The built-in key macros.
 *
 * `random::a::b` and `pick::a::b` are synonyms because both spellings appear in
 * the wild. `roll:dN` is a die roll.
 *
 * Every unknown macro is left **exactly as written**. Expanding one to `''` is
 * how a key silently becomes the empty string and then matches every message in
 * the room.
 */
export function builtinKeyMacros(options: {
  readonly now?: () => number
  readonly random?: () => number
} = {}): (key: string) => string {
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? Math.random

  return (key: string): string => {
    return key.replace(/\{\{([^{}]*)\}\}/g, (whole, body: string) => {
      const name = body.trim()

      if (name === 'time') {
        const date = new Date(now())
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
      }
      if (name === 'date') {
        const date = new Date(now())
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      }

      const alternatives = /^(?:random|pick)::(.*)$/.exec(name)
      if (alternatives !== null) {
        const options_ = (alternatives[1] ?? '').split('::').filter((part) => part.length > 0)
        if (options_.length === 0) return whole
        return options_[Math.floor(random() * options_.length)] ?? whole
      }

      const roll = /^roll:d(\d+)$/.exec(name)
      if (roll !== null) {
        const sides = Number(roll[1])
        if (Number.isInteger(sides) && sides >= 1) return String(1 + Math.floor(random() * sides))
      }

      // Unknown: literal. Not empty.
      return whole
    })
  }
}

/** Whole-word matcher with the `\W` boundary rule described in the module note. */
function wholeWordPattern(literal: string): RegExp {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|\\W)${escaped}(\\W|$)`)
}

/** Whether one key matches one haystack. */
export interface KeyMatch {
  readonly matched: boolean
  /** Set when the key was refused rather than merely not matching. */
  readonly unsafe: boolean
}

export function matchKey(key: string, haystack: string, options: {
  readonly caseSensitive: boolean
  readonly wholeWords: boolean
  readonly allowRegex: boolean
  readonly isSafeRegex?: (source: string) => boolean
}): KeyMatch {
  if (key.length === 0) return { matched: false, unsafe: false }

  const regex = parseRegexKey(key)
  if (regex !== null) {
    if (!options.allowRegex) return { matched: false, unsafe: false }
    // The gate runs on the *source*, before construction: an unsafe pattern must
    // never reach the engine, because the cost is paid on a hostile backtrack.
    if (options.isSafeRegex !== undefined && !options.isSafeRegex(regex.source)) {
      return { matched: false, unsafe: true }
    }
    try {
      return { matched: new RegExp(regex.source, regex.flags).test(haystack), unsafe: false }
    } catch {
      return { matched: false, unsafe: false }
    }
  }

  if (!options.caseSensitive) {
    const lowered = key.toLowerCase()
    const target = haystack.toLowerCase()
    if (!options.wholeWords) return { matched: target.includes(lowered), unsafe: false }
    return { matched: wholeWordPattern(lowered).test(target), unsafe: false }
  }

  if (!options.wholeWords) return { matched: haystack.includes(key), unsafe: false }
  return { matched: wholeWordPattern(key).test(haystack), unsafe: false }
}

/** `/pattern/flags` → its parts, or `null` when the key is not a regex. */
function parseRegexKey(key: string): { source: string; flags: string } | null {
  if (key.length < 2 || !key.startsWith('/')) return null
  const lastSlash = key.lastIndexOf('/')
  if (lastSlash <= 0) return null
  const flags = key.slice(lastSlash + 1)
  if (!/^[dgimsuvy]*$/.test(flags)) return null
  return { source: key.slice(1, lastSlash), flags }
}

// ────────────────────────────────────────────────────────────────────────────
// The scan
// ────────────────────────────────────────────────────────────────────────────

const SCAN_SEPARATOR = '\n\u0001'

/** A haystack per depth, memoised: most entries share a handful of depths. */
function haystackBuilder(messages: readonly string[]): (depth: number) => string {
  const cache = new Map<number, string>()
  return (depth: number): string => {
    const key = Math.max(0, depth)
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const built = key === 0 ? '' : messages.slice(0, key).join(SCAN_SEPARATOR)
    cache.set(key, built)
    return built
  }
}

function utf8Length(text: string): number {
  // TextEncoder exists in Node and in the browser, so the engine stays runnable
  // on whichever side needs the tester.
  return new TextEncoder().encode(text).length
}

/** The byte budget a scan may spend. Books claim; the largest claim wins. */
export function budgetFor(books: readonly Book[], contextTokens: number): number {
  let claimed = 0
  for (const book of books) {
    if (!book.enabled) continue
    const { budgetPercent, budgetCap } = book.settings
    if (budgetPercent <= 0) continue
    let claim = (budgetPercent / 100) * contextTokens
    if (budgetCap > 0) claim = Math.min(claim, budgetCap)
    claimed = Math.max(claimed, claim)
  }
  return Math.floor(claimed)
}

/**
 * Run the scan.
 *
 * Pure: the same input yields the same output, given the same injected `random`.
 */
export function scan(input: ScanInput): ScanResult {
  const random = input.random ?? Math.random
  const expandKey = input.expandKey ?? builtinKeyMacros({ random })
  const haystackFor = haystackBuilder(input.messages)
  const budgetBytes = budgetFor(input.books, input.contextTokens)

  // Keyed by book + entry, never by entry alone. See the module note.
  const activated = new Map<string, ActivatedEntry>()
  const activatedGroups = new Set<string>()
  const trace: TraceRecord[] = []

  let activatedBytes = 0
  let budgetExcluded = 0
  let rounds = 0

  /** Content fed back as haystack for the next recursion round. */
  let recursionBuffer = ''

  const maxRounds = Math.max(
    0,
    ...input.books.filter((book) => book.enabled).map((book) => book.settings.maxRecursionSteps),
  )

  for (let round = 0; round <= maxRounds; round += 1) {
    if (round > 0 && recursionBuffer === '') break
    rounds = round + 1
    const newlyActivated: ActivatedEntry[] = []
    // Snapshot taken *before* the round: a group that activated in an earlier
    // round is skipped entirely, while siblings within this round still compete
    // and the losers report `group-lost`. Conflating the two made the loser's
    // reason wrong — and the reason is what the tester UI shows the author.
    const groupsBeforeRound = new Set(activatedGroups)

    for (const book of input.books) {
      if (!book.enabled) continue
      const settings = book.settings

      // Process highest `order` first: within an inclusion group the first entry
      // to win is the most important one.
      const entries = [...book.entries].sort((left, right) => right.order - left.order)

      for (const entry of entries) {
        const cacheKey = compositeKey(book.bookId, entry.entryId)

        if (activated.has(cacheKey)) continue
        if (entry.disable) {
          record(trace, input, book, entry, 'disabled', round)
          continue
        }
        if (entry.content.trim() === '') {
          record(trace, input, book, entry, 'empty-body', round)
          continue
        }

        const groupKey = entry.group === '' ? null : compositeKey(book.bookId, entry.group)
        if (groupKey !== null && groupsBeforeRound.has(groupKey)) {
          // The group already produced an entry in an earlier round. Competing
          // again would let recursion pile up siblings of one group forever.
          record(trace, input, book, entry, 'group-already-activated', round)
          continue
        }

        const depth = entry.scanDepth ?? settings.scanDepth
        // Round 0 scans the messages; later rounds scan the same window plus
        // whatever recursion has fed back.
        const scoped = round === 0
          ? haystackFor(depth)
          : `${haystackFor(depth)}${SCAN_SEPARATOR}${recursionBuffer}`

        let matchedKeys: readonly string[] = []
        let unsafe = false

        if (!entry.constant) {
          if (entry.keys.length === 0) {
            record(trace, input, book, entry, 'no-keys', round)
            continue
          }
          const found = matchAny(entry.keys, scoped, entry, settings, expandKey, input)
          matchedKeys = found.matched
          unsafe = found.unsafe
          if (found.matched.length === 0) {
            record(trace, input, book, entry, unsafe ? 'unsafe-regex' : 'key-miss', round, [], [])
            continue
          }
        }

        const secondary = matchSecondary(entry, scoped, settings, expandKey, input)
        if (secondary.unsafe) {
          record(trace, input, book, entry, 'unsafe-regex', round, matchedKeys, [])
          continue
        }
        if (!secondary.ok) {
          record(trace, input, book, entry, 'secondary-failed', round, matchedKeys, secondary.matched)
          continue
        }

        if (entry.useProbability && entry.probability < 100) {
          if (random() * 100 >= Math.max(0, entry.probability)) {
            // Re-rolled on every round by design: a recursive book should get
            // another chance, not a frozen verdict.
            record(trace, input, book, entry, 'probability-failed', round, matchedKeys, secondary.matched)
            continue
          }
        }

        if (groupKey !== null) {
          const winner = chooseGroupWinner(book, entry, entries, scoped, settings, expandKey, input, random)
          if (winner !== entry.entryId) {
            record(trace, input, book, entry, 'group-lost', round, matchedKeys, secondary.matched)
            continue
          }
        }

        const size = utf8Length(entry.content)
        if (!entry.ignoreBudget && budgetBytes > 0 && activatedBytes + size > budgetBytes) {
          budgetExcluded += 1
          record(trace, input, book, entry, 'budget-exceeded', round, matchedKeys, secondary.matched)
          continue
        }

        const activation: ActivatedEntry = {
          bookId: book.bookId,
          bookName: book.name,
          entryId: entry.entryId,
          content: entry.content,
          order: entry.order,
          position: entry.position,
          round,
        }
        activated.set(cacheKey, activation)
        newlyActivated.push(activation)
        activatedBytes += size
        if (groupKey !== null) activatedGroups.add(groupKey)
        record(trace, input, book, entry, entry.constant ? 'constant' : 'activated', round, matchedKeys, secondary.matched)
      }
    }

    if (round < maxRounds) {
      recursionBuffer = newlyActivated
        .filter((activation) => {
          const entry = findEntry(input.books, activation)
          return entry !== undefined && !entry.excludeRecursion && !entry.preventRecursion
        })
        .map((activation) => activation.content)
        .join(SCAN_SEPARATOR)
    }

  }

  const ordered = [...activated.values()].sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order
    if (left.bookId !== right.bookId) return left.bookId < right.bookId ? -1 : 1
    return left.entryId < right.entryId ? -1 : 1
  })

  const cap = input.maxOutputBytes ?? 0
  let outputLimited = false
  let text = ''
  let used = 0
  const kept: ActivatedEntry[] = []
  for (const activation of ordered) {
    const size = utf8Length(activation.content)
    const separator = kept.length === 0 ? 0 : 1
    if (cap > 0 && used + size + separator > cap) {
      outputLimited = true
      continue
    }
    used += size + separator
    kept.push(activation)
  }
  text = kept.map((activation) => activation.content).join('\n')

  return {
    text,
    activated: kept,
    trace,
    activatedBytes,
    budgetBytes,
    budgetExcluded,
    outputLimited,
    rounds,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function findEntry(books: readonly Book[], activation: ActivatedEntry): Entry | undefined {
  const book = books.find((candidate) => candidate.bookId === activation.bookId)
  return book?.entries.find((entry) => entry.entryId === activation.entryId)
}

function record(
  trace: TraceRecord[],
  input: ScanInput,
  book: Book,
  entry: Entry,
  reason: TraceReason,
  round: number,
  matchedKeys: readonly string[] = [],
  matchedSecondaryKeys: readonly string[] = [],
): void {
  const notable = reason !== 'key-miss' && reason !== 'no-keys'
  if (!notable && input.traceAll !== true) return
  trace.push({ bookId: book.bookId, entryId: entry.entryId, reason, round, matchedKeys, matchedSecondaryKeys })
}

function matchAny(
  keys: readonly string[],
  haystack: string,
  entry: Entry,
  settings: BookSettings,
  expandKey: (key: string) => string,
  input: ScanInput,
): { matched: string[]; unsafe: boolean } {
  const matched: string[] = []
  let unsafe = false
  for (const raw of keys) {
    const key = expandKey(raw)
    const result = matchKey(key, haystack, {
      caseSensitive: entry.caseSensitive ?? settings.caseSensitive,
      wholeWords: entry.matchWholeWords ?? settings.matchWholeWords,
      allowRegex: settings.allowRegex,
      isSafeRegex: input.isSafeRegex ?? isSafeRegex,
    })
    if (result.unsafe) unsafe = true
    if (result.matched) matched.push(raw)
  }
  return { matched, unsafe }
}

function matchSecondary(
  entry: Entry,
  haystack: string,
  settings: BookSettings,
  expandKey: (key: string) => string,
  input: ScanInput,
): { ok: boolean; matched: string[]; unsafe: boolean } {
  if (!entry.selective || entry.secondaryKeys.length === 0) {
    return { ok: true, matched: [], unsafe: false }
  }

  const matched: string[] = []
  let unsafe = false
  for (const raw of entry.secondaryKeys) {
    const key = expandKey(raw)
    const result = matchKey(key, haystack, {
      caseSensitive: entry.caseSensitive ?? settings.caseSensitive,
      wholeWords: entry.matchWholeWords ?? settings.matchWholeWords,
      allowRegex: settings.allowRegex,
      isSafeRegex: input.isSafeRegex ?? isSafeRegex,
    })
    if (result.unsafe) unsafe = true
    if (result.matched) matched.push(raw)
  }

  const hits = matched.length
  const total = entry.secondaryKeys.length

  switch (entry.selectiveLogic) {
    case 0: // AND_ANY — at least one
      return { ok: hits >= 1, matched, unsafe }
    case 1: // NOT_ALL — not every one
      return { ok: hits < total, matched, unsafe }
    case 2: // NOT_ANY — none
      return { ok: hits === 0, matched, unsafe }
    case 3: // AND_ALL — every one
      return { ok: hits === total, matched, unsafe }
    default:
      return { ok: true, matched, unsafe }
  }
}

/**
 * Which entry of an inclusion group wins this round.
 *
 * `groupOverride` entries win by `order` (highest first). Otherwise the winner
 * is drawn with probability proportional to `groupWeight`. Entries that would
 * not activate at all are not candidates — a group must not be won by something
 * whose own keys did not match.
 */
function chooseGroupWinner(
  book: Book,
  entry: Entry,
  entries: readonly Entry[],
  haystack: string,
  settings: BookSettings,
  expandKey: (key: string) => string,
  input: ScanInput,
  random: () => number,
): string {
  const siblings = entries.filter((candidate) => {
    if (candidate.group !== entry.group || candidate.disable) return false
    if (candidate.content.trim() === '') return false
    if (candidate.constant) return true
    if (candidate.keys.length === 0) return false
    const keys = matchAny(candidate.keys, haystack, candidate, settings, expandKey, input)
    if (keys.matched.length === 0) return false
    const secondary = matchSecondary(candidate, haystack, settings, expandKey, input)
    return secondary.ok
  })

  if (siblings.length <= 1) return entry.entryId

  const overrides = siblings.filter((candidate) => candidate.groupOverride)
  if (overrides.length > 0) {
    const top = overrides.reduce((best, candidate) => (candidate.order > best.order ? candidate : best))
    return top.entryId
  }

  const total = siblings.reduce((sum, candidate) => sum + Math.max(1, candidate.groupWeight), 0)
  let roll = random() * total
  for (const candidate of siblings) {
    roll -= Math.max(1, candidate.groupWeight)
    if (roll < 0) return candidate.entryId
  }
  return siblings[siblings.length - 1]?.entryId ?? entry.entryId
}
