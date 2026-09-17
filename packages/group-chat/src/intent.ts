/**
 * A reroll, frozen at the moment the user clicked it.
 *
 * ## Why this is one object and not six fields
 *
 * In the legacy project, "what the user clicked" was spread across six pieces of
 * mutable state, each added by a different audit round as a previous one proved
 * insufficient:
 *
 *   `pendingRerolls`        which members had a reroll queued
 *   `rerollTargetTurn`      which turn it was aimed at
 *   `relaySeqOfLastTake`    which relay produced the take being replaced
 *   `activeSpeakerId`       the concurrency claim
 *   `liveSinceSeq`          the generation boundary
 *   `pendingRerollMemberIds` dedupe
 *
 * The bugs that bought those fields, in order:
 *
 *   1. a queued reroll replayed the *newest* relay instead of the one the user
 *      was looking at, so the replacement text belonged to a different round;
 *   2. then it landed under a different turn than the one clicked;
 *   3. then, queued while paused, it was silently shelved and surfaced only
 *      after a resume the user had no reason to perform;
 *   4. then a failure during drain returned without scheduling the next step,
 *      freezing the carousel with no error anywhere.
 *
 * Every one of those is a *missing dimension* in an implicit tuple. So the tuple
 * is made explicit, written once, and never recomputed:
 *
 *   - the object is frozen and carries the room, the member, the turn, the relay
 *     and the generation together;
 *   - **there are no fallbacks.** If the turn or the relay cannot be pinned, the
 *     request is rejected. The legacy code's fallback was "use the latest",
 *     which is precisely how content ended up in the wrong round — a wrong
 *     answer delivered confidently is worse than a refused click.
 *   - the generation is captured, so an intent accepted before a restart can
 *     never be delivered after it.
 *
 * @module dsh-group-chat/intent
 */

import { compositeKey, isId, reject } from '@dsh-tavern/contracts'

/**
 * Everything that was true when the user clicked, in one immutable value.
 *
 * There is deliberately no optional field: a partially-known intent is not a
 * weaker intent, it is a rejected one.
 */
export interface RerollIntent {
  /** Unique per acceptance; also the dedupe key's other half. */
  readonly intentId: string
  readonly roomId: string
  readonly memberId: string
  /** The turn the user was looking at. Always `>= 1`. */
  readonly turnId: number
  /** The relay that produced the take being replaced. Always `>= 0`. */
  readonly relaySeq: number
  /** The live generation when this was accepted. A later generation voids it. */
  readonly generation: number
  /** Acceptance time, for diagnostics and ordering. */
  readonly acceptedAt: number
}

/** What a caller supplies; the intent is derived from this plus the live state. */
export interface RerollRequest {
  readonly roomId: unknown
  readonly memberId: unknown
  readonly turnId: unknown
  readonly relaySeq: unknown
}

/** The slice of live state a freeze needs. */
export interface FreezeContext {
  readonly generation: number
  readonly now: number
  /** Injected so the core stays pure and tests stay deterministic. */
  readonly nextIntentId: () => string
}

function requirePositiveTurn(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    // Not `?? lastTurn`. "I could not tell which turn you meant" must be an
    // error the user sees, not a guess.
    reject(field, `must be an integer >= 1 (which turn the reroll targets), got ${String(value)}`)
  }
  return value
}

/** A relay sequence. Zero is legitimate; negatives and fractions are not. */
function requireRelaySeq(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    reject(field, `must be an integer >= 0 (the relay being replaced), got ${String(value)}`)
  }
  return value
}

/**
 * Freeze a request into an intent.
 *
 * @throws {RejectError} when any dimension is missing or malformed. Callers
 *   should surface that to the user as "this reroll could not be bound to what
 *   you clicked" rather than retrying with a guess.
 */
export function freezeRerollIntent(request: RerollRequest, context: FreezeContext): RerollIntent {
  if (!isId(request.roomId)) reject('roomId', 'must be a well-formed room id')
  if (!isId(request.memberId)) reject('memberId', 'must be a well-formed member id')

  const turnId = requirePositiveTurn('turnId', request.turnId)
  const relaySeq = requireRelaySeq('relaySeq', request.relaySeq)

  if (!Number.isInteger(context.generation) || context.generation < 1) {
    reject('generation', `must be an integer >= 1, got ${String(context.generation)}`)
  }

  const intentId = context.nextIntentId()
  if (!isId(intentId)) reject('intentId', 'the id factory produced a value outside the id charset')

  return Object.freeze({
    intentId,
    roomId: request.roomId,
    memberId: request.memberId,
    turnId,
    relaySeq,
    generation: context.generation,
    acceptedAt: context.now,
  })
}

/**
 * Whether an intent is still deliverable in `generation`.
 *
 * A member agent does not survive a restart, so an intent accepted before one
 * refers to a take that no longer exists. Delivering it would be worse than
 * dropping it: the surfaces it names are gone.
 */
export function isIntentLive(intent: RerollIntent, generation: number): boolean {
  return intent.generation === generation
}

/**
 * Dedupe key: one pending reroll per member per turn.
 *
 * The legacy project allowed a second queue entry for the same member and turn,
 * and the second silently overwrote the first — so the user's second click
 * destroyed the first click's work. Using the composite key makes the pair
 * unambiguous (see `compositeKey`: the separator cannot occur inside an id, so
 * two distinct pairs can never collide).
 */
export function rerollKey(intent: RerollIntent): string {
  return compositeKey(intent.memberId, String(intent.turnId))
}

/** True when `candidate` is already pending as a (member, turn) pair. */
export function hasPending(pending: readonly RerollIntent[], candidate: RerollIntent): boolean {
  const key = rerollKey(candidate)
  return pending.some((intent) => rerollKey(intent) === key)
}
