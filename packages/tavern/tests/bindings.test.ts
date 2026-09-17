/**
 * The ownership invariant, pinned.
 *
 * The single most important assertion in this repository is the first one
 * below: one owner's write must not be able to drop another owner's books. That
 * exact failure shipped twice in the legacy project, in both directions, and
 * each time it silently deleted a human's manual bindings.
 *
 * Run: node --test tests/bindings.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Owner, isReject } from '@dsh-tavern/contracts'
import {
  addBook,
  bookIdsForTargets,
  bindingKey,
  boundTargets,
  dropOwnerRows,
  removeBook,
  resolveBooks,
  rowOf,
  setBooks,
} from '../src/bindings.ts'
import type { BindingRow } from '../src/bindings.ts'

const T0 = 1_700_000_000_000

/** A table where a human and the group lifecycle both bound books to one room. */
function mixedTable(): readonly BindingRow[] {
  let rows: readonly BindingRow[] = []
  rows = setBooks(rows, Owner.User, 'room-1', ['book-manual'], T0)
  rows = addBook(rows, Owner.GroupChat, 'room-1', 'book-lifecycle', T0 + 1)
  return rows
}

// ────────────────────────────────────────────────────────────────────────────
// The invariant.
// ────────────────────────────────────────────────────────────────────────────

test("one owner's whole-row write cannot drop another owner's books", () => {
  const before = mixedTable()
  assert.deepEqual(resolveBooks(before, 'room-1'), ['book-manual', 'book-lifecycle'])

  // A stale snapshot of *the user's own row* is saved back. In the legacy
  // project the snapshot covered the whole table, so this is where the
  // lifecycle's book disappeared.
  const after = setBooks(before, Owner.User, 'room-1', ['book-manual-edited'], T0 + 2)

  assert.deepEqual(resolveBooks(after, 'room-1'), ['book-manual-edited', 'book-lifecycle'])
  assert.deepEqual(rowOf(after, Owner.GroupChat, 'room-1')?.bookIds, ['book-lifecycle'])
})

test("the lifecycle stopping cannot drop the human's books", () => {
  const before = mixedTable()
  const after = removeBook(before, Owner.GroupChat, 'room-1', 'book-lifecycle')
  assert.deepEqual(resolveBooks(after, 'room-1'), ['book-manual'])
})

test('owners are isolated in the key as well as the operations', () => {
  assert.notEqual(bindingKey(Owner.User, 'room-1'), bindingKey(Owner.GroupChat, 'room-1'))
  assert.notEqual(bindingKey(Owner.User, 'room-1'), bindingKey(Owner.User, 'room-2'))
})

test('dropOwnerRows removes only its own rows', () => {
  const before = mixedTable()
  const after = dropOwnerRows(before, Owner.GroupChat, 'room-1')
  assert.deepEqual(resolveBooks(after, 'room-1'), ['book-manual'])
  assert.notEqual(rowOf(after, Owner.User, 'room-1'), undefined)
})

// ────────────────────────────────────────────────────────────────────────────
// Determinism — resolution order feeds the prompt, so it must not drift.
// ────────────────────────────────────────────────────────────────────────────

test('resolution order is stable and independent of write order', () => {
  const a = setBooks([], Owner.User, 't', ['u1', 'u2'], T0)
  const withTavern = setBooks(a, Owner.Tavern, 't', ['b1'], T0)
  const withGroup = addBook(withTavern, Owner.GroupChat, 't', 'g1', T0)

  // Same set, written in a different order.
  let b: readonly BindingRow[] = []
  b = addBook(b, Owner.GroupChat, 't', 'g1', T0)
  b = setBooks(b, Owner.Tavern, 't', ['b1'], T0)
  b = setBooks(b, Owner.User, 't', ['u1', 'u2'], T0)

  assert.deepEqual(resolveBooks(withGroup, 't'), resolveBooks(b, 't'))
  assert.deepEqual(resolveBooks(withGroup, 't'), ['u1', 'u2', 'b1', 'g1'])
})

test('a book bound by two owners is injected once', () => {
  let rows: readonly BindingRow[] = []
  rows = addBook(rows, Owner.User, 't', 'shared', T0)
  rows = addBook(rows, Owner.GroupChat, 't', 'shared', T0)
  assert.deepEqual(resolveBooks(rows, 't'), ['shared'])
})

// ────────────────────────────────────────────────────────────────────────────
// Idempotence and emptiness.
// ────────────────────────────────────────────────────────────────────────────

test('adding a book twice is a no-op, not a duplicate', () => {
  const once = addBook([], Owner.Tavern, 't', 'b', T0)
  const twice = addBook(once, Owner.Tavern, 't', 'b', T0 + 1)
  assert.deepEqual(twice, once)
})

test('removing a book that is absent is a no-op', () => {
  const rows = addBook([], Owner.Tavern, 't', 'b', T0)
  assert.deepEqual(removeBook(rows, Owner.Tavern, 't', 'missing'), rows)
  assert.deepEqual(removeBook([], Owner.Tavern, 't', 'b'), [])
})

test('an emptied row is dropped, so "absent" and "empty" cannot diverge', () => {
  const rows = addBook([], Owner.Tavern, 't', 'b', T0)
  assert.deepEqual(removeBook(rows, Owner.Tavern, 't', 'b'), [])
  assert.equal(rowOf(removeBook(rows, Owner.Tavern, 't', 'b'), Owner.Tavern, 't'), undefined)
})

test('setting an empty list clears only that owner', () => {
  const before = mixedTable()
  const after = setBooks(before, Owner.User, 'room-1', [], T0 + 3)
  assert.equal(rowOf(after, Owner.User, 'room-1'), undefined)
  assert.deepEqual(resolveBooks(after, 'room-1'), ['book-lifecycle'])
})

// ────────────────────────────────────────────────────────────────────────────
// Rejection — limits are enforced loudly, never truncated.
// ────────────────────────────────────────────────────────────────────────────

test('an over-limit binding set is rejected, not truncated', () => {
  const tooMany = Array.from({ length: 101 }, (_, i) => `book-${i}`)
  let thrown: unknown
  try {
    setBooks([], Owner.User, 't', tooMany, T0)
  } catch (error) {
    thrown = error
  }
  assert.ok(isReject(thrown), 'expected a RejectError')
  assert.equal(thrown.field, 'bookIds')
})

test('duplicate book ids in one write are rejected', () => {
  let thrown: unknown
  try {
    setBooks([], Owner.User, 't', ['b', 'b'], T0)
  } catch (error) {
    thrown = error
  }
  assert.ok(isReject(thrown))
  assert.match(thrown.message, /duplicates/)
})

test('an unknown owner is rejected rather than defaulted', () => {
  let thrown: unknown
  try {
    setBooks([], 'nobody' as Owner, 't', ['b'], T0)
  } catch (error) {
    thrown = error
  }
  assert.ok(isReject(thrown))
  assert.equal(thrown.field, 'owner')
})

test('an empty target id is rejected', () => {
  let thrown: unknown
  try {
    setBooks([], Owner.User, '', ['b'], T0)
  } catch (error) {
    thrown = error
  }
  assert.ok(isReject(thrown))
  assert.equal(thrown.field, 'targetId')
})

test('boundTargets lists distinct targets in first-seen order', () => {
  let rows: readonly BindingRow[] = []
  rows = addBook(rows, Owner.User, 'r1', 'b', T0)
  rows = addBook(rows, Owner.Tavern, 'r1', 'b2', T0)
  rows = addBook(rows, Owner.User, 'r2', 'b', T0)
  assert.deepEqual(boundTargets(rows), ['r1', 'r2'])
})

// ────────────────────────────────────────────────────────────────────────────
// Which books apply
// ────────────────────────────────────────────────────────────────────────────

test('bookIdsForTargets unions across owners and ignores other targets', () => {
  // This decides whether world info applies at all, and its failure mode is
  // silence. It used to live in the service, where the platform import made it
  // untestable.
  let rows: readonly BindingRow[] = []
  rows = setBooks(rows, Owner.User, 'room-1', ['b-1'], T0)
  rows = addBook(rows, Owner.GroupChat, 'room-1', 'b-2', T0)
  rows = setBooks(rows, Owner.User, 'room-2', ['b-9'], T0)

  assert.deepEqual([...bookIdsForTargets(rows, ['room-1'])].sort(), ['b-1', 'b-2'])
  assert.deepEqual([...bookIdsForTargets(rows, ['room-1', 'room-2'])].sort(), ['b-1', 'b-2', 'b-9'])
  assert.deepEqual(bookIdsForTargets(rows, ['nobody']), [])
  assert.deepEqual(bookIdsForTargets([], ['room-1']), [])
})

test('bookIdsForTargets reports a book bound to two targets once', () => {
  let rows: readonly BindingRow[] = []
  rows = addBook(rows, Owner.User, 'room-1', 'shared', T0)
  rows = addBook(rows, Owner.GroupChat, 'room-2', 'shared', T0)
  assert.deepEqual(bookIdsForTargets(rows, ['room-1', 'room-2']), ['shared'])
})
