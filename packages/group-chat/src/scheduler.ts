/**
 * The turn scheduler: who speaks next, and when a frozen reroll is delivered.
 *
 * ## Why this is a pure state machine
 *
 * The legacy conductor was a 1 950-line class whose scheduling, fork-replay and
 * reroll logic shared mutable fields across `await` boundaries. Four separate
 * audit rounds produced bugs from that: a floor claimed *after* an await (so two
 * forks could both hold it), a failed drain that returned without scheduling the
 * next step (a carousel that froze with no error), and a reroll that recomputed
 * its target when it finally ran instead of using the one it was accepted with.
 *
 * None of those are expressible here. Transitions are pure functions of
 * `(state, input)`, the floor is claimed **synchronously and explicitly**, and
 * anything in flight is carried as a value rather than looked up again. A host
 * half performs the effects; this module decides what they are.
 *
 * @module dsh-group-chat/scheduler
 */

import { reject } from '@dsh-tavern/contracts'
import { hasPending, isIntentLive, rerollKey } from './intent.ts'
import type { RerollIntent } from './intent.ts'

export type TurnMode = 'round-robin' | 'free'
export type RoomStatus = 'stopped' | 'running' | 'paused'

export interface SchedulerConfig {
  readonly mode: TurnMode
  readonly order: readonly string[]
  /** `0` means unlimited. */
  readonly maxRounds: number
}

export interface SchedulerState {
  readonly status: RoomStatus
  readonly mode: TurnMode
  readonly order: readonly string[]
  readonly generation: number
  /** The current turn. Always `>= 1`, matching the platform's own requirement. */
  readonly turnId: number
  /** The member holding the floor, or `null`. The concurrency claim, made explicit. */
  readonly speaker: string | null
  /** Members waiting for the floor, in order. */
  readonly queue: readonly string[]
  /** Accepted rerolls, oldest first. Each carries its own turn and relay. */
  readonly pending: readonly RerollIntent[]
  /** Free mode: the member the user picked, honoured once the floor frees. */
  readonly picked: string | null
  readonly round: number
  readonly maxRounds: number
}

/** What the host half should do next. Decided here, performed there. */
export type Delivery =
  | { readonly kind: 'reroll'; readonly memberId: string; readonly intent: RerollIntent }
  | { readonly kind: 'speak'; readonly memberId: string }
  | { readonly kind: 'await-pick' }
  | { readonly kind: 'round-limit' }
  | { readonly kind: 'idle' }

export function createScheduler(config: SchedulerConfig): SchedulerState {
  if (config.mode !== 'round-robin' && config.mode !== 'free') {
    reject('mode', `must be "round-robin" or "free", got ${String(config.mode)}`)
  }
  if (!Number.isInteger(config.maxRounds) || config.maxRounds < 0) {
    reject('maxRounds', `must be an integer >= 0, got ${String(config.maxRounds)}`)
  }
  const seen = new Set<string>()
  for (const memberId of config.order) {
    if (seen.has(memberId)) reject('order', `duplicates member ${JSON.stringify(memberId)}`)
    seen.add(memberId)
  }
  return {
    status: 'stopped',
    mode: config.mode,
    order: [...config.order],
    generation: 1,
    turnId: 1,
    speaker: null,
    // Seeded from the order: round-robin's first delivery is the first member in
    // it, and a completed speech sends the speaker to the back.
    queue: [...config.order],
    pending: [],
    picked: null,
    round: 0,
    maxRounds: config.maxRounds,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ────────────────────────────────────────────────────────────────────────────

/**
 * Bring up a new member-agent generation.
 *
 * Member agents do not survive a process restart, so everything keyed to the old
 * generation — queued speakers and accepted rerolls alike — is voided here rather
 * than left to be filtered later. The generation counter is the boundary; an
 * intent from generation N can never be delivered in N+1.
 */
export function beginGeneration(state: SchedulerState): SchedulerState {
  const generation = state.generation + 1
  return {
    ...state,
    status: 'stopped',
    generation,
    turnId: 1,
    speaker: null,
    // A new generation starts a fresh rotation, so the queue is re-seeded from
    // the order rather than left empty.
    queue: [...state.order],
    // Intents from the old generation are dropped here, not merely filtered
    // later: the takes they name belong to member agents that no longer exist.
    pending: state.pending.filter((intent) => isIntentLive(intent, generation)),
    picked: null,
    round: 0,
  }
}

export function start(state: SchedulerState): SchedulerState {
  if (state.status === 'running') return state
  return { ...state, status: 'running' }
}

export function pause(state: SchedulerState): SchedulerState {
  if (state.status === 'stopped') return state
  return { ...state, status: 'paused' }
}

export function resume(state: SchedulerState): SchedulerState {
  if (state.status !== 'paused') return state
  return { ...state, status: 'running' }
}

/** Stop, discarding queued work. An in-flight delivery notices on `settle`. */
export function stop(state: SchedulerState): SchedulerState {
  return { ...state, status: 'stopped', speaker: null, queue: [], pending: [], picked: null }
}

// ────────────────────────────────────────────────────────────────────────────
// Rerolls
// ────────────────────────────────────────────────────────────────────────────

export interface AcceptRerollResult {
  readonly state: SchedulerState
  readonly intent: RerollIntent
}

/**
 * Queue a frozen reroll. Rejects a duplicate (member, turn) pair outright.
 *
 * The legacy project let the second entry overwrite the first, so a second click
 * destroyed the first click's work silently. Refusing is the honest answer: the
 * user can see that their click landed on something already queued.
 */
export function acceptReroll(state: SchedulerState, intent: RerollIntent): AcceptRerollResult {
  if (state.status === 'stopped') {
    reject('reroll', 'the room is stopped; start it before rerolling')
  }
  if (!isIntentLive(intent, state.generation)) {
    reject('reroll', `intent belongs to generation ${intent.generation}, the room is on ${state.generation}`)
  }
  if (hasPending(state.pending, intent)) {
    reject('reroll', `a reroll for that member and turn is already queued (${rerollKey(intent).replace('\u0000', ' / ')})`)
  }
  return { state: { ...state, pending: [...state.pending, intent] }, intent }
}

/** Free mode: record the user's pick. Held until the floor frees. */
export function pick(state: SchedulerState, memberId: string): SchedulerState {
  if (state.status === 'stopped') reject('pick', 'the room is stopped')
  if (!state.order.includes(memberId)) {
    reject('pick', `member ${JSON.stringify(memberId)} is not in this room`)
  }
  // Deliberately not "ignore if someone is speaking": that silently dropped the
  // click. Holding the pick keeps it visible to the UI, which is what tells the
  // user to click again.
  return { ...state, picked: memberId }
}

// ────────────────────────────────────────────────────────────────────────────
// Delivery
// ────────────────────────────────────────────────────────────────────────────

/**
 * What should happen now.
 *
 * Note the drain gate: everything except `stopped` delivers. The legacy gate was
 * `status === 'running'`, which silently shelved a reroll accepted while paused
 * — the click produced no feedback and the work surfaced only after a resume the
 * user had no reason to perform.
 *
 * Rerolls take priority over the round-robin queue: the user asked for this one
 * specifically.
 */
export function nextDelivery(state: SchedulerState): Delivery {
  if (state.status === 'stopped') return { kind: 'idle' }
  if (state.speaker !== null) return { kind: 'idle' }

  const intent = state.pending.find((candidate) => isIntentLive(candidate, state.generation))
  if (intent !== undefined) {
    return { kind: 'reroll', memberId: intent.memberId, intent }
  }

  // Pausing is how the user stops the carousel, so a paused room does not hand
  // out the next speaker. It *does* still serve rerolls — handled above, before
  // this gate — because a reroll is something the user explicitly asked for.
  // The legacy project had exactly this behaviour and it is what people expect;
  // the bug there was a *stopped* room also being gated out, dropping the click.
  if (state.status === 'paused') return { kind: 'idle' }

  // The round limit applies to both modes. It has to be checked before the mode
  // branch, or free mode silently escapes its own bound — which it did until a
  // test caught it.
  if (state.maxRounds > 0 && state.round >= state.maxRounds) return { kind: 'round-limit' }

  if (state.mode === 'free') {
    return state.picked === null ? { kind: 'await-pick' } : { kind: 'speak', memberId: state.picked }
  }

  const next = state.queue[0]
  return next === undefined ? { kind: 'idle' } : { kind: 'speak', memberId: next }
}

/**
 * Take the floor for `delivery`.
 *
 * **Synchronous and explicit by construction.** There is no `await` between
 * deciding to speak and owning the floor, which is what makes the legacy
 * double-fork — two replays both claiming the same slot after their awaits —
 * unrepresentable rather than merely unlikely.
 *
 * @throws when the floor is already held.
 */
export function claim(state: SchedulerState, delivery: Delivery): SchedulerState {
  if (delivery.kind === 'idle' || delivery.kind === 'await-pick' || delivery.kind === 'round-limit') {
    return state
  }
  if (state.speaker !== null) {
    reject('claim', `the floor is already held by ${JSON.stringify(state.speaker)}`)
  }

  if (delivery.kind === 'reroll') {
    return {
      ...state,
      speaker: delivery.memberId,
      // Removed here, not at settle: it is in flight now. A failure re-queues the
      // same frozen object — see `settle`.
      pending: state.pending.filter((intent) => intent.intentId !== delivery.intent.intentId),
    }
  }

  // Round-robin takes the head of the queue; free mode speaks a member who is
  // not queued at all. Filtering by id covers both, and `order` is unique so a
  // member cannot appear twice.
  return { ...state, speaker: delivery.memberId, queue: state.queue.filter((id) => id !== delivery.memberId), picked: null }
}

/**
 * Release the floor and apply the outcome.
 *
 * The failure paths are the point. In the legacy conductor a drain that threw
 * returned without scheduling anything, and the carousel stopped dead with no
 * error shown. Here a failed delivery always returns the work to the queue and
 * releases the floor, so `nextDelivery` is never left deciding nothing.
 *
 * A stop that landed *during* the delivery is also handled: the outcome is
 * discarded rather than re-queued, which is the model of the old "re-check stop
 * after every await".
 */
export function settle(
  state: SchedulerState,
  delivery: Delivery,
  outcome: 'ok' | 'failed',
): SchedulerState {
  if (delivery.kind === 'idle' || delivery.kind === 'await-pick' || delivery.kind === 'round-limit') {
    return state
  }

  // Stop landed mid-flight: drop the work, keep the room stopped.
  if (state.status === 'stopped') {
    return { ...state, speaker: null }
  }

  const released: SchedulerState = { ...state, speaker: null }

  if (outcome === 'failed') {
    if (delivery.kind === 'reroll') {
      // Re-queue at the front: the same frozen intent, still aimed at the same
      // turn and relay. Nothing is silently dropped, and the carousel moves on.
      return { ...released, pending: [delivery.intent, ...released.pending] }
    }
    // The speaker keeps their turn rather than being skipped by a transient error.
    return { ...released, queue: [delivery.memberId, ...released.queue] }
  }

  if (delivery.kind === 'reroll') {
    // A reroll replaces the take within the *same* turn, so `turnId` does not
    // advance. The new take carries this intent's turnId.
    return released
  }

  // A completed speech advances the turn; the member goes to the back.
  const rest = released.queue.filter((memberId) => memberId !== delivery.memberId)
  const advanced: SchedulerState = {
    ...released,
    turnId: released.turnId + 1,
    round: released.round + 1,
    queue: [...rest, delivery.memberId],
  }
  return advanced
}

/** Live (deliverable) pending rerolls. Dead-generation intents never appear. */
export function livePending(state: SchedulerState): readonly RerollIntent[] {
  return state.pending.filter((intent) => isIntentLive(intent, state.generation))
}
