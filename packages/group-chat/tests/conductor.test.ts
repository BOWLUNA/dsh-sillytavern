/**
 * The delivery loop's own rules.
 *
 * These tests exist because the legacy project's scheduling bugs were only ever
 * found by hand, in a browser, after they had already shipped — the loop could
 * not be exercised without a model, so nobody exercised it. A `Speaker` that the
 * test settles at will removes that excuse.
 *
 * Run: node --test tests/conductor.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isReject } from '@dsh-tavern/contracts'
import { Conductor } from '../src/conductor.ts'
import type { ConductorOptions, SpeakRequest, Speaker } from '../src/conductor.ts'

// ────────────────────────────────────────────────────────────────────────────
// A speaker the test owns: it records what it was asked for and, in manual
// mode, waits to be settled so the test can act while a delivery is in flight.
// ────────────────────────────────────────────────────────────────────────────

type Outcome = { ok: string } | { error: string }

class FakeSpeaker implements Speaker {
  readonly calls: SpeakRequest[] = []
  /** Consumed in order; when empty, calls succeed with a default text. */
  script: Outcome[] = []
  /** When true, every call waits for `settle`/`fail` instead of resolving. */
  manual = false

  private pending: { resolve: (v: { text: string }) => void; reject: (e: unknown) => void } | null = null

  produce(request: SpeakRequest, signal: AbortSignal): Promise<{ text: string }> {
    this.calls.push(request)

    // Abort always works, in both modes: a stop must be able to interrupt a
    // delivery that is already awaiting something.
    if (signal.aborted) return Promise.reject(new Error('aborted'))

    if (this.manual) {
      return new Promise<{ text: string }>((resolve, reject) => {
        this.pending = { resolve, reject }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }

    const next = this.script.shift()
    if (next !== undefined) {
      return 'error' in next
        ? Promise.reject(new Error(next.error))
        : Promise.resolve({ text: next.ok })
    }
    return Promise.resolve({ text: `${request.memberId} turn ${request.turnId}` })
  }

  settle(text: string): void {
    const pending = this.pending
    this.pending = null
    pending?.resolve({ text })
  }

  fail(error: unknown): void {
    const pending = this.pending
    this.pending = null
    pending?.reject(error)
  }

  get waiting(): boolean {
    return this.pending !== null
  }

  last(): SpeakRequest {
    const call = this.calls.at(-1)
    assert.ok(call !== undefined, 'no call was made')
    return call
  }
}

function ids() {
  let n = 0
  return () => `id-${++n}`
}

/** Let queued microtasks and immediates run. */
async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

function makeConductor(speaker: Speaker, overrides: Partial<ConductorOptions> = {}): Conductor {
  return new Conductor({
    roomId: 'room-1',
    mode: 'round-robin',
    order: ['a', 'b'],
    maxRounds: 2,
    speaker,
    nextId: ids(),
    now: () => 1_700_000_000_000,
    ...overrides,
  })
}

// ────────────────────────────────────────────────────────────────────────────
// The happy path, so the failure tests below are not vacuous.
// ────────────────────────────────────────────────────────────────────────────

test('a bounded room speaks in order and then pauses itself', async () => {
  const speaker = new FakeSpeaker()
  const conductor = makeConductor(speaker, { maxRounds: 2 })

  conductor.start()
  await conductor.idle()

  assert.deepEqual(speaker.calls.map((call) => call.memberId), ['a', 'b'])
  assert.deepEqual(conductor.takes.map((take) => take.memberId), ['a', 'b'])
  assert.deepEqual(conductor.takes.map((take) => take.turnId), [1, 2])
  assert.deepEqual(conductor.takes.map((take) => take.relaySeq), [1, 2])
  assert.equal(conductor.state.status, 'paused', 'the round limit pauses the room')
  assert.equal(conductor.state.turnId, 3)
})

test('every take records the request that produced it', async () => {
  const speaker = new FakeSpeaker()
  const conductor = makeConductor(speaker, { maxRounds: 1 })

  conductor.start()
  await conductor.idle()

  const take = conductor.takes[0]
  assert.ok(take !== undefined)
  assert.equal(take.kind, 'speak')
  assert.equal(take.memberId, 'a')
  assert.equal(take.turnId, 1)
  assert.equal(take.relaySeq, 1)
  assert.equal(take.intentId, null)
  assert.equal(take.generation, conductor.state.generation)
  assert.equal(take.text, 'a turn 1')
})

// ────────────────────────────────────────────────────────────────────────────
// Single-flight: the legacy "two replays both held the floor" bug.
// ────────────────────────────────────────────────────────────────────────────

test('only one delivery is ever in flight', async () => {
  const speaker = new FakeSpeaker()
  speaker.manual = true
  const conductor = makeConductor(speaker, { maxRounds: 0 })

  conductor.start()
  await flush()
  assert.equal(speaker.calls.length, 1, 'the first delivery started')

  // Every one of these would, in the legacy design, be a second entry point
  // into the conductor while a delivery was mid-flight.
  conductor.resume()
  conductor.pick('b')
  conductor.reroll({ roomId: 'room-1', memberId: 'b', turnId: 1, relaySeq: 1 })
  await flush()

  assert.equal(speaker.calls.length, 1, 'still exactly one delivery in flight')
  assert.equal(conductor.busy, true)

  speaker.settle('done')
  await flush()
})

// ────────────────────────────────────────────────────────────────────────────
// Failure must not freeze the room, and must not spin either.
// ────────────────────────────────────────────────────────────────────────────

test('a failing speaker is retried, then the room pauses instead of spinning', async () => {
  // The legacy loop could spin as fast as the microtask queue allowed once a
  // delivery failed; its own test harness had to suspend the mock until abort.
  const speaker = new FakeSpeaker()
  speaker.script = [{ error: 'boom' }, { error: 'boom' }, { error: 'boom' }]
  const failures: Array<SpeakRequest | null> = []
  const conductor = makeConductor(speaker, {
    maxRounds: 0,
    failureBudget: 3,
    onFailure: (_error, request) => failures.push(request),
  })

  conductor.start()
  await conductor.idle()

  assert.equal(speaker.calls.length, 3, `expected exactly the budget of attempts, got ${speaker.calls.length}`)
  assert.equal(conductor.state.status, 'paused', 'a bounded failure pauses rather than spins')
  assert.equal(failures.length, 3)
  // The work is still queued, so this is recoverable rather than fatal.
  assert.equal(conductor.state.queue[0], 'a')
  assert.equal(conductor.takes.length, 0)
})

test('a transient failure is retried and then succeeds', async () => {
  const speaker = new FakeSpeaker()
  speaker.script = [{ error: 'transient' }]
  const conductor = makeConductor(speaker, { maxRounds: 1 })

  conductor.start()
  await conductor.idle()

  assert.equal(speaker.calls.length, 2, 'one failure + one success')
  assert.equal(conductor.takes.length, 1)
  assert.equal(conductor.takes[0]?.text, 'a turn 1')
})

test('a failure does not lose the turn: the same member is retried', async () => {
  const speaker = new FakeSpeaker()
  speaker.script = [{ error: 'transient' }]
  const conductor = makeConductor(speaker, { maxRounds: 1 })

  conductor.start()
  await conductor.idle()

  assert.deepEqual(speaker.calls.map((call) => call.memberId), ['a', 'a'])
  assert.deepEqual(speaker.calls.map((call) => call.turnId), [1, 1], 'the turn does not advance on failure')
})

// ────────────────────────────────────────────────────────────────────────────
// Stop, mid-flight.
// ────────────────────────────────────────────────────────────────────────────

test('stopping mid-delivery discards the outcome and records nothing', async () => {
  const speaker = new FakeSpeaker()
  speaker.manual = true
  const conductor = makeConductor(speaker, { maxRounds: 0 })

  conductor.start()
  await flush()
  assert.equal(speaker.waiting, true)

  await conductor.stop()

  assert.equal(conductor.state.status, 'stopped')
  assert.equal(conductor.takes.length, 0, 'a cancelled delivery produces no take')
  assert.equal(conductor.state.pending.length, 0)
  // The abort reached the speaker.
  speaker.settle('too late')
  await flush()
  assert.equal(conductor.takes.length, 0)
})

test('a reroll queued before a stop is voided by the next start', async () => {
  const speaker = new FakeSpeaker()
  speaker.manual = true
  const conductor = makeConductor(speaker, { maxRounds: 0 })

  conductor.start()
  await flush()
  conductor.reroll({ roomId: 'room-1', memberId: 'a', turnId: 1, relaySeq: 1 })
  assert.equal(conductor.state.pending.length, 1)

  await conductor.stop()
  const generation = conductor.state.generation

  conductor.start()
  assert.equal(conductor.state.generation, generation + 1, 'a restart opens a new generation')
  assert.equal(conductor.state.pending.length, 0, 'intents from the old generation are voided')
  await conductor.stop()
})

// ────────────────────────────────────────────────────────────────────────────
// The frozen reroll, end to end through the loop.
// ────────────────────────────────────────────────────────────────────────────

test('a reroll accepted mid-speech is delivered with the clicked turn and relay', async () => {
  const speaker = new FakeSpeaker()
  speaker.manual = true
  const conductor = makeConductor(speaker, { maxRounds: 1 })

  conductor.start()
  await flush()
  assert.equal(speaker.last().kind, 'speak')
  assert.equal(speaker.last().turnId, 1)
  assert.equal(speaker.last().relaySeq, 1)

  // The user clicks reroll on the take being produced right now.
  const intent = conductor.reroll({ roomId: 'room-1', memberId: 'a', turnId: 1, relaySeq: 1 })

  // That speech completes on its own.
  speaker.settle('first take')
  await flush()

  // The queued reroll runs next, and it is aimed at what was clicked.
  assert.equal(speaker.last().kind, 'reroll')
  assert.equal(speaker.last().turnId, 1)
  assert.equal(speaker.last().relaySeq, 1)
  assert.equal(speaker.last().intentId, intent.intentId)

  speaker.settle('replacement take')
  await conductor.idle()

  assert.deepEqual(conductor.takes.map((take) => take.kind), ['speak', 'reroll'])
  assert.equal(conductor.takes[0]?.text, 'first take')
  assert.equal(conductor.takes[1]?.text, 'replacement take')
  assert.equal(conductor.takes[1]?.turnId, 1, 'a reroll replaces a take within the same turn')
  assert.equal(conductor.takes[1]?.intentId, intent.intentId)
})

test('a paused room serves a queued reroll but does not advance the carousel', async () => {
  // Pausing is how the user stops the carousel; a reroll is something they
  // explicitly asked for, so it is still served. The legacy project behaved this
  // way, and the variant that dropped the click was a bug, not a design.
  const speaker = new FakeSpeaker()
  speaker.manual = true
  const conductor = makeConductor(speaker, { maxRounds: 0 })

  conductor.start()
  await flush()
  conductor.pause()
  conductor.reroll({ roomId: 'room-1', memberId: 'a', turnId: 1, relaySeq: 1 })
  speaker.settle('first take')
  await flush()

  assert.equal(speaker.calls.length, 2)
  assert.equal(speaker.last().kind, 'reroll', 'a paused room still serves a reroll')

  speaker.settle('replacement take')
  await flush()

  assert.equal(conductor.state.status, 'paused')
  assert.equal(speaker.calls.length, 2, 'the carousel did not advance while paused')
  assert.equal(conductor.state.queue.length > 0, true, 'the queue is intact for a resume')
})

// ────────────────────────────────────────────────────────────────────────────
// Rejections surface to the caller rather than being swallowed.
// ────────────────────────────────────────────────────────────────────────────

test('a duplicate reroll is refused and reaches the caller', async () => {
  const speaker = new FakeSpeaker()
  speaker.manual = true
  const conductor = makeConductor(speaker, { maxRounds: 0 })

  conductor.start()
  await flush()
  conductor.reroll({ roomId: 'room-1', memberId: 'a', turnId: 1, relaySeq: 1 })

  let thrown: unknown
  try {
    conductor.reroll({ roomId: 'room-1', memberId: 'a', turnId: 1, relaySeq: 9 })
  } catch (error) {
    thrown = error
  }
  assert.ok(isReject(thrown), 'the second click must be refused, not silently merged')

  await conductor.stop()
})

test('a reroll that cannot be pinned never reaches the speaker', async () => {
  const speaker = new FakeSpeaker()
  speaker.manual = true
  const conductor = makeConductor(speaker, { maxRounds: 0 })

  conductor.start()
  await flush()

  let thrown: unknown
  try {
    conductor.reroll({ roomId: 'room-1', memberId: 'a', turnId: 0, relaySeq: 1 })
  } catch (error) {
    thrown = error
  }
  assert.ok(isReject(thrown))
  assert.equal(conductor.state.pending.length, 0)

  await conductor.stop()
})

// ────────────────────────────────────────────────────────────────────────────
// Free mode.
// ────────────────────────────────────────────────────────────────────────────

test('free mode waits for a pick and then speaks that member', async () => {
  const speaker = new FakeSpeaker()
  const conductor = makeConductor(speaker, { mode: 'free', maxRounds: 1 })

  conductor.start()
  await conductor.idle()
  assert.equal(speaker.calls.length, 0, 'a free room does not speak unprompted')

  conductor.pick('b')
  await conductor.idle()
  assert.deepEqual(speaker.calls.map((call) => call.memberId), ['b'])
})

// ────────────────────────────────────────────────────────────────────────────
// A kick that arrives mid-run must not be swallowed.
// ────────────────────────────────────────────────────────────────────────────

test('a reroll accepted while the loop is finishing is still delivered', async () => {
  // Found when the room runner was wired up: the loop reached its round limit and
  // returned, and a reroll accepted in that window was handed the finishing
  // promise and never scheduled. The work sat in the queue with no error — the
  // silently-shelved shape the legacy project kept rediscovering.
  const speaker = new FakeSpeaker()
  speaker.manual = true
  const conductor = makeConductor(speaker, { maxRounds: 1 })

  conductor.start()
  await flush()
  assert.equal(speaker.last().kind, 'speak')

  // The in-flight speech settles; the loop's next decision is the round limit,
  // which pauses the room and ends the run.
  speaker.settle('first take')

  // The reroll lands while that run is still unwinding.
  conductor.reroll({ roomId: 'room-1', memberId: 'a', turnId: 1, relaySeq: 1 })
  await flush()

  assert.equal(speaker.last().kind, 'reroll', 'the reroll must reach the speaker')
  assert.equal(speaker.last().turnId, 1)
  assert.equal(speaker.last().relaySeq, 1)

  speaker.settle('replacement')
  await conductor.idle()
})
