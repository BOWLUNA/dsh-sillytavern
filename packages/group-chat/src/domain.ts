/**
 * The durable shape of a room.
 *
 * Two things here are deliberate and load-bearing.
 *
 * **`owner` is a field.** Rule 1 of the rewrite: who may write a row is data,
 * not convention. The legacy binding table had two legitimate writers
 * (`setBinding` whole-row for the user, `addBinding`/`removeBinding` targeted
 * for the group lifecycle) and the resulting clobber took two separate audits,
 * in two packages, to surface. Encoding ownership makes the conflict a
 * rejected write instead of a lost row.
 *
 * **The schema is validated on read, so it must accept every record we ever
 * write.** The platform's storage layer runs zod when a domain is *loaded* and
 * not when a record is written; a record that fails takes the whole domain down
 * with it (`invalid-record`), which once made an application unopenable. That
 * means: every field a writer can produce must be expressible here, and every
 * field must be constrained tightly enough that a bad writer cannot smuggle a
 * poison pill in. `wire.ts` is the writer-side half of that bargain — this file
 * is the reader-side half, and the two are tested against each other.
 *
 * For genuinely disposable derived data the platform offers
 * `invalidRecords: 'backup-and-skip'`. Rooms are authoritative, so we do not use
 * it: a corrupt room must stop the boot loudly rather than disappear quietly.
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { Owner } from '@dsh-tavern/contracts'
import { z } from 'zod'
import { LIMITS, ROOM_MODES } from './wire.ts'

export const ROOM_STATUSES = ['stopped', 'running', 'paused'] as const
export type RoomStatus = (typeof ROOM_STATUSES)[number]

const memberRecordSchema = z.object({
  memberId: z.string().min(1).max(200),
  name: z.string().min(1).max(LIMITS.name),
  /**
   * Optional display glyph. Empty means "none given" rather than a default we
   * invented — the renderer falls back to the name's first character. A silent
   * default here would be one more thing the user did not ask for.
   */
  emoji: z.string().max(32).default(''),
  /**
   * Persona fields, each bounded by the shared text limit.
   *
   * `description` / `personality` / `scenario` / `greeting` mirror the parts of a
   * character card that shape speech. They are stored verbatim: the legacy
   * project learned that rewriting user text on the way in makes round-tripping
   * lossy, and the *prompt* assembly is where sanitisation belongs.
   */
  description: z.string().max(LIMITS.text).default(''),
  personality: z.string().max(LIMITS.text).default(''),
  scenario: z.string().max(LIMITS.text).default(''),
  greeting: z.string().max(LIMITS.text).default(''),
  /** Fingerprint of the character card this member came from, if any. */
  cardFingerprint: z.string().max(200).nullable().default(null),
  /** Optional context-seat binding; `null` means "no bound book". */
  bookId: z.string().max(200).nullable().default(null),
})

const roomRecordSchema = z.object({
  roomId: z.string().min(1).max(200),
  /** Ownership marker — see the note above. */
  owner: z.literal(Owner.GroupChat),
  name: z.string().min(1).max(LIMITS.name),
  mode: z.enum([...ROOM_MODES]),
  status: z.enum([...ROOM_STATUSES]),
  /**
   * The log-only session carrying this room's transcript.
   *
   * `null` until the room is started: a room is a durable thing a user creates
   * and configures, and the session it speaks into does not exist at that point.
   * Modelling it as required is what pushed the legacy project into creating the
   * session up front and then *forging platform events* to make it visible — and
   * the forged `turn: 0` is what left 52 sessions unopenable. Absence is a
   * legitimate state; the schema says so.
   */
  sessionId: z.string().min(1).max(200).nullable().default(null),
  /** Sessions this room has been carried across, oldest first. */
  sessionIds: z.array(z.string().min(1).max(200)).max(64).default([]),
  memberIds: z.array(z.string().min(1).max(200)).max(LIMITS.members).default([]),
  members: z.array(memberRecordSchema).max(LIMITS.members).default([]),
  maxRounds: z.number().int().min(0).max(10_000).default(0),
  scenario: z.string().max(LIMITS.persona).default(''),
  userPersona: z.string().max(LIMITS.persona).default(''),
  createdAt: z.number().int().nonnegative(),
})

export type MemberRecord = z.infer<typeof memberRecordSchema>
export type RoomRecord = z.infer<typeof roomRecordSchema>

/**
 * Storage layout for group chat.
 *
 * `per-record` rather than the `single` default: rooms are independent, can be
 * individually disposed, and a large transcript history should not make every
 * room's write rewrite one growing document. Version checks are also scoped per
 * record in this layout, so one stale document cannot poison its siblings.
 */
export const GROUP_CHAT_DOMAIN = defineDomain({
  name: 'group_chat',
  version: 0,
  layout: 'per-record',
  tables: {
    rooms: domainTable<string, RoomRecord>(roomRecordSchema),
  },
})
