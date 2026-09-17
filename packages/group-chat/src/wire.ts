/**
 * The boundary validator: the single place an untrusted value becomes a typed
 * one.
 *
 * Rule 2 of the rewrite: **one entry per boundary, and it rejects loudly.**
 *
 * The legacy project learned this the hard way, three times over. Its platform
 * runtime (`typert`) validates nothing, and its storage layer runs zod only
 * when a domain is *loaded*, never when a record is written. So validation had
 * to live in application code — and because there was no single entry, it grew
 * by audit: the word "silently" appears 26 times across its review documents.
 * Two of those were data-corrupting:
 *
 *   - an unrecognised group mode silently became `round-robin`, which left
 *     ghost groups behind after calls the caller believed had been rejected;
 *   - a misspelled book scope silently became `global`, which injects the book
 *     into **every session in the process**.
 *
 * Both are the same bug: a fallback where a rejection belonged. This module is
 * the answer, and `tests/wire.test.ts` pins it.
 *
 * Every function here is pure and synchronous so the whole boundary is testable
 * without a runtime.
 */

import { LIMITS as SHARED, isId, reject } from '@dsh-tavern/contracts'

/**
 * Upper bounds. Every one of these exists because the legacy project had an
 * unbounded path somewhere; the numbers are deliberately generous rather than
 * tight, because the goal is to stop a runaway, not to editorialise.
 *
 * The shared bounds come from the contracts package so the two plugins cannot
 * disagree about them — a value one side accepts and the other rejects on read
 * is a poison pill waiting to happen.
 */
export const LIMITS = {
  ...SHARED,
  /** Free-form persona / scenario / system prompt text. */
  persona: SHARED.text,
  /** One chat message. */
  message: 100_000,
  /** Members per room. */
  members: 100,
  /** Pending speech queue depth. */
  queue: 200,
} as const

import {
  describe,
  optionalIdArray,
  optionalInt,
  optionalText,
  requireEnum,
  requireInt,
  requireName,
} from '@dsh-tavern/contracts'

export { describe, optionalIdArray, optionalInt, optionalText, requireEnum, requireId, requireInt, requireName } from '@dsh-tavern/contracts'

// ────────────────────────────────────────────────────────────────────────────
// Room shapes — the typed forms the rest of the host half may rely on.
// ────────────────────────────────────────────────────────────────────────────

export const ROOM_MODES = ['round-robin', 'free'] as const
export type RoomMode = (typeof ROOM_MODES)[number]

export interface RoomCreate {
  readonly name: string
  readonly mode: RoomMode
  readonly memberIds?: readonly string[]
  readonly maxRounds?: number
  readonly scenario?: string
  readonly userPersona?: string
}

/** Turn an untrusted request body into a `RoomCreate`, or reject it. */
export function sanitizeRoomCreate(input: unknown): RoomCreate {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    reject('room', `must be an object, got ${describe(input)}`)
  }
  const raw = input as Record<string, unknown>
  const out: {
    name: string
    mode: RoomMode
    memberIds?: readonly string[]
    maxRounds?: number
    scenario?: string
    userPersona?: string
  } = {
    name: requireName('room.name', raw['name']),
    mode: requireEnum('room.mode', raw['mode'], ROOM_MODES),
  }

  const memberIds = optionalIdArray('room.memberIds', raw['memberIds'], LIMITS.members)
  if (memberIds !== undefined) out.memberIds = memberIds

  const maxRounds = optionalInt('room.maxRounds', raw['maxRounds'], 0, 10_000)
  if (maxRounds !== undefined) out.maxRounds = maxRounds

  const scenario = optionalText('room.scenario', raw['scenario'], LIMITS.persona)
  if (scenario !== undefined) out.scenario = scenario

  const userPersona = optionalText('room.userPersona', raw['userPersona'], LIMITS.persona)
  if (userPersona !== undefined) out.userPersona = userPersona

  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Members
// ────────────────────────────────────────────────────────────────────────────

export interface MemberCreate {
  readonly name: string
  readonly emoji: string
  readonly description?: string
  readonly personality?: string
  readonly scenario?: string
  readonly greeting?: string
}

/**
 * Turn an untrusted request body into a `MemberCreate`, or reject it.
 *
 * Only `name` is required. Everything else is genuinely optional and stays
 * absent rather than being filled with a plausible-looking placeholder: a member
 * whose persona the plugin invented is worse than one with no persona, because
 * the invention is invisible in the UI and indistinguishable from the user's own
 * writing later.
 */
export function sanitizeMemberCreate(input: unknown): MemberCreate {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    reject('member', `must be an object, got ${describe(input)}`)
  }
  const raw = input as Record<string, unknown>
  const out: {
    name: string
    emoji: string
    description?: string
    personality?: string
    scenario?: string
    greeting?: string
  } = {
    name: requireName('member.name', raw['name']),
    emoji: optionalText('member.emoji', raw['emoji'], 32) ?? '',
  }

  // Copied only when the caller supplied them, so the validator never invents
  // content. Storage normalises absence to an empty string (the schema requires
  // a string), and the UI treats empty as "not set" — which is as far as the
  // distinction can be carried without letting `undefined` into a record.
  for (const field of ['description', 'personality', 'scenario', 'greeting'] as const) {
    const value = optionalText(`member.${field}`, raw[field], LIMITS.text)
    if (value !== undefined) out[field] = value
  }

  return out
}
