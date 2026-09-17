/**
 * The agent adapter's own rules, exercised with a fake runtime.
 *
 * The unverifiable part of this project is the model call. Everything wrapped
 * around it is not, and that is where the legacy project's bugs lived: an agent
 * leaked across a generation boundary, two spawns for one member, a reroll that
 * answered the wrong line, a persona that killed every request.
 *
 * Run: node --test tests/speaker.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isReject } from '@dsh-tavern/contracts'
import type { SpeakRequest } from '../src/conductor.ts'
import { AgentSpeaker } from '../src/speaker.ts'
import type { MemberAgent, MemberRuntime, MemberSpec, SpawnOptions, TranscriptPort } from '../src/speaker.ts'

// ────────────────────────────────────────────────────────────────────────────
// Fakes
// ────────────────────────────────────────────────────────────────────────────

class FakeAgent implements MemberAgent {
  readonly relays: string[] = []
  disposals = 0
  reply: string = 'reply'

  async deliver(relay: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('aborted')
    this.relays.push(relay)
    return this.reply
  }

  async dispose(): Promise<void> {
    this.disposals += 1
  }
}

class FakeRuntime implements MemberRuntime {
  readonly spawns: SpawnOptions[] = []
  readonly agents: FakeAgent[] = []
  failNextSpawn = false
  /** When set, `spawn` waits for the test to release it. */
  hold: (() => void) | null = null

  async spawn(options: SpawnOptions): Promise<MemberAgent> {
    if (this.failNextSpawn) {
      this.failNextSpawn = false
      throw new Error('spawn failed')
    }
    if (this.hold !== null) {
      await new Promise<void>((resolve) => { this.hold = resolve })
    }
    this.spawns.push(options)
    const agent = new FakeAgent()
    this.agents.push(agent)
    return agent
  }
}

class FakeTranscript implements TranscriptPort {
  readonly lines = new Map<number, string>()
  newest: string | null = null

  line(relaySeq: number): string | null {
    return this.lines.get(relaySeq) ?? null
  }

  latest(): string | null {
    return this.newest
  }
}

const MEMBERS: readonly MemberSpec[] = [
  { memberId: 'm-1', name: '甲', description: '沉默', personality: '', scenario: '' },
  { memberId: 'm-2', name: '乙', description: '', personality: '急躁', scenario: '' },
]

function request(overrides: Partial<SpeakRequest> = {}): SpeakRequest {
  return {
    kind: 'speak',
    roomId: 'room-1',
    memberId: 'm-1',
    turnId: 1,
    relaySeq: 7,
    generation: 1,
    intentId: null,
    ...overrides,
  }
}

function makeSpeaker(overrides: Partial<{
  runtime: FakeRuntime
  transcript: FakeTranscript
  members: () => readonly MemberSpec[]
}> = {}) {
  const runtime = overrides.runtime ?? new FakeRuntime()
  const transcript = overrides.transcript ?? new FakeTranscript()
  transcript.newest ??= '上一句'
  const speaker = new AgentSpeaker({
    roomName: '测试群',
    runtime,
    transcript,
    members: overrides.members ?? (() => MEMBERS),
  })
  return { speaker, runtime, transcript }
}

const signal = (): AbortSignal => new AbortController().signal

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection, but the call resolved')
}

// ────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ────────────────────────────────────────────────────────────────────────────

test('one agent per member, reused across deliveries', async () => {
  const { speaker, runtime } = makeSpeaker()

  await speaker.produce(request(), signal())
  await speaker.produce(request(), signal())

  assert.equal(runtime.spawns.length, 1, 'the second delivery must reuse the agent')
  assert.equal(speaker.liveCount, 1)
  assert.deepEqual(runtime.agents[0]?.relays, ['m-1：上一句', 'm-1：上一句'])
})

test('a new generation disposes the old agent before spawning a new one', async () => {
  // Member agents do not survive a restart or a stop. Holding both would leak
  // one, which is the bug this ordering exists to prevent.
  const { speaker, runtime, transcript } = makeSpeaker()

  await speaker.produce(request({ generation: 1 }), signal())
  transcript.newest = '新一代'
  await speaker.produce(request({ generation: 2 }), signal())

  assert.equal(runtime.spawns.length, 2)
  assert.equal(runtime.agents[0]?.disposals, 1, 'the old agent must be disposed')
  assert.equal(runtime.agents[1]?.disposals, 0)
  assert.equal(speaker.liveCount, 1)
  assert.equal(runtime.spawns[1]?.generation, 2)
})

test('two concurrent deliveries for one member spawn a single agent', async () => {
  // The legacy double-spawn: the slot was claimed after an await, so two callers
  // both found it empty. In-flight spawns are shared here.
  const runtime = new FakeRuntime()
  let release: (() => void) | undefined
  runtime.hold = () => { /* replaced below */ }
  const gate = new Promise<void>((resolve) => { release = resolve })
  runtime.spawn = async function spawn(options: SpawnOptions): Promise<MemberAgent> {
    await gate
    this.spawns.push(options)
    const agent = new FakeAgent()
    this.agents.push(agent)
    return agent
  }

  const { speaker } = makeSpeaker({ runtime })
  const both = Promise.all([
    speaker.produce(request(), signal()),
    speaker.produce(request(), signal()),
  ])
  release?.()
  await both

  assert.equal(runtime.spawns.length, 1, 'exactly one agent for one member')
  assert.equal(speaker.liveCount, 1)
})

test('disposeAll releases every agent and is idempotent', async () => {
  const { speaker, runtime } = makeSpeaker()
  await speaker.produce(request({ memberId: 'm-1' }), signal())
  await speaker.produce(request({ memberId: 'm-2' }), signal())
  assert.equal(speaker.liveCount, 2)

  await speaker.disposeAll()
  await speaker.disposeAll()

  assert.equal(speaker.liveCount, 0)
  for (const agent of runtime.agents) assert.equal(agent.disposals, 1, 'disposed exactly once')
})

test('a delivery after disposal is refused', async () => {
  const { speaker } = makeSpeaker()
  await speaker.disposeAll()
  const error = await rejection(speaker.produce(request(), signal()))
  assert.ok(isReject(error))
  assert.equal(error.field, 'speaker')
})

test('an agent finishing after disposal is disposed rather than leaked', async () => {
  const runtime = new FakeRuntime()
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  runtime.spawn = async function spawn(options: SpawnOptions): Promise<MemberAgent> {
    await gate
    this.spawns.push(options)
    const agent = new FakeAgent()
    this.agents.push(agent)
    return agent
  }

  const { speaker } = makeSpeaker({ runtime })
  const inFlight = speaker.produce(request(), signal()).catch(() => undefined)
  await speaker.disposeAll()
  release?.()
  await inFlight

  assert.equal(speaker.liveCount, 0, 'nothing may be left live after disposal')
  assert.equal(runtime.agents[0]?.disposals, 1, 'the late agent must still be disposed')
})

// ────────────────────────────────────────────────────────────────────────────
// Which line a delivery answers
// ────────────────────────────────────────────────────────────────────────────

test('a speech answers the room\'s newest line', async () => {
  const { speaker, runtime, transcript } = makeSpeaker()
  transcript.newest = '最新的'
  await speaker.produce(request({ kind: 'speak' }), signal())
  assert.equal(runtime.agents[0]?.relays[0], 'm-1：最新的')
})

test('a reroll answers the pinned relay, not the newest line', async () => {
  // This is where `RerollIntent`'s whole purpose would be thrown away: looking
  // up "the latest relay" for a reroll is exactly the bug that put replacement
  // text in the wrong round.
  const { speaker, runtime, transcript } = makeSpeaker()
  transcript.newest = '最新的'
  transcript.lines.set(3, '被点的那一句')

  await speaker.produce(request({ kind: 'reroll', relaySeq: 3, intentId: 'intent-1' }), signal())
  assert.equal(runtime.agents[0]?.relays[0], 'm-1：被点的那一句')
})

test('a reroll whose relay is gone is refused rather than answering something else', async () => {
  const { speaker, runtime } = makeSpeaker()
  const error = await rejection(
    speaker.produce(request({ kind: 'reroll', relaySeq: 99, intentId: 'intent-1' }), signal()),
  )
  assert.ok(isReject(error))
  assert.equal(error.field, 'relaySeq')
  assert.equal(runtime.agents.length, 0, 'nothing should have been spawned for a refused relay')
})

test('a speech in an empty room opens the scene instead of being refused', async () => {
  // It was refused once, which looked obviously right in isolation and made an
  // empty room impossible to start — found when the runner was wired up.
  const transcript = new FakeTranscript()
  const { speaker, runtime } = makeSpeaker({ transcript })
  transcript.newest = null

  await speaker.produce(request(), signal())
  const relay = runtime.agents[0]?.relays[0] ?? ''
  assert.match(relay, /还没有人说话/)
  assert.ok(!relay.startsWith('m-1：'), 'an opening must not be prefixed with the speaker name')
})

test('a reroll in an empty room is still refused', async () => {
  // The distinction is the point: a speech can start from nothing, a reroll
  // cannot replace a take that does not exist.
  const transcript = new FakeTranscript()
  const { speaker } = makeSpeaker({ transcript })
  transcript.newest = null
  const error = await rejection(
    speaker.produce(request({ kind: 'reroll', relaySeq: 9, intentId: 'intent-1' }), signal()),
  )
  assert.ok(isReject(error))
  assert.equal(error.field, 'relaySeq')
})

// ────────────────────────────────────────────────────────────────────────────
// Membership
// ────────────────────────────────────────────────────────────────────────────

test('an unknown member is refused loudly', async () => {
  const { speaker, runtime } = makeSpeaker()
  const error = await rejection(speaker.produce(request({ memberId: 'ghost' }), signal()))
  assert.ok(isReject(error))
  assert.equal(error.field, 'memberId')
  assert.equal(runtime.spawns.length, 0)
})

test('membership is re-read on every delivery, not snapshotted', async () => {
  // A snapshot taken once is the staleness the legacy project kept re-fixing.
  let members: readonly MemberSpec[] = [MEMBERS[0] as MemberSpec]
  const { speaker } = makeSpeaker({ members: () => members })

  await speaker.produce(request({ memberId: 'm-1' }), signal())
  const before = await rejection(speaker.produce(request({ memberId: 'm-2' }), signal()))
  assert.ok(isReject(before), 'm-2 is not a member yet')

  members = MEMBERS
  await speaker.produce(request({ memberId: 'm-2' }), signal())
  assert.equal(speaker.liveCount, 2)
})

// ────────────────────────────────────────────────────────────────────────────
// Prompt safety at the port
// ────────────────────────────────────────────────────────────────────────────

test('the text handed to the runtime contains no "{{", even from hostile input', async () => {
  // The persona guarantee, asserted where it matters: at the boundary a real
  // runtime would place into prompt sections. A `{{char}}` left intact here
  // would make every request for this member fail.
  const members: readonly MemberSpec[] = [{
    memberId: 'm-1',
    name: '甲{{char}}',
    description: 'likes {{model}} and {{unknown}} and {{ bad }}',
    personality: '{{',
    scenario: '{{group}}',
  }]
  const { speaker, runtime } = makeSpeaker({ members: () => members })

  await speaker.produce(request(), signal())

  const spawn = runtime.spawns[0]
  assert.ok(spawn !== undefined)
  assert.ok(!spawn.personaText.includes('{{'), `persona leaked a macro:\n${spawn.personaText}`)
  assert.ok(!spawn.briefingText.includes('{{'), `briefing leaked a macro:\n${spawn.briefingText}`)
  // And the known one still resolved, so this is not merely deletion.
  assert.match(spawn.personaText, /甲甲/)
})

test('the briefing lists the room roster', async () => {
  const { speaker, runtime } = makeSpeaker()
  await speaker.produce(request(), signal())
  const briefingText = runtime.spawns[0]?.briefingText ?? ''
  assert.match(briefingText, /测试群/)
  assert.match(briefingText, /甲/)
  assert.match(briefingText, /乙/)
})

// ────────────────────────────────────────────────────────────────────────────
// Failure and abort
// ────────────────────────────────────────────────────────────────────────────

test('a spawn failure propagates so the loop can count it', async () => {
  // Swallowing it would make the failure budget blind and the room would spin.
  const runtime = new FakeRuntime()
  runtime.failNextSpawn = true
  const { speaker } = makeSpeaker({ runtime })
  await assert.rejects(speaker.produce(request(), signal()), /spawn failed/)
})

test('an aborted signal rejects the delivery', async () => {
  const { speaker, runtime } = makeSpeaker()
  await speaker.produce(request({ memberId: 'm-1' }), signal())

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(speaker.produce(request({ memberId: 'm-1' }), controller.signal), /aborted/)
  assert.equal(runtime.spawns.length, 1, 'an abort must not spawn a replacement')
})
