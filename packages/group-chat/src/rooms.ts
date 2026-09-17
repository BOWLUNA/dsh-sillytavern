/**
 * Rooms: one conductor each, and the transcript they share.
 *
 * This is the layer between the scheduler (which decides what should happen) and
 * the service (which speaks RPC). It is platform-free on purpose — the one thing
 * it cannot supply is a `Speaker`, and that arrives through `SpeakerFactory`. So
 * the room lifecycle, the transcript, and the reroll plumbing are all testable
 * without a model; the model is one injected function.
 *
 * @module dsh-group-chat/rooms
 */

import { reject } from '@dsh-tavern/contracts'
import { Conductor } from './conductor.ts'
import type { Speaker, Take } from './conductor.ts'
import type { RerollIntent } from './intent.ts'
import { relayLine } from './prompt.ts'
import type { SchedulerState, TurnMode } from './scheduler.ts'
import type { MemberSpec } from './speaker.ts'
import type { TranscriptPort } from './speaker.ts'

/** Everything a runner needs to bring one room up. */
export interface RoomInput {
  readonly roomId: string
  readonly name: string
  readonly mode: TurnMode
  readonly members: readonly MemberSpec[]
  readonly maxRounds: number
  /** Values for `{{…}}` in member personas. */
  readonly macros?: Readonly<Record<string, string>>
}

/**
 * Builds the speaker for one room.
 *
 * The only part of this module that needs a model, and therefore the only part a
 * test substitutes.
 */
export type SpeakerFactory = (
  room: RoomInput,
  transcript: TranscriptPort,
  takes: () => readonly Take[],
) => Speaker

export interface RoomRuntime {
  readonly speakerFor: SpeakerFactory
  readonly nextId: () => string
  readonly now?: () => number
  readonly failureBudget?: number
  readonly onTake?: (roomId: string, take: Take) => void
  readonly onStatus?: (roomId: string, state: SchedulerState) => void
  readonly onFailure?: (roomId: string, error: unknown) => void
}

/** What the wire reports about one room. Every field required: no holes. */
export interface RoomView {
  readonly roomId: string
  readonly status: SchedulerState['status']
  readonly turnId: number
  readonly generation: number
  readonly round: number
  readonly speaker: string | null
  readonly queued: number
  readonly pendingRerolls: number
  readonly takeCount: number
}

/** One room's live state. */
interface LiveRoom {
  readonly input: RoomInput
  readonly conductor: Conductor
  readonly takes: Take[]
  /** `relaySeq` → the line that relay carried, for pinning a reroll. */
  readonly lines: Map<number, string>
}

/**
 * The fields a room record contributes to a runner input.
 *
 * Structural rather than `RoomRecord`, so this module stays free of the zod
 * schema and of the platform — and so the test can supply a literal.
 *
 * The failure mode here is also silence: a member whose persona arrives empty
 * still speaks, just as nobody in particular.
 */
export interface RoomRecordLike {
  readonly roomId: string
  readonly name: string
  readonly mode: TurnMode
  readonly maxRounds: number
  readonly userPersona: string
  readonly members: readonly {
    readonly memberId: string
    readonly name: string
    readonly description: string
    readonly personality: string
    readonly scenario: string
  }[]
}

/** Map a stored room to what the runner needs. */
export function toRoomInput(record: RoomRecordLike): RoomInput {
  return {
    roomId: record.roomId,
    name: record.name,
    mode: record.mode,
    maxRounds: record.maxRounds,
    members: record.members.map((member) => ({
      memberId: member.memberId,
      name: member.name,
      description: member.description,
      personality: member.personality,
      scenario: member.scenario,
    })),
    // `user` is the room's user persona, not a member: a member answering as the
    // user would put words in the user's mouth.
    macros: { group: record.name, user: record.userPersona },
  }
}

export class RoomRunner {
  private readonly runtime: RoomRuntime
  private readonly rooms = new Map<string, LiveRoom>()

  constructor(runtime: RoomRuntime) {
    this.runtime = runtime
  }

  /** Room ids currently up. */
  get liveRoomIds(): readonly string[] {
    return [...this.rooms.keys()]
  }

  /**
   * Bring a room up, or return the one already up.
   *
   * Starting is idempotent because the UI's start button is not the only caller:
   * a resumed session, a retry after a failure, and a user clicking twice all
   * arrive here, and none of them wants a second conductor for one room.
   */
  start(input: RoomInput): RoomView {
    const existing = this.rooms.get(input.roomId)
    if (existing !== undefined) {
      existing.conductor.start()
      return toView(existing)
    }

    const takes: Take[] = []
    const lines = new Map<number, string>()
    const byId = new Map(input.members.map((member) => [member.memberId, member]))

    const transcript: TranscriptPort = {
      // A reroll resolves the relay it pinned. Absent means the take it named is
      // gone, and the speaker refuses rather than answering something else.
      line: (relaySeq) => lines.get(relaySeq) ?? null,
      latest: () => {
        let best: Take | undefined
        for (const take of takes) {
          if (best === undefined || take.relaySeq > best.relaySeq) best = take
        }
        if (best === undefined) return null
        const name = byId.get(best.memberId)?.name ?? best.memberId
        return relayLine(name, best.text)
      },
    }

    const conductor = new Conductor({
      roomId: input.roomId,
      mode: input.mode,
      order: input.members.map((member) => member.memberId),
      maxRounds: input.maxRounds,
      speaker: this.runtime.speakerFor(input, transcript, () => takes),
      nextId: this.runtime.nextId,
      ...(this.runtime.now === undefined ? {} : { now: this.runtime.now }),
      ...(this.runtime.failureBudget === undefined ? {} : { failureBudget: this.runtime.failureBudget }),
      onTake: (take) => {
        takes.push(take)
        // The line a relay carried is what the *next* member answers, and what a
        // later reroll may pin. Recorded once, read by both.
        const name = byId.get(take.memberId)?.name ?? take.memberId
        lines.set(take.relaySeq, relayLine(name, take.text))
        this.runtime.onTake?.(input.roomId, take)
      },
      onStatus: (state) => this.runtime.onStatus?.(input.roomId, state),
      onFailure: (error) => this.runtime.onFailure?.(input.roomId, error),
    })

    this.rooms.set(input.roomId, { input, conductor, takes, lines })
    conductor.start()
    return toView(this.require(input.roomId))
  }

  /** Stop a room and wait for its in-flight delivery to observe it. */
  async stop(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId)
    if (room === undefined) return
    await room.conductor.stop()
    this.rooms.delete(roomId)
  }

  pause(roomId: string): RoomView {
    this.require(roomId).conductor.pause()
    return toView(this.require(roomId))
  }

  resume(roomId: string): RoomView {
    this.require(roomId).conductor.resume()
    return toView(this.require(roomId))
  }

  pick(roomId: string, memberId: unknown): RoomView {
    const room = this.require(roomId)
    if (typeof memberId !== 'string' || !room.input.members.some((m) => m.memberId === memberId)) {
      reject('memberId', `no member ${JSON.stringify(memberId)} in room ${roomId}`)
    }
    room.conductor.pick(memberId)
    return toView(room)
  }

  /**
   * Reroll one member's take from one turn.
   *
   * The relay is resolved here, from the transcript, rather than accepted from
   * the caller. A UI-supplied sequence number would be one more way to aim a
   * reroll at the wrong round, and the whole point of the frozen intent is that
   * the aim is decided from authoritative state.
   */
  reroll(roomId: string, memberId: unknown, turnId: unknown): RerollIntent {
    const room = this.require(roomId)
    if (typeof memberId !== 'string') reject('memberId', 'must be a string')
    if (typeof turnId !== 'number' || !Number.isInteger(turnId) || turnId < 1) {
      reject('turnId', 'must be an integer >= 1')
    }

    const take = [...room.takes]
      .reverse()
      .find((candidate) => candidate.memberId === memberId && candidate.turnId === turnId)
    if (take === undefined) {
      reject('turnId', `member ${JSON.stringify(memberId)} has no take in turn ${turnId}`)
    }

    return room.conductor.reroll({
      roomId,
      memberId,
      turnId,
      relaySeq: take.relaySeq,
    })
  }

  view(roomId: string): RoomView | null {
    const room = this.rooms.get(roomId)
    return room === undefined ? null : toView(room)
  }

  takes(roomId: string): readonly Take[] {
    return this.rooms.get(roomId)?.takes ?? []
  }

  /** Release every room. Idempotent. */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.rooms.keys()].map((roomId) => this.stop(roomId)))
  }

  private require(roomId: string): LiveRoom {
    const room = this.rooms.get(roomId)
    if (room === undefined) reject('roomId', `room ${JSON.stringify(roomId)} is not running`)
    return room
  }
}

function toView(room: LiveRoom): RoomView {
  const state = room.conductor.state
  return {
    roomId: room.input.roomId,
    status: state.status,
    turnId: state.turnId,
    generation: state.generation,
    round: state.round,
    speaker: state.speaker,
    queued: state.queue.length,
    pendingRerolls: state.pending.length,
    takeCount: room.takes.length,
  }
}
