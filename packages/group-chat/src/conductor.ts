/**
 * The delivery loop: the thing that actually consumes the scheduler.
 *
 * `scheduler.ts` decides *what* should happen; this drives it. It is small on
 * purpose, and it is written so that the loop's own rules can be tested without
 * a model, a network, or an agent.
 *
 * ## The `Speaker` port
 *
 * The loop never talks to an agent directly. It asks a `Speaker` to produce a
 * take for a request, and that is the whole interface. Two reasons:
 *
 *   1. **The loop is testable.** Member agents need credentials and a model, so
 *      anything that only works end to end would be verified by hand at best —
 *      which is how the legacy project ended up with a scheduler whose
 *      concurrency rules nobody had ever exercised.
 *   2. **The agent wiring stays thin.** Creating agents, mounting presets and
 *      streaming responses is one adapter. If a bug turns out to be in the loop,
 *      no part of that adapter is implicated.
 *
 * ## What the legacy conductor got wrong, and what prevents it here
 *
 *   - *Two replays both held the floor.* The floor is taken by a synchronous
 *     `claim` before any `await`, and `pump` is single-flight, so there is no
 *     window in which two deliveries exist.
 *   - *A failed delivery froze the carousel.* Failure settles as `failed`, which
 *     re-queues the work; the loop then tries the next thing.
 *   - *Retry storms.* A failing speaker would otherwise spin as fast as the
 *     microtask queue allows — the legacy test harness hit exactly this and had
 *     to suspend its mock until abort. A consecutive-failure budget pauses the
 *     room instead, leaving the work queued and the state inspectable.
 *   - *A stop that landed mid-delivery was ignored.* The outcome is settled into
 *     the stopped state, which discards it rather than re-queueing work the user
 *     cancelled.
 *
 * @module dsh-group-chat/conductor
 */

import { freezeRerollIntent } from './intent.ts'
import type { RerollIntent, RerollRequest } from './intent.ts'
import {
  acceptReroll,
  beginGeneration,
  claim,
  createScheduler,
  nextDelivery,
  pause as pauseRoom,
  pick as pickMember,
  resume as resumeRoom,
  settle,
  start as startRoom,
  stop as stopRoom,
} from './scheduler.ts'
import type { Delivery, SchedulerState, TurnMode } from './scheduler.ts'

/**
 * What a speaker is asked for. Everything needed is in the request.
 *
 * `kind` uses the **same two words as `Delivery`** — `'speak'` and `'reroll'` —
 * and that is deliberate. An earlier draft of this file said `'speech'` here
 * while the scheduler said `'speak'`, and the mismatch made a cursor increment
 * unreachable: `delivery.kind === 'speech'` is never true, so relay sequence
 * numbers silently stopped advancing. Type stripping did not care, and a
 * typecheck only catches it if the branch is typed — not the point. Two names
 * for one concept is not a style question; it is a bug generator.
 */
export interface SpeakRequest {
  readonly kind: 'speak' | 'reroll'
  readonly roomId: string
  readonly memberId: string
  /** The turn this take belongs to. For a reroll, the turn that was clicked. */
  readonly turnId: number
  /** The relay being answered. For a reroll, the relay that was clicked. */
  readonly relaySeq: number
  readonly generation: number
  /** Set only for a reroll. */
  readonly intentId: string | null
}

/** One way to produce a take. The real implementation drives an agent. */
export interface Speaker {
  produce(request: SpeakRequest, signal: AbortSignal): Promise<{ text: string }>
}

/** A recorded take. This log is what a transcript view reads. */
export interface Take {
  readonly takeId: string
  readonly memberId: string
  readonly turnId: number
  readonly relaySeq: number
  readonly text: string
  readonly kind: 'speak' | 'reroll'
  readonly intentId: string | null
  readonly generation: number
  readonly at: number
}

export interface ConductorOptions {
  readonly roomId: string
  readonly mode: TurnMode
  readonly order: readonly string[]
  readonly maxRounds: number
  readonly speaker: Speaker
  /** Injected so the core stays deterministic under test. */
  readonly nextId: () => string
  readonly now?: () => number
  /**
   * Consecutive delivery failures tolerated before the room pauses itself.
   * Without a bound, a persistently failing speaker spins.
   */
  readonly failureBudget?: number
  readonly onTake?: (take: Take) => void
  readonly onStatus?: (state: SchedulerState) => void
  /**
   * Called for every failed delivery. `request` is `null` only for a fault in
   * the loop itself, where no request was ever formed.
   */
  readonly onFailure?: (error: unknown, request: SpeakRequest | null) => void
}

const DEFAULT_FAILURE_BUDGET = 3

/** The deliveries that actually produce a take. */
type SpeakingDelivery = Extract<Delivery, { kind: 'speak' | 'reroll' }>

export class Conductor {
  readonly roomId: string
  private readonly speaker: Speaker
  private readonly nextId: () => string
  private readonly now: () => number
  private readonly failureBudget: number
  private readonly onTake: ((take: Take) => void) | undefined
  private readonly onStatus: ((state: SchedulerState) => void) | undefined
  private readonly onFailure: ((error: unknown, request: SpeakRequest | null) => void) | undefined

  /** The live scheduler state. Read it through the `state` getter. */
  private current: SchedulerState
  private readonly takeLog: Take[] = []
  /** Single-flight guard: at most one delivery is ever in flight per room. */
  private pumping: Promise<void> | null = null
  /** Set when a kick arrives during a run, so the run repeats instead of dropping it. */
  private kicked = false
  /** The in-flight delivery's cancellation handle, if any. */
  private inflight: AbortController | null = null
  private consecutiveFailures = 0
  /** Relay sequence for the next speech. Only successful speeches consume one. */
  private relayCursor = 1
  /** Whether this conductor has been started before, for generation handling. */
  private hasRunBefore = false

  constructor(options: ConductorOptions) {
    this.roomId = options.roomId
    this.speaker = options.speaker
    this.nextId = options.nextId
    this.now = options.now ?? (() => Date.now())
    this.failureBudget = options.failureBudget ?? DEFAULT_FAILURE_BUDGET
    this.onTake = options.onTake
    this.onStatus = options.onStatus
    this.onFailure = options.onFailure
    this.current = createScheduler({
      mode: options.mode,
      order: options.order,
      maxRounds: options.maxRounds,
    })
  }

  // ── reads ────────────────────────────────────────────────────────────────

  get state(): SchedulerState {
    return this.current
  }

  /** Every take produced, oldest first. Survives stops; it is a transcript. */
  get takes(): readonly Take[] {
    return this.takeLog
  }

  /** Whether a delivery is currently in flight. */
  get busy(): boolean {
    return this.inflight !== null
  }

  /**
   * Resolve once no delivery is in flight and none was scheduled behind it.
   *
   * A delivery can settle into a state that schedules another, so this drains
   * rather than awaiting one promise. Tests use it to observe a quiescent room;
   * a UI uses it to know when a spurt of activity has finished.
   */
  async idle(): Promise<void> {
    let current = this.pumping
    while (current !== null) {
      await current
      current = this.pumping
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start the room.
   *
   * Starting from `stopped` opens a new generation, which voids every queued
   * reroll: member agents do not survive a stop, so the takes those intents name
   * no longer exist.
   */
  start(): void {
    if (this.hasRunBefore) {
      // Starting again is a new generation. Member agents do not survive a stop,
      // so every queued reroll names takes that no longer exist.
      this.commit(beginGeneration(this.current))
      this.relayCursor = 1
      this.consecutiveFailures = 0
    }
    this.hasRunBefore = true
    this.commit(startRoom(this.current))
    void this.pump()
  }

  /** Stop advancing. An in-flight delivery is left to finish. */
  pause(): void {
    this.commit(pauseRoom(this.current))
  }

  resume(): void {
    this.commit(resumeRoom(this.current))
    void this.pump()
  }

  /**
   * Stop the room and wait for any in-flight delivery to observe it.
   *
   * Awaiting matters: a caller that starts a new room immediately after would
   * otherwise race the old delivery's settlement. The legacy project's version
   * of this race is why a stop could be followed by one more speech.
   */
  async stop(): Promise<void> {
    this.commit(stopRoom(this.current))
    this.relayCursor = 1
    this.consecutiveFailures = 0
    this.inflight?.abort()
    await this.pumping
  }

  // ── requests ─────────────────────────────────────────────────────────────

  /** Free mode: point at a member. */
  pick(memberId: string): void {
    this.commit(pickMember(this.current, memberId))
    void this.pump()
  }

  /**
   * Queue a reroll for exactly what the user clicked.
   *
   * @throws {RejectError} when the request cannot be pinned, when the room is
   *   stopped, or when that member and turn already have one queued.
   */
  reroll(request: RerollRequest): RerollIntent {
    const intent = freezeRerollIntent(request, {
      generation: this.current.generation,
      now: this.now(),
      nextIntentId: this.nextId,
    })
    this.commit(acceptReroll(this.current, intent).state)
    void this.pump()
    return intent
  }

  // ── the loop ─────────────────────────────────────────────────────────────

  /**
   * Kick the loop. Concurrent calls share the in-flight run, but are not lost.
   *
   * The subtlety, found when the room runner was wired up: a pump decides
   * "nothing more to do" and returns, and a request accepted *while it was
   * running* then finds `pumping` non-null, gets handed the already-finishing
   * promise, and is never scheduled. The work sits in the queue with no error
   * anywhere — the same silently-shelved shape the legacy project kept
   * rediscovering.
   *
   * So a concurrent kick is recorded, and the run repeats at least once more.
   * One extra pass is enough: a kick that arrives during that pass sets the flag
   * again, and the loop continues until a pass completes with no kick.
   */
  private pump(): Promise<void> {
    if (this.pumping !== null) {
      this.kicked = true
      return this.pumping
    }

    const run = (async () => {
      do {
        this.kicked = false
        await this.runLoop()
      } while (this.kicked)
    })().finally(() => {
      this.pumping = null
    })

    this.pumping = run
    return run
  }

  /**
   * One delivery at a time until there is nothing schedulable left.
   *
   * Never rejects: an unexpected throw would otherwise surface as an unhandled
   * rejection on a `void this.pump()` call, which is the quietest possible way
   * for a room to stop working.
   */
  private async runLoop(): Promise<void> {
    try {
      for (;;) {
        const delivery = nextDelivery(this.current)
        if (delivery.kind === 'idle' || delivery.kind === 'await-pick') return
        if (delivery.kind === 'round-limit') {
          // The carousel reached its configured bound. Pausing is the visible
          // outcome; the UI shows the count and offers to resume.
          this.pause()
          return
        }

        const request = this.requestFor(delivery)
        this.commit(claim(this.current, delivery))

        const controller = new AbortController()
        this.inflight = controller
        try {
          const { text } = await this.speaker.produce(request, controller.signal)
          this.inflight = null
          this.commit(settle(this.current, delivery, 'ok'))
          this.consecutiveFailures = 0
          if (delivery.kind === 'speak') this.relayCursor += 1
          this.record(request, text)
        } catch (error) {
          this.inflight = null
          this.commit(settle(this.current, delivery, 'failed'))
          this.consecutiveFailures += 1
          this.onFailure?.(error, request)

          // A stop landed while we waited: `settle` discarded the work. Done.
          if (this.current.status === 'stopped') return

          if (this.consecutiveFailures >= this.failureBudget) {
            // Stop retrying rather than spinning. The work stays queued and the
            // room stays inspectable, so this is recoverable rather than fatal.
            this.pause()
            return
          }
        }
      }
    } catch (error) {
      // Defensive: a bug in the loop must not look like a stall. Reported with a
      // null request rather than a fabricated one, so nobody debugs a phantom.
      this.pause()
      this.onFailure?.(error, null)
    }
  }

  private requestFor(delivery: SpeakingDelivery): SpeakRequest {
    if (delivery.kind === 'reroll') {
      // Everything comes from the frozen intent, never from current state.
      return {
        kind: 'reroll',
        roomId: this.roomId,
        memberId: delivery.memberId,
        turnId: delivery.intent.turnId,
        relaySeq: delivery.intent.relaySeq,
        generation: this.current.generation,
        intentId: delivery.intent.intentId,
      }
    }
    return {
      kind: 'speak',
      roomId: this.roomId,
      memberId: delivery.memberId,
      turnId: this.current.turnId,
      relaySeq: this.relayCursor,
      generation: this.current.generation,
      intentId: null,
    }
  }

  private record(request: SpeakRequest, text: string): void {
    const take: Take = {
      takeId: this.nextId(),
      memberId: request.memberId,
      turnId: request.turnId,
      relaySeq: request.relaySeq,
      text,
      kind: request.kind,
      intentId: request.intentId,
      generation: request.generation,
      at: this.now(),
    }
    this.takeLog.push(take)
    this.onTake?.(take)
  }

  private commit(next: SchedulerState): void {
    this.current = next
    this.onStatus?.(next)
  }
}
