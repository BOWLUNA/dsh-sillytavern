/**
 * The room runner: lifecycle, transcript, and where a reroll's aim comes from.
 *
 * The one thing a test cannot supply is a model, so it supplies a `Speaker`
 * instead — which is the whole reason `SpeakerFactory` exists as a port.
 *
 * Run: node --test tests/rooms.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isReject } from '@dsh-tavern/contracts'
import type { SpeakRequest, Speaker, Take } from '../src/conductor.ts'
import { RoomRunner, toRoomInput } from '../src/rooms.ts'
import type { RoomInput } from '../src/rooms.ts'
import type { MemberSpec } from '../src/speaker.ts'
import type { TranscriptPort } from '../src/speaker.ts'

const MEMBERS: readonly MemberSpec[] = [
  { memberId: 'm-1', name: '甲', description: '', personality: '', scenario: '' },
  { memberId: 'm-2', name: '乙', description: '', personality: '', scenario: '' },
]

function ids() {
  let n = 0
  return () => `id-${++n}`
}

/** A speaker that answers immediately, echoing what it was asked to answer. */
class EchoSpeaker implements Speaker {
  readonly requests: SpeakRequest[] = []
  private readonly transcript: TranscriptPort

  constructor(transcript: TranscriptPort) {
    this.transcript = transcript
  }

  async produce(request: SpeakRequest): Promise<{ text: string }> {
    this.requests.push(request)
    if (request.kind === 'reroll') {
      const line = this.transcript.line(request.relaySeq)
      return { text: `reroll of ${line ?? '(gone)'}` }
    }
    return { text: `take ${request.turnId} by ${request.memberId}` }
  }
}

function room(overrides: Partial<RoomInput> = {}): RoomInput {
  return {
    roomId: 'room-1',
    name: '测试群',
    mode: 'round-robin',
    members: MEMBERS,
    maxRounds: 2,
    ...overrides,
  }
}

function makeRunner(overrides: { maxRounds?: number } = {}) {
  const speakers: EchoSpeaker[] = []
  const takes: Array<{ roomId: string; take: Take }> = []
  const runner = new RoomRunner({
    speakerFor: (_room, transcript) => {
      const speaker = new EchoSpeaker(transcript)
      speakers.push(speaker)
      return speaker
    },
    nextId: ids(),
    now: () => 1_700_000_000_000,
    onTake: (roomId, take) => takes.push({ roomId, take }),
  })
  return { runner, speakers, takes, input: room(overrides) }
}

const flush = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

// ────────────────────────────────────────────────────────────────────────────

test('starting a room brings it up and it speaks', async () => {
  const { runner, input, takes } = makeRunner({ maxRounds: 2 })
  const view = runner.start(input)
  assert.equal(view.status, 'running')
  assert.equal(view.generation, 1)

  await runner['rooms'].get('room-1')?.conductor.idle()
  assert.equal(takes.length, 2, 'two members, two rounds of one speech each')
  assert.deepEqual(takes.map((entry) => entry.take.memberId), ['m-1', 'm-2'])
  // The room pauses itself at the limit, which is the visible outcome.
  assert.equal(runner.view('room-1')?.status, 'paused')
  await runner.disposeAll()
})

test('starting a room twice reuses the same conductor', async () => {
  const { runner, input, speakers } = makeRunner({ maxRounds: 1 })
  runner.start(input)
  runner.start(input)
  await flush()
  assert.equal(speakers.length, 1, 'a second start must not build a second speaker')
  assert.equal(runner.liveRoomIds.length, 1)
  await runner.disposeAll()
})

test('stopping disposes the room and delivery observes it', async () => {
  const { runner, input } = makeRunner({ maxRounds: 2 })
  runner.start(input)
  await runner.stop('room-1')
  assert.equal(runner.view('room-1'), null)
  assert.deepEqual(runner.liveRoomIds, [])
  await runner.stop('room-1')  // idempotent
})

test('an operation on a room that is not running is refused', () => {
  const { runner } = makeRunner()
  assert.throws(() => runner.pause('nope'), /not running/)
  assert.throws(() => runner.pick('nope', 'm-1'), /not running/)
  assert.throws(() => runner.reroll('nope', 'm-1', 1), /not running/)
})

// ────────────────────────────────────────────────────────────────────────────
// The transcript and where a reroll's aim comes from
// ────────────────────────────────────────────────────────────────────────────

test('a reroll resolves its relay from the transcript, not from the caller', async () => {
  // The caller supplies a member and a turn. If the relay were also supplied by
  // the caller, that would be one more way to aim a reroll at the wrong round —
  // and the frozen intent exists precisely so the aim comes from real state.
  const { runner, input, speakers } = makeRunner({ maxRounds: 1 })
  runner.start(input)
  await runner['rooms'].get('room-1')?.conductor.idle()

  // `resume`, not `start`: start opens a new generation and resets the schedule,
  // which races the reroll being tested. The round limit will immediately pause
  // the room again, and a paused room still serves rerolls — which is exactly
  // the behaviour under test.
  runner.resume('room-1')

  const intent = runner.reroll('room-1', 'm-1', 1)
  assert.equal(intent.memberId, 'm-1')
  assert.equal(intent.turnId, 1)
  assert.equal(intent.relaySeq, 1, 'the first take answered relay 1')

  await flush()
  const rerollRequest = speakers[0]?.requests.find((request) => request.kind === 'reroll')
  assert.ok(rerollRequest !== undefined, 'the reroll should have been delivered')
  assert.equal(rerollRequest.relaySeq, intent.relaySeq)
  await runner.disposeAll()
})

test('a reroll for a turn the member never spoke in is refused', async () => {
  const { runner, input } = makeRunner({ maxRounds: 1 })
  runner.start(input)
  await runner['rooms'].get('room-1')?.conductor.idle()

  assert.throws(() => runner.reroll('room-1', 'm-2', 1), /no take in turn 1/)
  assert.throws(() => runner.reroll('room-1', 'm-1', 99), /no take in turn 99/)
  assert.throws(() => runner.reroll('room-1', 'm-1', 0), /integer >= 1/)
  await runner.disposeAll()
})

test('picking a member who is not in the room is refused', async () => {
  const { runner, input } = makeRunner({ maxRounds: 1 })
  runner.start(input)
  assert.throws(() => runner.pick('room-1', 'ghost'), /no member/)
  runner.pick('room-1', 'm-2')
  await runner.disposeAll()
})

test('the view reports the state the scheduler is in', async () => {
  const { runner, input } = makeRunner({ maxRounds: 1 })
  const started = runner.start(input)
  assert.deepEqual(
    Object.keys(started).sort(),
    ['generation', 'pendingRerolls', 'queued', 'roomId', 'round', 'speaker', 'status', 'takeCount', 'turnId'],
  )
  await runner.disposeAll()
})

// ────────────────────────────────────────────────────────────────────────────
// A stored room -> what the runner needs
// ────────────────────────────────────────────────────────────────────────────

test('toRoomInput carries every member field and names the user persona', () => {
  // A member whose persona arrives empty still speaks — just as nobody in
  // particular. Silent, again, which is why the mapping is asserted directly.
  const input = toRoomInput({
    roomId: 'room-1',
    name: '测试群',
    mode: 'free',
    maxRounds: 7,
    userPersona: '（用户是个旅行者）',
    members: [
      { memberId: 'm-1', name: '甲', description: '沉默', personality: '温和', scenario: '雨夜' },
      { memberId: 'm-2', name: '乙', description: '', personality: '', scenario: '' },
    ],
  })

  assert.equal(input.roomId, 'room-1')
  assert.equal(input.mode, 'free')
  assert.equal(input.maxRounds, 7)
  assert.deepEqual(input.members[0], {
    memberId: 'm-1', name: '甲', description: '沉默', personality: '温和', scenario: '雨夜',
  })
  assert.deepEqual(input.members.map((m) => m.memberId), ['m-1', 'm-2'])
  assert.deepEqual(input.macros, { group: '测试群', user: '（用户是个旅行者）' })
})

test('toRoomInput does not put the user persona on a member', () => {
  // `{{user}}` and `{{char}}` are different people. Conflating them would have
  // every member answering as the user.
  const input = toRoomInput({
    roomId: 'r', name: 'g', mode: 'round-robin', maxRounds: 0, userPersona: 'USER',
    members: [{ memberId: 'm', name: 'CHAR', description: '', personality: '', scenario: '' }],
  })
  assert.equal(input.macros?.user, 'USER')
  assert.notEqual(input.macros?.user, input.members[0]?.name)
})
