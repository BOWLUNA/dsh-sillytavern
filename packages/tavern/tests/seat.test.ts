/**
 * The seat: which books apply, and what the prompt renderer is allowed to see.
 *
 * `seatText` is the whole decision. It is a plain function over plain data, so
 * it is tested directly — no host, no agent, no model — and `mount` on the
 * service is reduced to registering it. The platform-touching edge is one line;
 * everything that can be wrong in an interesting way is behind this boundary.
 *
 * Run: node --test tests/seat.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_SETTINGS } from '../src/lorebook.ts'
import type { Entry } from '../src/lorebook.ts'
import { parseBookCreate, parseBookPatch, parseEntry } from '../src/schema.ts'
import type { BookRecord, EntryRecord } from '../src/schema.ts'
import { seatKeyMacros, seatText, toEngineBook } from '../src/seat.ts'

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

let counter = 0

/** A valid, fully-defaulted entry. */
function entry(overrides: Partial<Entry> = {}): EntryRecord {
  counter += 1
  return parseEntry({ entryId: `e-${counter}`, keys: ['sword'], content: 'A dull blade.', ...overrides })
}

/** A raw entry, for the cases that must be *rejected* rather than parsed. */
function rawEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  counter += 1
  return { entryId: `e-${counter}`, keys: ['sword'], content: 'A dull blade.', ...overrides }
}

function book(overrides: {
  bookId?: string
  name?: string
  enabled?: boolean
  entries?: readonly EntryRecord[]
  revision?: number
  createdAt?: number
} = {}): BookRecord {
  const input = parseBookCreate({
    name: overrides.name ?? 'Test Book',
    enabled: overrides.enabled ?? true,
    ...(overrides.entries === undefined ? { entries: [entry()] } : { entries: overrides.entries }),
  })
  return {
    bookId: overrides.bookId ?? `book-${++counter}`,
    owner: 'tavern',
    name: input.name,
    enabled: input.enabled,
    entries: [...input.entries],
    settings: input.settings,
    revision: overrides.revision ?? 0,
    createdAt: overrides.createdAt ?? 1,
  }
}

function seat(books: readonly BookRecord[], boundBookIds: readonly string[], macros = {}) {
  return seatText(
    { books, boundBookIds, macros, contextTokens: 64_000, random: () => 0 },
    ['I drew my sword.'],
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Which books apply
// ────────────────────────────────────────────────────────────────────────────

test('a bound book contributes its matching entries', () => {
  const b = book()
  assert.match(seat([b], [b.bookId]), /A dull blade\./)
})

test('an unbound book contributes nothing', () => {
  const b = book()
  assert.equal(seat([b], []), '')
  assert.equal(seat([b], ['some-other-book']), '')
})

test('a disabled book contributes nothing even when bound', () => {
  // "Disabled" has to mean disabled. A book that still injects while switched
  // off is worse than one that never worked, because nobody looks for it.
  const b = book({ enabled: false })
  assert.equal(seat([b], [b.bookId]), '')
})

test('binding two books concatenates in order precedence, not binding order', () => {
  const early = book({ entries: [entry({ entryId: 'x', keys: ['sword'], order: 10, content: 'early' })] })
  const late = book({ entries: [entry({ entryId: 'y', keys: ['sword'], order: 90, content: 'late' })] })
  assert.equal(seat([late, early], [late.bookId, early.bookId]), 'early\nlate')
})

test('an empty book set short-circuits without scanning', () => {
  assert.equal(seat([], []), '')
})

// ────────────────────────────────────────────────────────────────────────────
// The prompt guarantee, at the seat
// ────────────────────────────────────────────────────────────────────────────

test('entry content containing a macro cannot reach the renderer as one', () => {
  // The link between the engine and the prompt guarantee: entry content is
  // user-authored, and an unregistered `{{char}}` in a prompt context makes
  // every request fail. The browser half shows the value; the renderer never
  // sees the syntax.
  const b = book({
    entries: [entry({ keys: ['sword'], content: 'Forged for {{char}}, who is {{unknown}}.' })],
  })

  const withMacros = seat([b], [b.bookId], { char: '甲' })
  assert.equal(withMacros.includes('{{'), false)
  assert.match(withMacros, /Forged for 甲/)
  assert.match(withMacros, /〔unknown〕/)

  const withoutMacros = seat([b], [b.bookId])
  assert.equal(withoutMacros.includes('{{'), false)
  assert.match(withoutMacros, /〔char〕/)
})

test('a malformed macro in content does not survive either', () => {
  const b = book({ entries: [entry({ keys: ['sword'], content: '{{ char }} and {{' })] })
  const text = seat([b], [b.bookId], { char: '甲' })
  assert.equal(text.includes('{{'), false)
})

// ────────────────────────────────────────────────────────────────────────────
// Key macros
// ────────────────────────────────────────────────────────────────────────────

test('consumer macros win over built-ins of the same name', () => {
  const expand = seatKeyMacros({ time: 'now' }, () => 0.5)
  assert.equal(expand('{{time}}'), 'now')
})

test('an unknown key macro stays literal, so it cannot match everything', () => {
  const expand = seatKeyMacros({}, () => 0.5)
  assert.equal(expand('{{nope}}'), '{{nope}}')
})

test('a consumer macro can make a key match that otherwise would not', () => {
  const b = book({ entries: [entry({ keys: ['{{char}}'], content: 'named' })] })
  const messages = ['甲 spoke.']

  const without = seatText(
    { books: [b], boundBookIds: [b.bookId], macros: {}, contextTokens: 64_000, random: () => 0 },
    messages,
  )
  assert.equal(without, '', 'the literal {{char}} does not match')

  const withChar = seatText(
    { books: [b], boundBookIds: [b.bookId], macros: { char: '甲' }, contextTokens: 64_000, random: () => 0 },
    messages,
  )
  assert.match(withChar, /named/)
})

// ────────────────────────────────────────────────────────────────────────────
// toEngineBook
// ────────────────────────────────────────────────────────────────────────────

test('a stored book maps to the engine shape without losing settings', () => {
  const b = book({ entries: [entry({ keys: ['a'], order: 7 })] })
  const engine = toEngineBook(b)
  assert.equal(engine.bookId, b.bookId)
  assert.equal(engine.enabled, true)
  assert.equal(engine.entries[0]?.order, 7)
  assert.deepEqual(engine.settings, b.settings)
})

// ────────────────────────────────────────────────────────────────────────────
// Book validation — the same schema guards the wire and the record
// ────────────────────────────────────────────────────────────────────────────

test('a minimal book create fills the entry and settings defaults', () => {
  const parsed = parseBookCreate({ name: 'B' })
  assert.equal(parsed.name, 'B')
  assert.equal(parsed.enabled, true)
  assert.deepEqual(parsed.entries, [])
  assert.equal(parsed.settings?.scanDepth, DEFAULT_SETTINGS.scanDepth)
})

test('a book create needs a non-empty name', () => {
  for (const bad of [{}, { name: '' }, { name: '   ' }, { name: 7 }]) {
    assert.throws(() => parseBookCreate(bad), /name/, `expected a rejection for ${JSON.stringify(bad)}`)
  }
})

test('a book create rejects a non-object', () => {
  for (const bad of [null, 'book', 42, []]) {
    assert.throws(() => parseBookCreate(bad), /book/, `expected a rejection for ${JSON.stringify(bad)}`)
  }
})

test('an out-of-range selectiveLogic is rejected rather than defaulted', () => {
  // A four-value union, not a number: silently defaulting a mode is how an
  // author's `AND_ALL` becomes `AND_ANY` without anyone noticing.
  assert.throws(
    () => parseBookCreate({ name: 'B', entries: [rawEntry({ selectiveLogic: 7 })] }),
    /selectiveLogic/,
  )
  assert.throws(
    () => parseBookCreate({ name: 'B', entries: [rawEntry({ selectiveLogic: 'AND_ALL' })] }),
    /selectiveLogic/,
  )
})

test('an oversized entry is rejected, not truncated', () => {
  assert.throws(
    () => parseBookCreate({ name: 'B', entries: [rawEntry({ content: 'x'.repeat(256 * 1024 + 1) })] }),
    /content/,
  )
})

test('an entry missing its id is rejected, and the field is named', () => {
  assert.throws(() => parseBookCreate({ name: 'B', entries: [{ keys: ['a'] }] }), /entries\.0\.entryId/)
})

test('the rejection names the offending field path', () => {
  // The message is what the UI shows. "book.entries.0.order: ..." is actionable;
  // "invalid input" is not.
  try {
    parseBookCreate({ name: 'B', entries: [rawEntry({ order: 999_999 })] })
    assert.fail('expected a rejection')
  } catch (error) {
    assert.match(String(error), /entries\.0\.order/)
  }
})

test('a patch accepts partial fields and an optional baseRevision', () => {
  assert.deepEqual(parseBookPatch({ name: 'renamed' }), { name: 'renamed' })
  assert.deepEqual(parseBookPatch({ baseRevision: 3 }), { baseRevision: 3 })
  assert.deepEqual(parseBookPatch({}), {})
})

test('a patch rejects a bad field rather than ignoring it', () => {
  assert.throws(() => parseBookPatch({ name: '' }), /name/)
  assert.throws(() => parseBookPatch({ enabled: 'yes' }), /enabled/)
  assert.throws(() => parseBookPatch({ baseRevision: -1 }), /baseRevision/)
})
