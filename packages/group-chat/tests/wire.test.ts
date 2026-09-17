/**
 * Boundary invariants for group chat.
 *
 * These are not coverage. Each one pins a specific way the legacy project
 * corrupted data or shipped a silent behaviour, and each is written against the
 * *rejection*, not the happy path — because the happy path was never the
 * problem.
 *
 * Run: node --test tests/wire.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RejectError, compositeKey, isReject } from '@dsh-tavern/contracts'
import {
  LIMITS,
  requireEnum,
  requireName,
  sanitizeMemberCreate,
  sanitizeRoomCreate,
} from '../src/wire.ts'

/** Assert that `fn` rejects with a `RejectError` naming `field`. */
function assertRejects(field: string, fn: () => unknown, hint?: RegExp): RejectError {
  const error = assertIsReject(fn)
  assert.equal(error.field, field)
  if (hint) assert.match(error.message, hint)
  return error
}

/** Assert that `fn` rejects with the shared `RejectError` type, field unspecified. */
function assertIsReject(fn: () => unknown): RejectError {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== undefined, 'expected a rejection, but the call succeeded')
  assert.ok(isReject(thrown), `expected a RejectError, got ${String(thrown)}`)
  return thrown
}

// ────────────────────────────────────────────────────────────────────────────
// The two failures that corrupted real data.
// ────────────────────────────────────────────────────────────────────────────

test('an unknown mode is rejected, never silently defaulted', () => {
  // Legacy: an unrecognised mode silently became `round-robin`, which created
  // ghost rooms for calls the caller believed had been refused.
  assertRejects('room.mode', () => sanitizeRoomCreate({ name: 'r', mode: 'roundrobin' }), /round-robin/)
  assertRejects('room.mode', () => sanitizeRoomCreate({ name: 'r', mode: 'ROUND-ROBIN' }))
  assertRejects('room.mode', () => sanitizeRoomCreate({ name: 'r', mode: 1 }))
  assertRejects('room.mode', () => sanitizeRoomCreate({ name: 'r' }))
})

test('a required name is never trimmed into existence or defaulted', () => {
  // Legacy: an empty name could reach storage and poison the whole domain on
  // the next boot — the domain refuses to open, so every room becomes
  // unreachable, not just the bad one.
  assertRejects('room.name', () => sanitizeRoomCreate({ name: '', mode: 'free' }), /empty/)
  assertRejects('room.name', () => sanitizeRoomCreate({ name: '   \n\t ', mode: 'free' }), /empty/)
  assertRejects('room.name', () => sanitizeRoomCreate({ mode: 'free' }))
})

// ────────────────────────────────────────────────────────────────────────────
// Rejection is a single, catchable type.
// ────────────────────────────────────────────────────────────────────────────

test('every rejection is the shared RejectError type', () => {
  const cases: Array<() => unknown> = [
    () => requireName('n', ''),
    () => requireName('n', 42),
    () => requireEnum('e', 'x', ['a', 'b']),
    () => requireEnum('e', null, ['a']),
    () => compositeKey('a', `b${'\u0000'}c`),
  ]
  for (const fn of cases) {
    const error = assertIsReject(fn)
    assert.ok(error instanceof RejectError)
    // Every rejection names both the offending field and the reason, so a
    // caller can act on it without parsing free text.
    assert.ok(error.field.length > 0, 'a rejection must name its field')
    assert.ok(error.reason.length > 0, 'a rejection must state a reason')
  }
})

test('rejection messages name the field and what was allowed', () => {
  const error = assertRejects('room.mode', () => requireEnum('room.mode', 'nope', ['free', 'round-robin']))
  assert.match(error.message, /"free"/)
  assert.match(error.message, /"round-robin"/)
  assert.match(error.message, /"nope"/)
})

// ────────────────────────────────────────────────────────────────────────────
// Bounds are enforced, and the bound is not a silent truncation.
// ────────────────────────────────────────────────────────────────────────────

test('an over-long name is rejected, not truncated', () => {
  const long = 'x'.repeat(LIMITS.name + 1)
  assertRejects('n', () => requireName('n', long), new RegExp(`over the ${LIMITS.name} limit`))
  assert.equal(requireName('n', 'x'.repeat(LIMITS.name)).length, LIMITS.name)
})

test('duplicate member ids are rejected rather than deduplicated', () => {
  // Legacy: a repeated id in an ordering array was accepted, which corrupted
  // the member list. Deduplicating silently would hide the caller's bug.
  assertRejects(
    'room.memberIds[1]',
    () => sanitizeRoomCreate({ name: 'r', mode: 'free', memberIds: ['a', 'a'] }),
    /duplicates/,
  )
})

test('malformed member ids are rejected at their own index', () => {
  assertRejects('room.memberIds[0]', () => sanitizeRoomCreate({ name: 'r', mode: 'free', memberIds: ['-bad'] }))
  assertRejects('room.memberIds[0]', () => sanitizeRoomCreate({ name: 'r', mode: 'free', memberIds: [7] }))
})

// ────────────────────────────────────────────────────────────────────────────
// Composite keys must be injective.
// ────────────────────────────────────────────────────────────────────────────

test('composite keys cannot alias two distinct pairs', () => {
  // Legacy: the lorebook activation table was keyed by a bare entryId, so two
  // bound books that both contained entryId "0" ate each other. It was found
  // twice — once within a book, once across books.
  assert.notEqual(compositeKey('bookA', '0'), compositeKey('bookB', '0'))
  assert.equal(compositeKey('bookA', '0'), compositeKey('bookA', '0'))
  assertRejects('compositeKey', () => compositeKey('a', `b${'\u0000'}c`), /separator/)
})

// ────────────────────────────────────────────────────────────────────────────
// The happy path, so the rejections above are not vacuous.
// ────────────────────────────────────────────────────────────────────────────

test('a well-formed request passes through unchanged', () => {
  const input = {
    name: '测试群',
    mode: 'round-robin',
    memberIds: ['m-1', 'm-2'],
    maxRounds: 12,
    scenario: '一个安静的下午',
  }
  assert.deepEqual(sanitizeRoomCreate(input), input)
})

test('optional fields stay absent when the caller omitted them', () => {
  // Distinguishing "omitted" from "set to empty" matters: a patch that clears a
  // field and a patch that ignores it are different operations, and the legacy
  // code conflated them.
  const parsed = sanitizeRoomCreate({ name: 'r', mode: 'free' })
  assert.deepEqual(Object.keys(parsed).sort(), ['mode', 'name'])
})


// ────────────────────────────────────────────────────────────────────────────
// Members
// ────────────────────────────────────────────────────────────────────────────

test('a member needs a name and nothing else', () => {
  assert.deepEqual(sanitizeMemberCreate({ name: '甲' }), { name: '甲', emoji: '' })
  assertRejects('member.name', () => sanitizeMemberCreate({}))
  assertRejects('member.name', () => sanitizeMemberCreate({ name: '  ' }), /empty/)
})

test('an omitted persona field stays omitted rather than being invented', () => {
  // A placeholder the plugin made up is worse than none: it is invisible in the
  // UI and indistinguishable from the user's own writing afterwards.
  const parsed = sanitizeMemberCreate({ name: '甲', description: '沉默寡言' })
  assert.deepEqual(Object.keys(parsed).sort(), ['description', 'emoji', 'name'])
  assert.equal(parsed.personality, undefined)
})

test('a persona field set to empty is kept as empty, not dropped', () => {
  const parsed = sanitizeMemberCreate({ name: '甲', greeting: '' })
  assert.equal(parsed.greeting, '')
})

test('an over-long persona is rejected, not truncated', () => {
  assertRejects(
    'member.description',
    () => sanitizeMemberCreate({ name: '甲', description: 'x'.repeat(LIMITS.text + 1) }),
    /over the/,
  )
})

test('an over-long emoji is rejected', () => {
  assertRejects('member.emoji', () => sanitizeMemberCreate({ name: '甲', emoji: 'x'.repeat(33) }))
})

test('a non-object member body is rejected', () => {
  assertRejects('member', () => sanitizeMemberCreate(null))
  assertRejects('member', () => sanitizeMemberCreate('甲'))
  assertRejects('member', () => sanitizeMemberCreate([]))
})
