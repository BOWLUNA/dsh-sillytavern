/**
 * The world-info engine's semantics, one test per bug that shipped.
 *
 * The legacy engine's feature list reads like a specification. It is not: almost
 * every rule exists because something went wrong without it, and those are the
 * cases below.
 *
 * Run: node --test tests/lorebook.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_SETTINGS,
  budgetFor,
  builtinKeyMacros,
  matchKey,
  scan,
} from '../src/lorebook.ts'
import type { Book, Entry, ScanResult } from '../src/lorebook.ts'

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

function entry(overrides: Partial<Entry> & { entryId: string }): Entry {
  return {
    keys: [],
    secondaryKeys: [],
    content: `content-${overrides.entryId}`,
    comment: '',
    constant: false,
    selective: false,
    selectiveLogic: 0,
    order: 100,
    position: 'before',
    probability: 100,
    useProbability: false,
    group: '',
    groupWeight: 100,
    groupOverride: false,
    disable: false,
    ignoreBudget: false,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    excludeRecursion: false,
    preventRecursion: false,
    ...overrides,
  }
}

function book(overrides: Partial<Book> & { bookId: string; entries: readonly Entry[] }): Book {
  return {
    name: overrides.bookId,
    enabled: true,
    settings: DEFAULT_SETTINGS,
    ...overrides,
  }
}

/** A deterministic `random` that replays a script, then returns 0. */
function scripted(values: readonly number[]): () => number {
  let index = 0
  return () => values[index++] ?? 0
}

function reasons(result: ScanResult): string[] {
  return result.trace.map((record) => `${record.entryId}:${record.reason}`)
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Cross-book entry ids must not collide
// ────────────────────────────────────────────────────────────────────────────

test('two books may both contain entryId "0" without eating each other', () => {
  // Character cards routinely export ids `0,1,2…`, so two bound books both
  // holding "0" is the common case. Keying activation by the bare entry id made
  // one silently replace the other; it was found twice, once within a book and
  // once across books.
  const result = scan({
    books: [
      book({ bookId: 'book-a', entries: [entry({ entryId: '0', constant: true, content: 'from A' })] }),
      book({ bookId: 'book-b', entries: [entry({ entryId: '0', constant: true, content: 'from B' })] }),
    ],
    messages: ['hello'],
    contextTokens: 1000,
  })

  assert.equal(result.activated.length, 2)
  assert.deepEqual(result.activated.map((a) => a.content), ['from A', 'from B'])
})

test('two entries with the same id inside one book are also distinct', () => {
  // The within-a-book half of the same bug.
  const result = scan({
    books: [book({
      bookId: 'book-a',
      entries: [
        entry({ entryId: 'shared', constant: true, content: 'first' }),
        entry({ entryId: 'shared', constant: true, content: 'second' }),
      ],
    })],
    messages: ['x'],
    contextTokens: 1000,
  })
  // Same composite key, so the second is treated as already activated — it does
  // not overwrite the first, which is the failure the legacy project had.
  assert.equal(result.activated.length, 1)
  assert.equal(result.activated[0]?.content, 'first')
})

// ────────────────────────────────────────────────────────────────────────────
// 2. Key macros never expand to nothing
// ────────────────────────────────────────────────────────────────────────────

test('an unknown key macro stays literal instead of becoming empty', () => {
  // Expanding to '' makes the key match every message in the room — the loudest
  // failure disguised as the quietest.
  const expand = builtinKeyMacros({ random: () => 0 })
  assert.equal(expand('{{unknown}}'), '{{unknown}}')
  assert.equal(expand('{ {not a macro} }'), '{ {not a macro} }')
  assert.equal(expand('roll:d6'), 'roll:d6')
})

test('a literal unknown macro does not match ordinary text', () => {
  const result = scan({
    books: [book({ bookId: 'b', entries: [entry({ entryId: 'e', keys: ['{{unknown}}'] })] })],
    messages: ['anything at all'],
    contextTokens: 1000,
    isSafeRegex: () => true,
  })
  assert.equal(result.activated.length, 0)
})

test('the built-in key macros expand, and random:: picks from its list', () => {
  const expand = builtinKeyMacros({ now: () => new Date(2026, 8, 17, 9, 5).getTime(), random: () => 0.5 })
  assert.equal(expand('{{time}}'), '09:05')
  assert.equal(expand('{{date}}'), '2026-09-17')
  assert.equal(expand('{{roll:d6}}'), '4')
  assert.equal(expand('{{random::cat::dog}}'), 'dog')
  assert.equal(expand('{{pick::a::b::c}}'), 'b')
})

test('an empty random list is left alone rather than collapsing', () => {
  const expand = builtinKeyMacros({ random: () => 0 })
  assert.equal(expand('{{random::}}'), '{{random::}}')
})

// ────────────────────────────────────────────────────────────────────────────
// 3. Unsafe regular expressions are refused, not executed
// ────────────────────────────────────────────────────────────────────────────

test('a catastrophic pattern is refused with a reason', () => {
  const result = scan({
    books: [book({ bookId: 'b', entries: [entry({ entryId: 'evil', keys: ['/(a+)+$/'] })] })],
    messages: [`${'a'.repeat(40)}b`],
    contextTokens: 1000,
  })
  assert.equal(result.activated.length, 0)
  assert.deepEqual(reasons(result), ['evil:unsafe-regex'])
})

test('the safety gate is pluggable so a refusal can be observed deterministically', () => {
  const result = scan({
    books: [book({ bookId: 'b', entries: [entry({ entryId: 'e', keys: ['/cat/'] })] })],
    messages: ['a cat'],
    contextTokens: 1000,
    isSafeRegex: () => false,
  })
  assert.deepEqual(reasons(result), ['e:unsafe-regex'])
})

test('allowRegex off recognises a regex key but does not run it', () => {
  const result = scan({
    books: [book({
      bookId: 'b',
      settings: { ...DEFAULT_SETTINGS, allowRegex: false },
      entries: [entry({ entryId: 'e', keys: ['/cat/'] })],
    })],
    messages: ['a cat'],
    contextTokens: 1000,
  })
  assert.equal(result.activated.length, 0)
})

// ────────────────────────────────────────────────────────────────────────────
// 4. Whole-word matching keeps Chinese working
// ────────────────────────────────────────────────────────────────────────────

test('a CJK key matches inside a CJK sentence', () => {
  // `\b` would break every Chinese key, because JS `\w` is [A-Za-z0-9_]: a CJK
  // character counts as a boundary. The `\W` rule is what authors expect.
  const result = scan({
    books: [book({
      bookId: 'b',
      settings: { ...DEFAULT_SETTINGS, matchWholeWords: true },
      entries: [entry({ entryId: 'e', keys: ['北京'] })],
    })],
    messages: ['我在北京生活'],
    contextTokens: 1000,
  })
  assert.equal(result.activated.length, 1)
})

test('an ASCII whole word does not match inside a longer word', () => {
  const options = { caseSensitive: false, wholeWords: true, allowRegex: false }
  assert.equal(matchKey('cat', 'concat', options).matched, false)
  assert.equal(matchKey('cat', 'a cat sat', options).matched, true)
})

test('case sensitivity follows the entry, then the book', () => {
  const insensitive = scan({
    books: [book({ bookId: 'b', entries: [entry({ entryId: 'e', keys: ['Cat'] })] })],
    messages: ['a cat'],
    contextTokens: 1000,
  })
  assert.equal(insensitive.activated.length, 1)

  const sensitive = scan({
    books: [book({
      bookId: 'b',
      entries: [entry({ entryId: 'e', keys: ['Cat'], caseSensitive: true })],
    })],
    messages: ['a cat'],
    contextTokens: 1000,
  })
  assert.equal(sensitive.activated.length, 0)
})

// ────────────────────────────────────────────────────────────────────────────
// 5. Scan depth
// ────────────────────────────────────────────────────────────────────────────

test('an entry-level scanDepth overrides the book setting', () => {
  const books = [book({
    bookId: 'b',
    settings: { ...DEFAULT_SETTINGS, scanDepth: 1 },
    entries: [
      entry({ entryId: 'shallow', keys: ['old'] }),
      entry({ entryId: 'deep', keys: ['old'], scanDepth: 3 }),
    ],
  })]
  // Newest first: the keyword only appears in the third message back.
  const messages = ['newest', 'second', 'the old one']
  const result = scan({ books, messages, contextTokens: 1000 })
  assert.deepEqual(result.activated.map((a) => a.entryId), ['deep'])
})

test('scanDepth 0 scans nothing and only recursion can activate the entry', () => {
  const result = scan({
    books: [book({
      bookId: 'b',
      entries: [entry({ entryId: 'e', keys: ['x'], scanDepth: 0 })],
    })],
    messages: ['x'],
    contextTokens: 1000,
  })
  assert.equal(result.activated.length, 0)
})

// ────────────────────────────────────────────────────────────────────────────
// 6. Secondary keys
// ────────────────────────────────────────────────────────────────────────────

test('the four secondary logic modes behave as named', () => {
  const run = (logic: 0 | 1 | 2 | 3, text: string): boolean => {
    const result = scan({
      books: [book({
        bookId: 'b',
        entries: [entry({
          entryId: 'e',
          // Deliberately non-overlapping tokens: `a` would be a substring of
          // `main` under substring matching, which is a fixture bug rather than
          // an engine one.
          keys: ['zzz'],
          selective: true,
          selectiveLogic: logic,
          secondaryKeys: ['aaa', 'bbb'],
        })],
      })],
      messages: [text],
      contextTokens: 1000,
    })
    return result.activated.length === 1
  }

  const both = 'zzz aaa bbb'
  const one = 'zzz aaa'
  const none = 'zzz'

  assert.equal(run(0, one), true, 'AND_ANY needs at least one')
  assert.equal(run(0, none), false)

  assert.equal(run(1, one), true, 'NOT_ALL needs at least one missing')
  assert.equal(run(1, both), false)

  assert.equal(run(2, none), true, 'NOT_ANY needs none')
  assert.equal(run(2, one), false)

  assert.equal(run(3, both), true, 'AND_ALL needs all')
  assert.equal(run(3, one), false)
})

test('selective off ignores the secondary keys entirely', () => {
  const result = scan({
    books: [book({
      bookId: 'b',
      entries: [entry({ entryId: 'e', keys: ['main'], selective: false, secondaryKeys: ['never-present'] })],
    })],
    messages: ['main'],
    contextTokens: 1000,
  })
  assert.equal(result.activated.length, 1)
})

// ────────────────────────────────────────────────────────────────────────────
// 7. Inclusion groups
// ────────────────────────────────────────────────────────────────────────────

test('groupOverride picks the highest order, not a random sibling', () => {
  const result = scan({
    books: [book({
      bookId: 'b',
      entries: [
        entry({ entryId: 'low', keys: ['x'], group: 'g', order: 1, groupOverride: true }),
        entry({ entryId: 'high', keys: ['x'], group: 'g', order: 9, groupOverride: true }),
      ],
    })],
    messages: ['x'],
    contextTokens: 1000,
    random: () => 0.99,
  })
  assert.deepEqual(result.activated.map((a) => a.entryId), ['high'])
  assert.ok(reasons(result).includes('low:group-lost'))
})

test('without groupOverride, a single sibling always wins', () => {
  const result = scan({
    books: [book({
      bookId: 'b',
      entries: [
        entry({ entryId: 'only', keys: ['x'], group: 'g' }),
      ],
    })],
    messages: ['x'],
    contextTokens: 1000,
  })
  assert.deepEqual(result.activated.map((a) => a.entryId), ['only'])
})

test('groups are scoped per book, so the same group name in two books is two groups', () => {
  const result = scan({
    books: [
      book({ bookId: 'a', entries: [entry({ entryId: 'e', keys: ['x'], group: 'g', constant: false })] }),
      book({ bookId: 'b', entries: [entry({ entryId: 'e', keys: ['x'], group: 'g', constant: false })] }),
    ],
    messages: ['x'],
    contextTokens: 1000,
  })
  assert.equal(result.activated.length, 2, 'each book has its own group')
})

test('a group that already activated is skipped in later recursion rounds', () => {
  // Without this, recursion re-activates siblings of the same group forever.
  const result = scan({
    books: [book({
      bookId: 'b',
      settings: { ...DEFAULT_SETTINGS, recursive: true, maxRecursionSteps: 5 },
      entries: [
        entry({ entryId: 'seeder', keys: ['x'], content: 'seed text' }),
        entry({ entryId: 'sibling', keys: ['seed'], group: 'g' }),
      ],
    })],
    messages: ['x'],
    contextTokens: 100_000,
  })
  // `sibling` needs the word "seed", which only exists in the activated content,
  // so it can only come from recursion — and it must appear at most once.
  assert.equal(result.activated.filter((a) => a.entryId === 'sibling').length, 1)
})

// ────────────────────────────────────────────────────────────────────────────
// 8. Recursion and probability
// ────────────────────────────────────────────────────────────────────────────

test('recursion runs the configured number of rounds and picks up new keywords', () => {
  const result = scan({
    books: [book({
      bookId: 'b',
      settings: { ...DEFAULT_SETTINGS, recursive: true, maxRecursionSteps: 3 },
      entries: [
        entry({ entryId: 'first', keys: ['alpha'], content: 'bravo' }),
        entry({ entryId: 'second', keys: ['bravo'], content: 'charlie' }),
        entry({ entryId: 'third', keys: ['charlie'], content: 'delta' }),
      ],
    })],
    messages: ['alpha'],
    contextTokens: 100_000,
  })
  assert.deepEqual(result.activated.map((a) => a.entryId).sort(), ['first', 'second', 'third'])
})

test('probability is re-rolled on every recursion round', () => {
  // Roll once and freeze makes a recursive book deterministic in a way authors
  // do not expect; the SPEC is explicit that it re-rolls.
  const result = scan({
    books: [book({
      bookId: 'b',
      settings: { ...DEFAULT_SETTINGS, recursive: true, maxRecursionSteps: 2 },
      entries: [
        // Highest order, so it rolls before `keeper` in each round.
        entry({ entryId: 'seed', keys: ['alpha'], content: 'bravo', order: 300 }),
        entry({ entryId: 'lucky', keys: ['bravo'], order: 200, useProbability: true, probability: 50 }),
        // Always activates on `bravo` and carries `bravo` forward, which keeps
        // the keyword in the recursion buffer for the *next* round. The buffer
        // is rebuilt from each round's newly activated entries only, so without
        // this `lucky` would never get a second roll to take.
        entry({ entryId: 'keeper', keys: ['bravo'], order: 100, content: 'charlie bravo' }),
      ],
    })],
    messages: ['alpha'],
    contextTokens: 100_000,
    // Round 0 rolls 90 (fails at 50%), round 1 rolls 10 (passes).
    random: scripted([0.9, 0.1]),
  })
  assert.ok(result.activated.some((a) => a.entryId === 'lucky'), 'the second roll must count')
})

test('an entry excluded from recursion does not feed the buffer back', () => {
  const result = scan({
    books: [book({
      bookId: 'b',
      settings: { ...DEFAULT_SETTINGS, recursive: true, maxRecursionSteps: 3 },
      entries: [
        entry({ entryId: 'seed', keys: ['alpha'], content: 'bravo', excludeRecursion: true }),
        entry({ entryId: 'downstream', keys: ['bravo'] }),
      ],
    })],
    messages: ['alpha'],
    contextTokens: 100_000,
  })
  assert.deepEqual(result.activated.map((a) => a.entryId), ['seed'])
})

// ────────────────────────────────────────────────────────────────────────────
// 9. Budget and output cap
// ────────────────────────────────────────────────────────────────────────────

test('the budget is the largest claim any enabled book makes', () => {
  const small = book({ bookId: 'a', entries: [], settings: { ...DEFAULT_SETTINGS, budgetPercent: 10 } })
  const large = book({ bookId: 'b', entries: [], settings: { ...DEFAULT_SETTINGS, budgetPercent: 50 } })
  assert.equal(budgetFor([small, large], 1000), 500)

  const disabled = book({ bookId: 'c', entries: [], enabled: false, settings: { ...DEFAULT_SETTINGS, budgetPercent: 90 } })
  assert.equal(budgetFor([small, disabled], 1000), 100, 'a disabled book claims nothing')
})

test('an absolute budgetCap clamps the percentage claim', () => {
  const capped = book({ bookId: 'a', entries: [], settings: { ...DEFAULT_SETTINGS, budgetPercent: 50, budgetCap: 120 } })
  assert.equal(budgetFor([capped], 10_000), 120)
})

test('an entry over the budget is excluded, and ignoreBudget bypasses it', () => {
  const big = 'x'.repeat(400)
  const result = scan({
    books: [book({
      bookId: 'b',
      settings: { ...DEFAULT_SETTINGS, budgetPercent: 10, budgetCap: 0 },
      entries: [
        entry({ entryId: 'normal', keys: ['k'], content: big }),
        entry({ entryId: 'exempt', keys: ['k'], content: big, ignoreBudget: true }),
      ],
    })],
    messages: ['k'],
    // 10% of 1000 = 100 bytes, less than one 400-byte entry.
    contextTokens: 1000,
  })
  assert.deepEqual(result.activated.map((a) => a.entryId), ['exempt'])
  assert.equal(result.budgetExcluded, 1)
  assert.ok(reasons(result).includes('normal:budget-exceeded'))
})

test('the output cap keeps whole entries and reports that it truncated', () => {
  const result = scan({
    books: [book({
      bookId: 'b',
      settings: { ...DEFAULT_SETTINGS, budgetPercent: 0 },
      entries: [
        entry({ entryId: 'a', keys: ['k'], order: 1, content: 'aaaa' }),
        entry({ entryId: 'b', keys: ['k'], order: 2, content: 'bbbb' }),
      ],
    })],
    messages: ['k'],
    contextTokens: 1000,
    maxOutputBytes: 6,
  })
  assert.equal(result.outputLimited, true)
  assert.deepEqual(result.activated.map((a) => a.entryId), ['a'], 'a whole entry, never a partial one')
})

// ────────────────────────────────────────────────────────────────────────────
// 10. Ordering and simple reasons
// ────────────────────────────────────────────────────────────────────────────

test('output is ordered ascending by order regardless of processing order', () => {
  const result = scan({
    books: [book({
      bookId: 'b',
      entries: [
        entry({ entryId: 'late', keys: ['k'], order: 90, content: 'late' }),
        entry({ entryId: 'early', keys: ['k'], order: 10, content: 'early' }),
      ],
    })],
    messages: ['k'],
    contextTokens: 1000,
  })
  assert.deepEqual(result.activated.map((a) => a.entryId), ['early', 'late'])
  assert.equal(result.text, 'early\nlate')
})

test('a constant entry needs no keys and reports itself as constant', () => {
  const result = scan({
    books: [book({ bookId: 'b', entries: [entry({ entryId: 'c', constant: true })] })],
    messages: [],
    contextTokens: 1000,
  })
  assert.deepEqual(reasons(result), ['c:constant'])
})

test('disabled and empty entries are reported, not silently dropped', () => {
  const result = scan({
    books: [book({
      bookId: 'b',
      entries: [
        entry({ entryId: 'off', constant: true, disable: true }),
        entry({ entryId: 'blank', constant: true, content: '   ' }),
      ],
    })],
    messages: [],
    contextTokens: 1000,
  })
  assert.deepEqual(reasons(result).sort(), ['blank:empty-body', 'off:disabled'])
})

test('an entry with no keys is refused rather than treated as constant', () => {
  const result = scan({
    books: [book({ bookId: 'b', entries: [entry({ entryId: 'k' })] })],
    messages: ['anything'],
    contextTokens: 1000,
  })
  assert.equal(result.activated.length, 0)
  assert.ok(!reasons(result).includes('k:activated'))
})

test('a disabled book contributes nothing', () => {
  const result = scan({
    books: [book({ bookId: 'b', enabled: false, entries: [entry({ entryId: 'e', constant: true })] })],
    messages: [],
    contextTokens: 1000,
  })
  assert.equal(result.activated.length, 0)
  assert.equal(result.trace.length, 0)
})

test('traceAll records the misses too, for the tester', () => {
  const books = [book({ bookId: 'b', entries: [entry({ entryId: 'e', keys: ['absent'] })] })]
  const quiet = scan({ books, messages: ['x'], contextTokens: 1000 })
  const loud = scan({ books, messages: ['x'], contextTokens: 1000, traceAll: true })
  assert.equal(quiet.trace.length, 0)
  assert.deepEqual(reasons(loud), ['e:key-miss'])
})

// ────────────────────────────────────────────────────────────────────────────
// 11. Determinism
// ────────────────────────────────────────────────────────────────────────────

test('the same input yields the same output', () => {
  const books = [book({
    bookId: 'b',
    entries: [
      entry({ entryId: 'a', keys: ['k'], order: 2 }),
      entry({ entryId: 'b', keys: ['k'], order: 1 }),
      entry({ entryId: 'c', constant: true, order: 3 }),
    ],
  })]
  const first = scan({ books, messages: ['k'], contextTokens: 10_000, random: scripted([0.1, 0.2]) })
  const second = scan({ books, messages: ['k'], contextTokens: 10_000, random: scripted([0.1, 0.2]) })
  assert.deepEqual(first.activated, second.activated)
  assert.deepEqual(first.trace, second.trace)
})

test('the scan does not mutate its input', () => {
  const books = [book({
    bookId: 'b',
    entries: [entry({ entryId: 'a', keys: ['k'], order: 1 }), entry({ entryId: 'z', keys: ['k'], order: 9 })],
  })]
  const snapshot = JSON.stringify(books)
  scan({ books, messages: ['k'], contextTokens: 1000 })
  assert.equal(JSON.stringify(books), snapshot)
})
