/**
 * The frozen-reroll invariant, and the four bugs it exists to prevent.
 *
 * Every test below corresponds to a defect the legacy project shipped, found in
 * a later audit round, and fixed by adding one more mutable field. They are
 * written against the *rejection* or the *pinned value*, never the happy path —
 * the happy path was never what broke.
 *
 * Run: node --test tests/reroll.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RejectError, isReject } from '@dsh-tavern/contracts'
import { freezeRerollIntent } from '../src/intent.ts'
import type { RerollIntent, RerollRequest } from '../src/intent.ts'
import {
  acceptReroll,
  beginGeneration,
  claim,
  createScheduler,
  livePending,
  nextDelivery,
  pause,
  pick,
  settle,
  start,
  stop,
} from '../src/scheduler.ts'
import type { Delivery, SchedulerState } from '../src/scheduler.ts'

/** Deterministic id factory, so a test never depends on a random value. */
function ids() {
  let n = 0
  return () => `intent-${++n}`
}

/**
 * Present raw, deliberately-incomplete input to the boundary.
 *
 * These tests exercise what happens when a field is *missing*, which is exactly
 * what the boundary sees from an RPC body. The cast is the point: the compiler
 * cannot prove a request is complete, which is why the validator exists.
 */
function raw(value: Record<string, unknown>): RerollRequest {
  return value as unknown as RerollRequest
}

const AT = 1_700_000_000_000

function freeze(
  state: SchedulerState,
  request: Partial<RerollRequest> & { memberId: string; turnId: number; relaySeq: number },
  nextIntentId: () => string,
  now = AT,
): RerollIntent {
  return freezeRerollIntent(
    { roomId: 'room-1', ...request },
    { generation: state.generation, now, nextIntentId },
  )
}

/** A running round-robin room with three members. */
function room(): SchedulerState {
  return start(createScheduler({ mode: 'round-robin', order: ['a', 'b', 'c'], maxRounds: 0 }))
}

/** Drive one successful speech: deliver, claim, settle. */
function speak(state: SchedulerState, expected: string): SchedulerState {
  const delivery = nextDelivery(state)
  assert.equal(delivery.kind, 'speak')
  assert.equal(delivery.kind === 'speak' ? delivery.memberId : null, expected)
  return settle(claim(state, delivery), delivery, 'ok')
}

function assertRejects(fn: () => unknown, field?: string): RejectError {
  let thrown: unknown
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown !== undefined, 'expected a rejection, but the call succeeded')
  assert.ok(isReject(thrown), `expected a RejectError, got ${String(thrown)}`)
  if (field !== undefined) assert.equal(thrown.field, field)
  return thrown
}

// ────────────────────────────────────────────────────────────────────────────
// 1. No fallbacks: a dimension that cannot be pinned is refused.
// ────────────────────────────────────────────────────────────────────────────

test('a reroll with no turn is refused rather than aimed at the latest turn', () => {
  // Legacy: the target turn was recomputed when the reroll finally ran, so the
  // replacement text belonged to whatever round was current *then*.
  const next = ids()
  assertRejects(() => freeze(room(), { memberId: 'a', turnId: 0, relaySeq: 3 }, next), 'turnId')
  assertRejects(() => freeze(room(), { memberId: 'a', turnId: -1, relaySeq: 3 }, next), 'turnId')
  assertRejects(
    () => freezeRerollIntent(raw({ roomId: 'room-1', memberId: 'a', relaySeq: 3 }), { generation: 1, now: AT, nextIntentId: next }),
    'turnId',
  )
})

test('a reroll with no relay is refused rather than replaying the newest one', () => {
  // Legacy: with the relay unpinned, the fork replayed the most recent relay,
  // so the take was built from a different round than the one clicked.
  const next = ids()
  assertRejects(() => freeze(room(), { memberId: 'a', turnId: 2, relaySeq: -1 }, next), 'relaySeq')
  assertRejects(
    () => freezeRerollIntent(raw({ roomId: 'room-1', memberId: 'a', turnId: 2 }), { generation: 1, now: AT, nextIntentId: next }),
    'relaySeq',
  )
})

test('relay zero is legitimate, not treated as absent', () => {
  const intent = freeze(room(), { memberId: 'a', turnId: 1, relaySeq: 0 }, ids())
  assert.equal(intent.relaySeq, 0)
})

test('malformed ids are refused', () => {
  const next = ids()
  assertRejects(() => freeze(room(), { memberId: '-bad', turnId: 1, relaySeq: 0 }, next), 'memberId')
  assertRejects(
    () => freezeRerollIntent(raw({ roomId: 'bad id', memberId: 'a', turnId: 1, relaySeq: 0 }), { generation: 1, now: AT, nextIntentId: next }),
    'roomId',
  )
})

// ────────────────────────────────────────────────────────────────────────────
// 2. The pinned values survive later activity.
// ────────────────────────────────────────────────────────────────────────────

test('an accepted reroll keeps its turn and relay after the room moves on', () => {
  // The legacy scenario, exactly: the user clicks reroll while the member is
  // mid-speech, so it queues. That speech then completes on its own and the
  // turn advances. When the queued reroll finally runs, the old code recomputed
  // the target from "the member's latest turn" and attached the replacement to
  // the *new* turn — the wrong round, silently.
  const next = ids()
  let state = room()

  const live = nextDelivery(state)        // 'a' starts speaking on turn 1
  assert.equal(live.kind === 'speak' ? live.memberId : null, 'a')
  state = claim(state, live)

  // The click lands while the floor is busy.
  const intent = freeze(state, { memberId: 'a', turnId: 1, relaySeq: 4 }, next)
  state = acceptReroll(state, intent).state

  // That speech finishes naturally: the room advances to turn 2.
  state = settle(state, live, 'ok')
  assert.equal(state.turnId, 2, 'the room advanced past the clicked turn')

  // The queued reroll still points at turn 1 and relay 4.
  const delivery = nextDelivery(state)
  assert.equal(delivery.kind, 'reroll')
  assert.equal(delivery.kind === 'reroll' ? delivery.intent.turnId : null, 1)
  assert.equal(delivery.kind === 'reroll' ? delivery.intent.relaySeq : null, 4)
  assert.equal(delivery.kind === 'reroll' ? delivery.memberId : null, 'a')
  // Identity, not a copy: nothing recomputed it along the way.
  assert.equal(delivery.kind === 'reroll' ? delivery.intent.intentId : null, intent.intentId)
})

test('settling a reroll does not advance the turn', () => {
  const next = ids()
  let state = room()
  state = speak(state, 'a')
  const turnBefore = state.turnId

  const intent = freeze(state, { memberId: 'a', turnId: 1, relaySeq: 1 }, next)
  state = acceptReroll(state, intent).state
  const delivery = nextDelivery(state)
  state = settle(claim(state, delivery), delivery, 'ok')

  assert.equal(state.turnId, turnBefore, 'a reroll replaces a take within the same turn')
})

// ────────────────────────────────────────────────────────────────────────────
// 3. The drain gate: paused is not stopped.
// ────────────────────────────────────────────────────────────────────────────

test('a reroll accepted while paused is still delivered', () => {
  // Legacy gate was `status === 'running'`, which shelved the click silently.
  const next = ids()
  let state = pause(room())
  const intent = freeze(state, { memberId: 'b', turnId: 1, relaySeq: 2 }, next)
  state = acceptReroll(state, intent).state

  const delivery = nextDelivery(state)
  assert.equal(delivery.kind, 'reroll', 'a paused room must still deliver a queued reroll')
})

test('a stopped room delivers nothing', () => {
  const next = ids()
  let state = pause(room())
  const intent = freeze(state, { memberId: 'b', turnId: 1, relaySeq: 2 }, next)
  state = acceptReroll(state, intent).state
  state = stop(state)

  assert.equal(nextDelivery(state).kind, 'idle')
  assert.equal(livePending(state).length, 0)
})

// ────────────────────────────────────────────────────────────────────────────
// 4. Failure must not freeze the carousel.
// ────────────────────────────────────────────────────────────────────────────

test('a failed reroll delivery is re-queued and the room keeps moving', () => {
  // Legacy: a drain that threw returned without scheduling the next step, and
  // the carousel stopped dead with nothing reported anywhere.
  const next = ids()
  let state = room()
  const intent = freeze(state, { memberId: 'c', turnId: 1, relaySeq: 7 }, next)
  state = acceptReroll(state, intent).state

  const delivery = nextDelivery(state)
  state = claim(state, delivery)
  state = settle(state, delivery, 'failed')

  assert.equal(state.speaker, null, 'the floor must be released')
  const retry = nextDelivery(state)
  assert.equal(retry.kind, 'reroll')
  // The same object, still pinned: nothing was recomputed and nothing was lost.
  assert.equal(retry.kind === 'reroll' ? retry.intent.intentId : null, intent.intentId)
  assert.equal(retry.kind === 'reroll' ? retry.intent.relaySeq : null, 7)
})

test('a failed speech returns the member to the front of the queue', () => {
  let state = room()
  const delivery = nextDelivery(state)
  state = settle(claim(state, delivery), delivery, 'failed')

  assert.equal(state.speaker, null)
  const retry = nextDelivery(state)
  assert.equal(retry.kind === 'speak' ? retry.memberId : null, 'a')
})

test('a failure after a concurrent stop discards the work instead of re-queueing it', () => {
  // The pure model of the legacy "re-check stop after every await" rule.
  const next = ids()
  let state = room()
  const intent = freeze(state, { memberId: 'a', turnId: 1, relaySeq: 1 }, next)
  state = acceptReroll(state, intent).state

  const delivery = nextDelivery(state)
  state = claim(state, delivery)
  state = stop(state)                      // the user stops while it is in flight
  state = settle(state, delivery, 'failed') // the delivery then reports failure

  assert.equal(state.status, 'stopped')
  assert.equal(state.speaker, null)
  assert.equal(nextDelivery(state).kind, 'idle')
  assert.equal(livePending(state).length, 0, 'a stop must not resurrect the intent')
})

// ────────────────────────────────────────────────────────────────────────────
// 5. The floor is claimed synchronously, so two replays cannot both hold it.
// ────────────────────────────────────────────────────────────────────────────

test('the floor cannot be claimed twice', () => {
  // Legacy: `deliverReroll` took the slot after several awaits, so send / pick /
  // stop / a concurrent reroll could interleave and either both fork or leak one.
  let state = room()
  const delivery = nextDelivery(state)
  state = claim(state, delivery)
  assertRejects(() => claim(state, delivery), 'claim')
})

test('while the floor is held, nothing new is delivered', () => {
  const next = ids()
  let state = room()
  state = acceptReroll(state, freeze(state, { memberId: 'a', turnId: 1, relaySeq: 1 }, next)).state

  const delivery = nextDelivery(state)
  state = claim(state, delivery)
  assert.equal(nextDelivery(state).kind, 'idle', 'a busy floor must not hand out more work')
})

// ────────────────────────────────────────────────────────────────────────────
// 6. A second click must not destroy the first.
// ────────────────────────────────────────────────────────────────────────────

test('a duplicate reroll for the same member and turn is refused', () => {
  const next = ids()
  let state = room()
  state = acceptReroll(state, freeze(state, { memberId: 'a', turnId: 2, relaySeq: 1 }, next)).state
  const error = assertRejects(
    () => acceptReroll(state, freeze(state, { memberId: 'a', turnId: 2, relaySeq: 5 }, next)),
    'reroll',
  )
  assert.match(error.message, /already queued/)
})

test('the same member may queue rerolls for two different turns', () => {
  const next = ids()
  let state = room()
  state = acceptReroll(state, freeze(state, { memberId: 'a', turnId: 1, relaySeq: 1 }, next)).state
  state = acceptReroll(state, freeze(state, { memberId: 'a', turnId: 2, relaySeq: 9 }, next)).state
  assert.equal(livePending(state).length, 2)
  // Different turns must not alias through the composite key.
  assert.equal(new Set(livePending(state).map((i) => `${i.memberId}/${i.turnId}`)).size, 2)
})

test('two members may queue rerolls for the same turn', () => {
  const next = ids()
  let state = room()
  state = acceptReroll(state, freeze(state, { memberId: 'a', turnId: 3, relaySeq: 1 }, next)).state
  state = acceptReroll(state, freeze(state, { memberId: 'b', turnId: 3, relaySeq: 2 }, next)).state
  assert.equal(livePending(state).length, 2)
})

test('a reroll is refused while the room is stopped', () => {
  const next = ids()
  const state = createScheduler({ mode: 'round-robin', order: ['a'], maxRounds: 0 })
  assertRejects(() => acceptReroll(state, freeze(state, { memberId: 'a', turnId: 1, relaySeq: 1 }, next)), 'reroll')
})

// ────────────────────────────────────────────────────────────────────────────
// 7. The generation boundary.
// ────────────────────────────────────────────────────────────────────────────

test('a reroll from a previous generation is never delivered', () => {
  // Member agents do not survive a restart, so an intent from before one names
  // surfaces that no longer exist. Delivering it would be worse than dropping it.
  const next = ids()
  let state = room()
  const intent = freeze(state, { memberId: 'a', turnId: 1, relaySeq: 3 }, next)
  state = acceptReroll(state, intent).state

  const nextGeneration = beginGeneration(state)
  assert.equal(nextGeneration.generation, state.generation + 1)
  assert.equal(livePending(nextGeneration).length, 0)
  assert.equal(nextDelivery(start(nextGeneration)).kind, 'speak')

  // And it cannot be smuggled back in.
  assertRejects(() => acceptReroll(start(nextGeneration), intent), 'reroll')
})

test('an intent built for the wrong generation is refused on arrival', () => {
  const state = beginGeneration(room())
  const stale = freezeRerollIntent(
    { roomId: 'room-1', memberId: 'a', turnId: 1, relaySeq: 1 },
    { generation: 1, now: AT, nextIntentId: ids() },
  )
  assertRejects(() => acceptReroll(start(state), stale), 'reroll')
})

// ────────────────────────────────────────────────────────────────────────────
// 8. Turn mechanics.
// ────────────────────────────────────────────────────────────────────────────

test('a completed speech advances the turn and rotates the speaker to the back', () => {
  let state = room()
  state = speak(state, 'a')
  assert.equal(state.turnId, 2)
  state = speak(state, 'b')
  state = speak(state, 'c')
  state = speak(state, 'a')   // wrapped
  assert.equal(state.turnId, 5)
  assert.equal(state.round, 4)
})

test('the round limit reports itself instead of speaking', () => {
  let state = start(createScheduler({ mode: 'round-robin', order: ['a', 'b'], maxRounds: 2 }))
  for (const expected of ['a', 'b']) state = speak(state, expected)
  assert.equal(nextDelivery(state).kind, 'round-limit')
})

test('free mode waits for a pick, then speaks the picked member', () => {
  let state = start(createScheduler({ mode: 'free', order: ['a', 'b'], maxRounds: 0 }))
  assert.equal(nextDelivery(state).kind, 'await-pick')

  state = pick(state, 'a')
  const delivery = nextDelivery(state)
  assert.equal(delivery.kind, 'speak')
  assert.equal(delivery.kind === 'speak' ? delivery.memberId : null, 'a')

  state = claim(state, delivery)
  assert.equal(state.picked, null, 'claiming consumes the pick')
  state = settle(state, delivery, 'ok')
  assert.equal(nextDelivery(state).kind, 'await-pick', 'free mode asks again after every speech')
})

test('a pick made while the floor is busy is held, not dropped', () => {
  // Legacy: `pick` was ignored outright when someone was speaking, so the click
  // produced no feedback at all. Holding it keeps the UI able to show it.
  let state = start(createScheduler({ mode: 'free', order: ['a', 'b'], maxRounds: 0 }))
  state = pick(state, 'a')
  const speakA = nextDelivery(state)
  state = claim(state, speakA)          // floor is now busy
  assert.equal(nextDelivery(state).kind, 'idle')

  state = pick(state, 'b')              // the user picks anyway
  assert.equal(state.picked, 'b', 'the pick must be held so the UI can show it')

  state = settle(state, speakA, 'ok')
  const next = nextDelivery(state)
  assert.equal(next.kind === 'speak' ? next.memberId : null, 'b', 'the held pick is honoured next')
})

test('picking an unknown member is refused', () => {
  const state = start(createScheduler({ mode: 'free', order: ['a', 'b'], maxRounds: 0 }))
  assertRejects(() => pick(state, 'ghost'), 'pick')
})

test('a duplicate member in the order is refused at construction', () => {
  assertRejects(() => createScheduler({ mode: 'round-robin', order: ['a', 'a'], maxRounds: 0 }), 'order')
})

// ────────────────────────────────────────────────────────────────────────────
// 9. State is never mutated in place.
// ────────────────────────────────────────────────────────────────────────────

test('transitions do not mutate the state they are given', () => {
  const before = room()
  const snapshot = JSON.stringify(before)
  const delivery: Delivery = nextDelivery(before)
  settle(claim(before, delivery), delivery, 'ok')
  assert.equal(JSON.stringify(before), snapshot, 'a transition mutated its input')
})
